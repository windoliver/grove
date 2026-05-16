import type { PermitPlugin, PermitVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export class AutoPermit implements PermitPlugin {
  readonly name = "AutoPermit";

  async permit(_ctx: SchedulerContext, _profile: RuntimeProfile): Promise<PermitVerdict> {
    return { status: "granted" };
  }
}
