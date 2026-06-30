Chat extraction and export flow

1. The popup bootstraps in [popup.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/popup/popup.ts). When the popup DOM loads, `DOMContentLoaded` calls `init()`. `init()` queries the active tab, stores its URL in `app.dataset.tabUrl`, and then calls `render(state)`. At startup the state is `idle`, so render goes to `renderIdle()`.
2. `renderIdle()` builds the "Extract this conversation" button. It also calls `getPlatformInfo()`, which uses `detectPlatform` from [constants.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/shared/constants.ts) to decide whether the current page is supported. If the page is unsupported, the button is rendered disabled.
3. The click listener is attached in `renderIdle()`. When the user clicks, it calls `setState({ status: "extracting" })` directly. There is no event object or transition matrix — `setState()` is the single entry point for all state changes in the popup.
4. `setState()` updates the module-level `state` variable, calls `render(state)` to update the DOM, then fires async side effects. Because the new status is `extracting`, it triggers `runExtraction()`.
5. `render()` switches the UI to `renderExtracting()` (a spinner). Side effects are always triggered after the DOM is updated, never inside `render()`.

2. Content script receives the request
6. `runExtraction()` is the popup-side controller for the first I/O hop. It uses `chrome.tabs.query` to get the active tab ID. If that fails, it calls `setState({ status: "extraction_error", ... })` immediately.
7. If it gets a tab ID, it performs the readiness check. It sends a `PingMessage` with shape `{ type: "PING" }` via `chrome.tabs.sendMessage`. The response type is `PingResponse` (`{ type: "PONG" }`) from [messages.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/types/messages.ts). The timeout used is `PING_TIMEOUT_MS` from [constants.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/shared/constants.ts).
8. If the ping does not return `PONG`, `runExtraction()` calls `setState({ status: "extraction_error", ... })` with a diagnostic explaining the content script may not be injected.
9. If the ping succeeds, `runExtraction()` sends the actual extraction request: `{ type: "EXTRACT_CHAT" }`, typed by `ExtractChatMessage` in [messages.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/types/messages.ts). The response type is `ExtractChatResponse`, which is the union of `ExtractChatSuccess` and `ExtractChatError`. The popup waits up to `EXTRACT_TIMEOUT_MS` from [constants.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/shared/constants.ts).
10. At that point, the popup has handed control to the content-script listener in [index.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/index.ts). This is where `EXTRACT_CHAT` gets handled.

3. Content script runs the cascade
11. The content-script message listener in [index.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/index.ts) intercepts the `EXTRACT_CHAT` request. It records the start timestamp via `Date.now()` and invokes `runCascade()`. Since `runCascade()` is asynchronous, the handler returns `true` to keep the response channel open.
12. `runCascade()` coordinates a platform-specific extraction cascade:
    - **Gemini** (`gemini.google.com`): 1 layer — `extractGemini()` (shadow DOM + scroll pre-pass)
    - **ChatGPT** (`chatgpt.com`): 2 layers — `extractFromApi()` then `extractChatGPT()`
    Each call is wrapped in `withTimeout()` which rejects if it exceeds the layer's budget (5000ms for ChatGPT layers, 15000ms for Gemini to accommodate its scroll pre-pass).
13. If an extractor throws or times out, the `catch` block logs a warning and the cascade falls through to the next layer. If an extractor returns `null`, the loop continues. If a valid `ExtractionResult` is returned, the loop stops and passes it to normalization.

4. API extractor path (ChatGPT layer 1)
14. `extractFromApi()` in [chatgpt-api.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/extractors/chatgpt-api.ts) is the first ChatGPT layer. It checks if the URL matches `SAVED_CHAT_RE`. If not a saved conversation, it immediately returns `null`.
15. If a conversation ID exists, it requests the user's access token from `https://chatgpt.com/api/auth/session` via `getAccessToken()`, passing session cookies with `credentials: "include"`. If the user is logged out or the fetch fails, it warns and returns `null`.
16. Using the access token in the `Authorization: Bearer {accessToken}` header, it fetches `https://chatgpt.com/backend-api/conversation/{conversationId}`. On failure, it warns and returns `null`.
17. Upon parsing the `ApiConversationResponse`, it calls `walkBranch()` to traverse the message tree from the active leaf node (`current_node`) to the root via parent pointers, then reverses it into chronological order.
18. It iterates the branch, filtering nodes via `isUsableMessage()` (keeping only successfully completed user and assistant messages), merges text blocks via `extractTextFromParts()`, verifies at least 2 messages, and returns a high-confidence (0.99) `ExtractionResult`.

