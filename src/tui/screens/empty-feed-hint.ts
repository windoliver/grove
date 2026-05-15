/** Empty contribution-feed hint based on live agent state. */
export function emptyFeedHint(
  activeRoles?: readonly string[] | undefined,
  agentFailures?: ReadonlyMap<string, string> | undefined,
): string {
  if ((agentFailures?.size ?? 0) > 0) {
    return "Agent startup failed; check agent status";
  }
  if (activeRoles && activeRoles.length === 0) {
    return "No active agents";
  }
  return "Agents are working on your goal";
}
