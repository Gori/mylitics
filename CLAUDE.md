# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Milytics is a subscription analytics platform that aggregates metrics from App Store, Google Play, and Stripe. It provides unified dashboards showing subscriber counts, revenue, churn, and historical trends.

## Commands

```bash
# Development
npm run dev              # Start Next.js dev server (http://localhost:3000)
npx convex dev           # Start Convex backend (run in separate terminal)

# Build
npm run build            # Runs prebuild script + Convex codegen + Next.js build

# Lint
npm run lint             # ESLint

# Convex
npx convex dev           # Local development with hot reload
npx convex deploy        # Deploy to production
```

## Architecture

### Tech Stack
- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS 4, TanStack Query
- **Backend**: Convex (serverless functions + database)
- **Auth**: BetterAuth with Convex adapter (magic link + email/password)
- **UI**: Radix primitives, Recharts for charts

### Data Flow
1. User connects platform credentials (stored encrypted in `platformConnections` table)
2. Cron job at midnight UTC or manual trigger syncs data from all platforms
3. Platform integrations fetch raw data (subscriptions, invoices, reports)
4. `metrics.ts` processes data and creates daily snapshots in `metricsSnapshots`
5. Dashboard queries latest/historical snapshots via `queries.ts`

### Directory Structure

```
app/                          # Next.js App Router pages
  api/
    auth/[...all]/route.ts    # BetterAuth handler
    chat/route.ts             # AI chat endpoint
  apps/
    [slug]/                   # Per-app pages (dashboard, settings)
  sign-in/, sign-up/          # Auth pages
  ConvexClientProvider.tsx    # Convex + BetterAuth + TanStack Query wrapper

convex/                       # Convex backend
  schema.ts                   # Database schema (all tables defined here)
  sync.ts                     # Main sync orchestration (syncAllPlatforms action)
  metrics.ts                  # Metrics calculation and snapshot generation
  queries.ts                  # Public queries for frontend
  mutations.ts                # Public mutations
  apps.ts                     # App CRUD operations
  auth.ts                     # BetterAuth config and user helpers
  crons.ts                    # Scheduled jobs (daily sync, exchange rates)
  syncHelpers.ts              # Internal sync utilities
  integrations/
    stripe.ts                 # Stripe API integration
    appStore.ts               # App Store Connect API integration
    googlePlay.ts             # Google Play GCS financial reports

lib/
  auth-client.ts              # BetterAuth client config
  auth-server.ts              # Server-side auth helpers
  env.client.ts               # Client env vars (NEXT_PUBLIC_*)
  env.server.ts               # Server env vars

components/ui/                # Shadcn/ui components
```

### Key Patterns

**Platform Sync Process** (`convex/sync.ts`):
- Platforms sync in order: Stripe → Google Play → App Store
- App Store uses chunked historical sync (30 days per chunk) to avoid Convex 10-min timeout
- After platform syncs, unified snapshots are created combining all platform data

**Metrics Snapshots** (`convex/metricsSnapshots` table):
- Daily snapshots per platform (appstore, googleplay, stripe) + unified
- Contains: activeSubscribers, trialSubscribers, paidSubscribers, cancellations, churn, firstPayments, renewals, mrr, monthlyChargedRevenue (gross), monthlyRevenue (net), monthlyProceeds

**Authentication**:
- BetterAuth manages sessions in its own tables (via Convex component)
- App-specific `users` table synced via triggers in `convex/auth.ts`
- Use `getAuthUserId(ctx)` in queries/mutations to get current user's ID from `users` table

**Multi-App Support**:
- Users can create multiple apps (`apps` table)
- Each app has its own platform connections and metrics
- App slug used in URLs: `/apps/[slug]/dashboard`

### Platform Integration Details

**Stripe**: Fetches subscriptions and invoices directly via API. Calculates MRR from active subscription prices.

**App Store**: Downloads SUBSCRIPTION SUMMARY (snapshot), SUBSCRIBER (events), and SUBSCRIPTION_EVENT (cancellations) reports from App Store Connect. Reports delayed 1-3 days.

**Google Play**: Reads financial reports from GCS bucket (earnings exports). Revenue-only - subscriber counts not available from financial reports.

### Environment Variables

Required in `.env.local`:
```
NEXT_PUBLIC_CONVEX_URL=      # Convex deployment URL
NEXT_PUBLIC_SITE_URL=        # Site URL for auth redirects
SITE_URL=                    # Same as above (server-side)
BETTER_AUTH_SECRET=          # Random secret for BetterAuth
```

Platform credentials are stored per-connection in the database, not in env vars.
