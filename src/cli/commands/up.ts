/**
 * `grove up` command — start all grove services and TUI.
 *
 * Non-headless: always delegates to the TUI, which shows the setup screen
 * first and handles service startup internally with progress feedback.
 *
 * Headless: starts services directly with stderr output (for CI/scripting).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveGroveDir } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpOptions {
  readonly headless: boolean;
  readonly noTui: boolean;
  readonly groveOverride?: string | undefined;
  readonly build: boolean;
  readonly nexusSource?: string | undefined;
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

function parseUpArgs(args: readonly string[]): UpOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      headless: { type: "boolean", default: false },
      "no-tui": { type: "boolean", default: false },
      grove: { type: "string" },
      build: { type: "boolean", default: false },
      "nexus-source": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove up — start all grove services

Usage:
  grove up [options]

Options:
  --headless            Start services without TUI (for CI/scripting)
  --no-tui              Start services only, no TUI
  --grove <path>        Path to .grove directory
  --nexus-source <path> Build Nexus from local source (e.g., ~/nexus)
  --build               Same as --nexus-source, using NEXUS_SOURCE env var
  -h, --help            Show this help message`);
    process.exit(0);
  }

  return {
    headless: values.headless as boolean,
    noTui: values["no-tui"] as boolean,
    groveOverride: values.grove as string | undefined,
    build: values.build as boolean,
    nexusSource: values["nexus-source"] as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Main handler for `grove up`. */
export async function handleUp(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseUpArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  // Non-headless: always delegate to TUI — it shows the setup screen first,
  // then handles service startup internally with progress feedback.
  if (!opts.headless && !opts.noTui) {
    const { handleTui } = await import("../../tui/main.js");
    await handleTui([], effectiveGrove, { build: opts.build, nexusSource: opts.nexusSource });
    return;
  }

  // Headless mode: resolve grove directory, start services, wait
  let groveDir: string;
  try {
    const resolved = resolveGroveDir(effectiveGrove);
    groveDir = resolved.groveDir;
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) throw new Error("No grove.json");
  } catch {
    throw new Error(
      "No grove.json found. Run 'grove init' first, or 'grove init --preset <name>' for a quick start.",
    );
  }

  const { startServices, stopServices } = await import("../../shared/service-lifecycle.js");
  const services = await startServices({
    groveDir,
    build: opts.build,
    nexusSource: opts.nexusSource,
  });

  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n");
    await stopServices(services);
  };
  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0));
  });

  try {
    if (services.children.length > 0) {
      const serverPort = Number(process.env.PORT ?? 4515);
      const mcpPort = Number(process.env.MCP_PORT ?? 4015);
      const serviceLines = services.children.map((c) => {
        if (c.name === "server") return `  HTTP server  \u2192 http://localhost:${serverPort}`;
        if (c.name === "mcp") return `  MCP server   \u2192 http://localhost:${mcpPort}`;
        return `  ${c.name}`;
      });
      console.log(`Started ${services.children.length} service(s):\n${serviceLines.join("\n")}`);
    }

    console.log("Running in headless mode. Use 'grove down' to stop.");
    if (services.children.length > 0) {
      await Promise.race(services.children.map((c) => c.proc.exited));
      await shutdown();
    }
  } catch (err) {
    await shutdown();
    throw err;
  }
}
