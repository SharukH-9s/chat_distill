/**
 * Content Script Entry Point.
 * Coordinates the extraction cascade, normalizes, validates, and
 * returns the result to the popup via chrome.runtime.sendMessage.
 */

import type { ExtractionResult, ExtractionMeta } from "@/types/extraction";
import type {
  RuntimeMessage,
  ExtractChatSuccess,
  ExtractChatError,
  PingResponse,
} from "@/types/messages";

import { extractFromApi, SELECTOR_VERSION as API_VERSION } from "./extractors/chatgpt-api";
import { extractChatGPT, SELECTOR_VERSION as CHATGPT_VERSION } from "./extractors/chatgpt";
import { extractGemini, SELECTOR_VERSION as GEMINI_VERSION } from "./extractors/gemini";
import { normalizeMessages } from "./normalizer";
import { validate } from "./validator";
import { generateDomSkeleton } from "./skeletonizer";

// Constants

/** Default extraction timeout for ChatGPT (fast cascade, no scroll pre-pass). */
const EXTRACTION_TIMEOUT_MS = 5000;

/**
 * Extended timeout for Gemini. Includes up to 8s for the scroll pre-pass
 * (ensureAllMessagesLoaded) plus time for DOM extraction itself.
 */
const GEMINI_EXTRACTION_TIMEOUT_MS = 15_000;

// Helpers

/**
 * Wraps an extractor function in a Promise.race timeout guard.
 * Accepts both synchronous and async extractor functions.
 */
