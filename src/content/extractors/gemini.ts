/**
 * Gemini Extractor — Layer 2 (Precise)
 *
 * Uses Gemini-specific custom HTML elements for high-fidelity extraction.
 * Primary role anchors: <user-query> and <model-response> — Angular web components
 * whose tag names are tied to the component architecture and are highly stable.
 *
 * Architecture Notes:
 *   - User query text lives in the regular DOM: p.query-text-line elements
 *   - Model response text lives in the SHADOW DOM of <message-content>
 *     (Angular ViewEncapsulation.ShadowDom — accessible via element.shadowRoot)
 *   - .cdk-visually-hidden spans must be excluded (screen-reader labels only)
 *   - aria-busy="true" on .model-response-label-announcer signals streaming
 *
 * Scroll Pre-Pass:
 *   Gemini uses a load-on-scroll-up pattern (<infinite-scroller>). Older
 *   messages are only injected into the DOM when the user scrolls up to them.
 *   extractGemini() runs a MutationObserver scroll pre-pass before extraction
 *   to ensure the full conversation history is in the DOM.
 *
 * Extraction Contract:
 * - Stateless: no module-level state, no side effects beyond scroll pre-pass
 * - Scoped: reads DOM and shadow roots, never writes content
 * - Returns null on total failure (not partial junk)
 *
 * DOM Order Guarantee:
 *   document.querySelectorAll() returns elements in document order
 *   (depth-first tree traversal per DOM spec). Messages are therefore
 *   guaranteed to be in conversation order.
 */

import type { Message } from "@/types/chat";
import type {
  ExtractionResult,
  ExtractionMeta,
  DiagnosticData,
} from "@/types/extraction";
import { computeStats } from "@/shared/utils";

export const SELECTOR_VERSION = "gemini-v1";

// ─── Selectors ────────────────────────────────────────────────────────────────

/**
 * Primary role anchors — custom Angular web component tag names.
 * querySelectorAll returns these in document (conversation) order.
 */
const ROLE_SELECTOR = "user-query, model-response";

/**
 * Screen-reader-only elements injected by Angular CDK.
 * These contain labels like "Your message" / "Gemini's response" and must
 * be stripped from all text extraction paths.
 */
const VISUALLY_HIDDEN_SELECTOR = ".cdk-visually-hidden";

/**
 * The scrollable chat container. Used by the scroll pre-pass to trigger
 * loading of older messages.
 */
const SCROLL_CONTAINER_SELECTOR = "#chat-history";

// ─── Skip Ratio Thresholds ───────────────────────────────────────────────────

/**
 * skipRatio = skippedCandidates / totalCandidates
 *   < 0.1  → stable extraction
 *   0.1–0.3 → degraded (some noise or empty turns in the DOM)
 *   > 0.3  → likely DOM mismatch / structural change
 */
const SKIP_RATIO_STABLE   = 0.1;
const SKIP_RATIO_DEGRADED = 0.3;

// ─── Scroll Pre-Pass ─────────────────────────────────────────────────────────

/**
 * Time (ms) the DOM must be quiet (no new nodes inserted) before we consider
 * the conversation fully loaded.
 */
const SCROLL_STABILITY_MS = 700;

/**
 * Hard cap on how long the scroll pre-pass may run.
 * Must be well under GEMINI_EXTRACTION_TIMEOUT_MS set in index.ts.
 */
const SCROLL_MAX_WAIT_MS = 8_000;

interface ScrollPrePassResult {
  /** true if we believe the full conversation was loaded */
  loaded: boolean;
  /** true if we hit the hard time cap before DOM stabilised */
  timedOut: boolean;
  /** true if the scroll container element was not found at all */
  containerMissing: boolean;
}

/**
 * Scrolls the Gemini chat container to the top to trigger loading of all
 * older messages (Gemini uses a load-on-scroll-up pattern).
 *
 * Uses a MutationObserver to detect when new conversation nodes are injected.
 * Each batch of new nodes resets the stability timer and triggers another
 * scroll-to-top, propagating all the way back to turn 1.
 *
 * Resolves when:
 *   - DOM has been quiet for SCROLL_STABILITY_MS (loaded: true), OR
 *   - SCROLL_MAX_WAIT_MS has elapsed (timedOut: true)
 */
