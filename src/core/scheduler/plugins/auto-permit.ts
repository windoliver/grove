import type { PermitPlugin, PermitVerdict } from "../framework.js";

export class AutoPermit implements PermitPlugin {
  readonly name = "AutoPermit";

  async permit(): Promise<PermitVerdict> {
    return { status: "granted" };
  }
}
