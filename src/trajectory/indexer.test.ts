import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscriptIndex, detectRuntimeFromLines } from "./indexer.js";
import { TrajectoryEventType } from "./types.js";

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-index-"));
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("detectRuntimeFromLines", () => {
  test("detects codex ACP metadata before generic acpx", () => {
    const lines = [
      '{"jsonrpc":"2.0","id":0,"result":{"agentInfo":{"name":"codex-acp"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
    ];
    expect(detectRuntimeFromLines(lines)).toBe("codex");
  });

  test("detects claude stream-json parent tool use shape", () => {
    const lines = ['{"type":"tool_result","tool_use_id":"child","parent_tool_use_id":"parent"}'];
    expect(detectRuntimeFromLines(lines)).toBe("claude-stream-json");
  });

  test("detects claude stream-json assistant message arrays", () => {
    const lines = ['{"type":"assistant","message":[]}'];
    expect(detectRuntimeFromLines(lines)).toBe("claude-stream-json");
  });

  test("detects generic ACP and codex records", () => {
    expect(detectRuntimeFromLines(['{"jsonrpc":"2.0","method":"session/new"}'])).toBe("acpx");
    expect(detectRuntimeFromLines(['{"source":"codex"}'])).toBe("codex");
  });

  test("falls back to subprocess", () => {
    expect(detectRuntimeFromLines(["plain output"])).toBe("subprocess");
  });
});

describe("buildTranscriptIndex", () => {
  test("assigns sequence numbers, source lines, and span indexes", async () => {
    const transcript = await tempFile(
      "events.jsonl",
      [
        '{"event":"AGENT_START","spanId":"session-1"}',
        '{"event":"TOOL_CALL","tool":"apply_patch","spanId":"tool-1","parentSpanId":"session-1"}',
      ].join("\n"),
    );

    const index = await buildTranscriptIndex({
      transcriptPath: transcript,
      runtime: "subprocess",
    });

    expect(index.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(index.events[1]?.source.line).toBe(2);
    expect(index.bySeq.get(2)?.tool).toBe("apply_patch");
    expect(index.bySpanId.get("tool-1")?.[0]?.type).toBe(TrajectoryEventType.ToolCall);
    expect(index.childrenByParentSpanId.get("session-1")?.[0]?.spanId).toBe("tool-1");
  });

  test("auto-detects runtime and routes known runtimes through dedicated parsers", async () => {
    const acpTranscript = await tempFile(
      "acp.jsonl",
      [
        '{"jsonrpc":"2.0","method":"session/new"}',
        '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess-1"}}',
      ].join("\n"),
    );
    const codexTranscript = await tempFile(
      "codex.jsonl",
      '{"source":"codex","type":"tool_call","call_id":"call-1","tool_name":"apply_patch"}\n',
    );
    const claudeTranscript = await tempFile(
      "claude.jsonl",
      [
        '{"type":"assistant","message":[]}',
        '{"type":"tool_use","id":"tool-parent","name":"Task"}',
      ].join("\n"),
    );
    const unknownTranscript = await tempFile("unknown.jsonl", '{"event":"AGENT_START"}\n');

    const acp = await buildTranscriptIndex({ transcriptPath: acpTranscript, runtime: "auto" });
    const codex = await buildTranscriptIndex({ transcriptPath: codexTranscript, runtime: "auto" });
    const claude = await buildTranscriptIndex({
      transcriptPath: claudeTranscript,
      runtime: "auto",
    });
    const unknown = await buildTranscriptIndex({
      transcriptPath: unknownTranscript,
      runtime: "unknown",
    });

    expect(acp.runtime).toBe("acpx");
    expect(acp.events[0]?.type).toBe(TrajectoryEventType.AgentStart);
    expect(codex.runtime).toBe("codex");
    expect(codex.events[0]?.type).toBe(TrajectoryEventType.ToolCall);
    expect(codex.events[0]?.tool).toBe("apply_patch");
    expect(claude.runtime).toBe("claude-stream-json");
    expect(claude.events[1]?.type).toBe(TrajectoryEventType.Delegation);
    expect(unknown.runtime).toBe("unknown");
    expect(unknown.events[0]?.type).toBe(TrajectoryEventType.AgentStart);
  });

  test("keeps malformed JSONL as RAW with a parser warning", async () => {
    const transcript = await tempFile("bad.log", "not-json\n");
    const index = await buildTranscriptIndex({ transcriptPath: transcript, runtime: "subprocess" });

    expect(index.events).toHaveLength(1);
    expect(index.events[0]?.type).toBe(TrajectoryEventType.Raw);
    expect(index.warnings[0]).toContain("line 1");
  });
});
