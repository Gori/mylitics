"use client";

export function MetricsDefinitions() {
  const SRC = {
    stripe: {
      stock: "Stripe API: subscriptions.list",
      mrr: "Stripe API: subscriptions.list price.unit_amount & price.recurring.interval",
      monthlyYearly: "Stripe API: subscriptions.list price.recurring.interval",
      cancellations: "Stripe API: subscriptions.list cancel_at_period_end flag",
      grace: "Stripe API: subscriptions.status = 'past_due'",
      firstPayments: "Stripe API: invoices.list (paid, billing_reason='subscription_create')",
      renewals: "Stripe API: invoices.list (paid, excluding billing_reason='subscription_create')",
      revenue: "Stripe API: invoices.list (paid) + refunds.list",
    },
    appstore: {
      stock: "SUBSCRIPTION_SUMMARY report (DAILY v1_4): Active/Trial/Paid counts",
      cancellations: "Day-over-day delta from SUBSCRIPTION_SUMMARY Paid Subscribers",
      grace: "SUBSCRIPTION_SUMMARY: Grace Period + Billing Retry columns",
      firstPayments: "SUBSCRIBER report (DETAILED v1_3) event data OR day-over-day Paid gains",
      renewals: "SUBSCRIBER report (DETAILED v1_3): Proceeds Reason column (Renew/Rate After One Year)",
      revenue: "SUBSCRIPTION_SUMMARY: Customer Price (gross) and Developer Proceeds (net)",
      mrr: "Estimated from active subscribers × (monthlyRevenueNet / activeSubscribers)",
      monthlyYearly: "SUBSCRIPTION_SUMMARY: Product ID patterns (month/year/annual) + Subscription Duration column",
    },
    googleplay: {
      all: "Not implemented yet; planned via Android Publisher purchases (subscriptionsV2) and RTDN",
    },
  } as const;

  const definitions = [
    {
      name: "Active Subscribers",
      type: "Stock Metric",
      total: "Current count of all active and trialing subscriptions. Uses the latest snapshot from each platform.",
      chart: "Weekly snapshot showing the total number of active subscribers at the end of each week.",
      sources: {
        stripe: SRC.stripe.stock,
        appstore: SRC.appstore.stock,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Trial Subscribers",
      type: "Stock Metric",
      total: "Current count of subscriptions in trial period. Uses the latest snapshot from each platform.",
      chart: "Weekly snapshot showing the number of trial subscribers at the end of each week.",
      sources: {
        stripe: SRC.stripe.stock,
        appstore: SRC.appstore.stock,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Paid Subscribers",
      type: "Stock Metric",
      total: "Current count of active paying subscriptions (Active minus Trial). Uses the latest snapshot from each platform.",
      chart: "Weekly snapshot showing the number of paid subscribers at the end of each week.",
      sources: {
        stripe: SRC.stripe.stock,
        appstore: SRC.appstore.stock,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Monthly Subs",
      type: "Stock Metric",
      total: "Current count of paid subscribers with monthly billing. Derived from product ID patterns in Sales Reports.",
      chart: "Weekly snapshot showing the number of monthly subscribers at the end of each week.",
      sources: {
        stripe: SRC.stripe.monthlyYearly,
        appstore: SRC.appstore.monthlyYearly,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Yearly Subs",
      type: "Stock Metric",
      total: "Current count of paid subscribers with yearly billing. Derived from product ID patterns in Sales Reports.",
      chart: "Weekly snapshot showing the number of yearly subscribers at the end of each week.",
      sources: {
        stripe: SRC.stripe.monthlyYearly,
        appstore: SRC.appstore.monthlyYearly,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Cancellations",
      type: "Flow Metric",
      total: "Sum of all subscription cancellations over the past 30 days. This is the large number in the card.",
      chart: "Each week shows the total cancellations for THAT specific 7-day period only. Each bar represents one week's cancellations.",
      sources: {
        stripe: SRC.stripe.cancellations,
        appstore: SRC.appstore.cancellations,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Grace Events",
      type: "Flow Metric",
      total: "Sum of all subscriptions in grace period or billing retry over the past 30 days. This is the large number in the card.",
      chart: "Each week shows the total grace events for THAT specific 7-day period only. Each bar represents one week's grace events.",
      sources: {
        stripe: SRC.stripe.grace,
        appstore: SRC.appstore.grace,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "First Payments",
      type: "Flow Metric",
      total: "Sum of all first payment events over the past 30 days. For App Store: from SUBSCRIBER report event data or day-over-day paid subscriber gains. For Stripe: from paid invoices with billing_reason='subscription_create'. This is the large number in the card.",
      chart: "Each week shows the total first payments for THAT specific 7-day period only. Each bar represents one week's first payments.",
      sources: {
        stripe: SRC.stripe.firstPayments,
        appstore: SRC.appstore.firstPayments,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Renewals",
      type: "Flow Metric",
      total: "Sum of all renewal payment events over the past 30 days. For App Store: extracted from SUBSCRIBER report Proceeds Reason column. For Stripe: from paid invoices. This is the large number in the card.",
      chart: "Each week shows the total renewals for THAT specific 7-day period only. Each bar represents one week's renewals.",
      sources: {
        stripe: SRC.stripe.renewals,
        appstore: SRC.appstore.renewals,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "MRR (Monthly Recurring Revenue)",
      type: "Stock Metric",
      total: "Current monthly recurring revenue calculated from active subscription prices (annual subscriptions ÷ 12). Uses latest snapshot.",
      chart: "Weekly snapshot showing MRR at the end of each week.",
      sources: {
        stripe: SRC.stripe.mrr,
        appstore: SRC.appstore.mrr,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Monthly Revenue (Gross)",
      type: "Flow Metric",
      total: "Sum of all gross revenue collected over the past 30 days before platform fees. This is the large number in the card.",
      chart: "Each week shows the total gross revenue for THAT specific 7-day period only. Each bar represents one week's gross revenue.",
      sources: {
        stripe: SRC.stripe.revenue,
        appstore: SRC.appstore.revenue,
        googleplay: SRC.googleplay.all,
      },
    },
    {
      name: "Monthly Revenue (Net)",
      type: "Flow Metric",
      total: "Sum of all net revenue collected over the past 30 days after estimated platform fees (85% of gross). This is the large number in the card.",
      chart: "Each week shows the total net revenue for THAT specific 7-day period only. Each bar represents one week's net revenue.",
      sources: {
        stripe: SRC.stripe.revenue,
        appstore: SRC.appstore.revenue,
        googleplay: SRC.googleplay.all,
      },
    },
  ];

  return (
    <div className="mt-8 p-6 bg-gray-50 rounded-lg border border-gray-200">
      <h3 className="text-lg font-semibold mb-4">Metrics Definitions</h3>
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm">
        <p className="font-medium mb-1">Understanding Metric Types:</p>
        <ul className="space-y-1 ml-4 list-disc">
          <li><strong>Stock Metrics:</strong> Point-in-time measurements (e.g., current subscriber count). Shows latest value.</li>
          <li><strong>Flow Metrics:</strong> Accumulated over time (e.g., total cancellations). Shows sum over 30 days.</li>
        </ul>
        <p className="mt-2 text-xs text-gray-600">
          Note: Charts only display weeks with complete data from all active platforms. Incomplete weeks are filtered out to ensure accuracy.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {definitions.map((def) => (
          <div key={def.name} className="bg-white p-4 rounded border border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-sm">{def.name}</h4>
              <span className="text-xs px-2 py-1 bg-gray-100 rounded">{def.type}</span>
            </div>
            <div className="space-y-1 text-sm text-gray-700">
              <div>
                <span className="font-medium">Total Value:</span> {def.total}
              </div>
              <div>
                <span className="font-medium">Chart:</span> {def.chart}
              </div>
              <div>
                <span className="font-medium">Data sources (by channel):</span>
                <ul className="mt-1 ml-4 list-disc">
                  <li><span className="font-medium">Stripe:</span> {(def as any).sources.stripe}</li>
                  <li><span className="font-medium">App Store:</span> {(def as any).sources.appstore}</li>
                  <li><span className="font-medium">Google Play:</span> {(def as any).sources.googleplay}</li>
                </ul>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
