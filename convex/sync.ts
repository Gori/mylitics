"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { fetchStripe } from "./integrations/stripe";
import { fetchGooglePlayFromGCS } from "./integrations/googlePlay";
import { fetchAppStore, downloadASCSubscriptionSummary, downloadASCSubscriberReport, downloadASCSubscriptionEventReport } from "./integrations/appStore";
import { parseCredentials, tryJsonParse } from "./lib/safeJson";
import {
  ONE_YEAR_MS,
  THIRTY_DAYS_MS,
  NINETY_DAYS_MS,
  ONE_DAY_MS,
  SYNC_CHUNK_SIZE_DAYS,
  HISTORICAL_SYNC_DAYS,
  DB_BATCH_SIZE,
  MAX_DELETE_BATCH,
  UNIFIED_SYNC_CHUNK_DAYS,
  SCHEDULER_DELAY_MS,
  SAMPLE_SIZE_STANDARD,
  SAMPLE_SIZE_SMALL,
  SAMPLE_SIZE_LARGE,
  SAMPLE_SIZE_XLARGE,
} from "./lib/constants";

// Use constants from lib/constants.ts
const CHUNK_SIZE = SYNC_CHUNK_SIZE_DAYS;
const TOTAL_HISTORICAL_DAYS = HISTORICAL_SYNC_DAYS;

