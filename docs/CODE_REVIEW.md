# Code Review - Milytics

**Date:** 2026-01-21
**Reviewer:** Claude Code (Opus 4.5)
**Status:** Comprehensive Review Complete

---

## Executive Summary

Milytics is a well-structured subscription analytics platform that aggregates metrics from App Store, Google Play, and Stripe. The codebase demonstrates good practices in several areas while having some opportunities for improvement.

**Strengths:**
- Clean architecture with clear separation of concerns
- Proper use of Convex serverless functions
- Good authorization model with app ownership validation
- Chunked sync to handle Convex timeout limits
- TypeScript throughout with reasonable type safety

**Areas for Improvement:**
- Credential storage (currently stored as JSON strings, not encrypted)
- Some large files that could be further modularized
- Missing test coverage
- Some TypeScript `any` types still present

---

## 1. Architecture Overview

### 1.1 Tech Stack
| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Convex (serverless functions + database) |
| Auth | BetterAuth with Convex adapter |
| UI | Radix primitives (shadcn/ui), Recharts |
| AI | Google Gemini via Vercel AI SDK |

### 1.2 Data Flow
```
User → Frontend (Next.js) → Convex Queries/Mutations/Actions
                         ↓
              Platform APIs (Stripe, App Store, Google Play)
                         ↓
              Convex Database (subscriptions, revenueEvents, metricsSnapshots)
                         ↓
              Dashboard Queries → Aggregated Metrics
```

### 1.3 Directory Structure
```
milytics/
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes (auth, chat)
│   ├── apps/[slug]/       # Per-app pages (dashboard, settings)
│   └── sign-in, sign-up/  # Auth pages
├── convex/                 # Convex backend
│   ├── schema.ts          # Database schema
│   ├── sync.ts            # Main sync orchestration
│   ├── metrics.ts         # Metrics calculation
│   ├── queries.ts         # Public queries
│   ├── mutations.ts       # Public mutations
│   ├── lib/               # Utilities (constants, dateUtils, errors, etc.)
│   └── integrations/      # Platform integrations
├── lib/                    # Frontend utilities
└── components/             # UI components
```

---

## 2. Security Analysis

### 2.1 Authentication ✅

**Implementation:** `convex/auth.ts`, `lib/auth-server.ts`

The application uses BetterAuth with the Convex adapter, providing:
- Magic link authentication
- Email/password authentication (email verification disabled)
- Session management via BetterAuth tables

**Status:** Properly implemented. The `getAuthUserId()` helper correctly maps BetterAuth users to the app's `users` table.

**Note:** Line 119 in `convex/auth.ts` - Magic link email sending logs to console instead of actually sending:
```typescript
sendMagicLink: async ({ email, url }) => {
  // TODO: Implement email sending via service like Resend
  console.log(`Magic link for ${email}: ${url}`);
}
```

### 2.2 Authorization ✅

**Implementation:** `convex/lib/authHelpers.ts`

Proper authorization model with three helpers:
- `getUserId(ctx)` - Returns user ID or null
- `requireUserId(ctx)` - Throws if not authenticated
- `validateAppOwnership(ctx, appId)` - Validates user owns the app

All mutations and queries properly validate ownership before operations.

### 2.3 Credential Storage ⚠️

**Implementation:** `convex/schema.ts:33`

Platform credentials are stored as JSON strings in the `platformConnections` table:
```typescript
credentials: v.string(), // Encrypted JSON string (comment says encrypted, but not actually)
```

**Issue:** Despite the comment saying "Encrypted JSON string", credentials are stored in plain text. This includes:
- Stripe API keys
- App Store private keys
- Google Play service account JSON

**Recommendation:** Implement encryption using Convex environment variables for the encryption key. See `docs/CREDENTIAL_ENCRYPTION.md` for the architecture plan.

### 2.4 API Security ✅

**Chat API:** `app/api/chat/route.ts:46-52`
```typescript
const token = await getAuthToken();
if (!token) {
  return new Response('Unauthorized', { status: 401 });
}
```

Input validation includes:
- Request size limit (5MB)
- Message count limit (50)
- Question length limit (2000 chars)

**App Store Notifications:** `convex/http.ts:25-68`

Properly verifies App Store Server Notifications using Apple's SignedDataVerifier.

