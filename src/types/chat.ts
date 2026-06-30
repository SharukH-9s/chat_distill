/**
 * Core Chat Data Types
 *
 * Represents the raw chat data extracted from any AI platform's DOM.
 * Consumed by extractors and passed to the service worker for LLM processing.
 */

/**
 * All supported AI chat platforms.
 * Platform configuration lives in src/shared/constants.ts.
 */
export type Platform = "chatgpt" | "gemini" | "claude";

/** A single message in a conversation. */
export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Optional — not all extractors capture timestamps. */
  timestamp?: string;
}

/** A full conversation extracted from an AI chat page. */
export interface Conversation {
  platform: Platform;
  messages: Message[];
  url: string;
  title?: string;
}
