/**
 * Centralized theme constants for the TUI.
 *
 * All color and style tokens live here — views import `theme` instead
 * of scattering hex literals across the codebase.
 *
 * Color values are resolved at module load time via `resolveColor()` so the
 * TUI degrades gracefully on terminals with limited color support.
 */

// ---------------------------------------------------------------------------
// Color depth detection
// ---------------------------------------------------------------------------

/** Terminal color depth capabilities. */
export type ColorDepth = "truecolor" | "256" | "16";

/** Detected terminal color depth (resolved once at module load). */
export const colorDepth: ColorDepth = detectColorDepth();

function detectColorDepth(): ColorDepth {
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") return "truecolor";
  const term = process.env.TERM ?? "";
  if (term.includes("256color")) return "256";
  return "16";
}

// ---------------------------------------------------------------------------
// 16-color fallback map
// ---------------------------------------------------------------------------

/**
 * Maps hex colors used in this theme to the nearest basic ANSI color name
 * when running on a 16-color terminal.
 */
const ANSI_16_MAP: Record<string, string> = {
  "#00cccc": "cyan",
  "#cc00cc": "magenta",
  "#cccc00": "yellow",
  "#00cc00": "green",
  "#ff0000": "red",
  "#0088cc": "blue",
  "#ffffff": "white",
  "#888888": "gray",
  "#666666": "darkGray",
  "#1a1a2e": "black",
  // Additional colors used in AGENT_COLORS / PLATFORM_COLORS
  "#ff6600": "red",
  "#ff0088": "magenta",
  "#88ff00": "green",
  "#0088ff": "blue",
  "#00cc88": "cyan",
  "#ff8800": "yellow",
  "#555555": "darkGray",
  "#0d2137": "black",
};

// ---------------------------------------------------------------------------
// 256-color approximation
// ---------------------------------------------------------------------------

/**
 * Convert a hex color string to the nearest hex color in the xterm-256 palette.
 *
 * Returns a hex string (not an ANSI escape) because OpenTUI color props
 * expect hex or named colors, not raw escape sequences.
 */
