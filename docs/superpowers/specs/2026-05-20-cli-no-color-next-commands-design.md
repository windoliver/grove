# CLI NO_COLOR Support and Next Command Hints

## Context

GitHub issue #176 asks for two CLI polish changes:

- Honor `NO_COLOR`, `TERM=dumb`, and a global `--no-color` flag.
- Print suggested next commands after successful mutation commands.

The existing CLI mostly emits plain text already. It also has `UsageError.suggestion`
for error hints, but successful command hints are currently printed ad hoc by
individual commands.

## Scope

This change covers the full issue in one PR:

- Add CLI color configuration for human-readable output.
- Parse `--no-color` as a global flag before command dispatch.
- Disable color when `process.env.NO_COLOR` is set to any value.
- Disable color when `process.env.TERM === "dumb"`.
- Add successful next-command hints for `grove contribute`, `grove init`, and
  `grove claim`.
- Keep JSON output unchanged.

The Ink/OpenTUI dashboard is out of scope because it is not ordinary CLI text
formatting and has its own renderer/theme path.

## Design

Add a small CLI output utility that owns the global color decision:

- `shouldEnableColor(env, args)` returns false for `NO_COLOR`, `TERM=dumb`, or
  `--no-color`.
- `setColorEnabled(enabled)` sets the process-wide CLI output state.
- `isColorEnabled()` exposes the current state for tests and formatters.
- Optional ANSI wrappers use the global state, so future CLI colorization has one
  sanctioned entry point.
- `formatNextCommandHint(message)` formats successful mutation hints consistently.

`src/cli/main.ts` will strip `--no-color` from global args before dispatch, then
initialize the color state once. This mirrors the existing global `--grove`
parsing and avoids pushing `--no-color` into individual command parsers.

## Command Behavior

Successful human-readable mutation output gains one hint line:

- `grove contribute`:
  `hint: Run \`grove frontier\` to see updated frontier`
- `grove init`:
  `hint: Run \`grove up\` to start services`
- `grove claim`:
  `hint: Run \`grove claims\` to see active claims`

Commands using `--json` do not print hints, because extra human text would break
machine-readable output.

`grove init` currently prints a "Next:" message with multiple alternatives. The
new issue-required hint will replace that final next-step wording so there is a
single, predictable hint line.

## Error Handling

Unknown flags still use the existing `parseArgs` and `UsageError` behavior.
`--no-color` is accepted only as a global flag, either before or after the
subcommand token in the raw CLI argument list, because `main.ts` removes it
before dispatch.

## Testing

Add unit coverage for color decision rules:

- `NO_COLOR` disables color.
- `TERM=dumb` disables color.
- `--no-color` disables color.
- Default environment enables color.

Add command-level coverage for hints:

- `runClaim` prints the claim summary plus the claims hint.
- `executeContribute` prints the frontier hint in human mode and not in JSON mode.
- `executeInit` prints the `grove up` hint.

Add integration coverage for the issue acceptance case:

- `NO_COLOR=1 grove log` exits successfully and emits no ANSI escape codes.

## Rollout

This is backward-compatible for machine consumers because JSON output remains
unchanged. Human-readable output gets one extra hint line after the specified
successful mutations.
