/**
 * Mock agent runtime for testing.
 * Records all calls and allows programmatic control of sessions.
 */

import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";

export class MockRuntime implements AgentRuntime {
  readonly spawnCalls: Array<{ role: string; config: AgentConfig }> = [];
  readonly sendCalls: Array<{ sessionId: string; message: string }> = [];
  readonly closeCalls: Array<{ sessionId: string }> = [];

  private sessions = new Map<string, AgentSession>();
  private idleCallbacks = new Map<string, (() => void)[]>();
  private nextId = 0;
  private _isAvailable = true;

  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, config });
    const id = `mock-${role}-${this.nextId++}`;
    const session: AgentSession = { id, role, status: "running" };
    this.sessions.set(id, session);
    this.idleCallbacks.set(id, []);
    return session;
  }

  async send(session: AgentSession, message: string): Promise<void> {
    this.sendCalls.push({ sessionId: session.id, message });
  }

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push({ sessionId: session.id });
    const s = this.sessions.get(session.id);
    if (s) {
      this.sessions.set(session.id, { ...s, status: "stopped" });
    }
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const callbacks = this.idleCallbacks.get(session.id);
    if (callbacks) callbacks.push(callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()];
  }

  async isAvailable(): Promise<boolean> {
    return this._isAvailable;
  }

  // --- Test helpers ---

  /** Simulate an agent becoming idle. */
  triggerIdle(sessionId: string): void {
    const callbacks = this.idleCallbacks.get(sessionId);
    if (callbacks) for (const cb of callbacks) cb();
  }

  /** Update a session's status. */
  setSessionStatus(sessionId: string, status: AgentSession["status"]): void {
    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, status });
  }

  /** Reset all recorded calls. */
  reset(): void {
    this.spawnCalls.length = 0;
    this.sendCalls.length = 0;
    this.closeCalls.length = 0;
    this.sessions.clear();
    this.idleCallbacks.clear();
    this.nextId = 0;
  }
}
