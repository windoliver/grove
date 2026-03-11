/**
 * Artifact preview panel — shows artifact content based on media type.
 *
 * - JSON/text/markdown: raw content (first 100 lines)
 * - Binary/large: hex dump header (first 256 bytes)
 * - Missing/empty: placeholder message
 */

import React, { useCallback, useMemo } from "react";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ArtifactMeta, TuiArtifactProvider, TuiDataProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum lines of text content to display. */
const MAX_TEXT_LINES = 100;

/** Maximum bytes to show in hex dump. */
const MAX_HEX_BYTES = 256;

/** Bytes per row in hex dump display. */
const HEX_BYTES_PER_ROW = 16;

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
 * Compute a simple unified diff between two text strings.
 *
 * Uses a basic line-by-line longest common subsequence (LCS) approach.
 * Suitable for small artifacts displayed in the TUI.
 */
function computeUnifiedDiff(
  parentText: string,
  childText: string,
  parentLabel: string,
  childLabel: string,
): string {
  const parentLines = parentText.split("\n");
  const childLines = childText.split("\n");

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

  // Backtrack to produce diff lines
  const result: string[] = [`--- ${parentLabel}`, `+++ ${childLabel}`];
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
  result.push(...diffLines);
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
  readonly intervalMs: number;
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
    intervalMs,
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

    const { data, loading, error } = usePolledData<ArtifactData | undefined>(
      fetcher,
      intervalMs,
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
    } = usePolledData<DiffData | undefined>(
      diffFetcher,
      intervalMs,
      active && showDiff && parentCid !== undefined,
    );

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
    const preview = useMemo((): { readonly header: string; readonly body: string } => {
      if (!cid || !artifactName) {
        return { header: "", body: "(no artifact selected)" };
      }

      if (!artifactProvider) {
        return {
          header: artifactName,
          body: "(artifact preview not available — provider does not support artifacts)",
        };
      }

      if (loading && !data) {
        return { header: artifactName, body: "Loading..." };
      }

      if (error && !data) {
        return { header: artifactName, body: `Error: ${error.message}` };
      }

      if (!data) {
        return { header: artifactName, body: "(no data)" };
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
        return { header, body: "(empty artifact)" };
      }

      if (isTextContent(artifactName, meta.mediaType)) {
        const text = content.toString("utf-8");
        const lines = text.split("\n");
        const truncated = lines.slice(0, MAX_TEXT_LINES);
        const body =
          truncated.join("\n") +
          (lines.length > MAX_TEXT_LINES
            ? `\n... (${lines.length - MAX_TEXT_LINES} more lines)`
            : "");
        return { header, body };
      }

      // Binary content — show hex dump
      const hexBody = formatHexDump(content);
      const suffix =
        content.length > MAX_HEX_BYTES
          ? `\n... (${content.length - MAX_HEX_BYTES} more bytes)`
          : "";
      return { header, body: hexBody + suffix };
    }, [cid, artifactName, artifactProvider, data, loading, error]);

    // Compute diff body
    const diffBody = useMemo((): string | undefined => {
      if (!showDiff || !parentCid) return undefined;
      if (diffLoading && !diffData) return "Loading diff...";
      if (diffError && !diffData) return `Diff error: ${diffError.message}`;
      if (!diffData) return "(no diff data)";
      return computeUnifiedDiff(
        diffData.parentText,
        diffData.childText,
        `parent (${parentCid.slice(0, 8)})`,
        `child (${(cid ?? "").slice(0, 8)})`,
      );
    }, [showDiff, parentCid, cid, diffData, diffLoading, diffError]);

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
            <text color="#888888">{selectorHeader}</text>
          </box>
        )}
        <box marginBottom={1}>
          <text color="#00cccc">{preview.header}</text>
          {hasDiffSupport && (
            <text color={showDiff ? "#ffcc00" : "#666666"}>
              {showDiff ? "  [DIFF ON]" : "  [d]iff"}
            </text>
          )}
        </box>
        <box>
          <text>{diffBody ?? preview.body}</text>
        </box>
      </box>
    );
  },
);
