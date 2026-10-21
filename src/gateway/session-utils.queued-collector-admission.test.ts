import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve fixture mocks before importing their consumers.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createDeferred,
  awaitGateBeforeSettlement,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import * as registryMemory from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import * as subagentRegistry from "../agents/subagents/registry/subagent-registry.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import {
  closeSwarmScheduler,
  activateSwarmRun,
  holdQueuedSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  isRpcSourceExecuting,
  requestRpcSourceCancellation,
  getRpcSourceIdentity,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";
import { handleGatewayRequest } from "./server-methods.js";
import { agentRunHandler } from "./server-methods/agent-run-handler.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionDeleteHandlers } from "./server-methods/sessions-delete.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

const {
  requestContext,
  requestOptions,
  spawnCollector,
  expectChanged,
  gateRowPreparation,
  createQueuedReservation,
  launchedRunIds,
} = useQueuedCollectorFixture();

it.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "joins real preaccept cleanup independently of display preparation (exact=%s, publicationFailure=%s)",
  async (exact, publicationFailure) => {
    const context = requestContext();
    const entered = createDeferred();
    const dispatched = createDeferred();
    const killWriteEntered = createDeferred();
    const releaseKillWrite = createDeferred();
    const cleanupWaiting = createDeferred();
    const order: string[] = [];
    let nativeRunId: string | undefined;
    let stopping: Promise<void> | undefined;
    const agentResponse = vi.fn();
    const registration = vi.spyOn(subagentRegistry, "startQueuedSubagentRun");
    const waitForPublication = registryMemory.waitForSubagentRetirementPublication;
    const publicationWait = vi
      .spyOn(registryMemory, "waitForSubagentRetirementPublication")
      .mockImplementation((entry) => {
        const pending = waitForPublication(entry);
        if (entry.runId === nativeRunId && pending) {
          cleanupWaiting.resolve();
        }
        return pending;
      });
    let holdNotices = false;
    const markTerminated = subagentRegistry.markSubagentRunTerminated;
    const killGate = vi
      .spyOn(subagentRegistry, "markSubagentRunTerminated")
      .mockImplementation(async (params) => {
        if (params.runId === nativeRunId) {
          holdNotices = true;
          killWriteEntered.resolve();
          await releaseKillWrite.promise;
        }
        return markTerminated(params);
      });
    const displayGate = gateRowPreparation(
      context,
      () => holdNotices,
      publicationFailure ? new Error("publication preparation failed") : undefined,
    );
    const runtimeGate = vi
      .spyOn(preparedModelRuntime, "loadPublishedGatewayReplyDispatchRuntime")
      .mockImplementation(async ({ abortSignal }) => {
        const signal = expectDefined(abortSignal, "native admission abort signal");
        signal.throwIfAborted();
        entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error("Native admission aborted"));
            },
            { once: true },
          );
        });
      });
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
      ) => {
        const respond = method === "agent" ? agentResponse : vi.fn();
        const request = {
          req: { type: "req" as const, id: "native-preaccept", method },
          params,
          respond,
          context,
          sessionMutationCommitGuard: options?.sessionMutationCommitGuard,
          client: createSyntheticPluginRuntimeClient({
            agentRunTracking: options?.agentRunTracking,
            scopes: options?.syntheticScopes,
          }),
          isWebchatConnect: () => false,
        };
        if (method === "agent") {
          nativeRunId = String(params.idempotencyKey);
          try {
            await agentRunHandler!(request);
          } finally {
            dispatched.resolve();
          }
        } else if (method === "chat.abort") {
          await handleChatAbortRequest(request);
        } else if (method === "sessions.delete") {
          order.push("deleting");
          await expectDefined(sessionDeleteHandlers["sessions.delete"], "delete handler")(request);
          order.push("deleted");
        } else {
          throw new Error(`Unexpected native cleanup method ${method}`);
        }
        const [ok, payload, error] = respond.mock.calls[0] ?? [];
        return unwrapGatewayMethodDispatchResponse(method, { ok, payload, error }) as T;
      },
    });
    try {
      const spawned = await spawnCollector("Pending native collector");
      expect(spawned.status).toBe("accepted");
      await awaitGateBeforeSettlement(
        entered.promise,
        dispatched.promise,
        "Native admission ended before runtime gate",
      );
      const entry = expectDefined(registryMemory.subagentRuns.get(spawned.runId!), "collector");
      const admission = expectDefined(rpcSourceTesting.get(entry.runId), "controller");
      expect(admission.adapter.kind).toBe("agent");
      expect(isRpcSourceExecuting(admission)).toBe(false);
      expect(getAgentRunContext(entry.runId)).toBeDefined();
      expect(isSubagentRunQueued(entry)).toBe(true);
      const target = expectDefined(admission.input.target, "native physical session target");
      const visibleStatus = () =>
        resolveVisibleActiveSessionRunState({
          storePath: target.storeScope,
          agentId: target.agentId,
          sessionId: target.incarnation,
          requestedKey: entry.childSessionKey,
          canonicalKey: entry.childSessionKey,
          resolveGatewayContext: context.resolveGatewayContext,
        }).status;
      expect(visibleStatus()).toBeUndefined();
      const releaseCapacityWait = registerAgentRunCapacityWait(
        entry.runId,
        getAgentRunLifecycleGeneration(),
      );
      try {
        expect(visibleStatus()).toBe("queued");
      } finally {
        releaseCapacityWait?.();
      }
      expect(entry.execution.startedAt).toBeUndefined();
      const options = requestOptions(context, "sessions.abort", {
        key: entry.childSessionKey,
        ...(exact ? { runId: entry.runId } : { clearQueued: true }),
      });
      const { respond } = options;
      stopping = Promise.resolve(sessionAbortHandlers["sessions.abort"]!(options));
      await awaitGateBeforeSettlement(
        Promise.all([dispatched.promise, killWriteEntered.promise, cleanupWaiting.promise]),
        stopping,
        "Stop settled before its kill write",
      );
      expect(order).toEqual([]);
      expect(registration).toHaveBeenCalledOnce();
      await expect(registration.mock.results[0]?.value).resolves.toBe(false);
      const sessionEntry = async () =>
        (await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey)).entry;
      expect(await sessionEntry()).toBeDefined();
      const interrupted = expectDefined(
        registryMemory.getCurrentSubagentRunOwner(registryMemory.subagentRuns, entry),
        "collector before publication",
      );
      expect(interrupted.execution.startedAt).toBeUndefined();
      releaseKillWrite.resolve();
      await stopping;
      await dispatched.promise;
      // This unadopted launch still owns its provisional session; join its real cleanup.
      await closeSwarmScheduler();
      const stopped = expectDefined(
        registryMemory.getCurrentSubagentRunOwner(registryMemory.subagentRuns, entry),
        "collector after cleanup",
      );
      expect(stopped.collectorCompletion?.status).toBe("killed");
      expect(respond).toHaveBeenCalledOnce();
      expect
        .soft(respond.mock.calls[0]?.slice(0, 2), JSON.stringify(respond.mock.calls[0]?.[2]))
        .toEqual([true, { ok: true, status: "aborted", abortedRunId: entry.runId }]);
      expect.soft(context.chatRunState.hasAbortMarker(entry.runId)).toBe(true);
      expect.soft(admission.adapter.abortStopReason).toBe("rpc");
      expect.soft(entry.execution.startedAt).toBeUndefined();
      expect.soft(entry.sessionStartedAt).toBeUndefined();
      expect(rpcSourceTesting.has(entry.runId)).toBe(false);
      expect(order).toContain("deleted");
      expect(await sessionEntry()).toBeUndefined();
      await displayGate.entered.promise;
      expectChanged(context, { reason: "delete" });
      expect(context.broadcastToConnIds).not.toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: entry.childSessionKey, reason: "abort" }),
        expect.anything(),
        expect.anything(),
      );
      displayGate.release.resolve();
      await flushPendingSessionsChangedEvents(context);
      expectChanged(
        context,
        publicationFailure
          ? { reason: "update" }
          : { sessionKey: entry.childSessionKey, reason: "abort" },
      );
    } finally {
      releaseKillWrite.resolve();
      displayGate.release.resolve();
      if (nativeRunId) {
        const source = rpcSourceTesting.get(nativeRunId);
        if (source) {
          requestRpcSourceCancellation(source);
        }
        await dispatched.promise;
        clearAgentRunContext(nativeRunId);
      }
      await stopping;
      await flushPendingSessionsChangedEvents(context);
      for (const spy of [killGate, displayGate.spy, runtimeGate, registration, publicationWait]) {
        spy.mockRestore();
      }
    }
  },
);

