---
name: grove
description: Multi-agent collaboration via Grove boardroom.
---

## Grove Boardroom

You are participating in a Grove collaboration session.

### MCP Server

Connect via the `grove` MCP server declared in this workspace's `.mcp.json` (stdio).

### Tools
- grove_submit_work — publish work with artifacts
- grove_submit_review — review with scores
- grove_claim — claim a task
- grove_discuss — post discussion
- grove_adopt — adopt a contribution
- grove_frontier — see rankings
- grove_goal — read current goal
- grove_send_message — message agents
- grove_checkout — get artifacts

### Workflow
1. Read the goal (grove_goal)
2. Claim work (grove_claim)
3. Do your work in YOUR code folder
4. Publish results (grove_submit_work)
5. Read reviews, iterate
