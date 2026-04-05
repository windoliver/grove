export const HandoffStatus = {
  PendingPickup: "pending_pickup",
  Delivered: "delivered",
  Replied: "replied",
  Expired: "expired",
} as const;

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus];

export interface Handoff {
  readonly handoffId: string;
  readonly sourceCid: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly status: HandoffStatus;
  readonly requiresReply: boolean;
  readonly replyDueAt?: string | undefined;
  readonly resolvedByCid?: string | undefined;
  readonly createdAt: string;
}

export interface HandoffInput {
  readonly handoffId?: string | undefined;
  readonly sourceCid: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly requiresReply?: boolean | undefined;
  readonly replyDueAt?: string | undefined;
}

export interface HandoffQuery {
  readonly toRole?: string | undefined;
  readonly fromRole?: string | undefined;
  readonly status?: HandoffStatus | readonly HandoffStatus[] | undefined;
  readonly sourceCid?: string | undefined;
  readonly limit?: number | undefined;
}

export interface HandoffStore {
  create(input: HandoffInput): Promise<Handoff>;
  get(id: string): Promise<Handoff | undefined>;
  list(query?: HandoffQuery): Promise<readonly Handoff[]>;
  markDelivered(id: string): Promise<void>;
  markReplied(id: string, resolvedByCid: string): Promise<void>;
  expireStale(now?: string): Promise<readonly Handoff[]>;
  countPending(toRole: string): Promise<number>;
  close(): void;
}
