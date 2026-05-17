export interface UpstreamSection {
  readonly taskId: string;
  readonly summary: string;
}

export function buildPromptWithUpstream(
  basePrompt: string,
  sections: readonly UpstreamSection[],
): string {
  if (sections.length === 0) return basePrompt;
  const blocks = sections.map(
    (s) => `### ${s.taskId} (succeeded)\n${s.summary.length > 0 ? s.summary : "(no summary)"}`,
  );
  return `## Upstream output\n\n${blocks.join("\n\n")}\n\n## Your task\n\n${basePrompt}`;
}