5. Precise DOM extractor path (ChatGPT layer 2)
19. `extractChatGPT()` in [chatgpt.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/extractors/chatgpt.ts) is the ChatGPT fallback layer. It query-selects all elements matching `ROLE_SELECTOR` (`[data-message-author-role]` or `[data-turn]` for the newer UI). Since `querySelectorAll` returns nodes in depth-first order, messages are guaranteed to be chronological.
20. For each node, it reads the role via `parseRole()`, skipping non-conversation roles. It extracts message text via `extractContent()`, trying selectors like `.markdown.prose` before falling back to container `innerText`.
21. Content is validated via `isIntegrousContent()` to exclude empty nodes or known UI text (placeholder ellipsis, warnings). If at least 2 messages are collected, it computes a confidence score, logs warnings for skipped elements, and returns the `ExtractionResult`.

6. Gemini DOM extractor path
22. `extractGemini()` in [gemini.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/extractors/gemini.ts) runs first for Gemini pages. It begins with a scroll pre-pass: `ensureAllMessagesLoaded()` uses a `MutationObserver` to scroll the `#chat-history` container to the top repeatedly until the DOM is stable for 700ms or 8s elapses. This is required because Gemini uses a load-on-scroll-up pattern.
23. After the pre-pass, it query-selects all `user-query, model-response` elements (Angular custom elements). For user turns, `extractUserContent()` reads `p.query-text-line` elements. For assistant turns, `extractModelContent()` reads the **shadow root** of `<message-content>` (Angular `ViewEncapsulation.ShadowDom`), falling back to `structured-content-container` if the shadow root is unavailable.
24. Before reading each shadow root, `expandShowCodeButtons()` clicks any collapsed "Show code" buttons to ensure code blocks are in the DOM. Content is validated via `isIntegrousContent()`, and the result is returned with a confidence score adjusted for shadow root misses and skip ratio.

7. Normalization
25. Raw message arrays are normalized via `normalizeMessages()` in [normalizer.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/normalizer.ts). It iterates the list, calling `normalizeContent()` to strip invisible characters matching `ZERO_WIDTH_RE`, normalize line breaks, and collapse multiple consecutive newlines to two.
26. It filters out empty messages and contiguous duplicates (consecutive messages with the exact same role and text).
27. For DOM-based extractions, it inspects the final assistant message via `isStreamingArtifact()`. If the last message is under 5 characters, it is assumed to be an incomplete streaming chunk and is removed.

8. Validation
28. The normalized messages are passed to `validate()` in [validator.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/content/validator.ts). Structural validation verifies: at least 2 messages (`MIN_MESSAGES`), both "user" and "assistant" roles present, and total character count of at least 100 (`MIN_TOTAL_CHARS`).
29. If structural checks pass, semantic validation ensures at least 8 unique characters (`MIN_UNIQUE_CHARS`). For conversations longer than 50 characters, it calculates Shannon entropy via `calculateEntropy()`, failing if below 2.0 (`MIN_ENTROPY`).
30. It counts messages consisting purely of UI button texts (like "copy", "share" from `UI_JUNK_LABELS`). If 70% or more match, validation fails — indicating the scraper captured UI elements instead of dialogue.

