# ACP NDJSON fixtures

Captured from `acpx --format json --json-strict` on 2026-04-17 with acpx 0.5.3.
Regenerate only when ACP spec evolves or acpx output shape changes.

## Files

- `codex-simple.ndjson` — codex text-only turn, 9 lines. Covers session init + single `agent_message_chunk` + `usage_update` + final result.
- `claude-simple.ndjson` — claude text-only turn, 10 lines. Similar shape, with `cost` field on `usage_update` and `usage` on the final result.
- `claude-tool-call.ndjson` — claude multi-step tool-call turn, 25 lines. Covers `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`.

Gemini fixture deferred — `gemini` CLI not installed in capture environment.

## Wire shape notes

Observed, not yet reflected in the plan's parser pseudocode:

1. `session/update` frames nest under `params.update.sessionUpdate`, not `params.sessionUpdate`.
2. Session-init frames (`initialize`, `session/new`, `available_commands_update`) appear before the prompt. Parser should treat these as `raw`.
3. Codex emits `usage_update` (key `used`, `size`); claude emits `usage_update` with `used`, `size`, `cost`, AND includes `usage` on the final `result` frame.
4. Claude emits `agent_thought_chunk` (thinking). Codex does not in observed samples.
5. Tool calls come as one `tool_call` frame followed by N `tool_call_update` frames with status progression.

## Regenerate

```bash
mkdir -p tests/fixtures/acp
acpx --format json --json-strict codex  exec 'reply with exactly: hello'                              > codex-simple.ndjson
acpx --format json --json-strict claude exec 'reply with exactly: hello'                              > claude-simple.ndjson
acpx --format json --json-strict claude exec 'read the file /etc/hostname and tell me its contents'   > claude-tool-call.ndjson
```
