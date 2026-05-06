import { resolveAcpLaunch } from "../../core/acp-launch.js";

/** Check if a CLI tool is installed or available through a bundled ACP adapter. */
export function detectCli(name: string): boolean {
  if (Bun.which(name) !== null) return true;
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
