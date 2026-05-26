# TUI Extensions

Grove's first TUI extension surface is trusted local code. The TUI does not
load arbitrary module paths, remote plugins, or package manifests. Application
code passes typed extension objects into the TUI.

## Extension Shape

```ts
import type { TuiExtension } from "../../src/tui/plugins/types.js";

export const auditExtension: TuiExtension = {
  id: "audit",
  name: "Audit tools",
  version: "1.0.0",
  panels: [
    {
      id: "audit-panel",
      label: "Audit",
      slot: "operator-panel",
      defaultVisible: true,
      component: AuditPanel,
    },
  ],
  actions: [
    {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: (context) => {
        context.showMessage("Audit refresh requested");
      },
    },
  ],
};
```

## Panel Registrations

Panel IDs must start with a lowercase letter. After that, they may contain
lowercase letters, numbers, dots, and hyphens. Plugin panels use the
`operator-panel` slot. The first implementation renders default-visible plugin
panels only in unsuppressed grid layout. They do not render in tab layout, full
zoom, or medium and small responsive layouts, and they are not
keyboard-toggleable or focusable.

Panel components receive `TuiPluginContext`:

```ts
interface TuiPluginContext {
  readonly provider: TuiDataProvider;
  readonly topology?: AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
  readonly showMessage: (message: string) => void;
}
```

## Command Palette Actions

Actions appear in the command palette alongside built-ins. Disabled actions stay
visible but cannot execute.

```ts
{
  id: "audit-export",
  label: "Export audit summary",
  detail: "audit",
  enabled: (context) => context.selectedCid !== undefined,
  run: async (context) => {
    context.showMessage(`Exporting ${context.selectedCid}`);
  },
}
```

## Safety Model

Extensions run in the TUI process as trusted local code. Grove validates IDs,
rejects duplicates, and limits the context object, but does not sandbox
extension JavaScript. Do not load untrusted code as a TUI extension.

## Compatibility

Built-in IDs are reserved. Duplicate plugin entries are skipped and reported as
diagnostics. Optional context fields may be added in future versions; existing
context fields should keep their meaning.
