# OpenCode And Goose Full-Scope DX Adoption - Design

- **Date:** 2026-05-15
- **Issue:** [#225](https://github.com/windoliver/grove/issues/225)
- **Builds on:** [#212](https://github.com/windoliver/grove/issues/212), [#216](https://github.com/windoliver/grove/issues/216), [#272](https://github.com/windoliver/grove/issues/272), [#328](https://github.com/windoliver/grove/issues/328)
- **Status:** Approved design; awaiting user review before implementation plan

## Summary

Grove should adopt the useful architectural lessons from OpenCode's OpenTUI
implementation and Goose's agent organization model as one coherent program,
not as unrelated UI tweaks. This design covers the full target architecture:
extensible TUI panels, configurable layouts, anchored scrolling, stable
agent-colored collaboration surfaces, an ACP-like Grove collaboration protocol,
recipe-style reusable work templates, two-tier memory, and packaged
distributions.

The work should not ship as one monolithic change. It should be implemented in
dependency order through seven PR-sized tracks. The early tracks make the TUI
registry and layout system extensible; the later tracks make the collaboration
and reusable-work concepts first-class while preserving Grove's contribution
DAG as the source of truth.

## Goals

- Allow Grove presets, local tools, and future integrations to contribute TUI
  panels and footer/dashboard content through typed slots.
- Make operator layouts configurable through the existing layered Grove config
  path, including built-in `default`, `dense`, and `wide` modes.
- Keep scrollable views stable when content streams in and the user is pinned
  above the bottom.
- Make role and agent identity visually stable across all TUI collaboration
  surfaces.
- Formalize Grove's agent discovery, capability, delegation, and handoff
  semantics around existing gossip, claims, inbox, and handoff primitives.
- Add recipe, memory, and distribution concepts without creating a parallel
  storage model outside the contribution graph.
- Keep each implementation track independently testable and reviewable.

## Non-Goals

- A remote plugin marketplace.
- Sandboxed execution for untrusted plugin code in the first implementation.
- Replacing the direct ACP provider runtime. Grove's collaboration protocol is
  above provider ACP and should not undo the direct ACP runtime work.
- Replacing `Contribution`, `Claim`, `Handoff`, inbox messages, or gossip peer
  state with new stores.
- Solving full provider-native hot reload for skills or plugins.
- Building a visual plugin authoring UI.

## Current State

The repository already contains several pieces this design should reuse:

- `src/tui/panels/panel-registry.ts` defines data-driven built-in panel
  metadata, preset filtering, row groups, keybindings, zoom behavior, and grid
  versus tab layout modes.
- `src/tui/panels/panel-manager.tsx` renders built-in panels and adapts to
  small and medium terminal sizes.
- `src/tui/config-loader.ts` already loads layered config from global, project,
  and env override files and merges theme/keymap configuration.
- `src/tui/theme.ts` already centralizes theme tokens, `AGENT_COLORS`, platform
  colors, contribution kind icons, and `agentStatusIcon`.
- `src/tui/components/command-palette.tsx` already has fuzzy matching and
  command palette item composition.
- `src/tui/views/terminal.tsx` already models `scrollOffset` as offset from
  bottom, but anchoring is local and not shared with other scrollable panes.
- `src/core/handoff.ts`, `src/core/operations/messaging.ts`, and gossip peer
  capacity already provide much of the collaboration substrate.
- `src/core/acp-runtime.ts` and related direct ACP work already handle provider
  ACP. Grove should build coordination semantics on top of that instead of
  replacing it.

The missing piece is a stable public layer over these internals: string panel
IDs, slot registration, layout config, shared viewport anchoring, deterministic
agent display identity, collaboration protocol envelopes, and typed reusable
work object contexts.

## Chosen Approach

Use a foundation-first full-scope approach.

The full architecture is designed now, but implementation proceeds in order:

1. TUI registry foundation.
2. Local plugin loading and example panels.
3. Layout config and built-in layout modes.
4. Shared scroll anchoring.
5. Agent identity UX.
6. Grove collaboration protocol layer.
7. Recipes, memory, and distributions.

This sequence gives later tracks stable APIs to build on. The TUI plugin and
layout tracks establish public IDs and extension boundaries. The agent UX track
then applies stable identity consistently. The protocol and reusable-work tracks
use existing persistence primitives after the UI has a place to expose them.

## Architecture

### TUI Extensibility Foundation

Add `src/tui/plugins/` as the public extension boundary for TUI features. Core
panels remain built in, but they should be represented through the same
registry shape that plugin panels use. This lets `PanelManager` render a merged
registry of built-in and plugin entries while keeping built-in panels typed and
tree-shaken normally.

Slots:

- `operator-panel`: full panels that participate in focus, visibility,
  keybinding, and layout.
- `dashboard`: compact dashboard widgets rendered near existing dashboard
  content.
- `detail-adjacent`: context panels related to the selected contribution,
  artifact, or session.
- `footer`: compact status/footer content such as subagent state.
- `command-palette`: palette actions contributed by integrations or
  distributions.

Plugins receive a constrained `TuiPluginContext`, not raw access to the whole
application. The context includes the data provider, topology, selected
session, selected contribution, current theme, layout density, and limited
actions such as selecting a session or opening detail.

The first implementation is trusted local code loaded by Bun from configured
paths. A failing plugin should log a diagnostic and be skipped; it must not
prevent the TUI from starting.

### Operator Layout And Scroll Ergonomics

Extend `GroveUserConfig` with a `layout` section. Config still loads from:

1. `~/.config/grove/config.json`
2. `.grove/config.json`
3. `GROVE_CONFIG`

Layout config uses string IDs so built-in and plugin panels share the same
path. Built-in panels should get stable IDs such as `dag`, `detail`,
`frontier`, `claims`, `agents`, `terminal`, `artifact`, `vfs`, `activity`,
`search`, `threads`, `outcomes`, `bounties`, `gossip`, `inbox`, `decisions`,
`github`, and `plan`.

The layout system should provide three built-ins:

- `default`: current behavior.
- `dense`: fewer margins, compact rows, hide low-signal operator panels unless
  explicitly visible.
- `wide`: keep protocol panels and operator panels side by side when terminal
  width allows.

Scroll anchoring becomes a pure helper used by terminal, trace, session,
artifact, and search-like views. The model stays offset-from-bottom for simple
auto-scroll but records an anchor line key while pinned so layout recalculation
does not jump the user's viewport.

### Agent Identity And Live Collaboration UX

Add deterministic display identity helpers around existing `AgentIdentity`.
Colors should be assigned by stable input, preferably `role + agentId`, not by
registration order. This keeps colors stable across refreshes, reconnects, and
different panels.

All collaboration surfaces should use the same helpers:

- DAG and contribution rows.
- Detail and dashboard contribution metadata.
- Agent graph/list.
- Inbox and handoff views.
- Terminal/session headers.
- Footer slot content.

The footer slot should include a compact subagent status strip with role,
agent display name, status icon, last activity, and handoff/blocked indicators.
This gives multi-agent sessions an always-visible status surface without
requiring the operator to keep the agents panel open.

### Grove Collaboration Protocol

Formalize an internal Grove collaboration protocol above the existing stores.
It is ACP-like in purpose, but Grove-specific in persistence and routing.

Core concepts:

- Discovery: which agents, roles, peers, and capacities are visible.
- Capabilities: named abilities an agent or peer can satisfy.
- Delegation: a structured request to a role, agent, or peer.
- Handoff: receipt, acknowledgement, processing, reply, expiry, and
  dead-letter states.
- Session binding: which request, claim, contribution, and handoff belong
  together.

This protocol should map onto existing primitives:

- `Claim` continues to represent lease-based coordination.
- `Handoff` continues to represent role-to-role work transfer and reply
  lifecycle.
- Discussion contributions with message context continue to power inbox
  messages.
- Gossip peer state continues to power peer discovery and remote capacity.
- Contributions remain the durable result of delegated work.

The protocol layer should first ship as typed models and helpers, then later
gain CLI/API commands. The TUI can render protocol state as soon as the helpers
exist.

### Reusable Work Objects

Recipes, memory, and distributions should be first-class but graph-compatible.

Recipes are reusable task templates. Store them as `ContributionKind.Plan`
with tag `recipe` and context type `grove.recipe.v1`. A recipe contains a
parameter schema, default values, optional schedule hints, required
capabilities, suggested topology role, and prompt/body template. Running a
recipe creates normal claims, messages, or plan/work contributions according to
the recipe definition.

Memory is persistent knowledge. Store project memory as normal discussion
contributions with tag `memory` and context type `grove.memory.v1`. User-global
memory can live in a user Grove directory and be imported into a session view
as read-only or copied into the project as a contribution. Memory entries
should include scope, tags, summary, body, provenance, and updated/replaces
relations when revised.

Distributions package presets, topology, layout, plugins, recipes, memory seed
entries, and docs into a shareable bundle. Importing a distribution writes or
references normal Grove config and contributions. The first distribution format
should be local-file based; publishing and remote trust policy can come later.

## Public Types

### TUI Plugins

```ts
export type TuiSlot =
  | "operator-panel"
  | "dashboard"
  | "detail-adjacent"
  | "footer"
  | "command-palette";

export interface TuiPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly slots: readonly TuiSlot[];
}

export interface TuiPanelRegistration {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly defaultVisible?: boolean | undefined;
  readonly order?: number | undefined;
  readonly component: React.ComponentType<TuiPluginContext>;
}

export interface TuiPluginContext {
  readonly provider: import("../provider.js").TuiDataProvider;
  readonly topology?: import("../../core/topology.js").AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
}
```

### Layout Config

```ts
export interface TuiLayoutConfig {
  readonly preset?: "default" | "dense" | "wide" | undefined;
  readonly mode?: "grid" | "tab" | undefined;
  readonly visiblePanels?: readonly string[] | undefined;
  readonly rowWeights?: Readonly<Record<string, number>> | undefined;
  readonly panelOrder?: readonly string[] | undefined;
  readonly density?: "comfortable" | "compact" | undefined;
}
```

### Anchored Viewports

```ts
export interface AnchoredViewportState {
  readonly offsetFromBottom: number;
  readonly anchorLineKey?: string | undefined;
  readonly anchorLineOffset?: number | undefined;
}

export interface ViewportLine {
  readonly key: string;
}
```

### Agent Display Identity

```ts
export interface AgentDisplayIdentity {
  readonly agentId: string;
  readonly role?: string | undefined;
  readonly platform?: string | undefined;
  readonly displayName: string;
  readonly color: string;
}
```

### Collaboration Protocol

```ts
export interface AgentCapability {
  readonly name: string;
  readonly version?: string | undefined;
  readonly inputSchema?: import("./models.js").JsonValue | undefined;
}

export interface DelegationEnvelope {
  readonly requestId: string;
  readonly fromAgentId: string;
  readonly toAgentId?: string | undefined;
  readonly toRole?: string | undefined;
  readonly peerId?: string | undefined;
  readonly requiredCapabilities: readonly string[];
  readonly sourceCid?: string | undefined;
  readonly claimId?: string | undefined;
  readonly replyRequired: boolean;
  readonly createdAt: string;
}
```

### Reusable Work Contexts

```ts
export interface RecipeContextV1 {
  readonly type: "grove.recipe.v1";
  readonly parameters: import("./models.js").JsonValue;
  readonly defaults?: import("./models.js").JsonValue | undefined;
  readonly requiredCapabilities?: readonly string[] | undefined;
  readonly suggestedRole?: string | undefined;
  readonly template: string;
}

export interface MemoryContextV1 {
  readonly type: "grove.memory.v1";
  readonly scope: "project" | "global";
  readonly tags: readonly string[];
  readonly body: string;
  readonly provenance?: import("./models.js").JsonValue | undefined;
}

export interface GroveDistributionManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly presets?: readonly string[] | undefined;
  readonly layout?: TuiLayoutConfig | undefined;
  readonly plugins?: readonly string[] | undefined;
  readonly recipes?: readonly string[] | undefined;
  readonly docs?: readonly string[] | undefined;
}
```

## Data Flow

### TUI Startup

1. Load Grove config with the existing config loader.
2. Validate `layout` and `plugins` config fields.
3. Build the built-in panel registry.
4. Load trusted local plugin modules from configured paths and distribution
   manifests.
5. Merge built-in and plugin panel registrations by slot.
6. Apply layout preset, panel order, visible panel list, row weights, and
   terminal-size fallbacks.
7. Render `PanelManager` against the merged registry.

### Delegation

1. A local agent or operator creates a delegation envelope.
2. The protocol layer resolves target role, agent, or peer using topology,
   live agent state, capabilities, and gossip capacity.
3. The write path creates or updates the relevant claim/handoff/message
   records through existing stores.
4. Target agents receive handoff/inbox notifications through existing delivery
   paths.
5. Replies resolve the handoff by contribution CID and update protocol views.

### Recipe Execution

1. A recipe is discovered by tag/context or distribution manifest.
2. User or agent supplies parameters.
3. Grove validates parameters against the recipe schema.
4. Grove materializes a plan, claim, message, or prompt using the template.
5. Normal contribution and handoff flows handle the execution result.

### Memory Retrieval

1. A user or agent queries memory by scope, tags, text, or provenance.
2. Project memory comes from current project/session contributions.
3. Global memory comes from user-level Grove storage or imported seed entries.
4. Returned entries include provenance and CIDs so agents can cite durable
   graph state when possible.

## Implementation Tracks

### Track 1: TUI Registry Foundation

- Introduce stable string IDs for built-in panels at the registry/config
  boundary.
- Add `TuiPluginRegistry` and slot descriptor types.
- Adapt built-in panels into the merged registry path.
- Keep the numeric `Panel` constants internally where useful during migration.
- Test ordering, duplicate IDs, preset filtering, focus behavior, and visibility.

### Track 2: Local Plugin Loading And Example Panels

- Add trusted local plugin loading from config.
- Add distribution-provided plugin references.
- Add failure isolation and diagnostics for failed plugin imports.
- Add a minimal `research-loop/eval-results` example operator panel.
- Test missing plugin, bad plugin, duplicate plugin ID, and working example
  render.

### Track 3: Layout Config And Dense/Wide Modes

- Extend `GroveUserConfig` and its Zod schema with `layout`.
- Add built-in layout presets.
- Apply layout config in `PanelManager` and registry query helpers.
- Support `visiblePanels`, `panelOrder`, `rowWeights`, `density`, and `mode`.
- Test layered config merge and layout application.

### Track 4: Scroll Anchoring And Viewport Helpers

- Add pure viewport anchoring helpers under `src/tui/data/` or
  `src/tui/hooks/`.
- Migrate terminal view first.
- Migrate trace/session-like panes, artifact preview, and search result panes
  where the data shape can provide stable line keys.
- Test auto-scroll, pinned scroll, new content while pinned, truncation, and
  terminal resize.

### Track 5: Agent Identity UX

- Add deterministic agent display identity helpers.
- Replace one-off role/platform color use with shared helpers.
- Apply colors to contribution rows, DAG/detail metadata, agent views,
  inbox/handoff views, terminal/session headers, and footer slot.
- Add subagent footer registration as a built-in footer slot entry.
- Test deterministic colors and representative rendered output.

### Track 6: Collaboration Protocol Layer

- Add protocol models for capabilities, discovery, delegation, and session
  binding.
- Add helpers that map envelopes to claims, handoffs, inbox messages, and
  gossip peers.
- Expose protocol state to TUI panels.
- Add server/CLI routes only after the internal helper API is stable.
- Test mapping behavior, invalid targets, capability mismatch, reply-required
  lifecycle, peer delegation, and dead-letter visibility.

### Track 7: Recipes, Memory, And Distributions

- Add typed context schemas for `grove.recipe.v1` and `grove.memory.v1`.
- Add operations for creating, listing, validating, and running recipes.
- Add operations for writing and retrieving project/global memory.
- Add local distribution manifest parsing and import.
- Add TUI/CLI discovery once storage behavior is stable.
- Test context validation, graph compatibility, import idempotency, and
  execution through normal Grove write paths.

## Testing Strategy

- Use `bun test`.
- Keep pure helpers heavily unit-tested: registry merging, layout resolution,
  viewport anchoring, color hashing, protocol envelope validation, context
  schemas.
- Use `react-test-renderer` for TUI component tests, matching existing TUI
  tests.
- Add integration tests only where a track crosses storage or config
  boundaries: plugin loading, config layering, recipe import, memory retrieval,
  and delegation mapping.
- Add targeted regression tests for small terminal behavior and plugin failure
  isolation.
- Run `bun run typecheck` and `bun run check` before each PR.

## Migration And Compatibility

- Existing config without `layout` or `plugins` keeps current behavior.
- Existing numeric `Panel` internals can remain until all built-in panel logic
  has moved to string IDs.
- Existing contribution kinds remain unchanged. Recipes and memory use tags and
  typed contexts instead of new enum variants.
- Existing handoff, inbox, claim, and gossip stores remain the durable backing
  model for the collaboration protocol layer.
- Plugins are opt-in. A plugin load failure should not make existing Grove
  sessions unusable.

## Security And Trust

The first plugin system is trusted local code. Loading plugins from arbitrary
paths is equivalent to running local code in the TUI process. The loader should
make that trust boundary explicit in config docs and diagnostics.

Remote plugin marketplaces, signature verification, permission prompts, and
sandboxing are deferred. Distribution import should start local-only and reuse
existing safe path validation patterns where it writes files or references
plugin paths.

Collaboration protocol envelopes should not trust model-supplied agent
identity. Trusted identity comes from Grove session/runtime context, existing
claim ownership, handoff source, or server-side auth context.

## Risks

- Dynamic plugin loading can destabilize TUI startup if failure isolation is
  weak.
- Converting panel IDs risks focus/keybinding regressions if numeric and string
  IDs are mixed carelessly.
- Layout customization can make panels unreadable if constraints are too loose.
- Scroll anchoring needs stable line keys; some existing views may need small
  data-shape changes before they can migrate safely.
- The collaboration protocol can become a second source of truth if it stores
  state outside claims, handoffs, inbox messages, gossip, and contributions.
- Recipes and distributions can grow into a package manager if scope is not
  kept local and graph-compatible at first.

## Acceptance Criteria

- A local plugin can register an operator panel and command palette item through
  config without modifying `PanelManager`.
- Built-in and plugin panels use stable string IDs for layout config.
- `default`, `dense`, and `wide` layout presets work through layered config.
- Pinned terminal output remains anchored when new output arrives.
- Agent colors are deterministic across TUI refreshes and are shared by DAG,
  agent, inbox/handoff, and terminal/session surfaces.
- The subagent footer shows compact live multi-agent status without requiring
  the agents panel to be visible.
- Delegation envelopes can be mapped to existing claim/handoff/inbox/gossip
  state and rendered in the TUI.
- Recipes and memory are stored as normal contributions with typed contexts.
- A local distribution can import or reference layout, plugins, recipes, and
  docs without creating a parallel store.

## Follow-Up Plans

This design should produce separate implementation plans for each track. Track
1 is the first implementation plan because every later TUI-facing feature
depends on stable string IDs and a merged registry. Track 6 and Track 7 should
not begin until the UI extension and layout paths are stable enough to expose
their state.

