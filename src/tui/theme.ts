/**
 * Centralized theme constants for the TUI.
 *
 * All color and style tokens live here — views import `theme` instead
 * of scattering hex literals across the codebase.
 */

/** Semantic color tokens for the TUI theme. */
export const theme = {
  // Focus & chrome
  focus: "#00cccc",
  inactive: "#444444",
  border: "#555555",

  // Status indicators
  running: "#00cc00",
  waiting: "#cccc00",
  idle: "#888888",
  error: "#ff0000",
  stale: "#ff8800",

  // Contribution kinds
  work: "#00cc00",
  review: "#cccc00",
  discussion: "#0088cc",
  adoption: "#cc00cc",
  reproduction: "#00cccc",

  // Text
  text: "#ffffff",
  muted: "#888888",
  dimmed: "#777777",
  disabled: "#555555",

  // Surfaces
  panelBg: undefined as string | undefined,
  headerBg: "#1a1a2e",
  selectedBg: "#0d2137",

  // Semantic UI
  success: "#00cc00",
  warning: "#cccc00",
  info: "#0088cc",
  compare: "#ff6600",

  // Agent status symbols
  agentRunning: "●",
  agentWaiting: "◐",
  agentIdle: "○",
  agentError: "\u2717",
} as const;

/** Per-agent color palette — assigned round-robin at registration. */
export const AGENT_COLORS: readonly string[] = [
  "#00cccc",
  "#cc00cc",
  "#cccc00",
  "#00cc00",
  "#0088cc",
  "#ff6600",
  "#ff0088",
  "#88ff00",
];

/** Signature colors by agent platform/runtime (item 10). */
export const PLATFORM_COLORS: Readonly<Record<string, string>> = {
  "claude-code": "#ff8800",
  codex: "#0088ff",
  gemini: "#00cc88",
  custom: "#888888",
};

/**
 * Contribution kind icons for color-independent identification.
 * Uses box-drawing / geometric characters for accessibility.
 */
export const KIND_ICONS: Readonly<Record<string, string>> = {
  work: "\u2592", // ▒
  review: "\u25b7", // ▷
  discussion: "\u25c7", // ◇
  ask_user: "\u2753", // ❓
  response: "\u25b6", // ▶
  plan: "\u25a1", // □
  reproduction: "\u25d0", // ◐
  adoption: "\u25b2", // ▲
};

/** Braille spinner frames for animated agent status (item 8). */
export const BRAILLE_SPINNER: readonly string[] = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
];
