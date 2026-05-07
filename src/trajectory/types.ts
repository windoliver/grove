export const TrajectoryEventType = {
  AgentStart: "AGENT_START",
  ToolCall: "TOOL_CALL",
  ToolResult: "TOOL_RESULT",
  Delegation: "DELEGATION",
  DelegationReturn: "DELEGATION_RETURN",
  AssistantMessage: "ASSISTANT_MESSAGE",
  Compaction: "COMPACTION",
  PermissionDenied: "PERMISSION_DENIED",
  WorkBlockStarted: "WORK_BLOCK_STARTED",
  WorkBlockUpdated: "WORK_BLOCK_UPDATED",
  WorkBlockFinished: "WORK_BLOCK_FINISHED",
  TaskTriggered: "TASK_TRIGGERED",
  TaskAdmitted: "TASK_ADMITTED",
  TaskScheduled: "TASK_SCHEDULED",
  PermissionWait: "PERMISSION_WAIT",
  PermissionDecision: "PERMISSION_DECISION",
  HealthDegraded: "HEALTH_DEGRADED",
  HealthRecovered: "HEALTH_RECOVERED",
  ContributionChanged: "CONTRIBUTION_CHANGED",
  ArtifactChanged: "ARTIFACT_CHANGED",
  ReviewChanged: "REVIEW_CHANGED",
  AdoptionChanged: "ADOPTION_CHANGED",
  Raw: "RAW",
} as const;

export type TrajectoryEventType = (typeof TrajectoryEventType)[keyof typeof TrajectoryEventType];

export const TrajectoryRuntime = {
  Acpx: "acpx",
  Codex: "codex",
  ClaudeStreamJson: "claude-stream-json",
  Subprocess: "subprocess",
  Unknown: "unknown",
} as const;

export type TrajectoryRuntime = (typeof TrajectoryRuntime)[keyof typeof TrajectoryRuntime];
export type TrajectoryRuntimeInput = TrajectoryRuntime | "auto";
export type ReportFormat = "markdown" | "json";

export interface TrajectorySource {
  readonly path: string;
  readonly line: number;
}

export interface TrajectoryEvent {
  readonly seq: number;
  readonly type: TrajectoryEventType;
  readonly runtime: TrajectoryRuntime;
  readonly timestamp?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly role?: string | undefined;
  readonly spanId?: string | undefined;
  readonly parentSpanId?: string | undefined;
  readonly tool?: string | undefined;
  readonly status?: string | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly raw?: unknown;
  readonly source: TrajectorySource;
}

export type ParsedTrajectoryEvent = Omit<TrajectoryEvent, "seq">;

export interface TranscriptIndex {
  readonly runtime: TrajectoryRuntime;
  readonly transcriptPath: string;
  readonly events: readonly TrajectoryEvent[];
  readonly warnings: readonly string[];
  readonly bySeq: ReadonlyMap<number, TrajectoryEvent>;
  readonly bySpanId: ReadonlyMap<string, readonly TrajectoryEvent[]>;
  readonly childrenByParentSpanId: ReadonlyMap<string, readonly TrajectoryEvent[]>;
}

export interface EventMatcher {
  readonly event?: string | undefined;
  readonly tool?: string | undefined;
  readonly field_match?: Readonly<Record<string, string>> | undefined;
  readonly field_not_match?: Readonly<Record<string, string>> | undefined;
}

export interface RequiredMatcher extends EventMatcher {
  readonly match_field?: string | undefined;
}

export type RuleKind =
  | "precedes"
  | "allowed_tools"
  | "must_exist"
  | "must_not_exist"
  | "field_constraint";

export interface RuleSpec {
  readonly id: string;
  readonly kind: RuleKind;
  readonly match?: EventMatcher | undefined;
  readonly trigger?: EventMatcher | undefined;
  readonly required?: RequiredMatcher | undefined;
  readonly allowed?: readonly string[] | undefined;
  readonly field?: string | undefined;
  readonly equals?: unknown;
  readonly not_equals?: unknown;
  readonly match_value?: string | undefined;
  readonly not_match?: string | undefined;
  readonly exists?: boolean | undefined;
  readonly not_exists?: boolean | undefined;
}

export interface GoalSpec {
  readonly id: string;
  readonly criteria: string;
  readonly evidence: readonly string[];
}

export interface TrajectorySpec {
  readonly name: string;
  readonly sourcePaths: readonly string[];
  readonly rules: readonly RuleSpec[];
  readonly goals: readonly GoalSpec[];
}

export type CheckStatus = "pass" | "fail" | "deferred";

export interface RuleViolation {
  readonly ruleId: string;
  readonly message: string;
  readonly seq?: number | undefined;
  readonly seqRef?: string | undefined;
  readonly source?: TrajectorySource | undefined;
  readonly eventType?: TrajectoryEventType | undefined;
  readonly tool?: string | undefined;
  readonly status?: string | undefined;
  readonly spanId?: string | undefined;
  readonly messageSnippet?: string | undefined;
}

export interface RuleResult {
  readonly ruleId: string;
  readonly status: CheckStatus;
  readonly violations: readonly RuleViolation[];
}

export interface GoalResult {
  readonly goalId: string;
  readonly status: "deferred";
  readonly message: string;
}

export interface TrajectoryCheckReport {
  readonly name: string;
  readonly transcriptPath: string;
  readonly runtime: TrajectoryRuntime;
  readonly eventCount: number;
  readonly specPaths: readonly string[];
  readonly ruleResults: readonly RuleResult[];
  readonly goalResults: readonly GoalResult[];
  readonly parserWarnings: readonly string[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly deferred: number;
  };
}

const EVENT_TYPES = new Set<string>(Object.values(TrajectoryEventType));

export function isTrajectoryEventType(value: string): value is TrajectoryEventType {
  return EVENT_TYPES.has(value);
}

export function formatSeq(seq: number): string {
  return `[seq:${seq.toString().padStart(4, "0")}]`;
}
