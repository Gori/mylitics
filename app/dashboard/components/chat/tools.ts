import { tool } from 'ai';
import { z } from 'zod';

export const lineChartTool = tool({
  description: 'Display a line chart for visualizing trends over time. Use this for time-series data like weekly metrics, subscriber growth, revenue trends. IMPORTANT: Each data point must include the week AND at least one numeric value field (e.g., appstore, stripe, unified).',
  inputSchema: z.object({
    title: z.string().describe('Chart title'),
    data: z.array(
      z.object({
        week: z.string().describe('Week label (e.g., "2025-01-01")'),
        appstore: z.number().optional().describe('App Store value'),
        googleplay: z.number().optional().describe('Google Play value'),
        stripe: z.number().optional().describe('Stripe value'),
        unified: z.number().optional().describe('Unified total value'),
      }).passthrough()
    ).describe('Array of data points. Each point must have "week" (string) and at least one numeric field (appstore, googleplay, stripe, unified, or other metric names).'),
    lines: z.array(z.object({
      key: z.string().describe('Data key to plot (must exactly match a numeric field name in the data objects)'),
      name: z.string().describe('Display name for legend'),
      color: z.string().optional().describe('Hex color code (optional)')
    })).describe('Line configurations - each key must match a numeric field in the data')
  }),
  execute: async ({ title, data, lines }) => {
    // Transform data to ensure it has the expected format
    const transformedData = data.map((point: any) => {
      const week = point.week || '';
      const values: Record<string, number> = {};
      
      // Extract all numeric fields except 'week'
      Object.keys(point).forEach(key => {
        if (key.toLowerCase() !== 'week' && typeof point[key] === 'number') {
          values[key] = point[key];
        }
      });
      
      return { week, values };
    });
    
    return { title, data: transformedData, lines };
  },
});

export const barChartTool = tool({
  description: 'Display a bar chart for comparing values across categories. Use this for comparisons like platform breakdowns, period-over-period comparisons.',
  inputSchema: z.object({
    title: z.string().describe('Chart title'),
    data: z.array(z.object({
      category: z.string().describe('Category name (e.g., "App Store", "Week 1")'),
      value: z.number().describe('Numeric value'),
      label: z.string().optional().describe('Optional value label')
    })).describe('Array of category-value pairs'),
    xAxisLabel: z.string().optional().describe('X-axis label'),
    yAxisLabel: z.string().optional().describe('Y-axis label')
  }),
  execute: async ({ title, data, xAxisLabel, yAxisLabel }) => {
    return { title, data, xAxisLabel, yAxisLabel };
  },
});

export const pieChartTool = tool({
  description: 'Display a pie chart for showing proportions and percentage distributions. Use this for market share, plan distributions, platform splits.',
  inputSchema: z.object({
    title: z.string().describe('Chart title'),
    data: z.array(z.object({
      name: z.string().describe('Segment name (e.g., "Monthly Plans")'),
      value: z.number().describe('Numeric value'),
      percentage: z.number().optional().describe('Percentage (will be calculated if not provided)')
    })).describe('Array of segments with names and values'),
  }),
  execute: async ({ title, data }) => {
    // Calculate percentages if not provided
    const total = data.reduce((sum, item) => sum + item.value, 0);
    const dataWithPercentages = data.map(item => ({
      ...item,
      percentage: item.percentage ?? (total > 0 ? (item.value / total) * 100 : 0)
    }));
    return { title, data: dataWithPercentages };
  },
});

export const tools = {
  lineChart: lineChartTool,
  barChart: barChartTool,
  pieChart: pieChartTool,
};

