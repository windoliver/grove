/**
 * Reusable Contribution columns for EntityView. Imported by activity,
 * activity-panel, and search-panel to keep column definitions DRY.
 */

import type { ContributionEntity } from "../../../core/entity.js";
import { compareTimestampsDesc, formatTimestamp, truncateCid } from "../../../shared/format.js";
import type { EntityColumn } from "../entity-view.js";

const trunc = (s: string | undefined, max: number): string =>
  !s ? "" : s.length > max ? `${s.slice(0, max - 2)}..` : s;

export const cidColumn = (width = 22): EntityColumn<ContributionEntity> => ({
  header: "CID",
  key: "cid",
  width,
  render: (e) => truncateCid(e.id),
});

export const kindColumn = (width = 14): EntityColumn<ContributionEntity> => ({
  header: "KIND",
  key: "kind",
  width,
  render: (e) => e.spec.contributionKind,
});

export const modeColumn = (width = 12): EntityColumn<ContributionEntity> => ({
  header: "MODE",
  key: "mode",
  width,
  render: (e) => e.spec.mode,
});

export const summaryColumn = (width = 36): EntityColumn<ContributionEntity> => ({
  header: "SUMMARY",
  key: "summary",
  width,
  render: (e) => trunc(e.spec.summary, width),
});

export const agentColumn = (width = 16): EntityColumn<ContributionEntity> => ({
  header: "AGENT",
  key: "agent",
  width,
  render: (e) =>
    e.spec.agent?.role ?? e.spec.agent?.agentName ?? e.spec.agent?.agentId ?? "unknown",
});

export const tagsColumn = (width = 16, max = 3): EntityColumn<ContributionEntity> => ({
  header: "TAGS",
  key: "tags",
  width,
  render: (e) => (e.spec.tags ?? []).slice(0, max).join(", "),
});

export const createdColumn = (
  header = "CREATED",
  width = 12,
): EntityColumn<ContributionEntity> => ({
  header,
  key: "created",
  width,
  render: (e) => formatTimestamp(e.metadata.creationTimestamp ?? ""),
});

/** Sort: newest first by creationTimestamp. */
export const byCreatedDesc = (a: ContributionEntity, b: ContributionEntity): number =>
  compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp);
