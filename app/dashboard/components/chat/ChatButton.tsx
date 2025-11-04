"use client";

import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ChatButtonProps {
  onClick: () => void;
}

export function ChatButton({ onClick }: ChatButtonProps) {
  return (
    <Button
      onClick={onClick}
      size="icon"
      className="fixed bottom-4 right-4 h-14 w-14 rounded-full shadow-lg z-50"
      aria-label="Open analytics assistant"
    >
      <MessageSquare className="h-6 w-6" />
    </Button>
  );
}

