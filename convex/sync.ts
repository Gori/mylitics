"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { fetchStripe } from "./integrations/stripe";
import { fetchGooglePlayFromGCS } from "./integrations/googlePlay";
import { fetchAppStore, downloadASCSubscriptionSummary, downloadASCSubscriberReport } from "./integrations/appStore";

export const syncAllPlatforms = action({
  args: {
    appId: v.id("apps"),
    forceHistorical: v.optional(v.boolean()),
    platform: v.optional(v.union(v.literal("stripe"), v.literal("googleplay"), v.literal("appstore"))),
  },
  handler: async (ctx, { appId, forceHistorical, platform }) => {
    // Start sync session and cancel any existing active syncs
    const syncId = await ctx.runMutation(internal.syncHelpers.startSync, { appId });
    
    try {
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "Sync started",
        level: "info",
      });

      let connections = await ctx.runQuery(
        internal.syncHelpers.getPlatformConnections,
        {
          appId,
        }
      );

    if (platform) {
      connections = connections.filter((c: { platform: string }) => c.platform === platform);
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: `Found ${connections.length} platform connection(s)`,
      level: "info",
    });

    for (const connection of connections) {
      try {
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `Starting ${connection.platform} sync...`,
          level: "info",
        });

        const isFirstSync = !connection.lastSync || forceHistorical;

        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `${connection.platform}: Sync mode = ${isFirstSync ? "HISTORICAL (365 days)" : "INCREMENTAL (current)"}`,
          level: "info",
        });

        if (connection.platform === "stripe") {
          const credentials = JSON.parse(connection.credentials);
          
          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Stripe: First sync detected, fetching historical data (365 days)",
              level: "info",
            });

            const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
            const data = await fetchStripe(credentials.apiKey, oneYearAgo);

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Fetched ${data.subscriptions.length} subscriptions, ${data.revenueEvents.length} revenue events`,
              level: "info",
            });
            if (data.debug) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Stripe: Invoices - total ${data.debug.invoiceCount}, with subscription ${data.debug.invoicesWithSubscription}, paid ${data.debug.invoicesPaid}`,
                level: "info",
              });
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Stripe: Invoice statuses: ${JSON.stringify(data.debug.invoiceStatusCounts)}`,
                level: "info",
              });
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Stripe: Event types - First Payments: ${data.debug.eventTypeCounts.first_payment}, Renewals: ${data.debug.eventTypeCounts.renewal}, Refunds: ${data.debug.eventTypeCounts.refund}`,
                level: "info",
              });
            }

            const activeCount = data.subscriptions.filter(s => s.status === "active" || s.status === "trialing").length;
            const trialCount = data.subscriptions.filter(s => s.isTrial).length;
            const canceledCount = data.subscriptions.filter(s => s.status === "canceled").length;
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Status breakdown - Active: ${activeCount}, Trial: ${trialCount}, Canceled: ${canceledCount}`,
              level: "info",
            });

            const result1 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              appId,
              platform: "stripe",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
            });
            // Generate daily snapshots for past 365 days from stored raw data in monthly chunks
            const nowMs = Date.now();
            const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
            let chunkStart = oneYearAgo;
            let chunkIdx = 1;
            while (chunkStart < nowMs) {
              const chunkEnd = Math.min(chunkStart + thirtyDaysMs - 1, nowMs);
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Stripe: Generating daily snapshots chunk ${chunkIdx} (${new Date(chunkStart).toISOString().split("T")[0]} → ${new Date(chunkEnd).toISOString().split("T")[0]})`,
                level: "info",
              });
              await ctx.runMutation(internal.metrics.generateHistoricalSnapshots, {
                appId,
                platform: "stripe",
                startMs: chunkStart,
                endMs: chunkEnd,
              });
              chunkStart = chunkEnd + 1;
              chunkIdx += 1;
            }
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Calculated metrics - Active: ${result1.snapshot.activeSubscribers}, Paid: ${result1.snapshot.paidSubscribers}, Churn: ${result1.snapshot.churn}, Cancellations: ${result1.snapshot.cancellations}, First Payments: ${result1.snapshot.firstPayments}, Renewals: ${result1.snapshot.renewals}, MRR: $${result1.snapshot.mrr.toFixed(2)}`,
              level: "info",
            });
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Stripe: Incremental sync (current data)",
              level: "info",
            });

            const data = await fetchStripe(credentials.apiKey);

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Fetched ${data.subscriptions.length} subscriptions, ${data.revenueEvents.length} revenue events`,
              level: "info",
            });

            const activeCount = data.subscriptions.filter(s => s.status === "active" || s.status === "trialing").length;
            const trialCount = data.subscriptions.filter(s => s.isTrial).length;
            const canceledCount = data.subscriptions.filter(s => s.status === "canceled").length;
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Status breakdown - Active: ${activeCount}, Trial: ${trialCount}, Canceled: ${canceledCount}`,
              level: "info",
            });

            const result2 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              appId,
              platform: "stripe",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
            });
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `Stripe: Calculated metrics - Active: ${result2.snapshot.activeSubscribers}, Paid: ${result2.snapshot.paidSubscribers}, Churn: ${result2.snapshot.churn}, Cancellations: ${result2.snapshot.cancellations}, First Payments: ${result2.snapshot.firstPayments}, Renewals: ${result2.snapshot.renewals}, MRR: $${result2.snapshot.mrr.toFixed(2)}`,
              level: "info",
            });
          }
          
          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            appId,
            message: "Stripe: Sync completed successfully",
            level: "success",
          });
        } else if (connection.platform === "googleplay") {
          const credentials = JSON.parse(connection.credentials);
          const { serviceAccountJson, packageName, gcsBucketName, gcsReportPrefix } = credentials;

          if (!gcsBucketName) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Google Play: gcsBucketName is required. Update connection in Settings.",
              level: "error",
            });
            continue;
          }

          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            appId,
            message: `Google Play: Using GCS bucket gs://${gcsBucketName}/${gcsReportPrefix || 'earnings/'}`,
            level: "info",
          });

          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Google Play: First sync - scanning GCS bucket for all available historical reports",
              level: "info",
            });

            // Don't pass startDate on first sync to get ALL historical data
            try {
              const data = await fetchGooglePlayFromGCS(
                serviceAccountJson,
                packageName,
                gcsBucketName,
                gcsReportPrefix || "",
                undefined // No date filter - get all historical data
              );

              // Log discovered report types
              const reportTypes = data.discoveredReportTypes || [];
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Google Play: Discovered report types: ${reportTypes.length > 0 ? reportTypes.join(', ') : 'none'}`,
                level: "info",
              });

              const daysWithRevenue = Object.keys(data.revenueByDate).length;
              const daysWithSubscriptions = Object.keys(data.subscriptionMetricsByDate || {}).length;

              if (daysWithRevenue > 0) {
                const totalGross = Object.values(data.revenueByDate).reduce((sum: number, d: any) => sum + d.gross, 0);
                const totalNet = Object.values(data.revenueByDate).reduce((sum: number, d: any) => sum + d.net, 0);
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: `Google Play: Found revenue data for ${daysWithRevenue} days - Total Gross: $${totalGross.toFixed(2)}, Net: $${totalNet.toFixed(2)}`,
                  level: "info",
                });
              }

              if (daysWithSubscriptions > 0) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: `Google Play: Found subscription metrics for ${daysWithSubscriptions} days`,
                  level: "success",
                });
              } else {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: "Google Play: No subscription metrics found - only revenue data available",
                  level: "info",
                });
              }

              // Process all data and create daily snapshots
              const result = await ctx.runMutation(internal.metrics.processGooglePlayReports, {
                appId,
                revenueByDate: data.revenueByDate,
                subscriptionMetricsByDate: data.subscriptionMetricsByDate || {},
                discoveredReportTypes: reportTypes,
              });

              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Google Play: Created ${result.snapshotsCreated} snapshots, updated ${result.snapshotsUpdated} snapshots`,
                level: "success",
              });
            } catch (error) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Google Play: Error fetching from GCS - ${error instanceof Error ? error.message : String(error)}`,
                level: "error",
              });
            }
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Google Play: Incremental sync - scanning for recent reports",
              level: "info",
            });

            // For incremental sync, fetch last 90 days to catch any updates
            const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
            
            try {
              const data = await fetchGooglePlayFromGCS(
                serviceAccountJson,
                packageName,
                gcsBucketName,
                gcsReportPrefix || "",
                ninetyDaysAgo
              );

              const reportTypes = data.discoveredReportTypes || [];
              const daysWithRevenue = Object.keys(data.revenueByDate).length;
              const daysWithSubscriptions = Object.keys(data.subscriptionMetricsByDate || {}).length;

              if (daysWithRevenue > 0 || daysWithSubscriptions > 0) {
                let message = `Google Play: Found ${daysWithRevenue} days with revenue`;
                if (daysWithSubscriptions > 0) {
                  message += `, ${daysWithSubscriptions} days with subscription metrics`;
                }

                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message,
                  level: "info",
                });

                // Process all data
                const result = await ctx.runMutation(internal.metrics.processGooglePlayReports, {
                  appId,
                  revenueByDate: data.revenueByDate,
                  subscriptionMetricsByDate: data.subscriptionMetricsByDate || {},
                  discoveredReportTypes: reportTypes,
                });

                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: `Google Play: Updated ${result.snapshotsUpdated} snapshots, created ${result.snapshotsCreated} new snapshots`,
                  level: "success",
                });
              } else {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: "Google Play: No new data found in recent reports",
                  level: "info",
                });
              }
            } catch (error) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `Google Play: Error fetching from GCS - ${error instanceof Error ? error.message : String(error)}`,
                level: "error",
              });
            }
          }

          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            appId,
            message: "Google Play: Sync completed",
            level: "success",
          });
        } else if (connection.platform === "appstore") {
          const credentials = JSON.parse(connection.credentials);
          const { issuerId, keyId, privateKey, vendorNumber, bundleId } = credentials;

          if (!vendorNumber) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: vendorNumber is required. Add it in Connections.",
              level: "error",
            });
            continue;
          }

          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            appId,
            message: `App Store: Using vendor ${vendorNumber}`,
            level: "info",
          });

          if (isFirstSync) {
            const historicalSyncStartTime = Date.now();
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `[PROOF] App Store: HISTORICAL SYNC STARTED at ${new Date(historicalSyncStartTime).toISOString()}`,
              level: "info",
            });
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: First sync detected, scheduling 365 daily reports in batches...",
              level: "info",
            });

            // Process in chunks of 30 days to avoid action timeout
            const CHUNK_SIZE = 30;
            const TOTAL_DAYS = 365;
            const oneYearAgo = new Date(Date.now() - TOTAL_DAYS * 24 * 60 * 60 * 1000);
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `App Store: Processing ${TOTAL_DAYS} days in ${Math.ceil(TOTAL_DAYS / CHUNK_SIZE)} batches of ${CHUNK_SIZE} days each`,
              level: "info",
            });
            
            for (let chunkStart = 0; chunkStart < TOTAL_DAYS; chunkStart += CHUNK_SIZE) {
              // Check if sync was cancelled before starting each chunk
              const isCancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
              if (isCancelled) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: "App Store: Sync cancelled by user",
                  level: "info",
                });
                throw new Error("Sync cancelled");
              }

              const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, TOTAL_DAYS);
              const chunkNum = Math.floor(chunkStart / CHUNK_SIZE) + 1;
              const totalChunks = Math.ceil(TOTAL_DAYS / CHUNK_SIZE);
              const elapsedSeconds = Math.floor((Date.now() - historicalSyncStartTime) / 1000);
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `[PROOF] App Store: Starting batch ${chunkNum}/${totalChunks} at ${elapsedSeconds}s elapsed`,
                level: "info",
              });
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `App Store: Processing batch ${chunkNum}/${totalChunks} (days ${chunkStart + 1}-${chunkEnd})`,
                level: "info",
              });

              let successCount = 0;
              let errorCount = 0;
              const errorSamples: string[] = [];
              
              for (let dayOffset = chunkStart; dayOffset < chunkEnd; dayOffset++) {
                const date = new Date(oneYearAgo);
                date.setDate(date.getDate() + dayOffset);
                const dateStr = date.toISOString().split("T")[0];

                try {
                  // Fetch SUBSCRIPTION SUMMARY report (snapshot data)
                  const res = await downloadASCSubscriptionSummary(
                    issuerId,
                    keyId,
                    privateKey,
                    vendorNumber,
                    dateStr,
                    "DAILY",
                    "1_4"
                  );

                  if (res.ok) {
                    // Fetch SUBSCRIBER report (transaction-level event data)
                    const subscriberRes = await downloadASCSubscriberReport(
                      issuerId,
                      keyId,
                      privateKey,
                      vendorNumber,
                      dateStr,
                      "DAILY",
                      "1_3"
                    );
                    
                    let eventData = undefined;
                    if (subscriberRes.ok) {
                      await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                        appId,
                        reportType: "SUBSCRIBER",
                        reportSubType: "DETAILED",
                        frequency: "DAILY",
                        vendorNumber,
                        reportDate: dateStr,
                        bundleId,
                        content: subscriberRes.tsv,
                      });
                      eventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriberReport, {
                        appId,
                        date: dateStr,
                        tsv: subscriberRes.tsv,
                      });
                    }
                    
                    await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                      appId,
                      reportType: "SUBSCRIPTION",
                      reportSubType: "SUMMARY",
                      frequency: "DAILY",
                      vendorNumber,
                      reportDate: dateStr,
                      bundleId,
                      content: res.tsv,
                    });
                    await ctx.runMutation(internal.metrics.processAppStoreReport, {
                      appId,
                      date: dateStr,
                      tsv: res.tsv,
                      eventData,
                    });
                    successCount++;
                    
                    if (successCount === 1) {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        appId,
                        message: `App Store: First successful report for ${dateStr}`,
                        level: "info",
                      });
                    }
                  } else {
                    let parsed: any = null;
                    try { parsed = JSON.parse(res.text); } catch {}
                    const code = parsed?.errors?.[0]?.code;
                    
                    // Skip NOT_FOUND errors for recent dates (last 3 days) - reports are delayed
                    const daysOld = TOTAL_DAYS - dayOffset;
                    if (code === "NOT_FOUND" && daysOld <= 3) {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        appId,
                        message: `[PROOF] App Store: Tried ${dateStr} (${daysOld} day(s) old) - NOT_FOUND (Apple reporting delay, skipping)`,
                        level: "info",
                      });
                      continue;
                    }
                    
                    // Skip "no sales" reports - don't create fake data
                    if (code === "NOT_FOUND" && res.text.includes("no sales")) {
                      continue;
                    }
                    
                    errorCount++;
                    if (errorSamples.length < 2) {
                      const title = parsed?.errors?.[0]?.title;
                      const detail = parsed?.errors?.[0]?.detail;
                      const errorMsg = `${dateStr}: HTTP ${res.status}${code ? ` [${code}]` : ""}${title ? ` ${title}` : ""}${detail ? ` - ${detail}` : ""}`;
                      errorSamples.push(errorMsg);
                      
                      if (code === "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED") {
                        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                          appId,
                          message: "App Store ACTION REQUIRED: Accept latest agreements in App Store Connect → Agreements, Tax, and Banking, then retry.",
                          level: "error",
                        });
                      }
                      if (code === "FORBIDDEN_ERROR") {
                        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                          appId,
                          message: "App Store ACTION REQUIRED: Ensure the API Key has access to Sales Reports (Finance role) and is scoped correctly. Also verify bundleId/vendor permissions.",
                          level: "error",
                        });
                      }
                      if (code === "NOT_AUTHORIZED") {
                        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                          appId,
                          message: "App Store ACTION REQUIRED: Verify issuerId, keyId, and private key match; device/server clock is accurate (NTP); token lifetime kept short; and role includes Finance.",
                          level: "error",
                        });
                      }
                    }
                  }
                } catch (error) {
                  errorCount++;
                  if (errorSamples.length < 2) {
                    errorSamples.push(`${dateStr}: ${String(error)}`);
                  }
                }
              }

              const batchElapsedSeconds = Math.floor((Date.now() - historicalSyncStartTime) / 1000);
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `[PROOF] App Store: Batch ${chunkNum}/${totalChunks} COMPLETED at ${batchElapsedSeconds}s elapsed - ${successCount} reports, ${errorCount} errors`,
                level: "info",
              });
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `App Store: Batch ${chunkNum}/${totalChunks} complete - ${successCount} reports fetched, ${errorCount} errors`,
                level: successCount > 0 ? "success" : "info",
              });
              
              if (errorSamples.length > 0) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: `App Store: Sample errors from batch ${chunkNum}: ${errorSamples.join("; ")}`,
                  level: "error",
                });
              }
            }

            const totalElapsedSeconds = Math.floor((Date.now() - historicalSyncStartTime) / 1000);
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `[PROOF] App Store: HISTORICAL SYNC COMPLETED after ${totalElapsedSeconds}s - all batches processed`,
              level: "success",
            });
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: Historical sync completed - all batches processed",
              level: "success",
            });
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: Incremental sync (fetching most recent available report)",
              level: "info",
            });

            // Apple reports are typically delayed 1-2 days, try yesterday and day before
            const now = Date.now();
            const daysToTry = [1, 2, 3]; // Try yesterday, day before, 3 days ago
            let successfulFetch = false;
            
            for (const daysAgo of daysToTry) {
              // Check if sync was cancelled
              const isCancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
              if (isCancelled) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: "App Store: Sync cancelled by user",
                  level: "info",
                });
                throw new Error("Sync cancelled");
              }

              const targetDate = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
              const dateStr = targetDate.toISOString().split("T")[0];
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: `App Store: Trying report for ${dateStr} (${daysAgo} days ago)...`,
                level: "info",
              });

              try {
                // Fetch SUBSCRIPTION SUMMARY report (snapshot data)
                const res = await downloadASCSubscriptionSummary(
                  issuerId,
                  keyId,
                  privateKey,
                  vendorNumber,
                  dateStr,
                  "DAILY",
                  "1_4"
                );

                if (res.ok) {
                  // Fetch SUBSCRIBER report (transaction-level event data)
                  const subscriberRes = await downloadASCSubscriberReport(
                    issuerId,
                    keyId,
                    privateKey,
                    vendorNumber,
                    dateStr,
                    "DAILY",
                    "1_3"
                  );
                  
                  let eventData = undefined;
                  if (subscriberRes.ok) {
                    await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                      appId,
                      reportType: "SUBSCRIBER",
                      reportSubType: "DETAILED",
                      frequency: "DAILY",
                      vendorNumber,
                      reportDate: dateStr,
                      bundleId,
                      content: subscriberRes.tsv,
                    });
                    eventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriberReport, {
                      appId,
                      date: dateStr,
                      tsv: subscriberRes.tsv,
                    });
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: renewals=${eventData?.renewals || 0}, firstPayments=${eventData?.firstPayments || 0}, revenueGross=${eventData?.revenueGross?.toFixed(2) || '0.00'}, revenueNet=${eventData?.revenueNet?.toFixed(2) || '0.00'}`);
                  } else {
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: FAILED - HTTP ${subscriberRes.status}`);
                  }
                  
                  await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                    appId,
                    reportType: "SUBSCRIPTION",
                    reportSubType: "SUMMARY",
                    frequency: "DAILY",
                    vendorNumber,
                    reportDate: dateStr,
                    bundleId,
                    content: res.tsv,
                  });
                  await ctx.runMutation(internal.metrics.processAppStoreReport, {
                    appId,
                    date: dateStr,
                    tsv: res.tsv,
                    eventData,
                  });
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    appId,
                    message: `App Store: Successfully fetched and processed report for ${dateStr} (${res.tsv.length} bytes)${eventData ? ' with event data' : ''}`,
                    level: "success",
                  });
                  successfulFetch = true;
                  break; // Got a report, stop trying
                } else {
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    appId,
                    message: `App Store: Report for ${dateStr} not available (HTTP ${res.status})`,
                    level: "info",
                  });
                }
              } catch (error) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  appId,
                  message: `App Store: Error fetching ${dateStr} - ${String(error)}`,
                  level: "info",
                });
              }
            }
            
            if (!successfulFetch) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                appId,
                message: "App Store: No recent reports available (reports may be delayed)",
                level: "error",
              });
            }
          }
        }

        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `[PROOF] ${connection.platform}: About to call updateLastSync`,
          level: "info",
        });
        
        await ctx.runMutation(internal.syncHelpers.updateLastSync, {
          connectionId: connection._id,
        });

        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `[PROOF] ${connection.platform}: updateLastSync COMPLETED - next sync will be incremental`,
          level: "info",
        });
        
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `${connection.platform}: Connection updated`,
          level: "info",
        });
      } catch (error) {
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `Error syncing ${connection.platform}: ${String(error)}`,
          level: "error",
        });
      }
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: "Creating unified snapshots (today + historical)...",
      level: "info",
    });

    // Create unified snapshot for today
    await ctx.runMutation(internal.metrics.createUnifiedSnapshot, { appId });

    // Generate unified snapshots for ALL historical dates (past 365 days)
    const result = await ctx.runMutation(internal.metrics.generateUnifiedHistoricalSnapshots, { 
      appId,
      daysBack: 365,
    });

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: `Created ${result.created} unified historical snapshots`,
      level: "info",
    });

      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "Sync completed",
        level: "success",
      });

      // Mark sync as completed
      await ctx.runMutation(internal.syncHelpers.completeSyncSession, {
        syncId,
        status: "completed",
      });

      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "[PROOF] syncAllPlatforms action RETURNING successfully - action should end now",
        level: "info",
      });

      return { success: true };
    } catch (error) {
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: `[PROOF] syncAllPlatforms CAUGHT ERROR: ${error instanceof Error ? error.message : String(error)}`,
        level: "error",
      });
      
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: `Sync error: ${error instanceof Error ? error.message : String(error)}`,
        level: "error",
      });

      await ctx.runMutation(internal.syncHelpers.completeSyncSession, {
        syncId,
        status: "cancelled",
      });

      throw error;
    }
  },
});

export const syncAllApps = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; appsProcessed: number }> => {
    const apps = await ctx.runQuery(internal.syncHelpers.getAllAppsWithConnections);

    for (const app of apps) {
      if (app && app._id) {
        await ctx.runAction(api.sync.syncAllPlatforms, { appId: app._id });
      }
    }

    return { success: true, appsProcessed: apps.length };
  },
});

// Debug action to list GCS bucket contents
export const debugGCSBucket = action({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }): Promise<Record<string, unknown>> => {
    // Get Google Play connection
    const connections = await ctx.runQuery(internal.syncHelpers.getPlatformConnections, { appId });
    const gpConnection = connections.find((c: { platform: string }) => c.platform === "googleplay");
    
    if (!gpConnection) {
      return { error: "No Google Play connection found" };
    }

    const credentials = JSON.parse(gpConnection.credentials);
    const { serviceAccountJson, packageName, gcsBucketName, gcsReportPrefix } = credentials;

    if (!gcsBucketName) {
      return { error: "No GCS bucket configured" };
    }

    // Import GCS Storage and list files directly
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ credentials: JSON.parse(serviceAccountJson) });

    try {
      const [allFiles] = await storage.bucket(gcsBucketName).getFiles({
        prefix: gcsReportPrefix || "",
      });

      // Get unique folder paths
      const folders = new Set<string>();
      const files: { name: string; size: number; updated: string }[] = [];

      for (const file of allFiles) {
        const parts = file.name.split('/');
        if (parts.length > 1) {
          folders.add(parts.slice(0, -1).join('/') + '/');
        }
        files.push({
          name: file.name,
          size: Number(file.metadata.size || 0),
          updated: String(file.metadata.updated || 'unknown'),
        });
      }

      // Sample CSV files matching package name
      const packageVariants = [
        packageName.toLowerCase(),
        packageName.toLowerCase().replace(/\./g, '_'),
        packageName.toLowerCase().replace(/\./g, '')
      ];
      const matchingCsvFiles = files.filter(f => 
        f.name.endsWith('.csv') && 
        packageVariants.some(variant => f.name.toLowerCase().includes(variant))
      );

      // Also get files from earnings folder (they don't include package name)
      const earningsFiles = files.filter(f => {
        const p = f.name.toLowerCase();
        return (p.includes('earnings/') || p.startsWith('earnings/')) && f.name.endsWith('.csv');
      });

      // Get files from sales folder too
      const salesFiles = files.filter(f => {
        const p = f.name.toLowerCase();
        return (p.includes('sales/') || p.startsWith('sales/')) && f.name.endsWith('.csv');
      });

      // Get ALL files in earnings folder (any extension) to debug
      const allEarningsFiles = files.filter(f => {
        const p = f.name.toLowerCase();
        return p.includes('earnings/') || p.startsWith('earnings/');
      });
      
      // Get ALL files in sales folder (any extension) to debug
      const allSalesFiles = files.filter(f => {
        const p = f.name.toLowerCase();
        return p.includes('sales/') || p.startsWith('sales/');
      });

      return {
        bucketName: gcsBucketName,
        prefix: gcsReportPrefix || "(root)",
        packageName,
        totalFiles: files.length,
        folders: Array.from(folders).sort(),
        csvFileCount: matchingCsvFiles.length,
        sampleCsvFiles: matchingCsvFiles.slice(0, 10),
        // CSV files only
        earningsFiles: earningsFiles.slice(0, 10),
        earningsFileCount: earningsFiles.length,
        salesFiles: salesFiles.slice(0, 5),
        salesFileCount: salesFiles.length,
        // ALL files in these folders (any extension) for debugging
        allEarningsFiles: allEarningsFiles.slice(0, 15).map(f => ({ name: f.name, size: f.size })),
        allEarningsFilesCount: allEarningsFiles.length,
        allSalesFiles: allSalesFiles.slice(0, 10).map(f => ({ name: f.name, size: f.size })),
        allSalesFilesCount: allSalesFiles.length,
        allFileNames: files.slice(0, 50).map(f => f.name),
      };
    } catch (error) {
      return {
        bucketName: gcsBucketName,
        prefix: gcsReportPrefix || "(root)",
        packageName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
