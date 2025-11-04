import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, UIMessage } from 'ai';
import { tools } from '@/app/dashboard/components/chat/tools';

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const latestMessage = messages[messages.length - 1];
  const messageText = latestMessage?.parts?.[0]?.type === 'text' ? latestMessage.parts[0].text : '';
  
  console.log('=== API RECEIVED ===');
  console.log('Full message:', messageText);
  
  // Parse structured data and question
  const dataMatch = messageText.match(/\[DATA\]([\s\S]*?)\[\/DATA\]/);
  const questionMatch = messageText.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/);

  let data: any = null;
  try {
    data = dataMatch ? JSON.parse(dataMatch[1]) : null;
  } catch (e) {
    console.error('Failed to parse DATA JSON', e);
    return new Response('Invalid data format', { status: 400 });
  }

  if (!data || !questionMatch) {
    return new Response('Missing required data or question', { status: 400 });
  }

  const question = questionMatch[1];

  if (!data.platformBreakdown || !data.csvData) {
    return new Response('Missing platform breakdown or CSV data', { status: 400 });
  }

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
    monthlyRevenueGross: sum('monthlyRevenueGross'),
    monthlyRevenueNet: sum('monthlyRevenueNet'),
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
  
  const csvData = data.csvData;
  if (!csvData || csvData.trim() === '') {
    return new Response('CSV data is empty', { status: 400 });
  }
  
  const csvLines = csvData.split('\n');
  if (csvLines.length === 0) {
    return new Response('Invalid CSV format', { status: 400 });
  }
  
  const headerLine = csvLines[0];
  const weekHeaders = headerLine.split(',').slice(3);
  const dataStartDate = weekHeaders.length > 0 ? weekHeaders[0] : currentDate;
  const dataEndDate = weekHeaders.length > 0 ? weekHeaders[weekHeaders.length - 1] : currentDate;

  const systemMessage = `You are a subscription metrics analyst.

CURRENT DATE: ${currentDateFormatted} (${currentDate})

DATA DATE RANGE: ${dataStartDate} to ${dataEndDate} (approximately October 2024 to October 2025, 12 months of weekly data)
IMPORTANT: All data references are within this range. Do NOT reference dates outside this range (e.g., 2023 data does not exist).

CURRENT METRICS (UNIFIED TOTAL):
Active Subscribers: ${current.activeSubscribers}
Trial Subscribers: ${current.trialSubscribers}
Paid Subscribers: ${current.paidSubscribers}
Monthly Subscribers: ${current.monthlySubscribers}
Yearly Subscribers: ${current.yearlySubscribers}
MRR: ${data.currency} ${Number(current.mrr).toFixed(2)}
Monthly Revenue Gross: ${data.currency} ${Number(current.monthlyRevenueGross).toFixed(2)}
Monthly Revenue Net: ${data.currency} ${Number(current.monthlyRevenueNet).toFixed(2)}

Per-platform breakdown:
${breakdownLines}

Answer ONLY using these numbers and the data date range specified above. Be direct and concise.`;

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

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: systemMessage,
    messages: convertToModelMessages(cleanMessages),
    tools,
    maxSteps: 5,
  });

  return result.toUIMessageStreamResponse();
}

