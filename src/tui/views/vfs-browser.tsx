/**
 * VFS browser view — browse Nexus zone VFS tree with file preview.
 *
 * Only available when provider supports TuiVfsProvider (capabilities.vfs).
 * Shows a split-pane layout: left=file tree, right=file preview.
 */

import React, { createElement, useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { FsEntry, TuiDataProvider, TuiVfsProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the VFS browser view. */
export interface VfsBrowserProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  /** Incremented by parent when Enter is pressed; triggers navigation into directories. */
  readonly navigateTrigger?: number | undefined;
}

const COLUMNS = [
  { header: "NAME", key: "name", width: 32 },
  { header: "TYPE", key: "type", width: 10 },
  { header: "SIZE", key: "size", width: 12 },
] as const;

/** Check if provider supports VFS. */
function isVfsProvider(provider: TuiDataProvider): provider is TuiDataProvider & TuiVfsProvider {
  return provider.capabilities.vfs && "listPath" in provider;
}

/** Format bytes to human-readable. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Map file extension to tree-sitter language identifier. */
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
    txt: "text",
  };
  return ext ? map[ext] : undefined;
}

/** Returns true when the file name has a .md extension. */
function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name);
}

// ---------------------------------------------------------------------------
// Hex dump helper (first 256 bytes)
// ---------------------------------------------------------------------------

const MAX_HEX_BYTES = 256;
const HEX_BYTES_PER_ROW = 16;

/** Format a buffer slice as an annotated hex dump string. */
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

/** Return true when a buffer contains non-printable bytes (likely binary). */
function isBinaryContent(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 512);
  for (let i = 0; i < checkLen; i++) {
    const b = buf[i];
    if (b !== undefined && b < 0x09) return true; // below tab
    if (b !== undefined && b === 0x00) return true; // null byte
  }
  return false;
}

// ---------------------------------------------------------------------------
// File preview pane
// ---------------------------------------------------------------------------

interface FilePreviewProps {
  readonly name: string;
  readonly content: Buffer | null;
  readonly loading: boolean;
  readonly error: Error | null;
}

