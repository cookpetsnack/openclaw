import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { compareSessionRowsByUpdatedAt, sessionMatchesArchivedFilter } from "./navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
  type UiSessionDefaultsHost,
} from "./session-key.ts";
import {
  isPersistedSessionRow,
  isSessionRowOutsideResultScope,
  matchesExistingSession,
  preserveRosterPresentationMetadata,
  reconcileParsedSessionChangedRow,
  reconcileSessionRow,
  type SessionChangedEventInfo,
  type SessionChangedRowProjection,
  type SessionChangedRowResult,
  type SessionReconcileOptions,
  type SessionRowObservation,
  type PreparedSessionChangedEvent,
} from "./session-row-reconcile.ts";
import { preserveOmittedThinkingMetadata } from "./session-thinking-metadata.ts";

export {
  preserveRosterPresentationMetadata,
  readSessionChangedEvent,
  reconcileSessionRow,
} from "./session-row-reconcile.ts";
export type { SessionReconcileOptions, SessionRowObservation } from "./session-row-reconcile.ts";

export type SessionChangedResult = Omit<
  SessionChangedRowResult,
  "reconciled" | "eventTs" | "ownershipChanged" | "disposition"
> & { result: SessionsListResult | null; admittedRows?: GatewaySessionRow[] };

/** Retain result identity when a membership-preserving projection leaves every row unchanged. */
export function projectSessionResultRows(
  result: SessionsListResult | null,
  sessions: GatewaySessionRow[],
): SessionsListResult | null {
  return result && sessions.some((row, index) => row !== result.sessions[index])
    ? { ...result, sessions }
    : result;
}

export function mapSessionResultRows(
  result: SessionsListResult | null,
  project: (row: GatewaySessionRow) => GatewaySessionRow,
): SessionsListResult | null {
  return result && projectSessionResultRows(result, result.sessions.map(project));
}

function replaceSessionResultRow(
  result: SessionsListResult,
  key: string,
  row: GatewaySessionRow | undefined,
): SessionsListResult {
  const sessions = result.sessions.filter((candidate) => candidate.key !== key);
  if (row) {
    sessions.push(row);
    sessions.sort(compareSessionRowsByUpdatedAt);
  }
  return { ...result, count: sessions.length, sessions };
}

/** Merge canonical and filtered pages with the same cursor/deduplication contract. */
export function appendSessionResults(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const seen = new Set<string>();
  const sessions = [...previous.sessions, ...page.sessions].filter((row) => {
    if (!row.key || seen.has(row.key)) {
      return false;
    }
    seen.add(row.key);
    return true;
  });
  const totalCount = page.totalCount ?? previous.totalCount;
  const hasMore = page.hasMore ?? (totalCount !== undefined && sessions.length < totalCount);
  return {
    ...page,
    count: sessions.length,
    totalCount,
    hasMore,
    nextOffset: page.nextOffset ?? (hasMore ? sessions.length : null),
    sessions,
  };
}

export function reconcileRosterPresentationMetadata(
  incoming: SessionsListResult | null,
  existing: SessionsListResult | null,
): SessionsListResult | null {
  if (!incoming || !existing) {
    return incoming;
  }
  const existingByKey = new Map(existing.sessions.map((session) => [session.key, session]));
  return mapSessionResultRows(incoming, (session) =>
    preserveRosterPresentationMetadata(session, existingByKey.get(session.key)),
  );
}

export function preserveCurrentSessionRow(
  result: SessionsListResult,
  state: { result: Pick<SessionsListResult, "sessions"> | null; agentId: string | null },
  snapshot: UiSessionDefaultsHost & { sessionKey?: string },
  backgroundHydrate: boolean,
): SessionsListResult {
  const currentKey = snapshot.sessionKey?.trim();
  if (!currentKey) {
    return result;
  }
  const parsedAgentId = parseAgentSessionKey(currentKey)?.agentId;
  const currentAgentId = normalizeAgentId(
    parsedAgentId ?? resolveUiSelectedGlobalAgentId(snapshot),
  );
  if (!parsedAgentId && normalizeAgentId(state.agentId ?? "") !== currentAgentId) {
    return result;
  }
  const matchesCurrent = (row: GatewaySessionRow) =>
    uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey, row.agentId);
  const previousCurrentRow = state.result?.sessions.find(matchesCurrent);
  if (
    previousCurrentRow &&
    (backgroundHydrate || previousCurrentRow.archived === true) &&
    !result.sessions.some(matchesCurrent)
  ) {
    const sessions = [...result.sessions, previousCurrentRow];
    return { ...result, count: sessions.length, sessions };
  }
  return result;
}

