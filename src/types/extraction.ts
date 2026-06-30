/**
 * Extraction Result Types + Diagnostics
 *
 * Defines the shape of data returned by the extraction cascade
 * and the validation step that follows.
 */

import type { Message } from "./chat";

/** Which extraction layer succeeded. */
export type ExtractionLayer = "api" | "precise" | "failed";

/** Whether the data came from the backend API or DOM scraping. */
export type ExtractionSource = "api" | "dom";

/** Numeric stats about the extracted conversation. */
export interface ExtractionStats {
  messageCount: number;
  charCount: number;
  userMessages: number;
  assistantMessages: number;
}

/** Metadata about the extraction execution. */
export interface ExtractionMeta {
  durationMs: number;
  layerUsed: ExtractionLayer;
  selectorVersion: string;
  /** Whether data came from the backend API or DOM scraping. Affects normalizer behavior. */
  source: ExtractionSource;
}

/** Transparency data about how the extraction was performed. */
export interface DiagnosticData {
  /** Which platform-specific extractor ran (e.g., "chatgpt"). */
  extractor: string;
  /** Confidence score from 0 (low) to 1 (high). */
  confidence: number;
  /** Non-fatal warnings (e.g., "Some messages may be code blocks"). */
  warnings: string[];
}

/** The full result returned by the content script after extraction. */
export interface ExtractionResult {
  messages: Message[];
  stats: ExtractionStats;
  meta: ExtractionMeta;
  diagnostics: DiagnosticData;
}

/** The result of validating an extraction, split into structural and semantic levels. */
export interface ValidationResult {
  valid: boolean;
  errors: {
    structural: string[];
    semantic: string[];
  };
}
