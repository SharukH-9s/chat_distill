/**
 * ChatDistill — Popup UI
 *
 * State is a typed discriminated union (PopupState).
 * setState() is the single entry point for all state changes.
 * render() is the ONLY place that writes to the DOM.
 * Side effects (messaging) are triggered AFTER setState, never inside render().
 * The `cancelled` state drains stale async responses when the popup is torn down.
 */

import type { DiagnosticData, ExtractionResult, ValidationResult } from "../types/extraction";
import type { Conversation } from "../types/chat";
import type {
  ExtractChatResponse,
  ExportMarkdownResponse,
  PingResponse,
} from "../types/messages";
import {
  detectPlatform,
  LARGE_CONVERSATION_THRESHOLD,
  EXTRACT_TIMEOUT_MS,
  PING_TIMEOUT_MS,
} from "../shared/constants";
import { getIsExporting } from "../storage/client";

// ─── State ────────────────────────────────────────────────────────────────────

export type PopupState =
  | { status: "idle" }
  | { status: "extracting" }
  | { status: "preview"; result: Readonly<ExtractionResult> }
  | { status: "processing"; result: Readonly<ExtractionResult> }
  | { status: "processing_pdf"; result: Readonly<ExtractionResult> }
  | { status: "processing_bg" }
  | { status: "success"; filename: string }
  | { status: "cancelled" }
  | { status: "extraction_error"; message: string; diagnostics: DiagnosticData; skeleton?: string; emptyPage?: boolean }
  | { status: "validation_error"; errors: ValidationResult["errors"] }
  | { status: "api_error"; message: string; result: Readonly<ExtractionResult>; target: "markdown" | "pdf" };

let state: PopupState = { status: "idle" };

export function getState(): Readonly<PopupState> {
  return state;
}

/**
 * Sets the new state, renders the UI, then fires any async side effects.
 * This is the single entry point for all state changes in the popup.
 */
function setState(next: PopupState): void {
  state = next;
  render(state);

  if (next.status === "extracting") {
    void runExtraction();
  }
  if (next.status === "processing") {
    void runExport(next.result);
  }
  if (next.status === "processing_pdf") {
    void runExportPdf(next.result);
  }
}

// ─── Render Dispatcher ────────────────────────────────────────────────────────

const app = document.getElementById("app")!;

function render(s: PopupState): void {
  switch (s.status) {
    case "idle":            return renderIdle();
    case "extracting":      return renderExtracting();
    case "preview":         return renderPreview(s.result);
    case "processing":      return renderProcessing("Markdown");
    case "processing_pdf":  return renderProcessing("PDF summary");
    case "processing_bg":   return renderProcessing("in background");
    case "success":         return renderSuccess(s.filename);
    case "cancelled":       return; // drain state — no UI needed
    case "extraction_error": return renderExtractionError(s.message, s.diagnostics, s.skeleton, s.emptyPage);
    case "validation_error": return renderValidationError(s.errors);
    case "api_error":       return renderApiError(s.message, s.target);
  }
}

// ─── Shared UI Helpers ────────────────────────────────────────────────────────

function buildHeader(): string {
  return `
    <header class="popup-header">
      <div class="popup-logo">
        <div class="popup-logo-icon" aria-hidden="true">⚗</div>
        <span class="popup-logo-name">ChatDistill</span>
      </div>
      <button class="popup-settings-btn" id="btn-settings" title="Settings" aria-label="Open settings">⚙</button>
    </header>
  `;
}

