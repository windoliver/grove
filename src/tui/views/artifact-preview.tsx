/**
 * Artifact preview panel — shows artifact content based on media type.
 *
 * - Markdown (.md): rendered via <markdown>
 * - Code files: syntax-highlighted via <code> with language detection
 * - Plain text: scrollable raw content
 * - Binary/large: hex dump header (first 256 bytes)
 * - Empty artifacts: styled empty state with artifact name and hint
 */

import React, { useCallback, useMemo } from "react";
import { DataStatus } from "../components/data-status.js";
import { useAccentPulse } from "../hooks/use-accent-pulse.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { ArtifactMeta, TuiArtifactProvider, TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum lines of text content to display. */
const MAX_TEXT_LINES = 100;

/** Maximum bytes to show in hex dump. */
const MAX_HEX_BYTES = 256;

/** Bytes per row in hex dump display. */
const HEX_BYTES_PER_ROW = 16;

/**
 * Maximum number of lines fed into the O(m*n) LCS diff. The unified-diff path
 * is now the headline render for artifact comparison, so guard it against OOM:
 * inputs beyond this are truncated (with a visible marker) before diffing.
 */
const MAX_DIFF_LINES = 2000;

/** Extensions considered text-based. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".sh",
  ".log",
  ".cfg",
  ".ini",
  ".env",
  ".sql",
]);

/** Media types considered text-based. */
const TEXT_MEDIA_PREFIXES: readonly string[] = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract extension from an artifact name. */
function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * Map a file name to a tree-sitter language identifier for <code>.
 * Returns undefined for unknown or plain-text extensions.
 */
function detectLanguage(name: string): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    go: "go",
    rs: "rust",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    css: "css",
    html: "html",
    sql: "sql",
    c: "c",
    cpp: "cpp",
    h: "c",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    zig: "zig",
    xml: "xml",
  };
  return ext ? map[ext] : undefined;
}

/** Return true when a buffer contains non-printable bytes (likely binary). */
function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 512);
  for (let i = 0; i < checkLen; i++) {
    const b = buf[i];
    // Null byte or control characters below HT (\x09) indicate binary
    if (b !== undefined && (b === 0x00 || b < 0x09)) return true;
  }
  return false;
}

