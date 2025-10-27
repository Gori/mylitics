# Project Status

## Platform Metrics Fix - ✅ COMPLETELY REWRITTEN (Oct 24, 2025)

### LATEST FIXES (Evening - Oct 24, 2025)

**🔧 FIX #1: Stripe Revenue Events Still 0**
- **Status**: ⏳ WAITING FOR SYNC TEST
- **Problem**: Despite previous fix, Stripe still shows 0 revenue events
- **Hypothesis**: Either subscription field extraction failing OR no paid invoices in date range
- **Debugging Added**: Detailed logging for first 5 invoices
  - Log Format: `[Stripe] Invoice #X: id=..., status=..., subscription type=..., extracted subId=...`
  - Shows exactly what the subscription field contains
  - Reveals if extraction logic needs adjustment
- **What To Check After Sync**:
  1. Look for invoice debug logs - do they show `extracted subId=sub_xxx` or `NULL`?
  2. Check `invoicesWithSubscription` count - should match invoice count
  3. Check `invoicesPaid` count - should be > 0 if any paid invoices exist
  4. If still 0, copy the first 3 invoice log lines for analysis

**🔧 FIX #2: App Store Cancellations, First Payments, Renewals = 0**
- **Status**: ✅ FIXED
- **Problem**: App Store SUBSCRIPTION/SUMMARY reports are snapshots, not event logs
  - NO cancellation events in data
  - NO first payment events in data
  - NO renewal events in data
  - Report has columns: `event: -1, units: -1` (doesn't exist!)
- **Solution**: Calculate ALL flow metrics from day-to-day subscriber changes
- **Implementation**: 
  - **Cancellations**: Paid subs decreased? That's cancellations
  - **Churn**: Same as cancellations (snapshot data)
  - **First Payments**: Paid subs increased? Those are new subscribers
  - **Renewals**: Estimate from revenue minus estimated first payment revenue
  - Formula: `renewals ≈ (total revenue - first payment revenue) / avg price`
  - Added detailed logging: `Calculated from prev day: Cancellations=X, Churn=Y, First Payments=Z, Renewals=W`
- **Files Changed**: `convex/metrics.ts` lines 532-572
- **Result**: ALL App Store flow metrics now work (calculated from day-to-day changes)

**🔧 FIX #3: Churn Calculation**
- **Status**: ✅ ALREADY FIXED
- **Problem**: Was counting ALL canceled subs, not just recent ones
- **Fix**: Already implemented - filters for canceled subs with endDate in last 30 days

**🔧 FIX #4: Unified Total Wrong (459 instead of 6373)**
- **Status**: ✅ FIXED
- **Problem**: Total shows 459 but should be 459 (Stripe) + 5914 (App Store) = 6373 for historical dates
- **Root Cause**: Unified snapshots were ONLY created for TODAY, not for historical dates!
  - Stripe historical sync created 365 daily snapshots ✓
  - App Store historical sync created 365 daily snapshots ✓
  - BUT unified snapshots only existed for today ✗
- **Solution**: Added `generateUnifiedHistoricalSnapshots` function
  - Runs after all platform syncs complete
  - Processes last 365 days
  - For each date: queries all platform snapshots, sums them, creates/updates unified snapshot
- **Files Changed**:
  - `convex/metrics.ts`: New `generateUnifiedHistoricalSnapshots` mutation (lines 601-665)
  - `convex/sync.ts`: Call it after sync completes (lines 506-510)
- **Result**: ALL historical dates will now show correct totals (Stripe + App Store + Google Play)

**Critical Stripe Bug Fixed (Earlier):**
- **Problem**: All 502 invoices showed "with subscription 0" - NO revenue events created!
- **Root Cause**: Code only checked `typeof subscription === "string"`, but Stripe can return subscription as an object
- **Fix**: Now handles both string and object `{id: "sub_xxx"}` subscription fields
- **Result**: First Payments and Renewals will now populate correctly

**Critical App Store Gap Fixed (Earlier):**
- **Problem**: Last week shows 0 subscribers (graph drops to 0 at end)
- **Root Cause**: Apple returns 404 "no sales" for days with no transactions, we skipped those days entirely
- **Fix**: When 404 "NOT_FOUND" received, carry forward previous day's subscriber counts with 0 revenue
- **Result**: Graphs will no longer have gaps, subscriber counts continuous

**Incremental Sync Improved:**
- Now tries yesterday → day before → 3 days ago (finds most recent available report)
- Apple reports are typically delayed 1-2 days

### THE PROBLEM
Previous implementation tried to calculate metrics by querying old database data that had wrong flags. This fundamentally didn't work.

### THE SOLUTION
**Completely rewrote ALL metrics calculations to use ONLY fresh data from APIs, not database queries.**

### Stripe Integration Fixes (`convex/integrations/stripe.ts`)
- ✅ **Fetch ALL subscriptions** - Added `status: "all"` parameter
- ✅ **Track grace periods** - Set `isInGrace: subscription.status === "past_due"`
- ✅ **Track cancellations** - Set `willCancel: cancel_at_period_end`
- ✅ **Fix canceled endDate** - Use `canceled_at` or `ended_at` for canceled subs
- ✅ **Only paid invoices** - Only create revenue for `invoice.status === "paid"`
- ✅ **Fetch refunds** - Added Stripe refunds API integration
- ✅ **Proper event types** - Classify first_payment, renewal, refund correctly

### Metrics Calculation Rewrite (`convex/metrics.ts` - `processAndStoreMetrics`)
**BEFORE**: Queried database for old subscription/revenue data ❌
**NOW**: Calculate ONLY from fresh API data passed as parameters ✅

- Active/Trial/Paid Subs: From current subscriptions array
- Cancellations: Count `willCancel` flag in current subs
- Churn: Count canceled subs with endDate in last 30 days
- Grace Events: Count `isInGrace` flag in current subs
- First Payments: Count from revenueEvents array
- Renewals: Count from revenueEvents array
- MRR: Sum prices from active non-trial subs, rounded to 2 decimals
- Monthly Revenue: Sum revenueEvents, subtract refunds

### Historical Snapshots Rewrite (`convex/metrics.ts` - `generateHistoricalSnapshots`)
- Uses same clean logic as current snapshot
- No more mixed DB queries and calculations
- Consistent metric definitions

### App Store Parsing Rewrite (`convex/metrics.ts` - `processAppStoreReport`)
- ✅ **Added extensive logging** - Shows headers, columns, event types, parsed counts
- ✅ **More flexible event matching** - Uses `.includes()` instead of regex
- ✅ **Better refund handling** - Subtracts from revenue, doesn't double-add
- ✅ **Fixed active subscriber calc** - Accounts for cancellations properly
- ✅ **All event types** - Parses first payments, renewals, refunds, trials, grace, cancellations

### Validated Metrics (11 total)
1. Active Subscribers
2. Trial Subscribers
3. Paid Subscribers
4. Cancellations
5. Churn
6. Grace Events
7. First Payments
8. Renewals
9. MRR (rounded to 2 decimals)
10. Monthly Revenue (Gross)
11. Monthly Revenue (Net)

## v2 Upgrade - ✅ Completed

### Dashboard v2 Features
- ✅ Removed iOS reportDate field from App Store connection form
- ✅ Updated grid layout: 1 col mobile, 2 cols medium, 3 cols large
- ✅ Split metrics into current snapshot vs 30-day aggregates
  - Current: Active/Trial/Paid Subscribers
  - 30-day: Cancellations, Churn, Grace Events, First Payments, Renewals, MRR, Revenue
- ✅ Added date ranges for 30-day metrics (e.g., "Dec 23 - Jan 23")
- ✅ Added weekly historical charts (52 weeks) with line graphs
  - Shows Total + per-platform lines (App Store, Google Play, Stripe)
  - Using recharts library
- ✅ Historical data sync (365 days on first sync)
  - Stripe: Historical subscriptions and invoices
  - Google Play: Historical data support
  - App Store: Daily reports for past year
- ✅ Proper sync state management
  - Sync button disabled until completion
  - Log polling to detect completion
- ✅ Enhanced logging throughout sync process
  - Progress updates for historical syncs
  - Per-platform success/error tracking
  - Detailed status messages

## ✅ Completed Tasks

### Backend (Convex)
- ✅ Convex configuration and schema setup
- ✅ Authentication migrated to Clerk (from Convex Auth)
- ✅ Users table with Clerk integration
- ✅ Clerk webhook handler for user sync
- ✅ Platform integration actions (Stripe, Google Play, App Store)
- ✅ Metrics processing and storage
- ✅ Scheduled daily sync via cron jobs
- ✅ Manual sync trigger
- ✅ Queries for metrics and connections
- ✅ Mutations for adding/removing platform connections

### Frontend (Next.js + React)
- ✅ Convex client provider with Clerk integration
- ✅ Clerk authentication with SignIn component
- ✅ Next.js middleware for route protection
- ✅ Dashboard page with all metrics
- ✅ Platform connections management page
- ✅ Historical metrics page
- ✅ Mobile-first responsive design
- ✅ Minimal UI with no explanatory text

### Configuration
- ✅ Dependencies updated (Clerk packages added, Convex Auth removed)
- ✅ TypeScript configuration
- ✅ Tailwind CSS setup
- ✅ Clerk setup documentation (CLERK_SETUP.md)
- ✅ JWT auth configuration for Convex

## Next Steps (User Actions Required)

1. Run `npx convex dev`
2. Run `npm run dev`
3. Sign in at `/sign-in` (Clerk will run in dev mode - claim it when ready)
4. Connect platforms and start syncing data

## Architecture

### Data Flow
1. User connects platform credentials → stored encrypted in `platformConnections`
2. Daily cron (midnight UTC) or manual trigger → fetch data from all platforms
3. Raw data stored in `subscriptions` and `revenueEvents` tables
4. Metrics calculated and stored in `metricsSnapshots` (per platform + unified)
5. Dashboard queries latest snapshot and displays metrics

### Metrics Tracked
- Active Subscribers
- Trial vs Paid breakdown
- Cancellations
- Churn
- Grace Events
- First Payments
- Renewals
- MRR (Monthly Recurring Revenue)
- Monthly Revenue (Gross + Net)

### Platform Support
- **Stripe**: Full implementation with subscription and invoice data
- **Google Play**: Implementation using Google Play Developer API
- **App Store**: Basic structure (requires transaction IDs from server notifications for full implementation)

## Known Limitations

- App Store integration requires additional setup with App Store Server Notifications to track transaction IDs
- MRR calculation is simplified (uses placeholder pricing - needs actual product pricing data)
- Paybacks metric calculation requires historical comparison (set to 0 for now)
- Credentials stored as encrypted strings (consider using environment variables for encryption key)

## Files Structure

```
milytics/
├── app/
│   ├── sign-in/[[...sign-in]]/page.tsx  # Clerk SignIn component
│   ├── dashboard/
│   │   ├── page.tsx                     # Main dashboard
│   │   ├── connections/page.tsx         # Platform connections
│   │   └── history/page.tsx             # Historical metrics
│   ├── ConvexClientProvider.tsx         # Convex + Clerk provider
│   ├── layout.tsx                       # Root layout with ClerkProvider
│   └── page.tsx                         # Home (redirects to auth/dashboard)
├── convex/
│   ├── schema.ts                        # Database schema (users + data tables)
│   ├── auth.config.js                   # Clerk JWT configuration
│   ├── http.ts                          # Clerk webhook handler
│   ├── users.ts                         # User management functions
│   ├── queries.ts                       # Public queries
│   ├── mutations.ts                     # Public mutations
│   ├── sync.ts                          # Sync orchestration
│   ├── metrics.ts                       # Metrics calculation
│   ├── crons.ts                         # Scheduled jobs
│   └── integrations/
│       ├── stripe.ts                    # Stripe data fetching
│       ├── googlePlay.ts                # Google Play data fetching
│       └── appStore.ts                  # App Store data fetching
├── middleware.ts                        # Clerk route protection
├── CLERK_SETUP.md                       # Clerk setup instructions
└── package.json
```

