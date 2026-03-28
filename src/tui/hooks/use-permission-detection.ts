/**
 * Polls tmux sessions for permission prompts and provides y/n approval keybinding.
 *
 * Extracted from ScreenManager to reduce component complexity.
 */

import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import type { TmuxManager } from "../agents/tmux-manager.js";

/** A detected permission prompt from a tmux agent session. */
export interface PendingPermission {
  readonly sessionName: string;
  readonly agentRole: string;
  readonly command: string;
}

/** Prompt patterns to detect in tmux pane content. */
const PROMPT_PATTERNS = ["Do you want to proceed", "Allow this action?", "Proceed?"] as const;

function containsPermissionPrompt(paneContent: string): boolean {
  return PROMPT_PATTERNS.some((p) => paneContent.includes(p));
}

/**
 * Detect permission prompts in tmux sessions and handle y/n approval.
 *
 * @param tmux - TmuxManager instance (undefined disables detection)
 * @returns Array of pending permission prompts (empty if none)
 */
export function usePermissionDetection(
  tmux: TmuxManager | undefined,
): readonly PendingPermission[] {
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);

  useEffect(() => {
    if (!tmux) return;
    const timer = setInterval(async () => {
      try {
        const sessions = await tmux.listSessions();
        const prompts: PendingPermission[] = [];
        for (const sess of sessions) {
          if (!sess.startsWith("grove-")) continue;
          const pane = await tmux.capturePanes(sess);
          if (containsPermissionPrompt(pane)) {
            const lines = pane.split("\n");
            let cmd = "";
            for (const line of lines) {
              const t = line.trim();
              if (
                t &&
                !PROMPT_PATTERNS.some((p) => t.startsWith(p.slice(0, 10))) &&
                !t.startsWith("❯") &&
                !t.startsWith("Esc") &&
                !t.startsWith("1.") &&
                !t.startsWith("2.") &&
                !t.startsWith("Permission")
              ) {
                cmd = t;
              }
            }
            const role = sess.replace("grove-", "").replace(/-[a-z0-9]+$/i, "");
            prompts.push({ sessionName: sess, agentRole: role, command: cmd.slice(0, 80) });
          }
        }
        setPendingPermissions(prompts);
      } catch {
        // Non-fatal
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [tmux]);

  // y/n keybinding for approval — sends keys to the first pending prompt
  useKeyboard(
    useCallback(
      (key) => {
        if (pendingPermissions.length === 0) return;
        const prompt = pendingPermissions[0];
        if (!prompt) return;

        let sendKey: string | undefined;
        if (key.name === "y") sendKey = "Enter";
        else if (key.name === "n") sendKey = "Escape";

        if (sendKey) {
          try {
            const proc = Bun.spawn(
              ["tmux", "-L", "grove", "send-keys", "-t", prompt.sessionName, sendKey],
              { stdout: "pipe", stderr: "pipe" },
            );
            void proc.exited;
          } catch {
            // Non-fatal — session may have ended
          }
        }
      },
      [pendingPermissions],
    ),
  );

  return pendingPermissions;
}