/** Determine whether content is text-like from name and/or mediaType. */
function isTextContent(name: string, mediaType: string | undefined): boolean {
  if (TEXT_EXTENSIONS.has(getExtension(name))) return true;
  if (mediaType) {
    for (const prefix of TEXT_MEDIA_PREFIXES) {
      if (mediaType.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Format a buffer slice as a hex dump string. */
function formatHexDump(buf: Buffer): string {
  const length = Math.min(buf.length, MAX_HEX_BYTES);
  const lines: string[] = [];

  for (let offset = 0; offset < length; offset += HEX_BYTES_PER_ROW) {
    const slice = buf.subarray(offset, Math.min(offset + HEX_BYTES_PER_ROW, length));
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");

    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("");

    const addr = offset.toString(16).padStart(8, "0");
    lines.push(`${addr}  ${hex.padEnd(HEX_BYTES_PER_ROW * 3 - 1)}  |${ascii}|`);
  }

  return lines.join("\n");
}

/**
 * Split artifact text into unified-diff content lines.
 *
 * An empty file is ZERO lines (not one blank line), and a single trailing
 * newline is the line terminator, not an extra blank line — so `""` -> `[]`
 * and `"a\nb\n"` -> `["a", "b"]`. Without this, empty/added/deleted artifacts
 * would emit bogus hunks (e.g. a removed blank line for a pure addition).
 */
function toDiffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Compute a simple unified diff between two text strings.
 *
 * Uses a basic line-by-line longest common subsequence (LCS) approach.
 * Suitable for small artifacts displayed in the TUI.
 *
 * The output is a valid unified-diff string accepted by the "diff" package's
 * parsePatch (used by the OpenTUI <diff> intrinsic): `--- parent`, `+++ child`,
 * a single `@@ -1,old +1,new @@` hunk header, then the body. parsePatch
 * REQUIRES the hunk header and validates the declared line counts against the
 * body, so the counts are computed from the actual emitted body lines.
 *
 * Exported for unit testing of that parser contract.
 */
export function computeUnifiedDiff(
  parentText: string,
  childText: string,
  parentLabel: string,
  childLabel: string,
): string {
  // OOM hardening: cap inputs before the O(m*n) LCS. Truncate (never silently)
  // and append a visible marker to the diff body so the cut is observable.
  const rawParentLines = toDiffLines(parentText);
  const rawChildLines = toDiffLines(childText);
  const parentTruncated = rawParentLines.length > MAX_DIFF_LINES;
  const childTruncated = rawChildLines.length > MAX_DIFF_LINES;
  const parentLines = parentTruncated ? rawParentLines.slice(0, MAX_DIFF_LINES) : rawParentLines;
  const childLines = childTruncated ? rawChildLines.slice(0, MAX_DIFF_LINES) : rawChildLines;

  // Build LCS table
  const m = parentLines.length;
  const n = childLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    const row = dp[i];
    const prevRow = dp[i - 1];
    if (!row || !prevRow) continue;
    for (let j = 1; j <= n; j++) {
      row[j] =
        parentLines[i - 1] === childLines[j - 1]
          ? (prevRow[j - 1] ?? 0) + 1
          : Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
    }
  }

  // Backtrack to produce diff body lines
  const diffLines: string[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && parentLines[i - 1] === childLines[j - 1]) {
      diffLines.push(` ${parentLines[i - 1] ?? ""}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      diffLines.push(`+${childLines[j - 1] ?? ""}`);
      j--;
    } else {
      diffLines.push(`-${parentLines[i - 1] ?? ""}`);
      i--;
    }
  }

  diffLines.reverse();

  // Visible (never silent) truncation marker, emitted as a context line so it
  // is counted equally toward both old and new line counts.
  if (parentTruncated || childTruncated) {
    diffLines.push(` ... (diff truncated to first ${MAX_DIFF_LINES} lines)`);
  }

  // parsePatch requires a hunk header and validates its declared line counts
  // against the body. Compute the counts from the ACTUAL emitted body lines so
  // they always match: old = context + removals, new = context + additions.
  let oldCount = 0;
  let newCount = 0;
  for (const line of diffLines) {
    if (line.startsWith(" ")) {
      oldCount++;
      newCount++;
    } else if (line.startsWith("-")) {
      oldCount++;
    } else if (line.startsWith("+")) {
      newCount++;
    }
  }

  const result: string[] = [`--- ${parentLabel}`, `+++ ${childLabel}`];
  // No body => no change (e.g. identical or two empty files): emit just the
  // file headers with no hunk. parsePatch returns zero hunks and does not
  // throw. Emitting a hunk here would fabricate a change.
  if (diffLines.length > 0) {
    // A zero-count side starts at line 0 (unified-diff convention for an
    // added/deleted file), e.g. `@@ -0,0 +1,3 @@` for a pure addition.
    const oldStart = oldCount === 0 ? 0 : 1;
    const newStart = newCount === 0 ? 0 : 1;
    result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...diffLines);
  }
  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Fetched artifact data (combined meta + content)
// ---------------------------------------------------------------------------

/** Combined artifact fetch result. */
interface ArtifactData {
  readonly meta: ArtifactMeta;
  readonly content: Buffer;
}

/** Diff data between parent and child artifacts. */
interface DiffData {
  readonly parentText: string;
  readonly childText: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props for the ArtifactPreview view. */
export interface ArtifactPreviewProps {
  readonly provider: TuiDataProvider;
  readonly cid?: string | undefined;
  readonly artifactName?: string | undefined;
  /** All artifact names for cycling display. */
  readonly allArtifactNames?: readonly string[] | undefined;
  /** Current index into allArtifactNames (for the header indicator). */
  readonly artifactIndex?: number | undefined;
  /** Parent CID (from derives_from relation) for diff support. */
  readonly parentCid?: string | undefined;
  /** Whether to show diff view instead of content view. */
  readonly showDiff?: boolean | undefined;
  /** Diff rendering mode: inline (unified) or side-by-side (split). */
  readonly diffMode?: "inline" | "split" | undefined;
  /** Unused after A8.4 migration to useEventDrivenData; kept for caller-stability. */
  readonly intervalMs?: number;
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Artifact preview panel component. */
export const ArtifactPreviewView: React.NamedExoticComponent<ArtifactPreviewProps> = React.memo(
  function ArtifactPreviewView({
    provider,
    cid,
    artifactName,
    allArtifactNames,
    artifactIndex,
    parentCid,
    showDiff,
    diffMode = "inline",
    active,
  }: ArtifactPreviewProps): React.ReactNode {
    const artifactProvider = provider.capabilities.artifacts
      ? (provider as unknown as TuiArtifactProvider)
      : undefined;

    // Fetch artifact content
    const fetcher = useCallback(async (): Promise<ArtifactData | undefined> => {
      if (!artifactProvider || !cid || !artifactName) return undefined;

      const [meta, content] = await Promise.all([
        artifactProvider.getArtifactMeta(cid, artifactName),
        artifactProvider.getArtifact(cid, artifactName),
      ]);

      return { meta, content };
    }, [artifactProvider, cid, artifactName]);

    const { data, loading, error, isStale } = useEventDrivenData<ArtifactData | undefined>(
      fetcher,
      undefined,
      undefined,
      active,
    );

    // Fetch diff data when parentCid is available and diff mode is on
    const diffFetcher = useCallback(async (): Promise<DiffData | undefined> => {
      if (!artifactProvider || !parentCid || !cid || !artifactName) return undefined;
      const result = await artifactProvider.diffArtifacts(parentCid, cid, artifactName);
      return { parentText: result.parent, childText: result.child };
    }, [artifactProvider, parentCid, cid, artifactName]);

    const {
      data: diffData,
      loading: diffLoading,
      error: diffError,
    } = useEventDrivenData<DiffData | undefined>(
      diffFetcher,
      undefined,
      undefined,
      active && showDiff === true && parentCid !== undefined,
    );

    // Focus-change accent pulse (#192): a brief (~150ms) warning-colored flash
    // on the header each time the selected artifact changes.
    const pulse = useAccentPulse(artifactIndex);

    // Build artifact selector header
    const selectorHeader = useMemo((): string => {
      const names = allArtifactNames ?? [];
      if (names.length === 0) return "";
      const idx = artifactIndex ?? 0;
      const name: string = names[idx] ?? names[0] ?? "";
      if (names.length === 1) return name;
      return `< ${name} > (${idx + 1}/${names.length})`;
    }, [allArtifactNames, artifactIndex]);

    // Compute preview content from fetched data
    const preview = useMemo((): {
      readonly header: string;
      readonly body: string;
      /** How the body should be rendered. */
      readonly renderAs: "markdown" | "code" | "hex" | "empty" | "text";
      /** Language identifier for <code> rendering. */
      readonly language?: string | undefined;
    } => {
      if (!cid || !artifactName) {
        return { header: "", body: "(no artifact selected)", renderAs: "text" };
      }

      if (!artifactProvider) {
        return {
          header: artifactName,
          body: "(artifact preview not available — provider does not support artifacts)",
          renderAs: "text",
        };
      }

      if (loading && !data) {
        return { header: artifactName, body: "Loading...", renderAs: "text" };
      }

      if (error && !data) {
        return { header: artifactName, body: `Error: ${error.message}`, renderAs: "text" };
      }

      if (!data) {
        return { header: artifactName, body: "(no data)", renderAs: "text" };
      }

      const { meta, content } = data;
      const sizeLabel =
        meta.sizeBytes < 1024
          ? `${meta.sizeBytes} B`
          : meta.sizeBytes < 1024 * 1024
            ? `${(meta.sizeBytes / 1024).toFixed(1)} KB`
            : `${(meta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

      const typeLabel = meta.mediaType ?? "unknown";
      const header = `${artifactName}  (${sizeLabel}, ${typeLabel})`;

      if (content.length === 0) {
        return { header, body: "", renderAs: "empty" };
      }

      // Markdown files — render with <markdown>, capped to prevent render stalls
      const MAX_PREVIEW_TEXT = 64 * 1024;
      if (/\.md$/i.test(artifactName)) {
        const raw = content.toString("utf-8");
        const text =
          raw.length > MAX_PREVIEW_TEXT
            ? `${raw.slice(0, MAX_PREVIEW_TEXT)}\n\n--- truncated (${raw.length} bytes total) ---`
            : raw;
        return { header, body: text, renderAs: "markdown" };
      }

      // Binary detection — check actual bytes rather than extension only
      if (!isTextContent(artifactName, meta.mediaType) || isBinaryBuffer(content)) {
        const hexBody = formatHexDump(content);
        const suffix =
          content.length > MAX_HEX_BYTES
            ? `\n... (${content.length - MAX_HEX_BYTES} more bytes)`
            : "";
        return { header, body: hexBody + suffix, renderAs: "hex" };
      }

      // Text / code content
      const text = content.toString("utf-8");
      const lines = text.split("\n");
      const truncated = lines.slice(0, MAX_TEXT_LINES);
      const body =
        truncated.join("\n") +
        (lines.length > MAX_TEXT_LINES
          ? `\n... (${lines.length - MAX_TEXT_LINES} more lines)`
          : "");

      const lang = detectLanguage(artifactName);
      if (lang !== undefined) {
        return { header, body, renderAs: "code", language: lang };
      }

      return { header, body, renderAs: "text" };
    }, [cid, artifactName, artifactProvider, data, loading, error]);

    // Whether the diff view is the active surface (vs. content render).
    const showDiffView = Boolean(showDiff && parentCid);

    // The successful diff is rendered via the <diff> intrinsic, which parses a
    // unified-diff-format STRING (see Diff.d.ts). computeUnifiedDiff produces
    // exactly that string. Loading/error/no-data are rendered as <text> below.
    const unifiedDiff = useMemo((): string | undefined => {
      if (!showDiffView || !diffData) return undefined;
      return computeUnifiedDiff(
        diffData.parentText,
        diffData.childText,
        `parent (${(parentCid ?? "").slice(0, 8)})`,
        `child (${(cid ?? "").slice(0, 8)})`,
      );
    }, [showDiffView, parentCid, cid, diffData]);

    if (!cid || !artifactName) {
      return (
        <box>
          <text opacity={0.5}>(no artifact selected)</text>
        </box>
      );
    }

    const hasDiffSupport = Boolean(parentCid && artifactProvider);

    return (
      <box flexDirection="column">
        {/* Artifact selector header */}
        {selectorHeader && (
          <box marginBottom={0}>
            <text color={theme.secondary}>{selectorHeader}</text>
          </box>
        )}
        <box marginBottom={1} flexDirection="row">
          <text color={pulse ? theme.warning : theme.focus}>{preview.header}</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          {hasDiffSupport && (
            <text color={showDiff ? theme.warning : theme.secondary}>
              {showDiff ? `  [DIFF ${diffMode}]  [s]plit/inline` : "  [d]iff"}
            </text>
          )}
        </box>
        <box flexGrow={1}>
          {showDiffView ? (
            // Diff view — rendered via OpenTUI <diff> intrinsic (unified/split).
            // Loading/error/no-data fall back to plain text.
            diffLoading && !diffData ? (
              <text>Loading diff...</text>
            ) : diffError && !diffData ? (
              <text color={theme.error}>{`Diff error: ${diffError.message}`}</text>
            ) : !diffData || unifiedDiff === undefined ? (
              <text opacity={0.5}>(no diff data)</text>
            ) : !unifiedDiff.includes("\n@@ ") ? (
              // Header-only diff = no changes (identical or two empty files).
              // Render an explicit state rather than feeding an empty diff to
              // the <diff> intrinsic: DiffRenderable.buildView early-returns for
              // zero-hunk input WITHOUT clearing its existing child renderables,
              // so a reused instance would keep showing the PREVIOUS comparison.
              <box paddingTop={1}>
                <text color={theme.secondary} italic>
                  (no changes between the two versions)
                </text>
              </box>
            ) : (
              React.createElement(
                "scrollbox" as string,
                { flexGrow: 1 },
                React.createElement("diff" as string, {
                  // Remount when the comparison identity changes so OpenTUI
                  // can't carry stale left/right renderables across artifacts.
                  key: `${parentCid ?? ""}:${cid ?? ""}:${artifactName ?? ""}`,
                  diff: unifiedDiff,
                  view: diffMode === "split" ? "split" : "unified",
                  filetype: detectLanguage(artifactName ?? ""),
                }),
              )
            )
          ) : preview.renderAs === "empty" ? (
            // Empty artifact — styled empty state
            <box flexDirection="column" paddingTop={1}>
              <text color={theme.secondary} italic>
                {artifactName} is empty.
              </text>
              <text color={theme.secondary} opacity={0.7}>
                The artifact exists but has no content yet.
              </text>
            </box>
          ) : preview.renderAs === "markdown" ? (
            // Markdown — rendered via OpenTUI <markdown>
            React.createElement(
              "scrollbox" as string,
              { flexGrow: 1 },
              React.createElement("markdown" as string, {}, preview.body),
            )
          ) : preview.renderAs === "code" ? (
            // Code — syntax-highlighted via OpenTUI <code>
            React.createElement(
              "scrollbox" as string,
              { flexGrow: 1 },
              React.createElement(
                "code" as string,
                { language: preview.language ?? "text" },
                preview.body,
              ),
            )
          ) : preview.renderAs === "hex" ? (
            // Binary hex dump — monospace plain text
            React.createElement(
              "scrollbox" as string,
              { flexGrow: 1 },
              React.createElement("text", { color: theme.secondary }, preview.body),
            )
          ) : (
            // Plain text
            React.createElement(
              "scrollbox" as string,
              { flexGrow: 1 },
              React.createElement("text", {}, preview.body),
            )
          )}
        </box>
      </box>
    );
  },
);