async function reserve(name: string, profile: string) {
  const client = roleClient("view", profile);
  client.connId = "parent-requester";
  client.connect.scopes = ["operator.sessions.write"];
  setRuntimeConfigSnapshot({ ...getRuntimeConfig(), ...rolePolicyConfig() });
  const { entry } = await createQueuedReservation(name, {
    actor: { type: "human", source: "profile", id: client.authenticatedUserProfile!.profileId },
  });
  const loaded = await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey);
  return { client, entry, loaded };
}

function abort(client: ReturnType<typeof roleClient>, key: string, context = requestContext()) {
  const options = requestOptions(context, "sessions.abort", { key });
  const done = handleGatewayRequest({
    ...options,
    req: { ...options.req, params: options.params },
    client,
    extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
  });
  return { respond: options.respond, done };
}

it.each(["active", "queued", "pending-chat"] as const)(
  "narrow collector Stop preserves a same-key prior-incarnation %s producer",
  async (kind) => {
    const { client, entry, loaded } = await reserve("reserved", "collector-stop-owner");
    const childSession = expectDefined(loaded.entry, "collector session");
    expect(childSession.createdActor).toEqual({
      type: "human",
      source: "profile",
      id: client.authenticatedUserProfile!.profileId,
    });
    const descendant =
      kind === "queued"
        ? await createQueuedReservation(
            "nested-reserved",
            undefined,
            entry.childSessionKey,
            entry.runId,
          )
        : undefined;
    const descendantSession = descendant
      ? await loadGatewaySessionEntryReadOnlyAsync(descendant.entry.childSessionKey)
      : undefined;
    const source = (
      runId: string,
      sessionId: string,
      sessionKey = expectDefined(descendant, "descendant").entry.childSessionKey,
      storeScope = expectDefined(descendantSession, "descendant session").storePath,
      phase: "waiting" | "preparing" = "waiting",
    ) =>
      createRpcSourceForTest(
        { requester: { connectionId: client.connId } },
        { runId, sessionId, phase, agentId: "main", storeScope, sessionKey },
      );
    const descendantSource = descendant
      ? source("prior-descendant-input", "previous-descendant-session")
      : undefined;
    const descendantOwnedSource = descendant
      ? source(
          "owned-descendant-input",
          expectDefined(descendantSession?.entry, "descendant session").sessionId,
        )
      : undefined;
    const context = requestContext();
    const oldRunId = "prior-incarnation-input";
    const old = source(
      oldRunId,
      "previous-child-session",
      entry.childSessionKey,
      loaded.storePath,
      kind === "queued" ? "waiting" : "preparing",
    );
    if (kind === "active") {
      await claimRpcSourceForTest(old);
      rpcSourceTesting.set(oldRunId, old);
      context.chatRunState.getOrCreate(oldRunId).buffer = "untouched old partial";
    } else if (kind === "queued") {
      rpcSourceTesting.set(oldRunId, old);
    } else {
      context.dedupe.set(`${kind}:${oldRunId}`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: oldRunId,
          status: "accepted",
          ownerConnId: client.connId,
          agentId: "main",
          sessionKey: entry.childSessionKey,
          sessionId: getRpcSourceIdentity(old).sessionId,
        },
      });
    }
    const originalPending = context.dedupe.get(`${kind}:${oldRunId}`);
    const { respond, done } = abort(client, entry.childSessionKey, context);
    await done;
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
    ]);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(getCurrentSubagentRunOwner(subagentRuns, entry)).toMatchObject({
      collectorCompletion: { status: "killed" },
    });
    expect(old.input.abortSignal.aborted).toBe(false);
    if (descendant && descendantSource) {
      expect(getCurrentSubagentRunOwner(subagentRuns, descendant.entry)).toMatchObject({
        collectorCompletion: { status: "killed" },
      });
      expect(descendantSource.input.abortSignal.aborted).toBe(false);
      expect(descendantOwnedSource?.input.abortSignal.aborted).toBe(true);
      await descendantOwnedSource?.input.settlement.promise;
    }

    if (kind === "active") {
      expect(context.chatRunState.resolveBuffer(oldRunId, { final: true }).text).toBe(
        "untouched old partial",
      );
    }
    if (kind !== "pending-chat") {
      expect(rpcSourceTesting.get(oldRunId)).toBe(old);
    } else {
      expect(context.dedupe.get(`${kind}:${oldRunId}`)).toBe(originalPending);
    }
    expect(launchedRunIds).toEqual([]);
  },
);

