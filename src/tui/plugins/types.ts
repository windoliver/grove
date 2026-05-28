import type React from "react";
import type { AgentTopology } from "../../core/topology.js";
import type { TuiDataProvider } from "../provider.js";

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

export interface TuiPluginContext {
  readonly provider: TuiDataProvider;
  readonly topology?: AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
  readonly showMessage: (message: string) => void;
}

export interface TuiPanelRegistration {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly defaultVisible?: boolean | undefined;
  readonly order?: number | undefined;
  readonly component: React.ComponentType<TuiPluginContext>;
}

export interface TuiActionRegistration {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly order?: number | undefined;
  readonly enabled?: ((context: TuiPluginContext) => boolean) | undefined;
  readonly run: (context: TuiPluginContext) => void | Promise<void>;
}

export interface TuiExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly panels?: readonly TuiPanelRegistration[] | undefined;
  readonly actions?: readonly TuiActionRegistration[] | undefined;
}
