import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { UsageError } from "../errors.js";
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

  test("throws UsageError when transcript is missing", () => {
    expect(() => parseCheckTrajectoryArgs([])).toThrow(UsageError);
  });

  test("throws UsageError when runtime is invalid", () => {
    expect(() =>
      parseCheckTrajectoryArgs(["--transcript", "t.jsonl", "--runtime", "invalid"]),
    ).toThrow(UsageError);
  });

  test("wraps unknown flag parser errors as UsageError", () => {
    expect(() => parseCheckTrajectoryArgs(["--transcript", "t.jsonl", "--wat"])).toThrow(
      UsageError,
    );
  });

  test("uses an absolute bundled default spec path", () => {
    const parsed = parseCheckTrajectoryArgs(["--transcript", "t.jsonl"]);

    expect(parsed.specPaths[0]).toEndWith(join("spec", "trajectory", "common.yaml"));
    expect(isAbsolute(parsed.specPaths[0] ?? "")).toBe(true);
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