export function reconcileSessionChanged(
  result: SessionsListResult | null,
  prepared: PreparedSessionChangedEvent,
  options: SessionReconcileOptions = {},
  project?: SessionChangedRowProjection,
  accepts: (info: SessionChangedEventInfo) => boolean = () => true,
  compare = compareSessionRowsByUpdatedAt,
): SessionChangedResult {
  let sessions = result?.sessions;
  let ts = result?.ts ?? 0;
  let owners = result?.owners;
  let orderChanged = false;
  let primary: Omit<SessionChangedResult, "result"> | undefined;
  const admittedRows: GatewaySessionRow[] = [];
  for (const parsed of prepared.snapshots) {
    if (!parsed) {
      primary ??= { applied: false };
      continue;
    }
    const { info } = parsed;
    const existing = sessions?.find((candidate) =>
      matchesExistingSession(
        candidate,
        info.key,
        info.agentId ?? options.selectedGlobalAgentId ?? null,
      ),
    );
    if (
      !accepts(info) ||
      (parsed !== prepared.snapshots[0] && existing && existing.sessionId !== info.sessionId)
    ) {
      continue;
    }
    const { row, admittedRow, reconciled, eventTs, ownershipChanged, disposition, ...eventResult } =
      reconcileParsedSessionChangedRow(existing, parsed, options, project);
    const { deletedKey } = eventResult;
    if (disposition === "outside-scope") {
      primary ??= { ...eventResult, row: existing };
      continue;
    }
    if (deletedKey) {
      primary ??= eventResult;
    } else if (!reconciled) {
      primary ??= !result && eventResult.applied ? { applied: false } : eventResult;
      continue;
    } else {
      if (!result || !existing) {
        primary ??= { applied: false };
        continue;
      }
      primary ??= { ...eventResult, row, admittedRow };
      if (admittedRow) {
        admittedRows.push(admittedRow);
      }
      if (eventTs !== undefined) {
        ts = Math.max(ts, eventTs);
      }
      if (ownershipChanged) {
        owners = undefined;
      }
    }
    if (sessions && existing && (deletedKey || row !== existing)) {
      // One event owns one working array; ancestor rows never publish intermediate sorts.
      if (sessions === result?.sessions) {
        sessions = sessions.slice();
      }
      const index = sessions.indexOf(existing);
      if (row && !deletedKey) {
        sessions[index] = row;
        orderChanged = true;
      } else {
        sessions.splice(index, 1);
      }
    }
  }
  // Authoritative owner-first windows need not arrive in global recency order.
  if (orderChanged) {
    sessions?.sort(compare);
  }
  const nextResult =
    result && (sessions !== result.sessions || ts !== result.ts || owners !== result.owners)
      ? { ...result, sessions: sessions!, count: sessions!.length, ts, owners }
      : result;
  return {
    ...(primary ?? { applied: false }),
    ...(admittedRows.length ? { applied: true, admittedRows } : {}),
    result: nextResult,
  };
}

export function reconcileSessionHistory(
  result: SessionsListResult | null,
  row: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  options: SessionReconcileOptions = {},
  preserveMatchingExistingRow = false,
  observation?: SessionRowObservation,
): SessionsListResult | null {
  if (!row?.key || isSessionRowOutsideResultScope(row, options)) {
    return result;
  }
  if (!result) {
    if (!isPersistedSessionRow(row) && !defaults) {
      return null;
    }
    // An excluded first row never enters a list or its observation callbacks.
    const reduced =
      isPersistedSessionRow(row) &&
      sessionMatchesArchivedFilter(row, options.archivedFilter ?? "active")
        ? reconcileSessionRow(row, undefined, { ...options, archivedFilter: "all" }, observation)
        : undefined;
    const sessions = reduced?.row ? [reduced.row] : [];
    return {
      ts: Date.now(),
      path: "",
      count: sessions.length,
      defaults: defaults ?? { modelProvider: null, model: null, contextTokens: null },
      sessions,
    };
  }
  const matching = result.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      row.key,
      row.agentId ?? options.selectedGlobalAgentId ?? null,
    ),
  );
  const nextDefaults = defaults
    ? preserveOmittedThinkingMetadata(defaults, result.defaults)
    : result.defaults;
  const resultWithDefaults =
    nextDefaults === result.defaults ? result : { ...result, defaults: nextDefaults };
  const reduced = reconcileSessionRow(
    row,
    matching,
    { ...options, preserveExisting: preserveMatchingExistingRow },
    observation,
  );
  if (
    reduced.disposition === "older" ||
    reduced.disposition === "outside-scope" ||
    reduced.disposition === "invalid"
  ) {
    return result;
  }
  if (reduced.disposition !== "accepted") {
    return resultWithDefaults;
  }
  return replaceSessionResultRow(resultWithDefaults, matching?.key ?? row.key, reduced.row);
}
