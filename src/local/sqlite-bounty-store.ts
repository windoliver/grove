/**
 * SQLite-backed bounty store.
 *
 * Uses the shared Database instance from initSqliteDb().
 * Bounty and reward tables are created in the v6 migration.
 */

import type { Database, Statement } from "bun:sqlite";

import type { Bounty, RewardRecord } from "../core/bounty.js";
import { BountyStatus } from "../core/bounty.js";
import { BountyStateError } from "../core/bounty-errors.js";
import { validateBountyTransition } from "../core/bounty-logic.js";
import type { BountyQuery, BountyStore, RewardQuery } from "../core/bounty-store.js";
import { computeBountyStorageContentHash } from "../core/content-dedup.js";
import { StateConflictError } from "../core/errors.js";
import type { AgentIdentity, JsonValue } from "../core/models.js";

/** UTC ISO 8601 timestamp for "now". */
function nowUtcIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Schema DDL (created in migration v6)
// ---------------------------------------------------------------------------

export const BOUNTY_DDL = `
  CREATE TABLE IF NOT EXISTS bounties (
    bounty_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    creator_agent_id TEXT NOT NULL,
    creator_json TEXT NOT NULL,
    amount INTEGER NOT NULL,
    criteria_json TEXT NOT NULL,
    zone_id TEXT,
    deadline TEXT NOT NULL,
    claimed_by_json TEXT,
    claim_id TEXT,
    fulfilled_by_cid TEXT,
    reservation_id TEXT,
    context_json TEXT,
    content_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
  CREATE INDEX IF NOT EXISTS idx_bounties_creator ON bounties(creator_agent_id);
  CREATE INDEX IF NOT EXISTS idx_bounties_deadline ON bounties(deadline);
  CREATE INDEX IF NOT EXISTS idx_bounties_zone ON bounties(zone_id);

  CREATE TABLE IF NOT EXISTS rewards (
    reward_id TEXT PRIMARY KEY,
    reward_type TEXT NOT NULL,
    recipient_agent_id TEXT NOT NULL,
    recipient_json TEXT NOT NULL,
    amount INTEGER NOT NULL,
    contribution_cid TEXT NOT NULL,
    bounty_id TEXT,
    transfer_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rewards_type ON rewards(reward_type);
  CREATE INDEX IF NOT EXISTS idx_rewards_recipient ON rewards(recipient_agent_id);
  CREATE INDEX IF NOT EXISTS idx_rewards_bounty ON rewards(bounty_id);
  CREATE INDEX IF NOT EXISTS idx_rewards_contribution ON rewards(contribution_cid);
`;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface BountyRow {
  bounty_id: string;
  title: string;
  description: string;
  status: string;
  creator_agent_id: string;
  creator_json: string;
  amount: number;
  criteria_json: string;
  zone_id: string | null;
  deadline: string;
  claimed_by_json: string | null;
  claim_id: string | null;
  fulfilled_by_cid: string | null;
  reservation_id: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

interface RewardRow {
  reward_id: string;
  reward_type: string;
  recipient_agent_id: string;
  recipient_json: string;
  amount: number;
  contribution_cid: string;
  bounty_id: string | null;
  transfer_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToBounty(row: BountyRow): Bounty {
  const creator = JSON.parse(row.creator_json) as AgentIdentity;
  const criteria = JSON.parse(row.criteria_json) as Bounty["criteria"];
  const claimedBy =
    row.claimed_by_json !== null ? (JSON.parse(row.claimed_by_json) as AgentIdentity) : undefined;
  const context =
    row.context_json !== null
      ? (JSON.parse(row.context_json) as Record<string, JsonValue>)
      : undefined;

  return {
    bountyId: row.bounty_id,
    title: row.title,
    description: row.description,
    status: row.status as Bounty["status"],
    creator,
    amount: row.amount,
    criteria,
    zoneId: row.zone_id ?? undefined,
    deadline: row.deadline,
    claimedBy,
    claimId: row.claim_id ?? undefined,
    fulfilledByCid: row.fulfilled_by_cid ?? undefined,
    reservationId: row.reservation_id ?? undefined,
    context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReward(row: RewardRow): RewardRecord {
  const recipient = JSON.parse(row.recipient_json) as AgentIdentity;
  return {
    rewardId: row.reward_id,
    rewardType: row.reward_type as RewardRecord["rewardType"],
    recipient,
    amount: row.amount,
    contributionCid: row.contribution_cid,
    bountyId: row.bounty_id ?? undefined,
    transferId: row.transfer_id ?? undefined,
    createdAt: row.created_at,
  };
}

export function migrateBountyContentHash(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(bounties)").all() as readonly { name: string }[];
  if (cols.length === 0) return;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("content_hash")) {
    db.run("ALTER TABLE bounties ADD COLUMN content_hash TEXT");
  }

  const rows = db
    .prepare("SELECT * FROM bounties WHERE content_hash IS NULL OR content_hash = ''")
    .all() as BountyRow[];
  const updateHash = db.prepare("UPDATE bounties SET content_hash = ? WHERE bounty_id = ?");
  for (const row of rows) {
    const bounty = rowToBounty(row);
    updateHash.run(computeBountyStorageContentHash(bounty), bounty.bountyId);
  }

  const duplicateRows = db
    .prepare(
      `
      WITH ranked AS (
        SELECT bounty_id,
               ROW_NUMBER() OVER (
                 PARTITION BY content_hash
                 ORDER BY created_at ASC, rowid ASC
               ) AS rn
        FROM bounties
        WHERE content_hash IS NOT NULL AND content_hash <> ''
      )
      SELECT bounty_id FROM ranked WHERE rn > 1
    `,
    )
    .all() as readonly { bounty_id: string }[];
  for (const row of duplicateRows) {
    db.run("DELETE FROM bounties WHERE bounty_id = ?", [row.bounty_id]);
  }

  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_bounties_content_hash ON bounties(content_hash)");
}

// ---------------------------------------------------------------------------
// SqliteBountyStore
// ---------------------------------------------------------------------------

export class SqliteBountyStore implements BountyStore {
  readonly storeIdentity: string | undefined;
  private readonly db: Database;

  // Prepared statements (lazy init)
  private stmtInsertBounty: Statement | undefined;
  private stmtGetBounty: Statement | undefined;
  private stmtInsertReward: Statement | undefined;
  private stmtGetReward: Statement | undefined;

  constructor(db: Database) {
    this.db = db;
    this.storeIdentity = (db as { filename?: string }).filename;
    migrateBountyContentHash(db);
  }

  // -----------------------------------------------------------------------
  // Bounty CRUD
  // -----------------------------------------------------------------------

  createBounty = async (bounty: Bounty): Promise<Bounty> => {
    this.stmtInsertBounty ??= this.db.prepare(`
      INSERT OR IGNORE INTO bounties (
        bounty_id, title, description, status, creator_agent_id, creator_json,
        amount, criteria_json, zone_id, deadline, claimed_by_json, claim_id,
        fulfilled_by_cid, reservation_id, context_json, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const contentHash = computeBountyStorageContentHash(bounty);
    try {
      const result = this.stmtInsertBounty.run(
        bounty.bountyId,
        bounty.title,
        bounty.description,
        bounty.status,
        bounty.creator.agentId,
        JSON.stringify(bounty.creator),
        bounty.amount,
        JSON.stringify(bounty.criteria),
        bounty.zoneId ?? null,
        bounty.deadline,
        bounty.claimedBy !== undefined ? JSON.stringify(bounty.claimedBy) : null,
        bounty.claimId ?? null,
        bounty.fulfilledByCid ?? null,
        bounty.reservationId ?? null,
        bounty.context !== undefined ? JSON.stringify(bounty.context) : null,
        contentHash,
        bounty.createdAt,
        bounty.updatedAt,
      );
      if (result.changes === 0) {
        const idConflict = this.db
          .prepare("SELECT bounty_id FROM bounties WHERE bounty_id = ?")
          .get(bounty.bountyId) as { bounty_id: string } | null;
        if (idConflict !== null) {
          throw new StateConflictError({
            resource: "Bounty",
            reason: "already exists",
            message: `Bounty '${bounty.bountyId}' already exists`,
          });
        }
        const duplicate = this.db
          .prepare("SELECT * FROM bounties WHERE content_hash = ?")
          .get(contentHash) as BountyRow | null;
        if (duplicate !== null) {
          return { ...rowToBounty(duplicate), isNew: false } as Bounty & { readonly isNew: false };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        throw new StateConflictError({
          resource: "Bounty",
          reason: "already exists",
          message: `Bounty '${bounty.bountyId}' already exists`,
        });
      }
      throw err;
    }

    return { ...bounty, isNew: true } as Bounty & { readonly isNew: true };
  };

  getBounty = async (bountyId: string): Promise<Bounty | undefined> => {
    this.stmtGetBounty ??= this.db.prepare("SELECT * FROM bounties WHERE bounty_id = ?");
    const row = this.stmtGetBounty.get(bountyId) as BountyRow | null;
    return row !== null ? rowToBounty(row) : undefined;
  };

  listBounties = async (query?: BountyQuery): Promise<readonly Bounty[]> => {
    const { sql, params } = this.buildBountyQuery(query, "SELECT *");
    const rows = this.db.prepare(sql).all(...params) as BountyRow[];
    return rows.map(rowToBounty);
  };

  countBounties = async (query?: BountyQuery): Promise<number> => {
    const { sql, params } = this.buildBountyQuery(query, "SELECT COUNT(*) as cnt");
    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  };

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  fundBounty = async (bountyId: string, reservationId: string): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Open, "fund", (bounty) => ({
      ...bounty,
      status: BountyStatus.Open,
      reservationId,
      updatedAt: nowUtcIso(),
    }));
  };

  claimBounty = async (
    bountyId: string,
    claimedBy: AgentIdentity,
    claimId: string,
  ): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Claimed, "claim", (bounty) => ({
      ...bounty,
      status: BountyStatus.Claimed,
      claimedBy,
      claimId,
      updatedAt: nowUtcIso(),
    }));
  };

  beginSettlement = async (bountyId: string, fulfilledByCid: string): Promise<Bounty> => {
    return this.transitionBounty(
      bountyId,
      BountyStatus.PendingSettlement,
      "beginSettlement",
      (bounty) => ({
        ...bounty,
        status: BountyStatus.PendingSettlement,
        fulfilledByCid,
        updatedAt: nowUtcIso(),
      }),
    );
  };

  completeBounty = async (bountyId: string, fulfilledByCid: string): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Completed, "complete", (bounty) => ({
      ...bounty,
      status: BountyStatus.Completed,
      fulfilledByCid,
      updatedAt: nowUtcIso(),
    }));
  };

  settleBounty = async (bountyId: string): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Settled, "settle", (bounty) => ({
      ...bounty,
      status: BountyStatus.Settled,
      updatedAt: nowUtcIso(),
    }));
  };

  expireBounty = async (bountyId: string): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Expired, "expire", (bounty) => ({
      ...bounty,
      status: BountyStatus.Expired,
      updatedAt: nowUtcIso(),
    }));
  };

  cancelBounty = async (bountyId: string): Promise<Bounty> => {
    return this.transitionBounty(bountyId, BountyStatus.Cancelled, "cancel", (bounty) => ({
      ...bounty,
      status: BountyStatus.Cancelled,
      updatedAt: nowUtcIso(),
    }));
  };

  // -----------------------------------------------------------------------
  // Expiry sweep
  // -----------------------------------------------------------------------

  findExpiredBounties = async (): Promise<readonly Bounty[]> => {
    const now = nowUtcIso();
    const rows = this.db
      .prepare(
        `SELECT * FROM bounties
         WHERE deadline < ?
           AND status IN ('open', 'claimed', 'pending_settlement')
         ORDER BY deadline ASC`,
      )
      .all(now) as BountyRow[];
    return rows.map(rowToBounty);
  };

  // -----------------------------------------------------------------------
  // Reward records
  // -----------------------------------------------------------------------

  recordReward = async (reward: RewardRecord): Promise<void> => {
    this.stmtInsertReward ??= this.db.prepare(`
      INSERT OR IGNORE INTO rewards (
        reward_id, reward_type, recipient_agent_id, recipient_json,
        amount, contribution_cid, bounty_id, transfer_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtInsertReward.run(
      reward.rewardId,
      reward.rewardType,
      reward.recipient.agentId,
      JSON.stringify(reward.recipient),
      reward.amount,
      reward.contributionCid,
      reward.bountyId ?? null,
      reward.transferId ?? null,
      reward.createdAt,
    );
  };

  hasReward = async (rewardId: string): Promise<boolean> => {
    this.stmtGetReward ??= this.db.prepare("SELECT 1 FROM rewards WHERE reward_id = ?");
    return this.stmtGetReward.get(rewardId) !== null;
  };

  listRewards = async (query?: RewardQuery): Promise<readonly RewardRecord[]> => {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query?.rewardType !== undefined) {
      conditions.push("reward_type = ?");
      params.push(query.rewardType);
    }
    if (query?.recipientAgentId !== undefined) {
      conditions.push("recipient_agent_id = ?");
      params.push(query.recipientAgentId);
    }
    if (query?.bountyId !== undefined) {
      conditions.push("bounty_id = ?");
      params.push(query.bountyId);
    }
    if (query?.contributionCid !== undefined) {
      conditions.push("contribution_cid = ?");
      params.push(query.contributionCid);
    }

    let sql = "SELECT * FROM rewards";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY created_at DESC";
    if (query?.limit !== undefined) {
      sql += ` LIMIT ${query.limit}`;
    }

    const rows = this.db.prepare(sql).all(...params) as RewardRow[];
    return rows.map(rowToReward);
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  close = (): void => {
    // Don't close the shared db — let the caller handle that
  };

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async transitionBounty(
    bountyId: string,
    targetStatus: Bounty["status"],
    action: string,
    transform: (bounty: Bounty) => Bounty,
  ): Promise<Bounty> {
    const existing = await this.getBounty(bountyId);
    if (existing === undefined) {
      throw new BountyStateError({
        bountyId,
        currentStatus: "not_found",
        attemptedAction: action,
        message: `Bounty '${bountyId}' not found`,
      });
    }

    validateBountyTransition(bountyId, existing.status, targetStatus, action);

    const updated = transform(existing);

    // CAS: include WHERE status = ? to prevent concurrent transitions.
    // If another writer already changed the status, changes === 0.
    const result = this.db
      .prepare(`
      UPDATE bounties SET
        status = ?,
        claimed_by_json = ?,
        claim_id = ?,
        fulfilled_by_cid = ?,
        reservation_id = ?,
        updated_at = ?
      WHERE bounty_id = ? AND status = ?
    `)
      .run(
        updated.status,
        updated.claimedBy !== undefined ? JSON.stringify(updated.claimedBy) : null,
        updated.claimId ?? null,
        updated.fulfilledByCid ?? null,
        updated.reservationId ?? null,
        updated.updatedAt,
        bountyId,
        existing.status,
      );

    if (result.changes === 0) {
      throw new BountyStateError({
        bountyId,
        currentStatus: existing.status,
        attemptedAction: action,
        message: `Concurrent modification: bounty '${bountyId}' status changed since read`,
      });
    }

    return updated;
  }

  private buildBountyQuery(
    query: BountyQuery | undefined,
    selectClause: string,
  ): { sql: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query?.status !== undefined) {
      if (Array.isArray(query.status)) {
        const placeholders = query.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        params.push(...query.status);
      } else {
        conditions.push("status = ?");
        params.push(query.status as string);
      }
    }
    if (query?.creatorAgentId !== undefined) {
      conditions.push("creator_agent_id = ?");
      params.push(query.creatorAgentId);
    }
    if (query?.claimedByAgentId !== undefined) {
      conditions.push(
        "claimed_by_json IS NOT NULL AND json_extract(claimed_by_json, '$.agentId') = ?",
      );
      params.push(query.claimedByAgentId);
    }
    if (query?.zoneId !== undefined) {
      conditions.push("zone_id = ?");
      params.push(query.zoneId);
    }

    let sql = `${selectClause} FROM bounties`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    if (selectClause.includes("COUNT")) {
      return { sql, params };
    }

    sql += " ORDER BY created_at DESC";
    if (query?.limit !== undefined) {
      sql += ` LIMIT ${query.limit}`;
    } else if (query?.offset !== undefined) {
      // SQLite requires LIMIT before OFFSET; use -1 for unlimited
      sql += " LIMIT -1";
    }
    if (query?.offset !== undefined) {
      sql += ` OFFSET ${query.offset}`;
    }

    return { sql, params };
  }
}
