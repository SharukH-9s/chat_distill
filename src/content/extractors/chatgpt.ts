/**
 * ChatGPT Extractor — Layer 1 (Precise)
 *
 * Uses ChatGPT-specific DOM attributes for high-fidelity extraction.
 * Primary anchor: [data-message-author-role] — the most stable hook.
 *
 * Extraction Contract:
 * - Stateless: no module-level state, no side effects
 * - Scoped: only reads DOM, never writes
 * - Returns null on total failure (not partial junk)
 *
 * DOM Order Guarantee:
 *   document.querySelectorAll() returns elements in document order
 *   (depth-first tree traversal per DOM spec). Messages are therefore
 *   guaranteed to be in conversation order. Do NOT refactor to use
 *   methods that break this guarantee (e.g., parallel collection + sort).
 */

import type { Message } from "@/types/chat";
import type {
  ExtractionResult,
  ExtractionStats,
  ExtractionMeta,
  DiagnosticData,
} from "@/types/extraction";
import { computeStats } from "@/shared/utils";

export const SELECTOR_VERSION = "chatgpt-v1";

// Selectors

/**
 * Primary role anchor. The most stable attribute OpenAI has kept
 * across multiple UI rewrites (2023–2026).
 */
const ROLE_SELECTOR = "[data-message-author-role]";

/**
 * Content selectors tried in priority order within each message container.
 * We try the most semantic first, falling back to raw innerText.
 */
const CONTENT_SELECTORS = [
  ".markdown.prose",
  "[class*='markdown']",
  "[class*='message-content']",
  "[data-message-content]",
  ".whitespace-pre-wrap", // New ChatGPT user bubble text container
];

const SKIP_RATIO_STABLE = 0.1;
const SKIP_RATIO_DEGRADED = 0.3;

/**
 * Known garbage strings that ChatGPT sometimes renders as
 * placeholder/artifact content. These are not real messages.
 */
const GARBAGE_CONTENT = new Set([
  "[object Object]",
  "...",
  "…",
  "undefined",
  "null",
  "Loading...",
  "ChatGPT can make mistakes. Check important info.",
]);

/**
 * Returns true if a content string passes integrity checks.
 * Filters out empty strings, single-char noise, and known garbage.
 */
function isIntegrousContent(content: string): boolean {
  if (content.length === 0) return false;
  if (content.length < 2) return false; // single-char artifacts
  if (GARBAGE_CONTENT.has(content)) return false;
  return true;
}

// Helpers

/**
 * Extracts clean text content from a message container element.
 * Tries semantic content selectors first, falls back to container innerText.
 */
function extractContent(container: Element): string {
  for (const selector of CONTENT_SELECTORS) {
    const el = container.querySelector(selector);
    if (el && el.textContent && el.textContent.trim().length > 0) {
      return el.textContent.trim();
    }
  }
  return (container as HTMLElement).innerText?.trim() ?? "";
}

/**
 * Maps the raw role attribute value to our typed role.
 * Returns null for unknown roles (e.g., "tool", "system") so we skip them.
 */
function parseRole(el: Element): "user" | "assistant" | null {
  const raw = el.getAttribute("data-turn") ?? el.getAttribute("data-message-author-role") ?? "";
  if (raw === "user") return "user";
  if (raw === "assistant") return "assistant";
  return null;
}

/**
 * Signal-based confidence scoring.
 * Starts at a baseline and adjusts based on extraction quality signals.
 */
function computeConfidence(
  totalCandidates: number,
  skippedRoles: number,
  skippedIntegrity: number,
  hasUserMessages: boolean,
  hasAssistantMessages: boolean,
): number {
  if (totalCandidates === 0) return 0;

  let confidence = 0.95; // baseline for precise extractor

  // Degrade if only one role present
  if (!hasUserMessages || !hasAssistantMessages) {
    confidence -= 0.4;
  }

  // Degrade based on skip ratio
  const totalSkipped = skippedRoles + skippedIntegrity;
  const skipRatio = totalSkipped / totalCandidates;

  if (skipRatio > SKIP_RATIO_DEGRADED) {
    confidence -= 0.3; // likely DOM mismatch
  } else if (skipRatio > SKIP_RATIO_STABLE) {
    confidence -= 0.15; // some noise
  }

  return Math.max(0, Math.min(1, confidence));
}

export function extractChatGPT(): ExtractionResult | null {
  // Try the new UI selector first
  let roleElements = document.querySelectorAll("[data-turn]");
  
  // Fall back to the old UI selector if the new one isn't found
  if (roleElements.length === 0) {
    roleElements = document.querySelectorAll("[data-message-author-role]");
  }

  if (roleElements.length === 0) {
    return null;
  }

  const messages: Message[] = [];
  let skippedRoles = 0;     // tool, system, unknown roles
  let skippedIntegrity = 0;  // empty, garbage, single-char

  for (const el of Array.from(roleElements)) {
    const role = parseRole(el);

    if (role === null) {
      skippedRoles++;
      continue;
    }

    const content = extractContent(el);

    if (!isIntegrousContent(content)) {
      skippedIntegrity++;
      continue;
    }

    messages.push({ role, content });
  }

  if (messages.length < 2) {
    return null;
  }

  const stats = computeStats(messages);
  const confidence = computeConfidence(
    roleElements.length,
    skippedRoles,
    skippedIntegrity,
    stats.userMessages > 0,
    stats.assistantMessages > 0,
  );

  // Build warnings based on skip analysis
  const warnings: string[] = [];
  const totalSkipped = skippedRoles + skippedIntegrity;
  const skipRatio = totalSkipped / roleElements.length;

  if (skippedRoles > 0) {
    warnings.push(`Skipped ${skippedRoles} non-conversation element(s) (tool/system roles).`);
  }
  if (skippedIntegrity > 0) {
    warnings.push(`Filtered ${skippedIntegrity} element(s) with empty/garbage content.`);
  }
  if (skipRatio > SKIP_RATIO_DEGRADED) {
    warnings.push(
      `High skip ratio (${(skipRatio * 100).toFixed(0)}%) — DOM structure may have changed.`,
    );
  }

  const meta: ExtractionMeta = {
    durationMs: 0,
    layerUsed: "precise",
    selectorVersion: SELECTOR_VERSION,
    source: "dom",
  };

  const diagnostics: DiagnosticData = {
    extractor: "chatgpt",
    confidence,
    warnings,
  };

  return { messages, stats, meta, diagnostics };
}
