/**
 * Whether the legacy floating "Permission Request" overlay should render.
 *
 * When supervision is the active body (GROVE_SUPERVISION=1) the supervision
 * DetailRail owns approval display, so the floating overlay must be
 * suppressed to avoid a duplicate prompt. Pure — extracted so the
 * regression guard is testable without importing running-view.tsx
 * (which transitively needs chokidar). See supervision-input-guard.ts for
 * the same pattern (#193).
 */
export function permissionBoxVisible(
  supervisionOn: boolean,
  pendingPermissionCount: number,
): boolean {
  return !supervisionOn && pendingPermissionCount > 0;
}
