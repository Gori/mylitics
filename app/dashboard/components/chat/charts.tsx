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

export function LineChartDisplay({ title, data, lines }: LineChartDisplayProps) {
  // Transform data for recharts format
  const chartData = data.map(point => ({
    week: point.week,
    ...point.values
  }));

  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="week" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
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
}

export function BarChartDisplay({ title, data, xAxisLabel, yAxisLabel }: BarChartDisplayProps) {
  return (
    <div className="border rounded-lg p-4 bg-white">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="category" tick={{ fontSize: 12 }} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
          <YAxis tick={{ fontSize: 12 }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
          <Tooltip />
          <Bar dataKey="value" fill="#000000" />
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

