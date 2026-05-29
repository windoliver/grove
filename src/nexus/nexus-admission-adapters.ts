import { z } from "zod";

import type {
  AdmissionGovernanceCheck,
  AdmissionGovernanceDecision,
  AdmissionGovernanceEvaluator,
  AdmissionPermissionCheck,
  AdmissionPermissionDecision,
  AdmissionPermissionResolver,
} from "../core/admission/types.js";
import { NexusRpcClient, type NexusRpcClientConfig } from "./nexus-rpc-client.js";

export interface NexusAdmissionAdapters {
  readonly admissionPermissionResolver: AdmissionPermissionResolver;
  readonly admissionGovernanceEvaluator: AdmissionGovernanceEvaluator;
}

export function createNexusAdmissionAdapters(config: NexusRpcClientConfig): NexusAdmissionAdapters {
  const rpcClient = new NexusRpcClient(config);
  return {
    admissionPermissionResolver: new NexusAdmissionPermissionResolver(rpcClient),
    admissionGovernanceEvaluator: new NexusAdmissionGovernanceEvaluator(rpcClient),
  };
}

const GovernanceStatusSchema = z
  .object({
    recent_alerts: z.object({
      alerts: z.array(z.unknown()),
      count: z.number(),
    }),
    fraud_rings: z.object({
      rings: z.array(z.unknown()),
      count: z.number(),
    }),
  })
  .passthrough();

export class NexusAdmissionPermissionResolver implements AdmissionPermissionResolver {
  private readonly client: NexusRpcClient;

  constructor(client: NexusRpcClient) {
    this.client = client;
  }

  async check(input: AdmissionPermissionCheck): Promise<AdmissionPermissionDecision> {
    const allowed = await this.client.call(
      "rebac_check",
      {
        subject: [input.subjectType, input.subjectId],
        permission: input.permission,
        object: [input.objectType, input.objectId],
        zone_id: input.zoneId,
      },
      z.boolean(),
    );

    if (!allowed) {
      return {
        allowed: false,
        reason: "Nexus ReBAC denied permission",
        evidence: { backend: "nexus", method: "rebac_check" },
      };
    }
    return {
      allowed: true,
      evidence: { backend: "nexus", method: "rebac_check" },
    };
  }
}

export class NexusAdmissionGovernanceEvaluator implements AdmissionGovernanceEvaluator {
  private readonly client: NexusRpcClient;

  constructor(client: NexusRpcClient) {
    this.client = client;
  }

  async evaluate(input: AdmissionGovernanceCheck): Promise<AdmissionGovernanceDecision> {
    if (input.policy !== "governance_status_clean") {
      return {
        allowed: false,
        reason: `Nexus governance policy '${input.policy}' is not supported by the current RPC surface`,
        evidence: { backend: "nexus", method: "governance_status" },
      };
    }

    const status = await this.client.call("governance_status", {}, GovernanceStatusSchema);
    const alertCount = status.recent_alerts.count;
    const ringCount = status.fraud_rings.count;
    const allowed = alertCount === 0 && ringCount === 0;
    return {
      allowed,
      ...(allowed ? {} : { reason: "Nexus governance status is not clean" }),
      evidence: {
        backend: "nexus",
        method: "governance_status",
        alert_count: alertCount,
        ring_count: ringCount,
      },
    };
  }
}
