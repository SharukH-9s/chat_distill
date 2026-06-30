/**
 * ChatDistill — Shared Constants
 *
 * Single source of truth for platform configuration and model list.
 * Consumed by: popup (platform detection), options page (model dropdown),
 * service worker (model validation), and manifest (content_scripts.matches).
 */

import type { Platform } from "../types/chat";

// Platform Configuration

export interface PlatformConfig { // 
  /** Display name shown in the platform badge. */
  name: string;
  /** URL substring used to detect this platform from a tab URL. */
  urlPattern: string;
  /** Whether this platform has a working extractor (MVP scope). */
  supported: boolean;
}

export const PLATFORM_CONFIG: Record<Platform, PlatformConfig> = {
  chatgpt: {
    name:       "ChatGPT",
    urlPattern: "chatgpt.com",
    supported:  true,
  },
  gemini: {
    name:       "Gemini",
    urlPattern: "gemini.google.com",
    supported:  true,
  },
  claude: {
    name:       "Claude",
    urlPattern: "claude.ai",
    supported:  false, // post-MVP
  },
};

/**
 * Resolves the platform and support status from a tab URL.
 * Returns null if the URL doesn't match any known platform.
 */
export function detectPlatform(url: string): { platform: Platform; config: PlatformConfig } | null {
  for (const [platform, config] of Object.entries(PLATFORM_CONFIG) as [Platform, PlatformConfig][]) { // Object.entries() converts PLATFORM_CONFIG to a list of pairs: ["chatgpt", {...}], ["gemini", {...}], etc. For each property in PLATFORM_CONFIG, the loop creates a new [platform, config] pair.
    if (url.includes(config.urlPattern)) {
      return { platform, config };
    }
  }
  return null;
}

// Available Models

export interface ModelOption {
  /** Model ID passed to the Gemini API. */
  id: string;
  /** Human-readable label shown in the options page dropdown. */
  label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Recommended)" },
  { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro (Slower, higher quality)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (Latest)" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

/** Default model used when no preference has been saved. */
export const DEFAULT_MODEL = AVAILABLE_MODELS[0].id;

// Limits

/** Character count above which the popup shows a "large conversation" warning. */
export const LARGE_CONVERSATION_THRESHOLD = 500_000;

/** Popup-side timeout in ms for the content script to respond to EXTRACT_CHAT. */
export const EXTRACT_TIMEOUT_MS = 6_000;

/** Popup-side timeout in ms for the PING readiness check before extraction. */
export const PING_TIMEOUT_MS = 500;