/** Renders the right-side file preview pane. */
function FilePreview({ name, content, loading, error }: FilePreviewProps): React.ReactNode {
  if (loading && content === null) {
    return (
      <box flexDirection="column">
        <text color={theme.muted}>Loading {name}…</text>
      </box>
    );
  }

  if (error) {
    return (
      <box flexDirection="column">
        <text color={theme.error}>Error: {error.message}</text>
      </box>
    );
  }

  if (content === null) {
    return (
      <box flexDirection="column">
        <text color={theme.muted}>Select a file to preview.</text>
      </box>
    );
  }

  if (content.length === 0) {
    return (
      <box flexDirection="column">
        <text color={theme.muted} italic>
          Empty file
        </text>
      </box>
    );
  }

  const lang = detectLanguage(name);

  if (isMarkdownFile(name)) {
    const text = content.toString("utf-8");
    return createElement(
      "scrollbox" as string,
      { flexGrow: 1 },
      createElement("markdown" as string, {}, text),
    );
  }

  if (isBinaryContent(content)) {
    const hexDump = formatHexDump(content);
    const suffix =
      content.length > MAX_HEX_BYTES ? `\n… (${content.length - MAX_HEX_BYTES} more bytes)` : "";
    return createElement(
      "scrollbox" as string,
      { flexGrow: 1 },
      React.createElement("text", { color: theme.muted }, hexDump + suffix),
    );
  }

  const text = content.toString("utf-8");

  if (lang !== undefined && lang !== "text") {
    return createElement(
      "scrollbox" as string,
      { flexGrow: 1 },
      createElement("code" as string, { language: lang }, text),
    );
  }

  return createElement(
    "scrollbox" as string,
    { flexGrow: 1 },
    React.createElement("text", {}, text),
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/** VFS browser view component. */
export const VfsBrowserView: React.NamedExoticComponent<VfsBrowserProps> = React.memo(
  function VfsBrowserView({
    provider,
    intervalMs,
    active,
    cursor,
    navigateTrigger,
  }: VfsBrowserProps): React.ReactNode {
    const [currentPath, setCurrentPath] = useState("/");
    const [selectedFile, setSelectedFile] = useState<string | undefined>(undefined);
    const prevTriggerRef = useRef(navigateTrigger ?? 0);

    const vfsProvider = isVfsProvider(provider) ? provider : undefined;

    const fetcher = useCallback(async () => {
      if (!vfsProvider) return [] as readonly FsEntry[];
      return vfsProvider.listPath(currentPath);
    }, [vfsProvider, currentPath]);

    const { data: entries, loading } = usePolledData<readonly FsEntry[]>(
      fetcher,
      intervalMs,
      active && isVfsProvider(provider),
    );

    // Build display rows: prepend ".." when not at root
    const isRoot = currentPath === "/";
    const allEntries: readonly FsEntry[] = isRoot
      ? (entries ?? [])
      : [{ name: "..", type: "directory" as const }, ...(entries ?? [])];

    // Determine which entry is under the cursor (clamp to valid range)
    const clampedCursor = Math.min(cursor, Math.max(0, allEntries.length - 1));
    const cursorEntry = allEntries[clampedCursor];

    // Derive the full path of the selected file for preview
    const previewPath = selectedFile !== undefined ? `${currentPath}${selectedFile}` : undefined;

    // Fetch file content once on selection change — refuse files above size cap
    // to avoid downloading large payloads over the Nexus client (no range reads).
    const MAX_PREVIEW_BYTES = 64 * 1024; // 64 KB preview cap
    const [fileContent, setFileContent] = useState<Buffer | undefined>(undefined);
    const [fileLoading, setFileLoading] = useState(false);
    const [fileError, setFileError] = useState<Error | undefined>(undefined);
    const selectedSize = cursorEntry?.type === "file" ? cursorEntry.sizeBytes : undefined;
    useEffect(() => {
      if (!vfsProvider || !previewPath) {
        setFileContent(undefined);
        setFileError(undefined);
        return;
      }
      // Refuse to download files when size is unknown or exceeds the preview cap.
      // The Nexus client has no range-read support, so full files would be downloaded.
      if (selectedSize === undefined) {
        setFileContent(undefined);
        setFileError(new Error("File size unknown — preview disabled to avoid large downloads."));
        setFileLoading(false);
        return;
      }
      if (selectedSize > MAX_PREVIEW_BYTES) {
        setFileContent(undefined);
        setFileError(
          new Error(
            `File too large for preview (${(selectedSize / 1024).toFixed(0)} KB). Max: ${MAX_PREVIEW_BYTES / 1024} KB.`,
          ),
        );
        setFileLoading(false);
        return;
      }
      // Debounce 300ms so rapid cursor movement doesn't trigger a burst of reads
      let cancelled = false;
      setFileLoading(true);
      setFileError(undefined);
      const timer = setTimeout(() => {
        vfsProvider.readFile(previewPath, MAX_PREVIEW_BYTES).then(
          (buf) => {
            if (cancelled) return;
            setFileContent(buf);
            setFileLoading(false);
          },
          (err) => {
            if (cancelled) return;
            setFileError(err instanceof Error ? err : new Error(String(err)));
            setFileLoading(false);
          },
        );
      }, 300);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [vfsProvider, previewPath, selectedSize]);

    // Sync selectedFile to cursor position (only for files, not directories)
    useEffect(() => {
      if (!cursorEntry || cursorEntry.type !== "file") {
        setSelectedFile(undefined);
      } else {
        setSelectedFile(cursorEntry.name);
      }
    }, [cursorEntry]);

    // Navigate when parent increments navigateTrigger
    useEffect(() => {
      const trigger = navigateTrigger ?? 0;
      if (trigger === prevTriggerRef.current) return;
      prevTriggerRef.current = trigger;

      const entry = allEntries[clampedCursor];
      if (!entry || entry.type !== "directory") return;

      if (entry.name === "..") {
        // Go up: remove trailing slash, then last segment
        const trimmed = currentPath.replace(/\/$/, "");
        const parentPath = trimmed.substring(0, trimmed.lastIndexOf("/") + 1) || "/";
        setCurrentPath(parentPath);
        setSelectedFile(undefined);
      } else {
        setCurrentPath(`${currentPath}${entry.name}/`);
        setSelectedFile(undefined);
      }
    }, [navigateTrigger, clampedCursor, allEntries, currentPath]);

    if (!isVfsProvider(provider)) {
      return (
        <box>
          <text opacity={0.5}>
            VFS requires Nexus backend (configure via GROVE_NEXUS_URL, grove.json, or --nexus)
          </text>
        </box>
      );
    }

    if (loading && !entries) {
      return (
        <box>
          <text opacity={0.5}>Loading VFS...</text>
        </box>
      );
    }

    const rows = allEntries.map((entry) => ({
      name: entry.type === "directory" ? `${entry.name}/` : entry.name,
      type: entry.type,
      size: formatSize(entry.sizeBytes),
    }));

    return (
      <box flexDirection="column">
        {/* Path header */}
        <box marginBottom={1} flexDirection="column">
          <box flexDirection="row">
            <text color={theme.muted}>{"Path: "}</text>
            {currentPath === "/" ? (
              <text bold>/</text>
            ) : (
              <>
                <text color={theme.muted}>
                  {`${currentPath.replace(/\/$/, "").split("/").slice(0, -1).join("/")}/`}
                </text>
                <text bold>{currentPath.replace(/\/$/, "").split("/").pop()}</text>
              </>
            )}
          </box>
          {rows.length > 0 ? <text color={theme.dimmed}>Enter:browse Esc:back</text> : null}
        </box>

        {rows.length === 0 ? (
          <EmptyState
            title="Nexus virtual filesystem."
            hint="j/k to navigate, Enter to browse, Esc to go back."
          />
        ) : (
          /* Split pane: left=tree, right=preview */
          <box flexDirection="row" flexGrow={1}>
            {/* Left: file tree */}
            <box flexDirection="column" width={56} marginRight={2}>
              <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
            </box>

            {/* Right: file preview */}
            <box flexDirection="column" flexGrow={1}>
              {selectedFile !== undefined ? (
                <>
                  <box marginBottom={1}>
                    <text color={theme.focus}>{selectedFile}</text>
                  </box>
                  <FilePreview
                    name={selectedFile}
                    content={fileContent ?? null}
                    loading={fileLoading}
                    error={fileError ?? null}
                  />
                </>
              ) : (
                <box>
                  <text color={theme.muted} opacity={0.5}>
                    {cursorEntry?.type === "directory"
                      ? "Press Enter to open directory."
                      : "Select a file to preview."}
                  </text>
                </box>
              )}
            </box>
          </box>
        )}
      </box>
    );
  },
);
