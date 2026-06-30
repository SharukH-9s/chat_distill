/**
 * API Extractor (Layer 1).
 * Fetches conversation JSON from ChatGPT's backend API for saved chats.
 * Bypasses virtual scrolling by fetching all messages directly.
 * Returns null on failure, falling back to DOM extractors.
 */

import type { Message } from "@/types/chat";
import type {
  ExtractionResult,
  ExtractionStats,
  ExtractionMeta,
  DiagnosticData,
} from "@/types/extraction";
import { computeStats } from "@/shared/utils";

export const SELECTOR_VERSION = "chatgpt-api-v1";

// URL Pattern

/** Matches conversation IDs from both standard and Custom GPT URLs */
const SAVED_CHAT_RE = /chatgpt\.com\/(?:g\/[a-zA-Z0-9-]+\/)?c\/([a-zA-Z0-9-]{10,40})/i;

// ChatGPT API Response Shape

/**
 * A single part of a message's content.
 * May be a plain string (text) or an object (image, tool call, etc.).
 * We only keep string parts.
 */
type MessagePart = string | Record<string, unknown>;

interface ApiMessageContent {
  content_type: string;
  parts: MessagePart[];
}

interface ApiMessageAuthor {
  role: "user" | "assistant" | "system" | "tool";
}

interface ApiMessage {
  id: string;
  author: ApiMessageAuthor;
  content: ApiMessageContent;
  /** "finished_successfully" | "in_progress" | "abandoned" | etc. */
  status: string;
}

interface ApiNode {
  id: string;
  parent: string | null;
  children: string[];
  /** Null for the root sentinel node. */
  message: ApiMessage | null;
}

interface ApiConversationResponse {
  current_node: string;
  mapping: Record<string, ApiNode>;
}

// Helpers

/**
 * Extracts the conversation UUID from the current page URL.
 * Returns null if the URL is not a saved chat.
 */
function getConversationId(): string | null {
  const match = window.location.href.match(SAVED_CHAT_RE);
  return match ? match[1] : null;
}

/**
 * Walks the parent-pointer linked list from `current_node` up to the root,
 * then reverses the result to produce chronological order.
 *
 * This correctly handles branched conversations (where the user edited a
 * message and got multiple replies) — `current_node` always points to
 * the tip of the active branch.
 */
function walkBranch(
  mapping: Record<string, ApiNode>,
  currentNodeId: string,
): ApiNode[] {
  const branch: ApiNode[] = [];
  let cursor: string | null = currentNodeId;

  while (cursor !== null) {
    const current: ApiNode | undefined = mapping[cursor];
    if (!current) break;
    branch.push(current);
    cursor = current.parent;
  }

  return branch.reverse(); // root → leaf order
}

/**
 * Extracts clean text from a message's parts array.
 * Filters to string-only parts, skips images/tool-calls/code-interpreter results.
 * Returns null if no text content is found.
 */
function extractTextFromParts(parts: MessagePart[] | undefined): string | null {
  if (!Array.isArray(parts)) return null;
  const textParts = parts
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

/**
 * Returns true if a node's message should be included in the output.
 * Filters out system/tool messages and incomplete/abandoned turns.
 */
function isUsableMessage(node: ApiNode): boolean {
  const msg = node.message;
  if (msg === null || msg === undefined) return false;
  if (msg.author.role !== "user" && msg.author.role !== "assistant") return false;
  if (msg.status !== "finished_successfully") return false;
  // Guard: some message types (tool, code_interpreter) have no 'parts'
  if (!msg.content || !Array.isArray(msg.content.parts)) return false;
  return true;
}



// Auth

/**
 * Fetches the current user's access token from the NextAuth session endpoint.
 * This is the same call ChatGPT's frontend makes to get its bearer token.
 * Returns null if the user is not logged in or the request fails.
 */
async function getAccessToken(): Promise<string | null> {
  try {
    const response = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
    });
    if (!response.ok) return null;
    const session = await response.json() as { accessToken?: string };
    return session.accessToken ?? null;
  } catch {
    return null;
  }
}

// Main Extractor

export async function extractFromApi(): Promise<ExtractionResult | null> {
  // Only activate for saved chats
  const conversationId = getConversationId();
  if (conversationId === null) return null;

  // Get the session bearer token that ChatGPT's frontend uses for API calls.
  const accessToken = await getAccessToken();
  if (accessToken === null) {
    console.warn("[ChatDistill] API extractor: no access token — user may not be logged in");
    return null;
  }

  // Fetch the full conversation from the ChatGPT backend API.
  let data: ApiConversationResponse;
  try {
    const response = await fetch(
      `https://chatgpt.com/backend-api/conversation/${conversationId}`,
      {
        credentials: "include",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      console.warn(
        `[ChatDistill] API extractor: fetch failed with status ${response.status}`,
      );
      return null;
    }

    data = (await response.json()) as ApiConversationResponse;
  } catch (err) {
    console.warn("[ChatDistill] API extractor: network error", err);
    return null;
  }

  // Validate the response shape
  if (!data.mapping || !data.current_node) {
    console.warn("[ChatDistill] API extractor: unexpected response shape");
    return null;
  }

  // Walk the active branch from leaf → root → reverse
  const branch = walkBranch(data.mapping, data.current_node);

  const messages: Message[] = [];
  const warnings: string[] = [];

  for (const node of branch) {
    if (!isUsableMessage(node)) continue;

    const msg = node.message!;
    const text = extractTextFromParts(msg.content.parts);

    if (text === null) {
      // Message had no text content (image-only, etc.) — skip silently
      continue;
    }

    messages.push({
      role: msg.author.role as "user" | "assistant",
      content: text,
    });
  }

  if (messages.length < 2) return null;

  const stats = computeStats(messages);

  if (stats.userMessages === 0 || stats.assistantMessages === 0) {
    warnings.push("Only one role detected in API response — conversation may be incomplete.");
  }

  const meta: ExtractionMeta = {
    durationMs: 0, // overwritten by orchestrator
    layerUsed: "api",
    selectorVersion: SELECTOR_VERSION,
    source: "api",
  };

  const diagnostics: DiagnosticData = {
    extractor: "chatgpt-api",
    confidence: 0.99, // API data is ground truth — highest possible confidence
    warnings,
  };

  return { messages, stats, meta, diagnostics };
}
