import { z } from "zod";

export const LoopStopStatus = {
  Achieved: "achieved",
  Plateau: "plateau",
  MaxIterations: "max_iterations",
  Interrupted: "interrupted",
  Error: "error",
} as const;

export type LoopStopStatus = (typeof LoopStopStatus)[keyof typeof LoopStopStatus];
export type WorkflowRunStatus = "running" | LoopStopStatus;
export type ImprovementDirection = "maximize" | "minimize";

export interface SessionAssessment {
  readonly goal: string;
  readonly roles: readonly string[];
  readonly successCriteria: readonly string[];
  readonly constraints: readonly string[];
}

export interface IterationStage {
  readonly id: string;
  readonly title: string;
  readonly role?: string | undefined;
  readonly prompt: string;
  readonly successCriteria: readonly string[];
}

export interface IterationRoadmap {
  readonly source: "planner" | "fallback";
  readonly stages: readonly IterationStage[];
}

export interface LoopIterationRecord {
  readonly iteration: number;
  readonly stageId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly score?: number | undefined;
  readonly improved: boolean;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
}

export interface WorkflowState {
  readonly workflowId: string;
  readonly sessionId?: string | undefined;
  readonly assessment: SessionAssessment;
  readonly roadmap: IterationRoadmap;
  readonly status: WorkflowRunStatus;
  readonly reason?: string | undefined;
  readonly currentIteration: number;
  readonly iterations: readonly LoopIterationRecord[];
  readonly bestScore?: number | undefined;
  readonly noImprovementRounds: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
}

export interface WorkflowStateStore {
  saveWorkflowState(state: WorkflowState): Promise<void>;
}

export interface InterruptController {
  readonly interruptRequested: boolean;
  readonly reason: string | undefined;
  requestInterrupt(reason?: string): void;
}

export interface LoopIterationContext {
  readonly workflowId: string;
  readonly sessionId?: string | undefined;
  readonly iteration: number;
  readonly stage: IterationStage;
  readonly state: WorkflowState;
}

export interface LoopIterationResult {
  readonly score?: number | undefined;
  readonly achieved?: boolean | undefined;
  readonly stopStatus?: LoopStopStatus | undefined;
  readonly summary?: string | undefined;
}

export interface GroveLoopRunnerOptions {
  readonly workflowId: string;
  readonly sessionId?: string | undefined;
  readonly assessment: SessionAssessment;
  readonly roadmap?: IterationRoadmap | undefined;
  readonly plannerOutput?: string | undefined;
  readonly maxIterations?: number | undefined;
  readonly maxNoImprovementRounds?: number | undefined;
  readonly improvementThreshold?: number | undefined;
  readonly improvementDirection?: ImprovementDirection | undefined;
  readonly interrupt?: InterruptController | undefined;
  readonly workflowStore?: WorkflowStateStore | undefined;
  readonly now?: (() => string) | undefined;
  readonly executeIteration: (context: LoopIterationContext) => Promise<LoopIterationResult>;
}

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_NO_IMPROVEMENT_ROUNDS = 5;
const DEFAULT_IMPROVEMENT_THRESHOLD = 0.01;

const IterationStageSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    role: z.string().min(1).optional(),
    prompt: z.string().min(1),
    successCriteria: z.array(z.string()).optional(),
    success_criteria: z.array(z.string()).optional(),
  })
  .strict();

const IterationRoadmapSchema = z
  .object({
    stages: z.array(IterationStageSchema).min(1),
  })
  .strict();

type ParsedIterationStage = z.infer<typeof IterationStageSchema>;

