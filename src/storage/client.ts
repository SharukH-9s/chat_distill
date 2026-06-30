/**
 * Storage Layer
 *
 * Typed wrapper around Chrome's storage APIs.
 * - API key → chrome.storage.local (device-specific, never syncs)
 * - Preferences → chrome.storage.sync (follows Chrome profile across devices)
 *
 * No migration logic — just a STORAGE_VERSION stamp.
 * Migrations get built when a v2 schema actually exists.
 */

// Schema Version

/** Bump this when the stored data shape changes. */
const STORAGE_VERSION = 1;

// Types

/** User preferences stored in chrome.storage.sync. */
export interface Preferences {
  /** Gemini model identifier (e.g., "gemini-1.5-flash"). */
  model: string;
  /** Prompt template version (e.g., "1.0.0"). */
  promptVersion: string;
  /** Active Profile ID (e.g., "developer" or "custom"). */
  activeProfileId?: string;
}

/** Shape of data in chrome.storage.local. */
interface LocalStorageSchema {
  apiKey?: string;
  storageVersion?: number;
  activeExports?: Record<string, boolean>;
}

/** Shape of data in chrome.storage.sync. */
interface SyncStorageSchema {
  preferences?: Preferences;
}

// Defaults

import { DEFAULT_MODEL, AVAILABLE_MODELS } from "../shared/constants";

const DEFAULT_PREFERENCES: Preferences = {
  model: DEFAULT_MODEL,
  promptVersion: "1.0.0",
  activeProfileId: "developer",
};

// API Key (chrome.storage.local)

/** Retrieve the stored Gemini API key, or null if not set. */
export async function getApiKey(): Promise<string | null> {
  const result: LocalStorageSchema =
    await chrome.storage.local.get("apiKey");
  return result.apiKey ?? null;
}

/** Store the Gemini API key. Also stamps the storage version. */
export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({
    apiKey: key,
    storageVersion: STORAGE_VERSION,
  } satisfies LocalStorageSchema);
}

/** Remove the stored API key. */
export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove("apiKey");
}

// Preferences (chrome.storage.sync)

/** Retrieve user preferences, falling back to defaults for any missing fields. */
export async function getPreferences(): Promise<Preferences> {
  const result: SyncStorageSchema =
    await chrome.storage.sync.get("preferences");

  const prefs = {
    ...DEFAULT_PREFERENCES,
    ...result.preferences,
  };

  // Ensure obsolete models saved in storage are automatically upgraded
  const isValidModel = AVAILABLE_MODELS.some(m => m.id === prefs.model);
  if (!isValidModel) {
    prefs.model = DEFAULT_MODEL;
  }

  return prefs;
}

/** Update one or more preference fields. Merges with existing values. */
export async function setPreferences(
  prefs: Partial<Preferences>,
): Promise<void> {
  const current = await getPreferences();
  await chrome.storage.sync.set({
    preferences: { ...current, ...prefs },
  } satisfies SyncStorageSchema);
}

// Utilities

/** Get the current storage version stamp (useful for future migrations). */
export async function getStorageVersion(): Promise<number> {
  const result: LocalStorageSchema =
    await chrome.storage.local.get("storageVersion");
  return result.storageVersion ?? STORAGE_VERSION;
}

// Profiles

const VALID_PROFILE_IDS = new Set(["developer", "executive", "student"]);

/** Returns the active profile ID, falling back to "developer" if unrecognised. */
export async function getActiveProfileId(): Promise<string> {
  const prefs = await getPreferences();
  const id = prefs.activeProfileId ?? "developer";
  return VALID_PROFILE_IDS.has(id) ? id : "developer";
}

// Export State (chrome.storage.local)

/** Check if an export is currently running for a specific tab URL. */
export async function getIsExporting(url: string): Promise<boolean> {
  if (!url) return false;
  const result: LocalStorageSchema = await chrome.storage.local.get("activeExports");
  const exports = result.activeExports ?? {};
  return exports[url] === true;
}

/** Set the export running flag for a specific tab URL. */
export async function setIsExporting(url: string, isExporting: boolean): Promise<void> {
  if (!url) return;
  const result: LocalStorageSchema = await chrome.storage.local.get("activeExports");
  const activeExports = result.activeExports ?? {};
  if (isExporting) {
    activeExports[url] = true;
  } else {
    delete activeExports[url];
  }
  await chrome.storage.local.set({ activeExports } satisfies LocalStorageSchema);
}
