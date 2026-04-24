#!/usr/bin/env bun

/**
 * Headless render harness for ConditionChips — proves the chip renders
 * against real Entity adapter output, without needing the full TUI stack.
 *
 * Invocation:
 *   GROVE_NO_ALT_SCREEN=1 bun scripts/render-chips-harness.tsx
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type React from "react";
import { agentSessionToEntity, claimToEntity, contributionToEntity } from "../src/core/entity.js";
import { ClaimStatus, ContributionKind, ContributionMode } from "../src/core/models.js";
import { ConditionChips } from "../src/tui/components/condition-chips.js";

const work = contributionToEntity({
  cid: "blake3:bae42fe4c625d026cd12f14de42dbde1dc8102c1e7f972b2484e54469b730f4b",
  manifestVersion: 1,
  kind: ContributionKind.Work,
  mode: ContributionMode.Exploration,
  summary: "Coder: Entity adapter shipped",
  description: "Coder produces Entity envelope adapter implementation",
  artifacts: {},
  relations: [],
  tags: ["entity", "coder"],
  agent: { agentId: "KWN9VC2WN4-22679" },
  createdAt: "2026-04-24T07:13:19.510Z",
});

const claim = claimToEntity({
  claimId: "9824239f-88b4-4172-b9e8-6ac1a71bb523",
  targetRef: work.id,
  agent: { agentId: "tafeng@KWN9VC2WN4" },
  status: ClaimStatus.Completed,
  intentSummary: "coder handoff complete",
  createdAt: "2026-04-24T07:10:37Z",
  heartbeatAt: "2026-04-24T07:11:37Z",
  leaseExpiresAt: "2026-04-24T07:14:37Z",
});

const session = agentSessionToEntity(
  {
    id: "grove-coder-1-abc",
    role: "coder",
    status: "running",
    platform: "claude-code",
    model: "sonnet",
  },
  () => "2026-04-24T07:15:00.000Z",
);

function Harness(): React.ReactNode {
  return (
    <box flexDirection="column" padding={1}>
      <text>--- Contribution (Work) ---</text>
      <ConditionChips conditions={work.conditions} />
      <text>--- Claim (Completed handoff) ---</text>
      <ConditionChips conditions={claim.conditions} />
      <text>--- AgentSession (Running) ---</text>
      <ConditionChips conditions={session.conditions} />
      <text>--- Summary ---</text>
      <text>Work id: {work.id.slice(0, 22)}...</text>
      <text>Work kind: {work.kind}</text>
      <text>Claim id: {claim.id}</text>
      <text>Claim phase: {claim.status.phase}</text>
      <text>Session id: {session.id}</text>
      <text>Session phase: {session.status.phase}</text>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useAlternateScreen: !process.env.GROVE_NO_ALT_SCREEN,
  targetFps: 30,
});

const root = createRoot(renderer);
root.render(<Harness />);

await new Promise((r) => setTimeout(r, 500));

renderer.destroy?.();
process.exit(0);
