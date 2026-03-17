/**
 * SKILL.md template for `grove skill install`.
 *
 * Generates the skill manifest that AI coding assistants
 * (Claude Code, Codex, etc.) read to discover Grove tools.
 */

/**
 * Render the SKILL.md content with the given server URLs.
 */
export function renderSkillTemplate(opts: { serverUrl: string; mcpUrl: string }): string {
  return `---
name: grove
description: Multi-agent collaboration via Grove boardroom.
---

## Grove Boardroom

You are participating in a Grove collaboration session.
Server: ${opts.serverUrl}

### MCP Server
Connect via: grove-mcp (stdio) or HTTP at ${opts.mcpUrl}

### Tools
- grove_contribute — publish work
- grove_claim — claim a task
- grove_review — review a contribution
- grove_discuss — post discussion
- grove_frontier — see rankings
- grove_goal — read current goal
- grove_send_message — message agents
- grove_checkout — get artifacts

### Workflow
1. Read the goal (grove_goal)
2. Claim work (grove_claim)
3. Do your work in YOUR code folder
4. Publish results (grove_contribute)
5. Read reviews, iterate
`;
}