export const syncAllPlatforms = action({
  args: {
    appId: v.id("apps"),
    forceHistorical: v.optional(v.boolean()),
    platform: v.optional(v.union(v.literal("stripe"), v.literal("googleplay"), v.literal("appstore"))),
  },
  handler: async (ctx, { appId, forceHistorical, platform }) => {
    // Start sync session and cancel any existing active syncs
    const syncId = await ctx.runMutation(internal.syncHelpers.startSync, { appId });
    
    // Track if we started a chunked sync (means we need to defer finalization)
    let hasChunkedSync = false;
    
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
    
    // Sort connections to process Stripe and Google Play FIRST, App Store LAST
    // This ensures other platforms sync before we potentially start a chunked App Store sync
    const platformOrder = { stripe: 0, googleplay: 1, appstore: 2 };
    connections = connections.sort((a: { platform: string }, b: { platform: string }) => 
      (platformOrder[a.platform as keyof typeof platformOrder] ?? 99) - 
      (platformOrder[b.platform as keyof typeof platformOrder] ?? 99)
    );

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
          const credentials = parseCredentials<{ apiKey: string }>(connection.credentials, "stripe");
          
          if (isFirstSync) {
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "Stripe: First sync detected, fetching historical data (365 days)",
              level: "info",
            });

            const oneYearAgo = Date.now() - ONE_YEAR_MS;
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

            // For full sync: Delete old revenue events first to ensure clean data with correct proceeds
            console.log(`[Stripe] Full sync: Deleting old revenue events for clean re-import...`);
            let totalDeleted = 0;
            let deleteResult;
            do {
              deleteResult = await ctx.runMutation(internal.metrics.deleteRevenueEventsForPlatform, {
                appId,
                platform: "stripe",
                maxToDelete: 500,
              });
              totalDeleted += deleteResult.deleted;
              if (deleteResult.hasMore) {
                console.log(`[Stripe] Deleted ${totalDeleted} old revenue events so far...`);
              }
            } while (deleteResult.hasMore);
            console.log(`[Stripe] Deleted ${totalDeleted} old revenue events total`);
            
            // Store revenue events in batches to avoid 16MB read limit
            const BATCH_SIZE = 100;
            let totalStored = 0, totalUpdated = 0, totalSkipped = 0;
            for (let i = 0; i < data.revenueEvents.length; i += BATCH_SIZE) {
              const batch = data.revenueEvents.slice(i, i + BATCH_SIZE);
              const result = await ctx.runMutation(internal.metrics.storeRevenueEventsBatch, {
                appId,
                platform: "stripe",
                events: batch,
              });
              totalStored += result.stored;
              totalUpdated += result.updated;
              totalSkipped += result.skipped;
              if (i % 500 === 0 && i > 0) {
                console.log(`[Stripe] Stored revenue events batch ${i}/${data.revenueEvents.length}`);
              }
            }
            console.log(`[Stripe] Revenue events: ${totalStored} stored, ${totalUpdated} updated, ${totalSkipped} skipped`);
            
            const result1 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              appId,
              platform: "stripe",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
              skipRevenueEventStorage: true, // Already stored in batches above
            });
            // Generate daily snapshots for past 365 days from stored raw data in monthly chunks
            const nowMs = Date.now();
            const thirtyDaysMs = THIRTY_DAYS_MS;
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

            // Store revenue events in batches for incremental sync too
            const BATCH_SIZE_INC = 100;
            for (let i = 0; i < data.revenueEvents.length; i += BATCH_SIZE_INC) {
              const batch = data.revenueEvents.slice(i, i + BATCH_SIZE_INC);
              await ctx.runMutation(internal.metrics.storeRevenueEventsBatch, {
                appId,
                platform: "stripe",
                events: batch,
              });
            }
            
            const result2 = await ctx.runMutation(internal.metrics.processAndStoreMetrics, {
              appId,
              platform: "stripe",
              subscriptions: data.subscriptions,
              revenueEvents: data.revenueEvents,
              skipRevenueEventStorage: true,
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
          const credentials = parseCredentials<{
            serviceAccountJson: string;
            packageName: string;
            gcsBucketName?: string;
            gcsReportPrefix?: string;
          }>(connection.credentials, "googleplay");
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

          // Fetch exchange rates from database for currency conversion
          const exchangeRates = await ctx.runQuery(internal.syncHelpers.getExchangeRatesToUSD, {});

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
                undefined, // No date filter - get all historical data
                undefined,
                exchangeRates
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
                refundsByDate: data.refundsByDate || {},
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
            const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;

            try {
              const data = await fetchGooglePlayFromGCS(
                serviceAccountJson,
                packageName,
                gcsBucketName,
                gcsReportPrefix || "",
                ninetyDaysAgo,
                undefined,
                exchangeRates
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
                  refundsByDate: data.refundsByDate || {},
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
          const credentials = parseCredentials<{
            issuerId: string;
            keyId: string;
            privateKey: string;
            vendorNumber: string;
            bundleId?: string;
          }>(connection.credentials, "appstore");
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
            // ===== CHUNKED HISTORICAL SYNC =====
            // Instead of processing all 365 days in this action (which times out),
            // we create a progress record and schedule the first chunk.
            // Each chunk is a separate action that processes ~30 days and schedules the next.
            
            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: First sync detected - starting chunked historical sync...",
              level: "info",
            });

            const oneYearAgo = new Date(Date.now() - TOTAL_HISTORICAL_DAYS * 24 * 60 * 60 * 1000);
            const startDate = oneYearAgo.toISOString().split("T")[0];
            const totalChunks = Math.ceil(TOTAL_HISTORICAL_DAYS / CHUNK_SIZE);

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: `App Store: Scheduling ${TOTAL_HISTORICAL_DAYS} days in ${totalChunks} batches of ${CHUNK_SIZE} days each`,
              level: "info",
            });

            // Create progress tracking record
            const progressId = await ctx.runMutation(internal.syncHelpers.createSyncProgress, {
              syncId,
              appId,
              platform: "appstore",
              totalDays: TOTAL_HISTORICAL_DAYS,
              chunkSize: CHUNK_SIZE,
              startDate,
              connectionId: connection._id,
              credentials: connection.credentials,
            });

            // Schedule the first chunk - this action will complete immediately
            // and the chunks will process asynchronously
            await ctx.scheduler.runAfter(100, internal.sync.syncAppStoreChunk, {
              progressId,
              syncId,
              appId,
            });

            await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
              appId,
              message: "App Store: Historical sync started - processing in background...",
              level: "info",
            });

            // Mark that we have a chunked sync in progress
            // The chunked sync finalization will handle unified snapshots and completion
            hasChunkedSync = true;
            
            // Skip the rest of App Store processing and updateLastSync
            // (the chunked sync will handle that when it completes)
            continue;
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
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: renewals=${eventData?.renewals || 0}, firstPayments=${eventData?.firstPayments || 0}, chargedRevenue=${eventData?.revenueGross?.toFixed(2) || '0.00'}, revenue=${eventData?.revenueNet?.toFixed(2) || '0.00'}`);
                  } else {
                    console.log(`[Sync] SUBSCRIBER report for ${dateStr}: FAILED - HTTP ${subscriberRes.status}`);
                  }
                  
                  // Fetch SUBSCRIPTION_EVENT report (actual subscription events: Subscribe, Cancel, etc.)
                  const eventRes = await downloadASCSubscriptionEventReport(
                    issuerId,
                    keyId,
                    privateKey,
                    vendorNumber,
                    dateStr,
                    "DAILY",
                    "1_3"
                  );
                  
                  let subscriptionEventData = undefined;
                  if (eventRes.ok) {
                    await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
                      appId,
                      reportType: "SUBSCRIPTION_EVENT",
                      reportSubType: "SUMMARY",
                      frequency: "DAILY",
                      vendorNumber,
                      reportDate: dateStr,
                      bundleId,
                      content: eventRes.tsv,
                    });
                    subscriptionEventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriptionEventReport, {
                      appId,
                      date: dateStr,
                      tsv: eventRes.tsv,
                    });
                    console.log(`[Sync] SUBSCRIPTION_EVENT report for ${dateStr}: newSubscriptions=${subscriptionEventData?.newSubscriptions || 0}, cancellations=${subscriptionEventData?.cancellations || 0}, conversions=${subscriptionEventData?.conversions || 0}`);
                  } else {
                    console.log(`[Sync] SUBSCRIPTION_EVENT report for ${dateStr}: not available (HTTP ${eventRes.status})`);
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
                    subscriptionEventData,
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

        await ctx.runMutation(internal.syncHelpers.updateLastSync, {
          connectionId: connection._id,
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

    // If we have a chunked sync in progress, skip finalization here
    // The chunked sync's finalization action will handle unified snapshots and completion
    if (hasChunkedSync) {
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "App Store historical sync running in background - unified snapshots will be created when complete",
        level: "info",
      });
      
      // Don't mark sync as completed - the chunked sync will do that
      return { success: true, chunkedSync: true };
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: "Creating unified snapshots (today + historical)...",
      level: "info",
    });

    // Create unified snapshot for today
    await ctx.runMutation(internal.metrics.createUnifiedSnapshot, { appId });

    // Generate unified snapshots in chunks to avoid timeout (100 days per chunk)
    const UNIFIED_CHUNK_SIZE = 100;
    const totalDays = 365;
    let totalCreated = 0;

    for (let startDay = totalDays; startDay >= 1; startDay -= UNIFIED_CHUNK_SIZE) {
      const endDay = Math.max(startDay - UNIFIED_CHUNK_SIZE + 1, 1);
      
      const result = await ctx.runMutation(internal.metrics.generateUnifiedHistoricalSnapshotsChunk, { 
        appId,
        startDayBack: startDay,
        endDayBack: endDay,
      });
      
      totalCreated += result.created;
    }

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: `Created ${totalCreated} unified historical snapshots`,
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

      return { success: true };
    } catch (error) {
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

    const credentials = parseCredentials<{
      serviceAccountJson: string;
      packageName: string;
      gcsBucketName?: string;
      gcsReportPrefix?: string;
    }>(gpConnection.credentials, "googleplay");
    const { serviceAccountJson, packageName, gcsBucketName, gcsReportPrefix } = credentials;

    if (!gcsBucketName) {
      return { error: "No GCS bucket configured" };
    }

    // Import GCS Storage and list files directly
    const { Storage } = await import("@google-cloud/storage");
    const serviceAccountCredentials = parseCredentials(serviceAccountJson, "googleplay service account");
    const storage = new Storage({ credentials: serviceAccountCredentials });

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

// ===== CHUNKED SYNC ACTIONS =====
// These actions process data in small chunks to avoid the 10-minute timeout

/**
 * Process a single chunk of App Store historical data.
 * Each chunk handles ~30 days, then schedules the next chunk.
 */
export const syncAppStoreChunk = internalAction({
  args: {
    progressId: v.id("syncProgress"),
    syncId: v.id("syncStatus"),
    appId: v.id("apps"),
  },
  handler: async (ctx, { progressId, syncId, appId }) => {
    console.log(`[Chunked Sync] Starting chunk processing for progressId=${progressId}`);
    
    // Get current progress
    const progress = await ctx.runQuery(internal.syncHelpers.getSyncProgress, { progressId });
    if (!progress) {
      console.error("[Chunked Sync] Progress record not found - sync may have been cancelled");
      return;
    }

    // Check if sync was cancelled
    const isCancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
    if (isCancelled) {
      console.log("[Chunked Sync] Sync was cancelled by user");
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "App Store: Sync cancelled by user",
        level: "info",
      });
      await ctx.runMutation(internal.syncHelpers.deleteSyncProgress, { progressId });
      return;
    }

    const { currentChunk, totalChunks, totalDays, processedDays, startDate, credentials, connectionId } = progress;
    
    // Validate connectionId exists
    if (!connectionId) {
      console.error("[Chunked Sync] No connectionId in progress record");
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: "App Store: Error - missing connection ID in progress record",
        level: "error",
      });
      return;
    }
    
    const { issuerId, keyId, privateKey, vendorNumber, bundleId } = parseCredentials<{
      issuerId: string;
      keyId: string;
      privateKey: string;
      vendorNumber: string;
      bundleId?: string;
    }>(credentials, "appstore");

    const chunkNum = currentChunk + 1;
    const chunkStart = currentChunk * CHUNK_SIZE;
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, totalDays);
    const daysInChunk = chunkEnd - chunkStart;

    console.log(`[Chunked Sync] Chunk ${chunkNum}/${totalChunks}: days ${chunkStart}-${chunkEnd-1} (${daysInChunk} days)`);

    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: `App Store: Processing batch ${chunkNum}/${totalChunks} (days ${chunkStart + 1}-${chunkEnd} of ${totalDays})`,
      level: "info",
    });

    const oneYearAgo = new Date(startDate);
    let successCount = 0;
    let errorCount = 0;
    let skippedRecentDays = 0;
    const errorSamples: string[] = [];
    let lastProcessedDate = progress.lastProcessedDate;
    
    // Comprehensive data collection for chunk summary
    type DayData = {
      date: string;
      active: number;
      paid: number;
      trial: number;
      monthly: number;
      yearly: number;
      renewals: number;
      firstPayments: number;
      cancellations: number;
      chargedRevenue: number;
      revenue: number;
      mrr: number;
      productIds: string[];
      currencies: Record<string, number>;
      eventTypes: Record<string, number>;
    };
    
    const chunkData: DayData[] = [];
    const allProductIds = new Set<string>();
    const allCurrencies: Record<string, number> = {};
    const allEventTypes: Record<string, number> = {};

    // Process each day in this chunk
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
          
          // Fetch SUBSCRIPTION_EVENT report (actual subscription events: Subscribe, Cancel, etc.)
          const eventRes = await downloadASCSubscriptionEventReport(
            issuerId,
            keyId,
            privateKey,
            vendorNumber,
            dateStr,
            "DAILY",
            "1_3"
          );
          
          let subscriptionEventData = undefined;
          if (eventRes.ok) {
            await ctx.runMutation(internal.syncHelpers.saveAppStoreReport, {
              appId,
              reportType: "SUBSCRIPTION_EVENT",
              reportSubType: "SUMMARY",
              frequency: "DAILY",
              vendorNumber,
              reportDate: dateStr,
              bundleId,
              content: eventRes.tsv,
            });
            subscriptionEventData = await ctx.runMutation(internal.metrics.processAppStoreSubscriptionEventReport, {
              appId,
              date: dateStr,
              tsv: eventRes.tsv,
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
          const reportResult = await ctx.runMutation(internal.metrics.processAppStoreReport, {
            appId,
            date: dateStr,
            tsv: res.tsv,
            eventData,
            subscriptionEventData,
          });
          successCount++;
          lastProcessedDate = dateStr;
          
          // Collect comprehensive data for chunk summary
          if (reportResult) {
            const { snapshot, parsing } = reportResult;
            
            // Collect day data
            chunkData.push({
              date: dateStr,
              active: snapshot.activeSubscribers,
              paid: snapshot.paidSubscribers,
              trial: snapshot.trialSubscribers,
              monthly: snapshot.monthlySubscribers,
              yearly: snapshot.yearlySubscribers,
              renewals: snapshot.renewals,
              firstPayments: snapshot.firstPayments,
              cancellations: snapshot.cancellations,
              chargedRevenue: snapshot.monthlyChargedRevenue,
              revenue: snapshot.monthlyRevenue,
              mrr: snapshot.mrr,
              productIds: parsing.productIds,
              currencies: eventData?.currenciesSeen || {},
              eventTypes: eventData?.eventTypes || {},
            });
            
            // Aggregate across chunk
            parsing.productIds.forEach((id: string) => allProductIds.add(id));
            if (eventData?.currenciesSeen) {
              Object.entries(eventData.currenciesSeen).forEach(([currency, count]) => {
                allCurrencies[currency] = (allCurrencies[currency] || 0) + (count as number);
              });
            }
            if (eventData?.eventTypes) {
              Object.entries(eventData.eventTypes).forEach(([type, count]) => {
                allEventTypes[type] = (allEventTypes[type] || 0) + (count as number);
              });
            }
          }
        } else {
          let parsed: any = null;
          try { parsed = JSON.parse(res.text); } catch {}
          const code = parsed?.errors?.[0]?.code;
          
          // Skip NOT_FOUND errors for recent dates (last 3 days) - reports are delayed
          const daysOld = totalDays - dayOffset;
          if (code === "NOT_FOUND" && daysOld <= 3) {
            console.log(`[Chunked Sync] Skipping ${dateStr} (${daysOld} day(s) old) - Apple report delay`);
            skippedRecentDays++;
            continue;
          }
          
          // Skip "no sales" reports
          if (code === "NOT_FOUND" && res.text.includes("no sales")) {
            console.log(`[Chunked Sync] Skipping ${dateStr} - no sales`);
            skippedRecentDays++;
            continue;
          }
          
          errorCount++;
          if (errorSamples.length < 2) {
            const title = parsed?.errors?.[0]?.title;
            const detail = parsed?.errors?.[0]?.detail;
            const errorMsg = `${dateStr}: HTTP ${res.status}${code ? ` [${code}]` : ""}${title ? ` ${title}` : ""}${detail ? ` - ${detail}` : ""}`;
            errorSamples.push(errorMsg);
          }
        }
      } catch (error) {
        errorCount++;
        if (errorSamples.length < 2) {
          errorSamples.push(`${dateStr}: ${String(error)}`);
        }
      }
    }

    // Update progress and finalize chunk
    try {
      console.log(`[Chunked Sync] Chunk ${chunkNum} loop complete: success=${successCount}, errors=${errorCount}, skipped=${skippedRecentDays}, lastDate=${lastProcessedDate}`);
      
      const newProcessedDays = processedDays + daysInChunk;
      await ctx.runMutation(internal.syncHelpers.updateSyncProgress, {
        progressId,
        currentChunk: chunkNum,
        processedDays: newProcessedDays,
        lastProcessedDate,
      });

      // ===== COMPREHENSIVE CHUNK SUMMARY =====
      // Using console.log so it appears in Convex dashboard logs
      
      const firstDate = chunkData.length > 0 ? chunkData[0].date : "N/A";
      const lastDate = chunkData.length > 0 ? chunkData[chunkData.length - 1].date : "N/A";
      
      // Header
      console.log(`\n═══════════════════════════════════════════════════════════════════`);
      console.log(`[App Store Batch ${chunkNum}/${totalChunks}] ${firstDate} → ${lastDate}`);
      console.log(`───────────────────────────────────────────────────────────────────`);
      
      // Status counts
      const statusParts = [`${successCount} days synced`];
      if (skippedRecentDays > 0) statusParts.push(`${skippedRecentDays} skipped (Apple delay)`);
      if (errorCount > 0) statusParts.push(`${errorCount} errors`);
      console.log(`STATUS: ${statusParts.join(" | ")}`);
      
      if (chunkData.length > 0) {
        // Aggregate totals
        const totals = chunkData.reduce((acc, day) => ({
          renewals: acc.renewals + day.renewals,
          firstPayments: acc.firstPayments + day.firstPayments,
          cancellations: acc.cancellations + day.cancellations,
          chargedRevenue: acc.chargedRevenue + day.chargedRevenue,
          revenue: acc.revenue + day.revenue,
        }), { renewals: 0, firstPayments: 0, cancellations: 0, chargedRevenue: 0, revenue: 0 });
        
        // Latest snapshot values (end of chunk)
        const latest = chunkData[chunkData.length - 1];
        
        // Subscriber counts (snapshot - from last day)
        console.log(`SUBSCRIBERS (end of chunk): Active=${latest.active} | Paid=${latest.paid} | Trial=${latest.trial} | Monthly=${latest.monthly} | Yearly=${latest.yearly}`);
        
        // Flow metrics (aggregated across chunk)
        console.log(`EVENTS (chunk total): Renewals=${totals.renewals} | FirstPayments=${totals.firstPayments} | Cancellations=${totals.cancellations}`);
        
        // Revenue (aggregated)
        console.log(`REVENUE (chunk total): Charged=${totals.chargedRevenue.toFixed(2)} | Revenue=${totals.revenue.toFixed(2)} | MRR(latest)=${latest.mrr.toFixed(2)}`);
        
        // Product IDs
        if (allProductIds.size > 0) {
          console.log(`PRODUCTS (${allProductIds.size}): ${Array.from(allProductIds).join(", ")}`);
        }
        
        // Currencies seen
        if (Object.keys(allCurrencies).length > 0) {
          const currencyStr = Object.entries(allCurrencies)
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c}:${n}`)
            .join(", ");
          console.log(`CURRENCIES: ${currencyStr}`);
        }
        
        // Event types breakdown
        if (Object.keys(allEventTypes).length > 0) {
          const eventStr = Object.entries(allEventTypes)
            .sort((a, b) => b[1] - a[1])
            .map(([e, n]) => `${e}:${n}`)
            .join(", ");
          console.log(`EVENT TYPES: ${eventStr}`);
        }
        
        // Per-day breakdown table
        console.log(`───────────────────────────────────────────────────────────────────`);
        console.log(`PER-DAY DATA:`);
        
        // Show each day's data in compact format
        for (const day of chunkData) {
          console.log(`  ${day.date}: Active=${day.active} Paid=${day.paid} Trial=${day.trial} | Mo=${day.monthly} Yr=${day.yearly} | Ren=${day.renewals} 1st=${day.firstPayments} Can=${day.cancellations} | Charged=${day.chargedRevenue.toFixed(2)} Rev=${day.revenue.toFixed(2)} MRR=${day.mrr.toFixed(2)}`);
        }
      }
      
      // Errors
      if (errorSamples.length > 0) {
        console.log(`ERRORS: ${errorSamples.join("; ")}`);
      }
      
      console.log(`═══════════════════════════════════════════════════════════════════\n`);
      
      // Also save a summary to syncLogs for the UI
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: `App Store: Batch ${chunkNum}/${totalChunks} complete [${firstDate} → ${lastDate}] - ${successCount} days, ${chunkData.length > 0 ? chunkData.reduce((a, d) => a + d.renewals, 0) : 0} renewals, ${chunkData.length > 0 ? chunkData.reduce((a, d) => a + d.revenue, 0).toFixed(2) : '0'} revenue`,
        level: successCount > 0 ? "success" : "info",
      });

      // Check if there are more chunks to process
      if (chunkNum < totalChunks) {
        // Schedule next chunk (with small delay to avoid overwhelming the system)
        console.log(`[Chunked Sync] Scheduling next chunk ${chunkNum + 1}/${totalChunks}`);
        await ctx.scheduler.runAfter(100, internal.sync.syncAppStoreChunk, {
          progressId,
          syncId,
          appId,
        });
      } else {
        // All chunks complete - update connection and clean up
        console.log(`[Chunked Sync] All chunks complete, finalizing...`);
        
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: `App Store: Historical sync completed - ${newProcessedDays} days processed`,
          level: "success",
        });

        await ctx.runMutation(internal.syncHelpers.updateLastSync, {
          connectionId: progress.connectionId,
        });

        // Delete progress record
        await ctx.runMutation(internal.syncHelpers.deleteSyncProgress, { progressId });

        // Schedule the finalization (unified snapshots, etc.)
        console.log(`[Chunked Sync] Scheduling finalization...`);
        await ctx.scheduler.runAfter(100, internal.sync.finalizeSyncAfterAppStore, {
          syncId,
          appId,
        });
      }
    } catch (error) {
      console.error(`[Chunked Sync] Error in chunk ${chunkNum} finalization:`, error);
      await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
        appId,
        message: `App Store: Chunk ${chunkNum} finalization error: ${error instanceof Error ? error.message : String(error)}`,
        level: "error",
      });
      throw error;
    }
  },
});

