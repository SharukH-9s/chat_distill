import type { Message } from "@/types/chat";
import type { ExtractionStats } from "@/types/extraction";

export function computeStats(messages: Message[]): ExtractionStats {
  return {
    messageCount: messages.length,
    charCount: messages.reduce((sum, m) => sum + m.content.length, 0),
    userMessages: messages.filter((m) => m.role === "user").length,
    assistantMessages: messages.filter((m) => m.role === "assistant").length,
  };
}
