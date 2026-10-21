/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";
import { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";
import { sessionClient } from "./session-gateway-client.test-support.ts";

const notes = { key: "agent:ops:notes", sessionId: "notes-generation-1", label: "Notes" };

it("preserves stale wire responses without consuming sequences or replacing canonical identity", async ({
  connect,
}) => {
  const stale = { ...notes, sessionId: "retired-generation", pinned: false };
  const firstList = { sessions: [stale], offset: 10 };
  const lastList = { sessions: [], offset: 20 };
  const transcript = { messages: [], sessionId: "retired-transcript", sessionInfo: stale };
  const connection = await connect({
    sessions: [notes],
    methodResponses: {
      "sessions.list": { sequence: [firstList, lastList] },
      "chat.history": {
        cases: [{ match: { sessionKey: notes.key, offset: 10 }, response: transcript }],
      },
    },
  });
  const client = sessionClient(connection, notes.key);
  const { controls, send, response } = client;
  expect((await client.transcript("chat.history")).sessionId).toBe(notes.sessionId);
  expect((await client.transcript()).sessionId).toBe(notes.sessionId);
  expect(await client.payload("sessions.list")).toMatchObject(firstList);
  expect(await client.payload("sessions.list")).toEqual(lastList);
  expect(await client.payload("sessions.list")).toEqual(lastList);
  expect(await client.transcript("chat.history", { offset: 10 })).toEqual(transcript);
  controls.deferNext("chat.startup");
  const id = await send("chat.startup", { sessionKey: notes.key });
  controls.resolveDeferred("chat.startup", transcript);
  expect(response(id)?.payload).toEqual(transcript);
  controls.setMethodResponse("chat.history", transcript);
  expect(await client.transcript("chat.history")).toEqual(transcript);
  expect(await client.transcript()).toMatchObject(transcript);
  expect(await client.session()).toMatchObject(notes);
});

it("does not commit rejected patches or unresolved deferrals", async ({ connect }) => {
  const client = sessionClient(await connect({ sessionKey: notes.key }), notes.key);
  const { send, response, controls } = client;
  controls.setMethodResponse("sessions.patch", {
    __mockError: { code: "INVALID_REQUEST", message: "rejected" },
  });
  expect(await client.patch({ pinned: true })).toMatchObject({ ok: false });
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.setMethodResponse("sessions.patch", { ok: true });
  controls.deferNext("sessions.patch");
  const pending = await send("sessions.patch", { key: notes.key, pinned: true });
  expect(response(pending)).toBeUndefined();
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.rejectDeferred("sessions.patch");
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.deferNext("sessions.patch");
  await send("sessions.patch", { key: notes.key, pinned: true });
  controls.resolveDeferred("sessions.patch", { ok: true });
  expect(await client.rows()).toMatchObject([{ pinned: true, pinnedAt: expect.any(Number) }]);
  const beforeStalePatch = await client.rows();
  expect(
    await client.patch({ expectedSessionId: "retired-generation", label: "Wrong generation" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(await client.rows()).toEqual(beforeStalePatch);
  const replacement = { ...notes, sessionId: "replacement-generation", label: "Replacement label" };
  controls.setSessionsListResponse({ sessions: [{ ...notes, sessionId: replacement.sessionId }] });
  expect(
    await client.patch({ expectedSessionId: replacement.sessionId, label: replacement.label }),
  ).toMatchObject({ ok: true });
  expect(await client.rows()).toMatchObject([replacement]);
  for (const method of ["sessions.describe", "chat.history", "chat.startup"]) {
    const params = method === "sessions.describe" ? { key: notes.key } : { sessionKey: notes.key };
    expect(await client.payload(method, params)).toMatchObject(
      method === "sessions.describe"
        ? { session: { sessionId: replacement.sessionId } }
        : { sessionId: replacement.sessionId },
    );
  }
});

it("replays later commits onto an injected list without adopting its stale generation", async ({
  connect,
}) => {
  const client = sessionClient(await connect({ sessions: [notes] }), notes.key);
  const { controls } = client;
  await client.patch({ archived: true });
  const stale = { ...notes, archived: false, sessionId: "retired-generation" };
  controls.setMethodResponse("sessions.list", { sessions: [stale] });
  expect(await client.rows()).toMatchObject([{ ...stale, archived: true }]);
  expect(
    await client.patch({ expectedSessionId: stale.sessionId, label: "Wrong generation" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  await client.patch({ label: "Renamed" });
  expect(await client.rows()).toMatchObject([{ ...stale, archived: true, label: "Renamed" }]);
  expect(await client.session()).toMatchObject({
    sessionId: notes.sessionId,
    archived: true,
    label: "Renamed",
  });
});

it("replaces canonical rows and membership without retaining omitted fields", async ({
  connect,
}) => {
  const omitted = { key: "agent:ops:omitted", sessionId: "omitted-generation" };
  const scenario = { sessions: [notes, omitted] };
  const initial = sessionClient(await connect(scenario), notes.key);
  await initial.patch({ color: "purple", label: "Patched" });
  await initial.request("sessions.create", {
    key: "agent:ops:materialized",
    label: "Materialized",
  });
  const replacement = { key: notes.key, sessionId: notes.sessionId, label: "Exact replacement" };

  initial.controls.setSessionsListResponse({ sessions: [replacement] });

  const assertReplacement = async (client: ReturnType<typeof sessionClient>) => {
    const list = await client.payload("sessions.list");
    expect(list).toMatchObject({
      count: 1,
      defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
      path: "",
      ts: expect.any(Number),
    });
    expect(list.sessions).toEqual([{ ...replacement, snapshotAt: expect.any(Number) }]);
    expect(await client.session()).toEqual({ ...replacement, snapshotAt: expect.any(Number) });
    for (const method of ["chat.history", "chat.startup"]) {
      expect(await client.transcript(method)).toMatchObject({
        sessionId: notes.sessionId,
        sessionInfo: replacement,
      });
    }
    for (const key of [omitted.key, "agent:ops:materialized"]) {
      expect((await client.payload("sessions.describe", { key })).session).toBeNull();
      expect(await client.payload("chat.startup", { sessionKey: key })).not.toHaveProperty(
        "sessionInfo",
      );
    }
  };
  await assertReplacement(initial);

  await assertReplacement(sessionClient(await connect(scenario), notes.key));
});

it.for(
  ["chat.history", "chat.startup"].flatMap((method) =>
    ["transcript", "scenario"].map((source) => ({ method, source })),
  ),
)(
  "does not replay a stopped $source Workboard run through $method",
  async ({ method, source }, { connect }) => {
    const seed = buildWorkboardMocks(1_800_000_000_000, { id: "operator", label: "Operator" });
    const key = "agent:main:workboard-onboarding";
    const transcripts: NonNullable<ControlUiMockGatewayScenario["sessionTranscripts"]> =
      seed.cardSessionHistories;
    const history = expectDefined(transcripts[key], "onboarding history");
    const runId = "workboard-onboarding-run";
    const preview = expectDefined(history.inFlightRun, "onboarding run preview");
    const connection = await connect({
      sessions: seed.cardSessions,
      sessionTranscripts:
        source === "transcript" ? transcripts : { [key]: { messages: history.messages } },
      ...(source === "scenario" ? { inFlightRun: preview } : {}),
    });
    const client = sessionClient(connection, key);
    expect((await client.transcript(method)).inFlightRun).toMatchObject({
      runId,
      text: "Checking first-task navigation and recovery after a validation error…",
    });
    expect(await client.abort({ runId })).toEqual({ aborted: true, runIds: [runId] });
    const reopened = await client.transcript(method);
    expect(reopened).toMatchObject({
      inFlightRun: null,
      sessionInfo: { key, status: "killed", hasActiveRun: false, activeRunIds: [] },
    });
    expect(reopened.messages).toEqual(history.messages);
  },
);

const runFacts = (status: string, activeRunIds: string[] = []) => ({
  status,
  activeRunIds,
  hasActiveRun: activeRunIds.length > 0,
});
const abortedRuns = (runIds: string[]) => ({ aborted: runIds.length > 0, runIds });

it.for(["sessions.create", "sessions.catalog.continue"])(
  "retains a terminal event before the %s acknowledgment",
  async (method, { connect }) => {
    const key = "agent:main:created-before-ack";
    const runId = "created-run";
    const connection = await connect({
      deferredMethods: [method],
      methodResponses: { [method]: { key, runStarted: true, runId } },
    });
    const client = sessionClient(connection, key);
    await client.send(method, { message: "Prepare workspace" });
    client.emitChat(runId, "error", "Workspace preparation failed");
    await client.resolve(method);
    expect(await client.session()).toMatchObject({
      key,
      ...runFacts("failed"),
      lastRunError: "Workspace preparation failed",
    });
  },
);

it("commits targeted and session-wide aborts without replacing session edits or other runs", async ({
  connect,
}) => {
  const active = {
    key: "agent:main:workboard-onboarding",
    ...runFacts("running", ["run-a", "run-b"]),
    label: "Onboarding",
  };
  const other = {
    key: "agent:main:other",
    ...runFacts("running", ["other-run"]),
    label: "Other",
  };
  const connection = await connect({
    sessions: [active, other],
    methodResponses: { "sessions.list": { sessions: [active, other] } },
  });
  const client = sessionClient(connection, active.key);
  await client.patch({ label: "Renamed onboarding" });
  await client.request("sessions.patch", { key: other.key, pinned: true });
  expect(await client.abort({ runId: "unknown-run" })).toMatchObject(abortedRuns([]));
  expect(await client.abort({ runId: "run-a" })).toMatchObject(abortedRuns(["run-a"]));
  const expectRows = async (...rows: Record<string, unknown>[]) => {
    expect(await client.rows()).toEqual(
      expect.arrayContaining(rows.map((row) => expect.objectContaining(row))),
    );
  };
  await expectRows({ ...active, label: "Renamed onboarding", activeRunIds: ["run-b"] });
  expect(await client.abort()).toMatchObject(abortedRuns(["run-b"]));
  await expectRows(
    {
      ...active,
      label: "Renamed onboarding",
      ...runFacts("killed"),
      abortedLastRun: true,
    },
    { ...other, pinned: true },
  );
  expect(client.chatEvents()).toEqual([
    expect.objectContaining({ sessionKey: active.key, runId: "run-a", state: "aborted" }),
    expect.objectContaining({ sessionKey: active.key, runId: "run-b", state: "aborted" }),
  ]);
  expect(client.frames.filter((frame) => frame.event === "sessions.changed")).toHaveLength(2);
});

it.for(["direct", "descendant", "targeted"] as const)(
  "settles %s activity for every later read after a session-only abort",
  async (activity, { connect }) => {
    const active = {
      key: "agent:main:main",
      updatedAt: 1_000,
      status: activity === "descendant" ? "done" : "running",
      hasActiveRun: activity !== "descendant",
      hasActiveSubagentRun: activity !== "direct",
      ...(activity === "targeted"
        ? { activeRunIds: ["run-a", "run-b"] }
        : activity === "direct"
          ? { activeRunIds: ["cached-run"] }
          : {}),
    };
    const other = { key: "agent:main:other", status: "running", hasActiveRun: true };
    const connection = await connect({
      sessionKey: active.key,
      sessions: [active, other],
      sessionInfo: active,
      methodResponses: {
        "sessions.abort":
          activity === "targeted"
            ? { ok: true, abortedRunId: "run-a", status: "aborted" }
            : { ok: true, abortedRunId: null, status: "no-active-run" },
      },
    });
    const client = sessionClient(connection, active.key);
    if (activity === "targeted") {
      await client.request("sessions.abort", { key: active.key, runId: "run-a" });
      expect(await client.session()).toMatchObject({
        ...runFacts("running", ["run-b"]),
        hasActiveSubagentRun: true,
      });
    }
    await client.request("sessions.abort", { key: active.key, clearQueued: true });
    // Read-time rows must not republish pre-Stop activity or timestamps.
    const settled = {
      key: active.key,
      ...runFacts(activity === "targeted" ? "killed" : "done"),
      hasActiveSubagentRun: false,
      updatedAt: expect.toSatisfy((value: number) => value > active.updatedAt),
    };
    expect(await client.session()).toMatchObject(settled);
    for (const method of ["chat.history", "chat.startup"]) {
      expect((await client.transcript(method)).sessionInfo).toMatchObject(settled);
    }
    expect(await client.rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining(settled),
        expect.objectContaining({ key: other.key, status: "running", hasActiveRun: true }),
      ]),
    );
  },
);

it("registers a started send for targeted abort without cancelling another run or reviving a replayed ACK", async ({
  connect,
}) => {
  const key = "agent:main:send-abort";
  const active = { key, ...runFacts("running", ["other-run"]) };
  const connection = await connect({
    sessions: [active],
    methodResponses: {
      "chat.send": { runId: "new-run", status: "started" },
      "sessions.list": { sessions: [active] },
    },
  });
  const client = sessionClient(connection, key);
  const params = { sessionKey: key, message: "Start another run", idempotencyKey: "new-run" };
  expect(await client.payload("chat.send", params)).toMatchObject({
    runId: "new-run",
    status: "started",
  });
  expect(await client.rows()).toMatchObject([
    { activeRunIds: ["other-run", "new-run"], hasActiveRun: true },
  ]);
  expect(await client.abort({ runId: "new-run" })).toEqual(abortedRuns(["new-run"]));
  await client.request("chat.send", params);
  expect(await client.rows()).toMatchObject([
    { activeRunIds: ["other-run"], hasActiveRun: true, status: "running" },
  ]);
  expect(client.chatEvents()).toEqual([
    expect.objectContaining({ sessionKey: key, runId: "new-run", state: "aborted" }),
  ]);
});

it.for([
  { event: "final", outcome: "done", otherRun: false, newerEvent: null },
  { event: "error", outcome: "failed", otherRun: false, newerEvent: null },
  { event: "aborted", outcome: "killed", otherRun: false, newerEvent: null },
  { event: "final", outcome: "done", otherRun: true, newerEvent: null },
  { event: "error", outcome: "failed", otherRun: true, newerEvent: null },
  { event: "aborted", outcome: "killed", otherRun: true, newerEvent: null },
  { event: "error", outcome: "done", otherRun: true, newerEvent: "final" },
  { event: "error", outcome: "failed", otherRun: true, newerEvent: "error" },
  { event: "error", outcome: "killed", otherRun: true, newerEvent: "aborted" },
  { event: "error", outcome: "killed", otherRun: true, newerEvent: "abort receipt" },
])(
  "retains $event before a started ACK (other run: $otherRun, newer event: $newerEvent)",
  async ({ event, outcome, otherRun, newerEvent }, { connect }) => {
    const key = "agent:main:fast-completion";
    const diagnostic = "Provider request failed: session store unavailable. Retry after recovery.";
    const initial = {
      key,
      ...runFacts(otherRun ? "running" : "queued", otherRun ? ["other-run"] : []),
    };
    const connection = await connect({
      sessions: [initial],
      deferredMethods: ["chat.send"],
      methodResponses: { "chat.send": { runId: "fast-run", status: "started" } },
    });
    const client = sessionClient(connection, key);
    const { controls, response } = client;
    const id = await client.sendChat("fast-run", "Complete quickly");
    expect(response(id)).toBeUndefined();
    client.emitChat("fast-run", event, event === "error" ? diagnostic : undefined);
    expect(await client.rows()).toMatchObject([initial]);
    let newerCompletion: unknown;
    if (newerEvent) {
      if (newerEvent === "abort receipt") {
        await client.abort({ runId: "other-run" });
      } else {
        client.emitChat(
          "other-run",
          newerEvent,
          newerEvent === "error" ? "Later run failed" : undefined,
        );
      }
      newerCompletion = (await client.transcript()).sessionInfo;
      expect(newerCompletion).toMatchObject({
        ...runFacts(outcome),
        abortedLastRun: outcome === "killed",
      });
      if (newerEvent === "error") {
        expect(newerCompletion).toHaveProperty("lastRunError", "Later run failed");
      } else {
        expect(newerCompletion).not.toHaveProperty("lastRunError");
      }
      expect(response(id)).toBeUndefined();
    }
    await client.resolve("chat.send");
    expect(response(id)?.payload).toMatchObject({ runId: "fast-run", status: "started" });
    if (newerEvent) {
      expect(await client.rows()).toEqual([newerCompletion]);
      return;
    }
    expect(await client.rows()).toMatchObject([
      {
        key,
        ...runFacts(otherRun ? "running" : outcome, otherRun ? ["other-run"] : []),
        abortedLastRun: !otherRun && outcome === "killed",
        ...(!otherRun && outcome === "failed" ? { lastRunError: diagnostic } : {}),
      },
    ]);
    if (!otherRun && outcome === "failed") {
      await client.patch({ unread: false });
      expect((await client.transcript()).sessionInfo).toMatchObject({
        status: "failed",
        lastRunError: diagnostic,
      });
    }
    expect(await client.abort({ runId: "fast-run" })).toEqual(abortedRuns([]));
    // A replayed ACK must not overwrite a newer outcome on the same session.
    if (otherRun) {
      client.emitChat("other-run", "error");
    }
    const beforeReplay = await client.rows();
    if (otherRun) {
      expect(beforeReplay).toMatchObject([runFacts("failed")]);
    }
    controls.deferNext("chat.send");
    await client.sendChat("fast-run", "Complete quickly");
    await client.resolve("chat.send");
    expect(await client.rows()).toEqual(beforeReplay);
    if (!otherRun && outcome === "failed") {
      controls.setMethodResponse("chat.send", { runId: "next-run", status: "started" });
      controls.deferNext("chat.send");
      await client.sendChat("next-run", "Complete quickly");
      await client.resolve("chat.send");
      const next = (await client.transcript()).sessionInfo;
      expect(next).toMatchObject({ status: "running", activeRunIds: ["next-run"] });
      expect(next).not.toHaveProperty("lastRunError");
      client.emitChat("next-run", "final");
      const completed = (await client.transcript()).sessionInfo;
      expect(completed).toMatchObject({ status: "done", activeRunIds: [] });
      expect(completed).not.toHaveProperty("lastRunError");
    }
  },
);

it.for([
  { targeted: true, outcome: "success" },
  { targeted: false, outcome: "success" },
  { targeted: true, outcome: "not-aborted" },
  { targeted: false, outcome: "not-aborted" },
  { targeted: true, outcome: "error" },
  { targeted: false, outcome: "error" },
])(
  "preserves $outcome abort before send ACK (targeted: $targeted)",
  async ({ targeted, outcome }, { connect }) => {
    const key = "agent:main:abort-before-ack";
    const runId = "pending-run";
    const aborted = outcome === "success";
    const connection = await connect({
      sessions: [{ key, ...runFacts("queued") }],
      deferredMethods: ["chat.send"],
      methodResponses: {
        "chat.send": { runId, status: "started" },
        "chat.abort":
          outcome === "error"
            ? { __mockError: { code: "INVALID_REQUEST", message: "Abort rejected" } }
            : abortedRuns(aborted ? [runId] : []),
      },
    });
    const client = sessionClient(connection, key);
    await client.sendChat(runId);
    const result = await client.request("chat.abort", {
      sessionKey: key,
      ...(targeted ? { runId } : {}),
    });
    if (outcome === "error") {
      expect(result.ok).toBe(false);
    } else {
      expect(result.payload).toEqual(abortedRuns(aborted ? [runId] : []));
    }
    await client.resolve("chat.send");
    expect(await client.rows()).toMatchObject([
      {
        key,
        ...runFacts(aborted ? "killed" : "running", aborted ? [] : [runId]),
      },
    ]);
    expect(client.chatEvents()).toEqual(
      aborted ? [expect.objectContaining({ sessionKey: key, runId, state: "aborted" })] : [],
    );
  },
);

const parentKey = "agent:main:parent";
const row = (name: string, fields: Partial<ControlUiSessionFixture> = {}) => ({
  key: `agent:main:${name}`,
  ...fields,
});

it("excludes a running parent from child queries", async ({ connect }) => {
  const parent = row("main", { sessionId: "parent-session" });
  const rows = [parent, row("unrelated", { sessionId: "unrelated-session" })];
  const { request } = await connect({ sessionKey: parent.key, sessions: rows });
  await request("chat.send", {
    sessionKey: parent.key,
    message: "Start the parent turn",
    idempotencyKey: "parent-run",
  });

  expect((await request("sessions.list", { spawnedBy: parent.key })).payload).toMatchObject({
    count: 0,
    sessions: [],
  });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ ...parent, status: "running", hasActiveRun: true }),
    expect.objectContaining(rows[1]!),
  ]);
});

it("uses current child ownership before archive partitioning", async ({ connect }) => {
  const rows = [
    row("parent", { spawnedBy: parentKey }),
    row("spawned", { spawnedBy: parentKey }),
    row("navigation", { parentSessionKey: parentKey }),
    row("controlled", { spawnedBy: "agent:main:old-owner", controlOwnerSessionKey: parentKey }),
    row("archived-child", { spawnedBy: parentKey, archived: true }),
    row("moved", { spawnedBy: parentKey, controlOwnerSessionKey: "agent:main:other" }),
    row("unrelated"),
  ];
  const [, spawned, navigation, controlled, archived] = rows;
  const { request } = await connect({
    sessionKey: parentKey,
    sessionArchiveFiltering: true,
    methodResponses: { "sessions.list": { sessions: rows, count: rows.length } },
  });
  for (const [filter, expected] of [
    [false, [spawned, navigation, controlled]],
    [true, [archived]],
    ["all", [spawned, navigation, controlled, archived]],
  ] as const) {
    expect(
      (await request("sessions.list", { spawnedBy: ` ${parentKey} `, archived: filter })).payload,
    ).toMatchObject({
      count: expected.length,
      sessions: expected.map((entry) => expect.objectContaining(entry)),
    });
  }
  expect((await request("sessions.list", { archived: "all" })).payload.count).toBe(rows.length);
});

it.for(["empty", "materialized", "scoped"])(
  "preserves child pagination for a %s fixture",
  async (kind, { connect }) => {
    const child = row("child", {
      sessionId: "session:agent:main:child",
      spawnedBy: parentKey,
      archived: false,
      pinned: false,
    });
    const scoped = kind === "scoped";
    const page = {
      sessions: scoped ? [child] : [{ key: parentKey }],
      count: 1,
      totalCount: scoped ? 200 : 1,
      offset: 0,
      hasMore: scoped,
      nextOffset: scoped ? 1 : null,
    };
    const { request, controls } = await connect({ methodResponses: { "sessions.list": page } });
    const children =
      kind === "materialized" ? ["agent:main:child-one", "agent:main:child-two"] : [];
    for (const key of children) {
      controls.setMethodResponse("sessions.create", { key, entry: { spawnedBy: parentKey } });
      await request("sessions.create", {});
    }

    const result = (
      await request("sessions.list", { spawnedBy: parentKey, ...(scoped ? { limit: 1 } : {}) })
    ).payload;
    if (scoped) {
      expect(result).toEqual({ ...page, sessions: [{ ...child, snapshotAt: expect.any(Number) }] });
    } else {
      expect(result).toMatchObject({
        count: children.length,
        totalCount: children.length,
        hasMore: false,
        nextOffset: null,
      });
      expect(result.sessions).toEqual(children.map((key) => expect.objectContaining({ key })));
    }
  },
);