/**
 * Finalize sync after App Store historical data is done.
 * Creates unified snapshots in chunks to avoid timeout.
 */
export const finalizeSyncAfterAppStore = internalAction({
  args: {
    syncId: v.id("syncStatus"),
    appId: v.id("apps"),
  },
  handler: async (ctx, { syncId, appId }) => {
    console.log("[Finalization] Starting App Store finalization...");
    
    // Check if sync was cancelled
    const isCancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
    if (isCancelled) {
      console.log("[Finalization] Sync was cancelled, skipping finalization");
      return;
    }

    console.log("[Finalization] Creating unified snapshots...");
    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: "Creating unified snapshots (chunked)...",
      level: "info",
    });

    // Create unified snapshot for today
    await ctx.runMutation(internal.metrics.createUnifiedSnapshot, { appId });

    // Generate unified snapshots in chunks of 100 days
    const UNIFIED_CHUNK_SIZE = 100;
    const totalDays = 365;
    let totalCreated = 0;

    for (let startDay = totalDays; startDay >= 1; startDay -= UNIFIED_CHUNK_SIZE) {
      const endDay = Math.max(startDay - UNIFIED_CHUNK_SIZE + 1, 1);
      
      // Check if sync was cancelled before each chunk
      const cancelled = await ctx.runQuery(internal.syncHelpers.checkSyncCancelled, { syncId });
      if (cancelled) {
        await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
          appId,
          message: "Unified snapshot creation cancelled",
          level: "info",
        });
        return;
      }

      const result = await ctx.runMutation(internal.metrics.generateUnifiedHistoricalSnapshotsChunk, { 
        appId,
        startDayBack: startDay,
        endDayBack: endDay,
      });
      
      totalCreated += result.created;
    }

    console.log(`[Finalization] Created ${totalCreated} unified historical snapshots`);
    await ctx.runMutation(internal.syncHelpers.appendSyncLog, {
      appId,
      message: `Created ${totalCreated} unified historical snapshots`,
      level: "info",
    });

    console.log("[Finalization] Marking sync as completed...");
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
    
    console.log("[Finalization] ✅ App Store sync fully completed!");
  },
});
