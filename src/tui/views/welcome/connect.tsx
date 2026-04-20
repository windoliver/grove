/**
 * Connect-to-Nexus URL input, shared by first-run and fast-path.
 *
 * Esc routes to the caller-provided `onBack`. Enter calls `onConnect`; a
 * caller-managed `error` string renders inline so the user can retry
 * without losing the typed URL.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useRef, useState } from "react";
import { theme } from "../../theme.js";

export interface ConnectProps {
  /** Seed URL. Falls back to `http://localhost:2026` when absent. */
  readonly initialUrl?: string | undefined;
  readonly error?: string | undefined;
  readonly onConnect: (url: string) => void;
  readonly onBack: () => void;
}

export const Connect: React.NamedExoticComponent<ConnectProps> = React.memo(function Connect({
  initialUrl,
  error,
  onConnect,
  onBack,
}: ConnectProps): React.ReactNode {
  const [url, setUrl] = useState(
    initialUrl && initialUrl.length > 0 ? initialUrl : "http://localhost:2026",
  );
  // pendingUrlRef is the synchronously-updated source of truth; every char
  // write updates it before scheduling setUrl so a burst like "abc"+Enter
  // never reads a stale closure.
  const pendingUrlRef = useRef(url);
  const hasConnectedRef = useRef(false);
  void useRenderer();

  useKeyboard(
    useCallback(
      (key) => {
        const name = key.name;
        if (name === "escape") {
          onBack();
          return;
        }
        if (name === "return") {
          if (hasConnectedRef.current) return;
          const trimmed = pendingUrlRef.current.trim();
          if (trimmed.length === 0) return;
          hasConnectedRef.current = true;
          onConnect(trimmed);
          return;
        }
        if (name === "backspace") {
          const next = pendingUrlRef.current.slice(0, -1);
          pendingUrlRef.current = next;
          setUrl(next);
          return;
        }
        if (name === "space") {
          const next = `${pendingUrlRef.current} `;
          pendingUrlRef.current = next;
          setUrl(next);
          return;
        }
        if (typeof name === "string" && name.length === 1 && !key.ctrl) {
          const next = pendingUrlRef.current + name;
          pendingUrlRef.current = next;
          setUrl(next);
          return;
        }
      },
      [onConnect, onBack],
    ),
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      borderStyle="round"
      borderColor={theme.focus}
    >
      <box flexDirection="column" paddingX={2} paddingTop={1}>
        <text color={theme.focus} bold>
          Connect to remote Nexus
        </text>
        <text color={theme.secondary}>{""}</text>
        <box flexDirection="row">
          <text color={theme.text}>Nexus URL: </text>
          <text color={theme.focus} bold>
            {url}
          </text>
          <text color={theme.focus}>_</text>
        </box>
        {error ? (
          <box flexDirection="column" marginTop={1}>
            <text color={theme.error}>{`Error: ${error}`}</text>
          </box>
        ) : null}
        <text color={theme.secondary}>{""}</text>
        <text color={theme.secondary}>[Enter] connect [Esc] back [Backspace] delete</text>
      </box>
    </box>
  );
});
