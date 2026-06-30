/**
 * ChatDistill — Background Service Worker
 *
 * Handles all out-of-page logic: Gemini API calls, transcript formatting,
 * filename generation, and chrome.downloads integration.
 */

import type { Conversation } from "@/types/chat";
import type { ExportContext, GeminiRequest, GeminiResponse, GeminiError } from "@/types/api";
import type {
  ExportMarkdownMessage,
  ExportMarkdownSuccess,
  ExportMarkdownError,
  TestConnectionMessage,
  TestConnectionSuccess,
  TestConnectionError,
  RuntimeMessage,
} from "@/types/messages";
import { getApiKey, getPreferences, getActiveProfileId, setIsExporting } from "@/storage/client";
import { buildSystemPrompt, buildPdfSummaryPrompt, getProfileInstructions, PROMPT_VERSION } from "@/background/prompts";
import { downloadMarkdown } from "@/background/export";

// 3.2 — Transcript Formatting

/**
 * Formats a Conversation into a plain-text transcript for the LLM.
 * Includes a metadata header and prefixes messages with role labels.
 *
 * @param conversation - The Conversation from the content script.
 * @returns A plain-text string for the API request payload.
 */
export function formatTranscript(conversation: Conversation): string {
  const { platform, url, title, messages } = conversation;

  // Metadata header
  const headerLines: string[] = [
    `Platform: ${platform}`,
    `URL: ${url}`,
  ];
  if (title) {
    headerLines.push(`Title: ${title}`);
  }
  headerLines.push(`Messages: ${messages.length}`);

  const header = headerLines.join("\n");

  // Message blocks
  const body = messages
    .map((msg) => {
      const label = msg.role === "user" ? "[USER]:" : "[ASSISTANT]:";
      return `${label}\n${msg.content.trim()}`;
    })
    .join("\n\n");

  return `${header}\n\n${body}`;
}

// 3.3 — Gemini API Integration

// Typed error

/**
 * Typed error for all Gemini API failures.
 * Carries a user-facing message so the popup can display it directly.
 */
class GeminiAPIError extends Error {
  constructor(
    message: string,
    /** The HTTP status code, if applicable (0 for network errors). */
    public readonly status: number = 0,
  ) {
    super(message);
    this.name = "GeminiAPIError";
  }
}

/** Parses a failed Response into a human-readable GeminiAPIError */
async function parseGeminiError(response: Response, model?: string): Promise<GeminiAPIError> {
  let apiError: { error?: GeminiError } = {};
  try {
    apiError = await response.json();
  } catch {
    // response body wasn't parseable — fall through to generic error
  }

  const status = response.status;
  const apiStatus = apiError.error?.status ?? "";
  const apiMessage = apiError.error?.message ?? "";

  if (status === 400 && apiStatus === "API_KEY_INVALID") {
    return new GeminiAPIError("Invalid API key. Please check your key in Settings.", status);
  }
  if (status === 429) {
    return new GeminiAPIError("Rate limited by Gemini API. Please wait a moment and try again.", status);
  }
  if (status === 404) {
    return new GeminiAPIError(`Model '${model ?? "unknown"}' not found. Check your model selection in Settings.`, status);
  }
  if (status === 503) {
    return new GeminiAPIError("Gemini API is temporarily overloaded (503). Please wait a moment and try again.", status);
  }

  return new GeminiAPIError(`Gemini API error: ${status}${apiMessage ? ` — ${apiMessage}` : ""}`, status);
}

// Gemini API base URL

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// callGeminiAPI

/**
 * Sends a formatted transcript to Gemini for distillation.
 *
 * @returns The raw Markdown string on success.
 * @throws GeminiAPIError on failure.
 */
async function callGeminiAPI(
  context: ExportContext,
  apiKey: string,
  systemPrompt: string,
): Promise<string> {
  const { conversation, model } = context;
  const transcript = formatTranscript(conversation);

  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const body: GeminiRequest = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemPrompt },
          { text: "\n\n---\n\nHere is the conversation transcript:\n\n" + transcript },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,       // low temp → deterministic, structured output
      maxOutputTokens: 8192,
    },
  };

  // Network call
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch() itself threw — no internet, DNS failure, etc.
    throw new GeminiAPIError(
      "Network error — check your internet connection.",
    );
  }

  // HTTP error handling
  if (!response.ok) {
    throw await parseGeminiError(response, model);
  }

  // Parse successful response
  const data: GeminiResponse = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || text.trim().length === 0) {
    throw new GeminiAPIError(
      "Gemini returned an empty response. The conversation may be too short to distill.",
    );
  }

  return text;
}

// 4. Shared Export Pipeline

import type { ExportPdfMessage, ExportPdfSuccess, ExportPdfError } from "@/types/messages";

/**
 * Shared pipeline logic for both MD and PDF exports.
 * Orchestrates fetching state, compiling profiles, and hitting the API.
 */
