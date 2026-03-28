/**
 * `grove init` command — create a new grove.
 *
 * Creates the .grove/ directory with SQLite store and CAS,
 * generates a GROVE.md contract (optionally from a preset),
 * writes grove.json configuration, and optionally ingests seed data.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import type { AgentOverrides } from "../agent.js";
import { resolveAgent } from "../agent.js";
import { buildGroveMd, defaultGroveMdConfig, type GroveMdConfig } from "../grove-md-builder.js";
import { getPreset, listPresetNames, type PresetConfig } from "../presets/index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed options for `grove init`. */
export interface InitOptions {
  readonly name: string;
  readonly mode: "evaluation" | "exploration";
  readonly seed: readonly string[];
  readonly metric: readonly string[];
  readonly description?: string | undefined;
  readonly force: boolean;
  readonly agentOverrides: AgentOverrides;
  readonly cwd: string;
  readonly preset?: string | undefined;
  readonly nexusUrl?: string | undefined;
  readonly nexusChannel?: string | undefined;
}

/**
 * Parse `grove init` arguments.
 *
 * Usage: grove init [name] [--seed <path>...] [--mode <mode>] [--metric <name:direction>...]
 *        [--description <text>] [--force] [--preset <name>]
 */
export function parseInitArgs(args: readonly string[]): InitOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      seed: { type: "string", multiple: true, default: [] },
      mode: { type: "string", default: "evaluation" },
      metric: { type: "string", multiple: true, default: [] },
      description: { type: "string" },
      force: { type: "boolean", default: false },
      preset: { type: "string" },
      "nexus-url": { type: "string" },
      "nexus-channel": { type: "string" },
      "agent-id": { type: "string" },
      "agent-name": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      platform: { type: "string" },
      role: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const mode = values.mode as string;
  if (mode !== "evaluation" && mode !== "exploration") {
    throw new Error(`Invalid mode '${mode}'. Valid modes: evaluation, exploration`);
  }

  // Validate metric format: name:direction
  for (const m of values.metric as string[]) {
    const parts = m.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid metric format '${m}'. Expected 'name:direction' (e.g., 'val_bpb:minimize')`,
      );
    }
    const direction = parts[1];
    if (direction !== "minimize" && direction !== "maximize") {
      throw new Error(
        `Invalid metric direction '${direction}' in '${m}'. Valid directions: minimize, maximize`,
      );
    }
  }

  // Validate preset if specified
  const preset = values.preset as string | undefined;
  if (preset !== undefined) {
    const known = getPreset(preset);
    if (!known) {
      const available = listPresetNames().join(", ");
      throw new Error(`Unknown preset '${preset}'. Available: ${available}`);
    }
  }

  const name = positionals[0] ?? basename(process.cwd());

  return {
    name,
    mode: mode as "evaluation" | "exploration",
    seed: values.seed as string[],
    metric: values.metric as string[],
    description: values.description as string | undefined,
    force: values.force as boolean,
    preset,
    nexusUrl: (values["nexus-url"] as string | undefined) ?? process.env.GROVE_NEXUS_URL,
    nexusChannel:
      (values["nexus-channel"] as string | undefined) ?? process.env.GROVE_NEXUS_CHANNEL,
    agentOverrides: {
      agentId: values["agent-id"] as string | undefined,
      agentName: values["agent-name"] as string | undefined,
      provider: values.provider as string | undefined,
      model: values.model as string | undefined,
      platform: values.platform as string | undefined,
      role: values.role as string | undefined,
    },
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Callback fired as each init step completes, for progress UI. */
export type InitProgressCallback = (step: number, label: string) => void;

/** Dependencies for executeInit (injectable for testing). */
export interface InitDeps {
  readonly cwd: string;
}

/**
 * Execute `grove init`.
 *
 * 1. Check for existing .grove/ (error unless --force)
 * 2. Validate seed paths exist
 * 3. Create .grove/ directory structure
 * 4. Initialize SQLite store
 * 5. Generate GROVE.md (from preset or defaults)
 * 6. Write grove.json
 * 7. Seed demo contributions if preset defines them
 * 8. Optionally ingest seed artifacts
 */
export async function executeInit(
  options: InitOptions,
  onProgress?: InitProgressCallback,
): Promise<{ grovePath: string }> {
  const grovePath = join(options.cwd, ".grove");
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op fallback
  const progress = onProgress ?? (() => {});

  // 1. Check for existing grove
  if (!options.force) {
    const exists = await dirExists(grovePath);
    if (exists) {
      throw new Error(`Grove already initialized at ${grovePath}. Use --force to reinitialize.`);
    }
  }
  progress(0, "Validating configuration");

  // 2. Validate seed paths before creating any state
  for (const seedPath of options.seed) {
    try {
      await access(seedPath);
    } catch {
      throw new Error(`Seed path not found: ${seedPath}`);
    }
  }

  // Resolve preset if specified
  const preset = options.preset ? getPreset(options.preset) : undefined;

  // 3. Create directory structure
  progress(1, "Creating directory structure");
  const casPath = join(grovePath, "cas");
  const workspacesPath = join(grovePath, "workspaces");
  await mkdir(casPath, { recursive: true });
  await mkdir(workspacesPath, { recursive: true });

  // 4. Initialize SQLite store
  progress(2, "Initializing database");
  const dbPath = join(grovePath, "grove.db");
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(dbPath);

  // 5. Generate GROVE.md
  progress(3, "Generating GROVE.md contract");
  const grovemdPath = join(options.cwd, "GROVE.md");
  const mdConfig = preset ? presetToGroveMdConfig(preset, options) : defaultGroveMdConfig(options);
  const grovemdContent = buildGroveMd(mdConfig);
  await writeFile(grovemdPath, grovemdContent, "utf-8");

  // 6. Write grove.json
  progress(4, "Writing configuration");
  // Resolve backend mode: if preset prefers nexus, use it.
  // - With explicit --nexus-url: external (unmanaged) Nexus
  // - Without --nexus-url: grove-managed Nexus (grove up handles lifecycle)
  //   The actual Nexus URL is discovered at `grove up` time via nexus.yaml,
  //   so we don't write nexusUrl here — this avoids stale port references
  //   when Nexus resolves port conflicts (nexus#2918).
  const { writeGroveConfig } = await import("../../core/config.js");
  const groveJsonPath = join(grovePath, "grove.json");
  const preferredBackend = preset?.backend ?? "local";
  let resolvedMode: "local" | "nexus" = "local";
  let nexusManaged = false;
  const nexusUrl = options.nexusUrl;
  if (preferredBackend === "nexus") {
    resolvedMode = "nexus";
    if (!nexusUrl) {
      // No explicit URL — grove will manage Nexus lifecycle
      nexusManaged = true;
    }
  }
  writeGroveConfig(
    {
      name: options.name,
      mode: resolvedMode,
      preset: options.preset,
      ...(nexusUrl ? { nexusUrl } : {}),
      ...(nexusManaged ? { nexusManaged: true } : {}),
      ...(nexusManaged && options.nexusChannel ? { nexusChannel: options.nexusChannel } : {}),
      services: preset?.services ?? { server: false, mcp: false },
    },
    groveJsonPath,
  );

  // 6b. Initialize Nexus if grove-managed — but skip if one is already running
  if (nexusManaged) {
    try {
      const {
        checkNexusCli,
        nexusInit: runNexusInit,
        inferNexusPreset,
        discoverRunningNexus,
      } = await import("../nexus-lifecycle.js");

      // Reuse existing Nexus if any stack is running (avoid creating duplicate stacks).
      // API key is read from .state.json (authoritative) via readNexusApiKey.
      const existingUrl = await discoverRunningNexus();
      if (existingUrl) {
        process.env.GROVE_NEXUS_URL = existingUrl;
        const { readNexusApiKey } = await import("../nexus-lifecycle.js");
        const key = readNexusApiKey(options.cwd);
        if (key) process.env.NEXUS_API_KEY = key;
        console.log(`Reusing existing Nexus at ${existingUrl}`);
      } else {
        const hasNexus = await checkNexusCli();
        if (hasNexus) {
          const nexusPreset = inferNexusPreset({
            name: options.name,
            mode: resolvedMode,
            preset: options.preset,
          });
          await runNexusInit(options.cwd, {
            preset: nexusPreset,
            channel: options.nexusChannel,
          });
          const channel = options.nexusChannel ?? "edge";
          console.log(`Initialized Nexus backend (preset: ${nexusPreset}, channel: ${channel}).`);
        } else {
          console.log(
            "Nexus CLI not found. 'grove up' will install and initialize it automatically.",
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Warning: Nexus init failed (${msg}). 'grove up' will retry.`);
    }
  }

  // 7. Seed demo contributions if preset defines them
  progress(5, "Seeding data");
  if (preset?.seedContributions && preset.seedContributions.length > 0) {
    const { createContribution } = await import("../../core/manifest.js");
    const { SqliteContributionStore } = await import("../../local/sqlite-store.js");

    const store = new SqliteContributionStore(db);
    const contributions = preset.seedContributions.map((seed) =>
      createContribution({
        kind: seed.kind,
        mode: seed.mode,
        summary: seed.summary,
        artifacts: {},
        relations: [],
        tags: [...(seed.tags ?? [])],
        agent: {
          agentId: seed.agentId ?? "seed-agent",
          // role is tracked via agentName for seed data (AgentIdentity
          // schema in manifest.ts doesn't include role)
          ...(seed.role ? { agentName: seed.role } : {}),
        },
        createdAt: new Date().toISOString(),
      }),
    );

    await store.putMany(contributions);
    console.log(
      `Seeded ${contributions.length} demo contribution(s) from preset '${options.preset}'`,
    );
  }

  // 8. Ingest seed artifacts if provided
  if (options.seed.length > 0) {
    const { FsCas } = await import("../../local/fs-cas.js");
    const { ingestFiles } = await import("../../local/ingest/files.js");
    const { createContribution } = await import("../../core/manifest.js");
    const { SqliteContributionStore } = await import("../../local/sqlite-store.js");

    const cas = new FsCas(casPath);
    const store = new SqliteContributionStore(db);
    const agent = resolveAgent(options.agentOverrides);

    const artifacts = await ingestFiles(cas, options.seed);

    if (Object.keys(artifacts).length > 0) {
      const contribution = createContribution({
        kind: "work",
        mode: options.mode,
        summary: `Seed artifacts for ${options.name}`,
        artifacts,
        relations: [],
        tags: ["seed"],
        agent,
        createdAt: new Date().toISOString(),
      });

      await store.put(contribution);
      console.log(`Seeded ${Object.keys(artifacts).length} artifact(s) as ${contribution.cid}`);
    }
  }

  db.close();

  console.log(`Initialized grove '${options.name}' at ${grovePath}`);
  if (preset) {
    const services: string[] = [];
    if (preset.services?.server) services.push("HTTP server");
    if (preset.services?.mcp) services.push("MCP server");
    const serviceList = services.length > 0 ? ` (${services.join(", ")})` : "";
    console.log(`\nNext: run 'grove up' to start all services${serviceList}.`);
  } else {
    console.log("\nNext: run 'grove up' to start, or 'grove contribute' to publish work.");
  }
  return { grovePath };
}

// ---------------------------------------------------------------------------
// Preset → GroveMdConfig conversion
// ---------------------------------------------------------------------------

function presetToGroveMdConfig(preset: PresetConfig, options: InitOptions): GroveMdConfig {
  return {
    contractVersion: preset.topology ? 3 : 2,
    name: options.name,
    description: options.description ?? preset.description,
    mode: preset.mode,
    metrics: preset.metrics,
    topology: preset.topology,
    gates: preset.gates,
    stopConditions: preset.stopConditions,
    concurrency: preset.concurrency,
    execution: preset.execution,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle the `grove init` CLI command.
 */
export async function handleInit(args: readonly string[]): Promise<void> {
  const options = parseInitArgs(args);
  await executeInit(options);
}
