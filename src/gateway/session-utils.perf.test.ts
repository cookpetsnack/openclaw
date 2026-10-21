import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, test, expect, vi } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import * as modelCatalogLookup from "../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { projectSessionPatchResult } from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import * as rowProjection from "./session-utils-row.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

function prepareRuntime(cfg: OpenClawConfig) {
  resetPluginRuntimeStateForTest();
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot(cfg);
  return registry;
}

function makeStore(
  count: number,
  prefix: string,
  fields: (index: number) => Partial<SessionEntry> = () => ({}),
  key: (sessionId: string, index: number) => string = (id) => `agent:main:${id}`,
) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const sessionId = `${prefix}-${index}`;
      return [
        key(sessionId, index),
        { sessionId, updatedAt: index + 1, ...fields(index) },
      ] as const;
    }),
  );
}

function atImmediate(callback: () => void) {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      callback();
      resolve();
    });
  });
}

function ownedProjection<T extends { dispose(): void }>(projection: T) {
  return Object.assign(projection, { [Symbol.dispose]: () => projection.dispose() });
}

function measureRows(onRow: (count: number) => void = () => {}, chargeBeforeRead = false) {
  const work = { milliseconds: 0, count: 0 };
  const clock = vi.spyOn(performance, "now").mockImplementation(() => work.milliseconds);
  const read = rowProjection.readSessionRowInputs;
  const rows = vi.spyOn(rowProjection, "readSessionRowInputs").mockImplementation((params) => {
    if (chargeBeforeRead) {
      work.milliseconds += 20;
    }
    const result = read(params);
    if (!chargeBeforeRead) {
      work.milliseconds += 20;
    }
    onRow(++work.count);
    return result;
  });
  return {
    work,
    rows,
    restore() {
      rows.mockRestore();
      clock.mockRestore();
    },
  };
}