function hexTo256(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Snap to the 6×6×6 color cube (indices 16–231)
  const ri = Math.round((r / 255) * 5);
  const gi = Math.round((g / 255) * 5);
  const bi = Math.round((b / 255) * 5);
  // Convert back to the hex value the cube entry represents
  const rr = Math.round((ri * 255) / 5);
  const gg = Math.round((gi * 255) / 5);
  const bb = Math.round((bi * 255) / 5);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a hex color string to a terminal-appropriate value.
 *
 * - truecolor: hex returned as-is (Ink / OpenTUI accept hex directly)
 * - 256-color: nearest xterm-256 ANSI escape sequence
 * - 16-color: nearest basic ANSI color name from ANSI_16_MAP
 */
export function resolveColor(hex: string): string {
  if (!hex.startsWith("#")) return hex; // Already an ANSI name or escape — pass through
  switch (colorDepth) {
    case "truecolor":
      return hex;
    case "256":
      return hexTo256(hex);
    case "16":
      return ANSI_16_MAP[hex] ?? "white";
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Semantic color tokens for the TUI theme. */
export const theme: {
  readonly focus: string;
  readonly inactive: string;
  readonly border: string;
  readonly running: string;
  readonly waiting: string;
  readonly idle: string;
  readonly error: string;
  readonly stale: string;
  readonly work: string;
  readonly review: string;
  readonly discussion: string;
  readonly adoption: string;
  readonly reproduction: string;
  readonly text: string;
  readonly secondary: string;
  readonly muted: string;
  readonly dimmed: string;
  readonly disabled: string;
  readonly panelBg: string | undefined;
  readonly headerBg: string;
  readonly selectedBg: string;
  readonly success: string;
  readonly warning: string;
  readonly info: string;
  readonly compare: string;
  readonly agentRunning: string;
  readonly agentWaiting: string;
  readonly agentIdle: string;
  readonly agentError: string;
} = {
  // Focus & chrome
  focus: resolveColor("#00cccc"),
  inactive: resolveColor("#666666"),
  border: resolveColor("#555555"),

  // Status indicators
  running: resolveColor("#00cc00"),
  waiting: resolveColor("#cccc00"),
  idle: resolveColor("#888888"),
  error: resolveColor("#ff0000"),
  stale: resolveColor("#ff8800"),

  // Contribution kinds
  work: resolveColor("#00cc00"),
  review: resolveColor("#cccc00"),
  discussion: resolveColor("#0088cc"),
  adoption: resolveColor("#cc00cc"),
  reproduction: resolveColor("#00cccc"),

  // Text
  text: resolveColor("#ffffff"),
  /** Secondary text — labels, hints, timestamps. Replaces former muted/dimmed split. */
  secondary: resolveColor("#888888"),
  /** @deprecated Use `secondary` instead. Kept for backward compat during migration. */
  muted: resolveColor("#888888"),
  /** @deprecated Use `secondary` instead. Kept for backward compat during migration. */
  dimmed: resolveColor("#888888"),
  disabled: resolveColor("#666666"),

  // Surfaces
  panelBg: undefined,
  headerBg: resolveColor("#1a1a2e"),
  selectedBg: resolveColor("#0d2137"),

  // Semantic UI
  success: resolveColor("#00cc00"),
  warning: resolveColor("#cccc00"),
  info: resolveColor("#0088cc"),
  compare: resolveColor("#ff6600"),

  // Agent status symbols
  agentRunning: "●",
  agentWaiting: "◐",
  agentIdle: "○",
  agentError: "\u2717",
};

/** Spacing scale in terminal character units. */
export const spacing = {
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
} as const;

/** Border style tokens. */
export const borders = {
  /** Standard panel borders. */
  panel: "round",
  /** Modal/overlay borders. */
  modal: "round",
} as const;

/** Timing tokens in milliseconds. */
export const timing = {
  /** Braille spinner animation frame interval. */
  spinner: 80,
  /** Default polling interval (base). Multiply by tier. */
  pollBase: 3000,
  /** Polling tier multipliers: hot=1x, warm=3x, cold=5x, frozen=10x. */
  pollTiers: { hot: 1, warm: 3, cold: 5, frozen: 10 } as const,
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

// ---------------------------------------------------------------------------
// Shared agent status icon — single source of truth (DRY, issue #183)
// ---------------------------------------------------------------------------

/** Agent status for icon derivation. */
export type AgentStatus = "running" | "claimed" | "stalled" | "idle" | "expired" | "error";

/** Result of agentStatusIcon(): the symbol and its color. */
export interface AgentStatusBadge {
  readonly icon: string;
  readonly color: string;
}

/**
 * Derive the display icon and color for an agent status.
 *
 * When `spinnerFrame` is provided and status is "running", the icon
 * cycles through the braille spinner. Otherwise uses a static symbol.
 *
 * This replaces the duplicated statusSymbol() / agentSymbol() functions
 * in agent-list.tsx, agent-graph.tsx, running-view.tsx, and agent-split-pane.tsx.
 */
export function agentStatusIcon(
  status: AgentStatus | string,
  spinnerFrame?: number,
): AgentStatusBadge {
  switch (status) {
    case "running":
      return {
        icon:
          spinnerFrame !== undefined
            ? (BRAILLE_SPINNER[spinnerFrame % BRAILLE_SPINNER.length] ?? theme.agentRunning)
            : theme.agentRunning,
        color: theme.running,
      };
    case "claimed":
    case "stalled":
      return { icon: theme.agentWaiting, color: theme.waiting };
    case "expired":
    case "idle":
      return { icon: theme.agentIdle, color: theme.idle };
    case "error":
      return { icon: theme.agentError, color: theme.error };
    default:
      return { icon: theme.agentIdle, color: theme.idle };
  }
}
