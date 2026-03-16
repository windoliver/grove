/**
 * Terminal view — shows captured output from the selected agent's tmux session.
 *
 * Uses @xterm/headless for full VT emulation (colors, cursor, SGR, scrolling
 * regions) in pure JS — no native dependencies. Each agent gets a persistent
 * Terminal instance that maintains state across .write() calls, so only new
 * bytes are fed on each poll cycle.
 *
 * The rendered output preserves ANSI colors: each cell's foreground color is
 * read from the xterm buffer and applied via OpenTUI's <text color> prop.
 *
 * Diff-aware coloring: lines matching unified diff patterns (@@, +, -)
 * get tinted backgrounds for instant scannability.
 *
 * Falls back to plain text when xterm headless is not available.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { TmuxManager } from "../agents/tmux-manager.js";
import type { InputMode } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { theme } from "../theme.js";

// ---------------------------------------------------------------------------
// Persistent terminal cache with lifecycle management (3A)
// ---------------------------------------------------------------------------

interface PersistentTerminal {
  terminal: import("@xterm/headless").Terminal;
  prevLength: number;
  prevContent: string;
  lastAccessed: number;
}

/** Maximum number of cached terminals before eviction. */
const MAX_CACHED_TERMINALS = 50;

const agentTerminals = new Map<string, PersistentTerminal>();

/** Evict least-recently-used terminals when cache exceeds limit. */
function evictStaleTerminals(): void {
  if (agentTerminals.size <= MAX_CACHED_TERMINALS) return;

  const entries = [...agentTerminals.entries()].sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed,
  );
  const toEvict = entries.slice(0, agentTerminals.size - MAX_CACHED_TERMINALS);
  for (const [key, pt] of toEvict) {
    pt.terminal.dispose();
    agentTerminals.delete(key);
  }
}

/** Dispose terminals for sessions that are no longer active. */
export function disposeInactiveTerminals(activeSessions: ReadonlySet<string>): void {
  for (const [key, pt] of agentTerminals) {
    if (!activeSessions.has(key)) {
      pt.terminal.dispose();
      agentTerminals.delete(key);
    }
  }
}

let xtermModule: typeof import("@xterm/headless") | null = null;
let xtermLoadFailed = false;

async function getXterm(): Promise<typeof import("@xterm/headless") | null> {
  if (xtermModule) return xtermModule;
  if (xtermLoadFailed) return null;
  try {
    xtermModule = await import("@xterm/headless");
    return xtermModule;
  } catch {
    xtermLoadFailed = true;
    return null;
  }
}

function getAgentTerminal(
  sessionName: string,
  xterm: typeof import("@xterm/headless"),
): PersistentTerminal {
  let pt = agentTerminals.get(sessionName);
  if (!pt) {
    pt = {
      terminal: new xterm.Terminal({ cols: 120, rows: 30, scrollback: 1000 }),
      prevLength: 0,
      prevContent: "",
      lastAccessed: Date.now(),
    };
    agentTerminals.set(sessionName, pt);
    evictStaleTerminals();
  } else {
    pt.lastAccessed = Date.now();
  }
  return pt;
}

function feedTerminal(pt: PersistentTerminal, rawOutput: string): void {
  if (rawOutput.length > pt.prevLength && rawOutput.startsWith(pt.prevContent)) {
    const delta = rawOutput.slice(pt.prevLength);
    pt.terminal.write(delta);
  } else if (rawOutput !== pt.prevContent) {
    pt.terminal.reset();
    pt.terminal.write(rawOutput);
  }
  pt.prevLength = rawOutput.length;
  pt.prevContent = rawOutput;
}

// ---------------------------------------------------------------------------
// Pre-computed ANSI color palette (13C)
// ---------------------------------------------------------------------------

/** A run of characters sharing the same foreground color. */
interface StyledSpan {
  text: string;
  color: string | undefined;
  bold: boolean;
  bgColor?: string | undefined;
}

/** A line of styled spans extracted from the xterm buffer. */
interface StyledLine {
  spans: StyledSpan[];
}