async function ensureAllMessagesLoaded(): Promise<ScrollPrePassResult> {
  const scroller = document.querySelector(
    SCROLL_CONTAINER_SELECTOR,
  ) as HTMLElement | null;

  if (!scroller) {
    return { loaded: false, timedOut: false, containerMissing: true };
  }

  // If already at top with no overflow, nothing to load.
  if (
    scroller.scrollTop === 0 &&
    scroller.scrollHeight <= scroller.clientHeight + 1
  ) {
    return { loaded: true, timedOut: false, containerMissing: false };
  }

  return new Promise((resolve) => {
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    function finish(loaded: boolean, timedOut: boolean): void {
      observer.disconnect();
      if (stabilityTimer !== null) clearTimeout(stabilityTimer);
      clearTimeout(hardCap);
      resolve({ loaded, timedOut, containerMissing: false });
    }

    // Hard cap: never block extraction indefinitely
    const hardCap = setTimeout(() => finish(false, true), SCROLL_MAX_WAIT_MS);

    function resetStabilityTimer(): void {
      if (stabilityTimer !== null) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => finish(true, false), SCROLL_STABILITY_MS);
    }

    // Watch for new conversation-container nodes injected at the top of the list.
    // subtree: false — we only care about direct children of the scroller being added,
    // not every DOM mutation inside each message (which would be noisy during render).
    const observer = new MutationObserver(() => {
      // New content arrived — scroll to top again to reveal even older messages
      scroller.scrollTop = 0;
      resetStabilityTimer();
    });

    observer.observe(scroller, { childList: true, subtree: false });

    // Trigger the initial scroll
    scroller.scrollTop = 0;

    // Bootstrap stability timer: if the initial scroll triggers no mutations
    // (conversation was already fully loaded), we resolve after SCROLL_STABILITY_MS.
    resetStabilityTimer();
  });
}

// ─── Content Extraction ───────────────────────────────────────────────────────

/**
 * Recursively serializes a shadow root (or element) into a Markdown-friendly
 * text string, preserving the natural reading order of the response.
 *
 * Special handling:
 *   - <img>  → Skipped entirely
 *   - <svg>  → Skipped entirely (SVG markup is not useful in Markdown)
 *   - <script>, <style> → Skipped
 *   - .cdk-visually-hidden → Skipped (screen-reader labels)
 *   - All other elements → Children recursed in DOM order
 *   - Text nodes → Emitted as-is
 */
function serializeShadowContent(root: Element | ShadowRoot): string {
  const parts: string[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text) parts.push(text);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    // Skip non-content elements and images
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "img") return;

    // Skip screen-reader-only spans (CDK visually-hidden labels)
    if (el.classList.contains("cdk-visually-hidden")) return;

    // Skip Adobe Express entrypoint buttons and specific injected styles
    if (el.matches('[class*="cc440d50ba-"]')) return;

    // Recurse into all other elements
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child);
  }

  return parts.join("").trim();
}

/**
 * Extracts text from a <user-query> element.
 * Text lives in p.query-text-line elements under .query-text in the regular DOM.
 * Multi-paragraph queries have multiple <p> elements — join them with double newlines.
 */
function extractUserContent(container: Element): string {
  const queryText = container.querySelector(".query-text");
  if (queryText) {
    const paragraphs = Array.from(
      queryText.querySelectorAll("p.query-text-line"),
    )
      .map((p) => p.textContent?.trim() ?? "")
      .filter((t) => t.length > 0);

    if (paragraphs.length > 0) return paragraphs.join("\n\n");
  }

  // Fallback: innerText of container with screen-reader labels removed
  return extractInnerTextExcludingHidden(container);
}

/**
 * Extracts text from a <model-response> element.
 *
 * Primary path: shadow root of <message-content>
 *   Angular's ViewEncapsulation.ShadowDom creates an open shadow root.
 *   Content scripts can access open shadow roots via element.shadowRoot.
 *
 * Secondary path: textContent of <structured-content-container>
 *   Future-proofing: if Google switches from ShadowDom to Emulated encapsulation.
 *
 * Streaming guard: if aria-busy="true" on .model-response-label-announcer,
 *   Gemini is still generating — return "" to signal skip.
 *
 * @returns extracted text, or "" if streaming / empty
 */
/**
 * Finds and clicks any collapsed "Show code" buttons inside a shadow root.
 * Returns true if at least one button was clicked.
 */
