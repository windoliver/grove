# C2: Command Prompt + Filter with Alias Chain

**Issue:** [#302](https://github.com/windoliver/grove/issues/302)
**Parent:** Epic C — TUI Views + Mutation Safety ([#284](https://github.com/windoliver/grove/issues/284))
**Depends on:** #296 Central store (closed), #301 Generic EntityView (PR #409, pending merge)

## Goal

A k9s-style `<Prompt>` component for the TUI's running view, supporting two modes:
- `:` goto/command mode with alias chain resolution.
- `/` in-view filter mode that narrows the currently expanded panel without tearing down state.

Aliases live in YAML, are zod-validated, and resolve recursively with cycle detection.

## Non-goals

- File-watcher / hot-reload of `aliases.yaml` (defer to follow-up).
- Argument parsing for goto commands beyond passthrough as `argv`.
- Permanent Sessions/Tasks/Reviews views — this issue stubs them via EntityView; full views land in C3/C4.
- Replacing the existing Ctrl+P command palette (different UX, different scope).

## Architecture

Four units, sharp boundaries:

```
prompt.tsx            (presentational; no IO, no aliases logic)
   ↑
running-view.tsx      (integration; owns prompt + filter state, dispatches goto)
   ↓                   ↓
aliases-loader.ts    aliases.ts
(IO + zod schema)    (pure: resolveAlias, matchAliases, DEFAULT_ALIASES)
```

Why this split:
- Recursion / cycle bug → `aliases.ts`.
- YAML schema regression → `aliases-loader.ts`.
- UX bug → `prompt.tsx`.
- Routing bug → `running-view.tsx`.

Each unit is independently testable and replaceable.

## Components

### `src/tui/data/aliases.ts` (pure)

```ts
export interface AliasEntry {
  readonly value: string;
}
export type AliasMap = ReadonlyMap<string, AliasEntry>;

export const DEFAULT_ALIASES: AliasMap = new Map([
  ["a", { value: "agents" }],
  ["s", { value: "sessions" }],
  ["t", { value: "tasks" }],
  ["d", { value: "dag" }],
  ["r", { value: "reviews" }],
  ["q", { value: "quit" }],
]);

export const MAX_ALIAS_DEPTH = 8;

export type ResolveResult =
  | { kind: "ok"; command: string; argv: readonly string[]; chain: readonly string[] }
  | { kind: "miss"; key: string }
  | { kind: "cycle"; chain: readonly string[] }
  | { kind: "depth"; chain: readonly string[] };

export function resolveAlias(map: AliasMap, input: string): ResolveResult;
export function matchAliases(map: AliasMap, prefix: string): readonly string[];
```

Resolution rules:
- Input split on whitespace; first token is the alias key, rest is `argv`.
- Alias `value` starting with `:` re-enters resolution with argv concatenated.
- Alias `value` not starting with `:` is terminal — returns `{kind:'ok'}` with command = first token of value.
- Visited-set cycle detection per resolve call.
- Depth tracked starting at 0 for the entry call; recursion increments. `MAX_ALIAS_DEPTH = 8` means **8 recursion hops allowed**; the 9th hop returns `{kind:'depth'}`.
- Empty input or unknown key at depth 0 → `{kind:'miss'}`.

### `src/tui/data/aliases-loader.ts` (IO)

```ts
const AliasFileSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/),
  z.string().min(1),
);

export interface LoadResult {
  readonly aliases: AliasMap;          // merged: defaults <- user <- project
  readonly errors: readonly string[];  // per-file parse/schema errors for flash bar
}

export async function loadAliases(groveDir: string): Promise<LoadResult>;
```

Read order, project wins:
1. `DEFAULT_ALIASES` (built-in)
2. `~/.grove/aliases.yaml` (user, optional)
3. `<groveDir>/.grove/aliases.yaml` (project, optional)

ENOENT is silent; parse / schema / permission errors return empty map for that file plus an error message; loader falls back to defaults.

### `src/tui/components/prompt.tsx` (presentational)

```ts
export type PromptMode = "none" | "goto" | "filter";

export interface PromptProps {
  readonly mode: PromptMode;
  readonly query: string;
  readonly suggestions?: readonly string[];
  readonly suggestionIndex?: number;
  readonly error?: string;
}
```

- `mode === "none"` → renders nothing.
- Otherwise renders a one-line `:query` or `/query` input above the existing footer.
- Dropdown overlay with j/k cursor + selection highlight when `suggestions.length > 1`.
- All keystrokes routed by parent; component is pure render + forwarding.

### `running-view.tsx` integration

New state:
```ts
const [promptMode, setPromptMode]       = useState<PromptMode>("none");
const [promptText, setPromptText]       = useState("");
const [suggestionIdx, setSuggestionIdx] = useState(0);
const [flashError, setFlashError]       = useState<{msg:string,until:number}|null>(null);
const [filterQuery, setFilterQuery]     = useState("");
const [aliases, setAliases]             = useState<AliasMap>(DEFAULT_ALIASES);
```

Aliases load once on mount via `useEffect` calling `loadAliases(groveDir)`. Loader errors flow into the flash bar.

Goto dispatch table:
```ts
const GOTO_DISPATCH: Record<string, () => void> = {
  agents:   () => actions.expandPanel(RunningPanel.Agents),
  dag:      () => actions.expandPanel(RunningPanel.Dag),
  sessions: () => actions.expandPanel(RunningPanel.Sessions),
  tasks:    () => actions.expandPanel(RunningPanel.Tasks),
  reviews:  () => actions.expandPanel(RunningPanel.Reviews),
  quit:     () => actions.showQuitDialog(),
};
```

Three new entries added to `RunningPanel`:
```ts
Sessions: 6, Tasks: 7, Reviews: 8,
```

Stub renderers:
- **Sessions** — `EntityView` with `kind: "acp_session"` (kind exists per `src/tui/data/acp-session-store.ts`).
- **Tasks**, **Reviews** — placeholder `<box>` text. Alias still routes (so chain works end-to-end); panel content is a "coming in C3/C4" stub.

### `running-keyboard.ts` change

Replace `:` send-msg trigger with goto trigger; `m` remains the only send-msg key:

```ts
// before: if ((key.sequence === ":" || input === "m") && actions.hasSendToAgent ...)
// after:  if (input === "m" && actions.hasSendToAgent ...)
//
// new: if (key.sequence === ":") actions.enterGotoMode();
//      if (key.sequence === "/") actions.enterFilterMode();
```

Inside `promptMode !== "none"`, route Tab/Enter/Esc/Backspace/typing through prompt-specific actions.

## Data flow

### Goto (`:a`)

```
':' → enterGotoMode()           promptMode='goto', text=''
'a' → appendPromptChar          text='a'
Tab → matchAliases(map,'a')     1 match: insert+space; >1: dropdown
Enter → resolveAlias(map,'a')   {ok, command:'agents'}
       → GOTO_DISPATCH['agents']  expandPanel(Agents)
       → exit prompt
```

### Filter (`/foo`)

```
'/' → enterFilterMode           promptMode='filter', filterQuery=''
'foo' → live update             setFilterQuery('foo'), EntityView re-renders
                                with predicate (e) => columns.some(c =>
                                  c.render(e).toLowerCase().includes('foo'))
Enter → exit prompt              filterQuery RETAINED across panel switches
Esc   → exit prompt              filterQuery RETAINED
Esc Esc → second clears filter   filterQuery=''
```

### Recursive resolve

```yaml
# example aliases.yaml
dev: ":a"           # → "agents"
prod: ":dev foo"    # → ":a foo" → command='agents', argv=['foo']
loop: ":loop"       # cycle
deep: ":d1"
d1: ":d2"
... d8: ":a"        # depth 8 OK
d9: ":a"            # depth 9 → depth error
```

Algorithm sketch:
```ts
function resolveAlias(map, input, depth=0, visited=new Set(), chain=[]) {
  const [key, ...rest] = input.trim().split(/\s+/);
  if (!key) return { kind: 'miss', key: '' };
  if (visited.has(key)) return { kind: 'cycle', chain: [...chain, key] };
  if (depth > MAX_ALIAS_DEPTH) return { kind: 'depth', chain };
  const entry = map.get(key);
  if (!entry) {
    return depth === 0
      ? { kind: 'miss', key }
      : { kind: 'ok', command: key, argv: rest, chain };
  }
  if (!entry.value.startsWith(':')) {
    const [cmd, ...args] = entry.value.split(/\s+/);
    return { kind: 'ok', command: cmd, argv: [...args, ...rest], chain: [...chain, key] };
  }
  visited.add(key);
  const next = entry.value.slice(1) + (rest.length ? ' ' + rest.join(' ') : '');
  return resolveAlias(map, next, depth + 1, visited, [...chain, key]);
}
```

## Filter wiring

Filter predicate composes with EntityView's existing `predicate` prop (e.g. agent-list's "active only"):

```ts
function buildFilterPredicate<K>(
  query: string,
  columns: readonly EntityColumn<EntityForKind<K>>[],
): ((e: EntityForKind<K>) => boolean) | undefined {
  if (!query.trim()) return undefined;
  const q = query.toLowerCase();
  return (e) => columns.some((c) => c.render(e).toLowerCase().includes(q));
}

// running-view passes:
predicate={(e) => viewPredicate(e) && (filterPredicate?.(e) ?? true)}
```

Filter applies to whichever panel is currently expanded. Switching panels keeps `filterQuery` set; the predicate auto-applies to the new panel's columns. Esc-Esc clears.

## Error handling

| Failure | Detection | User-visible response |
|---|---|---|
| YAML parse error | `yaml.parse()` throws | Flash: `aliases.yaml: parse error — using defaults` |
| Schema violation | zod `safeParse().success === false` | Flash: `aliases.yaml: invalid entry "<key>"` |
| File missing (ENOENT) | fs error code | Silent; defaults used |
| Permission denied (EACCES) | fs error code | Flash: `aliases.yaml: permission denied` |
| Cycle | `resolveAlias` → `{kind:'cycle'}` | Flash: `alias cycle: a → b → a` |
| Depth exceeded | `resolveAlias` → `{kind:'depth'}` | Flash: `alias chain too deep (>8): ...` |
| Unknown alias | `resolveAlias` → `{kind:'miss'}` | Flash: `:foo: unknown alias` |
| Tab on no match | `matchAliases` → `[]` | No-op (or terminal bell); promptMode retained |
| Filter matches zero | EntityView empty | Existing `EmptyState` with hint `no matches for "/<query>"` |

Flash bar is a bottom-line transient message (3s timeout), `theme.error` color, rendered above the prompt line.

Esc layering update in `running-keyboard.ts`:
1. promptMode ≠ none && text ≠ ""  → clear text only
2. promptMode ≠ none && text === "" → exit prompt
3. flashError                       → clear flash
4. filterQuery (after prompt closed) → clear filter (Esc-Esc behavior)
5. (existing) showVfs / confirmQuit / expandedPanel

## Testing

### Pure (no React, no IO)

`src/tui/data/aliases.test.ts`:
- Direct match, recursion, argv passthrough, cycle, 8-hop chain OK and 9-hop chain fails, miss at depth 0, terminal command at depth >0, empty input.
- `matchAliases` prefix sorted output, empty prefix returns all.
- `DEFAULT_ALIASES` snapshot.

`src/tui/data/aliases-loader.test.ts` (uses `tmpdir()`):
- Valid project file → merge over defaults.
- ENOENT (no files) → defaults, no errors.
- Invalid YAML → defaults + error.
- Schema violation (bad key, empty value) → defaults + error.
- Project + user both present → project wins on key conflict.
- EACCES → defaults + error.

### Component

`src/tui/components/prompt.test.tsx`:
- `mode='none'` → null.
- `mode='goto'` → `:query`.
- `mode='filter'` → `/query`.
- `suggestions.length>1` → dropdown + selected highlighted.
- `error` → flash text in error color.

### Keyboard

`src/tui/screens/running-keyboard.test.ts` (extends existing):
- `:` enters goto mode (not message).
- `m` still enters message mode.
- `/` enters filter mode.
- Goto: typed chars append, Backspace deletes, Tab triggers complete, Enter submits, Esc clears/exits.
- Esc layering: clear text → exit prompt → existing layers.

### Integration

`src/tui/screens/running-view.integration.test.tsx`:
- Type `:a Enter` → `expandPanel(Agents)` called.
- Type `:dag Enter` → `expandPanel(Dag)` called.
- Type `:badkey Enter` → flash error visible, no panel change.
- Type `/foo` → EntityView receives composed predicate; row count drops.
- Type `/foo Esc` → predicate cleared; full row count restored.
- Tab with multiple matches → dropdown shows; j/k navigates; Enter picks.

### Acceptance (issue exit criteria)

One end-to-end test verifying issue's three criteria:
1. `:a` routes to agents view (panel state + render assertion).
2. `/foo` filters current view without tearing down state (panel ID before/after === same).
3. Invalid alias file → flash-bar error + falls back to defaults (write bad YAML to tmpdir, mount, assert flash + `:a` still works).

## Out of scope

- File-watcher / hot-reload — initial implementation loads once on mount; editing `aliases.yaml` requires TUI restart.
- Concurrent edits to `aliases.yaml`.
- Visual regression on dropdown styling beyond presence + selection highlight.
- Tasks/Reviews real WatchKinds — stub views only; real kinds land in later issues.

## Acceptance (mirrors issue)

- `:a` routes to agents view.
- `/foo` filters current view without tearing down state.
- Invalid alias file → flash-bar error, falls back to defaults.
