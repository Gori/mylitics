# Full Sync Test Checklist

## All Fixes Applied ✅

### Fix #1: Unified Total Not Working for Historical Dates ✅
**Problem**: Total shows 459 (only Stripe) instead of 6373 (Stripe + App Store)  
**Solution**: Added `generateUnifiedHistoricalSnapshots` - now creates unified snapshots for all 365 historical days  
**Expected After Sync**: All dates show correct totals (sum of all platforms)

### Fix #2: App Store Cancellations, First Payments, Renewals = 0 ✅
**Problem**: Apple SUMMARY reports are snapshots, not event logs - no event data  
**Solution**: Calculate from day-to-day paid subscriber changes  
**Expected After Sync**: 
- Cancellations: Shows when paid subs decrease day-to-day
- First Payments: Shows when paid subs increase day-to-day  
- Renewals: Estimated from revenue

### Fix #3: Churn Already Fixed ✅
**Problem**: Counted ALL canceled subs (not just recent)  
**Solution**: Filter for subs canceled in last 30 days  
**Expected**: Churn shows recent cancellations only

### Fix #4: Stripe Revenue Events Still 0 ⏳
**Problem**: `invoicesWithSubscription = 0` - subscription ID extraction failing  
**Solution**: Added detailed debug logging  
**What To Check**: Look for invoice logs showing subscription field type and extracted ID

---

## How To Test

### Step 1: Run Full Sync
Click **"Sync All Platforms"** button in dashboard

### Step 2: Watch Sync Logs For These Key Messages

#### Stripe Logs To Check:
```
[Stripe] Invoice #1: id=..., status=..., subscription type=..., extracted subId=...
[Stripe] Invoice #2: id=..., status=..., subscription type=..., extracted subId=...
[Stripe] Processed X invoices, created Y revenue events
```

**What To Look For**:
- ❌ BAD: `extracted subId=NULL` for all invoices
- ✅ GOOD: `extracted subId=sub_xxx` for most invoices
- ❌ BAD: `created 0 revenue events`
- ✅ GOOD: `created 100+ revenue events`

#### App Store Logs To Check:
```
[App Store 2024-XX-XX] Calculated from prev day: Cancellations=X, Churn=Y, First Payments=Z, Renewals=W
```

**What To Look For**:
- ✅ GOOD: Non-zero values for days 2-365 (day 1 will be 0)
- ❌ BAD: All zeros

#### Unified Snapshot Logs:
```
Created 365 unified historical snapshots
```

**What To Look For**:
- ✅ GOOD: Number close to 365 (or number of days with data)
- ❌ BAD: 0 or very low number

---

### Step 3: Verify Metrics After Sync

#### Check TODAY's Data (2025-10-24)

**Stripe Should Show**:
- ✅ Active Subscribers: 459
- ✅ Trial Subscribers: 0
- ✅ Paid Subscribers: 459
- ✅ Cancellations: 32
- ✅ Churn: 6
- ✅ Grace Events: (some number)
- ⏳ First Payments: > 0 (depends on invoice fix)
- ⏳ Renewals: > 0 (depends on invoice fix)
- ✅ MRR: $32,631.42 (rounded to 2 decimals)
- ⏳ Monthly Revenue Gross: > 0 (depends on invoice fix)
- ⏳ Monthly Revenue Net: > 0 (depends on invoice fix)

**App Store Should Show**:
- ✅ Active Subscribers: 5914
- ✅ Trial Subscribers: ~400
- ✅ Paid Subscribers: ~5514
- ✅ Cancellations: > 0 (calculated)
- ✅ Churn: > 0 (calculated)
- ✅ Grace Events: (from TSV)
- ✅ First Payments: > 0 (calculated)
- ✅ Renewals: > 0 (estimated)
- ✅ MRR: ~$7646
- ✅ Monthly Revenue Gross: ~$11,103
- ✅ Monthly Revenue Net: ~$7646

**Unified (Total) Should Show**:
- ✅ Active Subscribers: **6373** (459 + 5914)
- ✅ All other metrics: Sum of both platforms

#### Check Historical Dates (e.g., 2025-10-19)

**Unified Total Should Show**:
- ✅ Active Subscribers: **6373** (not 459!)
- ✅ App Store: 5914 (not 0!)
- ✅ Stripe: 459

---

## If Issues Persist

### If Stripe Revenue Events Still 0:
1. Copy the first 3-5 invoice debug logs
2. Share them - they'll show exactly what's wrong with extraction
3. Possible causes:
   - All invoices have `subscription: null`
   - All invoices are `status: draft` (not paid)
   - Date filter excluding all invoices

### If App Store Flow Metrics Still 0:
1. Check if previous day snapshot exists
2. Look for log: `No previous snapshot found`
3. First day will always be 0 (no comparison baseline)

### If Unified Total Still Wrong:
1. Check log: `Created X unified historical snapshots`
2. If X = 0, check if platform snapshots exist for historical dates
3. Query database to verify Stripe + App Store snapshots exist

---

## Expected Completion Time
- Full sync: ~5-10 minutes
- Progress updates every 50 days during historical sync
- Final unified snapshot generation: ~30 seconds

---

## Success Criteria ✅

All 11 metrics working for both platforms:
1. ✅ Active Subscribers
2. ✅ Trial Subscribers
3. ✅ Paid Subscribers
4. ✅ Cancellations
5. ✅ Churn
6. ✅ Grace Events
7. ⏳ First Payments (Stripe pending, App Store fixed)
8. ⏳ Renewals (Stripe pending, App Store fixed)
9. ✅ MRR
10. ⏳ Monthly Revenue (Gross) (Stripe pending, App Store fixed)
11. ⏳ Monthly Revenue (Net) (Stripe pending, App Store fixed)

**Remaining Issue**: Stripe revenue events extraction





