// Resolver call counts protect O(unique model tuples), without CI wall-clock noise.
describe("session list resolver cache", () => {
  test("bounds dirty-refresh roster work across config publication", async () => {
    const rosterSize = 32;
    await withStateDirEnv("openclaw-roster-chunks-", async () => {
      const rowCount = 80;
      const ownerId = `agent-${rosterSize - 1}`;
      const entries = Object.fromEntries(
        Array.from({ length: rosterSize }, (_, index) => [
          `agent-${index}`,
          { identity: { name: `Agent ${index}` }, fastModeDefault: false },
        ]),
      );
      let insideRow = false;
      let rowReads = 0;
      const observedEntries: typeof entries = {};
      // Getters preserve property-read accounting while keeping config snapshots cloneable.
      for (const id of Object.keys(entries)) {
        Object.defineProperty(observedEntries, id, {
          enumerable: true,
          get() {
            if (insideRow) {
              rowReads++;
            }
            return entries[id];
          },
        });
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: observedEntries,
          defaults: { model: { primary: "example/roster-model" }, thinkingDefault: "off" },
        },
      };
      prepareRuntime(cfg);
      const store = makeStore(
        rowCount,
        "row-chunk",
        () => ({ createdActor: { type: "agent", id: ownerId } }),
        (_id, index) => `agent:${ownerId}:dashboard:${index}`,
      );
      writeResidentEntries(store);
      let projection: SessionRowProjection | undefined;
      let refreshBatch = 0;
      const createDrain = projectionWork.createSessionProjectionDrain;
      const drains = vi.spyOn(projectionWork, "createSessionProjectionDrain");
      drains.mockImplementation((params) =>
        createDrain({
          ...params,
          refresh() {
            refreshBatch++;
            return params.refresh();
          },
        }),
      );
      try {
        projection = await createSessionRowProjection({ cfg });
        let projectedRows = 0;
        let rowsBeforePause = 0;
        let identityDuringPause: string | undefined;
        let control: Promise<void> | undefined;
        const rowBatches = new Set<number>();
        const buildRow = rowProjection.readSessionRowInputs;
        const rows = vi
          .spyOn(rowProjection, "readSessionRowInputs")
          .mockImplementation((params) => {
            rowBatches.add(refreshBatch);
            insideRow = true;
            try {
              return buildRow(params);
            } finally {
              insideRow = false;
              projectedRows++;
              if (projectedRows === 1) {
                control = atImmediate(() => {
                  rowsBeforePause = projectedRows;
                  entries[ownerId] = {
                    identity: { name: "Refreshed owner" },
                    fastModeDefault: true,
                  };
                  setRuntimeConfigSnapshot(cfg);
                  identityDuringPause = resolveAgentIdentity(cfg, ownerId)?.name;
                });
              }
            }
          });
        try {
          writeResidentEntries(store, 1);
          await projection.ensureMaterialized();
          const result = await listProjectedSessions({ projection, opts: { limit: rowCount } });
          expect(result).toMatchObject({ count: rowCount, totalCount: rowCount });
          expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
          expect(rowsBeforePause).toBeGreaterThan(0);
          expect(rowsBeforePause).toBeLessThan(rowCount);
          expect(identityDuringPause).toBe("Refreshed owner");
          expect(result.sessions.every((row) => row.effectiveFastMode === true)).toBe(true);
          expect(result.owners?.find((owner) => owner.id === ownerId)?.label).toBe(
            "Refreshed owner",
          );
          expect(rowBatches.size).toBeGreaterThan(1);
          expect(rowReads).toBeLessThanOrEqual(rosterSize * rowBatches.size * 3);
          rows.mockClear();
          await listProjectedSessions({ projection, opts: { limit: rowCount } });
          expect(rows).not.toHaveBeenCalled();
        } finally {
          rows.mockRestore();
          await control;
        }
      } finally {
        drains.mockRestore();
        projection?.dispose();
      }
    });
  });

  test.each(["first page", "dirty refresh"])(
    "yields during expensive %s materialization without reprojecting unchanged rows",
    async (phase) => {
      await withStateDirEnv("openclaw-row-work-budget-", async () => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" } },
        };
        prepareRuntime(cfg);
        const rowCount = 96;
        const store = makeStore(rowCount, "budget");
        writeResidentEntries(store);
        let projection: SessionRowProjection | undefined;
        if (phase === "dirty refresh") {
          projection = await createSessionRowProjection({ cfg });
          await listProjectedSessions({ projection, opts: { limit: rowCount } });
        }
        let rowsAtControl = 0;
        let control: Promise<void> | undefined;
        const measured = measureRows((count) => {
          if (count === 1) {
            control = atImmediate(() => {
              rowsAtControl = measured.work.count;
            });
          }
        });
        try {
          if (projection) {
            writeResidentEntries(store, 1);
            await projection.ensureMaterialized();
          } else {
            projection = await createSessionRowProjection({ cfg });
            await listProjectedSessions({ projection, opts: { limit: rowCount } });
          }
          await control;
          await projection.ensureMaterialized();
          expect(rowsAtControl).toBeGreaterThan(0);
          expect(rowsAtControl).toBeLessThan(rowCount);
          expect(measured.work.count).toBe(rowCount);
          measured.rows.mockClear();
          const result = await listProjectedSessions({ projection, opts: { limit: rowCount } });
          expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
          expect(measured.rows).not.toHaveBeenCalled();
        } finally {
          measured.restore();
          await control;
          projection?.dispose();
        }
      });
    },
  );

  test("bounds catalog acquisition per publication and reuses each agent's model metadata", async () => {
    await withStateDirEnv("openclaw-perf-catalog-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {}, research: {} },
          defaults: { model: { primary: "example/model-hit" } },
        },
      };
      const pluginRegistry = prepareRuntime(cfg);
      const modelCatalog = new Map(
        ["main", "research"].map((agentId) => [
          agentId,
          {
            entries: ["model-hit", "Model-Hit"].map((id): ModelCatalogEntry => ({
              provider: "example",
              id,
              name: "Example model",
              contextWindowDefault: "full",
            })),
            pluginRegistry,
          },
        ]),
      );
      const store = makeStore(
        80,
        "catalog",
        (index) => ({
          updatedAt: index,
          providerOverride: "example",
          modelOverride:
            index % 8 < 2 ? "model-hit" : index % 8 < 4 ? "Model-Hit" : "model-missing",
        }),
        (id, index) => `agent:${index % 2 ? "research" : "main"}:dashboard:${id}`,
      );
      writeResidentEntries(store);
      const acpSessionKeys = new Set<string>();
      for (const [index, [sessionKey, entry]] of Object.entries(store).entries()) {
        if (index % 8 < 2) {
          acpSessionKeys.add(sessionKey);
          seedCanonicalAcpSessionMeta({
            sessionKey,
            sessionId: entry.sessionId,
            meta: {
              backend: "acpx",
              agent: index % 2 ? "research" : "main",
              runtimeSessionName: `catalog-${index}`,
              mode: "persistent",
              state: "idle",
              lastActivityAt: index,
            },
          });
        }
      }
      using catalogSpy = vi.spyOn(modelCatalogLookup, "findModelCatalogEntry");
      let projection: SessionRowProjection | undefined;
      try {
        for (const revision of [1, 2]) {
          for (const [agentId, catalog] of modelCatalog) {
            catalog.entries.forEach((entry, index) => {
              const contextTokens = revision * (index + 1) * (agentId === "main" ? 10_000 : 20_000);
              catalog.entries[index] = {
                ...entry,
                contextTokens,
                contextWindows: [{ id: "full", label: "Full", contextWindow: contextTokens }],
              };
            });
          }
          catalogSpy.mockClear();
          if (projection) {
            notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
            await projection.ensureMaterialized();
          } else {
            projection = await createSessionRowProjection({
              cfg,
              modelCatalog,
              getModelCatalog: async () => modelCatalog,
            });
          }
          const result = await listProjectedSessions({ projection, opts: { limit: 80 } });
          expect(result.count).toBe(80);
          const catalogRows = result.sessions.filter(
            (row) => row.model?.toLowerCase() === "model-hit",
          );
          expect(catalogRows).toHaveLength(40);
          for (const row of catalogRows) {
            expect(row.contextTokens).toBe(
              acpSessionKeys.has(row.key)
                ? undefined
                : revision *
                    (row.model === "Model-Hit" ? 2 : 1) *
                    (row.agentId === "main" ? 10_000 : 20_000),
            );
            expect(row).not.toHaveProperty("catalogEntry");
          }
          // Acquisition shares both hits and misses; defaults retain their separate lookup.
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(10);
          catalogSpy.mockClear();
          let warmCatalogReads: number;
          {
            using inputs = vi.spyOn(rowProjection, "readSessionRowInputs");
            await listProjectedSessions({ projection, opts: { limit: 80 } });
            expect(inputs).not.toHaveBeenCalled();
            warmCatalogReads = catalogSpy.mock.calls.length;
          }
          catalogSpy.mockClear();
          const updatedKey = "agent:main:dashboard:catalog-2";
          for (let update = 0; update < 4; update++) {
            store[updatedKey] = { ...store[updatedKey]!, label: `Metadata update ${update}` };
            writeResidentEntries({ [updatedKey]: store[updatedKey]! }, 1);
            const updated = await listProjectedSessions({ projection, opts: { limit: 80 } });
            expect(updated.sessions.find((row) => row.key === updatedKey)).toMatchObject({
              label: `Metadata update ${update}`,
              contextTokens: revision * 20_000,
            });
          }
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(warmCatalogReads * 4);
          catalogSpy.mockClear();
          const key = "agent:main:dashboard:catalog-0";
          const patch = projectSessionPatchResult({
            cfg,
            canonicalKey: key,
            targetAgentId: "main",
            entry: store[key]!,
            preparedAcpMeta: projection.describe({ key, agentId: "main" })?.preparedAcpMeta ?? null,
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
            modelCatalog: modelCatalog.get("main")!.entries,
          });
          expect(patch.resolved).toMatchObject({
            contextWindow: "full",
            contextWindows: [{ id: "full", label: "Full", contextWindow: revision * 10_000 }],
          });
          expect(patch.resolved).not.toHaveProperty("catalogEntry");
          expect(catalogSpy.mock.calls.length).toBeLessThanOrEqual(2);
        }
      } finally {
        projection?.dispose();
      }
    });
  });

  test.each([
    { name: "ordinary page", limit: 100, search: undefined },
    { name: "wide ordering", limit: 300, search: undefined },
    { name: "unmatched search", limit: 1, search: "unmatched" },
  ])(
    "reuses resident input facts for $name without a request-time yield",
    async ({ limit, search }) => {
      await withStateDirEnv("openclaw-list-work-budget-", async ({ stateDir }) => {
        const cfg: OpenClawConfig = {};
        prepareRuntime(cfg);
        const entryCount = limit === 300 ? 2051 : 32;
        const store = makeStore(entryCount, "budget");
        const projection = createSessionRowProjectionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
        });
        // Measure resident row work independently of asynchronous identity-file admission.
        const identityRuntime = await import("../agents/identity-file-runtime.js");
        const identityReads = vi.spyOn(identityRuntime, "prepareIdentityFile");
        identityReads.mockResolvedValue({ kind: "missing" });
        // Charge former acquisition work before each read, even if it throws.
        const measured = measureRows(undefined, true);
        let controlRan = false;
        const control = atImmediate(() => {
          controlRan = true;
        });
        try {
          for (let request = 0; request < 2; request++) {
            const result = await listProjectedSessions({ projection, opts: { limit, search } });
            expect(result.sessions.map((row) => row.key)).toEqual(
              !search ? Object.keys(store).toReversed().slice(0, limit) : [],
            );
            expect(controlRan).toBe(false);
            expect(measured.rows).not.toHaveBeenCalled();
            expect(measured.work.milliseconds).toBe(0);
          }
        } finally {
          identityReads.mockRestore();
          measured.restore();
          projection.dispose();
          await control;
        }
      });
    },
  );

  test("bounds owner-first transcript fields without starving shared rows", async () => {
    await withStateDirEnv("openclaw-perf-title-batch-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
      };
      prepareRuntime(cfg);
      const storePath = path.join(stateDir, "sessions.json");
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      using _ = {
        [Symbol.dispose]: (await prepareUserProfileCatalog()).release,
      };
      // Half the roster belongs to this owner, behind newer shared sessions.
      const store = makeStore(480, "title-batch", (index) => ({
        updatedAt: 1_000 - index,
        ...(index >= 240
          ? {
              createdVia: "operator",
              createdActor: { type: "human", source: "profile", id: ownerId },
            }
          : {}),
      }));

      const titleFieldsBySessionKey = new Map(
        Object.keys(store).map(
          (key, index) =>
            [
              key,
              { firstUserMessage: `title ${index}`, lastMessagePreview: `last ${index}` },
            ] as const,
        ),
      );
      const client = createOperatorClient({ profileId: ownerId, scopes: ["operator.admin"] });
      prepareGatewayRecipientProfile(client);
      using projection = ownedProjection(
        createSessionRowProjectionFixture({
          cfg,
          storePath,
          store,
          titleFieldsBySessionKey,
        }),
      );
      const list = (include: boolean) =>
        listProjectedSessions({
          projection,
          client,
          opts: {
            ownerFirst: true,
            includeDerivedTitles: include,
            includeLastMessage: include,
            limit: 240,
          },
        });
      const result = await list(true);

      expect(result.sessions).toHaveLength(300);
      for (const field of ["derivedTitle", "lastMessagePreview"] as const) {
        expect(result.sessions.filter((row) => row[field] !== undefined)).toHaveLength(160);
      }
      const sessionsByKey = new Map(result.sessions.map((session) => [session.key, session]));
      for (const index of [0, 99]) {
        expect(sessionsByKey.get(`agent:main:title-batch-${index}`)).toMatchObject({
          derivedTitle: `Title ${index}`,
          lastMessagePreview: `last ${index}`,
        });
      }

      const withoutTranscriptFields = await list(false);
      expect(withoutTranscriptFields.sessions).toHaveLength(300);
      for (const row of withoutTranscriptFields.sessions) {
        expect([row.derivedTitle, row.lastMessagePreview]).toEqual([undefined, undefined]);
      }
    });
  });
});

