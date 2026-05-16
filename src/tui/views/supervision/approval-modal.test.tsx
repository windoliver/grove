import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ApprovalModal } from "./approval-modal.js";
import type { PendingApproval } from "./types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-05-15T12:00:00Z");

function ap(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    agentId: "a-2c4",
    requestId: "r-1",
    kind: "tmux-permission",
    prompt: "rm -rf node_modules",
    fullBody: "cmd: rm -rf node_modules\ncwd: /repo/sub\nuser: agent",
    requestedAt: NOW - 8_000,
    ...over,
  };
}

async function renderModal(props: React.ComponentProps<typeof ApprovalModal>) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ApprovalModal, props));
  });
  return renderer!;
}

describe("ApprovalModal", () => {
  test("renders agent id, prompt, kind", async () => {
    const renderer = await renderModal({
      approval: ap(),
      queueDepth: 1,
      detailOpen: false,
      nowMs: NOW,
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toContain("a-2c4");
    expect(s).toContain("tmux-permission");
    expect(s).toContain("rm -rf node_modules");
    await act(async () => {
      renderer.unmount();
    });
  });

  test("shows queue depth when > 1", async () => {
    const renderer = await renderModal({
      approval: ap(),
      queueDepth: 3,
      detailOpen: false,
      nowMs: NOW,
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toMatch(/2 more queued/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("does NOT show queue depth chip when 1", async () => {
    const renderer = await renderModal({
      approval: ap(),
      queueDepth: 1,
      detailOpen: false,
      nowMs: NOW,
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).not.toMatch(/more queued/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("detailOpen toggles to fullBody", async () => {
    const renderer = await renderModal({
      approval: ap(),
      queueDepth: 1,
      detailOpen: true,
      nowMs: NOW,
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toContain("cwd: /repo/sub");
    await act(async () => {
      renderer.unmount();
    });
  });

  test("requested-ago text reflects injected nowMs", async () => {
    const renderer = await renderModal({
      approval: ap({ requestedAt: NOW - 30_000 }),
      queueDepth: 1,
      detailOpen: false,
      nowMs: NOW,
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toMatch(/requested 30s ago/);
    await act(async () => {
      renderer.unmount();
    });
  });
});
