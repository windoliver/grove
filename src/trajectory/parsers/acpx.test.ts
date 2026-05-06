import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { TrajectoryRuntime } from "../types.js";
import { parseAcpxLine } from "./acpx.js";

describe("parseAcpxLine", () => {
  test("maps ACP session and update records to trajectory events", async () => {
    const text = await readFile("tests/fixtures/acp/claude-tool-call.ndjson", "utf8");
    const lines = text.trimEnd().split("\n");
    const events = lines.flatMap(
      (line, index) =>
        parseAcpxLine(line, "claude-tool-call.ndjson", index + 1, TrajectoryRuntime.Acpx).events,
    );

    expect(events.some((event) => event.type === "AGENT_START")).toBe(true);
    expect(events.some((event) => event.type === "ASSISTANT_MESSAGE")).toBe(true);
    expect(events.some((event) => event.type === "TOOL_CALL")).toBe(true);
    expect(events.every((event) => event.runtime === "acpx")).toBe(true);
  });

  test("maps ACP errors, permissions, and unknown updates", () => {
    const denied = parseAcpxLine(
      '{"jsonrpc":"2.0","error":{"message":"denied"}}',
      "acp.ndjson",
      1,
      TrajectoryRuntime.Acpx,
    );
    const permission = parseAcpxLine(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess","update":{"sessionUpdate":"permission_request","permissionRequestId":"perm-1","title":"Bash"}}}',
      "acp.ndjson",
      2,
      TrajectoryRuntime.Acpx,
    );
    const unknown = parseAcpxLine(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update"}}}',
      "acp.ndjson",
      3,
      TrajectoryRuntime.Acpx,
    );

    expect(denied.events[0]?.type).toBe("PERMISSION_DENIED");
    expect(denied.events[0]?.error).toBe("denied");
    expect(permission.events[0]?.type).toBe("PERMISSION_WAIT");
    expect(permission.events[0]?.spanId).toBe("perm-1");
    expect(unknown.events[0]?.type).toBe("RAW");
    expect(unknown.events[0]?.error).toBe(unknown.warnings[0]);
  });

  test("maps string-valued ACP errors to permission denial events", () => {
    const denied = parseAcpxLine('{"error":"denied"}', "acp.ndjson", 6, TrajectoryRuntime.Acpx);

    expect(denied.events).toHaveLength(1);
    expect(denied.events[0]?.type).toBe("PERMISSION_DENIED");
    expect(denied.events[0]?.error).toBe("denied");
  });

  test("keeps invalid and non-object ACP records as RAW warnings", () => {
    const invalid = parseAcpxLine("not-json", "acp.ndjson", 4, TrajectoryRuntime.Acpx);
    const nonObject = parseAcpxLine("true", "acp.ndjson", 5, TrajectoryRuntime.Acpx);

    expect(invalid.events[0]?.type).toBe("RAW");
    expect(invalid.events[0]?.error).toBe(invalid.warnings[0]);
    expect(nonObject.events[0]?.type).toBe("RAW");
    expect(nonObject.warnings[0]).toContain("non-object");
  });
});