9. Popup receives the extraction result
31. The content script attaches final timing metadata via `buildMeta()` and sends an `EXTRACT_CHAT_RESULT` message back to the popup. If validation or the cascade failed, it responds with `ok: false` containing error details.
32. Back in `runExtraction()`, the popup resolves the response. If the popup has been closed (`cancelled` state), the result is discarded. If validation failed, it calls `setState({ status: "validation_error", ... })`. If the cascade failed, it calls `setState({ status: "extraction_error", ... })`.
33. If successful, the popup calls `setState({ status: "preview", result: Object.freeze({...response.payload}) })` directly — there is no intermediate validation flash-state. `renderPreview()` displays the stats bar, metadata badge, and a scrollable preview of the first three messages.

10. Export starts from the popup
34. The preview UI displays "Export to Markdown" (`#btn-export`) and "Summarize & Export PDF" (`#btn-export-pdf`) buttons. Their click listeners call `setState({ status: "processing", result })` or `setState({ status: "processing_pdf", result })` respectively.
35. `renderProcessing()` renders a loading spinner. `setState()` then fires the corresponding async side effect — `runExport()` or `runExportPdf()` — after the DOM has updated.
36. Both export paths read the active tab's URL to determine the platform via `detectPlatform()`, build a `Conversation` object, and dispatch `EXPORT_MARKDOWN` or `EXPORT_PDF` messages to the service worker, waiting up to 120 seconds.

11. Service worker handles export
37. The background service worker listens for messages in [service-worker.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/background/service-worker.ts), delegating to `handleExportMarkdown()` or `handleExportPdf()`.
38. Both handlers call `runExportPipeline()`, which retrieves the API key, preferences, and the active profile ID from extension storage. The profile ID is passed to `getProfileInstructions(profileId, mode)` in [prompts.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/background/prompts.ts), which looks up one of three static instruction blocks (developer / executive / student) and optionally appends a PDF formatting note.
39. It builds the system prompt using `buildSystemPrompt()` or `buildPdfSummaryPrompt()`, formats the conversation via `formatTranscript()`, and calls `callGeminiAPI()` to POST the request to the Gemini `generateContent` endpoint.

12. Markdown export path
40. In `handleExportMarkdown()`, if the Gemini API call succeeds, the returned Markdown text is passed to `downloadMarkdown()` in [export.ts](file:///e%3A/projects/anti/ai-chat-md-exporter/src/background/export.ts).
41. `downloadMarkdown()` calls `generateFilename()` to extract the first H1 in the Markdown as the title via `extractH1Title()`. It sanitizes it via `sanitizeFilename()` (lowercase, non-alphanumeric chars removed, spaces collapsed to hyphens, truncated to 80 characters), and appends today's date in `YYYY-MM-DD` format.
42. Because service workers cannot access `URL.createObjectURL()`, it converts the Markdown to UTF-8 bytes via `TextEncoder`, encodes to base64, constructs a `data:text/markdown;base64,...` URL, and calls `chrome.downloads.download()` to trigger the file save.
43. The service worker returns the filename to the popup. If successful, the popup calls `setState({ status: "success", filename })` and renders `renderSuccess()`.

13. PDF export path
44. In `handleExportPdf()`, the service worker returns the raw Markdown text directly to the popup (no download triggered server-side).
45. `runExportPdf()` in the popup parses the Markdown into HTML using `marked.parse()` and injects it into a styled container element.
46. It queries for `code.language-mermaid` blocks. If any are present, it initializes the mermaid engine, renders each diagram as an SVG via `mermaid.render()`, and replaces the code block with the SVG.
47. The popup feeds the container to `html2pdf.js` with configuration options to avoid awkward page breaks. `html2pdf` renders the HTML to PDF and triggers a browser file save. The popup calls `setState({ status: "success", filename })` and renders the success screen.

Message flow summary
   - Popup -> content script: PING, EXTRACT_CHAT
   - Content script -> popup: EXTRACT_CHAT_RESULT
   - Popup -> service worker: EXPORT_MARKDOWN, EXPORT_PDF
   - Service worker -> popup: EXPORT_MARKDOWN_RESULT, EXPORT_PDF_RESULT

Core pipeline summary
   Popup click -> content extraction -> normalize -> validate -> popup preview -> service worker export -> Gemini -> download or PDF render