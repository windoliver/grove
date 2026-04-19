/**
 * AcpSessionStore — in-memory per-session turn log keyed by turnId.
 *
 * See docs/superpowers/specs/2026-04-19-tui-typed-acp-consumer-design.md.
 */

import type { Message, Result } from "../../acp/types.js";
import { debugLog } from "../debug-log.js";

export interface TurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly messages: Message[];
  readonly startedAt: number;
  closedAt?: number;
  stopReason?: Result["stopReason"];
  error?: Result["error"];
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly registeredAt: number;
  readonly turns: Map<string, TurnRecord>;
  latestTurnId?: string;
}

export type AcpSinkEvent =
  | { kind: "message"; sessionId: string; turnId: string; message: Message }
  | { kind: "result"; sessionId: string; turnId: string; result: Result };

export type SessionListener = (sessionId: string) => void;

export const FLUSH_INTERVAL_MS = 16;

export class AcpSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  register(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      registeredAt: Date.now(),
      turns: new Map(),
    });
  }

  unregister(sessionId: string): void {
    const set = this.listeners.get(sessionId);
    if (set) {
      for (const listener of set) {
        try {
          listener(sessionId);
        } catch {
          // swallow — matches scheduleFlush
        }
      }
    }
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
    this.dirty.delete(sessionId);
  }

  ingest(event: AcpSinkEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) {
      debugLog(
        "acp_event_unregistered",
        `dropped ${event.kind} for sessionId=${event.sessionId} turnId=${event.turnId}`,
      );
      return;
    }

    let turn = session.turns.get(event.turnId);
    if (!turn) {
      turn = {
        turnId: event.turnId,
        sessionId: event.sessionId,
        messages: [],
        startedAt: Date.now(),
      };
      session.turns.set(event.turnId, turn);
    }

    if (event.kind === "result") {
      if (turn.closedAt === undefined) {
        turn.closedAt = Date.now();
        turn.stopReason = event.result.stopReason;
        if (event.result.error) turn.error = event.result.error;
      }
    } else {
      if (turn.closedAt !== undefined) {
        debugLog(
          "acp_late_after_result",
          `dropped late message for sessionId=${event.sessionId} turnId=${event.turnId}`,
        );
        return;
      }
      turn.messages.push(event.message);
    }

    session.latestTurnId = turn.turnId;
    this.dirty.add(event.sessionId);
    this.scheduleFlush();
  }

  /**
   * Release timer + maps. Idempotent. Call from the owning SpawnManager's
   * `destroy()` so a scheduled flush does not fire after the TUI tears down.
   */
  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sessions.clear();
    this.listeners.clear();
    this.dirty.clear();
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getTurn(sessionId: string, turnId: string): TurnRecord | undefined {
    return this.sessions.get(sessionId)?.turns.get(turnId);
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(sessionId);
    };
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const toNotify = [...this.dirty];
      this.dirty.clear();
      for (const sessionId of toNotify) {
        const set = this.listeners.get(sessionId);
        if (!set) continue;
        for (const listener of set) {
          try {
            listener(sessionId);
          } catch {
            // listener errors never kill the store
          }
        }
      }
    }, FLUSH_INTERVAL_MS);
  }
}
