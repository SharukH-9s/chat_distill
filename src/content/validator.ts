/**
 * Validates the normalized message array.
 * Enforces structural and semantic rules.
 */

import type { Message } from "@/types/chat";
import type { ValidationResult } from "@/types/extraction";

// Constants

const MIN_MESSAGES = 2;
const MIN_TOTAL_CHARS = 100;
const MIN_ENTROPY = 2.0; // Shannon entropy threshold for repeating text. Shannon entropy is used as a mathematical measure of how diverse or "random" the characters in a string are. High entropy means the text has a rich, diverse set of characters, which is typical for natural human language. Low entropy means the text has a limited set of characters, which is typical for repetitive text.
const MIN_UNIQUE_CHARS = 8; // Minimum unique characters required in text

/** Common UI button labels in chat interfaces that might be scraped by accident. */
const UI_JUNK_LABELS = new Set([
  "copy",
  "share",
  "regenerate",
  "like",
  "dislike",
  "thumbs up",
  "thumbs down",
  "feedback",
  "edit",
  "stop generating",
  "new chat",
  "close",
  "open",
  "cancel",
  "submit",
  "send",
]);

// Shannon Entropy Helper

/**
 * Calculates Shannon entropy of a string.
 * Measures the diversity/randomness of characters.
 * Very low values (e.g. < 2.0) suggest highly repetitive text (e.g. "aaaa" or "...")
 */
function calculateEntropy(text: string): number {
  if (text.length === 0) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of text) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Main Validator

export function validate(messages: Message[]): ValidationResult {
  const structural: string[] = [];
  const semantic: string[] = [];

  // 1. Structural Validation

  // Check message count
  if (messages.length < MIN_MESSAGES) {
    structural.push(
      `Only ${messages.length} message(s) detected. A valid conversation must have at least ${MIN_MESSAGES} messages.`
    );
  }

  // Check roles presence
  let hasUser = false;
  let hasAssistant = false;
  let totalChars = 0;
  let emptyMessagesCount = 0;

  for (const msg of messages) { // each msg of messages array has role and content. 'timestamp' may be present or not depending on platform.
    if (msg.role === "user") hasUser = true;
    if (msg.role === "assistant") hasAssistant = true;

    const len = msg.content.trim().length;
    totalChars += len;
    if (len === 0) {
      emptyMessagesCount++;
    }
  }

  if (!hasUser) {
    structural.push("No user messages detected in the conversation.");
  }
  if (!hasAssistant) {
    structural.push("No assistant messages detected in the conversation.");
  }
  if (emptyMessagesCount > 0) {
    structural.push(`${emptyMessagesCount} empty message(s) detected after normalization.`);
  }

  // Check minimum total characters
  if (totalChars < MIN_TOTAL_CHARS) {
    structural.push(
      `Conversation content is too short (total character count of ${totalChars} is below the ${MIN_TOTAL_CHARS} character minimum).`
    );
  }

  // 2. Semantic Validation

  if (messages.length >= MIN_MESSAGES && totalChars >= MIN_TOTAL_CHARS) {
    const combinedText = messages.map((m) => m.content).join(" "); // concatenating all messages content in a single string.

    // Check character diversity (unique characters)
    const uniqueChars = new Set(combinedText.replace(/\s/g, "")); // removing all whitespace characters from the combined text and creating a set of unique characters.
    if (uniqueChars.size < MIN_UNIQUE_CHARS) {
      semantic.push(
        `Low character diversity: found only ${uniqueChars.size} unique character(s). Text may be highly repetitive.`
      );
    }

    // Check Shannon entropy (only on longer texts to avoid false positives on short valid chats)
    if (combinedText.length >= 50) {
      const entropy = calculateEntropy(combinedText);
      if (entropy < MIN_ENTROPY) {
        semantic.push(
          `Extracted text has extremely low information density (entropy: ${entropy.toFixed(2)}). It may contain garbage or repetitive characters.`
        );
      }
    }

    // Check if the conversation consists entirely or mostly of UI junk
    let junkMessages = 0;
    for (const msg of messages) {
      const cleanMsg = msg.content.trim().toLowerCase();
      if (UI_JUNK_LABELS.has(cleanMsg)) {
        junkMessages++;
      }
    }

    const junkRatio = junkMessages / messages.length;
    if (junkRatio >= 0.7) {
      semantic.push(
        `Scraped content appears to be mostly UI button text (e.g., Copy, Share, Regenerate). ${Math.round(
          junkRatio * 100
        )}% of messages are UI labels.`
      );
    }
  }

  const valid = structural.length === 0 && semantic.length === 0;

  return {
    valid,
    errors: {
      structural,
      semantic,
    },
  };
}
