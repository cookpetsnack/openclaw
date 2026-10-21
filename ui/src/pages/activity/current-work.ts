import { isCronRunSessionKey } from "../../../../src/sessions/session-key-utils.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { compareSessionRowsByUpdatedAt } from "../../lib/sessions/navigation.ts";
import { normalizeAgentId, resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  hasSessionChangedAncestorCoverage,
  prepareSessionChangedEvent,
  type ParsedSessionChangedEvent,
  type PreparedSessionChangedEvent,
  matchesExistingSession,
  reconcileParsedSessionChangedRow,
} from "../../lib/sessions/session-row-reconcile.ts";

export type CurrentWorkChange = ParsedSessionChangedEvent["info"] & {
  snapshot?: PreparedSessionChangedEvent;
  parentKeys: readonly string[];
  ancestorSnapshots?: readonly (ParsedSessionChangedEvent | null)[];
};

export const CURRENT_WORK_CHANGE_LIMIT = 1_000;

export function currentWorkIdentity(session: {
  key: string;
  agentId?: string | null;
  sessionId?: string;
}): string {
  const identity = resolveUiConversationIdentity({}, session.key, session.agentId ?? undefined);
  const agentId = session.agentId ?? identity.agentId;
  // A raw global in one agent and a literal agent:<id>:global are different sessions.
  return JSON.stringify([
    agentId ? normalizeAgentId(agentId) : null,
    identity.sessionKey,
    session.sessionId ?? null,
  ]);
}

export function readCurrentWorkChange(payload: unknown): CurrentWorkChange | null {
  return currentWorkChange(prepareSessionChangedEvent(payload));
}

function currentWorkChange(prepared: PreparedSessionChangedEvent): CurrentWorkChange | null {
  const parsed = prepared.snapshots[0];
  const change = parsed?.info;
  const snapshot =
    Array.isArray(parsed?.event.ancestorSessions) && parsed?.event.session ? prepared : undefined;
  if (
    !change?.sessionId ||
    (!snapshot &&
      change.hasActiveRun === null &&
      change.activeRunIds === undefined &&
      change.status === null &&
      change.reason !== "delete")
  ) {
    return null;
  }
  return {
    ...change,
    parentKeys: [
      parsed?.source.spawnedBy,
      parsed?.source.controlOwnerSessionKey,
      parsed?.source.parentSessionKey,
    ].filter((key): key is string => typeof key === "string" && Boolean(key)),
    ...(snapshot ? { snapshot } : {}),
  };
}

export function readCurrentWorkChanges(payload: unknown): CurrentWorkChange[] {
  const { snapshots } = prepareSessionChangedEvent(payload);
  return snapshots.flatMap((parsed) => {
    if (!parsed) {
      return [];
    }
    const change = currentWorkChange({ event: parsed.event, snapshots: [parsed] });
    if (change?.snapshot) {
      // Flattened ancestors retain the original event's coverage, including grandparents.
      change.ancestorSnapshots = snapshots;
    }
    return change ? [change] : [];
  });
}

export function isOlderCurrentWorkChange(
  change: Pick<CurrentWorkChange, "updatedAt" | "snapshotAt">,
  observed: Pick<GatewaySessionRow, "updatedAt" | "snapshotAt">,
): boolean {
  return (
    (change.updatedAt !== null && (observed.updatedAt ?? 0) > change.updatedAt) ||
    (change.snapshotAt !== undefined && (observed.snapshotAt ?? 0) > change.snapshotAt)
  );
}

