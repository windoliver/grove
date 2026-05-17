import type { AgentSession } from "../agent-runtime.js";
import type { AgentTaskView } from "../agent-task.js";
import type { AgentTaskStore } from "../store.js";
import type { RuntimeProfile } from "./profile.js";

export interface SchedulerContext {
  readonly task: AgentTaskView;
  readonly profiles: readonly RuntimeProfile[];
  readonly store: Pick<AgentTaskStore, "listAgentTaskEntities" | "getAgentTask">;
  readonly now: () => number;
}

export type FilterVerdict =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string; readonly message?: string | undefined };

export interface FilterPlugin {
  readonly name: string;
  filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict>;
}

export interface ScorePlugin {
  readonly name: string;
  score(ctx: SchedulerContext, profile: RuntimeProfile): Promise<number>;
}

export type PermitVerdict =
  | { readonly status: "granted" }
  | { readonly status: "denied"; readonly reason: string; readonly message?: string | undefined }
  | { readonly status: "wait"; readonly reason: string; readonly message?: string | undefined };

export interface PermitPlugin {
  readonly name: string;
  permit(ctx: SchedulerContext, profile: RuntimeProfile): Promise<PermitVerdict>;
}

export interface BindResult {
  readonly session: AgentSession;
}

export interface BindPlugin {
  readonly name: string;
  bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult>;
}

export interface FilterRejection {
  readonly plugin: string;
  readonly reason: string;
  readonly message?: string | undefined;
}

export interface ProfileRejection {
  readonly profile: RuntimeProfile;
  readonly rejections: readonly FilterRejection[];
}

export type SchedulingResult =
  | {
      readonly kind: "bound";
      readonly profile: RuntimeProfile;
      readonly session: AgentSession;
      readonly reservationToken?: string | undefined;
    }
  | {
      readonly kind: "unschedulable";
      readonly rejections: readonly ProfileRejection[];
    }
  | {
      readonly kind: "wait";
      readonly plugin: string;
      readonly reason: string;
      readonly message?: string | undefined;
      readonly profile: RuntimeProfile;
    }
  | {
      readonly kind: "denied";
      readonly plugin: string;
      readonly reason: string;
      readonly message?: string | undefined;
    };