### 2.5 CORS and Origins ✅

**Implementation:** `convex/auth.ts:84-101`

Dynamic trusted origins support:
- Production site URL
- localhost:3000 for development
- Vercel preview deployments (*.vercel.app)

---

## 3. Code Quality Analysis

### 3.1 TypeScript Usage

**Good:**
- Strict TypeScript configuration
- Most types properly defined in `convex/schema.ts`
- Good use of Convex validators for runtime type checking

**Areas for Improvement:**
- Some `any` types still present in `convex/queries.ts` and frontend components
- Example at `convex/queries.ts:110`: `[key: string]: any;`

### 3.2 Error Handling ✅

**Implementation:** `convex/lib/errors.ts`

Centralized error handling with:
- `IntegrationError`, `ApiError`, `CredentialError`, `ParseError` classes
- `logError()` for consistent logging
- `safeFetch()` with timeout support
- `withRetry()` for exponential backoff

**JSON Parsing:** `convex/lib/safeJson.ts`

Safe JSON parsing utilities prevent silent failures:
```typescript
export function parseCredentials<T>(json: string, platform: string): T
export function tryJsonParse<T>(json: string): T | null
```

### 3.3 Constants and Magic Numbers ✅

**Implementation:** `convex/lib/constants.ts`

Properly centralized:
```typescript
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const SYNC_CHUNK_SIZE_DAYS = 30;
export const HISTORICAL_SYNC_DAYS = 365;
export const DB_BATCH_SIZE = 100;
export const STRIPE_API_LIMIT = 100;
```

### 3.4 Date Handling ✅

**Implementation:** `convex/lib/dateUtils.ts`

Consistent UTC-based date handling:
```typescript
export function formatDateUTC(date: Date): string
export function parseDateString(dateStr: string): Date | null
export function getWeekStart(date: Date, weekStartDay: "monday" | "sunday"): Date
```

### 3.5 Large File Analysis

| File | Lines | Concern |
|------|-------|---------|
| `convex/queries.ts` | ~2,868 | Large but logically organized |
| `convex/metrics.ts` | ~2,358 | Complex metrics calculations |
| `convex/sync.ts` | ~1,401 | Main sync orchestration |
| `convex/integrations/googlePlay.ts` | ~1,022 | Partially refactored to modules |

Google Play integration has been partially modularized into:
- `convex/integrations/googlePlay/types.ts`
- `convex/integrations/googlePlay/utils.ts`

---

## 4. Performance Analysis

### 4.1 Sync Performance ✅

**Chunked Sync:** `convex/sync.ts:914-1319`

App Store historical sync uses 30-day chunks to avoid Convex's 10-minute timeout:
```typescript
const CHUNK_SIZE = SYNC_CHUNK_SIZE_DAYS; // 30 days
const TOTAL_HISTORICAL_DAYS = HISTORICAL_SYNC_DAYS; // 365 days
```

**Batch Processing:** Revenue events stored in batches of 100 to avoid 16MB read limits.

### 4.2 Query Performance ✅

**Indexes:** `convex/schema.ts`

Proper indexes defined:
- `users.by_email`
- `apps.by_user`, `apps.by_user_slug`
- `platformConnections.by_app`
- `metricsSnapshots.by_app_date`, `by_app_platform`
- `subscriptions.by_app`, `by_app_platform`, `by_external_id`
- `revenueEvents.by_app`, `by_app_platform`, `by_app_platform_time`, `by_external_id`

### 4.3 Potential Performance Issues

**4.3.1 Unbounded Collect in deleteApp**

`convex/apps.ts:110-130` - Deletes all related data without pagination:
```typescript
const connections = await ctx.db.query("platformConnections")...collect();
const snapshots = await ctx.db.query("metricsSnapshots")...collect();
// etc.
```

**Risk:** For apps with extensive history, this could approach Convex limits.
**Mitigation:** Document recommends chunked deletion for large apps.

**4.3.2 Weekly History Building**

`convex/queries.ts:121-500` - `buildWeeklyHistoryFromSnapshots` processes all snapshots in memory.

**Status:** Acceptable for current data volumes. Consider pagination if historical data grows significantly.

---

## 5. Platform Integration Analysis

