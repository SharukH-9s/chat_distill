/**
 * ChatDistill — Offscreen Document
 *
 * Runs in a hidden Chrome Offscreen Document (chrome.offscreen API, MV3).
 * Has full DOM access — safe to use html2pdf.js, marked, canvas, etc.
 *
 * Listens for GENERATE_PDF messages from the service worker, renders the
 * supplied Markdown to a PDF via html2pdf.js, triggers a chrome.downloads
 * download, then responds with OFFSCREEN_PDF_RESULT.
 *
 * The service worker creates this document before sending the message and
 * closes it once it receives the result.
 */

import { marked } from "marked";
import html2pdf from "html2pdf.js";
import type { GeneratePdfMessage, OffscreenPdfResponse } from "../types/messages";
import mermaid from "mermaid";

chrome.runtime.onMessage.addListener(
  (message: GeneratePdfMessage, _sender, sendResponse) => {
    if (message.type !== "GENERATE_PDF") return false;

    void renderAndDownloadPdf(message.markdown, message.filename)
      .then((result: OffscreenPdfResponse) => sendResponse(result))
      .catch((err: unknown) =>
        sendResponse({
          type: "OFFSCREEN_PDF_RESULT",
          ok: false,
          error: err instanceof Error ? err.message : "Unknown PDF error.",
        } satisfies OffscreenPdfResponse)
      );

    // Return true to keep the message channel open for async response.
    return true;
  },
);

/**
 * Renders Markdown → HTML → PDF, downloads the file, and returns the result.
 */
async function renderAndDownloadPdf(
  markdown: string,
  filename: string,
): Promise<OffscreenPdfResponse> {
  try {
    const htmlContent = await marked.parse(markdown);

    const container = document.createElement("div");
    container.style.padding = "20px";
    container.style.fontFamily = "sans-serif";
    container.style.fontSize = "14px";
    container.style.lineHeight = "1.5";
    container.style.color = "#000000";
    container.style.backgroundColor = "#ffffff";
    container.innerHTML = `
      <style>
        #pdf-export-container, #pdf-export-container * { color: #000000 !important; }
        #pdf-export-container pre, #pdf-export-container code { background-color: #f5f5f5 !important; }
        #pdf-export-container a { color: #0366d6 !important; }
        #pdf-export-container p, #pdf-export-container li, #pdf-export-container pre,
        #pdf-export-container h1, #pdf-export-container h2, #pdf-export-container h3,
        .mermaid-container {
          page-break-inside: avoid;
        }
        .mermaid-container {
          text-align: center;
          margin: 20px 0;
        }
        .mermaid-container svg {
          max-width: 100%;
          height: auto !important;
        }
      </style>
      <div id="pdf-export-container">
        ${htmlContent}
      </div>
    `;

    // Render any mermaid diagrams in-place before PDF generation.
    const mermaidBlocks = container.querySelectorAll("code.language-mermaid");
    if (mermaidBlocks.length > 0) {
      mermaid.initialize({ startOnLoad: false, theme: "default" });
      for (let i = 0; i < mermaidBlocks.length; i++) {
        const codeElement = mermaidBlocks[i] as HTMLElement;
        const preElement = codeElement.parentElement;
        if (preElement && preElement.tagName === "PRE") {
          const mermaidCode = codeElement.textContent ?? "";
          try {
            const id = `mermaid-pdf-${i}`;
            const { svg } = await mermaid.render(id, mermaidCode);
            const svgContainer = document.createElement("div");
            svgContainer.className = "mermaid-container";
            svgContainer.innerHTML = svg;
            preElement.replaceWith(svgContainer);
          } catch (e) {
            console.error("[ChatDistill Offscreen] Failed to render mermaid diagram:", e);
          }
        }
      }
    }

    const opt = {
      margin: 10,
      filename,
      image: { type: "jpeg" as const, quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: "mm" as const, format: "a4", orientation: "portrait" as const },
      pagebreak: { mode: "css", avoid: "p, li, pre, h1, h2, h3, h4, h5, h6, tr" },
    };

    // html2pdf saves directly via browser download in typical DOM environments,
    // but offscreen documents are sandboxed and cannot trigger downloads directly.
    // Instead, we output the PDF as a base64 data URI and send it to the service worker.
    const dataUrl = await html2pdf().set(opt).from(container).output("datauristring");

    return { type: "OFFSCREEN_PDF_RESULT", ok: true, filename, dataUrl };
  } catch (err) {
    return {
      type: "OFFSCREEN_PDF_RESULT",
      ok: false,
      error: err instanceof Error ? err.message : "Failed to generate PDF.",
    };
  }
}
