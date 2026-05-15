import { type AgentTaskView, agentTaskViewToEntity } from "../core/agent-task.js";
import type { AgentTaskStore } from "../core/store.js";
import type { WatchHub } from "../core/watch-hub.js";
import type { NexusWatchSubscriber } from "../nexus/nexus-watch-subscriber.js";

type AgentTaskWriteOp = "ADDED" | "MODIFIED";
type AgentTaskWriteCallback = (op: AgentTaskWriteOp, view: AgentTaskView) => void;

interface ObservableAgentTaskStore extends AgentTaskStore {
  onAgentTaskWrite?: AgentTaskWriteCallback | undefined;
}

export interface WireAgentTaskStoreWritesOptions {
  readonly store: AgentTaskStore;
  readonly namespace: string;
  readonly watchHub: WatchHub;
  readonly watchSubscriber?: NexusWatchSubscriber | undefined;
  readonly enqueueTaskId?: ((taskId: string) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export function hasAgentTaskWriteCallback(store: AgentTaskStore): boolean {
  return typeof (store as ObservableAgentTaskStore).onAgentTaskWrite === "function";
}

export function wireAgentTaskStoreWrites(options: WireAgentTaskStoreWritesOptions): void {
  const observable = options.store as ObservableAgentTaskStore;
  const previous = observable.onAgentTaskWrite;

  observable.onAgentTaskWrite = (op, view) => {
    if (previous !== undefined) {
      try {
        previous(op, view);
      } catch (error) {
        options.onError?.(error);
      }
    }

    const entity = agentTaskViewToEntity(view, options.namespace);
    try {
      options.watchHub.recordWrite({
        kind: "AgentTask",
        namespace: options.namespace,
        op,
        entity,
      });
      options.watchSubscriber?.markSeen({
        kind: "AgentTask",
        entityId: view.spec.id,
        generation: entity.metadata.generation,
      });
    } catch (error) {
      options.onError?.(error);
    }

    try {
      options.enqueueTaskId?.(view.spec.id);
    } catch (error) {
      options.onError?.(error);
    }
  };
}
