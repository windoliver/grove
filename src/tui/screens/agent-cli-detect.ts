import { resolveAcpLaunch } from "../../core/acp-launch.js";

export interface DetectCliOptions {
  readonly which?: (name: string) => string | null;
}

/** Check if a CLI tool is installed or available through a bundled ACP adapter. */
export function detectCli(name: string, options: DetectCliOptions = {}): boolean {
  const which = options.which ?? ((command: string) => Bun.which(command));
  if (which(name) !== null) return true;
  if (name === "claude" || name === "codex") {
    try {
      resolveAcpLaunch(name);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
