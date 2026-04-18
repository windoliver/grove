import { describe, expect, test } from "bun:test";
import {
  buildSessionId,
  parseAcpxSessionId,
  parseSessionId,
  SESSION_ID_PREFIX,
} from "./session-id.js";

describe("session-id", () => {
  test("buildSessionId emits grove-<role>-<counter>--<base36>", () => {
    const id = buildSessionId("coder", 0);
    expect(id).toMatch(/^grove-coder-0--[a-z0-9]+$/);
    expect(id.startsWith(SESSION_ID_PREFIX)).toBe(true);
  });

  test("buildSessionId produces distinct ids for sequential counters", () => {
    const a = buildSessionId("test", 0);
    const b = buildSessionId("test", 1);
    expect(a).not.toBe(b);
  });

  test("parseSessionId round-trips builder output", () => {
    const id = buildSessionId("reviewer", 42);
    const parsed = parseSessionId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("reviewer");
    expect(parsed!.counter).toBe(42);
    expect(parsed!.suffix).toMatch(/^[a-z0-9]+$/);
  });

  test("parseSessionId handles roles containing hyphens", () => {
    const id = buildSessionId("send-test", 3);
    const parsed = parseSessionId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("send-test");
    expect(parsed!.counter).toBe(3);
  });

  test("parseSessionId returns null for non-grove names", () => {
    expect(parseSessionId("foo-bar-0-abc")).toBeNull();
    expect(parseSessionId("")).toBeNull();
  });

  test("parseSessionId returns null when shape is malformed", () => {
    expect(parseSessionId("grove-")).toBeNull();
    expect(parseSessionId("grove-onlyrole")).toBeNull();
    expect(parseSessionId("grove-role-notanumber-suffix")).toBeNull();
  });

  test("parseSessionId accepts legacy grove-<role>-<counter> shape", () => {
    // Pre-#210 tmux IDs lacked the base36 suffix. Rediscovery after upgrade
    // must still find these sessions or live agents get marked dead.
    const parsed = parseSessionId("grove-coder-3");
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("coder");
    expect(parsed!.counter).toBe(3);
    expect(parsed!.suffix).toBeNull();
  });

  test("parseSessionId legacy shape supports hyphenated roles", () => {
    const parsed = parseSessionId("grove-code-reviewer-12");
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("code-reviewer");
    expect(parsed!.counter).toBe(12);
    expect(parsed!.suffix).toBeNull();
  });

  test("legacy ID with role ending in digit segment is not misparsed as canonical", () => {
    // Regression: legacy `grove-worker-1-0` (role=worker-1, counter=0) was
    // matching the old single-dash canonical regex as role=worker. Canonical
    // now uses `--`, so single-dash names always go to the legacy branch.
    const parsed = parseSessionId("grove-worker-1-0");
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("worker-1");
    expect(parsed!.counter).toBe(0);
    expect(parsed!.suffix).toBeNull();
  });

  test("TUI-style names (single dash, no counter) return null", () => {
    // The TUI's tmuxSessionName(agentId) shape `grove-<roleId>-<base36>` is
    // not a runtime session — parser must NOT claim it. Keeps the runtime
    // contract surface clean for use-permission-detection.
    expect(parseSessionId("grove-worker-1-mo3i3zh6")).toBeNull();
    expect(parseSessionId("grove-coder-mo3i3zh6")).toBeNull();
  });
});

describe("parseAcpxSessionId", () => {
  test("accepts canonical IDs", () => {
    const id = buildSessionId("coder", 0);
    const parsed = parseAcpxSessionId(id);
    expect(parsed?.role).toBe("coder");
    expect(parsed?.counter).toBe(0);
    expect(parsed?.suffix).toMatch(/^[a-z0-9]+$/);
  });

  test("accepts pre-double-dash acpx shape (upgrade compatibility)", () => {
    // Live agents created on the previous grove version have IDs shaped
    // `grove-<role>-<counter>-<base36>` (single dashes). Rediscovery must
    // still find them post-upgrade or claims/spawnRecords get cleaned up.
    const parsed = parseAcpxSessionId("grove-coder-0-mo3i3zh6");
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe("coder");
    expect(parsed!.counter).toBe(0);
    expect(parsed!.suffix).toBe("mo3i3zh6");
  });

  test("accepts legacy <role>-<counter> shape", () => {
    const parsed = parseAcpxSessionId("grove-worker-3");
    expect(parsed?.role).toBe("worker");
    expect(parsed?.counter).toBe(3);
    expect(parsed?.suffix).toBeNull();
  });

  test("rejects non-grove names", () => {
    expect(parseAcpxSessionId("foo-bar-0-abc")).toBeNull();
  });
});
