/**
 * Tests for DefaultFrontierCalculator using an in-memory ContributionStore.
 */

import { describe } from "bun:test";
import { runFrontierCalculatorTests } from "./frontier.conformance.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import type { Contribution, ContributionKind, Relation, RelationType } from "./models.js";
import type { ContributionQuery, ContributionStore } from "./store.js";

// ---------------------------------------------------------------------------
// InMemoryContributionStore
// ---------------------------------------------------------------------------

class InMemoryContributionStore implements ContributionStore {
  private contributions = new Map<string, Contribution>();

  async put(contribution: Contribution): Promise<void> {
    this.contributions.set(contribution.cid, contribution);
  }

  async putMany(contributions: readonly Contribution[]): Promise<void> {
    for (const c of contributions) {
      this.contributions.set(c.cid, c);
    }
  }

  async get(cid: string): Promise<Contribution | undefined> {
    return this.contributions.get(cid);
  }

  async list(query?: ContributionQuery): Promise<readonly Contribution[]> {
    let results = [...this.contributions.values()];

    if (query?.kind !== undefined) {
      results = results.filter((c) => c.kind === query.kind);
    }
    if (query?.mode !== undefined) {
      results = results.filter((c) => c.mode === query.mode);
    }
    if (query?.tags !== undefined && query.tags.length > 0) {
      results = results.filter((c) => query.tags?.every((t) => c.tags.includes(t)));
    }
    if (query?.agentId !== undefined) {
      results = results.filter((c) => c.agent.agentId === query.agentId);
    }
    if (query?.agentName !== undefined) {
      results = results.filter((c) => c.agent.agentName === query.agentName);
    }
    if (query?.offset !== undefined) {
      results = results.slice(query.offset);
    }
    if (query?.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async children(cid: string): Promise<readonly Contribution[]> {
    return [...this.contributions.values()].filter((c) =>
      c.relations.some((r) => r.targetCid === cid),
    );
  }

  async ancestors(cid: string): Promise<readonly Contribution[]> {
    const contribution = this.contributions.get(cid);
    if (!contribution) return [];

    const targetCids = contribution.relations.map((r) => r.targetCid);
    return [...this.contributions.values()].filter((c) => targetCids.includes(c.cid));
  }

  async relationsOf(cid: string, relationType?: RelationType): Promise<readonly Relation[]> {
    const contribution = this.contributions.get(cid);
    if (!contribution) return [];

    if (relationType !== undefined) {
      return contribution.relations.filter((r) => r.relationType === relationType);
    }
    return contribution.relations;
  }

  async relatedTo(cid: string, relationType?: RelationType): Promise<readonly Contribution[]> {
    return [...this.contributions.values()].filter((c) =>
      c.relations.some(
        (r) =>
          r.targetCid === cid && (relationType === undefined || r.relationType === relationType),
      ),
    );
  }

  async search(query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> {
    const lower = query.toLowerCase();
    let results = [...this.contributions.values()].filter(
      (c) =>
        c.summary.toLowerCase().includes(lower) || c.description?.toLowerCase().includes(lower),
    );

    if (filters?.kind !== undefined) {
      results = results.filter((c) => c.kind === filters.kind);
    }
    if (filters?.mode !== undefined) {
      results = results.filter((c) => c.mode === filters.mode);
    }
    if (filters?.tags !== undefined && filters.tags.length > 0) {
      results = results.filter((c) => filters.tags?.every((t) => c.tags.includes(t)));
    }
    if (filters?.limit !== undefined) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  async count(query?: ContributionQuery): Promise<number> {
    const results = await this.list(query);
    return results.length;
  }

  async findExisting(
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
  ): Promise<readonly Contribution[]> {
    return [...this.contributions.values()].filter(
      (c) =>
        c.agent.agentId === agentId &&
        c.kind === kind &&
        c.relations.some((r) => r.targetCid === targetCid),
    );
  }

  close(): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Run conformance suite
// ---------------------------------------------------------------------------

describe("DefaultFrontierCalculator", () => {
  runFrontierCalculatorTests(async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);
    return {
      store,
      calculator,
      cleanup: async () => {
        store.close();
      },
    };
  });
});
