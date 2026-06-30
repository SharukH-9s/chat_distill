/**
 * Normalization Layer
 *
 * Runs between raw extraction output and the validator.
 * Ensures every Message object contains only clean, consistent plain text.
 *
 * Pipeline position: Extractor → [Normalizer] → Validator → UI
 */

import type { Message } from "@/types/chat";

import type { ExtractionSource } from "@/types/extraction";

// Zero-width / invisible characters
const ZERO_WIDTH_RE =
  /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060]/g;

// Multiple consecutive newlines → max two
const EXCESSIVE_NEWLINES_RE = /\n{3,}/g;

// Streaming artifact threshold
// Minimum character count for the last assistant message to not be
// considered a mid-stream capture. Lowered from 20 → 5 to avoid
// silently dropping valid short answers (e.g. "Yes.", "No.", "Done.").
const STREAMING_ARTIFACT_MIN_CHARS = 5;

/**
 * Normalizes a single message's content string.
 * Removes HTML artefacts, zero-width characters, and excessive whitespace.
 */
function normalizeContent(raw: string): string {
  return raw
    .replace(ZERO_WIDTH_RE, "")          // strip invisible chars
    .replace(/\r\n/g, "\n")             // normalize CRLF → LF
    .replace(/\r/g, "\n")              // normalize stray CR
    .replace(EXCESSIVE_NEWLINES_RE, "\n\n") // collapse 3+ newlines
    .trim();
}

/**
 * Returns true if a message looks like a streaming artifact
 * (i.e., the assistant message was captured mid-generation).
 * Applied only to trailing assistant messages.
 */
function isStreamingArtifact(msg: Message): boolean {
  return (
    msg.role === "assistant" &&
    msg.content.length < STREAMING_ARTIFACT_MIN_CHARS
  );
}

/**
 * Normalizes a raw Message array returned by an extractor:
 * 1. Normalizes content (strips invisible chars, collapses whitespace)
 * 2. Removes empty messages
 * 3. Removes adjacent duplicates
 * 4. Strips trailing streaming artifacts (DOM source only — API results are always complete)
 */
export function normalizeMessages(
  raw: Message[],
  source: ExtractionSource = "dom", // default to "dom" for backward compatibility, but API extractions will explicitly pass "api" to disable streaming artifact stripping
): Message[] {
  // Step 1: Normalize content
  let msgs: Message[] = raw.map((msg) => ({
    ...msg,
    content: normalizeContent(msg.content),
  }));

  // Step 2: Remove empty messages
  msgs = msgs.filter((msg) => msg.content.length > 0);

  // Step 3: Remove adjacent duplicates (same role + same content)
  msgs = msgs.filter(
    (msg, i) =>
      i === 0 ||
      !(msg.role === msgs[i - 1].role && msg.content === msgs[i - 1].content),
  );

  // Step 4: Strip trailing streaming artifact (DOM only)
  // API source is always fully finished — never mid-stream.
  // DOM source may capture a short assistant reply that was still streaming.
  if (
    source === "dom" &&
    msgs.length > 0 &&
    isStreamingArtifact(msgs[msgs.length - 1])
  ) {
    msgs = msgs.slice(0, -1);
  }

  return msgs;
}
