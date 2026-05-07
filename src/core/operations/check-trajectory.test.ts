import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrajectoryOperation } from "./check-trajectory.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "trajectory-op-"));
}

describe("checkTrajectoryOperation", () => {
  test("returns validation error when transcriptPath is blank", async () => {
    const result = await checkTrajectoryOperation({
      transcriptPath: "   ",
      specPaths: ["/unused/spec.yaml"],
      runtime: "subprocess",
      format: "markdown",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected success");
    expect(result.error.message).toBe("transcriptPath is required");
  });

  test("returns validation error when specPaths is empty", async () => {
    const result = await checkTrajectoryOperation({
      transcriptPath: "/unused/transcript.jsonl",
      specPaths: [],
      runtime: "subprocess",
      format: "markdown",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected success");
    expect(result.error.message).toBe("at least one specPath is required");
  });

  test("returns a JSON report for local transcript and spec files", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(
      specPath,
      "name: local\nrules:\n  - id: has-message\n    kind: must_exist\n    match:\n      event: ASSISTANT_MESSAGE\n",
      "utf8",
    );

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "json",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");
    expect(result.value.report.summary.failed).toBe(0);
    expect(result.value.output).toContain('"eventCount"');
  });

  test("includes deferred goal results in report summary", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(
      specPath,
      "name: local\ngoals:\n  - id: answer-quality\n    criteria: answer addresses the request\n",
      "utf8",
    );

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "markdown",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");
    expect(result.value.report.goalResults).toEqual([
      {
        goalId: "answer-quality",
        status: "deferred",
        message: "LLM goal grading is deferred in this implementation slice",
      },
    ]);
    expect(result.value.report.summary.deferred).toBe(1);
    expect(result.value.output).toContain("Runtime: subprocess");
  });

  test("writes annotated log when requested", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    const annotatedLogPath = join(dir, "annotated.jsonl");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "markdown",
      annotatedLogPath,
    });

    expect(result.ok).toBe(true);
    expect(await readFile(annotatedLogPath, "utf8")).toContain("[seq:0001]");
  });

  test("returns validation error when spec loading fails", async () => {
    const dir = await tempDir();
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "[]\n", "utf8");

    const result = await checkTrajectoryOperation({
      transcriptPath,
      specPaths: [specPath],
      runtime: "subprocess",
      format: "markdown",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected success");
    expect(result.error.message).toContain("root must be an object");
  });
});
