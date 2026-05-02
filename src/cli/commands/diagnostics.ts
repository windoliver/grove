import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildDiagnosticsEntries } from "../../diagnostics/bundle.js";
import type { ScrubMode } from "../../diagnostics/redaction.js";
import type { ProbeRunner } from "../../diagnostics/system.js";
import { createStoredZip } from "../../shared/zip.js";
import { UsageError } from "../errors.js";
import { findGroveDir, resolveGroveDir } from "../utils/grove-dir.js";

export interface DiagnosticsOptions {
  readonly excludeDb: boolean;
  readonly scrubMode: ScrubMode;
  readonly slot?: string | undefined;
  readonly out?: string | undefined;
}

export interface RunDiagnosticsDeps {
  readonly cwd: string;
  readonly groveOverride?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdout?: (line: string) => void;
  readonly generatedAt?: string | undefined;
  readonly systemRunner?: ProbeRunner | undefined;
}

const HELP_TEXT = `grove diagnostics — create a diagnostics ZIP for bug reports

Usage:
  grove diagnostics [--exclude-db] [--scrub standard|aggressive|off] [--slot <id>] [--out <path>]`;

const SCRUB_MODES: readonly ScrubMode[] = ["standard", "aggressive", "off"];
const FALLBACK_PACKAGE_VERSION = "unknown";

export function parseDiagnosticsArgs(argv: readonly string[]): DiagnosticsOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "exclude-db": { type: "boolean", default: false },
      scrub: { type: "string", default: "standard" },
      slot: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help === true) {
    throw new UsageError(HELP_TEXT);
  }

  const scrub = values.scrub ?? "standard";
  if (!isScrubMode(scrub)) {
    throw new UsageError(
      `Invalid scrub mode: '${scrub}'. Must be one of: standard, aggressive, off.`,
    );
  }

  return {
    excludeDb: values["exclude-db"] ?? false,
    scrubMode: scrub,
    slot: values.slot,
    out: values.out,
  };
}

export async function handleDiagnostics(
  args: readonly string[],
  groveOverride?: string,
): Promise<void> {
  const options = parseDiagnosticsArgs(args);
  await runDiagnostics(options, {
    cwd: process.cwd(),
    groveOverride,
    env: process.env,
    stdout: console.log,
  });
}

export async function runDiagnostics(
  options: DiagnosticsOptions,
  deps: RunDiagnosticsDeps,
): Promise<void> {
  const groveDir = resolveDiagnosticsGroveDir(deps.cwd, deps.groveOverride);
  const projectRoot = resolve(groveDir, "..");
  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  const outPath = resolveOutputPath(deps.cwd, options.out, generatedAt);

  const result = await buildDiagnosticsEntries({
    projectRoot,
    groveDir,
    packageVersion: FALLBACK_PACKAGE_VERSION,
    generatedAt,
    scrubMode: options.scrubMode,
    excludeDb: options.excludeDb,
    slot: options.slot,
    env: deps.env ?? {},
    homeDir: homedir(),
    systemRunner: deps.systemRunner,
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, createStoredZip(result.entries));

  if (deps.stdout !== undefined) {
    deps.stdout(`Diagnostics bundle written: ${outPath}`);
    deps.stdout(`Entries: ${result.entries.length.toString()}`);
    deps.stdout(`Warnings: ${result.warnings.length.toString()}`);
  }
}

function resolveDiagnosticsGroveDir(cwd: string, groveOverride: string | undefined): string {
  if (groveOverride !== undefined) {
    return resolveGroveDir(groveOverride).groveDir;
  }

  const groveDir = findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error("No grove found. Run 'grove init' to create one, or set GROVE_DIR.");
  }
  return groveDir;
}

function resolveOutputPath(cwd: string, out: string | undefined, generatedAt: string): string {
  if (out !== undefined) {
    return resolve(cwd, out);
  }
  return join(cwd, `grove-diagnostics-${formatTimestamp(generatedAt)}.zip`);
}

function formatTimestamp(generatedAt: string): string {
  return generatedAt.replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function isScrubMode(value: string): value is ScrubMode {
  return SCRUB_MODES.includes(value as ScrubMode);
}
