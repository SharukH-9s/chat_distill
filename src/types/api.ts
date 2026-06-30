/**
 * Gemini API Types + Export Context
 *
 * Shapes for requests/responses to the Gemini generateContent endpoint,
 * plus ExportContext which bundles per-export metadata in the service worker.
 */

import type { Conversation } from "./chat";

/** Request payload for Gemini's generateContent endpoint. */
export interface GeminiRequest {
  contents: Array<{
    role: string;
    parts: Array<{ text: string }>;
  }>;
  generationConfig?: Record<string, unknown>;
}

/** Successful response from Gemini's generateContent endpoint. */
export interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
}

/** Error response from the Gemini API. */
export interface GeminiError {
  code: number;
  message: string;
  status: string;
}

/**
 * Bundles all metadata about a single export operation.
 * Constructed inside the service worker after receiving a Conversation
 * from the popup and reading settings from storage.
 */
export interface ExportContext {
  conversation: Conversation;
  /** Prompt template version used (e.g., "1.4.0"). */
  promptVersion: string;
  /** Gemini model used (e.g., "gemini-2.5-flash"). */
  model: string;
  /** ISO 8601 timestamp of when the export was initiated. */
  timestamp: string;
  /** The ID of the profile used to generate the distillation instructions. */
  profileId?: string;
}
