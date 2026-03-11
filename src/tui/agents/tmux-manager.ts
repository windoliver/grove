/**
 * TmuxManager — interface for managing agent tmux sessions.
 *
 * Agent sessions are bound to Grove claims and workspaces:
 *   claim → workspace checkout → tmux session in workspace
 *
 * The agent registry is derived from tmux + claims (no separate state).
 * The reconciler's orphan detection sees these sessions because
 * they're bound to claims and workspaces.
 */

/** A running agent session derived from tmux + claims. */
export interface AgentSession {
  readonly agentId: string;
  readonly claimId: string;
  readonly targetRef: string;
  readonly workspacePath: string;
  readonly tmuxSession: string;
  readonly status: "busy" | "idle" | "error";
  readonly command: string;
}

/** Options for spawning an agent. */
export interface SpawnOptions {
  readonly agentId: string;
  readonly command: string;
  readonly targetRef: string;
  readonly workspacePath: string;
}

/** Interface for tmux operations — mockable for testing. */
export interface TmuxManager {
  /** Check if tmux is available. */
  isAvailable(): Promise<boolean>;

  /** List running tmux sessions by name. */
  listSessions(): Promise<readonly string[]>;

  /** Spawn a new tmux session in a workspace directory. */
  spawn(options: SpawnOptions): Promise<string>;

  /** Kill a tmux session by name. */
  kill(sessionName: string): Promise<void>;

  /** Capture the current pane output (ANSI bytes). */
  capturePanes(sessionName: string): Promise<string>;

  /** Send keystrokes to a tmux session. */
  sendKeys(sessionName: string, keys: string): Promise<void>;
}

/** Tmux session name convention: grove-{agentId} */
export function tmuxSessionName(agentId: string): string {
  return `grove-${agentId}`;
}

/** Extract agentId from tmux session name, if it follows convention. */
export function agentIdFromSession(sessionName: string): string | undefined {
  if (sessionName.startsWith("grove-")) {
    return sessionName.slice(6);
  }
  return undefined;
}

/**
 * Real TmuxManager implementation using shell commands.
 *
 * Falls back gracefully when tmux is not installed.
 */
export class ShellTmuxManager implements TmuxManager {
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "tmux"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<readonly string[]> {
    try {
      const proc = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_name}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode !== 0) return [];
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async spawn(options: SpawnOptions): Promise<string> {
    const sessionName = tmuxSessionName(options.agentId);
    const proc = Bun.spawn(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        options.workspacePath,
        options.command,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tmux spawn failed: ${stderr}`);
    }
    return sessionName;
  }

  async kill(sessionName: string): Promise<void> {
    const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }

  async capturePanes(sessionName: string): Promise<string> {
    const proc = Bun.spawn(["tmux", "capture-pane", "-p", "-e", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, keys], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }
}

/** Mock TmuxManager for testing. */
export class MockTmuxManager implements TmuxManager {
  readonly sessions: Map<string, { command: string; output: string }> = new Map();
  private available = true;

  setAvailable(value: boolean): void {
    this.available = value;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async listSessions(): Promise<readonly string[]> {
    return [...this.sessions.keys()];
  }

  async spawn(options: SpawnOptions): Promise<string> {
    const name = tmuxSessionName(options.agentId);
    this.sessions.set(name, { command: options.command, output: "" });
    return name;
  }

  async kill(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
  }

  async capturePanes(sessionName: string): Promise<string> {
    return this.sessions.get(sessionName)?.output ?? "";
  }

  async sendKeys(_sessionName: string, _keys: string): Promise<void> {
    // No-op in mock
  }

  /** Set mock output for a session. */
  setOutput(sessionName: string, output: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      this.sessions.set(sessionName, { ...session, output });
    }
  }
}
