import type { AcpxTurn } from "../acp/types.js";
import { AcpRuntime, type AcpRuntimeEvent, type AcpRuntimeEventSink } from "./acp-runtime.js";
import type {
  AgentConfig,
  AgentDisconnectedError,
  AgentRuntime,
  AgentSession,
} from "./agent-runtime.js";
import type { AgentSessionEntity } from "./entity.js";
import { agentSessionToEntity } from "./entity.js";

export interface AcpxKey {
  readonly slotId: string;
  readonly backend: "claude-code" | "codex" | "gemini";
  readonly cwd: string;
  readonly sessionName?: string | undefined;
}

export type AcpxPhase = "starting" | "running" | "resuming" | "dead";

export interface AcpxRegistryEntry {
  readonly key: AcpxKey;
  handle: AcpRuntime;
  readonly acpxRecordId: string;
  session: AgentSession;
  lastSeq: number;
  lastRequestId?: string | undefined;
  phase: AcpxPhase;
  respawns: number;
}

export type AcpxRespawnEvent =
  | {
      readonly kind: "resuming";
      readonly key: AcpxKey;
      readonly acpxRecordId: string;
      readonly deadSessionId: string;
      readonly respawns: number;
    }
  | {
      readonly kind: "resumed";
      readonly key: AcpxKey;
      readonly acpxRecordId: string;
      readonly newSessionId: string;
      readonly lastSeq: number;
    }
  | {
      readonly kind: "dead";
      readonly key: AcpxKey;
      readonly acpxRecordId: string;
      readonly reason: string;
      readonly respawns: number;
    };

export interface AcpxSupervisorOptions {
  readonly runtimeFactory?: () => AcpRuntime;
  readonly maxRespawns?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly mintRecordId?: (() => string) | undefined;
}

const DEFAULT_MAX_RESPAWNS = 5;
const DEFAULT_BACKOFF_BASE_MS = 250;

export class AcpxSupervisor implements AgentRuntime {
  readonly sendsInitialPromptOnSpawn = true;

  private readonly registry = new Map<string, AcpxRegistryEntry>();
  private readonly inflight = new Map<string, Promise<AcpxRegistryEntry>>();
  private readonly configs = new Map<string, AgentConfig>();
  private readonly respawnListeners: ((e: AcpxRespawnEvent) => void)[] = [];
  /** Shared runtime — all slots are sessions within this single AcpRuntime instance. */
  private readonly sharedRuntime: AcpRuntime;
  private readonly maxRespawns: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mintRecordId: () => string;
  private downstreamSink: AcpRuntimeEventSink | undefined;
  private counter = 0;
  private recordCounter = 0;

  constructor(options: AcpxSupervisorOptions = {}) {
    const factory = options.runtimeFactory ?? ((): AcpRuntime => new AcpRuntime());
    this.sharedRuntime = factory();
    this.maxRespawns = options.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.sleep = options.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.mintRecordId = options.mintRecordId ?? ((): string => `acpx-rec-${this.recordCounter++}`);
    // Wire a single aggregated event sink on the shared runtime.
    this.sharedRuntime.setAcpEventSink((event: AcpRuntimeEvent) => {
      this.routeEvent(event);
    });
  }

  onRespawn(cb: (event: AcpxRespawnEvent) => void): void {
    this.respawnListeners.push(cb);
  }

  private emit(event: AcpxRespawnEvent): void {
    for (const l of this.respawnListeners) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  }

  async ensure(key: AcpxKey, config: AgentConfig): Promise<AcpxRegistryEntry> {
    const existing = this.registry.get(key.slotId);
    if (existing && existing.phase !== "dead") return existing;
    const pending = this.inflight.get(key.slotId);
    if (pending) return pending;
    const promise = this.spawnEntry(key, config).finally(() => {
      this.inflight.delete(key.slotId);
    });
    this.inflight.set(key.slotId, promise);
    return promise;
  }

  private async spawnEntry(key: AcpxKey, config: AgentConfig): Promise<AcpxRegistryEntry> {
    const session = await this.sharedRuntime.spawn(config.role, config);
    const entry: AcpxRegistryEntry = {
      key,
      handle: this.sharedRuntime,
      acpxRecordId: this.mintRecordId(),
      session,
      lastSeq: 0,
      phase: "running",
      respawns: 0,
    };
    this.registry.set(key.slotId, entry);
    this.configs.set(key.slotId, config);
    this.attachDisconnect(entry);
    return entry;
  }

