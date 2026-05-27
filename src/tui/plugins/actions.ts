import type { TuiActionRegistration, TuiPluginContext } from "./types.js";

export async function runTuiActionRegistration(
  action: TuiActionRegistration,
  context: TuiPluginContext,
): Promise<void> {
  await action.run(context);
}