it("narrow collector Stop joins owned raw effects without interrupting or waiting for foreign effects", async () => {
  const { client, entry, loaded } = await reserve("effect-reserved", "collector-effect-owner");
  const sessionId = expectDefined(loaded.entry, "collector session").sessionId;
  const target = captureSessionTarget({
    storeScope: loaded.storePath,
    sessionKey: entry.childSessionKey,
    incarnation: sessionId,
  });
  const priorTarget = captureSessionTarget({ ...target, incarnation: "prior-incarnation" });
  const validationEntered = createDeferred();
  const validationFinish = createDeferred();
  const interrupted = createDeferred();
  const rawFinish = createDeferred();
  const priorInterrupted = vi.fn();
  const foreignInterrupted = vi.fn();
  const prior = beginSessionEffect({
    target: priorTarget,
    onInterrupt: priorInterrupted,
    assertAllowed: async () => {
      validationEntered.resolve();
      await validationFinish.promise;
    },
    // Hold preparation outside the writer needed by the current incarnation's effect.
    revalidateAllowed: () => {},
  });
  await validationEntered.promise;
  const foreign = await beginSessionEffect({
    target: captureSessionTarget({ ...target, storeScope: loaded.storePath + ".foreign" }),
    assertAllowed: () => {},
    onInterrupt: foreignInterrupted,
  });
  const foreignOperation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId,
    resetTriggered: false,
    target: foreign.target,
  });
  const foreignAbort = vi.fn();
  const foreignNative = createEmbeddedRunHandle({
    runId: "foreign-store-run",
    abort: foreignAbort,
  });
  attachActiveEmbeddedRun(
    sessionId,
    foreignNative,
    target.sessionKey,
    undefined,
    undefined,
    foreignOperation,
  );
  const own = await beginSessionEffect({
    target,
    assertAllowed: () => {},
    onInterrupt: () => {
      own.release();
      interrupted.resolve();
      return { runId: entry.runId };
    },
  });
  const raw = own.run(async () => {
    await rawFinish.promise;
  });
  const { respond, done: stop } = abort(client, entry.childSessionKey);
  try {
    await interrupted.promise;
    expect(respond).not.toHaveBeenCalled();
    expect(priorInterrupted).not.toHaveBeenCalled();
    expect(foreignInterrupted).not.toHaveBeenCalled();
    rawFinish.resolve();
    await raw;
    await stop;
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
    ]);
    expect(priorInterrupted).not.toHaveBeenCalled();
    expect(foreign.isActive()).toBe(true);
    expect(foreignAbort).not.toHaveBeenCalled();
    expect(foreignOperation.abortSignal.aborted).toBe(false);
    expect(getCurrentSubagentRunOwner(subagentRuns, entry)).toMatchObject({
      collectorCompletion: { status: "killed" },
    });
  } finally {
    rawFinish.resolve();
    validationFinish.resolve();
    // Cleanup also settles the validator when a regression interrupted it.
    const priorEffect = await prior.catch(() => undefined);
    priorEffect?.release();
    detachActiveEmbeddedRun(sessionId, foreignNative, target.sessionKey);
    foreignOperation.complete();
    foreign.release();
    own.release();
    await Promise.all([raw, stop]);
  }
});

