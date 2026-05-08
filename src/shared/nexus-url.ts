import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface NexusUrlConfig {
  readonly mode?: string | undefined;
  readonly nexusManaged?: boolean | undefined;
  readonly nexusUrl?: string | undefined;
}

interface NexusUrlEnv {
  readonly [name: string]: string | undefined;
  readonly GROVE_NEXUS_URL?: string | undefined;
}

/** Parse managed Nexus URL from project-local nexus.yaml (ports.http). */
export function readManagedNexusUrl(projectRoot: string): string | undefined {
  const yamlPath = join(projectRoot, "nexus.yaml");
  if (!existsSync(yamlPath)) return undefined;
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    const match = raw.match(/^\s*http:\s*(\d{1,5})\s*$/m);
    if (!match?.[1]) return undefined;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return `http://localhost:${port}`;
  } catch {
    return undefined;
  }
}

export function resolveConfiguredNexusUrl(opts: {
  readonly projectRoot: string;
  readonly config: NexusUrlConfig | undefined;
  readonly env: NexusUrlEnv;
}): string | undefined {
  const envUrl = opts.env.GROVE_NEXUS_URL;
  if (envUrl && envUrl.length > 0) return envUrl;

  if (opts.config?.mode === "nexus" && opts.config.nexusManaged === true) {
    const managedUrl = readManagedNexusUrl(opts.projectRoot);
    if (managedUrl !== undefined) return managedUrl;
  }

  return opts.config?.nexusUrl;
}
