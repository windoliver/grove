import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCheckTrajectoryArgs, runCheckTrajectory } from "./check-trajectory.js";

describe("parseCheckTrajectoryArgs", () => {
  test("parses transcript, repeated specs, runtime, format, and annotated log", () => {
    expect(
      parseCheckTrajectoryArgs([
        "--transcript",
        "t.jsonl",
        "--spec",
        "a.yaml",
        "--spec",
        "b.yaml",
        "--runtime",
        "codex",
        "--format",
        "json",
        "--annotated-log",
        "annotated.jsonl",
      ]),
    ).toEqual({
      transcriptPath: "t.jsonl",
      specPaths: ["a.yaml", "b.yaml"],
      runtime: "codex",
      format: "json",
      annotatedLogPath: "annotated.jsonl",
    });
  });
});

describe("runCheckTrajectory", () => {
  test("writes markdown output through the injected writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trajectory-cli-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    const specPath = join(dir, "spec.yaml");
    await writeFile(transcriptPath, '{"event":"ASSISTANT_MESSAGE","message":"done"}\n', "utf8");
    await writeFile(specPath, "name: local\nrules: []\n", "utf8");
    const lines: string[] = [];

    await runCheckTrajectory(
      {
        transcriptPath,
        specPaths: [specPath],
        runtime: "subprocess",
        format: "markdown",
      },
      (line) => lines.push(line),
    );

    expect(lines.join("\n")).toContain("# Trajectory Check Report");
  });
});
