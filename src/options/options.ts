/**
 * ChatDistill — Options Page
 *
 * Flow:
 * 1. On load — read saved key + preferences, populate fields
 * 2. API key — save to chrome.storage.local, inline validation
 * 3. Model — auto-save on change to chrome.storage.sync
 * 4. Test Connection — 1-token probe via service worker, maps all 5 outcomes
 * 5. Footer — shows PROMPT_VERSION
 */

import { getApiKey, setApiKey, clearApiKey, getPreferences, setPreferences } from "../storage/client";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "../shared/constants";
import { PROMPT_VERSION } from "../background/prompts";
import type { TestConnectionResponse } from "../types/messages";

// Element Refs

const apiKeyInput     = document.getElementById("api-key-input")     as HTMLInputElement;
const btnToggleKey    = document.getElementById("btn-toggle-key")    as HTMLButtonElement;
const eyeIcon         = document.getElementById("eye-icon")          as HTMLElement;
const btnSaveKey      = document.getElementById("btn-save-key")      as HTMLButtonElement;
const btnClearKey     = document.getElementById("btn-clear-key")     as HTMLButtonElement;
const btnTestConn     = document.getElementById("btn-test-connection") as HTMLButtonElement;
const apiKeyFeedback  = document.getElementById("api-key-feedback")  as HTMLElement;
const testResult      = document.getElementById("test-result")       as HTMLElement;
const modelSelect     = document.getElementById("model-select")      as HTMLSelectElement;
const modelFeedback   = document.getElementById("model-feedback")    as HTMLElement;
const profileSelect   = document.getElementById("profile-select")    as HTMLSelectElement;
const profileFeedback = document.getElementById("profile-feedback")  as HTMLElement;
const promptVersion   = document.getElementById("prompt-version")    as HTMLElement;

// Helpers

/** Displays an inline feedback message with a semantic class. */
function setFeedback(
  el: HTMLElement,
  text: string,
  kind: "success" | "warning" | "error" | "",
): void {
  el.textContent = text;
  el.className = `feedback ${kind}`.trim();
}

/** Clears an inline feedback message. */
function clearFeedback(el: HTMLElement): void {
  el.textContent = "";
  el.className = "feedback";
}

/**
 * Validates the raw API key string.
 * Returns a typed result so the caller can decide to block saving or just warn.
 */
function validateApiKey(key: string): { ok: true } | { ok: false; error: string } | { ok: "warn"; warning: string } {
  if (!key.trim()) {
    return { ok: false, error: "API key cannot be empty." };
  }
  if (!key.startsWith("AIza") && !key.startsWith("AQ")) {
    return { ok: "warn", warning: "This doesn't look like a valid Gemini API key (should start with AIza or AQ)." };
  }
  return { ok: true };
}

// 1. Load saved values

async function loadSavedValues(): Promise<void> {
  // API key
  const savedKey = await getApiKey();
  if (savedKey) {
    apiKeyInput.value = savedKey;
    btnTestConn.disabled = false;
  }

  // Preferences → model
  const prefs = await getPreferences();
  const savedModel = prefs.model ?? DEFAULT_MODEL;
  const option = modelSelect.querySelector<HTMLOptionElement>(`option[value="${savedModel}"]`);
  if (option) option.selected = true;

  // Preferences → activeProfileId
  const savedProfile = prefs.activeProfileId ?? "developer";
  const profileOption = profileSelect.querySelector<HTMLOptionElement>(`option[value="${savedProfile}"]`);
  if (profileOption) profileOption.selected = true;

  // Footer prompt version
  promptVersion.textContent = `Prompt version: ${PROMPT_VERSION}`;
}

// 2. API Key — Show / Hide toggle

btnToggleKey.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  eyeIcon.textContent = isPassword ? "🙈" : "👁";
});

// 3. API Key — Save