/** ANSI 16-color palette mapped to hex. */
const ANSI_16: readonly string[] = [
  "#000000",
  "#cc0000",
  "#00cc00",
  "#cccc00",
  "#0088cc",
  "#cc00cc",
  "#00cccc",
  "#cccccc",
  "#555555",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0088ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

/**
 * Pre-computed lookup table for all 256 ANSI indexed colors → hex.
 * Built once at module load time to avoid per-cell recomputation.
 */
const ANSI_256_PALETTE: readonly (string | undefined)[] = (() => {
  const palette: (string | undefined)[] = new Array(256);

  // 0-15: standard ANSI colors
  for (let i = 0; i < 16; i++) {
    palette[i] = ANSI_16[i];
  }

  // 16-231: 6x6x6 color cube
  for (let i = 16; i < 232; i++) {
    const idx = i - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    palette[i] =
      `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  // 232-255: grayscale ramp
  for (let i = 232; i < 256; i++) {
    const v = (i - 232) * 10 + 8;
    palette[i] =
      `#${v.toString(16).padStart(2, "0")}${v.toString(16).padStart(2, "0")}${v.toString(16).padStart(2, "0")}`;
  }

  return palette;
})();

/** RGB hex cache for true-color values. */
const rgbHexCache = new Map<number, string>();

/** Convert an xterm color to hex using pre-computed palette. */
function cellColorToHex(
  color: number,
  isRgb: boolean,
  r: number,
  g: number,
  b: number,
): string | undefined {
  if (isRgb) {
    const key = (r << 16) | (g << 8) | b;
    let hex = rgbHexCache.get(key);
    if (hex === undefined) {
      hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      rgbHexCache.set(key, hex);
    }
    return hex;
  }
  // Indexed color: O(1) lookup in pre-computed palette
  if (color >= 0 && color < 256) {
    return ANSI_256_PALETTE[color];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Diff-aware terminal coloring (16A)
// ---------------------------------------------------------------------------

/** Background tint colors for unified diff lines. */
const DIFF_BG = {
  hunk: "#1a1a3a", // blue tint for @@ hunk headers
  add: "#1a2a1a", // green tint for + lines
  remove: "#2a1a1a", // red tint for - lines
} as const;

/** Detect unified diff pattern and return appropriate background color. */
function diffLineBgColor(lineText: string): string | undefined {
  if (lineText.startsWith("@@")) return DIFF_BG.hunk;
  if (lineText.startsWith("+")) return DIFF_BG.add;
  if (lineText.startsWith("-")) return DIFF_BG.remove;
  return undefined;
}

// ---------------------------------------------------------------------------
// Styled line extraction with diff detection
// ---------------------------------------------------------------------------

/** Extract styled lines from an xterm terminal buffer. */
function extractStyledLines(terminal: import("@xterm/headless").Terminal): StyledLine[] {
  const buf = terminal.buffer.active;
  const lines: StyledLine[] = [];
  const cell = terminal.buffer.active.getNullCell();

  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;

    const spans: StyledSpan[] = [];
    let currentText = "";
    let currentColor: string | undefined;
    let currentBold = false;

    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (!cell) continue;

      const char = cell.getChars();
      const fg = cell.getFgColor();
      const isFgRgb = cell.isFgRGB();
      const fgColor =
        fg === 0 && !isFgRgb
          ? undefined
          : cellColorToHex(fg, isFgRgb, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
      const bold = cell.isBold() !== 0;

      if (fgColor !== currentColor || bold !== currentBold) {
        if (currentText) {
          spans.push({ text: currentText, color: currentColor, bold: currentBold });
        }
        currentText = char;
        currentColor = fgColor;
        currentBold = bold;
      } else {
        currentText += char;
      }
    }

    if (currentText) {
      spans.push({ text: currentText, color: currentColor, bold: currentBold });
    }

    // Detect diff lines and apply background tint
    const plainText = spans.map((s) => s.text).join("");
    const bg = diffLineBgColor(plainText);
    if (bg) {
      for (const span of spans) {
        span.bgColor = bg;
      }
    }

    lines.push({ spans });
  }

  // Trim trailing empty lines
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (!last || last.spans.every((s) => s.text.trim() === "")) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Number of visible terminal lines. */
const VIEWPORT_LINES = 30;

export interface TerminalProps {
  readonly sessionName?: string | undefined;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly mode: InputMode;
  /** Scroll offset from the bottom (0 = auto-scroll, >0 = pinned). */
  readonly scrollOffset?: number | undefined;
  /** Callback when the user scrolls (changes offset). */
  readonly onScrollChange?: ((offset: number) => void) | undefined;
}

export const TerminalView: React.NamedExoticComponent<TerminalProps> = React.memo(
  function TerminalView({
    sessionName,
    tmux,
    intervalMs,
    active,
    mode,
    scrollOffset,
    onScrollChange: _onScrollChange,
  }: TerminalProps): React.ReactNode {
    void _onScrollChange; // available for parent scroll tracking
    const captureMs = Math.max(intervalMs, 200);
    const [xtermReady, setXtermReady] = useState(xtermModule !== null);

    useEffect(() => {
      if (xtermModule) {
        setXtermReady(true);
        return;
      }
      let cancelled = false;
      getXterm().then((mod) => {
        if (!cancelled && mod) setXtermReady(true);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    useEffect(() => {
      if (sessionName) {
        const pt = agentTerminals.get(sessionName);
        if (pt) {
          pt.terminal.reset();
          pt.prevLength = 0;
          pt.prevContent = "";
        }
      }
    }, [sessionName]);

    const fetcher = useCallback(async () => {
      if (!tmux || !sessionName) return "";
      return tmux.capturePanes(sessionName);
    }, [tmux, sessionName]);

    const { data: output } = usePolledData<string>(
      fetcher,
      captureMs,
      active && !!sessionName && !!tmux,
    );

    // Feed output and extract styled lines (memoized — only recomputes when output changes)
    const styledLines = useMemo((): StyledLine[] | null => {
      const rawOutput = output ?? "";
      if (!rawOutput || !xtermReady || !xtermModule || !sessionName) return null;

      const pt = getAgentTerminal(sessionName, xtermModule);
      feedTerminal(pt, rawOutput);
      return extractStyledLines(pt.terminal);
    }, [output, xtermReady, sessionName]);

    if (!tmux) {
      return (
        <box>
          <text opacity={0.5}>Terminal requires tmux — not available</text>
        </box>
      );
    }

    if (!sessionName) {
      return (
        <box flexDirection="column">
          <text opacity={0.5}>Select an agent (panel 5) to view terminal output</text>
          <text opacity={0.5}>Press i to enter input mode, Esc to exit</text>
        </box>
      );
    }

    const isInputMode = mode === "terminal_input";

    const header = (
      <box>
        <text color={theme.muted}>
          session: {sessionName}
          {isInputMode ? (
            <text color={theme.focus}> [INPUT]</text>
          ) : (
            <text opacity={0.5}> (press i to type)</text>
          )}
        </text>
      </box>
    );

    const offset = scrollOffset ?? 0;
    const isPinned = offset > 0;

    // Styled rendering via xterm buffer
    if (styledLines && styledLines.length > 0) {
      const total = styledLines.length;
      const end = Math.max(0, total - offset);
      const start = Math.max(0, end - VIEWPORT_LINES);
      const displayLines = styledLines.slice(start, end);
      return (
        <box flexDirection="column">
          {header}
          {isPinned && (
            <box>
              <text color={theme.warning}>[pinned \u2193]</text>
            </box>
          )}
          <box flexDirection="column">
            {displayLines.map((line, y) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: terminal lines have no stable identity
              <box key={y}>
                {line.spans.map((span, x) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: spans have no stable identity
                  <text key={x} color={span.color} bold={span.bold} backgroundColor={span.bgColor}>
                    {span.text}
                  </text>
                ))}
              </box>
            ))}
          </box>
        </box>
      );
    }

    // Plain text fallback
    const rawOutput = (output ?? "").trimEnd();
    const allLines = rawOutput ? rawOutput.split("\n") : [];
    const plainEnd = Math.max(0, allLines.length - offset);
    const plainStart = Math.max(0, plainEnd - VIEWPORT_LINES);
    const lines = allLines.slice(plainStart, plainEnd);

    return (
      <box flexDirection="column">
        {header}
        {lines.length > 0 ? (
          <box flexDirection="column">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: terminal lines have no stable identity
              <text key={i}>{line}</text>
            ))}
          </box>
        ) : (
          <text opacity={0.5}>(no output)</text>
        )}
      </box>
    );
  },
);
