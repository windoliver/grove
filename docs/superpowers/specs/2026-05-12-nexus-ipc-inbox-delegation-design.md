# Nexus IPC Inbox Delegation for `readInbox`

- **Issue**: [#234](https://github.com/windoliver/grove/issues/234)
- **Related**: [#188](https://github.com/windoliver/grove/issues/188)
- **Date**: 2026-05-12

## Goal

Stop Nexus-backed `grove_read_inbox` calls from scanning the full discussion
contribution table when a recipient filter is present. Nexus mode should read
from the recipient's IPC inbox source instead of using
`ContributionStore.list({ kind: "discussion", tags: ["message"] })` followed
by JavaScript recipient filtering.

This follows the newer issue direction: Grove should delegate recipient-indexed
inbox reads to Nexus IPC rather than adding a new Grove-owned recipient index
for Nexus.

## Current Problem

`readInbox` in `src/core/operations/messaging.ts` has correct inbox semantics
but no store-level recipient selector. When `recipient` or `recipients` is set,
it disables the store-level limit so older addressed messages are not missed
behind unrelated traffic. In Nexus mode this means each recipient inbox poll can
scan the contribution index and materialize all message discussions.

Local inspection found that the old Python `nexus.bricks.ipc` router named in
the issue comment has been deleted in the checked-out Nexus tree. The live
surfaces Grove can rely on today are:

- Grove writes IPC envelopes through `src/nexus/nexus-ipc-client.ts` using
  `/api/v2/files/write` into `/ipc/{recipient}/inbox/...` or
  `/sessions/{sessionId}/ipc/{recipient}/inbox/...`.
- Grove's TUI bridge already drains those inbox directories with
  `/api/v2/files/list` and file reads.
- The Nexus TUI has references to `GET /api/v2/ipc/inbox/{agentId}`, but the
  current Nexus server tree also documents deletion of the old `/api/v2/ipc/*`
  router. Grove must treat that endpoint as optional.

## Non-Goals

- Do not add a SQLite `discussion_recipients` table in this change. That can be
  a separate local-store optimization if local inbox scans become a bottleneck.
- Do not change message write semantics. `sendMessageAsDiscussion` still creates
  ephemeral discussion contributions, and Nexus event delivery still writes IPC
  envelopes.
- Do not make Grove depend on a Nexus API that may not be present. The direct
  IPC endpoint is capability-detected.
- Do not remove existing `readInbox` filtering. It remains the canonical
  fallback for non-Nexus stores and for unfiltered contribution queries.

## Proposed Architecture

Add a small Nexus inbox read client alongside `NexusIpcClient`.

```
CLI / MCP / TUI inbox read
          |
          v
    readInboxLike entry
          |
          +-- Nexus inbox client available and recipient query present
          |      |
          |      +-- try GET /api/v2/ipc/inbox/{recipient}
          |      |
          |      +-- fallback to listing recipient inbox files
          |              /sessions/{sessionId}/ipc/{recipient}/inbox
          |              /ipc/{recipient}/inbox
          |
          +-- otherwise existing readInbox(store, query)
```

The new client owns Nexus-specific decoding and projection. The existing
`readInbox` operation remains store-oriented and backend-neutral.

## Components

### `src/nexus/nexus-inbox-client.ts`

New Nexus-specific reader.

Responsibilities:

- Accept `nexusUrl`, `apiKey`, optional `sessionId`, and fetch implementation
  for tests.
- Expose `readInbox(query)` with recipient, recipients, fromAgentId, since, and
  limit support.
- For each requested recipient handle, normalize the Nexus role by stripping a
  leading `@` for IPC paths. Broadcast `@all` is included by querying the direct
  recipient handles and the `all` inbox when useful, then deduping by message
  id or CID.
- First attempt `GET /api/v2/ipc/inbox/{recipient}`. Treat 404 and 405 as
  endpoint-unavailable for the life of the client. Treat other non-2xx responses
  as a soft failure for that recipient and continue to file-backed fallback.
- Fallback to file-backed inbox reads:
  - list the session-scoped inbox directory when `sessionId` is present
  - list the global inbox directory otherwise
  - read only `.json` entries up to a bounded page limit
  - decode the same envelope shape written by `NexusIpcClient`
- Project decoded envelopes to `InboxMessage` while preserving existing
  semantics: newest first, sender filter, since filter, `@all`, and caller limit.

### Inbox read adapter

Add a narrow helper in the operation or integration layer, for example
`readInboxWithNexusFallback(store, query, nexusInboxClient?)`.

Behavior:

- If there is no recipient query, call existing `readInbox(store, query)`.
- If a Nexus inbox client is available and the query has `recipient` or
  `recipients`, read through Nexus IPC and never call `store.list()` for the
  recipient-filtered Nexus path.
- If Nexus IPC read returns an infrastructure failure before producing any
  messages, fall back to `readInbox(store, query)` so existing deployments do
  not lose inbox visibility.

### Wiring

Use the helper in the existing entry points that currently call `readInbox`:

- `src/mcp/tools/messaging.ts`
- `src/cli/commands/inbox.ts`
- `src/tui/store-backed-provider.ts` when constructed with Nexus config

Runtime wiring should create `NexusInboxClient` from the same `NEXUS_URL`,
`NEXUS_API_KEY`, and `GROVE_SESSION_ID` values already used for `NexusIpcClient`.

## Data Flow

For a recipient query such as `readInbox({ recipients: ["@coder", "@all"], limit: 30 })`:

1. The caller reaches the inbox read adapter.
2. The adapter detects a recipient-filtered query and a configured Nexus inbox
   client.
3. The client reads `/api/v2/ipc/inbox/coder` if the endpoint exists.
4. If not, it lists `/sessions/{sessionId}/ipc/coder/inbox` and
   `/sessions/{sessionId}/ipc/all/inbox`, reads matching JSON files, and decodes
   envelopes.
5. The client applies sender and timestamp filters, sorts newest first, dedupes,
   and slices to the requested limit.
6. The contribution store is not scanned on the Nexus recipient path.

## Error Handling

- Endpoint absence (`404`, `405`) disables the direct IPC endpoint and uses the
  file-backed path.
- Individual malformed inbox files are skipped. One bad message must not make
  the inbox unreadable.
- File list/read failures for one recipient do not stop other recipient reads.
- If all Nexus IPC paths fail before producing a usable result, the adapter falls
  back to existing contribution-store `readInbox` behavior.
- Fallbacks should be observable through debug logging when `GROVE_DEBUG=1`, but
  normal CLI/MCP output should remain unchanged.

## Testing

Use TDD before implementation.

Required tests:

- A unit test proving recipient-filtered Nexus inbox reads do not call
  `ContributionStore.list()`.
- A direct-endpoint test for `GET /api/v2/ipc/inbox/{recipient}` response
  parsing and limit handling.
- A file-backed fallback test for session-scoped paths.
- A multi-recipient test proving `@all` and direct recipient messages are
  deduped and sorted newest first.
- A fallback test proving infrastructure failure returns to existing
  contribution-store `readInbox` behavior.
- Existing `src/core/operations/messaging.test.ts` behavior remains unchanged.

## Acceptance Criteria

- In Nexus mode, `grove_read_inbox` with recipient filters avoids full
  contribution-table scans.
- Existing CLI, MCP, and TUI inbox output shapes remain compatible.
- Local SQLite behavior remains unchanged.
- Nexus deployments without `/api/v2/ipc/inbox/{recipient}` still work through
  file-backed inbox directories.
- Tests cover the no-store-scan behavior and fallback paths.

## Risks

- Nexus endpoint availability is inconsistent across checked-out versions. The
  design mitigates this with capability detection and file-backed fallback.
- IPC inbox files may contain non-Grove payloads. The decoder must accept only
  known message envelope shapes and skip the rest.
- Session scoping must stay explicit. Session-scoped reads must prefer
  `/sessions/{sessionId}/ipc/...` and must not silently mix global inbox data.
