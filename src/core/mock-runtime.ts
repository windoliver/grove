/**
 * Mock agent runtime for testing.
 * Records all calls and allows programmatic control of sessions.
 *
 * Since migrating AgentRuntime.send to return AcpxTurn, tests drive the
 * mock by enqueueing canned Messages and Results per session; each send()
 * drains the queues and returns a one-shot AcpxTurn.
 */

import type { AcpxTurn, Message, Result } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import type { AgentSessionEntity } from "./entity.js";
import { agentSessionToEntity } from "./entity.js";

export class MockRuntime implements AgentRuntime {
  readonly spawnCalls: Array<{ role: string; config: AgentConfig }> = [];
  readonly sendCalls: Array<{ sessionId: string; message: string }> = [];
  readonly closeCalls: Array<{ sessionId: string }> = [];

  private sessions = new Map<string, AgentSession>();
  private idleCallbacks = new Map<string, (() => void)[]>();
  private msgQueues = new Map<string, Message[]>();
  private resultQueues = new Map<string, Result[]>();
  private nextId = 0;
  private _isAvailable = true;

  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, config });
    const id = `mock-${role}-${this.nextId++}`;
    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
    this.sessions.set(id, session);
    this.idleCallbacks.set(id, []);
    return session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    this.sendCalls.push({ sessionId: session.id, message });
    // Drain the queues so the next send() sees an empty turn unless the
    // test enqueues more. Matches the real acpx contract: one turn per call.
    const queued = this.msgQueues.get(session.id) ?? [];
    this.msgQueues.set(session.id, []);
    const resultQ = this.resultQueues.get(session.id) ?? [];
    const canned = resultQ.shift();
    this.resultQueues.set(session.id, resultQ);
    const turnId = canned?.turnId ?? `mock-${this.nextId++}`;

    const messages = (async function* () {
      for (const m of queued) yield m;
    })();
    const result: Result = canned ?? { turnId, stopReason: "end_turn" };

    return {
      sessionId: session.id,
      turnId,
      messages,
      result: Promise.resolve(result),
      cancel: async () => undefined,
      close: async () => undefined,
    };
  }

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push({ sessionId: session.id });
    this.sessions.delete(session.id);
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const callbacks = this.idleCallbacks.get(session.id);
    if (callbacks) callbacks.push(callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()];
  }

  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    const items = await this.listSessions();
    return items.map((s) => agentSessionToEntity(s));
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

  /** Get session metadata (platform, model, agent) for test assertions. */
  getSessionMetadata(
    sessionId: string,
  ): Pick<AgentSession, "platform" | "model" | "agent"> | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return { platform: s.platform, model: s.model, agent: s.agent };
  }

  /** Queue messages to be yielded by the next send() for this session. */
  enqueueMessages(sessionId: string, msgs: readonly Message[]): void {
    const q = this.msgQueues.get(sessionId) ?? [];
    q.push(...msgs);
    this.msgQueues.set(sessionId, q);
  }

  /** Queue a terminal Result for the next send() for this session. */
  enqueueResult(sessionId: string, r: Result): void {
    const q = this.resultQueues.get(sessionId) ?? [];
    q.push(r);
    this.resultQueues.set(sessionId, q);
  }

  /** Reset all recorded calls. */
  reset(): void {
    this.spawnCalls.length = 0;
    this.sendCalls.length = 0;
    this.closeCalls.length = 0;
    this.sessions.clear();
    this.idleCallbacks.clear();
    this.msgQueues.clear();
    this.resultQueues.clear();
    this.nextId = 0;
  }
}
