# Grove TUI Design System

Design tokens, keyboard grammar, and component conventions for the Grove terminal UI.

## Color Tokens

All colors defined in `src/tui/theme.ts`. Import `theme` for use.

| Token | Hex | Usage |
|-------|-----|-------|
| `focus` | `#00cccc` | Focused element borders, cursor, active highlights |
| `inactive` | `#666666` | Unfocused panel borders |
| `border` | `#555555` | Standard panel borders |
| `running` | `#00cc00` | Active agent status, success states |
| `waiting` | `#cccc00` | Pending agent status, warning states |
| `error` | `#ff0000` | Error states, failed agents |
| `stale` | `#ff8800` | Stale data indicator |
| `text` | `#ffffff` | Primary text |
| `secondary` | `#888888` | Labels, hints, timestamps, muted text |
| `disabled` | `#666666` | Non-interactive elements |
| `headerBg` | `#1a1a2e` | Panel header background |
| `selectedBg` | `#0d2137` | Selected row background |

### Contribution Kind Colors

| Kind | Color | Icon |
|------|-------|------|
| work | `#00cc00` | `▒` |
| review | `#cccc00` | `▷` |
| discussion | `#0088cc` | `◇` |
| adoption | `#cc00cc` | `▲` |
| reproduction | `#00cccc` | `◐` |

### Platform Colors

| Platform | Color |
|----------|-------|
| claude-code | `#ff8800` |
| codex | `#0088ff` |
| gemini | `#00cc88` |

## Spacing

Terminal character units. Import `spacing` from `theme.ts`.

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 0 | No spacing |
| `sm` | 1 | Tight spacing (between inline elements) |
| `md` | 2 | Standard padding (paddingX, marginX) |
| `lg` | 3 | Section separation |

## Borders

Import `borders` from `theme.ts`.

| Token | Style | Usage |
|-------|-------|-------|
| `panel` | `single` | Standard panel borders, input fields |
| `modal` | `round` | Modal overlays, help overlays, screen containers |

## Timing

Import `timing` from `theme.ts`.

| Token | Value | Usage |
|-------|-------|-------|
| `spinner` | 80ms | Braille spinner animation frame interval |
| `pollBase` | 3000ms | Base polling interval |

### Polling Tiers

Multiply `pollBase` by tier multiplier:

| Tier | Multiplier | Interval | Used for |
|------|-----------|----------|----------|
| hot | 1x | 3s | Contribution feed, agent status |
| warm | 3x | 9s | Claims, dashboard data |
| cold | 5x | 15s | Session costs, agent profiles |
| frozen | 10x | 30s | Terminal buffers, GitHub PRs |

## Keyboard Grammar

Consistent keybinding patterns across all screens.

### Navigation
- `j` / `↓` — Move down in lists
- `k` / `↑` — Move up in lists
- `Enter` — Select, drill-down, submit
- `Esc` — Back, dismiss, cancel
- `q` — Quit (with confirmation in Running view)

### Discovery
- `?` — Help overlay (context-sensitive)
- `/` — Search (in panels that support it)
- `:` — Command mode / message input

### Screen-specific
- `1-9` — Toggle agent output expansion (Running view)
- `m` — Message mode (Running view)
- `Ctrl+A` — Advanced boardroom (deliberate entry)
- `Ctrl+B` — Back from advanced to running
- `Ctrl+F` — File browser (VFS)
- `Ctrl+U` — Clear text input
- `y` / `n` — Approve/deny permission prompts

### Advanced boardroom
- `1-4` — Focus core panels
- `5-]` — Toggle operator panels
- `Tab` — Cycle panel focus
- `+` — Zoom cycle (Normal → Half → Full)
- `b` — Broadcast message
- `@` — Direct message

## Agent Status Symbols

| Symbol | State | Color |
|--------|-------|-------|
| `●` | Running (active work) | `running` |
| `◐` | Waiting (idle, ready) | `waiting` |
| `○` | Idle (no activity) | `idle` |
| `✗` | Error (crashed) | `error` |

Animated braille spinner (`⠋⠙⠹...`) used for spawning/working states.

## Component Inventory

| Component | File | Usage |
|-----------|------|-------|
| `StatusBar` | `components/status-bar.tsx` | Bottom bar with mode + contextual hints |
| `HelpOverlay` | `components/help-overlay.tsx` | `?` key keybinding reference |
| `CommandPalette` | `components/command-palette.tsx` | Ctrl+P fuzzy command search |
| `EmptyState` | `components/empty-state.tsx` | Empty data placeholder with hint |
| `BreadcrumbBar` | `components/breadcrumb-bar.tsx` | Screen navigation breadcrumbs |
| `InputBar` | `components/input-bar.tsx` | Text input with mode indicator |
| `ProgressBar` | `components/progress-bar.tsx` | Metric progress display |
| `Table` | `components/table.tsx` | Data table with column truncation |
| `TabBar` | `components/tab-bar.tsx` | Panel visibility indicator |
| `Sparkline` | `components/sparkline.tsx` | Inline graph for trends |
| `OutcomeBadge` | `components/outcome-badge.tsx` | Status badge for outcomes |
| `SplitDiff` | `components/split-diff.tsx` | Side-by-side artifact comparison |
| `AgentSplitPane` | `components/agent-split-pane.tsx` | Agent terminal split view |
| `AgentWizard` | `components/agent-wizard.tsx` | Agent spawn wizard |
| `DataStatus` | `components/data-status.tsx` | Data freshness indicator |
| `TooltipOverlay` | `components/tooltip-overlay.tsx` | First-launch tooltips |

## Contrast Requirements

All text must meet WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text) against the assumed dark background (`#000000` or `#1a1a2e`).

| Token | Color | Ratio vs black | Passes AA? |
|-------|-------|---------------|------------|
| `text` | `#ffffff` | 21:1 | Yes |
| `secondary` | `#888888` | 5.32:1 | Yes |
| `disabled` | `#666666` | 3.72:1 | Yes (large text) |
| `inactive` | `#666666` | 3.72:1 | Yes (large text) |
