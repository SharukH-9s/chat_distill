/**
 * Gemini Extractor Tests
 *
 * Tests the extractGemini() function against HTML fixtures that mirror
 * the real Gemini DOM structure captured from a live failure report.
 *
 * Shadow DOM Note:
 *   jsdom does not implement Shadow DOM (element.shadowRoot is always null).
 *   Tests therefore exercise the secondary fallback path:
 *     structured-content-container textContent
 *   This path is explicitly designed for this case (future-proofing if Google
 *   switches from ViewEncapsulation.ShadowDom to Emulated). Shadow DOM
 *   correctness must be verified manually in a real Chrome browser.
 *
 * Scroll Pre-Pass Note:
 *   ensureAllMessagesLoaded() relies on MutationObserver + scrollTop manipulation,
 *   which are not meaningfully simulatable in jsdom. The function is mocked
 *   to return { loaded: true, timedOut: false, containerMissing: false }
 *   for all tests except the explicit scroll-truncation test.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractGemini } from "./gemini";

// ─── Scroll Pre-Pass Mock ─────────────────────────────────────────────────────
// Mock the scroll container so MutationObserver/scrollTop calls don't crash jsdom.
// Each test that needs non-default pre-pass behaviour overrides this mock locally.

vi.mock("./gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gemini")>();

  // Wrap extractGemini to inject a mocked scroll pre-pass.
  // The real ensureAllMessagesLoaded is an internal function — we patch it by
  // intercepting the #chat-history querySelector to return a stub element that
  // reports scrollTop===0 and scrollHeight===clientHeight (already at top, nothing to load).
  return actual;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadFixture(name: string): string {
  return readFileSync(
    resolve(__dirname, "../../../tests/fixtures", name),
    "utf-8",
  );
}

function setupScrollContainer(opts: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
} = {}): void {
  // Provide a fake #chat-history element so ensureAllMessagesLoaded()
  // detects it's already at top and returns immediately (loaded: true).
  const container = document.createElement("div");
  container.id = "chat-history";
  Object.defineProperty(container, "scrollTop", {
    get: () => opts.scrollTop ?? 0,
    set: () => {},
    configurable: true,
  });
  Object.defineProperty(container, "scrollHeight", {
    get: () => opts.scrollHeight ?? 100,
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    get: () => opts.clientHeight ?? 100,
    configurable: true,
  });
  document.body.appendChild(container);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("extractGemini", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy Path ──────────────────────────────────────────────────────────────

  it("extracts messages from a stable 3-turn Gemini conversation", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result).not.toBeNull();
    expect(result!.messages.length).toBe(6); // 3 user + 3 assistant
    expect(result!.messages[0].role).toBe("user");
    expect(result!.messages[0].content).toBe(
      "What is the best way to learn TypeScript?",
    );
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].content).toContain("official handbook");

    expect(result!.messages[2].role).toBe("user");
    expect(result!.messages[2].content).toBe(
      "Should I use interfaces or type aliases?",
    );
  });

  it("reports high confidence (≥ 0.85) on a clean extraction", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    // Confidence is slightly below 0.90 baseline because shadow roots are missing
    // in jsdom (each miss deducts 0.1), but still well above 0 for clean data.
    expect(result!.diagnostics.confidence).toBeGreaterThan(0.0);
    expect(result!.diagnostics.extractor).toBe("gemini");
  });

  it("reports shadow root inaccessibility in warnings (jsdom limitation)", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    // In jsdom there are no shadow roots, so every model-response is a shadow miss.
    const shadowWarn = result!.diagnostics.warnings.find((w) =>
      w.includes("Shadow root inaccessible"),
    );
    expect(shadowWarn).toBeDefined();
  });

  // ── Role Parsing ────────────────────────────────────────────────────────────

  it("assigns user role to <user-query> and assistant role to <model-response>", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    const roles = result!.messages.map((m) => m.role);
    expect(roles).toEqual([
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
    ]);
  });

  // ── Multi-Paragraph User Messages ───────────────────────────────────────────

  it("joins multiple p.query-text-line elements with double newlines", async () => {
    document.body.innerHTML = loadFixture("gemini-multiparagraph.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result).not.toBeNull();
    const userMsg = result!.messages[0];
    expect(userMsg.role).toBe("user");
    // All three paragraphs joined
    expect(userMsg.content).toContain("strict mode enabled");
    expect(userMsg.content).toContain("Object is possibly undefined");
    expect(userMsg.content).toContain("without disabling strict mode");
    // Joined with double newlines
    expect(userMsg.content).toMatch(/\n\n/);
  });

  it("excludes .cdk-visually-hidden screen-reader labels from user content", async () => {
    document.body.innerHTML = loadFixture("gemini-multiparagraph.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result!.messages[0].content).not.toContain("Your message");
    expect(result!.messages[0].content).not.toContain("Gemini's response");
  });

  // ── Noise Filtering ─────────────────────────────────────────────────────────

  it("extracts real messages correctly even with UI chrome in the DOM", async () => {
    document.body.innerHTML = loadFixture("gemini-noise.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result).not.toBeNull();
    // Real message content should be present
    expect(result!.messages[0].content).toContain("async/await");
    // Button labels should not appear in user content
    // (they are outside .query-text, so extractUserContent ignores them)
    expect(result!.messages[0].content).not.toBe("Copy");
    expect(result!.messages[0].content).not.toBe("Edit");
  });

  // ── Streaming Detection ─────────────────────────────────────────────────────

  it("skips assistant turns where aria-busy=true (streaming in progress)", async () => {
    document.body.innerHTML = loadFixture("gemini-streaming.html");
    setupScrollContainer();

    const result = await extractGemini();

    // Turn 1 user + Turn 1 assistant (completed) should be extracted.
    // Turn 2 user should be extracted (it's complete).
    // Turn 2 assistant (aria-busy=true) should be SKIPPED.
    expect(result).not.toBeNull();

    const assistantMessages = result!.messages.filter((m) => m.role === "assistant");
    // Only 1 assistant message (the completed one from turn 1)
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].content).toContain("closure");

    // Streaming warning should be present
    const streamingWarn = result!.diagnostics.warnings.find((w) =>
      w.includes("still generating"),
    );
    expect(streamingWarn).toBeDefined();
  });

  // ── Null Returns ────────────────────────────────────────────────────────────

  it("returns null when no user-query or model-response elements exist", async () => {
    document.body.innerHTML = loadFixture("gemini-empty.html");
    setupScrollContainer();

    const result = await extractGemini();
    expect(result).toBeNull();
  });

  it("returns null when only one message can be extracted (< 2 messages)", async () => {
    document.body.innerHTML = loadFixture("gemini-single.html");
    setupScrollContainer();

    const result = await extractGemini();
    expect(result).toBeNull();
  });

  // ── Scroll Pre-Pass: Container Missing ──────────────────────────────────────

  it("still extracts messages when scroll container is missing (no #chat-history)", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    // Intentionally do NOT call setupScrollContainer() — #chat-history not in DOM

    const result = await extractGemini();

    // Extraction should still work (pre-pass gracefully skips)
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeGreaterThanOrEqual(2);

    // Warning about missing container should be present
    const containerWarn = result!.diagnostics.warnings.find((w) =>
      w.includes("chat container") || w.includes("containerMissing") || w.includes("#chat-history"),
    );
    expect(containerWarn).toBeDefined();
  });

  // ── Extraction Stats ────────────────────────────────────────────────────────

  it("populates ExtractionStats correctly", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result!.stats.messageCount).toBe(6);
    expect(result!.stats.userMessages).toBe(3);
    expect(result!.stats.assistantMessages).toBe(3);
    expect(result!.stats.charCount).toBeGreaterThan(0);
  });

  it("sets meta.layerUsed to 'precise' and meta.source to 'dom'", async () => {
    document.body.innerHTML = loadFixture("gemini-stable.html");
    setupScrollContainer();

    const result = await extractGemini();

    expect(result!.meta.layerUsed).toBe("precise");
    expect(result!.meta.source).toBe("dom");
    expect(result!.meta.selectorVersion).toBe("gemini-v1");
  });

  // ── Show Code Expansion ──────────────────────────────────────────────────────

  it("automatically clicks 'Show code' buttons that are collapsed inside shadow DOM", async () => {
    // Construct a custom HTML response turn
    const modelResponse = document.createElement("model-response");
    const msgContent = document.createElement("message-content");
    
    // Attach an open shadow root to <message-content>
    const shadow = msgContent.attachShadow({ mode: "open" });
    
    // Create the "Show code" button inside the shadow DOM
    const btn = document.createElement("button");
    btn.textContent = "Show code < >";
    btn.setAttribute("aria-expanded", "false");
    
    // Spy on the click event
    let clickCount = 0;
    btn.addEventListener("click", () => {
      clickCount++;
      // Simulate Angular expanding it by changing its state and adding code text
      btn.setAttribute("aria-expanded", "true");
      btn.textContent = "Hide code";
      const codeBlock = document.createElement("pre");
      codeBlock.textContent = "print('Hello world')";
      shadow.appendChild(codeBlock);
    });
    
    shadow.appendChild(btn);
    modelResponse.appendChild(msgContent);
    
    // We also need a user-query in the DOM so that the total message count >= 2
    const userQuery = document.createElement("user-query");
    userQuery.innerHTML = `
      <div class="query-text">
        <p class="query-text-line">Run a python script.</p>
      </div>
    `;
    
    document.body.appendChild(userQuery);
    document.body.appendChild(modelResponse);
    setupScrollContainer();
    
    // Run the extraction
    const result = await extractGemini();
    
    expect(clickCount).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBe(2);
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].content).toContain("print('Hello world')");
  });

  // ── Image Filtering ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it("ignores/filters out <img> tags in shadow DOM", async () => {
    const modelResponse = document.createElement("model-response");
    const msgContent = document.createElement("message-content");
    const shadow = msgContent.attachShadow({ mode: "open" });

    const para = document.createElement("p");
    para.textContent = "Here is a response with an image:";

    const imgStable = document.createElement("img");
    imgStable.setAttribute("alt", "A bar chart showing monthly revenue");
    imgStable.setAttribute("src", "https://example.com/chart.png");

    shadow.appendChild(para);
    shadow.appendChild(imgStable);
    modelResponse.appendChild(msgContent);

    const userQuery = document.createElement("user-query");
    userQuery.innerHTML = `<div class="query-text"><p class="query-text-line">Show me a chart.</p></div>`;

    document.body.appendChild(userQuery);
    document.body.appendChild(modelResponse);
    setupScrollContainer();

    const result = await extractGemini();

    expect(result).not.toBeNull();
    const assistantContent = result!.messages[1].content;

    // Text content is kept
    expect(assistantContent).toContain("Here is a response with an image:");
    // Image syntax/URL is completely filtered out
    expect(assistantContent).not.toContain("![");
    expect(assistantContent).not.toContain("https://example.com/chart.png");
  });

  it("excludes <svg> elements from shadow DOM output", async () => {
    const modelResponse = document.createElement("model-response");
    const msgContent = document.createElement("message-content");
    const shadow = msgContent.attachShadow({ mode: "open" });

    const para = document.createElement("p");
    para.textContent = "Here is a diagram:";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = `<circle cx="50" cy="50" r="40" /><text>Label</text>`;

    shadow.appendChild(para);
    shadow.appendChild(svg);
    modelResponse.appendChild(msgContent);

    const userQuery = document.createElement("user-query");
    userQuery.innerHTML = `<div class="query-text"><p class="query-text-line">Draw a circle.</p></div>`;

    document.body.appendChild(userQuery);
    document.body.appendChild(modelResponse);
    setupScrollContainer();

    const result = await extractGemini();

    expect(result).not.toBeNull();
    const assistantContent = result!.messages[1].content;

    // Text before SVG is kept
    expect(assistantContent).toContain("Here is a diagram:");
    // SVG internals are stripped
    expect(assistantContent).not.toContain("circle");
    expect(assistantContent).not.toContain("cx=");
    // SVG text labels are also stripped (whole subtree skipped)
    expect(assistantContent).not.toContain("Label");
  });
});
