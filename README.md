# Milytics

Subscription analytics platform for App Store, Google Play, and Stripe.

## Setup

```bash
npm install
npx convex dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

Clerk will run in development mode. When prompted, click "Claim this instance" to connect it to your account.

## Usage

1. Sign in/up at `/sign-in` using Clerk
2. Connect your platforms at `/dashboard/connections`
3. Sync data and view metrics at `/dashboard`
4. View historical data at `/dashboard/history`

## Tech Stack

- Next.js
- React
- TypeScript
- Convex (backend + database)
- Clerk (authentication)
- TanStack Query
- Tailwind CSS
