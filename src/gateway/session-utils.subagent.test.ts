import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import * as subagentRegistryState from "../agents/subagents/registry/subagent-registry-state.js";
import { canonicalSubagentRunFixtures } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunFixture } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { registerSubagentSessionStatusTests } from "./session-utils.subagent-status.test-harness.js";
import { useSessionStoreFixture } from "./session-utils.test-support.js";
const rowReader = createResidentSessionRowReader();
async function withRegistry<T>(fn: () => Promise<T>, resetRuntimeConfig = false) {
  return withRawStateDirEnv("openclaw-session-subagent-", () =>
    withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      try {
        return await fn();
      } finally {
        await rowReader.dispose();
        if (resetRuntimeConfig) {
          resetConfigRuntimeState();
        }
        await closeOpenClawStateDatabaseAsync();
      }
    }),
  );
}

const fixtureStorePath = useSessionStoreFixture("openclaw-session-subagent-list-");

function childEntry(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return { sessionId, updatedAt, spawnedBy: "agent:main:main", ...overrides };
}

function runFixture(
  runId: string,
  childSessionKey: string,
  createdAt: number,
  startedAt: number,
  overrides: Partial<SubagentRunFixture> = {},
): SubagentRunFixture {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    createdAt,
    startedAt,
    requesterDisplayKey: "tree",
    task: "synthetic task",
    cleanup: "keep",
    ...overrides,
  };
}
function registerRun(...args: Parameters<typeof runFixture>) {
  return addSubagentRunForTests({
    controllerSessionKey: "agent:main:main",
    ...runFixture(...args),
  });
}

