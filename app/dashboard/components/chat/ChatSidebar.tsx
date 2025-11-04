"use client";

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageSquareIcon } from 'lucide-react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputHeader,
  PromptInputBody,
  PromptInputFooter,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputTools,
  PromptInputSpeechButton,
  PromptInputModelSelect,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { Response } from '@/components/ai-elements/response';
import { LineChartDisplay, BarChartDisplay, PieChartDisplay } from './charts';

interface ChatSidebarProps {
  chatContext: any;
  debugData: any;
}

const models = [
  { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
  { id: 'gpt-5', name: 'GPT-5' },
];

function HeaderControls() {
  return null;
}

function generateCSV(debugData: any): string {
  if (!debugData || !debugData.latestByPlatform || !debugData.weeklyDataByMetric || !debugData.flowMetrics) return '';

  const metricLabels: Record<string, string> = {
    activeSubscribers: "Active Subscribers",
    trialSubscribers: "Trial Subscribers",
    paidSubscribers: "Paid Subscribers",
    monthlySubscribers: "Monthly Subs",
    yearlySubscribers: "Yearly Subs",
    cancellations: "Cancellations",
    graceEvents: "Grace Events",
    firstPayments: "First Payments",
    renewals: "Renewals",
    mrr: "MRR",
    monthlyRevenueGross: "Monthly Rev. (Gross)",
    monthlyRevenueNet: "Monthly Rev. (Net)",
  };

  const metrics = Object.keys(metricLabels);
  const flowMetrics = debugData.flowMetrics;
  const rows: Array<{ metricName: string; platform: string; total: number; weeks: Record<string, number> }> = [];

  const allWeeks = new Set<string>();
  for (const metric of metrics) {
    const weeklyData = debugData.weeklyDataByMetric[metric];
    if (weeklyData && Array.isArray(weeklyData)) {
      weeklyData.forEach((w: any) => {
        if (w && w.week) allWeeks.add(w.week);
      });
    }
  }
  const sortedWeeks = Array.from(allWeeks).sort();

  for (const metric of metrics) {
    const weeklyData = debugData.weeklyDataByMetric[metric];
    if (!weeklyData || !Array.isArray(weeklyData)) continue;
    
    const isFlowMetric = flowMetrics.includes(metric);

    const weekLookup: Record<string, any> = {};
    weeklyData.forEach((w: any) => {
      if (w && w.week) {
        weekLookup[w.week] = w;
      }
    });

    const platforms = ["appstore", "googleplay", "stripe"];
    const platformLabels: Record<string, string> = {
      appstore: "App Store",
      googleplay: "Google Play",
      stripe: "Stripe",
    };

    const platformTotals: Record<string, number> = {};

    for (const platform of platforms) {
      let platformTotal = 0;
      if (isFlowMetric) {
        if (debugData.flowSumsByPlatform && debugData.flowSumsByPlatform[platform] && debugData.flowSumsByPlatform[platform][metric] !== undefined) {
          platformTotal = debugData.flowSumsByPlatform[platform][metric];
        }
      } else {
        if (debugData.latestByPlatform[platform] && debugData.latestByPlatform[platform][metric] !== undefined) {
          platformTotal = debugData.latestByPlatform[platform][metric];
        }
      }
      platformTotals[platform] = platformTotal;
    }

    const unifiedTotal = 
      platformTotals.appstore + 
      platformTotals.googleplay + 
      platformTotals.stripe;

    const unifiedWeeks: Record<string, number> = {};
    sortedWeeks.forEach((week) => {
      unifiedWeeks[week] = weekLookup[week]?.unified ?? 0;
    });

    rows.push({
      metricName: metricLabels[metric],
      platform: "Unified",
      total: unifiedTotal,
      weeks: unifiedWeeks,
    });

    for (const platform of platforms) {
      const platformWeeks: Record<string, number> = {};
      sortedWeeks.forEach((week) => {
        platformWeeks[week] = weekLookup[week]?.[platform] ?? 0;
      });

      rows.push({
        metricName: metricLabels[metric],
        platform: platformLabels[platform],
        total: platformTotals[platform],
        weeks: platformWeeks,
      });
    }
  }

  if (rows.length === 0) return '';

  const headers = ["Metric", "Platform", "Total", ...sortedWeeks];
  const csvRows = [headers.join(",")];

  for (const row of rows) {
    const weekValues = sortedWeeks.map((week) => row.weeks[week] ?? 0);
    csvRows.push([
      `"${row.metricName}"`,
      row.platform,
      row.total,
      ...weekValues,
    ].join(","));
  }

  return csvRows.join("\n");
}

function ChatInput({ 
  chatContext, 
  debugData, 
  sendMessage, 
  status, 
  onError 
}: { 
  chatContext: any; 
  debugData: any; 
  sendMessage: (message: { text: string }) => void; 
  status: string; 
  onError: (error: string) => void;
}) {
  const controller = usePromptInputController();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [model, setModel] = useState(models[0].id);

  const handleSubmit = (message: { text?: string; files?: any[] }, e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const messageText = message.text ?? '';
    if (!messageText.trim() || status !== 'ready' || !chatContext || !debugData) return;

    const latest = chatContext.latestMetrics;
    const csvData = generateCSV(debugData);
    
    const fullPayload = {
      currency: chatContext.currency,
      current: latest,
      platformBreakdown: latest.platformBreakdown,
      csvData: csvData,
    };

    const messageWithContext = `[DATA]${JSON.stringify(fullPayload)}[/DATA][QUESTION]${messageText}[/QUESTION]`;

    sendMessage({ text: messageWithContext });
    controller.textInput.clear();
    
    // Refocus the textarea immediately
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  return (
    <>
      <HeaderControls />
      <PromptInput globalDrop multiple onSubmit={handleSubmit}>
        <PromptInputHeader>
          <PromptInputAttachments>
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea 
            ref={textareaRef}
            placeholder={chatContext ? "Ask about your metrics..." : "Loading..."}
            disabled={status !== 'ready' || !chatContext}
            className="text-base"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputSpeechButton textareaRef={textareaRef} className="text-base" />
            <PromptInputModelSelect onValueChange={setModel} value={model}>
              <PromptInputModelSelectTrigger className="text-base">
                <PromptInputModelSelectValue />
              </PromptInputModelSelectTrigger>
              <PromptInputModelSelectContent>
                {models.map((modelOption) => (
                  <PromptInputModelSelectItem
                    key={modelOption.id}
                    value={modelOption.id}
                    className="text-base"
                  >
                    {modelOption.name}
                  </PromptInputModelSelectItem>
                ))}
              </PromptInputModelSelectContent>
            </PromptInputModelSelect>
          </PromptInputTools>
          <PromptInputSubmit 
            status={status === 'streaming' ? 'streaming' : 'ready'}
            disabled={status !== 'ready' || !chatContext}
            className="text-base"
          />
        </PromptInputFooter>
      </PromptInput>
    </>
  );
}

export function ChatSidebar({ chatContext, debugData }: ChatSidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error: chatError } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
    onError: (error) => {
      console.error('Chat error:', error);
      setError(error.message || 'Failed to get response. Please try again.');
    },
  });

  useEffect(() => {
    if (sidebarRef.current) {
      sidebarRef.current.style.setProperty('--sidebar-width', '32rem');
    }
  }, []);

  return (
    <div ref={sidebarRef} className="text-base">
      <Sidebar side="right" className="text-base">
        <SidebarHeader>
          <h2 className="text-3xl font-semibold pl-8 pt-2">Assistant</h2>
        </SidebarHeader>

      <SidebarGroup className="flex flex-col flex-1 min-h-0">
        <SidebarContent className="flex-1 min-h-0">
          <Conversation className="h-full">
            <ConversationContent>
              {messages.length === 0 ? (
                <ConversationEmptyState
                  icon={<MessageSquareIcon className="size-8" />}
                  title="Start a conversation"
                  description="Ask me anything about your subscription metrics. Try questions like: Which week did we gain most subscribers? Show me revenue trends by platform. What's the split between monthly and yearly plans? Compare MRR across platforms."
                />
              ) : (
                messages.map((message) => {
                  const hasCharts = message.parts.some(part => 
                    part.type === 'tool-lineChart' || 
                    part.type === 'tool-barChart' || 
                    part.type === 'tool-pieChart'
                  );
                  return (
                    <Message key={message.id} from={message.role}>
                      <MessageContent className={cn("text-base", hasCharts && message.role === 'assistant' && "max-w-full")}>
                        {message.parts.map((part, index) => {
                        if (part.type === 'text') {
                          let displayText = part.text;
                          if (message.role === 'user') {
                            const questionMatch = part.text.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/);
                            displayText = questionMatch ? questionMatch[1] : part.text;
                          }
                          
                          return (
                            <Response key={index} className="text-base">
                              {displayText}
                            </Response>
                          );
                        }

                        if (part.type === 'tool-lineChart') {
                          switch (part.state) {
                            case 'input-available':
                              return (
                                <div key={index} className="space-y-2">
                                  <Skeleton className="h-[300px] w-full" />
                                  <div className="text-base text-gray-500">Generating chart...</div>
                                </div>
                              );
                            case 'output-available':
                              return (
                                <div key={index} className="-mx-4 -my-3 first:-mt-0 last:-mb-0">
                                  <LineChartDisplay {...(part.output as any)} />
                                </div>
                              );
                            case 'output-error':
                              return (
                                <div key={index} className="text-base text-red-600">
                                  Error generating chart: {part.errorText}
                                </div>
                              );
                            default:
                              return null;
                          }
                        }

                        if (part.type === 'tool-barChart') {
                          switch (part.state) {
                            case 'input-available':
                              return (
                                <div key={index} className="space-y-2">
                                  <Skeleton className="h-[300px] w-full" />
                                  <div className="text-base text-gray-500">Generating chart...</div>
                                </div>
                              );
                            case 'output-available':
                              return (
                                <div key={index} className="-mx-4 -my-3 first:-mt-0 last:-mb-0">
                                  <BarChartDisplay {...(part.output as any)} />
                                </div>
                              );
                            case 'output-error':
                              return (
                                <div key={index} className="text-base text-red-600">
                                  Error generating chart: {part.errorText}
                                </div>
                              );
                            default:
                              return null;
                          }
                        }

                        if (part.type === 'tool-pieChart') {
                          switch (part.state) {
                            case 'input-available':
                              return (
                                <div key={index} className="space-y-2">
                                  <Skeleton className="h-[300px] w-full" />
                                  <div className="text-base text-gray-500">Generating chart...</div>
                                </div>
                              );
                            case 'output-available':
                              return (
                                <div key={index} className="-mx-4 -my-3 first:-mt-0 last:-mb-0">
                                  <PieChartDisplay {...(part.output as any)} />
                                </div>
                              );
                            case 'output-error':
                              return (
                                <div key={index} className="text-base text-red-600">
                                  Error generating chart: {part.errorText}
                                </div>
                              );
                            default:
                              return null;
                          }
                        }

                        return null;
                        })}
                      </MessageContent>
                    </Message>
                  );
                })
              )}

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-base text-red-700">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {!chatContext && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-base text-yellow-700">
                  Loading metrics data...
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton className="text-base" />
          </Conversation>
        </SidebarContent>

        <SidebarFooter className="mt-auto text-base">
          <PromptInputProvider>
            <ChatInput
              chatContext={chatContext}
              debugData={debugData}
              sendMessage={sendMessage}
              status={status}
              onError={setError}
            />
          </PromptInputProvider>
        </SidebarFooter>
      </SidebarGroup>
    </Sidebar>
    </div>
  );
}
