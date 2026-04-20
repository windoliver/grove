/**
 * Connect-to-Nexus URL input, shared by first-run and fast-path.
 *
 * Esc routes to the caller-provided `onBack`. Enter calls `onConnect`; a
 * caller-managed `error` string renders inline so the user can retry
 * without losing the typed URL.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { theme } from "../../theme.js";

export interface ConnectProps {
  readonly defaultUrl?: string;
  readonly error?: string | undefined;
  readonly onConnect: (url: string) => void;
  readonly onBack: () => void;
}

export const Connect: React.NamedExoticComponent<ConnectProps> = React.memo(
  function Connect({
    defaultUrl,
    error,
    onConnect,
    onBack,
  }: ConnectProps): React.ReactNode {
    const [url, setUrl] = useState(defaultUrl ?? "http://localhost:2026");
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
            const trimmed = url.trim();
            if (trimmed.length > 0) onConnect(trimmed);
            return;
          }
          if (name === "backspace") {
            setUrl((u) => u.slice(0, -1));
            return;
          }
          if (name === "space") {
            setUrl((u) => `${u} `);
            return;
          }
          if (typeof name === "string" && name.length === 1 && !key.ctrl) {
            setUrl((u) => u + name);
            return;
          }
        },
        [url, onConnect, onBack],
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
          <text color={theme.secondary}>[Enter] connect  [Esc] back  [Backspace] delete</text>
        </box>
      </box>
    );
  },
);