function createRowThinkingFixture(runtimeRoute = false) {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider = "row-thinking-fixture";
  const model = { provider, id: "reasoner", name: "Reasoner" };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: { model: `${provider}/reasoner`, thinkingDefault: "off", utilityModel: "" },
    },
  };
  const policy = vi.fn((): ProviderThinkingProfile => ({
    levels: [
      { id: "off", label: "Off", rank: 0 },
      { id: "high", label: "Deep", rank: 10 },
      { id: "low", label: "Light", rank: 40 },
    ],
    defaultLevel: "low",
  }));
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: provider,
    source: "test",
    provider: { id: provider, label: provider, auth: [], resolveThinkingProfile: policy },
  });
  const catalog: ModelCatalogSnapshot = {
    entries: [{ ...model, reasoning: true }],
    routeVariants: runtimeRoute ? [{ ...model, reasoning: true, nativeRuntime: "openclaw" }] : [],
  };
  const wrap = (snapshot: Parameters<typeof createPreparedGatewayModelCatalog>[0]) =>
    new Map([["main", createPreparedGatewayModelCatalog({ ...snapshot, pluginRegistry })]]);
  const prepare = (snapshot: ModelCatalogSnapshot) => {
    prepareModelCatalogThinkingPolicies({
      catalog: snapshot,
      pluginRegistry,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    return wrap(snapshot);
  };
  const modelCatalog = prepare(catalog);
  const rowContext = buildSessionListRowMetadataContext({ now: 1 });
  const entry = (sessionId: string, thinkingLevel: SessionEntry["thinkingLevel"]) => ({
    sessionId,
    updatedAt: 1,
    modelProvider: provider,
    model: "reasoner",
    thinkingLevel,
  });
  const read = (
    thinkingLevel: SessionEntry["thinkingLevel"],
    models: Parameters<typeof rowProjection.readSessionRowInputs>[0]["modelCatalog"],
    index = 0,
  ) =>
    rowProjection.readSessionRowInputs({
      cfg,
      key: `agent:main:thinking-${index}`,
      agentId: "main",
      store: {},
      storePath: "unused",
      entry: entry(`thinking-${index}`, thinkingLevel),
      preparedAcpMeta: {
        backend: "openclaw",
        agent: "fixture",
        runtimeSessionName: `thinking-${index}`,
        mode: "oneshot",
        state: "idle",
        lastActivityAt: 1,
      },
      modelCatalog: models,
      rowContext,
      activeModel: null,
    }).inputs.thinkingProjection;
  return {
    cfg,
    policyCalls: () => policy.mock.calls.length,
    catalog,
    modelCatalog,
    model,
    prepare,
    wrap,
    entry,
    read,
  };
}

test.each(["missing", "identity-only", "runtime-route"] as const)(
  "preserves a stored level with a %s catalog after warming thinking facts",
  async (kind) => {
    await withStateDirEnv("openclaw-row-thinking-incomplete-", async () => {
      const fixture = createRowThinkingFixture(kind === "runtime-route");
      const warmed = fixture.read(
        undefined,
        kind === "missing" ? fixture.catalog.entries : fixture.modelCatalog,
      );
      if (kind === "runtime-route") {
        expect(warmed.catalogEntry?.nativeRuntime).toBe("openclaw");
      }
      const warmCalls = fixture.policyCalls();
      const catalog =
        kind === "missing"
          ? undefined
          : fixture.wrap({
              entries: kind === "identity-only" ? [fixture.model] : [],
            });
      expect(fixture.read("medium", catalog, 1)).toMatchObject({
        thinkingLevel: "medium",
        effectiveThinkingLevel: "medium",
        thinkingDefault: "off",
        thinkingOptions: ["Off", "Deep", "Light", "ultra"],
      });
      expect(fixture.policyCalls()).toBe(warmCalls);
    });
  },
);

test("rebuilds resident thinking facts on config and catalog publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createRowThinkingFixture();
    let cfg = fixture.cfg;
    let catalog = fixture.modelCatalog;
    const key = "agent:main:thinking-publication";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      fixture.entry("thinking-publication", "medium"),
    );
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => catalog,
    });
    using _ = { [Symbol.dispose]: () => projection.dispose() };
    const read = () => projection.snapshot({ agentId: "main", key }).row;
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({ thinkingLevel: "medium", thinkingDefault: "off" });
    const initialCalls = fixture.policyCalls();
    cfg = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, thinkingDefault: "high" } },
    };
    expect(read()?.thinkingDefault).toBe("off");
    sessionChanges.emit({ all: true, scope: "config" });
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({ thinkingLevel: "medium", thinkingDefault: "high" });
    expect(fixture.policyCalls()).toBeGreaterThan(initialCalls);
    const configuredCalls = fixture.policyCalls();
    catalog = fixture.prepare({
      entries: [{ ...fixture.model, reasoning: false }],
      routeVariants: [],
    });
    expect(read()?.thinkingLevel).toBe("medium");
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({
      thinkingLevel: "medium",
      thinkingDefault: "off",
      thinkingOptions: ["off", "ultra"],
    });
    expect(fixture.policyCalls()).toBeGreaterThan(configuredCalls);
  });
});

