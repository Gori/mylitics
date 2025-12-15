"use client";

import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  ColumnDef,
} from "@tanstack/react-table";
import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatRevenue, type RevenueFormat } from "@/app/dashboard/formatters";

type DebugRow = {
  metricName: string;
  platform: string;
  total: number;
  periods: Record<string, number | null>;
};

type DebugDataTableProps = {
  debugData: any;
  userCurrency?: string;
  periodType: "weekly" | "monthly";
  revenueFormat?: RevenueFormat;
};

export function DebugDataTable({ debugData, userCurrency = "USD", periodType, revenueFormat = "whole" }: DebugDataTableProps) {
  const { rows, periodHeaders } = useMemo(() => {
    if (!debugData || !debugData.latestByPlatform) return { rows: [], periodHeaders: [] };

    const metricLabels: Record<string, string> = {
      activeSubscribers: "Active Subscribers",
      trialSubscribers: "Trial Subscribers",
      paidSubscribers: "Paid Subscribers",
      monthlySubscribers: "Monthly Subs",
      yearlySubscribers: "Yearly Subs",
      cancellations: "Cancellations",
      churn: "Churn (count)",
      churnRate: "Churn Rate (%)",
      firstPayments: "First Payments",
      renewals: "Renewals",
      weeklyChargedRevenue: "Weekly Charged Revenue",
      weeklyRevenue: "Weekly Revenue",
      mrr: "MRR",
      monthlyChargedRevenue: "Charged Revenue",
      monthlyRevenue: "Revenue",
    };

    const metrics = Object.keys(metricLabels);
    const flowMetrics = debugData.flowMetrics || [];
    const rows: DebugRow[] = [];

    // Get appropriate data based on periodType
    const dataByMetric = periodType === "monthly" 
      ? debugData.monthlyDataByMetric 
      : debugData.weeklyDataByMetric;

    if (!dataByMetric) return { rows: [], periodHeaders: [] };

    // Get all unique periods across all metrics
    const allPeriods = new Set<string>();
    for (const metric of metrics) {
      const periodData = dataByMetric[metric] || [];
      periodData.forEach((p: any) => {
        const key = periodType === "monthly" ? p.month : p.week;
        if (key) allPeriods.add(key);
      });
    }
    const sortedPeriods = Array.from(allPeriods).sort();

    for (const metric of metrics) {
      const periodData = dataByMetric[metric] || [];
      const isFlowMetric = flowMetrics.includes(metric);

      // Create period lookup for this metric
      const periodLookup: Record<string, any> = {};
      periodData.forEach((p: any) => {
        const key = periodType === "monthly" ? p.month : p.week;
        if (key) periodLookup[key] = p;
      });

      // Platform rows - calculate these first so we can sum them for unified
      const platforms = ["appstore", "googleplay", "stripe"];
      const platformLabels: Record<string, string> = {
        appstore: "App Store",
        googleplay: "Google Play",
        stripe: "Stripe",
      };

      const platformTotals: Record<string, number> = {};

      // For flow metrics: use 30-day sum; for stock metrics: use latest value
      for (const platform of platforms) {
        const platformTotal = isFlowMetric
          ? debugData.flowSumsByPlatform?.[platform]?.[metric] || 0
          : debugData.latestByPlatform[platform]?.[metric] || 0;
        platformTotals[platform] = platformTotal;
      }

      // Unified row - always calculate as sum of platforms
      const unifiedTotal = 
        platformTotals.appstore + 
        platformTotals.googleplay + 
        platformTotals.stripe;

      const unifiedPeriods: Record<string, number | null> = {};
      sortedPeriods.forEach((period) => {
        const value = periodLookup[period]?.unified;
        unifiedPeriods[period] = value !== undefined ? value : null;
      });

      rows.push({
        metricName: metricLabels[metric],
        platform: "Unified",
        total: unifiedTotal,
        periods: unifiedPeriods,
      });

      // Add platform rows
      for (const platform of platforms) {
        const platformPeriods: Record<string, number | null> = {};
        sortedPeriods.forEach((period) => {
          const value = periodLookup[period]?.[platform];
          platformPeriods[period] = value !== undefined ? value : null;
        });

        rows.push({
          metricName: metricLabels[metric],
          platform: platformLabels[platform],
          total: platformTotals[platform],
          periods: platformPeriods,
        });
      }
    }

    return { rows, periodHeaders: sortedPeriods };
  }, [debugData, periodType]);

  const downloadData = () => {
    if (!rows || rows.length === 0) return;

    // Create CSV content
    const headers = ["Metric", "Platform", "Total", ...periodHeaders];
    const csvRows = [headers.join(",")];

    for (const row of rows) {
      const periodValues = periodHeaders.map((period) => {
        const value = row.periods[period];
        return value === null ? "" : value;
      });
      csvRows.push([
        `"${row.metricName}"`,
        row.platform,
        row.total,
        ...periodValues,
      ].join(","));
    }

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `metrics-debug-${periodType}-${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatValue = (metricName: string, value: number) => {
    const currencyMetrics = ["MRR", "Charged Revenue", "Revenue", "Weekly Charged Revenue", "Weekly Revenue"];
    const percentMetrics = ["Churn Rate (%)"];
    if (percentMetrics.includes(metricName)) {
      return `${value.toFixed(2)}%`;
    }
    if (currencyMetrics.includes(metricName)) {
      return formatRevenue(value, userCurrency, revenueFormat);
    }
    return value.toLocaleString();
  };

  const columns = useMemo<ColumnDef<DebugRow>[]>(() => {
    const baseColumns: ColumnDef<DebugRow>[] = [
      {
        accessorKey: "metricName",
        header: "Metric",
        cell: (info) => (
          <div className="font-medium whitespace-nowrap">{info.getValue() as string}</div>
        ),
      },
      {
        accessorKey: "platform",
        header: "Platform",
        cell: (info) => (
          <div className="whitespace-nowrap">{info.getValue() as string}</div>
        ),
      },
      {
        accessorKey: "total",
        header: () => (
          <div className="whitespace-nowrap">
            Latest / 30d<br />
            <span className="text-xs font-normal text-muted-foreground">(sum for flows)</span>
          </div>
        ),
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="font-semibold whitespace-nowrap">
              {formatValue(row.metricName, info.getValue() as number)}
            </div>
          );
        },
      },
    ];

    const periodColumns: ColumnDef<DebugRow>[] = periodHeaders.map((period) => ({
      id: `period-${period}`,
      header: () => {
        if (periodType === "monthly") {
          // Format YYYY-MM as "Jan 2024"
          const [year, month] = period.split("-");
          const date = new Date(parseInt(year), parseInt(month) - 1, 1);
          return (
            <div className="text-xs whitespace-nowrap">
              {date.toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
            </div>
          );
        }
        // Weekly: format as "Jan 15"
        const date = new Date(period);
        return (
          <div className="text-xs whitespace-nowrap">
            {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        );
      },
      cell: (info) => {
        const row = info.row.original;
        const value = row.periods[period];
        return (
          <div className="text-xs whitespace-nowrap text-gray-400">
            {value === null ? "—" : formatValue(row.metricName, value)}
          </div>
        );
      },
    }));

    return [...baseColumns, ...periodColumns];
  }, [periodHeaders, periodType]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (!debugData) {
    return <div className="text-gray-500">Loading debug data...</div>;
  }

  if (rows.length === 0) {
    return <div className="text-gray-500">No data available</div>;
  }

  return (
    <div className="w-full">
      <div className="mb-4 flex justify-end">
        <Button onClick={downloadData} variant="outline">
          Download CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-20 bg-white">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header, idx) => (
                    <TableHead
                      key={header.id}
                      className={
                        idx === 0
                          ? "sticky left-0 z-30 bg-white border-r min-w-[180px]"
                          : idx === 1
                          ? "sticky left-[180px] z-30 bg-white border-r min-w-[120px]"
                          : idx === 2
                          ? "sticky left-[300px] z-30 bg-white border-r min-w-[120px]"
                          : "min-w-[100px]"
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const platform = row.original.platform;
                let platformBg = "bg-white";
                
                if (platform === "App Store") {
                  platformBg = "bg-blue-50";
                } else if (platform === "Google Play") {
                  platformBg = "bg-green-50";
                } else if (platform === "Stripe") {
                  platformBg = "bg-purple-50";
                }
                
                return (
                  <TableRow 
                    key={row.id}
                    className={platformBg}
                  >
                    {row.getVisibleCells().map((cell, idx) => (
                      <TableCell
                        key={cell.id}
                        className={
                          idx === 0
                            ? `sticky left-0 z-10 ${platformBg} border-r min-w-[180px]`
                            : idx === 1
                            ? `sticky left-[180px] z-10 ${platformBg} border-r min-w-[120px]`
                            : idx === 2
                            ? `sticky left-[300px] z-10 ${platformBg} border-r min-w-[120px]`
                            : "min-w-[100px]"
                        }
                      >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
