import type { HandoffOperatorProjection } from "../core/handoff-operator-state.js";
import { HandoffOperatorAction } from "../core/handoff-operator-state.js";
import type { TuiDataProvider } from "./provider.js";
import { isHandoffProvider } from "./provider.js";

export type HandoffPromptResult = string | null | undefined;

export interface PerformHandoffOperatorActionOptions {
  readonly provider: TuiDataProvider;
  readonly projection: HandoffOperatorProjection;
  readonly action: HandoffOperatorAction;
  readonly sessionId?: string | undefined;
  readonly activeRoles?: readonly string[] | undefined;
  readonly promptReason: (
    action: HandoffOperatorAction,
    projection: HandoffOperatorProjection,
  ) => Promise<HandoffPromptResult>;
  readonly promptRerouteRole: (
    projection: HandoffOperatorProjection,
    roles: readonly string[],
  ) => Promise<HandoffPromptResult>;
}

export async function performHandoffOperatorAction(
  options: PerformHandoffOperatorActionOptions,
): Promise<boolean> {
  if (!options.projection.actions.includes(options.action)) return false;
  if (!isHandoffProvider(options.provider)) {
    throw new Error("Handoff provider not configured");
  }

  const handoffId = options.projection.handoff.handoffId;

  if (options.action === HandoffOperatorAction.Cancel) {
    const reason = normalizePrompt(await options.promptReason(options.action, options.projection));
    if (reason === null) return false;
    await options.provider.cancelHandoff(handoffId, reason, options.sessionId);
    return true;
  }

  if (options.action === HandoffOperatorAction.ManualResolve) {
    const reason = normalizePrompt(await options.promptReason(options.action, options.projection));
    if (reason === null) return false;
    await options.provider.manualResolveHandoff(handoffId, reason, options.sessionId);
    return true;
  }

  if (options.action === HandoffOperatorAction.Resend) {
    const reason = normalizePrompt(await options.promptReason(options.action, options.projection));
    if (reason === null) return false;
    await options.provider.resendHandoff(handoffId, {
      ...(reason !== undefined ? { reason } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    });
    return true;
  }

  const targetRole = normalizePrompt(
    await options.promptRerouteRole(options.projection, options.activeRoles ?? []),
  );
  if (targetRole === null || targetRole === undefined) return false;
  const reason = normalizePrompt(await options.promptReason(options.action, options.projection));
  if (reason === null) return false;
  await options.provider.rerouteHandoff(handoffId, {
    toRole: targetRole,
    ...(reason !== undefined ? { reason } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
  return true;
}

function normalizePrompt(value: HandoffPromptResult): string | null | undefined {
  if (value === null) return null;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
