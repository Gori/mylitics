import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';

interface LineChartDisplayProps {
  title: string;
  data: Array<{
    week: string;
    values: Record<string, number>;
  }>;
  lines: Array<{
    key: string;
    name: string;
    color?: string;
  }>;
}

const DEFAULT_COLORS = ['#000000', '#0071e3', '#34a853', '#635bff', '#f59e0b', '#ef4444', '#8b5cf6'];

const CustomTooltip = ({ active, payload, label, currency, isCurrency }: any) => {
  if (active && payload && payload.length) {
    const total = payload.reduce((acc: number, entry: any) => acc + (entry.value || 0), 0);

    const formatValue = (val: number) => {
      if (isCurrency && currency) {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }).format(val);
      }
      return new Intl.NumberFormat('en-US', {
        style: 'decimal',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(val);
    };

    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-xl p-3 text-sm z-50">
        <p className="font-medium mb-2">{label}</p>
        {payload.map((entry: any, index: number) => (
          <div key={index} className="flex items-center gap-2 mb-1.5 last:mb-0">
             <div className="w-2.5 h-2.5 rounded-[2px]" style={{ backgroundColor: entry.color || entry.fill }} />
             <span className="text-gray-500">{entry.name}</span>
             <span className="font-mono font-medium ml-auto text-gray-900">
               {formatValue(entry.value)}
             </span>
          </div>
        ))}
        {payload.length > 1 && (
            <div className="border-t border-gray-200 pt-1.5 mt-1.5 flex items-center justify-between font-medium text-gray-900">
                <span>Total</span>
                <span className="font-mono">
                  {formatValue(total)}
                </span>
            </div>
        )}
      </div>
    );
  }
  return null;
};

export function LineChartDisplay({ title, data, lines, currency }: LineChartDisplayProps & { currency?: string }) {
  // Transform data for recharts format
  const chartData = data.map(point => ({
    week: point.week,
    ...point.values
  }));

  const isCurrency = title.toLowerCase().includes('revenue') || title.toLowerCase().includes('mrr');

  const formatValue = (val: number) => {
    if (isCurrency && currency) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(val);
    }
    return new Intl.NumberFormat('en-US', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2, // Allow up to 2 decimals for non-currency if needed
    }).format(val);
  };

  const CustomTooltipWithCurrency = (props: any) => {
    // Override the generic CustomTooltip to support currency if needed, 
    // but actually CustomTooltip above uses simple decimal formatting. 
    // We should probably make CustomTooltip smarter.
    // Let's rewrite CustomTooltip to handle formatting.
    return <CustomTooltip {...props} currency={currency} isCurrency={isCurrency} />;
  }

  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="week" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={formatValue} />
          <Tooltip content={<CustomTooltip currency={currency} isCurrency={isCurrency} />} />
          <Legend />
          {lines.map((line, idx) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              stroke={line.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
              strokeWidth={2}
              name={line.name}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
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

export function BarChartDisplay({ title, data, xAxisLabel, yAxisLabel, currency }: BarChartDisplayProps) {
  const isCurrency = title.toLowerCase().includes('revenue') || title.toLowerCase().includes('mrr');
  
  const formatValue = (val: number) => {
    if (isCurrency && currency) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(val);
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
          <Tooltip content={<CustomTooltip currency={currency} isCurrency={isCurrency} />} />
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

