import React from "react";
import { theme } from "../../theme.js";
import type { PendingApproval } from "./types.js";

export interface ApprovalModalProps {
  readonly approval: PendingApproval;
  readonly queueDepth: number;
  readonly detailOpen: boolean;
  /** Caller injects "now" so the modal does not call Date.now() (testable). */
  readonly nowMs: number;
}

export const ApprovalModal: React.NamedExoticComponent<ApprovalModalProps> = React.memo(
  function ApprovalModal({ approval, queueDepth, detailOpen, nowMs }: ApprovalModalProps) {
    const requestedAgo = Math.max(0, Math.floor((nowMs - approval.requestedAt) / 1000));
    return (
      <box
        flexDirection="column"
        borderStyle="double"
        borderColor={theme.info}
        paddingLeft={1}
        paddingRight={1}
        minWidth={48}
      >
        <text>APPROVAL {approval.agentId}</text>
        <text color={theme.secondary}>
          {`requested ${requestedAgo}s ago${queueDepth > 1 ? ` · ${queueDepth - 1} more queued` : ""}`}
        </text>
        <text></text>
        <text>kind: {approval.kind}</text>
        <text></text>
        <text>{detailOpen ? approval.fullBody : approval.prompt}</text>
        <text></text>
        <text color={theme.secondary}>[y]es [n]o [d]etail [Esc] dismiss</text>
      </box>
    );
  },
);
