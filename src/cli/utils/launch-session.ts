/**
 * Reusable session-launch core extracted from `grove session start`.
 *
 * `launchGoalSession` owns runtime/permission selection, SQLite session
 * creation, optional Nexus mirroring, orchestrator startup, and the
 * deterministic completion loop. `sessionStart` (and, later, recipe run)
 * are thin callers that supply already-resolved inputs and decide output.
 */

import type { AgentConfig, AgentRuntime } from "../../core/agent-runtime.js";
import { expectCasOk } from "../../core/cas.js";
import type { GroveContract } from "../../core/contract.js";
import { LocalEventBus } from "../../core/local-event-bus.js";
import {
  createFallbackRoadmap,
  GroveLoopRunner,
  installProcessInterruptHandlers,
  LoopStopStatus,
  type SessionAssessment,
  type WorkflowStateStore,
} from "../../core/loop-runner.js";
import { MockRuntime } from "../../core/mock-runtime.js";
import type { RecipeProvenance } from "../../core/recipe.js";
import type { RepoRef } from "../../core/repo-ref.js";
import { SessionOrchestrator } from "../../core/session-orchestrator.js";
import type { ContributionStore } from "../../core/store.js";
import type { AgentTopology } from "../../core/topology.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { resolveSessionNexusZoneId } from "../commands/session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionCompletionUpdates {
  readonly status: "completed" | "cancelled";
  readonly completedAt: string;
  readonly stopReason: string;
  readonly stopStatus: LoopStopStatus;
}

export interface LaunchGoalSessionInput {
  readonly groveDir: string;
  readonly groveRoot: string;
  readonly goal: string;
  readonly topology: AgentTopology;
  readonly contract?: GroveContract | undefined;
  /** Preset name from `--preset`, recorded on the session and used as the
   *  fallback contract name when no contract is supplied. Recipe runs omit it. */
  readonly presetName?: string | undefined;
  readonly repos: readonly RepoRef[];
  readonly extraMcpServers?: NonNullable<AgentConfig["mcpServers"]> | undefined;
  /** Override the orchestrator idle grace period (ms). Defaults to 30000. */
  readonly idleGracePeriodMs?: number | undefined;
  readonly recipeProvenance?: RecipeProvenance | undefined;
  /**
   * Optional pre-built agent runtime. When omitted (the normal case), the
   * runtime is selected via `selectRuntime()` with acpx/acp logging and the
   * permission resolver wired up. Callers that already hold a runtime — or
   * tests that need a deterministic one — may inject it here.
   */
  readonly runtime?: AgentRuntime | undefined;
  readonly onAgentsStarted?:
    | ((info: {
        readonly sessionId: string;
        readonly agents: readonly {
          readonly role: string;
          readonly session: { readonly id: string; readonly status: string };
        }[];
      }) => void)
    | undefined;
}

export interface LaunchGoalSessionResult {
  readonly sessionId: string;
  readonly stopStatus: LoopStopStatus;
  readonly stopReason: string;
}

// ---------------------------------------------------------------------------
// Launch core
// ---------------------------------------------------------------------------

