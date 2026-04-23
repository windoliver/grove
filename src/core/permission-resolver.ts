import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface PermissionResolver {
  resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

function selectedOf(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelledOutcome(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function findByKind(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return undefined;
}

export const DENY_ALL_RESOLVER: PermissionResolver = {
  async resolve(req) {
    const reject = findByKind(req.options, ["reject_once", "reject_always"]);
    return reject ? selectedOf(reject.optionId) : cancelledOutcome();
  },
};

export const ALLOW_ALL_RESOLVER: PermissionResolver = {
  async resolve(req) {
    const allow = findByKind(req.options, ["allow_always", "allow_once"]);
    return allow ? selectedOf(allow.optionId) : cancelledOutcome();
  },
};

export class ChainResolver implements PermissionResolver {
  private readonly resolvers: readonly PermissionResolver[];
  constructor(resolvers: readonly PermissionResolver[]) {
    this.resolvers = resolvers;
  }
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    for (const r of this.resolvers) {
      const out = await r.resolve(req);
      if (out.outcome.outcome === "selected") return out;
    }
    return DENY_ALL_RESOLVER.resolve(req);
  }
}

export class AuditingResolver implements PermissionResolver {
  private readonly inner: PermissionResolver;
  private readonly logPath: string;
  constructor(inner: PermissionResolver, logPath: string) {
    this.inner = inner;
    this.logPath = logPath;
    mkdirSync(dirname(logPath), { recursive: true });
  }
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const response = await this.inner.resolve(req);
    const entry = {
      ts: new Date().toISOString(),
      sessionId: req.sessionId,
      toolCall: req.toolCall,
      options: req.options,
      response,
    };
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
    return response;
  }
}
