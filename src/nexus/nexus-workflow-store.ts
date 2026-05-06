/**
 * Nexus VFS-backed workflow state store.
 *
 * Stores deterministic loop-runner state under:
 *   /zones/{zoneId}/workflows/{workflowId}.json
 */

import type { WorkflowState, WorkflowStateStore } from "../core/loop-runner.js";
import type { NexusClient } from "./client.js";
import { workflowPath, workflowsDir } from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface NexusWorkflowStoreConfig {
  readonly client: NexusClient;
  readonly zoneId: string;
}

export class NexusWorkflowStore implements WorkflowStateStore {
  private readonly client: NexusClient;
  private readonly zoneId: string;

  constructor(config: NexusWorkflowStoreConfig) {
    this.client = config.client;
    this.zoneId = config.zoneId;
  }

  async saveWorkflowState(state: WorkflowState): Promise<void> {
    await this.client.write(
      workflowPath(this.zoneId, state.workflowId),
      encoder.encode(JSON.stringify(state, null, 2)),
    );
  }

  async getWorkflowState(workflowId: string): Promise<WorkflowState | undefined> {
    const bytes = await this.client.read(workflowPath(this.zoneId, workflowId));
    if (bytes === undefined) return undefined;
    return parseWorkflowState(bytes);
  }

  async listWorkflowStates(): Promise<readonly WorkflowState[]> {
    const listing = await this.client.list(workflowsDir(this.zoneId));
    const states: WorkflowState[] = [];
    for (const file of listing.files) {
      if (file.isDirectory === true || !file.name.endsWith(".json")) continue;
      const bytes = await this.client.read(file.path);
      if (bytes === undefined) continue;
      const parsed = parseWorkflowState(bytes);
      if (parsed !== undefined) states.push(parsed);
    }
    return states.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
}

function parseWorkflowState(bytes: Uint8Array): WorkflowState | undefined {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!isWorkflowState(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isWorkflowState(value: unknown): value is WorkflowState {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workflowId === "string" &&
    typeof record.status === "string" &&
    typeof record.currentIteration === "number" &&
    Array.isArray(record.iterations) &&
    typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
