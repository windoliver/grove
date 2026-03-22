import type { AgentTopology } from "./topology.js";
import type { EventBus, GroveEvent } from "./event-bus.js";

/**
 * Routes contribution events through topology edges.
 *
 * Given a contribution from a source role, finds all outgoing edges
 * from that role and publishes events to the target roles.
 */
export class TopologyRouter {
  private readonly topology: AgentTopology;
  private readonly eventBus: EventBus;
  private readonly edgeMap: ReadonlyMap<string, readonly string[]>;

  constructor(topology: AgentTopology, eventBus: EventBus) {
    this.topology = topology;
    this.eventBus = eventBus;
    // Pre-compute: source role -> target roles
    const map = new Map<string, string[]>();
    for (const role of topology.roles) {
      if (role.edges) {
        for (const edge of role.edges) {
          let targets = map.get(role.name);
          if (!targets) {
            targets = [];
            map.set(role.name, targets);
          }
          if (!targets.includes(edge.target)) {
            targets.push(edge.target);
          }
        }
      }
    }
    this.edgeMap = map;
  }

  /**
   * Route an event from a source role to all downstream targets.
   * Returns the list of target roles that received the event.
   */
  route(sourceRole: string, payload: Record<string, unknown>): readonly string[] {
    const targets = this.edgeMap.get(sourceRole);
    if (!targets || targets.length === 0) return [];

    const timestamp = new Date().toISOString();
    const routedTo: string[] = [];

    for (const targetRole of targets) {
      const event: GroveEvent = {
        type: "contribution",
        sourceRole,
        targetRole,
        payload,
        timestamp,
      };
      this.eventBus.publish(event);
      routedTo.push(targetRole);
    }

    return routedTo;
  }

  /**
   * Broadcast a stop event to all roles.
   */
  broadcastStop(reason: string): void {
    const timestamp = new Date().toISOString();
    const allRoles = this.topology.roles.map((r) => r.name);
    for (const role of allRoles) {
      this.eventBus.publish({
        type: "stop",
        sourceRole: "system",
        targetRole: role,
        payload: { reason },
        timestamp,
      });
    }
  }

  /** Get the target roles for a given source role. */
  targetsFor(sourceRole: string): readonly string[] {
    return this.edgeMap.get(sourceRole) ?? [];
  }
}