export function findFirstBalancedBraces(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

export function createFallbackRoadmap(assessment: SessionAssessment): IterationRoadmap {
  const roles = assessment.roles.length > 0 ? assessment.roles : ["worker"];
  return {
    source: "fallback",
    stages: roles.map((role, index) => ({
      id: `stage-${index + 1}-${sanitizeStageId(role)}`,
      title: `Run ${role}`,
      role,
      prompt:
        `Work toward goal: ${assessment.goal}. ` +
        `Success criteria: ${assessment.successCriteria.join("; ") || "complete the goal"}.`,
      successCriteria: [...assessment.successCriteria],
    })),
  };
}

export function parseIterationRoadmap(
  plannerOutput: string,
  assessment: SessionAssessment,
): IterationRoadmap {
  const jsonText = findFirstBalancedBraces(plannerOutput);
  if (jsonText === undefined) return createFallbackRoadmap(assessment);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch {
    return createFallbackRoadmap(assessment);
  }

  const parsed = IterationRoadmapSchema.safeParse(parsedJson);
  if (!parsed.success) return createFallbackRoadmap(assessment);

  return {
    source: "planner",
    stages: parsed.data.stages.map(normalizeStage),
  };
}

export function createInterruptController(opts?: {
  readonly forceExit?: ((reason: string) => void) | undefined;
  readonly onInterrupt?: ((reason: string) => void) | undefined;
}): InterruptController {
  let requested = false;
  let storedReason: string | undefined;

  return {
    get interruptRequested(): boolean {
      return requested;
    },
    get reason(): string | undefined {
      return storedReason;
    },
    requestInterrupt(reason = "Interrupted"): void {
      if (requested) {
        opts?.forceExit?.(reason);
        return;
      }
      requested = true;
      storedReason = reason;
      opts?.onInterrupt?.(reason);
    },
  };
}

export interface SignalEmitter {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
}

export interface InstalledInterruptHandlers {
  readonly interrupt: InterruptController;
  dispose(): void;
}

export function installProcessInterruptHandlers(
  emitter: SignalEmitter,
  opts?: {
    readonly forceExit?: ((code: number) => void) | undefined;
    readonly onInterrupt?: ((reason: string) => void) | undefined;
  },
): InstalledInterruptHandlers {
  const interrupt = createInterruptController({
    forceExit: () => opts?.forceExit?.(130),
    onInterrupt: opts?.onInterrupt,
  });
  const onSigint = (): void => interrupt.requestInterrupt("User interrupted (SIGINT)");
  const onSigterm = (): void => interrupt.requestInterrupt("Terminated (SIGTERM)");

  emitter.on("SIGINT", onSigint);
  emitter.on("SIGTERM", onSigterm);

  return {
    interrupt,
    dispose(): void {
      emitter.removeListener("SIGINT", onSigint);
      emitter.removeListener("SIGTERM", onSigterm);
    },
  };
}

export class GroveLoopRunner {
  private readonly options: GroveLoopRunnerOptions;
  private readonly maxIterations: number;
  private readonly maxNoImprovementRounds: number;
  private readonly improvementThreshold: number;
  private readonly improvementDirection: ImprovementDirection;

  constructor(options: GroveLoopRunnerOptions) {
    this.options = options;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxNoImprovementRounds =
      options.maxNoImprovementRounds ?? DEFAULT_MAX_NO_IMPROVEMENT_ROUNDS;
    this.improvementThreshold = options.improvementThreshold ?? DEFAULT_IMPROVEMENT_THRESHOLD;
    this.improvementDirection = options.improvementDirection ?? "maximize";
  }

  async run(): Promise<WorkflowState> {
    const now = this.options.now ?? (() => new Date().toISOString());
    const roadmap =
      this.options.roadmap ??
      parseIterationRoadmap(this.options.plannerOutput ?? "", this.options.assessment);

    let state: WorkflowState = {
      workflowId: this.options.workflowId,
      sessionId: this.options.sessionId,
      assessment: this.options.assessment,
      roadmap,
      status: "running",
      currentIteration: 0,
      iterations: [],
      noImprovementRounds: 0,
      startedAt: now(),
      updatedAt: now(),
    };

    await this.persist(state);

    if (hasInterruptRequest(this.options.interrupt)) {
      return this.complete(state, LoopStopStatus.Interrupted, interruptReason(this.options), now);
    }

    while (state.status === "running") {
      const iteration = state.currentIteration + 1;
      const stage = roadmap.stages[(iteration - 1) % roadmap.stages.length];
      if (stage === undefined) {
        return this.complete(state, LoopStopStatus.Error, "Roadmap has no stages", now);
      }

      const startedAt = now();
      let result: LoopIterationResult;
      try {
        result = await this.options.executeIteration({
          workflowId: this.options.workflowId,
          sessionId: this.options.sessionId,
          iteration,
          stage,
          state,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return this.complete(state, LoopStopStatus.Error, reason, now);
      }

      const improvement = calculateImprovement({
        score: result.score,
        bestScore: state.bestScore,
        direction: this.improvementDirection,
        threshold: this.improvementThreshold,
      });
      const completedAt = now();
      const nextIterations: LoopIterationRecord[] = [
        ...state.iterations,
        {
          iteration,
          stageId: stage.id,
          startedAt,
          completedAt,
          score: result.score,
          improved: improvement.improved,
          summary: result.summary,
        },
      ];

      state = {
        ...state,
        currentIteration: iteration,
        iterations: nextIterations,
        bestScore: improvement.bestScore,
        noImprovementRounds: improvement.improved ? 0 : state.noImprovementRounds + 1,
        updatedAt: completedAt,
      };
      await this.persist(state);

      if (hasInterruptRequest(this.options.interrupt)) {
        return this.complete(state, LoopStopStatus.Interrupted, interruptReason(this.options), now);
      }
      if (result.stopStatus !== undefined) {
        return this.complete(
          state,
          result.stopStatus,
          result.summary ?? `Stopped with ${result.stopStatus}`,
          now,
        );
      }
      if (result.achieved === true) {
        return this.complete(state, LoopStopStatus.Achieved, result.summary ?? "Achieved", now);
      }
      if (state.noImprovementRounds >= this.maxNoImprovementRounds) {
        return this.complete(
          state,
          LoopStopStatus.Plateau,
          `No improvement for ${state.noImprovementRounds} rounds`,
          now,
        );
      }
      if (iteration >= this.maxIterations) {
        return this.complete(
          state,
          LoopStopStatus.MaxIterations,
          `Reached max iterations (${this.maxIterations})`,
          now,
        );
      }
    }

    return state;
  }

  private async complete(
    state: WorkflowState,
    status: LoopStopStatus,
    reason: string,
    now: () => string,
  ): Promise<WorkflowState> {
    const completedAt = now();
    const completed: WorkflowState = {
      ...state,
      status,
      reason,
      updatedAt: completedAt,
      completedAt,
    };
    await this.persist(completed);
    return completed;
  }

  private async persist(state: WorkflowState): Promise<void> {
    await this.options.workflowStore?.saveWorkflowState(state);
  }
}

function normalizeStage(stage: ParsedIterationStage): IterationStage {
  return {
    id: stage.id,
    title: stage.title,
    role: stage.role,
    prompt: stage.prompt,
    successCriteria: [...(stage.successCriteria ?? stage.success_criteria ?? [])],
  };
}

function sanitizeStageId(input: string): string {
  const lowered = input.toLowerCase();
  const safe = lowered.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
  return safe.length > 0 ? safe : "role";
}

function interruptReason(options: GroveLoopRunnerOptions): string {
  return options.interrupt?.reason ?? "Interrupted";
}

function hasInterruptRequest(interrupt: InterruptController | undefined): boolean {
  return interrupt?.interruptRequested === true;
}

function calculateImprovement(opts: {
  readonly score: number | undefined;
  readonly bestScore: number | undefined;
  readonly direction: ImprovementDirection;
  readonly threshold: number;
}): { readonly improved: boolean; readonly bestScore: number | undefined } {
  if (opts.score === undefined) {
    return { improved: false, bestScore: opts.bestScore };
  }
  if (opts.bestScore === undefined) {
    return { improved: true, bestScore: opts.score };
  }

  const delta =
    opts.direction === "minimize" ? opts.bestScore - opts.score : opts.score - opts.bestScore;
  if (delta >= opts.threshold) {
    return { improved: true, bestScore: opts.score };
  }
  return { improved: false, bestScore: opts.bestScore };
}
