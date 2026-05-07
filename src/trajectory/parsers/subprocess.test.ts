import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { formatSeq } from "../types.js";
import { parseSubprocessLine } from "./subprocess.js";

describe("parseSubprocessLine", () => {
  test("maps structured events and keeps plain text as RAW", async () => {
    const text = await readFile("tests/fixtures/trajectory/subprocess.log", "utf8");
    const lines = text.trimEnd().split("\n");

    const first = parseSubprocessLine(lines[0] ?? "", "subprocess.log", 1);
    const second = parseSubprocessLine(lines[1] ?? "", "subprocess.log", 2);
    const third = parseSubprocessLine(lines[2] ?? "", "subprocess.log", 3);

    expect(first.events[0]?.type).toBe("AGENT_START");
    expect(first.events[0]?.spanId).toBe("proc-1");
    expect(second.events[0]?.type).toBe("RAW");
    expect(second.events[0]?.message).toBe("plain stdout line");
    expect(second.warnings[0]).toContain("line 2");
    expect(second.events[0]?.error).toBe(second.warnings[0]);
    expect(third.events[0]?.type).toBe("PERMISSION_DENIED");
  });

  test("keeps non-object JSON as RAW with a warning", () => {
    const result = parseSubprocessLine("true", "subprocess.log", 4);

    expect(result.events[0]?.type).toBe("RAW");
    expect(result.events[0]?.runtime).toBe("subprocess");
    expect(result.events[0]?.raw).toBe("true");
    expect(result.warnings[0]).toContain("non-object JSONL record");
  });

  test("keeps array JSON as RAW with a warning", () => {
    const result = parseSubprocessLine("[1]", "subprocess.log", 12);

    expect(result.events[0]?.type).toBe("RAW");
    expect(result.events[0]?.message).toBe("[1]");
    expect(result.events[0]?.raw).toBe("[1]");
    expect(result.warnings[0]).toContain("line 12");
    expect(result.warnings[0]).toContain("non-object JSONL record");
  });

  test("infers assistant messages from stdout and stderr streams", () => {
    const stdout = parseSubprocessLine('{"stream":"stdout","text":"hello"}', "subprocess.log", 5);
    const stderr = parseSubprocessLine('{"stream":"stderr","text":"warning"}', "subprocess.log", 6);

    expect(stdout.events[0]?.type).toBe("ASSISTANT_MESSAGE");
    expect(stdout.events[0]?.message).toBe("hello");
    expect(stderr.events[0]?.type).toBe("ASSISTANT_MESSAGE");
  });

  test("infers agent start from subprocess command or pid fields", () => {
    const command = parseSubprocessLine('{"command":"bun test"}', "subprocess.log", 7);
    const pid = parseSubprocessLine('{"pid":123}', "subprocess.log", 8);

    expect(command.events[0]?.type).toBe("AGENT_START");
    expect(pid.events[0]?.type).toBe("AGENT_START");
  });

  test("uses aliases and falls back to RAW for unknown structured records", () => {
    const aliased = parseSubprocessLine(
      '{"kind":"TOOL_CALL","span_id":"child","parent_span_id":"parent","tool_name":"shell","status":"ok","input":{"cmd":"ls"},"output":"done","error":"none"}',
      "subprocess.log",
      9,
    );
    const unknownEvent = parseSubprocessLine('{"event":"missing"}', "subprocess.log", 10);
    const unknownRecord = parseSubprocessLine('{"value":1}', "subprocess.log", 11);

    expect(aliased.events[0]?.type).toBe("TOOL_CALL");
    expect(aliased.events[0]?.spanId).toBe("child");
    expect(aliased.events[0]?.parentSpanId).toBe("parent");
    expect(aliased.events[0]?.tool).toBe("shell");
    expect(aliased.events[0]?.status).toBe("ok");
    expect(aliased.events[0]?.input).toEqual({ cmd: "ls" });
    expect(aliased.events[0]?.output).toBe("done");
    expect(aliased.events[0]?.error).toBe("none");
    expect(unknownEvent.events[0]?.type).toBe("RAW");
    expect(unknownRecord.events[0]?.type).toBe("RAW");
  });

  test("covers shared sequence formatting used by trajectory reports", () => {
    expect(formatSeq(12)).toBe("[seq:0012]");
  });
});
