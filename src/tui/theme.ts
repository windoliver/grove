/**
 * Centralized theme constants for the TUI.
 *
 * All color and style tokens live here — views import `theme` instead
 * of scattering hex literals across the codebase.
 *
 * Color values are resolved at module load time via `resolveColor()` so the
 * TUI degrades gracefully on terminals with limited color support.
 *
 * Call `configureTheme(overrides)` before React mounts to apply user
 * customization from the config file.  All existing `import { theme }` sites
 * continue to work unchanged — they reference the same mutable object.
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
// 16-color approximation (algorithmic — no manual map needed)
// ---------------------------------------------------------------------------

/**
 * Representative RGB values for the 10 ANSI color names accepted by OpenTUI.
 * Nearest-neighbor distance selects the best name for any input hex color.
 */
const ANSI_16_PALETTE = [
  { name: "black", r: 0, g: 0, b: 0 },
  { name: "red", r: 204, g: 0, b: 0 },
  { name: "green", r: 0, g: 204, b: 0 },
  { name: "yellow", r: 204, g: 204, b: 0 },
  { name: "blue", r: 0, g: 136, b: 204 },
  { name: "magenta", r: 204, g: 0, b: 204 },
  { name: "cyan", r: 0, g: 204, b: 204 },
  { name: "white", r: 255, g: 255, b: 255 },
  { name: "gray", r: 136, g: 136, b: 136 },
  { name: "darkGray", r: 102, g: 102, b: 102 },
] as const;

/** Return the nearest ANSI-16 color name for a hex color string. */
function nearestAnsi16(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best: (typeof ANSI_16_PALETTE)[number] = ANSI_16_PALETTE[0];
  let bestDist = Infinity;
  for (const entry of ANSI_16_PALETTE) {
    const dist = (r - entry.r) ** 2 + (g - entry.g) ** 2 + (b - entry.b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return best.name;
}

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
 * - 16-color: nearest basic ANSI color name (algorithmic)
 */
export function resolveColor(hex: string): string {
  if (!hex.startsWith("#")) return hex; // Already an ANSI name or escape — pass through
  switch (colorDepth) {
    case "truecolor":
      return hex;
    case "256":
      return hexTo256(hex);
    case "16":
      return nearestAnsi16(hex);
  }
}

// ---------------------------------------------------------------------------
// Theme color token interface — user-overridable via configureTheme()
// ---------------------------------------------------------------------------

/** Color-only theme tokens that can be overridden via user config. */
export interface ThemeColorTokens {
  focus: string;
  inactive: string;
  border: string;
  running: string;
  waiting: string;
  idle: string;
  error: string;
  stale: string;
  work: string;
  review: string;
  discussion: string;
  adoption: string;
  reproduction: string;
  text: string;
  secondary: string;
  disabled: string;
  panelBg: string | undefined;
  headerBg: string;
  selectedBg: string;
  success: string;
  warning: string;
  info: string;
  compare: string;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Internal mutable theme store.  Exported as `theme` (readonly view).
 * `configureTheme()` patches this object in-place before React mounts,
 * so all existing `theme.X` import sites see the user's overrides without
 * any code changes.
 */
const _themeStore: {
  focus: string;
  inactive: string;
  border: string;
  running: string;
  waiting: string;
  idle: string;
  error: string;
  stale: string;
  work: string;
  review: string;
  discussion: string;
  adoption: string;
  reproduction: string;
  text: string;
  secondary: string;
  disabled: string;
  panelBg: string | undefined;
  headerBg: string;
  selectedBg: string;
  success: string;
  warning: string;
  info: string;
  compare: string;
  agentRunning: string;
  agentWaiting: string;
  agentIdle: string;
  agentError: string;
  // xray DAG node-status colors (#311)
  statusRunning: string;
  statusDone: string;
  statusFailed: string;
  statusBlocked: string;
  statusAwaitingReview: string;
  statusIdle: string;
  // Filter-highlight foreground for xray DAG (#311)
  highlightMatch: string;
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
  secondary: resolveColor("#888888"),
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

  // Agent status symbols (not color tokens — not overridable via ThemeColorTokens)
  agentRunning: "●",
  agentWaiting: "◐",
  agentIdle: "○",
  agentError: "\u2717",

  // xray DAG node-status colors (#311 task 5)
  statusRunning: resolveColor("#ffcc00"),
  statusDone: resolveColor("#7fbf7f"),
  statusFailed: resolveColor("#ff6666"),
  statusBlocked: resolveColor("#cc66ff"),
  statusAwaitingReview: resolveColor("#7faaff"),
  statusIdle: resolveColor("#7f7f7f"),

  // Filter-highlight foreground for xray DAG (#311 task 5)
  highlightMatch: resolveColor("#ffff66"),
};

/**
 * Readonly view of the theme — same object reference as `_themeStore`.
 * Components import this and access `theme.focus`, `theme.running`, etc.
 * Calling `configureTheme()` before React mounts updates the values in-place.
 */
export const theme: Readonly<typeof _themeStore> = _themeStore;

/**
 * Apply user theme overrides from config.
 *
 * Must be called before React mounts (e.g. in main.ts after loading config).
 * Mutates `_themeStore` in-place so all existing `theme.X` references see
 * the updated values on first render.
 */
export function configureTheme(overrides: Partial<ThemeColorTokens>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (key in _themeStore && typeof value === "string") {
      (_themeStore as Record<string, unknown>)[key] = resolveColor(value);
    }
  }
}

/** Return the current theme (same as the exported `theme` constant). */
export function getTheme(): Readonly<typeof _themeStore> {
  return _themeStore;
}

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
