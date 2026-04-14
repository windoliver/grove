import type { EventBus, GroveEvent } from "./event-bus.js";
import type { AgentRole, AgentTopology, RoleEdge } from "./topology.js";

/**
 * Routes contribution events through topology edges.
 *
 * Given a contribution from a source role, finds all outgoing edges
 * from that role and publishes events to the target roles.
 *
 * Edge types are structurally preserved in the edge map (deduplicated by
 * (target, edgeType) pair). Behavioral semantics for edge types are
 * informational in the current protocol version — routing behavior is flat
 * (all edges produce the same handoff pattern). Behavioral routing is planned
 * for a future protocol version.
 *
 * Memory bound: max 50 roles × 50 edges = 2500 RoleEdge objects (~100KB).
 * All caps are enforced by the contract Zod schema.
 */
export class TopologyRouter {
  private readonly topology: AgentTopology;
  private readonly eventBus: EventBus;
  // source role → outgoing edges, deduplicated by (target, edgeType) pair
  private readonly edgeMap: ReadonlyMap<string, readonly RoleEdge[]>;
  private readonly roleMap: ReadonlyMap<string, AgentRole>;

  constructor(topology: AgentTopology, eventBus: EventBus) {
    this.topology = topology;
    this.eventBus = eventBus;
    // Index roles by name for mode lookup
    this.roleMap = new Map(topology.roles.map((r) => [r.name, r]));
    // Pre-compute: source role -> outgoing RoleEdge[], deduped by (target, edgeType).
    // Use a Set<string> keyed by "target:edgeType" for O(1) dedup instead of O(n) Array.includes.
    const map = new Map<string, RoleEdge[]>();
    const seen = new Map<string, Set<string>>();
    for (const role of topology.roles) {
      if (role.edges) {
        for (const edge of role.edges) {
          let edges = map.get(role.name);
          if (!edges) {
            edges = [];
            map.set(role.name, edges);
          }
          let seenForRole = seen.get(role.name);
          if (!seenForRole) {
            seenForRole = new Set<string>();
            seen.set(role.name, seenForRole);
          }
          const key = `${edge.target}:${edge.edgeType}`;
          if (!seenForRole.has(key)) {
            seenForRole.add(key);
            edges.push({ target: edge.target, edgeType: edge.edgeType });
          }
        }
      }
    }
    this.edgeMap = map;
  }

  /**
   * Route an event from a source role to all downstream targets.
   * Publishes one event per unique target role (deduplicates by target when
   * multiple edge types point to the same target). Returns the list of unique
   * target roles that received the event.
   */
  route(sourceRole: string, payload: Record<string, unknown>): readonly string[] {
    const role = this.roleMap.get(sourceRole);
    const mode = role?.mode ?? "explicit";

    const timestamp = new Date().toISOString();
    const targets = new Set<string>();

    // Explicit: follow defined edges
    if (mode === "explicit") {
      const edges = this.edgeMap.get(sourceRole);
      if (edges) {
        for (const edge of edges) {
          targets.add(edge.target);
        }
      }
    }

    // Broadcast: notify ALL other roles
    if (mode === "broadcast") {
      for (const r of this.topology.roles) {
        if (r.name !== sourceRole) {
          targets.add(r.name);
        }
      }
    }

    if (targets.size === 0) return [];

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

  /**
   * Get all outgoing edges for a given source role.
   *
   * Returns all distinct (target, edgeType) pairs. Multiple edges to the
   * same target with different edge types are preserved as separate entries.
   * Returns an empty array for unknown roles.
   */
  targetsFor(sourceRole: string): readonly RoleEdge[] {
    return this.edgeMap.get(sourceRole) ?? [];
  }
}
