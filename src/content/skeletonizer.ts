/**
 * DOM Skeletonizer — Privacy-Safe Layout Reporter
 *
 * Converts a live DOM subtree into a structural skeleton string.
 * Used to generate reproducible, privacy-safe bug reports when the
 * extraction cascade fails (e.g. due to a ChatGPT UI update).
 *
 * Privacy contract:
 *   ✅ Keeps: tag names, class lists, id, role, data-* attribute KEYS
 *   ✅ Keeps: short data-attribute values (≤30 chars, no spaces)
 *   ❌ Strips: all text content (replaced with [TEXT:N])
 *   ❌ Strips: sensitive attribute values (href, src, title, placeholder, alt, value)
 *   ❌ Strips: long / multi-word data attribute values
 *   ❌ Skips: script, style, svg, path, iframe, canvas, noscript tags
 */

// Tags that are noise and carry no structural info for debugging.
const SKIP_TAGS = new Set([
  "script", "style", "svg", "path", "use", "defs", "clippath",
  "iframe", "canvas", "noscript", "link", "meta", "head",
]);

// Attributes we always preserve (keys only, values may be filtered).
const KEEP_ATTR_KEYS = new Set(["id", "role", "class", "type", "aria-label", "aria-role"]);

// Hard limit on output size to prevent large reports.
const MAX_OUTPUT_CHARS = 30_000;

// Maximum DOM depth to traverse.
const MAX_DEPTH = 15;

/**
 * Returns a sanitized attribute string for a given element.
 * Keeps class, id, role, aria-*, data-* (with value masking).
 * Strips content-bearing attributes (src, href, value, title, etc.).
 */
function buildAttrString(el: Element): string {
  const parts: string[] = [];

  for (const { name, value } of Array.from(el.attributes)) {
    if (KEEP_ATTR_KEYS.has(name)) {
      // Escape quotes for safety
      const safeValue = value.replace(/"/g, "'");
      parts.push(`${name}="${safeValue}"`);
      continue;
    }

    if (name.startsWith("data-") || name.startsWith("aria-")) {
      // Keep the key; mask the value if it's long or contains spaces
      const isSafe = value.length <= 30 && !value.includes(" ");
      const safeValue = isSafe ? value.replace(/"/g, "'") : "[MASKED]";
      parts.push(`${name}="${safeValue}"`);
      continue;
    }

    // All other attributes: keep the key only (omit value to prevent data leaks)
    // e.g. href, src, title, placeholder, alt, value, data-testid with long UUIDs
    // We still include the attribute name so we know it exists.
    if (name !== "style") {
      parts.push(`${name}="…"`);
    }
  }

  return parts.length > 0 ? " " + parts.join(" ") : "";
}

/**
 * Recursive tree walker.
 * Returns the skeleton fragment for a given node at a given depth.
 */
function walk(node: Node, depth: number, output: string[]): void {
  // Track output size to enforce MAX_OUTPUT_CHARS
  const totalLen = output.reduce((sum, s) => sum + s.length, 0);
  if (totalLen >= MAX_OUTPUT_CHARS) return;

  // Text nodes
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").trim();
    if (text.length > 0) {
      output.push(`[TEXT:${text.length}]`);
    }
    return;
  }

  // Element nodes
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    // Skip noise tags entirely
    if (SKIP_TAGS.has(tag)) return;

    const attrs = buildAttrString(el);
    const indent = "  ".repeat(depth);

    const children = Array.from(el.childNodes);

    if (children.length === 0 || depth >= MAX_DEPTH) {
      // Self-close or stop recursing
      output.push(`${indent}<${tag}${attrs} />`);
      return;
    }

    output.push(`${indent}<${tag}${attrs}>`);

    for (const child of children) {
      walk(child, depth + 1, output);
    }

    output.push(`${indent}</${tag}>`);
  }
  // Comment nodes, processing instructions, etc. are silently ignored.
}

/**
 * Generates a privacy-safe DOM skeleton string from the given root element.
 *
 * @param root - The DOM element to skeletonize (e.g. document.querySelector('main') || document.body).
 * @returns A human-readable, plaintext structural outline of the DOM.
 */
export function generateDomSkeleton(root: Element): string {
  const output: string[] = [];
  walk(root, 0, output);
  const result = output.join("\n");

  // Final safety truncation
  if (result.length > MAX_OUTPUT_CHARS) {
    return result.slice(0, MAX_OUTPUT_CHARS) + "\n… [TRUNCATED]";
  }

  return result;
}
