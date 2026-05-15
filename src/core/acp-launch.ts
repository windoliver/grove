import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_ACP_AGENTS = ["codex", "claude", "gemini"] as const;
export type AcpAgent = (typeof SUPPORTED_ACP_AGENTS)[number];

export interface AcpLaunch {
  readonly agent: AcpAgent;
  readonly command: string;
  readonly args: readonly string[];
  readonly packageName?: string;
  readonly packageVersion?: string;
}

interface BuiltInPackageSpec {
  readonly packageName: string;
  readonly preferredBinName: string;
  readonly installHint: string;
}

const BUILT_IN: Record<"codex" | "claude", BuiltInPackageSpec> = {
  codex: {
    packageName: "@zed-industries/codex-acp",
    preferredBinName: "codex-acp",
    installHint: "bun add @zed-industries/codex-acp@^0.14.0",
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    preferredBinName: "claude-agent-acp",
    installHint: "bun add @agentclientprotocol/claude-agent-acp@^0.30.0",
  },
};

function findPackageRoot(packageName: string): string | undefined {
  const segments = packageName.split("/");
  let cursor = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(cursor, "node_modules", ...segments);
    const manifest = join(candidate, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === packageName) return candidate;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function resolveBuiltIn(agent: "codex" | "claude"): AcpLaunch {
  const spec = BUILT_IN[agent];
  const root = findPackageRoot(spec.packageName);
  if (!root) {
    throw new Error(
      `[acp-launch] ${spec.packageName} not found in node_modules. Install: ${spec.installHint}`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  const relBin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.[spec.preferredBinName] ??
        (manifest.bin && Object.keys(manifest.bin).length === 1
          ? Object.values(manifest.bin)[0]
          : undefined));
  if (!relBin) {
    throw new Error(`[acp-launch] ${spec.packageName} has no usable bin entry`);
  }
  const nativeCodexBin = agent === "codex" ? resolveNativeCodexBin(root) : undefined;
  const binPath = nativeCodexBin ?? pathResolve(root, relBin);
  if (!existsSync(binPath)) {
    throw new Error(`[acp-launch] bin not found at ${binPath}. Reinstall: ${spec.installHint}`);
  }
  const result: AcpLaunch = {
    agent,
    command: nativeCodexBin ?? process.execPath,
    args: nativeCodexBin ? [] : [binPath],
    packageName: spec.packageName,
    ...(manifest.version !== undefined ? { packageVersion: manifest.version } : {}),
  };
  return result;
}

function nativeCodexPackageName(): string | undefined {
  if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
  switch (process.platform) {
    case "darwin":
      return `codex-acp-darwin-${process.arch}`;
    case "linux":
      return `codex-acp-linux-${process.arch}`;
    case "win32":
      return `codex-acp-win32-${process.arch}`;
    default:
      return undefined;
  }
}

function resolveNativeCodexBin(codexPackageRoot: string): string | undefined {
  const nativePackage = nativeCodexPackageName();
  if (!nativePackage) return undefined;
  const binaryName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
  const realRoot = realpathSync(codexPackageRoot);
  const candidate = join(dirname(realRoot), nativePackage, "bin", binaryName);
  return existsSync(candidate) ? candidate : undefined;
}

export function resolveAcpLaunch(agent: string): AcpLaunch {
  switch (agent) {
    case "codex":
    case "claude":
      return resolveBuiltIn(agent);
    case "gemini":
      return { agent: "gemini", command: "gemini", args: ["--acp"] };
    default:
      throw new Error(
        `[acp-launch] unsupported agent "${agent}" (supported: ${SUPPORTED_ACP_AGENTS.join(", ")})`,
      );
  }
}