  /**
   * Route an event from the shared runtime's aggregated sink.
   * Finds the matching entry by sessionId, stamps the per-entry seq, and
   * forwards to the downstream sink.
   */
  private routeEvent(event: AcpRuntimeEvent): void {
    const entry = this.entryForSession(event.sessionId);
    if (!entry) return;
    const seq = entry.lastSeq;
    entry.lastSeq += 1;
    this.downstreamSink?.({ ...event, seq });
  }

  private entryForSession(sessionId: string): AcpxRegistryEntry | undefined {
    for (const entry of this.registry.values()) {
      if (entry.session.id === sessionId) return entry;
    }
    return undefined;
  }

  private attachDisconnect(entry: AcpxRegistryEntry): void {
    entry.handle.onDisconnect?.(entry.session, (err) => {
      void this.handleDisconnect(entry, err);
    });
  }

  private async handleDisconnect(
    entry: AcpxRegistryEntry,
    _err: AgentDisconnectedError,
  ): Promise<void> {
    if (entry.phase !== "running") return;
    const config = this.configs.get(entry.key.slotId);
    if (!config) return;

    entry.phase = "resuming";
    this.emit({
      kind: "resuming",
      key: entry.key,
      acpxRecordId: entry.acpxRecordId,
      deadSessionId: entry.session.id,
      respawns: entry.respawns,
    });

    try {
      await entry.handle.close(entry.session);
    } catch {
      /* dead child; ignore */
    }

    if (entry.respawns >= this.maxRespawns) {
      entry.phase = "dead";
      this.emit({
        kind: "dead",
        key: entry.key,
        acpxRecordId: entry.acpxRecordId,
        reason: `exceeded maxRespawns=${this.maxRespawns}`,
        respawns: entry.respawns,
      });
      return;
    }

    await this.sleep(this.backoffBaseMs * 2 ** entry.respawns);
    const nextRespawns = entry.respawns + 1;

    // Respawn WITHIN the shared runtime: a fresh sharedRuntime.spawn() does a
    // fresh session/new => a NEW wireSessionId (never the dead one, #319). The
    // handle stays this.sharedRuntime; only the registry entry is replaced with
    // a new object so callers holding the old entry reference retain the dead
    // session.id (enables seq-continuity testing). routeEvent() demuxes by the
    // new session id, so seq stamping continues from the preserved lastSeq with
    // no reset. Re-register onDisconnect for the new session.
    const session = await this.sharedRuntime.spawn(config.role, config);
    const newEntry: AcpxRegistryEntry = {
      ...entry,
      session,
      phase: "running",
      respawns: nextRespawns,
    };
    this.registry.set(entry.key.slotId, newEntry);
    this.attachDisconnect(newEntry);
    this.emit({
      kind: "resumed",
      key: entry.key,
      acpxRecordId: entry.acpxRecordId,
      newSessionId: session.id,
      lastSeq: entry.lastSeq,
    });
  }

  get(slotId: string): AcpxRegistryEntry | undefined {
    return this.registry.get(slotId);
  }

  list(): readonly AcpxRegistryEntry[] {
    return [...this.registry.values()];
  }

  async stop(slotId: string, _reason: string): Promise<void> {
    const entry = this.registry.get(slotId);
    if (!entry) return;
    this.registry.delete(slotId);
    this.configs.delete(slotId);
    await entry.handle.close(entry.session);
  }

  // --- AgentRuntime facade ---

  private slotIdForSession(sessionId: string): string | undefined {
    for (const [slotId, entry] of this.registry) {
      if (entry.session.id === sessionId) return slotId;
    }
    return undefined;
  }

  setAcpEventSink(sink: AcpRuntimeEventSink | undefined): void {
    this.downstreamSink = sink;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const key: AcpxKey = {
      slotId: `${role}-${this.counter++}`,
      backend: platformToBackend(config.platform),
      cwd: config.cwd,
    };
    const entry = await this.ensure(key, config);
    return entry.session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    if (!entry) throw new Error(`AcpxSupervisor.send: no slot for session ${session.id}`);
    return entry.handle.send(entry.session, message);
  }

  async close(session: AgentSession): Promise<void> {
    const slotId = this.slotIdForSession(session.id);
    if (slotId) await this.stop(slotId, "close");
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    entry?.handle.onIdle(entry.session, callback);
  }

  onDisconnect(session: AgentSession, callback: (err: AgentDisconnectedError) => void): void {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    entry?.handle.onDisconnect?.(entry.session, callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.registry.values()].map((e) => e.session);
  }

  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    const sessions = await this.listSessions();
    return sessions.map((s) => agentSessionToEntity(s));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function platformToBackend(platform: AgentConfig["platform"]): AcpxKey["backend"] {
  if (platform === "claude-code") return "claude-code";
  if (platform === "gemini") return "gemini";
  return "codex";
}
