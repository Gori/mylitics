"use client";

export function MetricsDefinitions() {
  return (
    <div className="mt-8 p-6 bg-gray-50 rounded-lg border border-gray-200">
      <h3 className="text-lg font-semibold mb-4">Metrics Definitions</h3>
      
      {/* Understanding Metric Types - KEEP THIS */}
      <div className="mb-6 p-3 bg-blue-50 border border-blue-200 rounded text-sm">
        <p className="font-medium mb-1">Understanding Metric Types:</p>
        <ul className="space-y-1 ml-4 list-disc">
          <li><strong>Stock Metrics:</strong> Point-in-time measurements (e.g., current subscriber count). Shows latest value.</li>
          <li><strong>Flow Metrics:</strong> Accumulated over time (e.g., total cancellations). Shows sum over 30 days.</li>
        </ul>
        <p className="mt-2 text-xs text-gray-600">
          Dashed lines indicate derived or carried-forward values; solid lines indicate actual platform data.
        </p>
      </div>

      {/* SUBSCRIBER METRICS */}
      <div className="mb-6">
        <h4 className="font-semibold text-sm mb-3 text-gray-800">Subscriber Metrics (Stock)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border border-gray-200 font-semibold">Metric</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Definition</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Stripe</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">App Store</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Google Play</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Formula</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Active Subscribers</td>
                <td className="p-2 border border-gray-200">All active and trialing subscriptions</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">subscriptions.list</code> where status is active or trialing</td>
                <td className="p-2 border border-gray-200">SUBSCRIPTION_SUMMARY report (DAILY v1_4), &quot;Active Subscribers&quot; column</td>
                <td className="p-2 border border-gray-200">GCS subscription reports, &quot;active subscriptions&quot; column</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where status = active OR trialing</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Trial Subscribers</td>
                <td className="p-2 border border-gray-200">Subscriptions in trial period</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">subscriptions.list</code> where <code className="bg-gray-100 px-1 rounded text-[10px]">status = trialing</code></td>
                <td className="p-2 border border-gray-200">SUBSCRIPTION_SUMMARY report, &quot;Active Free Trial&quot; column</td>
                <td className="p-2 border border-gray-200">GCS subscription reports, &quot;trial&quot; column (or derived from App Store ratio)</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where isTrial = true</code></td>
              </tr>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Paid Subscribers</td>
                <td className="p-2 border border-gray-200">Active minus trial</td>
                <td className="p-2 border border-gray-200">Derived</td>
                <td className="p-2 border border-gray-200">Derived</td>
                <td className="p-2 border border-gray-200">Derived</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">activeSubscribers - trialSubscribers</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Monthly Subs</td>
                <td className="p-2 border border-gray-200">Paid subscribers on monthly billing</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">price.recurring.interval = month</code></td>
                <td className="p-2 border border-gray-200">Product ID pattern matching (month/monthly/1m/30day)</td>
                <td className="p-2 border border-gray-200">GCS &quot;monthly subscriptions&quot; column (or derived from App Store ratio)</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where priceInterval = month AND not trial</code></td>
              </tr>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Yearly Subs</td>
                <td className="p-2 border border-gray-200">Paid subscribers on yearly billing</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">price.recurring.interval = year</code></td>
                <td className="p-2 border border-gray-200">Product ID pattern matching (year/yearly/annual/12m)</td>
                <td className="p-2 border border-gray-200">GCS &quot;yearly subscriptions&quot; column (or derived from App Store ratio)</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where priceInterval = year AND not trial</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* FLOW METRICS */}
      <div className="mb-6">
        <h4 className="font-semibold text-sm mb-3 text-gray-800">Event Metrics (Flow - summed over period)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border border-gray-200 font-semibold">Metric</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Definition</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Stripe</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">App Store</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Google Play</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Formula</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Cancellations</td>
                <td className="p-2 border border-gray-200">Subscriptions that ended during period</td>
                <td className="p-2 border border-gray-200">Subscriptions where <code className="bg-gray-100 px-1 rounded text-[10px]">status = canceled</code> with endDate in period</td>
                <td className="p-2 border border-gray-200">SUBSCRIPTION_EVENT report &quot;Cancel&quot; events, or day-over-day paid subscriber drops</td>
                <td className="p-2 border border-gray-200">GCS subscription reports, &quot;canceled subscriptions&quot; column</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where status = canceled AND endDate in period</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Churn Rate</td>
                <td className="p-2 border border-gray-200">Percentage of paid subscribers lost</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">(churnCount / startingPaidSubscribers) × 100</code></td>
              </tr>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">First Payments</td>
                <td className="p-2 border border-gray-200">New subscription purchases</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">invoices.list</code> where <code className="bg-gray-100 px-1 rounded text-[10px]">billing_reason = subscription_create</code> and <code className="bg-gray-100 px-1 rounded text-[10px]">status = paid</code></td>
                <td className="p-2 border border-gray-200">SUBSCRIBER report &quot;Start Introductory Price&quot; events, or SUBSCRIPTION_EVENT &quot;Subscribe&quot; events</td>
                <td className="p-2 border border-gray-200">GCS subscription reports, &quot;new subscriptions&quot; column</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where eventType = first_payment</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Renewals</td>
                <td className="p-2 border border-gray-200">Recurring charges after first payment</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">invoices.list</code> paid invoices excluding <code className="bg-gray-100 px-1 rounded text-[10px]">billing_reason = subscription_create</code></td>
                <td className="p-2 border border-gray-200">SUBSCRIBER report rows with positive Customer Price (incl. &quot;Rate After One Year&quot;)</td>
                <td className="p-2 border border-gray-200">Total transactions minus new subscriptions</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where eventType = renewal</code></td>
              </tr>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Refunds</td>
                <td className="p-2 border border-gray-200">Number of refund events issued during period</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">refunds.list</code> API, also negative invoices</td>
                <td className="p-2 border border-gray-200">SUBSCRIBER report &quot;Refund&quot; events</td>
                <td className="p-2 border border-gray-200">Reflected in revenue (negative transactions), not as separate count</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">count where eventType = refund</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">ARPU</td>
                <td className="p-2 border border-gray-200">Revenue per active subscriber</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200">Calculated</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">revenue / activeSubscribers</code></td>
              </tr>
            </tbody>
          </table>
        </div>
            </div>

      {/* REVENUE METRICS */}
      <div className="mb-6">
        <h4 className="font-semibold text-sm mb-3 text-gray-800">Revenue Metrics (Flow - summed over period)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border border-gray-200 font-semibold">Metric</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Definition</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Stripe</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">App Store</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Google Play</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Formula</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Charged Revenue</td>
                <td className="p-2 border border-gray-200">Gross amount including VAT</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">invoice.amount_paid</code></td>
                <td className="p-2 border border-gray-200">SUBSCRIBER report (DETAILED v1_3), &quot;Customer Price&quot; column</td>
                <td className="p-2 border border-gray-200">GCS sales reports, &quot;charged amount&quot; column</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">sum of amount from revenue events</code></td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Revenue (excl. VAT)</td>
                <td className="p-2 border border-gray-200">After VAT, before platform fees</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">invoice.total_excluding_tax</code> or calculated from country VAT rates</td>
                <td className="p-2 border border-gray-200">Calculated: Customer Price / (1 + vatRate) using storefront country</td>
                <td className="p-2 border border-gray-200">GCS sales reports, &quot;item price&quot; column</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">chargedAmount / (1 + vatRate)</code></td>
              </tr>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Proceeds</td>
                <td className="p-2 border border-gray-200">After VAT and platform fees (your actual payout)</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">charge.balance_transaction.net</code></td>
                <td className="p-2 border border-gray-200">SUBSCRIBER report, &quot;Developer Proceeds&quot; column</td>
                <td className="p-2 border border-gray-200">GCS earnings reports, &quot;amount (merchant currency)&quot;</td>
                <td className="p-2 border border-gray-200">Direct from platform data</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">MRR</td>
                <td className="p-2 border border-gray-200">Normalized monthly recurring revenue (Stock)</td>
                <td className="p-2 border border-gray-200">Active subscription prices from <code className="bg-gray-100 px-1 rounded text-[10px]">price.unit_amount</code></td>
                <td className="p-2 border border-gray-200">Active subscribers × Customer Price from SUBSCRIPTION_SUMMARY</td>
                <td className="p-2 border border-gray-200">Derived: subscriber counts × App Store avg prices per subscriber</td>
                <td className="p-2 border border-gray-200"><code className="bg-gray-100 px-1 rounded text-[10px]">monthlyRevenue + (yearlyRevenue / 12)</code></td>
              </tr>
            </tbody>
          </table>
              </div>
              </div>

      {/* REVENUE BY PLAN TYPE */}
      <div className="mb-4">
        <h4 className="font-semibold text-sm mb-3 text-gray-800">Revenue by Plan Type (Flow)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border border-gray-200 font-semibold">Metric</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Definition</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Stripe</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">App Store</th>
                <th className="text-left p-2 border border-gray-200 font-semibold">Google Play</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2 border border-gray-200 font-medium">Monthly Plans - Charged/Revenue/Proceeds</td>
                <td className="p-2 border border-gray-200">Revenue from monthly subscriptions</td>
                <td className="p-2 border border-gray-200">Revenue events where subscription&apos;s <code className="bg-gray-100 px-1 rounded text-[10px]">priceInterval = month</code></td>
                <td className="p-2 border border-gray-200">Revenue events where Product ID matches monthly pattern</td>
                <td className="p-2 border border-gray-200">Derived: total Google Play revenue × (App Store monthly revenue / App Store total revenue)</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="p-2 border border-gray-200 font-medium">Yearly Plans - Charged/Revenue/Proceeds</td>
                <td className="p-2 border border-gray-200">Revenue from yearly subscriptions</td>
                <td className="p-2 border border-gray-200">Revenue events where subscription&apos;s <code className="bg-gray-100 px-1 rounded text-[10px]">priceInterval = year</code></td>
                <td className="p-2 border border-gray-200">Revenue events where Product ID matches yearly pattern</td>
                <td className="p-2 border border-gray-200">Derived: total Google Play revenue × (App Store yearly revenue / App Store total revenue)</td>
              </tr>
            </tbody>
          </table>
              </div>
            </div>

      {/* CURRENCY CONVERSION */}
      <div className="p-3 bg-gray-100 border border-gray-200 rounded text-xs text-gray-700">
        <p className="font-medium mb-1">Currency Conversion:</p>
        <p>All revenue amounts are converted to your app&apos;s preferred currency using exchange rates from the <code className="bg-gray-200 px-1 rounded">exchangeRates</code> table. Historical rates by year-month are used when available, with fallback to latest rates. Google Play amounts in buyer currency are first converted to USD using approximate rates, then to your currency.</p>
      </div>
    </div>
  );
}
