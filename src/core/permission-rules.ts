import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PermissionResolver } from "./permission-resolver.js";

export interface RulesResolverConfig {
  readonly allowKinds: readonly ToolKind[];
  readonly denyTitleSubstrings: readonly string[];
}

export class RulesResolver implements PermissionResolver {
  private readonly config: RulesResolverConfig;
  constructor(config: RulesResolverConfig) {
    this.config = config;
  }

  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = req.toolCall.title ?? "";
    const reject = req.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
    const allow = req.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");

    if (this.config.denyTitleSubstrings.some((s) => title.includes(s))) {
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    if (req.toolCall.kind && this.config.allowKinds.includes(req.toolCall.kind)) {
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    return { outcome: { outcome: "cancelled" } };
  }
}
