# Surface Parity Matrix

This document tracks which capabilities are available on each surface (CLI, MCP, HTTP, TUI)
and their classification. All `shared` capabilities use the operations layer in
`src/core/operations/` as the single source of truth.

## Classification

| Class | Meaning |
|---|---|
| **shared** | Available on all listed surfaces via the operations layer |
| **operator-only** | Only makes sense for human operators (single surface) |
| **infra-only** | Infrastructure/deployment concern (CLI, HTTP) |
| **transport-only** | Specific to a transport's capabilities |
| **deferred** | Planned but not yet implemented |

## Capability Matrix

| Capability | CLI | MCP | HTTP | TUI | Class |
|---|---|---|---|---|---|
| contribute | Y | Y | Y | - | shared |
| review | Y | Y | Y | - | shared |
| reproduce | Y | Y | Y | - | shared |
| discuss | Y | Y | Y | - | shared |
| claim | Y | Y | Y | Y | shared |
| release/complete | Y | Y | Y | Y | shared |
| list claims | Y | Y | Y | Y | shared |
| checkout | Y | Y | - | Y | shared |
| frontier | Y | Y | Y | Y | shared |
| search | Y | Y | Y | Y | shared |
| log | Y | Y | Y | Y | shared |
| tree | Y | Y | Y | Y | shared |
| thread | Y | Y | Y | Y | shared |
| threads | Y | Y | Y | Y | shared |
| check stop | - | Y | - | - | transport-only |
| bounty create | Y | Y | - | - | shared |
| bounty list | Y | Y | Y | Y | shared |
| bounty claim | Y | Y | - | - | shared |
| bounty settle | - | Y | - | - | transport-only |
| outcome set | Y | Y | Y | Y | shared |
| outcome get | Y | Y | Y | Y | shared |
| outcome list | Y | Y | Y | Y | shared |
| outcome stats | Y | Y | Y | Y | shared |
| init | Y | - | - | - | operator-only |
| up | Y | - | - | - | operator-only |
| down | Y | - | - | - | operator-only |
| ask (CLI) / ask_user (MCP) | Y | Y | - | - | transport-only |
| tui | Y | - | - | - | operator-only |
| import/export | Y | - | - | - | deferred |
| gossip peers | Y | - | Y | Y | infra-only |
| cas put | - | Y | Y | - | transport-only |
| ingest git diff | - | Y | - | - | transport-only |
| ingest git tree | - | Y | - | - | transport-only |
| artifact download | - | - | Y | Y | transport-only |
| diff | - | - | Y | Y | transport-only |
| metadata | - | - | Y | - | transport-only |

## Notes

- **contribute (CLI)**: Handles ingestion modes (git diff, git tree, report, files)
  which are CLI-specific. The core `contributeOperation` is called after ingestion.
- **discuss (CLI)**: Delegates to `executeContribute` with kind=discussion.
- **check stop**: Only meaningful for MCP agents that need to decide whether to continue.
- **bounty settle**: Operator-level action, currently MCP-only.
- **cas put / ingest**: MCP tools for agents to store content before contributing.
- **ask / ask_user**: Same capability (interactive question-asking) with transport-specific
  implementations. CLI uses `grove ask` (interactive TTY or rules-based), MCP uses `ask_user`
  (delegates to the `@grove/ask-user` package). Neither goes through the operations layer;
  each surface implements its own strategy resolution.
- **gossip**: Peer-to-peer sync, relevant for CLI daemon and HTTP server.

## JSON Output

All `shared` CLI commands support `--json` for structured output compatible with
the operations layer result types. When `--json` is active:
- Success: outputs the operation result value as JSON
- Error: outputs `{ "error": { "code": "...", "message": "..." } }` and exits 1
- TTY detection: pretty-prints when stdout is a TTY, compact when piped

## Adding New Capabilities

When adding a new capability:
1. Implement the operation in `src/core/operations/`
2. Add tests in `src/core/operations/<name>.test.ts`
3. Wire it into each required surface
4. Update this matrix
5. Update the hardcoded lists in `parity-matrix.test.ts` — the CI test verifies that
   the operations layer exports, MCP tool registrations, and CLI command registrations
   all match its lists. It does **not** parse this document, so both must be kept in sync manually.
