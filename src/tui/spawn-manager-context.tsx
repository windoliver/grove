/**
 * React Context for distributing a single SpawnManager instance.
 *
 * SpawnManager is a stateful singleton that owns tmux sessions, claims,
 * heartbeat timers, and IPC bridges. It must be created once (in tui-app.tsx
 * after AppProps resolve) and shared across ScreenManager and App via context.
 *
 * Uses the "safe context" pattern: useSpawnManager() throws if called
 * outside a provider, so consumers never see a null value.
 */

import type React from "react";
import { createContext, useContext } from "react";
import type { SpawnManager } from "./spawn-manager.js";

export const SpawnManagerContext: React.Context<SpawnManager | undefined> = createContext<
  SpawnManager | undefined
>(undefined);
SpawnManagerContext.displayName = "SpawnManagerContext";

/**
 * Consume the shared SpawnManager instance.
 * Throws if called outside a SpawnManagerContext provider.
 */
export function useSpawnManager(): SpawnManager {
  const ctx = useContext(SpawnManagerContext);
  if (ctx === undefined) {
    throw new Error("useSpawnManager must be used within a <SpawnManagerContext> provider");
  }
  return ctx;
}
