"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function HistoryPage() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();
  const history = useQuery(api.queries.getMetricsHistory, { days: 30 });

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace("/sign-in");
    }
  }, [isLoaded, isSignedIn, router]);

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div>Loading...</div>
      </div>
    );
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  };

  return (
    <div className="min-h-screen bg-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <button
          onClick={() => router.push("/dashboard")}
          className="mb-8 text-sm text-gray-600"
        >
          ← Back
        </button>

        {!history || history.length === 0 ? (
          <div className="text-center py-12 text-gray-600">No history yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-sm font-semibold">Date</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Active</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Trials</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Paid</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Churn</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">MRR</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {history.map((snapshot) => (
                  <tr key={snapshot._id} className="border-b border-gray-100">
                    <td className="px-4 py-3 text-sm">{snapshot.date}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      {snapshot.activeSubscribers}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {snapshot.trialSubscribers}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {snapshot.paidSubscribers}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {snapshot.churn}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {formatCurrency(snapshot.mrr)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {formatCurrency(snapshot.monthlyRevenueNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

