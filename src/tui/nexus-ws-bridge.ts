/**
 * Nexus IPC bridge — watches Nexus VFS inboxes and pushes to agents.
 *
 * The TUI process subscribes to each role's inbox via NexusEventBus.
 * When a contribution event arrives (routed by TopologyRouter on contribute),
 * the bridge calls runtime.send() to push the notification into the
 * agent's acpx session. Agents never poll — the TUI does it for them.
 *
 * This is a transitional approach until Nexus WebSocket/webhook push works.
 * The polling happens in ONE place (TUI), not in each agent.
 */

import type { AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { EventBus, GroveEvent } from "../core/event-bus.js";
import type { AgentTopology } from "../core/topology.js";

export interface NexusWsBridgeOptions {
  topology: AgentTopology;
  runtime: AgentRuntime;
  eventBus: EventBus;
}

/**
 * Bridges Nexus EventBus events to agent sessions via AgentRuntime.
 *
 * For each role in the topology, subscribes to that role's inbox.
 * When an event arrives, formats a notification and sends it to
 * the agent session via runtime.send().
 */
export class NexusWsBridge {
  private readonly opts: NexusWsBridgeOptions;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly handlers = new Map<string, (event: GroveEvent) => void>();

  constructor(opts: NexusWsBridgeOptions) {
    this.opts = opts;
  }

  /** Register an agent session for a role and start listening for events. */
  registerSession(role: string, session: AgentSession): void {
    this.sessions.set(role, session);

    // Subscribe to this role's inbox if not already
    if (!this.handlers.has(role)) {
      const handler = (event: GroveEvent) => {
        this.handleEvent(role, event);
      };
      this.handlers.set(role, handler);
      this.opts.eventBus.subscribe(role, handler);
    }
  }

  unregisterSession(role: string): void {
    this.sessions.delete(role);
    const handler = this.handlers.get(role);
    if (handler) {
      this.opts.eventBus.unsubscribe(role, handler);
      this.handlers.delete(role);
    }
  }

  /** No async setup needed — EventBus subscription is immediate. */
  connect(): void {
    // EventBus subscriptions happen in registerSession
  }

  close(): void {
    for (const [role, handler] of this.handlers) {
      this.opts.eventBus.unsubscribe(role, handler);
    }
    this.handlers.clear();
    this.sessions.clear();
  }

  private handleEvent(targetRole: string, event: GroveEvent): void {
    const session = this.sessions.get(targetRole);
    if (!session) return;

    // Format notification from the event payload
    const source = event.sourceRole ?? "system";
    const payload = event.payload as Record<string, unknown> | undefined;
    const summary = (payload?.summary as string) ?? "";
    const kind = (payload?.kind as string) ?? event.type;

    const isDone =
      summary.startsWith("[DONE]") ||
      (payload?.context as Record<string, unknown> | undefined)?.done === true;

    const notification = isDone
      ? `[Nexus IPC] ${source} signaled DONE: ${summary}`
      : `[Nexus IPC] New ${kind} from ${source}: ${summary}`;

    void this.opts.runtime.send(session, notification).catch(() => {
      // Agent may have exited — non-fatal
    });
  }
}
