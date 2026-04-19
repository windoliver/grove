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
  /**
   * Count of messages evicted from the front of `messages` by the
   * retention cap. Consumers with cursors (e.g. SessionLogProjector)
   * read this to translate their absolute sequence number into a valid
   * current-array index: `index = cursor - droppedMessageCount`.
   */
  droppedMessageCount: number;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly registeredAt: number;
  readonly turns: Map<string, TurnRecord>;
  latestTurnId?: string;
  /**
   * Count of CLOSED turns evicted from `turns` by the session-level cap.
   * Exposed for observability and so consumers can keep cursors stable
   * across long-lived sessions (e.g. days of agent work).
   */
  droppedTurnCount: number;
}

export type AcpSinkEvent =
  | { kind: "message"; sessionId: string; turnId: string; message: Message }
  | { kind: "result"; sessionId: string; turnId: string; result: Result };

export type SessionListener = (sessionId: string) => void;

export const FLUSH_INTERVAL_MS = 16;

/**
 * Per-turn retention cap. Long-running streaming turns (e.g. a multi-hour
 * coding agent emitting thousands of text chunks) would otherwise grow the
 * in-memory message array without bound and starve TUI rendering. When
 * exceeded, the oldest messages are evicted FIFO so the tail of the
 * conversation stays intact.
 */
export const MAX_MESSAGES_PER_TURN = 10_000;

/**
 * Session-level turn cap. Per-turn retention alone does not bound memory
 * across a long-lived session — every new turn adds a fresh TurnRecord.
 * When the live-turn count exceeds this cap, the oldest CLOSED turns are
 * evicted (closed so projection is already complete; the active
 * latestTurnId is never dropped).
 */
export const MAX_TURNS_PER_SESSION = 500;

export interface AcpSessionStoreOptions {
  /** Override for MAX_MESSAGES_PER_TURN — primarily for tests. */
  readonly maxMessagesPerTurn?: number;
  /** Override for MAX_TURNS_PER_SESSION — primarily for tests. */
  readonly maxTurnsPerSession?: number;
}

export class AcpSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxMessagesPerTurn: number;
  private readonly maxTurnsPerSession: number;

  constructor(opts: AcpSessionStoreOptions = {}) {
    this.maxMessagesPerTurn = opts.maxMessagesPerTurn ?? MAX_MESSAGES_PER_TURN;
    this.maxTurnsPerSession = opts.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION;
  }

  register(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      registeredAt: Date.now(),
      turns: new Map(),
      droppedTurnCount: 0,
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
        droppedMessageCount: 0,
      };
      session.turns.set(event.turnId, turn);
      // Enforce the session-level turn cap. Only closed turns are eligible
      // — keep every running turn alive so live projection/rendering never
      // loses an active stream under bursty traffic. Maps iterate in
      // insertion order, so this naturally evicts oldest-first.
      if (session.turns.size > this.maxTurnsPerSession) {
        let evicted = 0;
        for (const [id, t] of session.turns) {
          if (session.turns.size <= this.maxTurnsPerSession) break;
          if (t.closedAt === undefined) continue;
          if (id === session.latestTurnId) continue;
          session.turns.delete(id);
          evicted += 1;
        }
        if (evicted > 0) {
          session.droppedTurnCount += evicted;
          debugLog(
            "acp_session_turns_evicted",
            `evicted ${evicted} closed turns for sessionId=${event.sessionId} (cap=${this.maxTurnsPerSession} total=${session.droppedTurnCount})`,
          );
        }
      }
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
      // FIFO eviction once the turn exceeds the cap. Batched in halves so
      // a hot stream amortizes the shift cost across many appends instead
      // of paying O(n) every push past the limit.
      if (turn.messages.length > this.maxMessagesPerTurn) {
        const drop = turn.messages.length - this.maxMessagesPerTurn;
        turn.messages.splice(0, drop);
        turn.droppedMessageCount += drop;
        debugLog(
          "acp_turn_evicted",
          `evicted ${drop} oldest messages for sessionId=${event.sessionId} turnId=${event.turnId} (cap=${this.maxMessagesPerTurn} total=${turn.droppedMessageCount})`,
        );
      }
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