function expandShowCodeButtons(shadowRoot: ShadowRoot): boolean {
  let clickedAny = false;
  const buttons = shadowRoot.querySelectorAll("button");
  for (const btn of Array.from(buttons)) {
    const label = (btn.getAttribute("aria-label") ?? "").toLowerCase();
    const text = (btn.textContent ?? "").toLowerCase();

    // Match "Show code", "< >", or "code execution" button indicators
    const isShowCode =
      label.includes("show code") ||
      text.includes("show code") ||
      text.includes("< >") ||
      label.includes("< >");

    const isHideCode =
      label.includes("hide code") ||
      text.includes("hide code");

    const isAlreadyExpanded = btn.getAttribute("aria-expanded") === "true";

    if (isShowCode && !isHideCode && !isAlreadyExpanded) {
      btn.click();
      clickedAny = true;
    }
  }
  return clickedAny;
}

/**
 * Extracts text from a <model-response> element.
 *
 * Primary path: shadow root of <message-content>
 *   Angular's ViewEncapsulation.ShadowDom creates an open shadow root.
 *   Content scripts can access open shadow roots via element.shadowRoot.
 *
 * Secondary path: textContent of <structured-content-container>
 *   Future-proofing: if Google switches from ShadowDom to Emulated encapsulation.
 *
 * Streaming guard: if aria-busy="true" on .model-response-label-announcer,
 *   Gemini is still generating — return "" to signal skip.
 *
 * @returns extracted text, or "" if streaming / empty
 */
async function extractModelContent(
  container: Element,
  shadowMisses: { count: number },
): Promise<string> {
  // Streaming guard — aria-busy flips to "true" during token generation
  const announcer = container.querySelector(".model-response-label-announcer");
  if (announcer?.getAttribute("aria-busy") === "true") {
    return ""; // signals streaming to caller
  }

  // Primary path: shadow root
  const messageContent = container.querySelector("message-content");
  if (messageContent) {
    const shadowRoot = (
      messageContent as Element & { shadowRoot: ShadowRoot | null }
    ).shadowRoot;

    if (shadowRoot) {
      // Programmatically expand any collapsed "Show code" buttons inside the shadow DOM
      const clickedAny = expandShowCodeButtons(shadowRoot);
      if (clickedAny) {
        // Wait a short moment for the collapsed code elements to render in the DOM
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const text = serializeShadowContent(shadowRoot);
      if (text.length > 0) return text;
    } else {
      // No shadow root found — track for confidence penalty + warning
      shadowMisses.count++;

      // Fallback: try innerText directly (Emulated encapsulation)
      const directText = extractInnerTextExcludingHidden(messageContent);
      if (directText.length > 0) return directText;
    }
  }

  // Secondary path: structured-content-container wraps message-content
  const structured = container.querySelector(
    "structured-content-container, .model-response-text",
  );
  if (structured) {
    const text = extractInnerTextExcludingHidden(structured);
    if (text.length > 0) return text;
  }

  // Final fallback: innerText of entire container, hidden elements removed
  return extractInnerTextExcludingHidden(container);
}

/**
 * Returns clean text content of a container after removing visually hidden
 * screen-reader labels, scripts, styles, svgs, and injected extension elements.
 * Operates on a clone to avoid mutating the live DOM.
 */
function extractInnerTextExcludingHidden(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  clone.querySelectorAll(VISUALLY_HIDDEN_SELECTOR).forEach((el) => el.remove());
  clone.querySelectorAll("style, script, svg, [class*=\"cc440d50ba-\"]").forEach((el) => el.remove());
  return clone.textContent?.trim() ?? "";
}

// ─── Role Parsing ─────────────────────────────────────────────────────────────

/**
 * Maps a Gemini custom element tag name to our typed role.
 * Returns null for any unknown element that slipped into the selector result.
 */
function parseRole(el: Element): "user" | "assistant" | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "user-query") return "user";
  if (tag === "model-response") return "assistant";
  return null;
}

// ─── Content Integrity ───────────────────────────────────────────────────────

/**
 * Minimal garbage strings that might leak through the targeted extraction paths
 * (primarily via the innerText fallback).
 */
const GARBAGE_STRINGS = new Set([
  "[object Object]",
  "...",
  "…",
  // CDK labels — should already be removed by extractInnerTextExcludingHidden,
  // but guard in case the visually-hidden class name changes.
  "Your message",
  "Gemini's response",
  "Gemini",
]);

/**
 * Returns true if a content string represents a real message.
 */
function isIntegrousContent(content: string): boolean {
  if (content.length === 0) return false;
  if (content.length < 3) return false; // single-char / two-char artifacts
  if (GARBAGE_STRINGS.has(content)) return false;
  return true;
}

// ─── Confidence Scoring ───────────────────────────────────────────────────────

/**
 * Signal-based confidence scoring for Gemini DOM extraction.
 * Baseline is 0.90 (lower than ChatGPT's 0.95 because we have no API fallback).
 */
