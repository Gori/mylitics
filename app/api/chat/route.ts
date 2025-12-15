import { google, GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';
import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
import { tools } from '@/app/dashboard/components/chat/tools';

function extractDateRange(csvData: string): { start: string; end: string } | null {
  if (!csvData?.trim()) return null;
  const lines = csvData.split('\n');
  if (lines.length === 0) return null;
  const headers = lines[0].split(',').slice(3);
  if (headers.length === 0) return null;
  return { start: headers[0], end: headers[headers.length - 1] };
}

export async function POST(request: Request) {
  console.log('\n=== CHAT API REQUEST ===');
  const startTime = Date.now();
  
  const { messages }: { messages: UIMessage[] } = await request.json();

  const latestMessage = messages[messages.length - 1];
  const messageText = latestMessage?.parts?.[0]?.type === 'text' ? latestMessage.parts[0].text : '';
  
  // Parse structured data and question
  const dataMatch = messageText.match(/\[DATA\]([\s\S]*?)\[\/DATA\]/);
  const questionMatch = messageText.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/);

  let data: any = null;
  try {
    data = dataMatch ? JSON.parse(dataMatch[1]) : null;
  } catch (e) {
    console.error('[CHAT API] Failed to parse DATA JSON', e);
    return new Response('Invalid data format', { status: 400 });
  }

  if (!data || !questionMatch) {
    console.error('[CHAT API] Missing required data or question');
    return new Response('Missing required data or question', { status: 400 });
  }

  const question = questionMatch[1];
  console.log('[CHAT API] Question:', question);
  console.log('[CHAT API] Message count:', messages.length);

  if (!data.platformBreakdown || (!data.weeklyCSV && !data.monthlyCSV)) {
    console.error('[CHAT API] Missing platform breakdown or CSV data');
    return new Response('Missing platform breakdown or CSV data', { status: 400 });
  }
  
  console.log('[CHAT API] Currency:', data.currency);
  console.log('[CHAT API] Weekly CSV rows:', data.weeklyCSV?.split('\n').length || 0);
  console.log('[CHAT API] Monthly CSV rows:', data.monthlyCSV?.split('\n').length || 0);

  const platformSnapshots = [
    data.platformBreakdown.appstore,
    data.platformBreakdown.googleplay,
    data.platformBreakdown.stripe,
  ].filter(Boolean);

  const sum = (key: string) => {
    return platformSnapshots.reduce((acc: number, snap: any) => {
      const value = snap[key];
      return acc + (typeof value === 'number' ? value : 0);
    }, 0);
  };

  const current = {
    activeSubscribers: sum('activeSubscribers'),
    trialSubscribers: sum('trialSubscribers'),
    paidSubscribers: sum('paidSubscribers'),
    monthlySubscribers: sum('monthlySubscribers'),
    yearlySubscribers: sum('yearlySubscribers'),
    mrr: sum('mrr'),
    monthlyChargedRevenue: sum('monthlyChargedRevenue'),
    monthlyRevenue: sum('monthlyRevenue'),
  };

  const breakdownLines = platformSnapshots
    .map((snap: any) => {
      const active = typeof snap.activeSubscribers === 'number' ? snap.activeSubscribers : 0;
      const trial = typeof snap.trialSubscribers === 'number' ? snap.trialSubscribers : 0;
      const paid = typeof snap.paidSubscribers === 'number' ? snap.paidSubscribers : 0;
      const mrr = typeof snap.mrr === 'number' ? snap.mrr : 0;
      return `- ${snap.platform}: active=${active}, trial=${trial}, paid=${paid}, mrr=${Number(mrr).toFixed(2)}`;
    })
    .join('\n');

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentDateFormatted = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  
  // Extract date ranges from both CSV datasets
  const weeklyRange = extractDateRange(data.weeklyCSV);
  const monthlyRange = extractDateRange(data.monthlyCSV);

  const systemMessage = `You are a subscription metrics analyst with access to comprehensive historical data.

CURRENT DATE: ${currentDateFormatted} (${currentDate})

=== CURRENT METRICS (UNIFIED TOTAL) ===
Active Subscribers: ${current.activeSubscribers}
Trial Subscribers: ${current.trialSubscribers}
Paid Subscribers: ${current.paidSubscribers}
Monthly Subscribers: ${current.monthlySubscribers}
Yearly Subscribers: ${current.yearlySubscribers}
MRR: ${data.currency} ${Number(current.mrr).toFixed(2)}
Charged Revenue (incl. VAT): ${data.currency} ${Number(current.monthlyChargedRevenue).toFixed(2)}
Revenue (excl. VAT): ${data.currency} ${Number(current.monthlyRevenue).toFixed(2)}

Per-platform breakdown:
${breakdownLines}

=== HISTORICAL DATA AVAILABLE ===

You have access to TWO datasets for historical analysis:

1. WEEKLY DATA${weeklyRange ? ` (${weeklyRange.start} to ${weeklyRange.end})` : ''}:
   - Granular week-by-week metrics
   - Best for: identifying specific weeks with changes, short-term trends, recent performance
   - CSV columns: Metric, Platform, Total, [weekly dates...]
   
${data.weeklyCSV || 'No weekly data available'}

2. MONTHLY DATA${monthlyRange ? ` (${monthlyRange.start} to ${monthlyRange.end})` : ''}:
   - Aggregated month-by-month metrics
   - Best for: long-term trends, seasonal patterns, year-over-year comparisons
   - CSV columns: Metric, Platform, Total, [monthly periods as YYYY-MM...]

${data.monthlyCSV || 'No monthly data available'}

=== METRICS EXPLANATION ===
- Stock metrics (Active/Trial/Paid/Monthly/Yearly Subscribers, MRR): Show point-in-time values
- Flow metrics (Cancellations, First Payments, Renewals, Revenue): Show cumulative amounts per period
- Platforms: Unified (all combined), App Store, Google Play, Stripe

=== INSTRUCTIONS ===
- Use weekly data for granular analysis and finding specific time periods
- Use monthly data for broader trends and long-term patterns
- When creating charts, use the "week" field for weekly data timestamps
- Always cite which dataset (weekly/monthly) you're using for analysis
- Be direct and concise in your answers`;

  const cleanMessages = messages.map(msg => {
    if (msg.role === 'user') {
      const text = msg.parts && msg.parts[0] && msg.parts[0].type === 'text' ? msg.parts[0].text : '';
      const q = text.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/);
      if (q && q[1]) {
        return {
          ...msg,
          parts: [{ type: 'text' as const, text: q[1] }]
        };
      }
    }
    return msg;
  });

  // Log what we're sending to the AI
  console.log('[CHAT API] Current metrics:', current);
  console.log('[CHAT API] Platform breakdown:', breakdownLines);
  console.log('[CHAT API] Weekly range:', weeklyRange);
  console.log('[CHAT API] Monthly range:', monthlyRange);
  console.log('[CHAT API] System message length:', systemMessage.length, 'chars');
  console.log('[CHAT API] Cleaned messages:', cleanMessages.length);
  
  // Log each message summary
  cleanMessages.forEach((msg, i) => {
    const parts = msg.parts || [];
    const partsSummary = parts.map((p: any) => {
      if (p.type === 'text') return `text(${p.text?.length || 0} chars)`;
      if (p.type === 'tool-invocation') return `tool(${p.toolInvocationId})`;
      return p.type;
    }).join(', ');
    console.log(`[CHAT API] Message ${i + 1}: role=${msg.role}, parts=[${partsSummary}]`);
  });
  
  const modelMessages = convertToModelMessages(cleanMessages);
  const totalContentSize = JSON.stringify(modelMessages).length;
  console.log('[CHAT API] Model messages content size:', totalContentSize, 'chars');
  console.log('[CHAT API] Sending to Google (gemini-3-pro-preview)...');

  try {
    const result = streamText({
      model: google('gemini-3-pro-preview'),
      system: systemMessage,
      messages: convertToModelMessages(cleanMessages),
      tools,
      stopWhen: stepCountIs(5),
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: 'low',
          },
        } satisfies GoogleGenerativeAIProviderOptions,
      },
      onFinish: ({ text, toolCalls, usage, finishReason }) => {
        const duration = Date.now() - startTime;
        console.log('\n=== CHAT API RESPONSE ===');
        console.log('[CHAT API] Duration:', duration, 'ms');
        console.log('[CHAT API] Finish reason:', finishReason);
        console.log('[CHAT API] Response length:', text?.length || 0, 'chars');
        console.log('[CHAT API] Tool calls:', toolCalls?.length || 0);
        if (toolCalls?.length) {
          toolCalls.forEach((tc, i) => console.log(`[CHAT API] Tool ${i + 1}:`, tc.toolName));
        }
        console.log('[CHAT API] Usage:', usage);
        console.log('[CHAT API] Response preview:', text?.slice(0, 200) + (text && text.length > 200 ? '...' : ''));
      },
      onError: (error) => {
        console.error('\n=== CHAT API ERROR ===');
        console.error('[CHAT API] Error:', error);
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('\n=== CHAT API FATAL ERROR ===');
    console.error('[CHAT API] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to process chat request', details: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