test.each([
  { search: undefined, recordedModel: true },
  { search: "unmatched-runtime-search", recordedModel: false },
  { search: "list-model", recordedModel: false },
])(
  "reuses prepared metadata across session rows (search=$search, recordedModel=$recordedModel)",
  async ({ search, recordedModel }) => {
    await withStateDirEnv("openclaw-prepared-row-auth-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "example/list-alias", thinkingDefault: "off" },
        },
      };
      const pluginRegistry = prepareRuntime(cfg);
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "list-model-owner",
            modelIdNormalization: {
              providers: { example: { aliases: { "list-alias": "list-model" } } },
            },
          },
        ],
      });
      const catalog = createPreparedGatewayModelCatalog({
        entries: [{ provider: "example", id: "list-model", name: "Synthetic model" }],
        pluginRegistry,
        metadataSnapshot,
      });
      const modelCatalog = new Map([["main", catalog]]);
      const metadata = await import("../plugins/current-plugin-metadata-snapshot.js");
      using lookup = vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot");
      const project = async (count: number) => {
        const store = makeStore(
          count,
          "prepared",
          (index) => ({
            displayName: `Session ${index}`,
            ...(recordedModel ? { modelProvider: "example", model: "list-model" } : {}),
          }),
          (id) => `agent:main:dashboard:${id}`,
        );
        lookup.mockClear();
        const result = await listSessionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
          modelCatalog,
          opts: { limit: count, ...(search ? { search } : {}) },
        });
        expect(result.count).toBe(search === "unmatched-runtime-search" ? 0 : count);
        expect(result.defaults.model).toBe("list-model");
        expect(result.sessions.every((session) => session.model === "list-model")).toBe(true);
        return lookup.mock.calls.length;
      };
      await project(1);
      const small = await project(16);
      const large = await project(128);
      expect(large).toBeLessThanOrEqual(small + 4);
    });
  },
);