async function runExportPipeline(
  payload: Conversation,
  mode: "md" | "pdf",
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("No API key configured. Go to Settings to add your Gemini API key.");
  }

  const prefs = await getPreferences();
  const profileId = await getActiveProfileId();

  const context: ExportContext = {
    conversation: payload,
    promptVersion: prefs.promptVersion ?? PROMPT_VERSION,
    model: prefs.model,
    timestamp: new Date().toISOString(),
    profileId,
  };

  const platformName = payload.platform.charAt(0).toUpperCase() + payload.platform.slice(1);
  const profileInstructions = getProfileInstructions(profileId, mode);

  const dateString = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const messageCount = payload.messages.length;

  const systemPrompt = mode === "md"
    ? buildSystemPrompt(platformName, profileInstructions, dateString, messageCount)
    : buildPdfSummaryPrompt(platformName, profileInstructions, dateString, messageCount);

  return await callGeminiAPI(context, apiKey, systemPrompt);
}

// handleExportMarkdown

async function handleExportMarkdown(
  payload: ExportMarkdownMessage["payload"],
): Promise<ExportMarkdownSuccess | ExportMarkdownError> {
  await setIsExporting(payload.url, true);
  try {
    const markdown = await runExportPipeline(payload, "md");
    const filename = await downloadMarkdown(markdown);
    return { type: "EXPORT_MARKDOWN_RESULT", ok: true, filename };
  } catch (err) {
    return {
      type: "EXPORT_MARKDOWN_RESULT",
      ok: false,
      error: err instanceof Error ? err.message : "An unexpected error occurred.",
    };
  } finally {
    await setIsExporting(payload.url, false);
  }
}

// handleExportPdf

import type { OffscreenPdfResponse } from "@/types/messages";

/** URL of the offscreen document — must match the file path exactly. */
const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

/**
 * Ensures exactly one offscreen document is open with the PDF renderer.
 * Chrome allows only one offscreen document per extension at a time.
 */
async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: "Render Markdown to PDF using html2pdf.js (requires DOM access).",
  });
}

async function handleExportPdf(
  payload: ExportPdfMessage["payload"],
): Promise<ExportPdfSuccess | ExportPdfError> {
  await setIsExporting(payload.url, true);
  try {
    const markdown = await runExportPipeline(payload, "pdf");

    // Derive filename (same convention as Markdown exports).
    const date = new Date().toISOString().split("T")[0];
    const filename = `chat-summary-${date}.pdf`;

    // Spin up the offscreen document (or reuse an existing one).
    await ensureOffscreenDocument();

    // Delegate PDF rendering + download to the offscreen document.
    const result = await new Promise<OffscreenPdfResponse>((resolve) => {
      chrome.runtime.sendMessage(
        { type: "GENERATE_PDF", markdown, filename },
        (res: OffscreenPdfResponse | undefined) => {
          if (chrome.runtime.lastError || !res) {
            resolve({
              type: "OFFSCREEN_PDF_RESULT",
              ok: false,
              error: chrome.runtime.lastError?.message ?? "Offscreen document did not respond.",
            });
          } else {
            resolve(res);
          }
        },
      );
    });

    // Close the offscreen document to free resources.
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // Already closed — harmless.
    }

    if (result.ok) {
      await chrome.downloads.download({
        url: result.dataUrl,
        filename,
        saveAs: false,
      });
      return { type: "EXPORT_PDF_RESULT", ok: true, filename: result.filename };
    } else {
      return { type: "EXPORT_PDF_RESULT", ok: false, error: result.error };
    }
  } catch (err) {
    return {
      type: "EXPORT_PDF_RESULT",
      ok: false,
      error: err instanceof Error ? err.message : "An unexpected error occurred.",
    };
  } finally {
    await setIsExporting(payload.url, false);
  }
}


// TEST_CONNECTION Handler

/**
 * Probes the Gemini API with a minimal 1-token request.
 * Used by the options page "Test Connection" button.
 * Cost: near-zero (maxOutputTokens: 1).
 */
async function handleTestConnection(
  message: TestConnectionMessage,
): Promise<TestConnectionSuccess | TestConnectionError> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      type: "TEST_CONNECTION_RESULT",
      ok: false,
      error: "No API key configured. Add your Gemini API key first.",
    };
  }

  const prefs = await getPreferences();
  const model = message.model ?? prefs.model;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const probeBody: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    generationConfig: { maxOutputTokens: 1 },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(probeBody),
    });
  } catch {
    return { type: "TEST_CONNECTION_RESULT", ok: false, error: "No network connection." };
  }

  if (!response.ok) {
    const geminiError = await parseGeminiError(response, model);
    return {
      type: "TEST_CONNECTION_RESULT",
      ok: false,
      error: geminiError.message,
    };
  }

  return { type: "TEST_CONNECTION_RESULT", ok: true, model };
}

// Message Listener

/**
 * Message listener for popup -> service worker communication.
 * Keeps the channel open for async responses.
 */
chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "EXPORT_MARKDOWN") {
      handleExportMarkdown(message.payload)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            type: "EXPORT_MARKDOWN_RESULT",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      return true;
    }

    if (message.type === "EXPORT_PDF") {
      handleExportPdf(message.payload)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            type: "EXPORT_PDF_RESULT",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      return true;
    }

    if (message.type === "TEST_CONNECTION") {
      handleTestConnection(message)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            type: "TEST_CONNECTION_RESULT",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      return true;
    }
  },
);
