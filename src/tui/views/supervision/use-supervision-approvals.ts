/**
 * Adapter: PermissionPrompt[] (from useAgentMonitor) → PendingApproval[] (SupervisionScreen).
 *
 * Approve/reject mirror running-view's behaviour exactly:
 *   approve → send Enter to the prompt's tmux session
 *   reject  → send Escape to the prompt's tmux session
 *
 * Tracks first-observation timestamps per requestId so the modal's
 * "requested Ns ago" display stays stable across re-renders.
 */

import { useCallback, useMemo, useRef } from "react";
import { agentIdFromSession, type TmuxManager } from "../../agents/tmux-manager.js";
import type { PermissionPrompt } from "../../hooks/use-agent-monitor.js";
import type { PendingApproval } from "./types.js";

const PROMPT_PREVIEW_CHARS = 40;

/** Pure: convert one PermissionPrompt + nowMs into a PendingApproval. */
export function permissionToApproval(prompt: PermissionPrompt, nowMs: number): PendingApproval {
  return {
    agentId: agentIdFromSession(prompt.sessionName) ?? prompt.sessionName,
    requestId: prompt.sessionName,
    kind: "tmux-permission",
    prompt:
      prompt.command.length <= PROMPT_PREVIEW_CHARS
        ? prompt.command
        : `${prompt.command.slice(0, PROMPT_PREVIEW_CHARS - 1)}…`,
    fullBody: prompt.command,
    requestedAt: nowMs,
    metadata: { sessionName: prompt.sessionName, agentRole: prompt.agentRole },
  };
}

/**
 * Pure: build a PendingApproval[] from the current prompt list, mutating
 * `seen` in place to track first-observation timestamps. Entries for
 * prompts no longer present are deleted from `seen`.
 */
export function buildApprovalsFromPrompts(
  prompts: readonly PermissionPrompt[],
  seen: Map<string, number>,
  nowMs: number,
): readonly PendingApproval[] {
  const currentIds = new Set<string>();
  const out: PendingApproval[] = [];
  for (const p of prompts) {
    const id = p.sessionName;
    currentIds.add(id);
    const firstAt = seen.get(id);
    const at = firstAt ?? nowMs;
    if (firstAt === undefined) seen.set(id, nowMs);
    out.push(permissionToApproval(p, at));
  }
  // Garbage-collect stale entries
  for (const id of [...seen.keys()]) {
    if (!currentIds.has(id)) seen.delete(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseSupervisionApprovalsResult {
  readonly pendingApprovals: readonly PendingApproval[];
  readonly onAcceptApproval: (requestId: string) => Promise<void>;
  readonly onRejectApproval: (requestId: string) => Promise<void>;
}

export function useSupervisionApprovals(
  prompts: readonly PermissionPrompt[],
  tmux: TmuxManager | undefined,
): UseSupervisionApprovalsResult {
  // Stable first-observation timestamps across renders.
  const seenRef = useRef<Map<string, number>>(new Map());

  const pendingApprovals = useMemo(
    () => buildApprovalsFromPrompts(prompts, seenRef.current, Date.now()),
    [prompts],
  );

  const onAcceptApproval = useCallback(
    async (requestId: string): Promise<void> => {
      if (!tmux) return;
      // Mirror running-view's approve pattern exactly:
      // 1. sendKeys with empty string (primes the pane)
      // 2. Bun.spawn to send the Enter key name so tmux interprets it as the
      //    Enter key (not literal text). tmux.sendKeys uses the grove socket.
      await tmux.sendKeys(requestId, "");
      const proc = Bun.spawn(
        ["tmux", "-L", "grove", "send-keys", "-t", requestId, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
    },
    [tmux],
  );

  const onRejectApproval = useCallback(
    async (requestId: string): Promise<void> => {
      if (!tmux) return;
      // Mirror running-view's deny pattern exactly: send Escape key via Bun.spawn.
      const proc = Bun.spawn(
        ["tmux", "-L", "grove", "send-keys", "-t", requestId, "Escape"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
    },
    [tmux],
  );

  return { pendingApprovals, onAcceptApproval, onRejectApproval };
}