btnSaveKey.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  clearFeedback(apiKeyFeedback);

  const validation = validateApiKey(key);

  if (validation.ok === false) {
    // Hard error — don't save
    setFeedback(apiKeyFeedback, validation.error, "error");
    apiKeyInput.focus();
    return;
  }

  // Save (even if it's just a warning)
  try {
    await setApiKey(key);
    btnTestConn.disabled = false;

    if (validation.ok === "warn") {
      setFeedback(apiKeyFeedback, `Saved. ⚠️ ${validation.warning}`, "warning");
    } else {
      setFeedback(apiKeyFeedback, "✅ Saved.", "success");
      // Auto-clear success message after 3s
      setTimeout(() => clearFeedback(apiKeyFeedback), 3000);
    }
  } catch (err) {
    setFeedback(
      apiKeyFeedback,
      `Failed to save: ${err instanceof Error ? err.message : "unknown error"}`,
      "error",
    );
  }
});

// 3.5 API Key — Clear

btnClearKey.addEventListener("click", async () => {
  try {
    await clearApiKey();
    apiKeyInput.value = "";
    btnTestConn.disabled = true;
    testResult.textContent = "";
    testResult.className = "test-result";
    setFeedback(apiKeyFeedback, "🗑️ API Key cleared.", "success");
    setTimeout(() => clearFeedback(apiKeyFeedback), 3000);
  } catch (err) {
    setFeedback(
      apiKeyFeedback,
      `Failed to clear: ${err instanceof Error ? err.message : "unknown error"}`,
      "error",
    );
  }
});

// Also clear feedback when the user types (stale error is confusing)
apiKeyInput.addEventListener("input", () => clearFeedback(apiKeyFeedback));

// 4. Auto-save Dropdowns

function bindPreferenceDropdown(
  selectEl: HTMLSelectElement,
  feedbackEl: HTMLElement,
  preferenceKey: "model" | "activeProfileId"
): void {
  selectEl.addEventListener("change", async () => {
    const value = selectEl.value;
    clearFeedback(feedbackEl);
    try {
      await setPreferences({ [preferenceKey]: value });
      setFeedback(feedbackEl, "✅ Saved.", "success");
      setTimeout(() => clearFeedback(feedbackEl), 2000);
    } catch (err) {
      setFeedback(
        feedbackEl,
        `Failed to save: ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
      );
    }
  });
}

bindPreferenceDropdown(modelSelect, modelFeedback, "model");
bindPreferenceDropdown(profileSelect, profileFeedback, "activeProfileId");

// 5. Test Connection

btnTestConn.addEventListener("click", async () => {
  // Lock button during probe
  btnTestConn.disabled = true;
  testResult.className = "test-result testing";
  testResult.textContent = "Testing connection…";

  let response: TestConnectionResponse;
  try {
    response = await chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      model: modelSelect.value || undefined,
    });
  } catch (err) {
    testResult.className = "test-result fail";
    testResult.textContent = `❌ Could not reach service worker: ${err instanceof Error ? err.message : "unknown"}`;
    btnTestConn.disabled = false;
    return;
  }

  if (response.ok) {
    testResult.className = "test-result ok";
    testResult.textContent = `✅ Connected — ${response.model}`;
  } else {
    // Distinguish rate-limit (key is valid but throttled) vs hard failure
    const isRateLimit = response.error.toLowerCase().includes("rate limited");
    testResult.className = isRateLimit ? "test-result warn" : "test-result fail";
    testResult.textContent = isRateLimit
      ? `⚠️ ${response.error}`
      : `❌ ${response.error}`;
  }

  btnTestConn.disabled = false;
});

// 6. Build Model Dropdown

function populateModelDropdown(): void {
  modelSelect.innerHTML = "";
  for (const { id, label } of AVAILABLE_MODELS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    modelSelect.appendChild(opt);
  }
}

function populateProfileDropdown(): void {
  const profiles = [
    { id: "developer", label: "Developer (The Builder)" },
    { id: "executive", label: "Executive (The Manager/Lead)" },
    { id: "student",   label: "Student / Researcher (The Learner)" },
  ];
  profileSelect.innerHTML = "";
  for (const { id, label } of profiles) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    profileSelect.appendChild(opt);
  }
}

// Init

async function init(): Promise<void> {
  populateModelDropdown();
  populateProfileDropdown();
  await loadSavedValues();
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
