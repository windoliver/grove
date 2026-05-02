import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiagnosticEntry } from "./sqlite-export.js";

export interface ProbeResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeRunner = (command: string) => Promise<ProbeResult>;

export interface SystemSnapshotOptions {
  readonly projectRoot: string;
  readonly groveDir: string;
  readonly runner?: ProbeRunner | undefined;
}

interface ProbeDefinition {
  readonly path: string;
  readonly command: string;
}

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export async function collectSystemSnapshots(
  options: SystemSnapshotOptions,
): Promise<readonly DiagnosticEntry[]> {
  const runner = options.runner ?? defaultProbeRunner;
  const probes = buildProbeDefinitions(options);
  const entries: DiagnosticEntry[] = [];

  for (const probe of probes) {
    const result = await runner(probe.command);
    entries.push(
      makeEntry(
        probe.path,
        result.ok ? result.stdout : formatProbeFailure(probe.command, result.stderr),
      ),
    );
  }

  return entries;
}

async function defaultProbeRunner(command: string): Promise<ProbeResult> {
  try {
    const result = await execFileAsync("/bin/sh", ["-lc", command], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: DEFAULT_PROBE_TIMEOUT_MS,
    });
    return {
      ok: true,
      stdout: stringOutput(result.stdout),
      stderr: stringOutput(result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: stdoutFromError(error),
      stderr: stderrFromError(error, command),
    };
  }
}

function buildProbeDefinitions(options: SystemSnapshotOptions): readonly ProbeDefinition[] {
  return [
    {
      path: "system/process-tree.txt",
      command: "ps -axo pid,ppid,comm,args",
    },
    {
      path: "system/disk-usage.txt",
      command: `du -sh ${shellQuote(options.groveDir)} ${shellQuote(options.projectRoot)}`,
    },
    {
      path: "system/open-fds.txt",
      command: "lsof -nP | grep -E 'grove|bun|codex|claude|nexus' || true",
    },
  ];
}

function formatProbeFailure(command: string, stderr: string): string {
  const message = stderr.length > 0 ? stderr : "unknown error";
  return `Probe failed\nCommand: ${command}\n${message}`;
}

function makeEntry(path: string, content: string): DiagnosticEntry {
  return {
    path,
    bytes: new TextEncoder().encode(content),
  };
}

function stdoutFromError(error: unknown): string {
  if (hasStringProperty(error, "stdout")) {
    return error.stdout;
  }
  return "";
}

function stderrFromError(error: unknown, command: string): string {
  if (hasStringProperty(error, "stderr")) {
    return error.stderr;
  }
  if (isTimeoutError(error)) {
    return `Command timed out after ${DEFAULT_PROBE_TIMEOUT_MS.toString()}ms: ${command}`;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "";
}

function stringOutput(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function hasStringProperty<Value extends string>(
  value: unknown,
  property: Value,
): value is Readonly<Record<Value, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    property in value &&
    typeof value[property as keyof typeof value] === "string"
  );
}

function hasBooleanProperty<Value extends string>(
  value: unknown,
  property: Value,
): value is Readonly<Record<Value, boolean>> {
  return (
    typeof value === "object" &&
    value !== null &&
    property in value &&
    typeof value[property as keyof typeof value] === "boolean"
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (hasStringProperty(error, "signal") && error.signal === "SIGTERM") ||
    (hasBooleanProperty(error, "killed") && error.killed)
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