export async function launchGoalSession(
  input: LaunchGoalSessionInput,
): Promise<LaunchGoalSessionResult> {
  const { join } = await import("node:path");

  // Create runtime via selectRuntime (honors GROVE_RUNTIME env), fall back to mock
  const { selectRuntime } = await import("../../core/select-runtime.js");
  const { ALLOW_ALL_RESOLVER, ChainResolver, DENY_ALL_RESOLVER } = await import(
    "../../core/permission-resolver.js"
  );
  const { RulesResolver } = await import("../../core/permission-rules.js");
  const allowAllPermissions = process.env.GROVE_ALLOW_ALL_PERMISSIONS === "1";
  const permissionResolver = allowAllPermissions
    ? ALLOW_ALL_RESOLVER
    : new ChainResolver([
        new RulesResolver({
          allowKinds: ["read", "search", "think"],
          denyTitleSubstrings: ["rm -rf", "sudo", "shutdown"],
        }),
        DENY_ALL_RESOLVER,
      ]);
  if (allowAllPermissions) {
    process.stderr.write(
      "[grove] permission-resolver: ALLOW_ALL (GROVE_ALLOW_ALL_PERMISSIONS=1). " +
        "Destructive tool calls are auto-approved.\n",
    );
  }
  let runtime: AgentRuntime;
  if (input.runtime !== undefined) {
    runtime = input.runtime;
  } else {
    const picked = selectRuntime({
      acpx: { logDir: join(input.groveDir, "agent-logs") },
      acp: { logDir: join(input.groveDir, "agent-logs"), permissionResolver },
    });
    runtime = (await picked.isAvailable()) ? picked : new MockRuntime();
  }
  const eventBus = new LocalEventBus();

  // Open SQLite database and create session
  const { initSqliteDb } = await import("../../local/sqlite-store.js");
  const db = initSqliteDb(join(input.groveDir, "grove.db"));

  // Everything below must run under try/finally so db.close() always fires.
  // Signal handlers are installed early (before orchestrator.start) so a
  // Ctrl-C during startup still records a stopReason.
  let sessionId: string | undefined;
  let orchestrator: SessionOrchestrator | undefined;
  let workflowStore: WorkflowStateStore | undefined;
  let contributionStore: ContributionStore | undefined;
  let updateNexusSession:
    | ((sessionId: string, updates: SessionCompletionUpdates) => Promise<void>)
    | undefined;
  let addNexusContributionToSession:
    | ((sessionId: string, cid: string) => Promise<void>)
    | undefined;
  const goalSessionStore = new SqliteGoalSessionStore(db);

  const markDone = async (reason: string, stopStatus: LoopStopStatus): Promise<void> => {
    if (sessionId === undefined) return;
    const updates: SessionCompletionUpdates = {
      status: terminalSessionStatus(stopStatus),
      completedAt: new Date().toISOString(),
      stopReason: reason,
      stopStatus,
    };
    try {
      // C6 (#304): no ifMatch supplied — rv-mismatch is unreachable here;
      // surface as a hard error so future ifMatch wiring (T7) doesn't silently
      // skip the markDone path.
      const result = await goalSessionStore.updateSession(sessionId, updates);
      expectCasOk(result, `cli markDone(${sessionId})`);
    } catch {
      // Best-effort — DB may already be closed or session archived.
    }
    try {
      await updateNexusSession?.(sessionId, updates);
    } catch {
      // Best-effort — Nexus may be unavailable during shutdown.
    }
  };

  const interruptHandlers = installProcessInterruptHandlers(process, {
    forceExit: (code) => process.exit(code),
    onInterrupt: (reason) => {
      void orchestrator?.stop(reason, LoopStopStatus.Interrupted);
      void markDone(reason, LoopStopStatus.Interrupted);
    },
  });

  try {
    const session = await goalSessionStore.createSession({
      goal: input.goal,
      presetName: input.presetName ?? input.contract?.name,
      topology: input.topology,
      config: input.contract,
      recipeProvenance: input.recipeProvenance,
    });
    sessionId = session.id;

    // Mirror the session to Nexus so MCP servers spawned by agents (which set
    // `GROVE_NEXUS_URL`) can resolve the frozen contract. Parallels the TUI
    // path in NexusProvider.createSession — without this, grove-mcp's
    // fail-closed check kills every agent spawned through `grove session
    // start`. Best-effort with retries; a hard failure archives the orphan
    // SQLite record and rethrows so the user sees the problem up front.
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const nexusApiKey = process.env.NEXUS_API_KEY;
    if (nexusUrl) {
      const { NexusHttpClient } = await import("../../nexus/nexus-http-client.js");
      const { NexusContributionStore } = await import("../../nexus/nexus-contribution-store.js");
      const { NexusSessionStore } = await import("../../nexus/nexus-session-store.js");
      const { NexusWorkflowStore } = await import("../../nexus/nexus-workflow-store.js");
      const nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(nexusApiKey ? { apiKey: nexusApiKey } : {}),
      });
      const zoneId = resolveSessionNexusZoneId(input.groveDir);
      const nexusSessionStore = new NexusSessionStore(nexusClient, zoneId);
      updateNexusSession = async (targetSessionId, updates) => {
        const result = await nexusSessionStore.updateSession(targetSessionId, updates);
        expectCasOk(result, `cli nexus markDone(${targetSessionId})`);
      };
      addNexusContributionToSession = (targetSessionId, cid) =>
        nexusSessionStore.addContribution(targetSessionId, cid);
      workflowStore = new NexusWorkflowStore({ client: nexusClient, zoneId });
      contributionStore = new NexusContributionStore({
        client: nexusClient,
        zoneId,
        sessionId: session.id,
      });

      const retryDelaysMs = [0, 200, 500, 1000];
      let lastErr: unknown;
      for (const delay of retryDelaysMs) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        try {
          await nexusSessionStore.putSession(session);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        // Best-effort archive — ignore both CAS mismatches and exceptions.
        await goalSessionStore
          .archiveSession(session.id)
          .then((result) => {
            if (result.kind === "rv-mismatch") return; // best-effort, ignore stale RV
          })
          .catch(() => undefined);
        throw new Error(
          `Failed to mirror session ${session.id} to Nexus at ${nexusUrl}: ` +
            `${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
            `The local session has been archived; please retry.`,
        );
      }
    }

    // Create contribution store for polling-based routing (MCP runs in child processes).
    // In Nexus mode MCP writes session-scoped contributions to Nexus, so the
    // orchestrator must poll the same scoped store or downstream roles never
    // receive handoffs.
    if (!contributionStore) {
      const { SqliteContributionStore } = await import("../../local/sqlite-store.js");
      contributionStore = new SqliteContributionStore(db);
    }

    orchestrator = new SessionOrchestrator({
      goal: input.goal,
      contract: input.contract ?? { contractVersion: 3, name: input.presetName ?? "default" },
      topology: input.topology,
      runtime,
      eventBus,
      projectRoot: input.groveRoot,
      repos: input.repos,
      workspaceBaseDir: join(input.groveDir, "workspaces"),
      sessionId: session.id,
      contributionStore,
      extraMcpServers: input.extraMcpServers,
      idleGracePeriodMs: input.idleGracePeriodMs,
      onContributionAccepted: async (cid) => {
        const localLink = goalSessionStore.addContributionToSession(session.id, cid);
        if (addNexusContributionToSession === undefined) {
          await localLink;
          return;
        }
        await Promise.all([localLink, addNexusContributionToSession(session.id, cid)]);
      },
    });

    let status: import("../../core/session-orchestrator.js").SessionStatus;
    try {
      status = await orchestrator.start();
    } catch (err) {
      // Mark session as cancelled on spawn failure. The outer finally still
      // closes db and removes signal listeners.
      const archiveResult = await goalSessionStore.archiveSession(session.id);
      expectCasOk(archiveResult, `cli session start cleanup (${session.id})`);
      throw err;
    }

    // Notify the caller that agents have started; the caller decides output.
    input.onAgentsStarted?.({ sessionId: session.id, agents: status.agents });

    // Wait for session completion through the deterministic external loop.
    // The session orchestrator owns agent routing; the loop owns final status,
    // interrupt observation, and durable workflow state.
    const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const assessment = sessionAssessment(input.goal, input.topology);
    const loop = new GroveLoopRunner({
      workflowId: `workflow-${session.id}`,
      sessionId: session.id,
      assessment,
      roadmap: createFallbackRoadmap(assessment),
      maxIterations: 1,
      interrupt: interruptHandlers.interrupt,
      workflowStore,
      executeIteration: async () => {
        const stopReason = await orchestrator?.waitForCompletion(SESSION_TIMEOUT_MS);
        const current = orchestrator?.getStatus();
        return {
          stopStatus:
            current?.stopStatus ??
            (interruptHandlers.interrupt.interruptRequested
              ? LoopStopStatus.Interrupted
              : LoopStopStatus.Achieved),
          summary: stopReason ?? current?.stopReason ?? "Session complete",
        };
      },
    });
    const finalState = await loop.run();
    const finalStopStatus =
      finalState.status === "running" ? LoopStopStatus.Error : finalState.status;
    await markDone(finalState.reason ?? "Session complete", finalStopStatus);
    return {
      sessionId: session.id,
      stopStatus: finalStopStatus,
      stopReason: finalState.reason ?? "Session complete",
    };
  } finally {
    interruptHandlers.dispose();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function terminalSessionStatus(stopStatus: LoopStopStatus): "completed" | "cancelled" {
  return stopStatus === LoopStopStatus.Interrupted || stopStatus === LoopStopStatus.Error
    ? "cancelled"
    : "completed";
}

function sessionAssessment(goal: string, topology: AgentTopology): SessionAssessment {
  return {
    goal,
    roles: topology.roles.map((role) => role.name),
    successCriteria: ["session reaches a deterministic terminal status"],
    constraints: ["stop decisions are made by GroveLoopRunner, not by agent prose"],
  };
}
