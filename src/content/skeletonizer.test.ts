import { describe, it, expect, beforeEach } from "vitest";
import { generateDomSkeleton } from "./skeletonizer";

describe("generateDomSkeleton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces text node content with [TEXT:N] placeholder", () => {
    document.body.innerHTML = `<div><p>Hello, world!</p></div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain("Hello, world!");
    expect(skeleton).toContain("[TEXT:13]");
    expect(skeleton).toContain("<p>");
  });

  it("preserves class, id, and role attributes", () => {
    document.body.innerHTML = `<div id="main" class="container" role="main"><span>text</span></div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).toContain(`id="main"`);
    expect(skeleton).toContain(`class="container"`);
    expect(skeleton).toContain(`role="main"`);
  });

  it("preserves short data-* attribute values", () => {
    document.body.innerHTML = `<div data-message-author-role="user"><span>msg</span></div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).toContain(`data-message-author-role="user"`);
  });

  it("masks long data-* attribute values", () => {
    const longId = "a".repeat(60);
    document.body.innerHTML = `<div data-id="${longId}"></div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain(longId);
    expect(skeleton).toContain(`data-id="[MASKED]"`);
  });

  it("masks data-* attribute values that contain spaces", () => {
    document.body.innerHTML = `<div data-label="first second third"></div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain("first second third");
    expect(skeleton).toContain("[MASKED]");
  });

  it("strips href, src, and title attribute values", () => {
    document.body.innerHTML = `<a href="/secret-url" title="private link">click me</a>`;
    const root = document.body.querySelector("a")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain("/secret-url");
    expect(skeleton).not.toContain("private link");
    expect(skeleton).not.toContain("click me");
    // The attribute KEY should appear (with masked value)
    expect(skeleton).toContain("href");
    expect(skeleton).toContain("title");
  });

  it("skips script and style tags", () => {
    document.body.innerHTML = `
      <div>
        <script>alert("xss")</script>
        <style>.secret { color: red; }</style>
        <p>visible</p>
      </div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain("alert");
    expect(skeleton).not.toContain(".secret");
    expect(skeleton).toContain("<p>");
  });

  it("skips svg and its child elements", () => {
    document.body.innerHTML = `
      <div>
        <svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>
        <span>content</span>
      </div>`;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    expect(skeleton).not.toContain("<svg");
    expect(skeleton).not.toContain("<path");
    expect(skeleton).toContain("<span");
  });

  it("respects max depth and self-closes at limit", () => {
    // Build deeply nested HTML (17 levels)
    let html = "<span>deep</span>";
    for (let i = 0; i < 17; i++) {
      html = `<div>${html}</div>`;
    }
    document.body.innerHTML = html;
    const root = document.body.querySelector("div")!;
    const skeleton = generateDomSkeleton(root);

    // Output should exist but be truncated at max depth
    expect(skeleton.length).toBeGreaterThan(0);
    // The very deep span should be self-closed (/) rather than fully expanded
    // At depth 8+ the children are not recursed — they're self-closed
    expect(skeleton).toContain("/>");
  });

  it("produces stable output for a realistic ChatGPT-like structure", () => {
    document.body.innerHTML = `
      <main>
        <div class="conversation-container">
          <div data-message-author-role="user" class="message-bubble">
            <div class="markdown prose">Hello, explain closures in JS</div>
          </div>
          <div data-message-author-role="assistant" class="message-bubble">
            <div class="markdown prose">A closure is a function that...</div>
          </div>
        </div>
      </main>`;
    const root = document.body.querySelector("main")!;
    const skeleton = generateDomSkeleton(root);

    // Structure preserved
    expect(skeleton).toContain(`data-message-author-role="user"`);
    expect(skeleton).toContain(`data-message-author-role="assistant"`);
    expect(skeleton).toContain(`class="markdown prose"`);
    // Text stripped
    expect(skeleton).not.toContain("Hello, explain closures");
    expect(skeleton).not.toContain("A closure is a function");
    expect(skeleton).toContain("[TEXT:");
  });
});