### 5.1 Stripe Integration ✅

**File:** `convex/integrations/stripe.ts` (434 lines)

**Features:**
- Fetches subscriptions with expanded price data
- Fetches invoices with payment intents for proceeds calculation
- Handles refunds separately
- Extracts subscription item pricing

**Revenue Tracking:**
- `amount` - Charged amount (including VAT)
- `amountExcludingTax` - From Stripe Tax
- `amountProceeds` - Net after Stripe fees (from balance_transaction)

### 5.2 App Store Integration ✅

**File:** `convex/integrations/appStore.ts` (319 lines)

**Features:**
- Downloads SUBSCRIPTION SUMMARY reports (snapshot data)
- Downloads SUBSCRIBER reports (transaction events)
- Downloads SUBSCRIPTION_EVENT reports (cancellations, conversions)
- JWT generation for App Store Connect API
- PEM key normalization

**Report Types:**
- Frequency: DAILY
- Versions: 1_4 for SUMMARY, 1_3 for SUBSCRIBER/EVENT

### 5.3 Google Play Integration ✅

**File:** `convex/integrations/googlePlay.ts` (1,022 lines)

**Features:**
- Reads financial reports from GCS bucket
- Handles both CSV and ZIP files
- Supports earnings/ and sales/ folders
- Currency conversion using database exchange rates
- CSV encoding detection (UTF-8, UTF-16LE)

**Revenue Fields:**
- `gross` - Charged amount (including VAT)
- `net` - Item price (excluding VAT)
- `proceeds` - Developer proceeds (after fees)

---

## 6. Frontend Analysis

### 6.1 Pages Structure ✅

Clean App Router structure:
- `/` - Landing page
- `/sign-in`, `/sign-up` - Authentication
- `/apps` - App list
- `/apps/[slug]/dashboard` - Main dashboard
- `/apps/[slug]/settings` - Settings and connections

### 6.2 State Management ✅

- Convex real-time queries for data
- TanStack Query for AI chat state
- React useState for local UI state

### 6.3 UI Components ✅

Properly structured shadcn/ui components in `components/ui/`:
- 20+ Radix-based primitives
- Consistent styling with Tailwind CSS 4

### 6.4 Settings Page Analysis

**File:** `app/apps/[slug]/settings/page.tsx` (841 lines)

**Features:**
- Platform connection management
- Currency selection
- Week start day preference
- Revenue display format
- Chart style preference
- GCS bucket debugging for Google Play

**Note:** Credentials are displayed when editing connections. The form shows existing credentials to users for easy editing, which could be a security concern if someone gains access to the session.

---

## 7. Database Schema Analysis

### 7.1 Tables Overview

| Table | Purpose | Indexes |
|-------|---------|---------|
| `users` | User profiles | `by_email` |
| `apps` | Multi-app support | `by_user`, `by_user_slug` |
| `platformConnections` | Platform credentials | `by_app` |
| `metricsSnapshots` | Daily metric snapshots | `by_app_date`, `by_app_platform` |
| `subscriptions` | Raw subscription data | Multiple |
| `revenueEvents` | Transaction events | Multiple including `by_external_id` |
| `syncLogs` | Sync progress | `by_app_time` |
| `syncStatus` | Active sync tracking | `by_app_status` |
| `syncProgress` | Chunked sync state | `by_app_platform`, `by_status` |
| `exchangeRates` | Currency rates | `by_pair`, `by_pair_month` |
| `appStoreNotifications` | Server notifications | `by_app_time` |
| `appStoreReports` | Raw report content | `by_app_date` |

### 7.2 Metrics Snapshot Fields

```typescript
metricsSnapshots: {
  appId, date, platform,
  // Subscriber counts
  activeSubscribers, trialSubscribers, paidSubscribers,
  monthlySubscribers, yearlySubscribers,
  // Flow metrics
  cancellations, churn, paybacks,
  firstPayments, renewals, refunds,
  // Revenue
  mrr, monthlyChargedRevenue, monthlyRevenue, monthlyProceeds,
  weeklyChargedRevenue, weeklyRevenue, weeklyProceeds,
  // Plan breakdown
  monthlyPlanChargedRevenue, yearlyPlanChargedRevenue,
  monthlyPlanRevenue, yearlyPlanRevenue,
  monthlyPlanProceeds, yearlyPlanProceeds,
}
```