it.for(["settled", "rejected", "session replaced"] as const)(
  "qualifies queued cancellation only after owned cleanup: %s",
  async (transition, { signal }) => {
    const { entry } = await createQueuedReservation("settled-publication");
    const producer = expectDefined(holdQueuedSwarmRun(entry.runId), "preparation hold");
    const context = requestContext();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const failure = new Error("owned queued cleanup failed");
    const publications = () =>
      vi
        .mocked(context.broadcastToConnIds)
        .mock.calls.filter(([event]) => event === "sessions.changed")
        .map(([, payload]) => payload);
    let cleanupSettled = false;
    const start = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      if (transition === "rejected") {
        throw failure;
      }
      cleanupSettled = true;
    });
    const respond = vi.fn();
    let stopping: Promise<void> | undefined;
    try {
      activateSwarmRun({
        groupId: expectDefined(entry.groupId, "queued collector group"),
        runId: entry.runId,
        start,
        onStartFailure: () => true,
        onRemoved: cleanup,
      });
      stopping = Promise.resolve(
        sessionAbortHandlers["sessions.abort"]!({
          ...requestOptions(context, "sessions.abort", {
            key: entry.childSessionKey,
            runId: entry.runId,
            agentId: "main",
          }),
          respond,
        }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          cleanupEntered.promise,
          stopping,
          "Stop returned before owned cleanup",
        ),
        signal,
      );
      // Current-row notices may arrive later; terminal qualification must await cleanup.
      expect(publications()).not.toContainEqual(
        expect.objectContaining({ lastRunId: entry.runId }),
      );
      expect(cleanupSettled).toBe(false);
      expect(
        (await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey)).entry?.lastRunId,
      ).toBeUndefined();
      expect(respond).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();

      if (transition === "session replaced") {
        const selected = await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey);
        await replaceSessionEntry(
          { storePath: selected.storePath, sessionKey: entry.childSessionKey },
          {
            ...expectDefined(selected.entry, "selected session"),
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-lifecycle",
            lastRunId: "replacement-terminal",
            status: "done",
            abortedLastRun: false,
          },
        );
      }
      releaseCleanup.resolve();
      await withinTest(stopping, signal);
      await flushPendingSessionsChangedEvents(context);

      const stored = expectDefined(
        (await loadGatewaySessionEntryReadOnlyAsync(entry.childSessionKey)).entry,
        "terminal session",
      );
      const stopped = expectDefined(
        getCurrentSubagentRunOwner(subagentRuns, entry),
        "cancelled collector owner",
      );
      expect(stopped.execution.startedAt).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledOnce();
      if (transition === "settled") {
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(stored).toMatchObject({
          status: "killed",
          lastRunId: entry.runId,
          abortedLastRun: true,
        });
        expectChanged(context, {
          sessionKey: entry.childSessionKey,
          reason: "abort",
          status: "killed",
          hasActiveRun: false,
          lastRunId: entry.runId,
        });
      } else {
        expect(respond.mock.calls[0]?.[0]).toBe(false);
        expect(publications()).not.toContainEqual(
          expect.objectContaining({ lastRunId: entry.runId }),
        );
        expect(stored.lastRunId).toBe(
          transition === "session replaced" ? "replacement-terminal" : undefined,
        );
        if (transition === "rejected") {
          expect(respond.mock.calls[0]?.[2]).toMatchObject({
            message: expect.stringContaining(failure.message),
          });
          await expect(closeSwarmScheduler()).rejects.toMatchObject({ errors: [failure] });
        } else {
          expect(stored).toMatchObject({
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-lifecycle",
            status: "done",
          });
        }
      }
      expect(stored.startedAt).toBeUndefined();
      expect(stored.runtimeMs).toBeUndefined();
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([stopping]);
      await producer.release();
      await closeSwarmScheduler().catch(() => {});
      await flushPendingSessionsChangedEvents(context);
    }
  },
);