function setView(bodyHtml: string): void {
  app.innerHTML = `
    ${buildHeader()}
    <div class="popup-body">${bodyHtml}</div>
  `;
  app.querySelector<HTMLButtonElement>('#btn-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function getPlatformInfo(): { name: string; supported: boolean } {
  const url = app.dataset.tabUrl ?? '';
  const match = detectPlatform(url);
  if (match) return { name: match.config.name, supported: match.config.supported };
  return { name: 'Unknown page', supported: false };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── View Builders ────────────────────────────────────────────────────────────

function renderIdle(): void {
  const { name, supported } = getPlatformInfo();
  const badgeClass = supported ? 'platform-badge' : 'platform-badge unsupported';
  const dotClass = supported ? 'platform-dot' : 'platform-dot unsupported';

  setView(`
    <div class="idle-view">
      <div>
        <span class="${badgeClass}">
          <span class="${dotClass}"></span>
          ${name}
        </span>
      </div>

      ${supported
      ? `<button class="btn-primary" id="btn-extract">Extract this conversation</button>
           <p class="idle-hint">Opens a preview before sending to Gemini</p>`
      : `<button class="btn-primary" id="btn-extract" disabled>Extract this conversation</button>
           <p class="idle-unsupported-msg">Navigate to a supported AI chat first</p>`
    }
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-extract')?.addEventListener('click', () => {
    setState({ status: 'extracting' });
  });
}

function renderExtracting(): void {
  setView(`
    <div class="loading-view">
      <div class="spinner" aria-hidden="true"></div>
      <span class="loading-label">Reading conversation…</span>
    </div>
  `);
}

function renderPreview(result: Readonly<ExtractionResult>): void {
  const { stats, meta, messages } = result;
  const layerLabel = meta.layerUsed === 'api' ? '⚡ API' : '🔬 Precise';
  const layerClass = 'layer-badge precise';
  const showWarning = stats.charCount > LARGE_CONVERSATION_THRESHOLD;

  const sampleMessages = messages.slice(0, 3).map((m) => {
    const roleLabel = m.role === 'user' ? 'You' : 'Assistant';
    const roleClass = m.role === 'user' ? 'user' : 'asst';
    const text = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content;
    return `
      <div class="message-item">
        <div class="message-role ${roleClass}">${roleLabel}</div>
        <div class="message-text">${escapeHtml(text)}</div>
      </div>
    `;
  }).join('');

  const remainingCount = messages.length - 3;
  const moreRow = remainingCount > 0
    ? `<div class="message-more">+ ${remainingCount} more message${remainingCount === 1 ? '' : 's'}</div>`
    : '';

  setView(`
    <div class="preview-view">
      <div class="stats-bar">
        <div class="stat-cell">
          <div class="stat-value">${stats.messageCount}</div>
          <div class="stat-label">Messages</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">${fmtChars(stats.charCount)}</div>
          <div class="stat-label">Chars</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">${stats.userMessages}</div>
          <div class="stat-label">You</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">${stats.assistantMessages}</div>
          <div class="stat-label">AI</div>
        </div>
      </div>

      <div class="preview-meta-row">
        <span class="${layerClass}">${layerLabel}</span>
      </div>

      <div class="message-sample" aria-label="Conversation preview">
        ${sampleMessages}
        ${moreRow}
      </div>

      ${showWarning ? `
        <div class="warning-banner" role="alert">
          <span class="warning-banner-icon">⚠️</span>
          <span>Large conversation — Gemini may truncate. Consider exporting in sections.</span>
        </div>
      ` : ''}

      <div class="btn-col">
        <button class="btn-primary" id="btn-export">Export to Markdown</button>
        <button class="btn-secondary" id="btn-export-pdf" style="margin-top: 8px;">Summarize &amp; Export PDF</button>
      </div>
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-export')?.addEventListener('click', () => {
    setState({ status: 'processing', result });
  });
  app.querySelector<HTMLButtonElement>('#btn-export-pdf')?.addEventListener('click', () => {
    setState({ status: 'processing_pdf', result });
  });
}

function renderProcessing(formatLabel: string): void {
  setView(`
    <div class="loading-view">
      <div class="spinner" aria-hidden="true"></div>
      <span class="loading-label" id="processing-label">Sending to Gemini…</span>
      <span class="loading-sublabel">This usually takes 5–15 seconds</span>
      <button class="btn-ghost processing-cancel-btn" id="btn-cancel-processing">Cancel</button>
    </div>
  `);

  // Cosmetic label swap after 2s
  setTimeout(() => {
    const el = app.querySelector<HTMLElement>('#processing-label');
    if (el) el.textContent = `Generating ${formatLabel}…`;
  }, 2000);

  app.querySelector<HTMLButtonElement>('#btn-cancel-processing')?.addEventListener('click', () => {
    setState({ status: 'cancelled' });
    setState({ status: 'idle' });
  });
}

function renderSuccess(filename: string): void {
  setView(`
    <div class="success-view">
      <div class="success-icon" aria-hidden="true">✅</div>
      <div class="success-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
      <p class="success-sub">Saved to your Downloads folder</p>
      <button class="btn-primary" id="btn-another">Export Another</button>
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-another')?.addEventListener('click', () => {
    setState({ status: 'extracting' });
  });
}

function renderExtractionError(message: string, diagnostics: DiagnosticData, skeleton?: string, emptyPage?: boolean): void {
  if (emptyPage) {
    setView(`
      <div class="error-view">
        <div class="error-header">
          <span class="error-icon" aria-hidden="true" style="filter: none; opacity: 1;">ℹ️</span>
          <div>
            <div class="error-title">No conversation found</div>
            <div class="error-message">${escapeHtml(message)}</div>
          </div>
        </div>
      </div>
    `);
    return;
  }

  const warningRows = diagnostics.warnings.length > 0
    ? `<ul class="diag-warnings">${diagnostics.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '<p class="diag-row" style="font-style:italic">No warnings recorded.</p>';

  const hasReport = !!skeleton;
  const { name: platformName } = getPlatformInfo();

  setView(`
    <div class="error-view">
      <div class="error-header">
        <span class="error-icon" aria-hidden="true">⚠️</span>
        <div>
          <div class="error-title">Could not read this conversation</div>
          <div class="error-message">${escapeHtml(message)}</div>
        </div>
      </div>

      <details class="diagnostics">
        <summary>Diagnostic info</summary>
        <div class="diagnostics-body">
          <div class="diag-row">Extractor: <span>${escapeHtml(diagnostics.extractor)}</span></div>
          <div class="diag-row">Confidence: <span>${Math.round(diagnostics.confidence * 100)}%</span></div>
          ${warningRows}
        </div>
      </details>

      ${hasReport ? `
      <div class="report-actions">
        <p class="report-hint">${platformName} may have updated its UI. Help us fix it by submitting a report — your message content is never included.</p>
        <div class="report-buttons">
          <button class="btn-report-copy" id="btn-copy-report" title="Copy privacy-safe debug report to clipboard">
            <span class="report-btn-icon" aria-hidden="true">📋</span> Copy Report
          </button>
          <button class="btn-report-github" id="btn-github-report" title="Open pre-filled GitHub issue">
            <span class="report-btn-icon" aria-hidden="true">🐛</span> Report on GitHub
          </button>
        </div>
        <div class="report-feedback" id="report-feedback" aria-live="polite"></div>
      </div>` : ''}

      <button class="btn-primary" id="btn-retry">Try Again</button>
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-retry')?.addEventListener('click', () => {
    setState({ status: 'idle' });
  });

  if (!hasReport) return;

  function buildReport(): string {
    const ts = new Date().toISOString();
    return [
      `## ChatDistill Extraction Failure Report`,
      ``,
      `**Timestamp:** ${ts}`,
      `**Extractor:** ${diagnostics.extractor}`,
      `**Confidence:** ${Math.round(diagnostics.confidence * 100)}%`,
      `**Error:** ${message}`,
      `**Warnings:**`,
      ...diagnostics.warnings.map(w => `  - ${w}`),
      ``,
      `### Privacy-Safe DOM Skeleton`,
      `\`\`\`html`,
      skeleton ?? '',
      `\`\`\``,
      ``,
      `> Generated by ChatDistill. No message content is included.`,
    ].join('\n');
  }

  async function copyReport(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(buildReport());
      return true;
    } catch {
      return false;
    }
  }

  function showFeedback(text: string, isError = false): void {
    const fb = app.querySelector<HTMLElement>('#report-feedback');
    if (!fb) return;
    fb.textContent = text;
    fb.className = `report-feedback ${isError ? 'report-feedback--error' : 'report-feedback--ok'}`;
    setTimeout(() => { fb.textContent = ''; fb.className = 'report-feedback'; }, 3000);
  }

  app.querySelector<HTMLButtonElement>('#btn-copy-report')?.addEventListener('click', async () => {
    const ok = await copyReport();
    showFeedback(ok ? '✓ Report copied to clipboard' : '✗ Could not access clipboard', !ok);
  });

  app.querySelector<HTMLButtonElement>('#btn-github-report')?.addEventListener('click', async () => {
    await copyReport();
    showFeedback('✓ Report copied — paste it into the issue below');
    const title = encodeURIComponent(`[Extraction Failure] ${platformName} DOM Changed`);
    const body = encodeURIComponent(
      `## Extraction Failure Report\n\n` +
      `I ran ChatDistill on ${platformName} and all extraction layers failed. The DOM skeleton report is below.\n\n` +
      `**Steps to reproduce:**\n` +
      `1. Open ${platformName}\n2. Open an existing conversation\n3. Click the ChatDistill extension icon\n4. Click Extract\n\n` +
      `**Debug report:**\n` +
      `_(Paste the copied report here with Ctrl+V / Cmd+V)_`
    );
    const url = `https://github.com/SharukH-9s/chat_distill/issues/new?title=${title}&body=${body}`;
    chrome.tabs.create({ url });
  });
}

function renderValidationError(errors: ValidationResult['errors']): void {
  const allErrors = [...errors.structural, ...errors.semantic];
  const errorItems = allErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('');

  setView(`
    <div class="error-view">
      <div class="error-header">
        <span class="error-icon" aria-hidden="true">⚠️</span>
        <div>
          <div class="error-title">Conversation didn't pass validation</div>
        </div>
      </div>

      <ul class="error-list">${errorItems}</ul>

      <button class="btn-primary" id="btn-retry">Try Again</button>
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-retry')?.addEventListener('click', () => {
    setState({ status: 'idle' });
  });
}

function renderApiError(message: string, target: "markdown" | "pdf"): void {
  setView(`
    <div class="error-view">
      <div class="error-header">
        <span class="error-icon" aria-hidden="true">❌</span>
        <div>
          <div class="error-title">Gemini API error</div>
          <div class="error-message">${escapeHtml(message)}</div>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn-ghost" id="btn-settings-err">Settings</button>
        <button class="btn-primary" id="btn-retry">Try Again</button>
      </div>
    </div>
  `);

  app.querySelector<HTMLButtonElement>('#btn-retry')?.addEventListener('click', () => {
    // Retry: re-run the export from the current api_error state which holds the result.
    // We need the frozen result — read it from state directly.
    const s = getState();
    if (s.status === 'api_error') {
      setState(target === 'markdown'
        ? { status: 'processing', result: s.result }
        : { status: 'processing_pdf', result: s.result });
    }
  });
  app.querySelector<HTMLButtonElement>('#btn-settings-err')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  window.addEventListener("unload", () => {
    setState({ status: "cancelled" });
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    app.dataset.tabUrl = tab?.url ?? "";
  } catch {
    app.dataset.tabUrl = "";
  }

  const isExporting = await getIsExporting(app.dataset.tabUrl ?? "");
  if (isExporting) {
    setState({ status: "processing_bg" });
    return;
  }

  render(state);
}

document.addEventListener("DOMContentLoaded", () => { void init(); });

// ─── Async Wiring ─────────────────────────────────────────────────────────────
//
// These functions are the ONLY callers of chrome.tabs/runtime.sendMessage.
// They are triggered as side effects of setState — never called from render().
// Both check getState() before applying any response to guard against stale callbacks.

/**
 * Sends PING → waits PING_TIMEOUT_MS → then sends EXTRACT_CHAT.
 * Runs validation inline and sets state directly to preview or validation_error.
 */
async function runExtraction(): Promise<void> {
  // 1. Resolve the active tab
  let tabId: number | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch (err) {
    console.warn("[ChatDistill] Could not query active tab:", err);
  }

  if (tabId === undefined) {
    if (getState().status === "cancelled") return;
    setState({
      status: "extraction_error",
      message: "Could not identify the active tab. Try closing and reopening the extension.",
      diagnostics: { extractor: "popup", confidence: 0, warnings: ["tab query returned no id"] },
    });
    return;
  }

  // 2. PING readiness check
  const pingAlive = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    chrome.tabs.sendMessage(tabId!, { type: "PING" }, (response: PingResponse | undefined) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(response?.type === "PONG");
    });
  });

  if (!pingAlive) {
    if (getState().status === "cancelled") return;
    setState({
      status: "extraction_error",
      message: "Extension is not active on this page — reload the page and try again.",
      diagnostics: { extractor: "ping", confidence: 0, warnings: ["PING timed out — content script may not be injected"] },
    });
    return;
  }

  // 3. Send EXTRACT_CHAT
  const response = await new Promise<ExtractChatResponse | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), EXTRACT_TIMEOUT_MS);
    chrome.tabs.sendMessage(
      tabId!,
      { type: "EXTRACT_CHAT" },
      (res: ExtractChatResponse | undefined) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res ?? null);
      },
    );
  });

  if (getState().status === "cancelled") return;

  // 4. Handle timeout
  if (response === null) {
    setState({
      status: "extraction_error",
      message: "Extraction timed out — the page may be too large or the extension unresponsive.",
      diagnostics: { extractor: "timeout", confidence: 0, warnings: [`No response within ${EXTRACT_TIMEOUT_MS}ms`] },
    });
    return;
  }

  // 5. Handle content script errors
  if (!response.ok) {
    if (response.validationErrors) {
      setState({ status: "validation_error", errors: response.validationErrors });
    } else {
      setState({
        status: "extraction_error",
        message: response.error,
        diagnostics: response.diagnostics ?? { extractor: "cascade", confidence: 0, warnings: [response.error] },
        skeleton: response.skeleton,
        emptyPage: response.emptyPage,
      });
    }
    return;
  }

  // 6. Success → go straight to preview (no validation flash-state)
  setState({ status: "preview", result: Object.freeze({ ...response.payload }) });
}

/**
 * Sends EXPORT_MARKDOWN to the service worker and applies the response.
 */
async function runExport(result: Readonly<ExtractionResult>): Promise<void> {
  const url = app.dataset.tabUrl ?? "";
  const platformMatch = detectPlatform(url);
  const platform = platformMatch?.platform ?? "chatgpt";

  const conversation: Conversation = {
    platform,
    messages: [...result.messages],
    url,
    title: undefined,
  };

  const response = await new Promise<ExportMarkdownResponse | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 120_000);
    chrome.runtime.sendMessage(
      { type: "EXPORT_MARKDOWN", payload: conversation },
      (res: ExportMarkdownResponse | undefined) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res ?? null);
      },
    );
  });

  if (getState().status === "cancelled") return;

  if (response === null) {
    setState({ status: "api_error", message: "Export timed out — the Gemini API did not respond within 120 seconds.", result, target: "markdown" });
    return;
  }

  if (response.ok) {
    setState({ status: "success", filename: response.filename });
  } else {
    setState({ status: "api_error", message: response.error, result, target: "markdown" });
  }
}

import type { ExportPdfResponse } from "../types/messages";

/**
 * Sends EXPORT_PDF to the service worker. The service worker delegates
 * rendering to the offscreen document, which downloads the file directly.
 * The popup can be safely closed at any point during this process.
 */
async function runExportPdf(result: Readonly<ExtractionResult>): Promise<void> {
  const url = app.dataset.tabUrl ?? "";
  const platformMatch = detectPlatform(url);
  const platform = platformMatch?.platform ?? "chatgpt";

  const conversation: Conversation = {
    platform,
    messages: [...result.messages],
    url,
    title: undefined,
  };

  const response = await new Promise<ExportPdfResponse | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 120_000);
    chrome.runtime.sendMessage(
      { type: "EXPORT_PDF", payload: conversation },
      (res: ExportPdfResponse | undefined) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res ?? null);
      },
    );
  });

  if (getState().status === "cancelled") return;

  if (response === null) {
    setState({ status: "api_error", message: "Export timed out — the Gemini API did not respond.", result, target: "pdf" });
    return;
  }

  if (response.ok) {
    setState({ status: "success", filename: response.filename });
  } else {
    setState({ status: "api_error", message: response.error, result, target: "pdf" });
  }
}

// Needed for TypeScript module mode (no implicit globals).
export type { Conversation };