function withTimeout<T>(fn: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Extraction timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/** Stamps final timing metadata onto a completed extraction result. */
function buildMeta(
  startTime: number,
  result: ExtractionResult,
  selectorVersion: string,
): ExtractionMeta {
  return {
    durationMs: Date.now() - startTime,
    layerUsed: result.meta.layerUsed,
    selectorVersion,
    source: result.meta.source,
  };
}

// Cascade

/**
 * Runs a platform-specific extraction cascade.
 *
 * Gemini cascade (gemini.google.com):
 *   Layer 1 → Gemini precise DOM extractor (shadow DOM + scroll pre-pass)
 *
 * ChatGPT cascade (chatgpt.com):
 *   Layer 1 → ChatGPT backend API (full fidelity, bypasses virtual scroll)
 *   Layer 2 → ChatGPT precise DOM selectors
 *
 * Each extractor is wrapped in a platform-appropriate timeout guard.
 * Raw output is normalised before being returned.
 */
async function runCascade(): Promise<ExtractionResult | null> {
  const isGemini = window.location.hostname === "gemini.google.com";

  type Layer = {
    fn: () => Promise<ExtractionResult | null> | ExtractionResult | null;
    version: string;
    timeoutMs: number;
  };

  // Gemini gets a larger per-layer budget because extractGemini() runs an async
  // scroll pre-pass (up to 8s) before DOM extraction begins.
  const layers: Layer[] = isGemini
    ? [
        { fn: extractGemini,  version: GEMINI_VERSION,  timeoutMs: GEMINI_EXTRACTION_TIMEOUT_MS },
      ]
    : [
        { fn: extractFromApi, version: API_VERSION,     timeoutMs: EXTRACTION_TIMEOUT_MS },
        { fn: extractChatGPT, version: CHATGPT_VERSION, timeoutMs: EXTRACTION_TIMEOUT_MS },
      ];

  for (const { fn, version, timeoutMs } of layers) {
    let raw: ExtractionResult | null = null;

    try {
      raw = await withTimeout(fn, timeoutMs);
    } catch (err) {
      console.warn(`[ChatDistill] Extractor "${version}" failed:`, err);
      continue;
    }

    if (raw === null) continue;

    // Normalize: strip invisible chars, streaming artifacts, duplicates
    const normalizedMessages = normalizeMessages(raw.messages, raw.meta.source);
    if (normalizedMessages.length === 0) continue;

    return {
      ...raw,
      messages: normalizedMessages,
      meta: { ...raw.meta, selectorVersion: version },
    };
  }

  return null;
}

// ─── Empty Page Detection ────────────────────────────────────────────────────

/**
 * Returns true when the current page URL indicates the user is on a platform
 * home/new-chat page rather than inside an open conversation.
 *
 * ChatGPT conversation URLs: chatgpt.com/c/<uuid>
 * Gemini conversation URLs:  gemini.google.com/app (or /app/<id>)
 *
 * Returning true does NOT mean the DOM changed — it means there is simply
 * no conversation loaded yet. We show a helpful prompt instead of a bug report.
 */
function isEmptyPage(): boolean {
  const { hostname, pathname } = window.location;
  if (hostname === "chatgpt.com") {
    return !pathname.startsWith("/c/");
  }
  if (hostname === "gemini.google.com") {
    const isAppChat = pathname.startsWith("/app/") && pathname.length > 5;
    return !isAppChat;
  }
  return false;
}

// Message Listener

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "PING") {
      const response: PingResponse = { type: "PONG" };
      sendResponse(response);
      return false; // synchronous — no need to keep channel open
    }

    if (message.type === "EXTRACT_CHAT") {
      const startTime = Date.now();

      runCascade()
        .then((result) => {
          if (result === null) {
            // Fast path: user is on a home/new-chat page — not a bug, just no conversation.
            if (isEmptyPage()) {
              const isGemini = window.location.hostname === "gemini.google.com";
              const platformName = isGemini ? "Gemini" : "ChatGPT";
              const err: ExtractChatError = {
                type: "EXTRACT_CHAT_RESULT",
                ok: false,
                error: `No conversation is open. Please navigate to a chat in ${platformName} and try again.`,
                diagnostics: {
                  extractor: isGemini ? "gemini" : "chatgpt",
                  confidence: 0,
                  warnings: [],
                },
                emptyPage: true,
              };
              sendResponse(err);
              return;
            }

            // Generate a privacy-safe DOM skeleton for the bug report.
            // Try platform-specific roots first for the most informative skeleton.
            const skeletonRoot =
              document.querySelector("chat-window") ??          // ChatGPT
              document.querySelector("#chat-history") ??        // Gemini scrollable container
              document.querySelector("infinite-scroller") ??    // Gemini outer wrapper
              document.querySelector("main") ??
              document.querySelector("[role='main']") ??
              document.body;
            let skeleton: string | undefined;
            try {
              skeleton = generateDomSkeleton(skeletonRoot);
            } catch (skelErr) {
              console.warn("[ChatDistill] Skeletonizer failed:", skelErr);
            }

            const err: ExtractChatError = {
              type: "EXTRACT_CHAT_RESULT",
              ok: false,
              error: "All extraction layers failed. The page DOM may be unsupported.",
              diagnostics: {
                extractor: "cascade",
                confidence: 0,
                warnings: ["All extraction layers returned null or empty results."],
              },
              skeleton,
            };
            sendResponse(err);
            return;
          }

          // Validate the normalized messages
          const validation = validate(result.messages);
          if (!validation.valid) {
            const err: ExtractChatError = {
              type: "EXTRACT_CHAT_RESULT",
              ok: false,
              error: [
                ...validation.errors.structural,
                ...validation.errors.semantic,
              ].join(" | "),
              validationErrors: validation.errors,
            };
            sendResponse(err);
            return;
          }

          // Success — attach final timing metadata
          const finalResult: ExtractionResult = {
            ...result,
            meta: buildMeta(startTime, result, result.meta.selectorVersion),
          };

          const success: ExtractChatSuccess = {
            type: "EXTRACT_CHAT_RESULT",
            ok: true,
            payload: finalResult,
          };
          sendResponse(success);
        })
        .catch((err: unknown) => {
          const errorMsg =
            err instanceof Error ? err.message : "Unknown extraction error";
          const response: ExtractChatError = {
            type: "EXTRACT_CHAT_RESULT",
            ok: false,
            error: errorMsg,
          };
          sendResponse(response);
        });

      return true; // keep channel open for async response
    }
  },
);