describe("session list subagent metadata", () => {
  afterEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await closeOpenClawStateDatabaseAsync();
    await resetSubagentRegistryForTests({ persist: false });
    resetConfigRuntimeState();
  });
  beforeEach(async () => {
    resetAgentEventsForTest({ preserveListeners: true });
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(cfg, cfg);
  });

  const cfg: OpenClawConfig = { session: { mainKey: "main" }, agents: { entries: { main: {} } } };

  function listSubagentSessions(
    store: Record<string, SessionEntry>,
    opts: Parameters<typeof listSessionFixture>[0]["opts"] = {},
  ) {
    return listSessionFixture({ cfg, storePath: fixtureStorePath(), store, opts });
  }

  test("keeps exact rows equivalent through descendant retention, moves, generations, and deletion", () =>
    withRegistry(async () => {
      const now = Date.now();
      setRuntimeConfigSnapshot(cfg, cfg);
      const key = (name: string) => `agent:main:subagent:${name}`;
      const root = key("root");
      const movedRoot = key("moved-root");
      const navigation = key("navigation");
      const child = key("child");
      const grandchild = key("grandchild");
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      for (const sessionKey of [root, movedRoot, navigation, child, grandchild]) {
        const links = sessionKey === child ? { spawnedBy: root, parentSessionKey: navigation } : {};
        await replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId: sessionKey.split(":").at(-1)!, updatedAt: now, ...links },
        );
      }
      const makeRun = (runId: string, childSessionKey: string, requesterSessionKey: string) =>
        runFixture(runId, childSessionKey, now - 10_000, now - 9_000, { requesterSessionKey });
      const records: SubagentRunFixture[] = [
        {
          ...makeRun("child", child, key("other")),
          controllerSessionKey: root,
          endedAt: now - 3 * 60 * 60_000,
        },
        { ...makeRun("grandchild", grandchild, child), generation: 1 },
        makeRun("collision", key("old-collision"), root),
        {
          ...makeRun(" collision ", key("new-collision"), key("other")),
          createdAt: now - 5_000,
        },
        {
          ...makeRun("deleted-collector", key("deleted"), key("other")),
          controllerSessionKey: root,
          collect: true,
          groupId: "group",
          swarmRequesterSessionKey: root,
          requesterAgentId: "main",
          collectorCompletion: { status: "done" },
          endedAt: now - 1_000,
        },
      ];
      const runs = canonicalSubagentRunFixtures(new Map(records.map((run) => [run.runId, run])));
      saveSubagentRegistryToSqlite(runs);
      const read = async (sessionKey: string, at = now) =>
        expectDefined(await rowReader.row(sessionKey, { now: at }), "resident row");
      expect((await read(root)).childSessions).toEqual([child]);
      expect((await read(navigation)).childSessions).toEqual([child]);
      expect((await read(child)).hasActiveSubagentRun).toBe(true);
      expect((await read(root)).swarm?.groups).toMatchObject([{ groupId: "group", done: 1 }]);

      const childRun = expectDefined(runs.get("child"), "child run");
      const moved = { ...childRun, controllerSessionKey: movedRoot };
      subagentRuns.set(moved.runId, moved);
      subagentRuns.commitOwnership(moved);
      expect((await read(root)).childSessions).toBeUndefined();
      expect((await read(movedRoot)).childSessions).toEqual([child]);
      expect((await read(navigation)).childSessions).toEqual([child]);

      const replacement = {
        ...expectDefined(runs.get("grandchild"), "grandchild run"),
        runId: "replacement",
        generation: 2,
        requesterSessionKey: key("unrelated"),
      };
      persistRegistryFixture(new Map([[replacement.runId, replacement]]), [replacement.runId]);
      expect((await read(child)).hasActiveSubagentRun).toBe(false);
      expect((await read(movedRoot)).childSessions).toBeUndefined();
      expect((await read(navigation)).childSessions).toBeUndefined();

      const recent = { ...moved, execution: { ...moved.execution, endedAt: now - 29 * 60_000 } };
      subagentRuns.set(recent.runId, recent);
      subagentRuns.commitOwnership(recent);
      expect((await read(movedRoot)).childSessions).toEqual([child]);
      expect((await read(movedRoot, now + 2 * 60_000)).childSessions).toBeUndefined();
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: child, storeKeys: [child] },
      });
      expect((await read(movedRoot)).childSessions).toBeUndefined();
      expect((await read(navigation)).childSessions).toBeUndefined();
    }, true));

  registerSubagentSessionStatusTests(listSubagentSessions);

  test("keeps follow-up turn timing instead of the finished spawn run", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:follow-up";
    await registerRun("run-spawn", childSessionKey, now - 60_000, now - 59_000, {
      endedAt: now - 55_787,
      outcome: { status: "ok" },
    });
    const list = (entry: Partial<SessionEntry>) =>
      listSubagentSessions({
        [childSessionKey]: childEntry("sess-follow-up", now, entry),
      }).then((result) => result.sessions.find((session) => session.key === childSessionKey));

    for (const fields of [
      { endedAt: undefined, runtimeMs: undefined },
      { endedAt: now - 1_000, runtimeMs: 29_000, status: "done" as const },
    ]) {
      const row = await list({ startedAt: now - 30_000, ...fields });
      expect([row?.startedAt, row?.endedAt, row?.runtimeMs]).toEqual([
        now - 30_000,
        fields.endedAt,
        fields.runtimeMs,
      ]);
    }
  });

  test("prefers persisted terminal session state when only stale active subagent snapshots remain", async () => {
    await withRegistry(async () => {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const records = [
        runFixture("run-complete", childSessionKey, now - 2_000, now - 1_900, {
          endedAt: now - 1_800,
          outcome: { status: "ok" },
        }),
        runFixture("run-live", childSessionKey, now - 10_000, now - 9_000),
      ];
      saveSubagentRegistryToSqlite(
        canonicalSubagentRunFixtures(new Map(records.map((run) => [run.runId, run]))),
      );
      const result = await listSubagentSessions({
        [childSessionKey]: childEntry("sess-disk-live", now, {
          status: "done",
          endedAt: now - 1_800,
          runtimeMs: 100,
        }),
      });
      expect(result.sessions.find((session) => session.key === childSessionKey)).toMatchObject({
        status: "done",
        subagentRunState: "historical",
        hasActiveSubagentRun: false,
        startedAt: now - 9_000,
        endedAt: now - 1_800,
        runtimeMs: 100,
      });
    });
  });

  test("does not reattach stale terminal store-only child links", async () => {
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { sessionId: "sess-main", updatedAt: now },
      "agent:claude:acp:done-child": childEntry("sess-done-child", staleAt, {
        status: "done",
        endedAt: staleAt,
      }),
    };

    const all = await listSubagentSessions(store);
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = await listSubagentSessions(store, { spawnedBy: "agent:main:main" });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("omits deleted child sessions while retaining collector runs", async () => {
    const now = Date.now();
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:deleted";
    const store: Record<string, SessionEntry> = {
      [parentKey]: { sessionId: "parent", updatedAt: now },
      [childKey]: { sessionId: "child", updatedAt: now - 1 },
    };
    await addSubagentRunForTests(
      runFixture("retained-child", childKey, now - 5_000, now - 4_000, {
        requesterSessionKey: parentKey,
        cleanup: "delete",
        collect: true,
        endedAt: now - 1_000,
        outcome: { status: "ok" },
        cleanupCompletedAt: now - 500,
      }),
    );
    const list = (spawnedBy?: string) => listSubagentSessions(store, { spawnedBy });
    const before = await list();
    expect(before.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([childKey]);
    expect((await list(parentKey)).sessions.map((row) => row.key)).toEqual([childKey]);

    delete store[childKey];
    const after = await list();
    expect((await list(parentKey)).sessions).toEqual([]);
    expect(after.sessions.find((row) => row.key === parentKey)?.childSessions).toBeUndefined();
  });

  describe("payload projection", () => {
    const parentKey = "agent:main:main";
    const childKey = (runId: string) => `agent:main:subagent:${runId}`;
    const makeRun = (runId: string, overrides: Partial<SubagentRunFixture> = {}) =>
      runFixture(runId, childKey(runId), 1, 2, {
        requesterDisplayKey: "main",
        task: "live child",
        ...overrides,
      });
    const writeSession = (
      sessionKey: string,
      sessionId: string,
      fields: Partial<SessionEntry> = {},
    ) =>
      replaceSessionEntrySync(
        { storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }), sessionKey },
        { sessionId, updatedAt: 1, ...fields },
      );
    const saveRuns = (runs: SubagentRunFixture[]) =>
      saveSubagentRegistryToSqlite(
        canonicalSubagentRunFixtures(new Map(runs.map((run) => [run.runId, run]))),
      );

    test("loads direct children without repeated or unrelated host-thread payload validation", async () => {
      await withRegistry(async () => {
        const runs: SubagentRunFixture[] = [];
        const nativeJson = new DatabaseSync(":memory:");
        try {
          // Async writes schedule maintenance whose retained-payload reads contaminate this observer.
          writeSession(parentKey, "parent");
          const other = "agent:main:other";
          for (const [runId, requesterSessionKey, controllerSessionKey] of [
            ["explicit", other, parentKey],
            ["fallback", parentKey, undefined],
            ["redirected", parentKey, other],
            ["unrelated", other, other],
            ["alias", "main", undefined],
          ] as const) {
            writeSession(childKey(runId), runId);
            runs.push(
              makeRun(runId, {
                requesterSessionKey,
                controllerSessionKey,
                requesterDisplayKey: "parent",
                task:
                  runId === "unrelated"
                    ? "unrelated-retained-payload".repeat(1_024)
                    : `selected-retained-payload:${runId}:${"x".repeat(16_384)}`,
                createdAt: runId === "alias" ? 0 : 1,
              }),
            );
          }
          saveRuns(runs);
          subagentRegistryState.clearSubagentRunsReadCacheForTest();
          const validateJson = nativeJson.prepare("SELECT json_valid(?) AS value");
          let unrelatedInspections = 0;
          let retainedValidationBytes = 0;
          requireNativeSqliteDatabase(openOpenClawStateDatabase().db).function(
            "json_valid",
            { deterministic: true },
            (value) => {
              if (typeof value === "string" && value.includes("unrelated-retained-payload")) {
                unrelatedInspections += 1;
              }
              if (typeof value === "string" && value.includes("selected-retained-payload:")) {
                retainedValidationBytes += Buffer.byteLength(value);
              }
              return validateJson.get(value)?.value ?? 0;
            },
          );

          await subagentRegistryState.prepareSubagentSessionListReadCache();
          const { store } = await loadGatewaySessionEntryReadOnlyInWorker({
            cfg,
            key: "main",
            includeStoreChildEntries: true,
          });
          expect(Object.keys(store)).toEqual([
            parentKey,
            ...["explicit", "fallback", "alias"].map(childKey),
          ]);
          expect(unrelatedInspections).toBe(0);
          // Host validation stays proportional to selected bytes, not metadata fields per payload.
          const selectedPayloadBytes = openOpenClawStateDatabase()
            .db.prepare(
              "SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM subagent_runs WHERE run_id IN ('explicit', 'fallback', 'alias')",
            )
            .get()?.bytes;
          expect(typeof selectedPayloadBytes).toBe("number");
          expect(retainedValidationBytes).toBeLessThanOrEqual(Number(selectedPayloadBytes) * 2);
          await (await rowReader.ready()).ensureMaterialized();
          const startupInspections = unrelatedInspections;
          expect((await rowReader.row(parentKey))?.key).toBe(parentKey);
          expect(unrelatedInspections).toBe(startupInspections);
        } finally {
          await rowReader.dispose();
          await closeOpenClawStateDatabaseAsync();
          nativeJson.close();
        }
      });
    });

    test("projects lifecycle ownership and lineage without parsing retained task payloads", async () => {
      await withRegistry(async () => {
        const now = Date.now();
        // Stack formatting can parse this test’s source map; only runtime bytes identify stored tasks.
        const retainedTaskMarker = `retained-task-payload:${now}:`;
        const liveChildKey = childKey("lifecycle-child");
        const navigationKey = "agent:main:dashboard:navigation-parent";
        writeSession(parentKey, "parent", { updatedAt: now });
        writeSession(liveChildKey, "child", {
          updatedAt: now,
          parentSessionKey: navigationKey,
          spawnedBy: "agent:main:subagent:old-controller",
        });
        saveRuns(
          Array.from({ length: 20 }, (_, index) =>
            makeRun(`retained-${index}`, {
              task: `${retainedTaskMarker}${"x".repeat(16_384)}`,
              createdAt: now - 10_000,
              startedAt: now - 9_000,
              endedAt: now - 8_000,
              outcome: { status: "ok" },
            }),
          ),
        );
        await addSubagentRunForTests(
          makeRun("live-child", {
            childSessionKey: liveChildKey,
            controllerSessionKey: parentKey,
            createdAt: now - 100,
            startedAt: now - 50,
          }),
        );
        claimAgentRunContext(
          "live-child",
          { sessionKey: liveChildKey },
          { trackOwner: true, ownsContext: true },
        );
        subagentRegistryState.clearSubagentRunsReadCacheForTest();
        await (await rowReader.ready()).ensureMaterialized();
        const parse = vi.spyOn(JSON, "parse");
        try {
          const parent = (await rowReader.snapshot(parentKey, { now })).row;
          const child = (await rowReader.snapshot(liveChildKey, { now })).row;
          expect(parent).toMatchObject({
            hasActiveSubagentRun: true,
            childSessions: [liveChildKey],
          });
          expect(child).toMatchObject({
            subagentRunState: "active",
            hasActiveSubagentRun: true,
            controlOwnerSessionKey: parentKey,
            parentSessionKey: navigationKey,
          });
          expect([parent?.swarm, child?.swarm]).toEqual([undefined, undefined]);
          expect(parse.mock.calls.some(([value]) => value.includes(retainedTaskMarker))).toBe(
            false,
          );
        } finally {
          parse.mockRestore();
        }
      });
    });
  });
});
