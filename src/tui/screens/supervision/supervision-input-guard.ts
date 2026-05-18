/**
 * Pure guard predicate for the supervision keyboard owner (#193 Task 10).
 *
 * Supervision only consumes keys when GROVE_SUPERVISION is on, it is the
 * visible body (no panel expanded), and no modal / overlay / input mode owns
 * the keyboard. Extracted into its own leaf module (no heavy imports) so the
 * risky guard logic can be unit-tested without pulling RunningView's full
 * module graph (config-watcher → chokidar, opentui, etc.).
 */

export interface SupervisionInputState {
  readonly useSupervision: boolean;
  readonly expandedPanelNull: boolean;
  readonly cmdMode: string;
  readonly promptMode: boolean;
  readonly showHelp: boolean;
  readonly showVfs: boolean;
  readonly filterQuery: string;
}

export function supervisionInputActive(s: SupervisionInputState): boolean {
  return (
    s.useSupervision &&
    s.expandedPanelNull &&
    s.cmdMode === "none" &&
    !s.promptMode &&
    !s.showHelp &&
    !s.showVfs &&
    s.filterQuery === ""
  );
}
