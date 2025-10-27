"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { fetchStripe } from "./integrations/stripe";
import { fetchGoogle } from "./integrations/googlePlay";
import { fetchAppStore, downloadASCSubscriptionSummary, downloadASCSubscriberReport } from "./integrations/appStore";

export const syncAllPlatforms = action({
  args: {
    userId: v.id("users"),
    forceHistorical: v.optional(v.boolean()),
    platform: v.optional(v.union(v.literal("stripe"), v.literal("googleplay"), v.literal("appstore"))),
  },
  handler: async (ctx, { userId, forceHistorical, platform }) => {
    // Start sync session and cancel any existing active syncs
    const syncId = await ctx.runMutation(internal.syncHelpers.startSync, { userId });
    
    try {
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        userId,
        message: "Sync started",
        level: "info",
      });

      let connections = await ctx.runQuery(
        internal.syncHelpers.getPlatformConnections,
        {
          userId,
        }
      );

    if (platform) {
      connections = connections.filter((c) => c.platform === platform);
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      userId,
      message: `Found ${connections.length} platform connection(s)`,
      level: "info",
    });

    for (const connection of connections) {
      try {
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          userId,
          message: `Starting ${connection.platform} sync...`,
          level: "info",
        });

        const isFirstSync = !connection.lastSync || forceHistorical;

        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          userId,
          message: `${connection.platform}: Sync mode = ${isFirstSync ? "HISTORICAL (365 days)" : "INCREMENTAL (current)"}`,
          level: "info",
        });

        if (connection.platform === "stripe") {
          const credentials = JSON.parse(connection.credentials);
          
          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "Stripe: First sync detected, fetching historical data (365 days)",
              level: "info",
            });

            const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
            const data = await fetchStripe(credentials.apiKey, oneYearAgo);

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Fetched ${data.subscriptions.length} subscriptions, ${data.revenueEvents.length} revenue events`,
              level: "info",
            });
            if (data.debug) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                userId,
                message: `Stripe: Invoices - total ${data.debug.invoiceCount}, with subscription ${data.debug.invoicesWithSubscription}, paid ${data.debug.invoicesPaid}`,
                level: "info",
              });
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                userId,
                message: `Stripe: Invoice statuses: ${JSON.stringify(data.debug.invoiceStatusCounts)}`,
                level: "info",
              });
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                userId,
                message: `Stripe: Event types - First Payments: ${data.debug.eventTypeCounts.first_payment}, Renewals: ${data.debug.eventTypeCounts.renewal}, Refunds: ${data.debug.eventTypeCounts.refund}`,
                level: "info",
              });
            }

            const activeCount = data.subscriptions.filter(s => s.status === "active" || s.status === "trialing").length;
            const trialCount = data.subscriptions.filter(s => s.isTrial).length;
            const canceledCount = data.subscriptions.filter(s => s.status === "canceled").length;
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Status breakdown - Active: ${activeCount}, Trial: ${trialCount}, Canceled: ${canceledCount}`,
              level: "info",
            });

            const result1 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              userId,
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
                userId,
                message: `Stripe: Generating daily snapshots chunk ${chunkIdx} (${new Date(chunkStart).toISOString().split("T")[0]} → ${new Date(chunkEnd).toISOString().split("T")[0]})`,
                level: "info",
              });
              await ctx.runMutation(internal.metrics.generateHistoricalSnapshots, {
                userId,
                platform: "stripe",
                startMs: chunkStart,
                endMs: chunkEnd,
              });
              chunkStart = chunkEnd + 1;
              chunkIdx += 1;
            }
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Calculated metrics - Active: ${result1.snapshot.activeSubscribers}, Paid: ${result1.snapshot.paidSubscribers}, Churn: ${result1.snapshot.churn}, Cancellations: ${result1.snapshot.cancellations}, First Payments: ${result1.snapshot.firstPayments}, Renewals: ${result1.snapshot.renewals}, MRR: $${result1.snapshot.mrr.toFixed(2)}`,
              level: "info",
            });
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "Stripe: Incremental sync (current data)",
              level: "info",
            });

            const data = await fetchStripe(credentials.apiKey);

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Fetched ${data.subscriptions.length} subscriptions, ${data.revenueEvents.length} revenue events`,
              level: "info",
            });

            const activeCount = data.subscriptions.filter(s => s.status === "active" || s.status === "trialing").length;
            const trialCount = data.subscriptions.filter(s => s.isTrial).length;
            const canceledCount = data.subscriptions.filter(s => s.status === "canceled").length;
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Status breakdown - Active: ${activeCount}, Trial: ${trialCount}, Canceled: ${canceledCount}`,
              level: "info",
            });

            const result2 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              userId,
              platform: "stripe",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
            });
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Stripe: Calculated metrics - Active: ${result2.snapshot.activeSubscribers}, Paid: ${result2.snapshot.paidSubscribers}, Churn: ${result2.snapshot.churn}, Cancellations: ${result2.snapshot.cancellations}, First Payments: ${result2.snapshot.firstPayments}, Renewals: ${result2.snapshot.renewals}, MRR: $${result2.snapshot.mrr.toFixed(2)}`,
              level: "info",
            });
          }
          
          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            userId,
            message: "Stripe: Sync completed successfully",
            level: "success",
          });
        } else if (connection.platform === "googleplay") {
          const credentials = JSON.parse(connection.credentials);
          
          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "Google Play: First sync detected, fetching historical data (365 days)",
              level: "info",
            });

            const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
            const data = await fetchGoogle(
              credentials.serviceAccountJson,
              credentials.packageName,
              oneYearAgo
            );

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `Google Play: Fetched ${data.subscriptions.length} subscriptions, ${data.revenueEvents.length} revenue events`,
              level: "info",
            });

            await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              userId,
              platform: "googleplay",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
            });
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "Google Play: Incremental sync (current data)",
              level: "info",
            });

            const data = await fetchGoogle(credentials.serviceAccountJson, credentials.packageName);

            await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              userId,
              platform: "googleplay",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
            });
          }

          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            userId,
            message: "Google Play: Sync completed successfully",
            level: "success",
          });
        } else if (connection.platform === "appstore") {
          const credentials = JSON.parse(connection.credentials);
          const { issuerId, keyId, privateKey, vendorNumber, bundleId } = credentials;

          if (!vendorNumber) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "App Store: vendorNumber is required. Add it in Connections.",
              level: "error",
            });
            continue;
          }

          await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
            userId,
            message: `App Store: Using vendor ${vendorNumber}`,
            level: "info",
          });

          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: "App Store: First sync detected, fetching 365 daily reports...",
              level: "info",
            });

            const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
            const today = new Date();
            
            let successCount = 0;
            let errorCount = 0;
            const errorSamples: string[] = [];
            
            for (let dayOffset = 0; dayOffset < 365; dayOffset++) {
              // Check if sync was cancelled every 50 days
              if (dayOffset % 50 === 0) {
                const isCancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
                if (isCancelled) {
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    userId,
                    message: "App Store: Sync cancelled by user",
                    level: "info",
                  });
                  throw new Error("Sync cancelled");
                }
              }

              const date = new Date(oneYearAgo);
              date.setDate(date.getDate() + dayOffset);
              const dateStr = date.toISOString().split("T")[0];

              // Only log at key milestones to reduce noise
              if (dayOffset === 0 || dayOffset === 182 || dayOffset === 364) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  userId,
                  message: `App Store: Processing day ${dayOffset + 1}/365 (${dateStr})`,
                  level: "info",
                });
              }

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
                      userId,
                      reportType: "SUBSCRIBER",
                      reportSubType: "DETAILED",
                      frequency: "DAILY",
                      vendorNumber,
                      reportDate: dateStr,
                      bundleId,
                      content: subscriberRes.tsv,
                    });
                    eventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriberReport, {
                      userId,
                      date: dateStr,
                      tsv: subscriberRes.tsv,
                    });
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: renewals=${eventData?.renewals || 0}, firstPayments=${eventData?.firstPayments || 0}`);
                  } else {
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: FAILED - HTTP ${subscriberRes.status}`);
                  }
                  
                  await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                    userId,
                    reportType: "SUBSCRIPTION",
                    reportSubType: "SUMMARY",
                    frequency: "DAILY",
                    vendorNumber,
                    reportDate: dateStr,
                    bundleId,
                    content: res.tsv,
                  });
                  await ctx.runMutation(internal.metrics.processAppStoreReport, {
                    userId,
                    date: dateStr,
                    tsv: res.tsv,
                    eventData,
                  });
                  successCount++;
                  
                  if (successCount === 1) {
                    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                      userId,
                      message: `App Store: First successful report for ${dateStr} - ${res.tsv.length} bytes`,
                      level: "info",
                    });
                  }
                } else {
                  let parsed: any = null;
                  try { parsed = JSON.parse(res.text); } catch {}
                  const code = parsed?.errors?.[0]?.code;
                  
                  // Handle "no sales" as special case - carry forward previous day's data
                  if (code === "NOT_FOUND" && res.text.includes("no sales")) {
                    // Get previous day's snapshot to carry forward subscriber counts
                    const prevSnapshot = await ctx.runQuery(internal.syncHelpers.getLatestAppStoreSnapshot, { userId });
                    if (prevSnapshot) {
                      // Create snapshot with 0 revenue but same subscriber counts
                      await ctx.runMutation(internal.metrics.createAppStoreSnapshotFromPrevious, {
                        userId,
                        date: dateStr,
                        previousSnapshot: prevSnapshot,
                      });
                      successCount++;
                    }
                    // Don't log this as an error, it's expected
                    continue;
                  }
                  
                  // Skip NOT_FOUND errors for recent dates (last 3 days) - reports are delayed
                  const daysOld = 365 - dayOffset;
                  if (code === "NOT_FOUND" && daysOld <= 3) {
                    // This is expected - Apple reports are delayed 1-3 days
                    continue;
                  }
                  
                  errorCount++;
                  const title = parsed?.errors?.[0]?.title;
                  const detail = parsed?.errors?.[0]?.detail;
                  const shortText = res.text.substring(0, 200);
                  const errorMsg = `Day ${dayOffset + 1} (${dateStr}): HTTP ${res.status}${code ? ` [${code}]` : ""}${title ? ` ${title}` : ""}${detail ? ` - ${detail}` : ""} - ${shortText}`;

                  if (errorSamples.length < 5) {
                    errorSamples.push(errorMsg);
                    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                      userId,
                      message: `App Store ERROR: ${errorMsg}`,
                      level: "error",
                    });
                    if (code === "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED") {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        userId,
                        message: "App Store ACTION REQUIRED: Accept latest agreements in App Store Connect → Agreements, Tax, and Banking, then retry.",
                        level: "error",
                      });
                    }
                    if (code === "FORBIDDEN_ERROR") {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        userId,
                        message: "App Store ACTION REQUIRED: Ensure the API Key has access to Sales Reports (Finance role) and is scoped correctly. Also verify bundleId/vendor permissions.",
                        level: "error",
                      });
                    }
                    if (code === "NOT_AUTHORIZED") {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        userId,
                        message: `App Store 401 diagnostics: www-authenticate='${res.wwwAuth ?? ""}' x-request-id='${res.requestId ?? ""}'`,
                        level: "error",
                      });
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        userId,
                        message: "App Store ACTION REQUIRED: Verify issuerId, keyId, and private key match; device/server clock is accurate (NTP); token lifetime kept short; and role includes Finance.",
                        level: "error",
                      });
                    }
                    if (code === "PARAMETER_ERROR.INVALID_VENDOR_NUMBER") {
                      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                        userId,
                        message: `App Store ACTION REQUIRED: Invalid vendor number '${vendorNumber}'. Verify your vendor in App Store Connect Finance Reports and update the connection.`,
                        level: "error",
                      });
                    }
                  }
                }
              } catch (error) {
                errorCount++;
                const errorMsg = `Day ${dayOffset + 1} (${dateStr}): Exception - ${String(error)}`;
                
                if (errorSamples.length < 5) {
                  errorSamples.push(errorMsg);
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    userId,
                    message: `App Store EXCEPTION: ${errorMsg}`,
                    level: "error",
                  });
                }
              }
            }

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
              message: `App Store: Historical sync completed - ${successCount} reports fetched, ${errorCount} errors`,
              level: successCount > 0 ? "success" : "error",
            });
          } else {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              userId,
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
                  userId,
                  message: "App Store: Sync cancelled by user",
                  level: "info",
                });
                throw new Error("Sync cancelled");
              }

              const targetDate = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
              const dateStr = targetDate.toISOString().split("T")[0];
              
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                userId,
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
                      userId,
                      reportType: "SUBSCRIBER",
                      reportSubType: "DETAILED",
                      frequency: "DAILY",
                      vendorNumber,
                      reportDate: dateStr,
                      bundleId,
                      content: subscriberRes.tsv,
                    });
                    eventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriberReport, {
                      userId,
                      date: dateStr,
                      tsv: subscriberRes.tsv,
                    });
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: renewals=${eventData?.renewals || 0}, firstPayments=${eventData?.firstPayments || 0}`);
                  } else {
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: FAILED - HTTP ${subscriberRes.status}`);
                  }
                  
                  await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                    userId,
                    reportType: "SUBSCRIPTION",
                    reportSubType: "SUMMARY",
                    frequency: "DAILY",
                    vendorNumber,
                    reportDate: dateStr,
                    bundleId,
                    content: res.tsv,
                  });
                  await ctx.runMutation(internal.metrics.processAppStoreReport, {
                    userId,
                    date: dateStr,
                    tsv: res.tsv,
                    eventData,
                  });
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    userId,
                    message: `App Store: Successfully fetched and processed report for ${dateStr} (${res.tsv.length} bytes)${eventData ? ' with event data' : ''}`,
                    level: "success",
                  });
                  successfulFetch = true;
                  break; // Got a report, stop trying
                } else {
                  await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                    userId,
                    message: `App Store: Report for ${dateStr} not available (HTTP ${res.status})`,
                    level: "info",
                  });
                }
              } catch (error) {
                await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                  userId,
                  message: `App Store: Error fetching ${dateStr} - ${String(error)}`,
                  level: "info",
                });
              }
            }
            
            if (!successfulFetch) {
              await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
                userId,
                message: "App Store: No recent reports available (reports may be delayed)",
                level: "error",
              });
            }
          }
        }

        await ctx.runMutation(internal.syncHelpers.updateLastSync, {
          connectionId: connection._id,
        });

        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          userId,
          message: `${connection.platform}: Connection updated`,
          level: "info",
        });
      } catch (error) {
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          userId,
          message: `Error syncing ${connection.platform}: ${String(error)}`,
          level: "error",
        });
      }
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      userId,
      message: "Creating unified snapshots (today + historical)...",
      level: "info",
    });

    // Create unified snapshot for today
    await ctx.runMutation(internal.metrics.createUnifiedSnapshot, { userId });

    // Generate unified snapshots for ALL historical dates (past 365 days)
    const result = await ctx.runMutation(internal.metrics.generateUnifiedHistoricalSnapshots, { 
      userId,
      daysBack: 365,
    });

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      userId,
      message: `Created ${result.created} unified historical snapshots`,
      level: "info",
    });

      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        userId,
        message: "Sync completed",
        level: "success",
      });

      // Mark sync as completed
      await ctx.runMutation(internal.syncHelpers.completeSyncSession, {
        syncId,
        status: "completed",
      });

      return { success: true };
    } catch (error) {
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        userId,
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

export const syncAllUsers = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; usersProcessed: number }> => {
    const users = await ctx.runQuery(internal.syncHelpers.getAllUsersWithConnections);

    for (const user of users) {
      if (user && user._id) {
        await ctx.runAction(api.sync.syncAllPlatforms, { userId: user._id });
      }
    }

    return { success: true, usersProcessed: users.length };
  },
});
