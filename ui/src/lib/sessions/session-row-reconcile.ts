import {
  asNullableRecord as recordOrNull,
  isStringArray,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { isSessionRunStateActive } from "../session-run-state.ts";
import { sessionMatchesArchivedFilter, type SessionArchivedFilter } from "./navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";
import { isShallowEqualSessionRow } from "./session-row-equality.ts";
import {
  preserveOmittedThinkingMetadata,
  stripThinkingMetadata,
  thinkingMetadataFields,
  thinkingMetadataIdentityMatches,
  type ThinkingMetadataCarrier,
} from "./session-thinking-metadata.ts";

export type SessionReconcileOptions = {
  resultAgentId?: string | null;
  selectedGlobalAgentId?: string | null;
  archivedFilter?: SessionArchivedFilter;
};

export type SessionChangedRowProjection = (
  row: GatewaySessionRow,
  previous: GatewaySessionRow,
  fields: readonly string[],
  info: SessionChangedEventInfo,
) => GatewaySessionRow;

export type SessionChangedRowResult = {
  applied: boolean;
  key?: string;
  row?: GatewaySessionRow;
  /** Accepted event facts remain available when a list filter removes the row. */
  admittedRow?: GatewaySessionRow;
  deletedKey?: string;
  /** A held row reached snapshot reduction; list adapters still own publication. */
  reconciled?: true;
  eventTs?: number;
  ownershipChanged?: boolean;
  disposition?: SessionRowReconcileResult["disposition"];
};

export type SessionChangedEventInfo = {
  key: string;
  reason: string | null;
  sessionId?: string;
  updatedAt: number | null;
  snapshotAt?: number;
  hasPermissionMode: boolean;
  hasActivitySummary: boolean;
  thinkingLevel?: string | null;
  agentId: string | null;
  runId: string | null;
  clientRunId: string | null;
  hasActiveRun: boolean | null;
  activeRunIds?: string[] | null;
  status: SessionRunStatus | null;
  archived: boolean | null;
  isAncestorReference: boolean;
};

export function sanitizeSessionRow(row: GatewaySessionRow): GatewaySessionRow {
  let next = row;
  for (const [key, value] of Object.entries(row)) {
    if (
      value === undefined ||
      (key === "totalTokensFresh" && value === false && row.totalTokens === undefined)
    ) {
      if (next === row) {
        next = { ...row };
      }
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
}

export function isPersistedSessionRow(row: GatewaySessionRow): boolean {
  return Boolean(row.sessionId?.trim() || row.updatedAt != null);
}

export function preserveRosterPresentationMetadata(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): GatewaySessionRow {
  if (
    !existing ||
    !incoming.sessionId ||
    incoming.sessionId !== existing.sessionId ||
    (incoming.derivedTitle !== undefined &&
      incoming.lastMessagePreview !== undefined &&
      incoming.lastAssistantMessage !== undefined)
  ) {
    return incoming;
  }
  const incomingAgentId = sessionAgentId(incoming, null);
  const existingAgentId = sessionAgentId(existing, null);
  if (incomingAgentId && existingAgentId && incomingAgentId !== existingAgentId) {
    return incoming;
  }
  let row = incoming;
  for (const field of ["derivedTitle", "lastMessagePreview", "lastAssistantMessage"] as const) {
    if (incoming[field] === undefined && existing[field] !== undefined) {
      if (row === incoming) {
        row = { ...incoming };
      }
      Object.assign(row, { [field]: existing[field] });
    }
  }
  return row;
}

function isStaleForActiveSession(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow | undefined,
): boolean {
  if (!existing || !isSessionRunStateActive(existing) || isSessionRunStateActive(incoming)) {
    return false;
  }
  if (
    incoming.snapshotAt !== undefined &&
    existing.snapshotAt !== undefined &&
    incoming.snapshotAt > existing.snapshotAt
  ) {
    // Runtime settlement need not write persisted metadata; its newer Gateway
    // sample still owns liveness. Field receipts fence late cached snapshots.
    return false;
  }
  const incomingUpdatedAt = incoming.updatedAt ?? 0;
  return (
    (existing.updatedAt ?? 0) >= incomingUpdatedAt ||
    (typeof existing.startedAt === "number" && existing.startedAt >= incomingUpdatedAt)
  );
}

export function matchesExistingSession(
  existing: GatewaySessionRow,
  incomingKey: string,
  selectedGlobalAgentId: string | null,
): boolean {
  const existingAgentId = sessionAgentId(existing, null);
  const incomingAgentId = parseAgentSessionKey(incomingKey)?.agentId ?? selectedGlobalAgentId;
  if (
    existingAgentId &&
    incomingAgentId?.trim() &&
    existingAgentId !== normalizeAgentId(incomingAgentId)
  ) {
    return false;
  }
  if (areUiSessionKeysEquivalent(existing.key, incomingKey)) {
    return true;
  }
  if (!isUiGlobalSessionKey(incomingKey) || existing.kind !== "global") {
    return false;
  }
  const parsed = parseAgentSessionKey(existing.key);
  return (
    parsed?.agentId !== undefined &&
    normalizeAgentId(parsed.agentId) === normalizeAgentId(selectedGlobalAgentId ?? "")
  );
}

function sessionAgentId(
  row: GatewaySessionRow,
  selectedGlobalAgentId: string | null,
): string | null {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  if (row.agentId?.trim()) {
    return normalizeAgentId(row.agentId);
  }
  if (row.kind === "global" && selectedGlobalAgentId?.trim()) {
    return normalizeAgentId(selectedGlobalAgentId);
  }
  return null;
}

function sessionRunStatus(value: unknown): SessionRunStatus | null {
  return value === "running" ||
    value === "queued" ||
    value === "done" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export type ParsedSessionChangedEvent = Readonly<{
  info: SessionChangedEventInfo;
  event: Readonly<Record<string, unknown>>;
  source: Readonly<Record<string, unknown>>;
}>;

export type PreparedSessionChangedRow = ParsedSessionChangedEvent &
  Readonly<{
    rowFields: Readonly<Record<string, unknown>>;
    fields: readonly string[];
    clearedFields: readonly string[];
    thinkingIdentity: ThinkingMetadataCarrier;
  }>;

export type PreparedSessionChangedEvent = Readonly<{
  event: Readonly<Record<string, unknown>> | null;
  snapshots: readonly (PreparedSessionChangedRow | null)[];
}>;

// Receipt admission is synchronous: the next event may already reference this row.
// Copies and local edits cannot certify references by copying a wire revision.
const ancestorRevisions = new WeakMap<GatewaySessionRow, string>();

function rememberAncestor(row: GatewaySessionRow, offered: GatewaySessionRow, revision: string) {
  if (isShallowEqualSessionRow(row, offered)) {
    ancestorRevisions.set(row, revision);
  }
}

function reconcileAncestorReference(
  existing: GatewaySessionRow | undefined,
  info: SessionChangedEventInfo,
  source: Record<string, unknown>,
  options: SessionReconcileOptions,
  project?: SessionChangedRowProjection,
): SessionChangedRowResult {
  const { key } = info;
  if (
    !existing ||
    !info.sessionId ||
    existing.sessionId !== info.sessionId ||
    typeof source.revision !== "string" ||
    ancestorRevisions.get(existing) !== source.revision ||
    info.snapshotAt === undefined ||
    !matchesExistingSession(existing, key, info.agentId) ||
    isSessionRowOutsideResultScope(existing, options)
  ) {
    return { applied: false, key, row: existing };
  }
  const retained = {
    ...existing,
    snapshotAt: Math.max(existing.snapshotAt ?? 0, info.snapshotAt),
  };
  const row = project?.(retained, existing, Object.keys(existing), info) ?? retained;
  rememberAncestor(row, retained, source.revision);
  return { applied: true, key, row, admittedRow: row, reconciled: true };
}

export function parseSessionChangedEvent(payload: unknown): ParsedSessionChangedEvent | null {
  const event = recordOrNull(payload);
  if (!event) {
    return null;
  }
  const session = recordOrNull(event.session);
  // Full viewer snapshots inherit only explicit clearing receipts from the envelope.
  let source = session ?? event;
  if (session) {
    const fullSnapshot = Array.isArray(event.ancestorSessions);
    for (const field in event) {
      if (
        Object.hasOwn(event, field) &&
        !Object.hasOwn(session, field) &&
        (!fullSnapshot || event[field] === null)
      ) {
        if (source === session) {
          source = { ...session };
        }
        source[field] = event[field];
      }
    }
  }
  const key = stringValue(source.key) ?? stringValue(event.sessionKey);
  if (!key) {
    return null;
  }
  const reason = stringValue(event.reason) ?? stringValue(source.reason) ?? null;
  const sourceHasActiveRun = source.hasActiveRun;
  const hasActiveRun =
    typeof sourceHasActiveRun === "boolean" ? sourceHasActiveRun : event.hasActiveRun;
  const archived = source.archived;
  const updatedAt = source.updatedAt;
  const snapshotAt = source.snapshotAt;
  const thinkingLevel = source.thinkingLevel;
  const activeRunIds = Object.hasOwn(source, "activeRunIds")
    ? source.activeRunIds
    : event.activeRunIds;
  return {
    info: {
      key,
      reason,
      sessionId: stringValue(source.sessionId),
      updatedAt: typeof updatedAt === "number" ? updatedAt : null,
      snapshotAt:
        typeof snapshotAt === "number" && Number.isFinite(snapshotAt) ? snapshotAt : undefined,
      hasPermissionMode: Object.hasOwn(source, "permissionMode"),
      hasActivitySummary: Object.hasOwn(source, "activitySummary"),
      thinkingLevel:
        typeof thinkingLevel === "string"
          ? thinkingLevel
          : thinkingLevel === null
            ? null
            : undefined,
      agentId: stringValue(event.agentId) ?? null,
      runId: stringValue(event.runId) ?? stringValue(source.runId) ?? null,
      clientRunId: stringValue(event.clientRunId) ?? stringValue(source.clientRunId) ?? null,
      hasActiveRun: typeof hasActiveRun === "boolean" ? hasActiveRun : null,
      activeRunIds: activeRunIds === null || isStringArray(activeRunIds) ? activeRunIds : undefined,
      status: sessionRunStatus(source.status) ?? sessionRunStatus(event.status),
      archived: typeof archived === "boolean" ? archived : null,
      isAncestorReference: event.ancestorSessionRef === true,
    },
    event,
    source,
  };
}

function prepareSessionChangedRow(payload: unknown): PreparedSessionChangedRow | null {
  const parsed = parseSessionChangedEvent(payload);
  if (!parsed) {
    return null;
  }
  const { source } = parsed;
  const {
    agentId: _agentId,
    ancestorRevision: _ancestorRevision,
    ancestorSessions: _ancestorSessions,
    ancestorSessionRefs: _ancestorSessionRefs,
    catalogChanged: _catalogChanged,
    clientRunId: _clientRunId,
    compacted: _compacted,
    key: _key,
    phase: _phase,
    reason: _reason,
    runId: _runId,
    session: _session,
    sessionKey: _sessionKey,
    ts: _ts,
    ...rowFields
  } = source;
  const fields: string[] = [];
  const clearedFields: string[] = [];
  for (const field in rowFields) {
    const value = rowFields[field];
    if (value !== undefined) {
      fields.push(field);
    }
    if (value === null && !NULLABLE_SESSION_ROW_FIELDS.has(field)) {
      clearedFields.push(field);
    }
  }
  const runtime = recordOrNull(rowFields.agentRuntime);
  return {
    ...parsed,
    rowFields,
    fields,
    clearedFields,
    thinkingIdentity: {
      modelProvider: stringValue(rowFields.modelProvider),
      model: stringValue(rowFields.model),
      ...(runtime ? { agentRuntime: { id: stringValue(runtime.id) ?? "" } } : {}),
    },
  };
}

/** Prepare wire facts once; each held query still owns admission and field receipts. */
export function prepareSessionChangedEvent(payload: unknown): PreparedSessionChangedEvent {
  const event = recordOrNull(payload);
  const snapshots: (PreparedSessionChangedRow | null)[] = [prepareSessionChangedRow(payload)];
  if (event && Array.isArray(event.ancestorSessions)) {
    const append = (values: unknown[], reference: boolean) => {
      for (const value of values) {
        const row = recordOrNull(value);
        const key = stringValue(row?.key);
        if (!row || !key) {
          continue;
        }
        snapshots.push(
          prepareSessionChangedRow({
            session: row,
            agentId: stringValue(row.agentId) ?? parseAgentSessionKey(key)?.agentId,
            ts: event.ts,
            ancestorSessions: [],
            ...(reference ? { ancestorSessionRef: true } : {}),
          }),
        );
      }
    };
    append(event.ancestorSessions, false);
    if (Array.isArray(event.ancestorSessionRefs)) {
      append(event.ancestorSessionRefs, true);
    }
  }
  return { event, snapshots };
}

/** Only held ancestors require coverage; complete Gateway ancestry is access-scoped. */
export function hasSessionChangedAncestorCoverage(
  rows: readonly GatewaySessionRow[],
  key: string,
  parentKeys: readonly (string | null | undefined)[],
  snapshots?: readonly (ParsedSessionChangedEvent | null)[],
): boolean {
  return !rows.some(
    (parent) =>
      (parentKeys.some(
        (parentKey) =>
          typeof parentKey === "string" && areUiSessionKeysEquivalent(parentKey, parent.key),
      ) ||
        parent.childSessions?.some((childKey) => areUiSessionKeysEquivalent(childKey, key))) &&
      !snapshots?.some((snapshot) => {
        const info = snapshot?.info;
        return info && matchesExistingSession(parent, info.key, info.agentId);
      }),
  );
}

export function readSessionChangedEvent(payload: unknown): SessionChangedEventInfo | null {
  return parseSessionChangedEvent(payload)?.info ?? null;
}

// Null source confirms inheritance; omission on a lifecycle event preserves selection.
const NULLABLE_SESSION_ROW_FIELDS = new Set<string>([
  "updatedAt",
  "activeLeafEntryId",
  "modelOverrideSource",
]);

export type SessionRowObservation = {
  observe?: (row: GatewaySessionRow) => void;
  isProvisional?: (row: GatewaySessionRow) => boolean;
  project?: (row: GatewaySessionRow, donor?: GatewaySessionRow) => GatewaySessionRow;
};

type SessionRowReconcileOptions = SessionReconcileOptions & {
  preserveExisting?: boolean;
  clearedFields?: readonly string[];
};

type RejectedRowDisposition =
  | "invalid"
  | "outside-scope"
  | "preserved"
  | "older"
  | "unpersisted"
  | "stale-active";

type SessionRowReconcileResult =
  | {
      disposition: RejectedRowDisposition;
      row: GatewaySessionRow | undefined;
      admittedRow?: undefined;
    }
  | {
      disposition: "unchanged" | "accepted";
      row: GatewaySessionRow | undefined;
      admittedRow: GatewaySessionRow;
    };

export function isSessionRowOutsideResultScope(
  row: GatewaySessionRow,
  options: SessionReconcileOptions,
): boolean {
  const resultAgentId = options.resultAgentId?.trim()
    ? normalizeAgentId(options.resultAgentId)
    : null;
  const incomingAgentId = sessionAgentId(row, options.selectedGlobalAgentId ?? null);
  return resultAgentId !== null && incomingAgentId !== null && incomingAgentId !== resultAgentId;
}

/** Reduces one matched row; its caller owns the roster and request/deletion fences. */
export function reconcileSessionRow(
  incoming: GatewaySessionRow | undefined,
  previous: GatewaySessionRow | undefined,
  options: SessionRowReconcileOptions = {},
  observation?: SessionRowObservation,
): SessionRowReconcileResult {
  const reject = (disposition: RejectedRowDisposition): SessionRowReconcileResult => ({
    disposition,
    row: previous,
  });
  if (!incoming?.key) {
    return reject("invalid");
  }
  const session = sanitizeSessionRow(incoming);
  if (isSessionRowOutsideResultScope(session, options)) {
    return reject("outside-scope");
  }
  // Provisional presentation cannot donate metadata, but still fences old/run snapshots.
  const existing = previous && observation?.isProvisional?.(previous) ? undefined : previous;
  if (options.preserveExisting && previous) {
    return reject("preserved");
  }
  if (
    session.updatedAt != null &&
    previous?.updatedAt != null &&
    session.updatedAt < previous.updatedAt
  ) {
    return reject("older");
  }
  if (!existing && !isPersistedSessionRow(session)) {
    return reject("unpersisted");
  }
  const visibleKey = previous?.key ?? session.key;
  let admittedRow = preserveRosterPresentationMetadata(
    preserveOmittedThinkingMetadata(
      visibleKey === session.key ? session : { ...session, key: visibleKey },
      existing,
    ),
    existing,
  );
  for (const field of options.clearedFields ?? []) {
    Reflect.deleteProperty(admittedRow, field);
  }
  if (isStaleForActiveSession(admittedRow, previous)) {
    return reject("stale-active");
  }
  admittedRow = observation?.project?.(admittedRow, existing) ?? admittedRow;
  const retained = sessionMatchesArchivedFilter(admittedRow, options.archivedFilter ?? "active");
  if (existing && isShallowEqualSessionRow(admittedRow, existing) && retained) {
    // Confirm only an identical full input; copied omitted fields remain donor facts.
    const confirmRead = isShallowEqualSessionRow(session, existing);
    if (confirmRead) {
      observation?.observe?.(existing);
    }
    return {
      disposition: "unchanged",
      row: existing,
      admittedRow: confirmRead ? existing : admittedRow,
    };
  }
  const row = retained ? admittedRow : undefined;
  if (row) {
    observation?.observe?.(row);
  }
  return { disposition: "accepted", row, admittedRow };
}

/** List owners admit certified snapshots only after proving their query membership. */
export function reconcileParsedSessionChangedRow(
  existing: GatewaySessionRow | undefined,
  parsed: PreparedSessionChangedRow,
  options: SessionReconcileOptions & { admitSnapshot?: boolean } = {},
  project?: SessionChangedRowProjection,
): SessionChangedRowResult {
  const { info, event, source, rowFields, clearedFields, thinkingIdentity } = parsed;
  const { key, reason } = info;
  if (info.isAncestorReference) {
    return reconcileAncestorReference(existing, info, source, options, project);
  }
  if (
    !info.agentId &&
    (isUiGlobalSessionKey(key) || (!parseAgentSessionKey(key) && !Object.keys(rowFields).length))
  ) {
    return { applied: false, key, row: existing };
  }
  if (reason === "delete") {
    if (!info.sessionId || (existing && existing.sessionId !== info.sessionId)) {
      return { applied: false, key, row: existing };
    }
    return { applied: true, key, deletedKey: existing?.key ?? key };
  }
  // The Gateway folds cron/spawn-child into direct before projection.
  const kind =
    rowFields.kind === "direct" ||
    rowFields.kind === "group" ||
    rowFields.kind === "global" ||
    rowFields.kind === "unknown"
      ? rowFields.kind
      : existing?.kind;
  const updatedAt =
    typeof rowFields.updatedAt === "number" ? rowFields.updatedAt : existing?.updatedAt;
  const sessionId = stringValue(rowFields.sessionId) ?? existing?.sessionId;
  if (!kind || (!existing && sessionId === undefined && typeof updatedAt !== "number")) {
    return { applied: false, row: existing };
  }
  const eventResult = {
    applied: true as const,
    key,
  };
  const fullSnapshot = Array.isArray(event.ancestorSessions);
  if (!existing && (!options.admitSnapshot || !fullSnapshot || !recordOrNull(event.session))) {
    return eventResult;
  }
  const existingFields =
    existing && !thinkingMetadataIdentityMatches(thinkingIdentity, existing)
      ? stripThinkingMetadata(existing)
      : existing;
  const snapshotAgentId = stringValue(recordOrNull(event.session)?.agentId);
  const offered = {
    ...(fullSnapshot ? {} : existingFields),
    ...rowFields,
    key: existing?.key ?? key,
    kind,
    updatedAt: updatedAt ?? null,
    ...(sessionId ? { sessionId } : {}),
    ...(fullSnapshot && snapshotAgentId ? { agentId: snapshotAgentId } : {}),
  };
  for (const field of clearedFields) {
    Reflect.deleteProperty(offered, field);
  }
  const fields =
    existingFields !== existing ? [...parsed.fields, ...thinkingMetadataFields] : parsed.fields;
  const reduced = reconcileSessionRow(
    offered,
    existing,
    {
      ...options,
      selectedGlobalAgentId: info.agentId ?? options.selectedGlobalAgentId ?? null,
      clearedFields,
    },
    project && existing
      ? {
          project: (row) =>
            project(
              row,
              existing,
              fullSnapshot
                ? [
                    ...fields,
                    ...Object.keys(existing).filter((field) => !Object.hasOwn(row, field)),
                  ]
                : fields,
              info,
            ),
        }
      : undefined,
  );
  const previousOwner = existing?.owner?.actor;
  if (typeof source.ancestorRevision === "string" && reduced.admittedRow) {
    rememberAncestor(reduced.admittedRow, sanitizeSessionRow(offered), source.ancestorRevision);
  }
  const nextOwner = reduced.admittedRow?.owner?.actor;
  const ownershipChanged =
    Boolean(reduced.admittedRow) &&
    (fullSnapshot ||
      Object.hasOwn(rowFields, "owner") ||
      Object.hasOwn(rowFields, "createdActor")) &&
    (previousOwner?.type !== nextOwner?.type ||
      previousOwner?.id !== nextOwner?.id ||
      previousOwner?.label !== nextOwner?.label ||
      existing?.owner?.assignedAt !== reduced.admittedRow?.owner?.assignedAt);
  return {
    ...eventResult,
    row: reduced.row,
    admittedRow: reduced.admittedRow,
    reconciled: true,
    disposition: reduced.disposition,
    ...(typeof event.ts === "number" && Number.isFinite(event.ts) ? { eventTs: event.ts } : {}),
    ownershipChanged,
  };
}
