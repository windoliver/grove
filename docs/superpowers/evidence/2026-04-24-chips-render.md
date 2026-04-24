# E2E Evidence — Entity Adapter + Chip Render + Handoff Done (#287)

Date: 2026-04-24
Branch: `worktree-flickering-dancing-spark`
PR: https://github.com/windoliver/grove/pull/354

## What this proves

1. Real Nexus stack up (`nexus-233bc13e-nexus-1  Up (healthy)` at port 25936).
2. Real reviewer-coder loop committed to Nexus-backed stores:
   - Coder Work contribution
   - Reviewer Review contribution (with score 9)
   - Claim on the Work target
   - Claim released with `--completed` (handoff done)
3. The three Entity adapters (`contributionToEntity`, `claimToEntity`, `agentSessionToEntity`) project the real flat-type payloads into Entity shape.
4. The `ConditionChips` component renders every derived condition on a real terminal frame buffer via OpenTUI.

## Reviewer-coder loop (real CLI calls)

```
$ bun src/cli/main.ts session start --goal "Entity adapter chip render E2E" --preset review-loop
→ session 10563638-a3ae-49d9-aefb-4b044e8abc07

$ GROVE_SESSION_ID=10563638… grove contribute --kind work --role coder --summary "Coder: Entity adapter shipped" …
Contribution blake3:bae42fe4c625d026cd12f14de42dbde1dc8102c1e7f972b2484e54469b730f4b
  kind: work, mode: exploration

$ GROVE_SESSION_ID=10563638… grove contribute --kind review --reviews blake3:bae4… --role reviewer --score quality=9 …
Contribution blake3:4d1d363a4162eea5b56a7e0a156b29714a2cfafc3b39bc209dbc9f88d083615b
  kind: review, mode: exploration
  relations: 1

$ grove claim blake3:bae4… --intent "coder handoff complete"
Claimed: 9824239f-88b4-4172-b9e8-6ac1a71bb523
  status:  active

$ grove release 9824239f-88b4-4172-b9e8-6ac1a71bb523 --completed
Completed: 9824239f-88b4-4172-b9e8-6ac1a71bb523
  status:  completed
```

Frontier confirms all 5 contributions landed in Nexus:

```
$ grove frontier
By recency
CID                   SUMMARY                                            VALUE  AGENT
--------------------  ----------------------------------------  --------------  ----------------
blake3:4d1d363a416..  Reviewer: LGTM, adapter matrix complete   177701480573..  KWN9VC2WN4-22741
blake3:bae42fe4c62..  Coder: Entity adapter shipped             177701479951..  KWN9VC2WN4-22679
blake3:852bbf30c68..  E2E smoke: Entity adapter chip render ..  177701476808..  KWN9VC2WN4-14617
blake3:37bbc33ce44..  LGTM: Entity envelope + adapters are w..  177701456949..  KWN9VC2WN4-12724
blake3:3ef17937113..  Entity envelope A1: add generic Entity..  177701456296..  KWN9VC2WN4-12701
```

## Chip render (OpenTUI real frame)

Harness `scripts/render-chips-harness.tsx` feeds the real Nexus-backed
work contribution + completed claim + a running agent-session fixture
through the three adapters and renders the resulting `Condition[]`
arrays via `ConditionChips` on the real OpenTUI renderer.

Captured from OpenTUI's frame buffer (ANSI stripped for readability —
background colors are green/red/yellow in the raw capture; raw escapes
in `2026-04-24-chips-render-raw.txt`):

```
--- Contribution (Work) ---
 Published

--- Claim (Completed handoff) ---
 Active   Expired   Completed
 Active: completed
 Expired: completed

--- AgentSession (Running) ---
 Ready   Crashed
 Crashed: running

--- Summary ---
Work id: blake3:bae42fe4c625d02...
Work kind: Contribution
Claim id: 9824239f-88b4-4172-b9e8-6ac1a71bb523
Claim phase: completed
Session id: grove-coder-1-abc
Session phase: running
```

Color mapping (from the raw ANSI capture):
- `status === "True"`  → green background  (`Published`, `Completed`, `Ready`)
- `status === "False"` → red background    (`Active`, `Expired`, `Crashed` on the Claim; `Crashed` on the Session)
- `status === "Unknown"` → yellow background (none in this fixture)

Reason lines (grey, opacity 0.5) render for any chip with `status !== "True"`:
- `Active: completed` — Claim's Active condition is False because phase moved to `completed`; reason surfaces the phase.
- `Expired: completed` — same mechanic.
- `Crashed: running`  — AgentSession's Crashed condition is False because phase is `running`.

## How to reproduce

```
bun src/cli/main.ts init --preset review-loop --force
bun src/cli/main.ts up --headless --no-tui        # nexus healthy
bun src/cli/main.ts session start --goal "…" --preset review-loop &
GROVE_SESSION_ID=<session> bun src/cli/main.ts contribute --kind work …
GROVE_SESSION_ID=<session> bun src/cli/main.ts contribute --kind review --reviews <work-cid> …
bun src/cli/main.ts claim <work-cid> --intent "…"
bun src/cli/main.ts release <claim-id> --completed
GROVE_NO_ALT_SCREEN=1 bun scripts/render-chips-harness.tsx
```
