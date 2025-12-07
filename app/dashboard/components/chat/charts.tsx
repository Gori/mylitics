import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { formatRevenue, type RevenueFormat } from "@/app/dashboard/formatters";

type DataStatus = 'real' | 'derived' | 'unavailable';

interface LineChartDisplayProps {
  title: string;
  data: Array<{
    week: string;
    values: Record<string, number>;
    // Optional status for each line key - when provided, derived/unavailable show as dashed
    statuses?: Record<string, DataStatus>;
    // Optional flag indicating this data point is from an incomplete period
    isIncomplete?: boolean;
  }>;
  lines: Array<{
    key: string;
    name: string;
    color?: string;
  }>;
}

const DEFAULT_COLORS = ['#000000', '#0071e3', '#34a853', '#635bff', '#f59e0b', '#ef4444', '#8b5cf6'];

const CustomTooltip = ({ active, payload, label, currency, isCurrency, revenueFormat }: any) => {
  if (active && payload && payload.length) {
    const formatValue = (val: number) => {
      if (isCurrency && currency) {
        return formatRevenue(val, currency, revenueFormat ?? "whole");
      }
      return new Intl.NumberFormat('en-US', {
        style: 'decimal',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(val);
    };

    // Deduplicate entries - combine _real and _derived keys into single entries
    // Also handle the case where dataKey ends with _real or _derived
    const seenKeys = new Set<string>();
    const entries: Array<{ name: string; value: number; color: string; isDerived: boolean }> = [];
    
    for (const entry of payload) {
      const dataKey = entry.dataKey as string;
      // Extract base key (remove _real or _derived suffix)
      const baseKey = dataKey.replace(/_real$|_derived$/, '');
      
      if (seenKeys.has(baseKey)) continue;
      
      // Get the actual value from the data point
      const dataPoint = entry.payload;
      const realValue = dataPoint[`${baseKey}_real`];
      const derivedValue = dataPoint[`${baseKey}_derived`];
      const directValue = dataPoint[baseKey];
      
      // Use direct value if available, otherwise combine real + derived
      const value = directValue ?? realValue ?? derivedValue ?? 0;
      const isDerived = realValue === null && derivedValue !== null;
      
      if (value !== null && value !== undefined) {
        seenKeys.add(baseKey);
        entries.push({
          name: entry.name,
          value,
          color: entry.color || entry.fill,
          isDerived,
        });
      }
    }

    const total = entries.reduce((acc, entry) => acc + (entry.value || 0), 0);

    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl p-3 text-sm z-50">
        <p className="font-medium mb-2">{label}</p>
        {entries.map((entry, index) => (
          <div key={index} className="flex items-center gap-2 mb-1.5 last:mb-0">
             <div 
               className="w-2.5 h-2.5 rounded-[2px]" 
               style={{ backgroundColor: entry.color, opacity: entry.isDerived ? 0.6 : 1 }} 
             />
             <span className="text-gray-500">
               {entry.name}
               {entry.isDerived && <span className="ml-1 text-amber-600">*</span>}
             </span>
             <span className="font-mono font-medium ml-auto text-gray-900">
               {formatValue(entry.value)}
             </span>
          </div>
        ))}
        {entries.length > 1 && (
            <div className="border-t border-gray-200 pt-1.5 mt-1.5 flex items-center justify-between font-medium text-gray-900">
                <span>Total</span>
                <span className="font-mono">
                  {formatValue(total)}
                </span>
            </div>
        )}
        {entries.some(e => e.isDerived) && (
          <div className="text-[10px] text-amber-600 mt-1">* Derived/estimated</div>
        )}
      </div>
    );
  }
  return null;
};

export function LineChartDisplay({ title, data, lines, currency, revenueFormat, chartType = "line" }: LineChartDisplayProps & { currency?: string; revenueFormat?: RevenueFormat; chartType?: "line" | "area" }) {
  // Check if any data point has status information (derived data)
  const hasStatusInfo = data.some(point => point.statuses);
  
  // Check if there are any trailing nulls (data ends before the series ends)
  const hasTrailingNulls = lines.some(line => {
    const values = data.map(p => p.values[line.key]);
    let lastNonNullIdx = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined) {
        lastNonNullIdx = i;
      }
    }
    return lastNonNullIdx >= 0 && lastNonNullIdx < values.length - 1;
  });
  
  const needsDualLines = hasStatusInfo || hasTrailingNulls;

  // Transform data for recharts format
  const chartData = (() => {
    if (!needsDualLines) {
      // No status info and no gaps - use original values as solid lines
      return data.map(point => ({
        week: point.week,
        ...point.values
      }));
    }
    
    // First pass: create base data with status flags
    const processedData = data.map(point => {
      const base: Record<string, any> = { week: point.week };
      
      for (const line of lines) {
        const value = point.values[line.key];
        const status = point.statuses?.[line.key] ?? 'real';
        // Real = status is 'real' (isIncomplete doesn't affect real data)
        const isReal = status === 'real';
        
        base[line.key] = value;
        base[`${line.key}_isReal`] = isReal;
      }
      
      return base;
    });
    
    // Second pass: carry forward last known value into null gaps (as derived)
    for (const line of lines) {
      const key = line.key;
      let lastKnownValue: number | null = null;
      
      for (let i = 0; i < processedData.length; i++) {
        const value = processedData[i][key];
        
        if (value !== null && value !== undefined) {
          lastKnownValue = value;
        } else if (lastKnownValue !== null) {
          // Carry forward as derived
          processedData[i][key] = lastKnownValue;
          processedData[i][`${key}_carriedForward`] = true;
          processedData[i][`${key}_isReal`] = false;
        }
      }
    }
    
    // Third pass: split into real vs derived with seamless connections
    return processedData.map((point, idx) => {
      const result: Record<string, any> = { week: point.week };
      
      for (const line of lines) {
        const key = line.key;
        const value = point[key];
        const isReal = point[`${key}_isReal`];
        const isCarriedForward = point[`${key}_carriedForward`];
        
        // Check if next point is derived (for seamless connection)
        const nextPoint = processedData[idx + 1];
        const nextIsNotReal = nextPoint && (
          !nextPoint[`${key}_isReal`] || nextPoint[`${key}_carriedForward`]
        ) && nextPoint[key] !== null;
        
        result[key] = value; // Keep original for tooltip
        
        if (value === null || value === undefined) {
          result[`${key}_real`] = null;
          result[`${key}_derived`] = null;
        } else if (isReal && !isCarriedForward) {
          result[`${key}_real`] = value;
          // Include in derived too if next is derived (seamless connection)
          result[`${key}_derived`] = nextIsNotReal ? value : null;
        } else {
          result[`${key}_real`] = null;
          result[`${key}_derived`] = value;
        }
      }
      
      return result;
    });
  })();

  const isCurrency = title.toLowerCase().includes('revenue') || title.toLowerCase().includes('mrr');

  const formatValue = (val: number) => {
    if (isCurrency && currency) {
      return formatRevenue(val, currency, revenueFormat ?? "whole");
    }
    return new Intl.NumberFormat('en-US', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2, // Allow up to 2 decimals for non-currency if needed
    }).format(val);
  };

  const renderLineChart = () => (
    <LineChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
      <XAxis dataKey="week" tick={{ fontSize: 12 }} />
      <YAxis tick={{ fontSize: 12 }} tickFormatter={formatValue} />
      <Tooltip content={<CustomTooltip currency={currency} isCurrency={isCurrency} revenueFormat={revenueFormat} />} />
      <Legend />
      {needsDualLines ? (
        <>
          {lines.map((line, idx) => (
            <Line
              key={`${line.key}_real`}
              type="monotone"
              dataKey={`${line.key}_real`}
              stroke={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
              strokeWidth={2}
              name={line.name}
              dot={false}
              connectNulls={false}
              legendType="none"
            />
          ))}
          {lines.map((line, idx) => (
            <Line
              key={`${line.key}_derived`}
              type="monotone"
              dataKey={`${line.key}_derived`}
              stroke={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
              strokeWidth={2}
              strokeDasharray="6 4"
              name={line.name}
              dot={false}
              connectNulls={false}
              legendType="none"
            />
          ))}
        </>
      ) : (
        lines.map((line, idx) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            stroke={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
            strokeWidth={2}
            name={line.name}
            dot={false}
          />
        ))
      )}
    </LineChart>
  );

  // For area charts, use raw data keys for proper stacking (no _real/_derived split)
  const areaChartData = data.map(point => ({
    week: point.week,
    ...point.values
  }));

  const renderAreaChart = () => (
    <AreaChart data={areaChartData}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
      <XAxis dataKey="week" tick={{ fontSize: 12 }} />
      <YAxis tick={{ fontSize: 12 }} tickFormatter={formatValue} />
      <Tooltip content={<CustomTooltip currency={currency} isCurrency={isCurrency} revenueFormat={revenueFormat} />} />
      <Legend />
      {lines.map((line, idx) => (
        <Area
          key={line.key}
          type="monotone"
          dataKey={line.key}
          stroke={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
          fill={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
          fillOpacity={0.6}
          strokeWidth={2}
          name={line.name}
          stackId="1"
          dot={false}
        />
      ))}
    </AreaChart>
  );

  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        {chartType === "area" ? renderAreaChart() : renderLineChart()}
      </ResponsiveContainer>
      {needsDualLines && (
        <div className="text-xs text-gray-500 mt-2 flex items-center gap-4">
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-gray-400" /> Real data
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-gray-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 2px, currentColor 2px, currentColor 4px)' }} /> Derived/estimated
          </span>
        </div>
      )}
    </div>
  );
}

interface BarChartDisplayProps {
  title: string;
  data: Array<{
    category: string;
    value: number;
    label?: string;
  }>;
  xAxisLabel?: string;
  yAxisLabel?: string;
  currency?: string;
}

export function BarChartDisplay({ title, data, xAxisLabel, yAxisLabel, currency, revenueFormat }: BarChartDisplayProps & { revenueFormat?: RevenueFormat }) {
  const isCurrency = title.toLowerCase().includes('revenue') || title.toLowerCase().includes('mrr');
  
  const formatValue = (val: number) => {
    if (isCurrency && currency) {
      return formatRevenue(val, currency, revenueFormat ?? "whole");
    }
    return new Intl.NumberFormat('en-US', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(val);
  };

  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="category" tick={{ fontSize: 12 }} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
          <YAxis tick={{ fontSize: 12 }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} tickFormatter={formatValue} />
          <Tooltip content={<CustomTooltip currency={currency} isCurrency={isCurrency} revenueFormat={revenueFormat} />} />
          <Bar dataKey="value" name="Value" fill="#000000" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface PieChartDisplayProps {
  title: string;
  data: Array<{
    name: string;
    value: number;
    percentage: number;
  }>;
}

const PIE_COLORS = ['#000000', '#0071e3', '#34a853', '#635bff', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function PieChartDisplay({ title, data }: PieChartDisplayProps) {
  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={(entry) => `${entry.name}: ${entry.percentage.toFixed(1)}%`}
            outerRadius={80}
            fill="#8884d8"
            dataKey="value"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value: number) => value.toLocaleString()} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

