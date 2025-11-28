# Google Play Developer API Integration

## Overview

We've implemented **two complementary methods** for collecting Google Play subscription data:

### 1. ✅ **GCS Reports (Currently Active)**
- **Source**: Auto-managed GCS bucket (`gs://pubsite_prod_rev_XXX`)
- **Data**: Aggregated subscription metrics from CSV reports
- **What you get**: Active subscribers, new subscriptions, cancellations (per date)
- **What you DON'T get**: Trial/paid breakdown, monthly/yearly split, renewals, MRR, revenue, grace periods, payment failures
- **Sync frequency**: Daily (processes historical reports)
- **No app changes required** ✅

### 2. 🆕 **Google Play Developer API (NEW - Available but Not Yet Connected)**
- **Source**: `purchases.subscriptionsv2.get` API endpoint
- **Data**: Real-time, user-level subscription details
- **What you get**: 
  - ✅ Trial vs Paid status
  - ✅ Base plan & offer details
  - ✅ Payment state (success, failure, grace period, account hold, pause)
  - ✅ Auto-renewal status (on/off)
  - ✅ Price & currency per subscription
  - ✅ Exact expiry times
  - ✅ Country/region
  - ✅ Intro offers & promotional pricing
- **Sync frequency**: Hourly or on-demand (configurable)
- **Requirement**: Need a list of purchase tokens to poll

---

## Current Limitations (GCS Reports Only)

From your current GCS sync logs:
```
Sample data: {"active":1059,"canceledSubscriptions":17,"monthly":0,"newSubscriptions":28,"paid":0,"renewals":0,"trial":0,"yearly":0}
```

The GCS reports provide:
- ✅ `active`, `newSubscriptions`, `canceledSubscriptions`
- ❌ `trial`, `paid`, `monthly`, `yearly`, `renewals` are **all 0** (not available in CSV)

**This is a Google Play limitation** - their CSV exports don't include these breakdowns.

---

## How to Enable the Developer API Integration

### Step 1: Service Account Permissions

Your existing service account already has the right credentials, but you need to ensure it has API access permissions:

1. Go to [Google Play Console → Users & Permissions](https://play.google.com/console/users-and-permissions)
2. Find your service account (the one you're already using for GCS)
3. Make sure it has these permissions:
   - ✅ "View financial data, orders, and cancellation survey responses"
   - ✅ "Manage orders and subscriptions"

### Step 2: The Token Problem

The API requires **purchase tokens** to query subscription details. There are 3 ways to get tokens:

#### Option A: **Collect tokens when users subscribe (RECOMMENDED)**
- Modify your Android app to send purchase tokens to your backend when purchases occur
- Store tokens in a database (e.g., Convex `purchaseTokens` table)
- Periodically poll all tokens using the API

**Example app code (Kotlin):**
```kotlin
// When a purchase is made
val purchase = billingResult.purchases.first()
val token = purchase.purchaseToken
// Send to your backend
api.storePurchaseToken(userId, token, productId)
```

#### Option B: **Use Real-Time Developer Notifications (RTDN)**
- You explicitly said NO to this earlier, so skipping

#### Option C: **Infer tokens from GCS reports + trial polling (PARTIAL SOLUTION)**
- Some GCS reports may contain obfuscated purchase tokens or order IDs
- This is unreliable and not recommended

### Step 3: Sync Logic (Once You Have Tokens)

Once you have purchase tokens, you can call the API:

**Manual test (example):**
```typescript
import { batchFetchSubscriptionDetailsAction } from "./convex/integrations/googlePlayAPI";

// In your sync logic:
const result = await ctx.runAction(batchFetchSubscriptionDetailsAction, {
  serviceAccountJson: credentials.serviceAccountJson,
  packageName: credentials.packageName,
  purchaseTokens: ["token1", "token2", "token3"], // From your database
});

// result.success contains detailed subscription data
// result.failed contains tokens that failed (expired, invalid, etc.)
```

**What you'll get back:**
```typescript
{
  purchaseToken: "abc123...",
  productId: "mia_basic_subscription",
  basePlanId: "monthly",
  offerId: "intro-trial-7day",
  state: "ACTIVE",
  startTime: "2024-11-01T10:00:00Z",
  expiryTime: "2025-12-01T10:00:00Z",
  autoRenewEnabled: true,
  priceCurrencyCode: "USD",
  priceAmountMicros: "4990000", // $4.99
  country: "NO",
  isTrial: false,
  isIntroductoryPricePeriod: false,
  acknowledgementState: "ACKNOWLEDGED"
}
```

---

## Recommended Approach

Given your constraints (no app modification, no RTDN), here's what I recommend:

### **Short-term (Current State)**
- ✅ Continue using GCS reports for: Active Subscribers, New Subscriptions, Cancellations
- ✅ Display these metrics on your dashboard
- ❌ Accept that Trial/Paid, Monthly/Yearly, Renewals, Grace Periods, MRR are **not available** from GCS alone

### **Long-term (If You Want Full Metrics)**
You **must** choose one of these paths:

1. **Modify your Android app** to collect purchase tokens (minimal code change, ~10 lines)
2. **Enable RTDN** (Google Play's real-time webhooks - you said no to this)
3. **Accept limited metrics** and rely only on GCS reports

**If you choose Option 1** (app modification), the integration code is already ready - it's in `/convex/integrations/googlePlayAPI.ts` and just needs tokens to work.

---

## Code Files

- **`/convex/integrations/googlePlay.ts`** - GCS CSV parsing (currently active)
- **`/convex/integrations/googlePlayAPI.ts`** - Developer API integration (ready but needs tokens)

---

## Summary

| Metric | GCS Reports | Developer API |
|--------|-------------|---------------|
| Active Subscribers | ✅ | ✅ |
| New Subscriptions | ✅ | ✅ |
| Cancellations | ✅ | ✅ |
| Trial vs Paid | ❌ | ✅ |
| Monthly vs Yearly | ❌ | ✅ |
| Renewals | ❌ | ✅ |
| Grace Periods | ❌ | ✅ |
| Payment Failures | ❌ | ✅ |
| MRR | ❌ | ✅ |
| Auto-Renewal Status | ❌ | ✅ |
| Price per User | ❌ | ✅ |

**Bottom line**: GCS reports are great for high-level metrics, but if you need detailed subscription analytics (trial conversion, churn breakdown, MRR), you need the Developer API + purchase tokens.