---

## 8. Issues Summary

### 8.1 Critical (Previously Fixed)

| Issue | File | Status |
|-------|------|--------|
| Missing auth in deleteMetricsSnapshot | mutations.ts | ✅ Fixed |
| No auth on chat API | chat/route.ts | ✅ Fixed |
| JSON.parse without error handling | Multiple | ✅ Fixed |

### 8.2 High Priority

| Issue | File | Status |
|-------|------|--------|
| Credentials stored in plain text | schema.ts | ⚠️ Documented, needs encryption |
| Magic link not sending emails | auth.ts:119 | ⚠️ Needs implementation |

### 8.3 Medium Priority

| Issue | File | Status |
|-------|------|--------|
| Some `any` types remain | queries.ts, components | ⚠️ Low risk |
| Large file sizes | queries.ts, metrics.ts | ⚠️ Functional but could be modularized |

### 8.4 Low Priority

| Issue | Status |
|-------|--------|
| No test files | Should add unit tests |
| Missing JSDoc on some functions | Would improve maintainability |

---

## 9. Recommendations

### 9.1 Short-term (High Priority)

1. **Implement Credential Encryption**
   - Use Convex environment variables for encryption key
   - Encrypt credentials before storage
   - Decrypt on retrieval

2. **Implement Magic Link Emails**
   - Integrate with Resend or similar email service
   - Replace console.log with actual email sending

3. **Add Rate Limiting**
   - Consider adding rate limiting to the chat API
   - Protect against abuse of AI resources

### 9.2 Medium-term

1. **Add Unit Tests**
   - Test metrics calculations
   - Test date utilities
   - Test JSON parsing utilities

2. **Reduce TypeScript `any` Usage**
   - Define proper types for query results
   - Type component props more strictly

3. **Improve Error Boundaries**
   - Add React error boundaries for better UX
   - Implement graceful degradation

### 9.3 Long-term

1. **Modularize Large Files**
   - Split queries.ts by domain (subscribers, revenue, history)
   - Complete Google Play module refactoring

2. **Add Monitoring**
   - Track sync failures
   - Monitor API errors
   - Alert on unusual patterns

3. **Documentation**
   - Add JSDoc to public functions
   - Create API documentation
   - Document metrics calculations

---

## 10. Files Summary

### 10.1 Created Utility Files
- `convex/lib/authHelpers.ts` - Auth helpers
- `convex/lib/constants.ts` - Centralized constants
- `convex/lib/dateUtils.ts` - Date utilities
- `convex/lib/errors.ts` - Error handling
- `convex/lib/exchangeRates.ts` - Currency conversion
- `convex/lib/logger.ts` - Logging utilities
- `convex/lib/safeJson.ts` - Safe JSON parsing
- `convex/lib/vatRates.ts` - VAT calculations

### 10.2 Integration Files
- `convex/integrations/stripe.ts` - Stripe API
- `convex/integrations/appStore.ts` - App Store Connect
- `convex/integrations/googlePlay.ts` - Google Play GCS
- `convex/integrations/googlePlayAPI.ts` - GCS utilities
- `convex/integrations/googlePlay/types.ts` - GP types
- `convex/integrations/googlePlay/utils.ts` - GP utilities

### 10.3 Core Backend Files
- `convex/schema.ts` - Database schema
- `convex/sync.ts` - Sync orchestration
- `convex/metrics.ts` - Metrics calculation
- `convex/queries.ts` - Public queries
- `convex/mutations.ts` - Public mutations
- `convex/apps.ts` - App CRUD
- `convex/auth.ts` - BetterAuth config
- `convex/http.ts` - HTTP handlers
- `convex/crons.ts` - Scheduled jobs

---

## Conclusion

Milytics demonstrates solid software engineering practices with proper separation of concerns, authorization checks, and error handling. The main areas requiring attention are:

1. **Credential encryption** - Critical for production security
2. **Magic link implementation** - Required for full auth functionality
3. **Test coverage** - Currently none, should be added

The codebase is well-organized and follows consistent patterns, making it maintainable and extensible. The chunked sync approach shows good understanding of Convex limitations and how to work around them effectively.
