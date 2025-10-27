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

type DebugRow = {
  metricName: string;
  platform: string;
  total: number;
  weeks: Record<string, number>;
};

type DebugDataTableProps = {
  debugData: any;
};

export function DebugDataTable({ debugData }: DebugDataTableProps) {
  const downloadData = () => {
    if (!rows || rows.length === 0) return;

    // Create CSV content
    const headers = ["Metric", "Platform", "Total", ...weekHeaders];
    const csvRows = [headers.join(",")];

    for (const row of rows) {
      const weekValues = weekHeaders.map((week) => row.weeks[week] || 0);
      csvRows.push([
        `"${row.metricName}"`,
        row.platform,
        row.total,
        ...weekValues,
      ].join(","));
    }

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `metrics-debug-${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const { rows, weekHeaders } = useMemo(() => {
    if (!debugData || !debugData.latestByPlatform) return { rows: [], weekHeaders: [] };

    const metricLabels: Record<string, string> = {
      activeSubscribers: "Active Subscribers",
      trialSubscribers: "Trial Subscribers",
      paidSubscribers: "Paid Subscribers",
      monthlySubscribers: "Monthly Subs",
      yearlySubscribers: "Yearly Subs",
      cancellations: "Cancellations",
      churn: "Churn",
      graceEvents: "Grace Events",
      firstPayments: "First Payments",
      renewals: "Renewals",
      weeklyRevenue: "Revenue (Week)",
      mrr: "MRR",
      monthlyRevenueGross: "Monthly Rev. (Gross)",
      monthlyRevenueNet: "Monthly Rev. (Net)",
    };

    const metrics = Object.keys(metricLabels);
    const flowMetrics = debugData.flowMetrics || [];
    const rows: DebugRow[] = [];

    // Get all unique weeks across all metrics
    const allWeeks = new Set<string>();
    for (const metric of metrics) {
      const weeklyData = debugData.weeklyDataByMetric[metric] || [];
      weeklyData.forEach((w: any) => allWeeks.add(w.week));
    }
    const sortedWeeks = Array.from(allWeeks).sort();

    for (const metric of metrics) {
      const weeklyData = debugData.weeklyDataByMetric[metric] || [];
      const isFlowMetric = flowMetrics.includes(metric);

      // Create week lookup for this metric
      const weekLookup: Record<string, any> = {};
      weeklyData.forEach((w: any) => {
        weekLookup[w.week] = w;
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

      const unifiedWeeks: Record<string, number> = {};
      sortedWeeks.forEach((week) => {
        unifiedWeeks[week] = weekLookup[week]?.unified || 0;
      });

      rows.push({
        metricName: metricLabels[metric],
        platform: "Unified",
        total: unifiedTotal,
        weeks: unifiedWeeks,
      });

      // Add platform rows
      for (const platform of platforms) {
        const platformWeeks: Record<string, number> = {};
        sortedWeeks.forEach((week) => {
          platformWeeks[week] = weekLookup[week]?.[platform] || 0;
        });

        rows.push({
          metricName: metricLabels[metric],
          platform: platformLabels[platform],
          total: platformTotals[platform],
          weeks: platformWeeks,
        });
      }
    }

    return { rows, weekHeaders: sortedWeeks };
  }, [debugData]);

  const formatValue = (metricName: string, value: number) => {
    const currencyMetrics = ["Revenue (Week)", "MRR", "Monthly Rev. (Gross)", "Monthly Rev. (Net)"];
    if (currencyMetrics.includes(metricName)) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value);
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

    const weekColumns: ColumnDef<DebugRow>[] = weekHeaders.map((week, idx) => ({
      id: `week-${week}`,
      header: () => {
        const date = new Date(week);
        return (
          <div className="text-xs whitespace-nowrap">
            {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        );
      },
      cell: (info) => {
        const row = info.row.original;
        const value = row.weeks[week] || 0;
        return (
          <div className="text-xs whitespace-nowrap">
            {formatValue(row.metricName, value)}
          </div>
        );
      },
    }));

    return [...baseColumns, ...weekColumns];
  }, [weekHeaders]);

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
              {table.getRowModel().rows.map((row, rowIndex) => {
                const isOddRow = rowIndex % 2 === 1;
                const rowBg = isOddRow ? "bg-gray-50" : "bg-white";
                return (
                  <TableRow 
                    key={row.id}
                    className={isOddRow ? "bg-gray-50" : ""}
                  >
                    {row.getVisibleCells().map((cell, idx) => (
                      <TableCell
                        key={cell.id}
                        className={
                          idx === 0
                            ? `sticky left-0 z-10 ${rowBg} border-r min-w-[180px]`
                            : idx === 1
                            ? `sticky left-[180px] z-10 ${rowBg} border-r min-w-[120px]`
                            : idx === 2
                            ? `sticky left-[300px] z-10 ${rowBg} border-r min-w-[120px]`
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

