/**
 * ChatDistill — Filename Generation & Download
 *
 *   generateFilename   — extract title from Markdown H1 → safe filename
 *   sanitizeFilename   — strip special chars, truncate, slugify
 *   downloadMarkdown   — data: URI + chrome.downloads.download()
 *
 * MV3 note: service workers have no DOM, so URL.createObjectURL() is
 * unavailable. We use a base64-encoded data: URI as the standard workaround.
 */

// Constants

const DEFAULT_BASENAME = "chatdistill-export";
const MAX_FILENAME_LENGTH = 80;

// generateFilename

/**
 * Generates a safe .md filename from Markdown content.
 * Extracts the first H1, sanitizes it, and appends the date.
 *
 * @param markdown - The full Markdown string.
 * @returns A safe filename string ending in ".md".
 */
function generateFilename(markdown: string): string {
  const date = getTodayDateString();
  const title = extractH1Title(markdown);

  if (!title) {
    return `${DEFAULT_BASENAME}-${date}.md`;
  }

  const slug = sanitizeFilename(title, MAX_FILENAME_LENGTH);
  return slug ? `${slug}-${date}.md` : `${DEFAULT_BASENAME}-${date}.md`;
}

// sanitizeFilename

/**
 * Sanitizes a title string into a safe filename segment.
 * Strips special chars, truncates, and lowercases the output.
 *
 * @param raw       - The raw title string.
 * @param maxLength - Maximum character length (default: 80).
 * @returns A slugified string safe for use in a filename.
 */
function sanitizeFilename(
  raw: string,
  maxLength: number = MAX_FILENAME_LENGTH,
): string {
  return raw
    .replace(/[^a-zA-Z0-9\s-]/g, "")   // strip non-alphanumeric (keep spaces + hyphens)
    .replace(/[\s-]+/g, "-")             // collapse whitespace/hyphens → single hyphen
    .replace(/^-+|-+$/g, "")            // trim leading/trailing hyphens
    .slice(0, maxLength)                  // truncate
    .replace(/-+$/, "")                  // clean up any trailing hyphen from truncation
    .toLowerCase();
}

// downloadMarkdown

/**
 * Downloads Markdown content as a .md file via the chrome.downloads API.
 * Uses a base64-encoded data URI instead of ObjectURL due to MV3 worker limits.
 *
 * @param markdown - The full Markdown string to download.
 * @returns The filename used for the download.
 */
export async function downloadMarkdown(markdown: string): Promise<string> {
  const filename = generateFilename(markdown);

  // Encode to base64 via UTF-8 safe path:
  // Using TextEncoder to avoid deprecated unescape() function
  const bytes = new TextEncoder().encode(markdown);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = btoa(binary);
  const dataUrl = `data:text/markdown;base64,${base64}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });

  return filename;
}

// Helpers

/**
 * Extracts the text content of the first H1 heading in a Markdown string.
 * Returns null if no H1 heading is found.
 *
 * Handles both ATX-style headings (# Title) and optional trailing hashes.
 */
function extractH1Title(markdown: string): string | null {
  // Match the first line starting with a single # (not ## or ###)
  const match = markdown.match(/^#(?!#)\s+(.+?)(?:\s+#+)?$/m);
  return match ? match[1].trim() : null;
}

/**
 * Returns today's date formatted as YYYY-MM-DD (local time).
 */
function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