export function reconcileCurrentWork(
  result: SessionsListResult,
  changes: Iterable<CurrentWorkChange>,
): {
  result: SessionsListResult;
  requiresRefresh: boolean;
  canPublish: boolean;
} {
  const rows = new Map(
    result.sessions.map((row) => [currentWorkIdentity(row), { row, requiresRefresh: false }]),
  );
  let requiresAncestorRefresh = false;
  let requiresMembershipRefresh = false;
  for (const change of changes) {
    const snapshot = change.snapshot?.snapshots[0];
    const identity = currentWorkIdentity(change);
    const state = rows.get(identity);
    // A stale read can seed a retired child whose lineage still identifies held parents.
    const lineage =
      state?.row ?? result.sessions.find((row) => currentWorkIdentity(row) === identity);
    if (!lineage || !isOlderCurrentWorkChange(change, lineage)) {
      requiresAncestorRefresh ||= !hasSessionChangedAncestorCoverage(
        result.sessions,
        change.key,
        [
          lineage?.spawnedBy,
          lineage?.controlOwnerSessionKey,
          lineage?.parentSessionKey,
          ...change.parentKeys,
        ],
        change.ancestorSnapshots,
      );
    }
    const activeStatus =
      change.status === "running" || change.status === "queued" ? change.status : undefined;
    const active =
      change.hasActiveRun === true || (change.hasActiveRun !== false && activeStatus !== undefined);
    const inactive =
      change.reason === "delete" ||
      (change.hasActiveRun === false &&
        (change.snapshot !== undefined || change.activeRunIds !== undefined || !change.runId));
    const terminal = change.hasActiveRun === false || change.status !== null;
    if (!state) {
      if (
        [...rows.values()].some(({ row }) =>
          matchesExistingSession(row, change.key, change.agentId),
        )
      ) {
        requiresMembershipRefresh = true;
        continue;
      }
      if (change.isAncestorReference) {
        // An unchanged reference for an entirely unheld target changes no query membership.
        continue;
      }
      if (isCronRunSessionKey(change.key) || snapshot?.source.isDock === true) {
        continue;
      }
      if (
        snapshot &&
        change.reason !== "delete" &&
        change.hasActiveRun === true &&
        !result.hasMore &&
        rows.size < (result.limitApplied ?? 100)
      ) {
        const row = reconcileParsedSessionChangedRow(undefined, snapshot, {
          archivedFilter: "all",
          admitSnapshot: true,
        }).admittedRow;
        if (row?.hasActiveRun === true) {
          rows.set(identity, { row, requiresRefresh: false });
          continue;
        }
      }
      requiresMembershipRefresh ||= !inactive && (active || terminal);
      continue;
    }
    const { row } = state;
    if (isOlderCurrentWorkChange(change, row)) {
      continue;
    }
    if (snapshot) {
      const reduced = reconcileParsedSessionChangedRow(row, snapshot, { archivedFilter: "all" });
      if (reduced.admittedRow) {
        state.row = reduced.admittedRow;
        state.requiresRefresh = false;
        if (reduced.admittedRow.hasActiveRun !== true) {
          rows.delete(identity);
        }
      } else if (reduced.deletedKey) {
        rows.delete(identity);
      } else {
        state.requiresRefresh = true;
      }
      continue;
    }
    const next = { ...row, updatedAt: change.updatedAt ?? row.updatedAt };
    if (change.reason === "delete") {
      next.hasActiveRun = false;
      next.activeRunIds = [];
    } else if (active) {
      next.hasActiveRun = true;
      next.status = activeStatus ?? (row.status === "queued" ? "queued" : "running");
      if (change.activeRunIds !== undefined) {
        // Null explicitly retires a previously exact set when only liveness is known.
        next.activeRunIds = change.activeRunIds ?? undefined;
      } else if (change.runId && !row.activeRunIds?.includes(change.runId)) {
        next.activeRunIds = undefined;
      }
    } else {
      if (
        terminal &&
        row.hasActiveRun === true &&
        change.runId &&
        !row.activeRunIds?.includes(change.runId)
      ) {
        // A single old run cannot retire a replacement or an unidentified active run.
        state.requiresRefresh = true;
        continue;
      }
      if (inactive || change.activeRunIds?.length === 0) {
        next.hasActiveRun = false;
        next.activeRunIds = [];
      } else if (terminal) {
        const runIds = change.activeRunIds ?? row.activeRunIds;
        if (!change.runId || !runIds?.includes(change.runId)) {
          state.requiresRefresh = row.hasActiveRun === true;
          continue;
        }
        next.activeRunIds = runIds.filter((id) => id !== change.runId);
        next.hasActiveRun = next.activeRunIds.length > 0;
      } else if (change.activeRunIds !== undefined) {
        next.activeRunIds = change.activeRunIds ?? undefined;
      }
    }
    if (next.hasActiveRun !== true) {
      rows.delete(identity);
      continue;
    }
    state.row = next;
    state.requiresRefresh = false;
  }
  const current = [...rows.values()].filter(({ row }) => row.hasActiveRun === true);
  const sessions = current.map(({ row }) => row).toSorted(compareSessionRowsByUpdatedAt);
  const canPublish = !current.some((state) => state.requiresRefresh);
  const requiresRefresh =
    requiresAncestorRefresh ||
    requiresMembershipRefresh ||
    !canPublish ||
    (result.hasMore === true && sessions.length < result.sessions.length);
  return {
    result: {
      ...result,
      count: sessions.length,
      ...(!result.hasMore ? { totalCount: sessions.length } : {}),
      sessions,
    },
    requiresRefresh,
    canPublish,
  };
}