function computeConfidence(
  totalCandidates: number,
  skippedRoles: number,
  skippedIntegrity: number,
  hasUserMessages: boolean,
  hasAssistantMessages: boolean,
  shadowMisses: number,
): number {
  if (totalCandidates === 0) return 0;

  let confidence = 0.9; // baseline for Gemini precise extractor

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

  // Degrade if shadow root was inaccessible (used fallback extraction)
  if (shadowMisses > 0) {
    confidence -= 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

// ─── Main Extractor ───────────────────────────────────────────────────────────

/**
 * Extracts a full conversation from a Gemini page.
 *
 * Runs a scroll pre-pass first to ensure all lazy-loaded messages are in
 * the DOM (Gemini uses load-on-scroll-up via <infinite-scroller>).
 *
 * @returns ExtractionResult on success, null if fewer than 2 messages found.
 */
export async function extractGemini(): Promise<ExtractionResult | null> {
  // ── Step 1: Scroll pre-pass ───────────────────────────────────────────────
  const prePass = await ensureAllMessagesLoaded();

  // ── Step 2: Select all role elements in DOM order ─────────────────────────
  const roleElements = document.querySelectorAll(ROLE_SELECTOR);

  if (roleElements.length === 0) {
    return null;
  }

  // ── Step 3: Extract messages ──────────────────────────────────────────────
  const messages: Message[] = [];
  let skippedRoles      = 0;
  let skippedIntegrity  = 0;
  let skippedStreaming   = 0;
  const shadowMisses    = { count: 0 }; // passed by ref to extractModelContent

  for (const el of Array.from(roleElements)) {
    const role = parseRole(el);
    if (role === null) {
      skippedRoles++;
      continue;
    }

    const content =
      role === "user"
        ? extractUserContent(el)
        : await extractModelContent(el, shadowMisses);

    // Empty assistant content signals streaming-in-progress — skip the turn
    if (content === "" && role === "assistant") {
      skippedStreaming++;
      continue;
    }

    if (!isIntegrousContent(content)) {
      skippedIntegrity++;
      continue;
    }

    messages.push({ role, content });
  }

  if (messages.length < 2) {
    return null;
  }

  // ── Step 4: Build result ──────────────────────────────────────────────────
  const stats = computeStats(messages);

  const confidence = computeConfidence(
    roleElements.length,
    skippedRoles,
    skippedIntegrity,
    stats.userMessages > 0,
    stats.assistantMessages > 0,
    shadowMisses.count,
  );

  const warnings: string[] = [];
  const totalSkipped = skippedRoles + skippedIntegrity;
  const skipRatio = totalSkipped / roleElements.length;

  if (skippedRoles > 0) {
    warnings.push(
      `Skipped ${skippedRoles} unknown element(s) (unexpected tag inside role selector).`,
    );
  }
  if (skippedIntegrity > 0) {
    warnings.push(
      `Filtered ${skippedIntegrity} element(s) with empty or garbage content.`,
    );
  }
  if (skippedStreaming > 0) {
    warnings.push(
      `Skipped ${skippedStreaming} assistant turn(s) — Gemini was still generating.`,
    );
  }
  if (skipRatio > SKIP_RATIO_DEGRADED) {
    warnings.push(
      `High skip ratio (${(skipRatio * 100).toFixed(0)}%) — DOM structure may have changed.`,
    );
  }
  if (shadowMisses.count > 0) {
    warnings.push(
      `Shadow root inaccessible on ${shadowMisses.count} <message-content> element(s) — used fallback extraction. Output may be lower quality.`,
    );
  }

  // Scroll pre-pass outcome
  if (prePass.containerMissing) {
    warnings.push(
      `Scroll pre-pass skipped — chat container ("${SCROLL_CONTAINER_SELECTOR}") not found. Older messages may be missing.`,
    );
  } else if (prePass.timedOut) {
    warnings.push(
      `Scroll pre-pass timed out after ${SCROLL_MAX_WAIT_MS / 1000}s — conversation may be incomplete (${messages.length} turns captured).`,
    );
  }

  const meta: ExtractionMeta = {
    durationMs: 0, // stamped by buildMeta() in index.ts
    layerUsed: "precise",
    selectorVersion: SELECTOR_VERSION,
    source: "dom",
  };

  const diagnostics: DiagnosticData = {
    extractor: "gemini",
    confidence,
    warnings,
  };

  return { messages, stats, meta, diagnostics };
}
