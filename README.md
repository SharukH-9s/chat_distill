# ChatDistill

**AI Chat Knowledge Distiller Extension**

ChatDistill is a powerful Chrome Extension that extracts messy, unstructured conversations from ChatGPT and distills them into clean, high-signal, structured Markdown or PDF knowledge documents using the Gemini API.

Instead of generic "save as text" tools that dump raw HTML or unreadable chat logs, ChatDistill uses a **Profile-Based Architecture** to instruct an LLM to synthesize, deduplicate, and format your chat based on your specific needs (e.g., extracting just the code for a developer, or synthesizing an executive summary for a manager).

## Key Features

* **Profile Presets:** Choose from pre-configured presets (Developer, Executive, Student) to change exactly how the LLM distills your chat. The system automatically enforces strict depth, focus, and style instructions based on your selected profile.
* **2-Layer Extraction Cascade:** High scraping reliability:
  * **Layer 1:** Direct ChatGPT API extraction (bypassing virtual scrolling).
  * **Layer 2:** Precise DOM selector extraction.
* **Graceful Error Telemetry & GitHub Issue Pre-Fill:** When extraction fails completely due to UI changes, the extension generates a **privacy-safe DOM skeleton** (stripping all text content and sensitive attributes like `href`/`src`/`value`, and masking long custom data attributes). Users are prompted to **Copy Report** or **Report on GitHub** via a pre-filled issue link, enabling opt-in, zero-middlemen diagnostics.
* **Model Customization & Key Validation:** Built-in options panel lets you select from multiple Gemini models (e.g. Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 3.5 Flash, Gemini 2.0 Flash) and test the connection immediately via a 1-token diagnostic probe.
* **Markdown & PDF Support:** Export directly to heavily structured Markdown (`.md`) or beautiful, rendered PDF summaries.
* **Zero Operating Cost:** Bring your own Gemini API key (which offers a generous free tier).
* **Privacy First:** Operates entirely locally. Your API key is stored locally in your browser (`chrome.storage.local`) and your chat data goes straight to the Gemini API with no middlemen.

## Installation (Developer Mode)

Since this extension is currently in development, you can install it locally in Chrome:

1. Clone or download this repository.
2. Ensure you have Node.js installed.
3. Open a terminal in the project directory and run:

   ```bash
   npm install
   npm run build
   ```

4. Open Chrome and navigate to `chrome://extensions/`.
5. Toggle **Developer mode** ON (top right corner).
6. Click **Load unpacked**.
7. Select the `dist` folder located inside the project directory.
8. Pin the ChatDistill extension to your toolbar!

## User Guidelines Quick Reference

| Requirement | Description & Actions | Details Section |
| :--- | :--- | :--- |
| **API Key Setup** | Obtain a key from [Google AI Studio](https://aistudio.google.com/) and save it in the extension settings. | [Configuration](#configuration) |
| **Prompt Customization** | Modify LLM system instructions or profiles inside `src/background/prompts.ts`. | [Customizing Prompts](#customizing-prompts) |
| **Language Support** | Performs best on English chats. Adjust `prompts.ts` if targeting other languages. | [Language Support & Limitations](#language-support--limitations) |

## Configuration

Before extracting your first chat, you need to configure your API key:

1. **Obtain an API Key:** Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/).
2. **Add to Extension:** Click the ChatDistill icon in your Chrome toolbar, click the **Settings (Gear)** icon in the top right, and paste your API key.
3. **Verify:** Use the **Test Connection** button to verify it connects.
4. **Choose Profile:** (Optional) Select your default Export Profile.

## Customizing Prompts

You can adjust how the LLM summarizes and structures your notes. The prompts are defined in plain text inside:
📄 `src/background/prompts.ts`

* **To change layout / rules:** Edit `buildSystemPrompt` (for Markdown) or `buildPdfSummaryPrompt` (for PDFs).
* **To change profile behavior:** Edit the `PROFILE_INSTRUCTIONS` constant at the bottom of the file (e.g., tweaking instructions for the `developer` or `executive` templates).

*After modifying the prompts, rebuild the extension so Chrome loads the updates:*
```bash
npm run build
```

## Language Support & Limitations

* **Best Performance (English):** The internal prompts and structuring instructions are written in English. The extension performs best and produces the cleanest layout structures on English conversations.
* **Multilingual Capability:** Standard UTF-8 character extraction is fully supported (works with Spanish, Japanese, Hindi, etc.). While Gemini is smart enough to digest foreign language conversations, it may occasionally generate English headers or summaries. If you consistently extract non-English chats, we recommend editing `prompts.ts` (see above) to translate the system prompt instructions into your target language.

## Troubleshooting & Common Questions

* **"Rate limit exceeded" or "Temporarily Overloaded (503)"**: The free tier of the Gemini API is limited to **15 Requests Per Minute (RPM)**. If you run multiple exports in quick succession, you may receive a rate limit warning or a brief 503 error. Simply wait 15–30 seconds and click **Try Again**.
* **Chrome "Disable developer mode extensions" popup**: Because this extension is loaded unpacked directly in Developer Mode (rather than installed from the Chrome Web Store), Chrome will show a small warning popup when you start the browser. This is standard Chrome behavior and is completely safe to ignore.
* **Large chat logs and truncation**: Extremely long conversations (containing months of continuous dialogue) might exceed the Gemini API's token context window. If this happens, the model may truncate earlier parts of the chat. For very large chats, consider exporting in smaller sections.
* **Claude support status**: The codebase contains configurations for Claude, but only ChatGPT and Gemini extractors are currently active. Support for Claude is planned for a future update.

## Development & Testing

This project uses **TypeScript**, **Vite**, and the **CRXJS Vite Plugin** for a modern extension development experience with Hot Module Replacement (HMR).

To start the development server:

```bash
npm run dev
```

*(Note: When using `npm run dev`, CRXJS will create a dynamic build. You can load this `dist` folder into Chrome just like the production build, and it will automatically reload when you change files).*

To run unit tests (using **Vitest**):

```bash
npm run test
```

## Architecture Stack

* **Framework:** Vite + CRXJS
* **Language:** TypeScript
* **Testing:** Vitest
* **LLM Provider:** Google Gemini (Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 3.5 Flash, Gemini 2.0 Flash)
* **UI / Styling:** Vanilla DOM + Scoped CSS
* **Markdown Rendering:** `marked` + `mermaid` (for SVG diagrams)

---
