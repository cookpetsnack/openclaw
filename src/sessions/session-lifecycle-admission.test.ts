import { setImmediate as waitForImmediate } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../agents/run-termination.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  admissionTarget as target,
  installAdmissionFixtures,
} from "./session-admission.test-support.js";
import { runWithSessionControllerCleanup } from "./session-controller.cleanup-context.js";
import { cancelSessionEffectHandoff as cancelHandoff } from "./session-controller.lifecycle-observation.js";
import {
  beginSessionEffect as beginAdmission,
  captureSessionWorkRunInterruptions as captureRuns,
  collectSessionControllerTargets,
  getCompetingSessionWorkAdmissionRelease as getCompetingRelease,
  captureSessionControllerSettlement as getRelease,
  observeSessionControllerProtectionReleases,
  captureGatewaySessionControllerWork as captureGateway,
  startSessionControllerInterruption as startInterruption,
  consumeSessionEffectHandoff as consumeHandoff,
  getSessionMutationCount,
  getSessionControllerWorkCount,
  hasOnlySessionMutationKindActive as onlyKindActive,
  interruptSessionControllerEffects as interrupt,
  isCompetingSessionControllerWorkActive as competingActive,
  isSessionMutationActive as mutationActive,
  isSessionControllerWorkActive as workActive,
} from "./session-controller.lifecycle.js";

// Settle test resources before the outer runtime cleanup drains store writers.
describe("session lifecycle admission", () => {
  type Target = ReturnType<typeof target>;
  const { admit, gate, mutate, track } = installAdmissionFixtures();
  function holdMutation(
    owner: Target | { targets: Target[] },
    options: { kind?: "compaction"; prepare?: boolean } = {},
  ) {
    const barrier = gate();
    const mutation = mutate({
      ...owner,
      kind: options.kind,
      run: options.prepare ? async () => {} : barrier.wait,
      ...(options.prepare ? { prepare: barrier.wait } : {}),
    });
    return { started: barrier.entered, release: barrier.release, mutation };
  }
  const childTarget = { scope: "store-a", identities: ["agent:main:child", "session-1"] };

  it("validates default admission once after earlier store writes", async () => {
    const scope = "store-default-validation-order";
    const barrier = gate();
    let value = "before";
    const observations: string[] = [];
    const writer = runExclusiveSessionStoreWrite(scope, async () => {
      await barrier.wait();
      value = "after";
    });
    await barrier.entered;
    const pending = admit({
      scope,
      identities: ["session-default-validation-order"],
      assertAllowed: () => void observations.push(value),
    });
    try {
      await waitForImmediate();
      expect(observations).toEqual([]);
    } finally {
      barrier.release();
      (await pending).release();
      await writer;
    }
    expect(observations).toEqual(["after"]);
  });

  it.each([
    { label: "Error", reason: new Error("cancel queued admission") },
    { label: "primitive", reason: "cancel queued admission" },
  ])(
    "cancels queued writer admission without later validation ($label)",
    async ({ label, reason }) => {
      const scope = `store-cancel-validation-${label}`;
      const identities = ["session-cancel-validation"];
      const barrier = gate();
      const writer = runExclusiveSessionStoreWrite(scope, barrier.wait);
      await barrier.entered;
      const controller = new AbortController();
      const assertAllowed = vi.fn();
      const pending = admit({ scope, identities, signal: controller.signal, assertAllowed });
      const rejected =
        reason instanceof Error
          ? expect(pending).rejects.toBe(reason)
          : expect(pending).rejects.toMatchObject({
              message: "Session effect cancelled",
              cause: reason,
            });
      try {
        await waitForImmediate();
        controller.abort(reason);
        await rejected;
        expect(assertAllowed).not.toHaveBeenCalled();
        expect(workActive(scope, identities)).toBe(false);
      } finally {
        barrier.release();
        await writer;
      }
      expect(assertAllowed).not.toHaveBeenCalled();
    },
  );

  it("joins an admitted validator before releasing cancelled effect custody", async () => {
    const owner = target("store-admitted-validation", "session-admitted-validation");
    const barrier = gate();
    const controller = new AbortController();
    const reason = "cancel admitted validation";
    let completed = false;
    const pending = admit({
      ...owner,
      signal: controller.signal,
      assertAllowed: barrier.wait,
    });
    const outcome = pending.then(
      (ref) => {
        completed = true;
        ref.release();
      },
      (error: unknown) => {
        completed = true;
        return error;
      },
    );
    await barrier.entered;
    controller.abort(reason);
    await waitForImmediate();
    expect(completed).toBe(false);
    expect(workActive(owner.scope, owner.identities)).toBe(true);
    barrier.release();
    await expect(outcome).resolves.toBe(reason);
    expect(workActive(owner.scope, owner.identities)).toBe(false);
  });

  it("atomically hands admitted work across an interrupted RPC boundary", async () => {
    const scope = "store-rpc-handoff";
    const identities = ["agent:main:main", "session-rpc-handoff"];
    const admission = await admit({ scope, identities });
    const handoffId = admission.createHandoff();
    const mutationStarted = createDeferred();
    const run = vi.fn(async () => {});
    const mutation = mutate({
      scope,
      identities,
      prepare: async () => {
        mutationStarted.resolve();
        expect(await interrupt({ scope, identities, timeoutMs: 1_000 })).toBe(true);
      },
      run,
    });
    await mutationStarted.promise;
    const onInterrupt = vi.fn();
    const adopted = consumeHandoff({ handoffId, scope, identities, onInterrupt });

    expect(adopted).toBe(admission);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(cancelHandoff(handoffId)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    adopted?.release();
    admission.release();
    await mutation;
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an admission handoff bound to its original identities", async () => {
    const admission = await admit(
      target("store-bound-handoff", "agent:main:main", "session-bound-handoff"),
    );
    const handoffId = admission.createHandoff();

    expect(
      consumeHandoff({
        handoffId,
        scope: "store-bound-handoff",
        identities: ["agent:main:other", "session-bound-handoff"],
      }),
    ).toBeUndefined();
    expect(cancelHandoff(handoffId)).toBe(true);
    expect(workActive("store-bound-handoff", ["session-bound-handoff"])).toBe(false);
  });

  it("keeps a same-identity mutation queued until finalization completes", async () => {
    const owner = { scope: "store-finalize-order", identities: ["session-finalize-order"] };
    const barrier = gate();
    const secondRun = vi.fn(async () => {});
    const first = mutate({
      ...owner,
      run: async () => {},
      finalize: barrier.wait,
    });
    await barrier.entered;
    const second = mutate({ ...owner, run: secondRun });

    await waitForImmediate();
    expect(secondRun).not.toHaveBeenCalled();
    barrier.release();
    await Promise.all([first, second]);
    expect(secondRun).toHaveBeenCalledOnce();
  });

  it.each(["run", "finalize"] as const)(
    "releases lifecycle state when %s throws",
    async (phase) => {
      const owner = target(`store-${phase}-error`, "session-finalize-error");
      const error = new Error(`lifecycle ${phase} failed`);
      const fail = async () => {
        throw error;
      };
      const finalize = vi.fn(phase === "finalize" ? fail : async () => {});
      await expect(
        mutate({
          ...owner,
          run: phase === "run" ? fail : async () => {},
          finalize,
        }),
      ).rejects.toBe(error);
      expect(finalize).toHaveBeenCalledOnce();
      expect(mutationActive(owner.scope, owner.identities)).toBe(false);
      await expect(mutate({ ...owner, run: async () => "next" })).resolves.toBe("next");
    },
  );

  it("counts a cross-store lifecycle mutation once and fences every target", async () => {
    const held = holdMutation({
      targets: [
        target("store-cross-count-b", "agent:work:main", "session-cross-count-b"),
        target("store-cross-count-a", "agent:main:main", "session-cross-count-a"),
        target("store-cross-count-a", "session-cross-count-a", undefined),
      ],
    });
    await held.started;

    expect(getSessionMutationCount()).toBe(1);
    expect(mutationActive("store-cross-count-a", ["agent:main:main"])).toBe(true);
    expect(mutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(true);
    expect(mutationActive("store-cross-count-b", ["agent:main:main"])).toBe(false);
    held.release();
    await held.mutation;
    expect(getSessionMutationCount()).toBe(0);
    expect(mutationActive("store-cross-count-a", ["session-cross-count-a"])).toBe(false);
    expect(mutationActive("store-cross-count-b", ["session-cross-count-b"])).toBe(false);
  });

  it("serializes opposite-direction cross-store lifecycle mutations", async () => {
    const main = target("store-cross-order-a", "agent:main:main", "session-cross-order-a");
    const work = target("store-cross-order-b", "agent:work:main", "session-cross-order-b");
    let activeMutations = 0;
    let maximumActiveMutations = 0;
    let completedMutations = 0;

    await Promise.all(
      Array.from({ length: 48 }, async (_, index) =>
        mutate({
          targets: index % 2 === 0 ? [main, work] : [work, main],
          run: async () => {
            activeMutations += 1;
            maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
            await Promise.resolve();
            completedMutations += 1;
            activeMutations -= 1;
          },
        }),
      ),
    );

    expect({ completedMutations, maximumActiveMutations, activeMutations }).toEqual({
      completedMutations: 48,
      maximumActiveMutations: 1,
      activeMutations: 0,
    });
    expect(getSessionMutationCount()).toBe(0);
  });

  it("interrupts admitted work in both stores before a cross-store mutation", async () => {
    const main = target("store-cross-interrupt-a", "agent:main:main", "session-cross-interrupt-a");
    const work = target("store-cross-interrupt-b", "agent:work:main", "session-cross-interrupt-b");
    const admitInterruptible = async (owner: Target) => {
      const onInterrupt = vi.fn(() => admission.release());
      const admission = await admit({ ...owner, onInterrupt });
      return { admission, onInterrupt };
    };
    const admissions = await Promise.all([admitInterruptible(main), admitInterruptible(work)]);

    await mutate({
      targets: [work, main],
      prepare: async () => {
        const interrupted = await Promise.all([
          interrupt({ ...main, timeoutMs: 1_000 }),
          interrupt({ ...work, timeoutMs: 1_000 }),
        ]);
        expect(interrupted).toEqual([true, true]);
      },
      run: async () => {
        for (const { onInterrupt } of admissions) {
          expect(onInterrupt).toHaveBeenCalledOnce();
        }
        for (const { scope, identities } of [main, work]) {
          expect(workActive(scope, identities)).toBe(false);
        }
      },
    });
  });

  it("cancels an opposite-direction cross-store mutation before activation", async () => {
    const main = target("store-cross-cancel-a", "agent:main:main", "session-cross-cancel-a");
    const work = target("store-cross-cancel-b", "agent:work:main", "session-cross-cancel-b");
    const held = holdMutation({ targets: [main, work] });
    const first = held.mutation;
    await held.started;

    const controller = new AbortController();
    const abortError = new Error("cancel queued cross-store lifecycle mutation");
    const run = vi.fn(async () => {});
    const cancelled = mutate({ targets: [work, main], signal: controller.signal, run });
    controller.abort(abortError);

    await expect(cancelled).rejects.toBe(abortError);
    held.release();
    await first;
    expect(run).not.toHaveBeenCalled();
    expect(getSessionMutationCount()).toBe(0);
  });

  it("rejects an admission that resumes after suspension closes the async gap", async () => {
    resetGatewayWorkAdmission();
    const owner = target("store-suspend-race", "session-suspend-race", "backing-suspend-race");
    const held = holdMutation(owner);
    await held.started;
    expect(getSessionMutationCount()).toBeGreaterThan(0);

    const admission = admit(owner);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    held.release();
    await held.mutation;
    expect(getSessionMutationCount()).toBe(0);

    await expect(admission).rejects.toMatchObject({ name: "GatewayDrainingError" });
    expect(getSessionControllerWorkCount()).toBe(0);
    suspension?.release();
    resetGatewayWorkAdmission();
  });

  it("lets an admitted root enter session work while suspension preparation refuses new roots", async () => {
    resetGatewayWorkAdmission();
    const continueRoot = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const active = root?.run(async () => {
      await continueRoot.promise;
      (await admit(target("store-admitted-root", "session-admitted-root"))).release();
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});

    try {
      continueRoot.resolve();
      await expect(active).resolves.toBeUndefined();
      await expect(admit(target("store-new-root", "session-new-root"))).rejects.toMatchObject({
        name: "GatewayDrainingError",
      });
    } finally {
      suspension?.rollback();
      root?.release();
      resetGatewayWorkAdmission();
    }
  });

  it.each([false, true])(
    "excludes its own lease during revalidation while retaining competing work (%s)",
    async (hasCompetingWork) => {
      const owner = target("store-revalidation", "agent:main:main", "session-revalidation");
      if (hasCompetingWork) {
        await admit(owner);
      }

      const admission = await admit({
        ...owner,
        revalidateAllowed: async () => {
          await Promise.resolve();
          expect(workActive(owner.scope, owner.identities)).toBe(true);
          expect(competingActive(owner.scope, owner.identities)).toBe(hasCompetingWork);
        },
      });

      expect(competingActive(owner.scope, owner.identities)).toBe(true);
      admission.release();
      expect(workActive(owner.scope, owner.identities)).toBe(hasCompetingWork);
    },
  );

  it("admits an independent session while revalidating a conflicting writer's authority", async () => {
    const scope = "store-keyed-admission";
    const blockedKey = "agent:main:blocked";
    const independentKey = "agent:main:independent";
    const writerBarrier = gate();
    const initialValidation = createDeferred();
    const independentBarrier = gate();
    let allowed = true;
    const validateBlocked = vi.fn(() => {
      if (!allowed) {
        throw new Error("session authority revoked");
      }
    });
    const writer = track(
      runExclusiveSessionStoreWrite(
        scope,
        async () => {
          await writerBarrier.wait();
          allowed = false;
        },
        { identities: [blockedKey] },
      ),
    );
    const blocked = admit({
      scope,
      identities: [blockedKey, "blocked-id"],
      storeWriterIdentities: [blockedKey],
      assertAllowed: () => {
        validateBlocked();
        initialValidation.resolve();
      },
      revalidateAllowed: validateBlocked,
    });
    const blockedOutcome = expect(blocked).rejects.toThrow("session authority revoked");
    await initialValidation.promise;
    const independent = admit({
      scope,
      identities: [independentKey, "independent-id"],
      storeWriterIdentities: [independentKey],
      revalidateAllowed: independentBarrier.wait,
    });

    await independentBarrier.entered;
    expect(validateBlocked).toHaveBeenCalledTimes(1);
    writerBarrier.release();
    await writer;
    await blockedOutcome;
    expect(validateBlocked).toHaveBeenCalledTimes(2);
    expect(workActive(scope, [blockedKey])).toBe(false);
    expect(workActive(scope, [independentKey])).toBe(true);
    independentBarrier.release();
    (await independent).release();
  });

  it("serializes lifecycle mutation and work admission across identity aliases", async () => {
    const held = holdMutation(childTarget);
    const assertAllowed = vi.fn();
    const admission = admit({ ...target("store-a", "session-1"), assertAllowed });

    await held.started;
    expect(assertAllowed).not.toHaveBeenCalled();

    held.release();
    await held.mutation;
    await admission;
    expect(assertAllowed).toHaveBeenCalledOnce();
    expect(workActive("store-a", ["agent:main:child", "session-1"])).toBe(true);
    (await admission).release();
    expect(workActive("store-a", ["session-1"])).toBe(false);
  });

  it("tracks the active lifecycle mutation kind across identity aliases", async () => {
    const held = holdMutation(target("store-kind", "agent:main:child", "session-kind"), {
      kind: "compaction",
    });
    await held.started;

    expect(onlyKindActive("store-kind", ["session-kind"], "compaction")).toBe(true);
    expect(onlyKindActive("store-other", ["session-kind"], "compaction")).toBe(false);

    held.release();
    await held.mutation;
    expect(onlyKindActive("store-kind", ["session-kind"], "compaction")).toBe(false);
  });

  it("keeps identical session keys isolated by store", async () => {
    await admit(target("store-a", "global", "session-a"));

    expect(workActive("store-a", ["global"])).toBe(true);
    expect(workActive("store-b", ["global"])).toBe(false);
    const run = vi.fn(async () => {});
    await mutate({ ...target("store-b", "global"), run });
    expect(run).toHaveBeenCalledOnce();
  });

  it("cancels work admission waiting behind a lifecycle mutation", async () => {
    const held = holdMutation(childTarget, { prepare: true });
    await held.started;

    const controller = new AbortController();
    const abortError = new Error("reset interrupted admission");
    const admission = admit({ ...target("store-a", "session-1"), signal: controller.signal });
    controller.abort(abortError);

    await expect(admission).rejects.toBe(abortError);
    held.release();
    await held.mutation;
  });

  it("preserves the initiating admission across a queued lifecycle mutation", async () => {
    const onInterrupt = vi.fn();
    const admission = await admit({ ...childTarget, onInterrupt });
    const held = holdMutation(childTarget);
    const first = held.mutation;
    await held.started;

    let initiatingAdmissionExcluded = false;
    const queued = admission.run(
      async () =>
        await mutate({
          ...childTarget,
          prepare: async () => {
            initiatingAdmissionExcluded = await interrupt({ ...childTarget, timeoutMs: 1 });
          },
          run: async () => {},
        }),
    );

    try {
      held.release();
      await first;
      await queued;
      expect(initiatingAdmissionExcluded).toBe(true);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      held.release();
      admission.release();
      await Promise.allSettled([first, queued]);
    }
  });

  it("bounds interruption waits for non-cooperative work", async () => {
    await admit({ ...childTarget, onInterrupt: () => {} });

    await expect(interrupt({ ...target("store-a", "session-1"), timeoutMs: 1 })).resolves.toBe(
      false,
    );
  });

  it("shares lifecycle coordination across duplicate module instances", async () => {
    const first = await importFreshModule<typeof import("./session-controller.lifecycle.js")>(
      import.meta.url,
      "./session-controller.lifecycle.js?scope=session-lifecycle-a",
    );
    const second = await importFreshModule<typeof import("./session-controller.lifecycle.js")>(
      import.meta.url,
      "./session-controller.lifecycle.js?scope=session-lifecycle-b",
    );
    let releaseLease = () => {};
    const onInterrupt = vi.fn(() => releaseLease());
    const lease = await first.beginSessionEffect({
      scope: "store-duplicate",
      identities: ["agent:main:child", "session-duplicate"],
      assertAllowed: () => {},
      onInterrupt,
    });
    releaseLease = lease.release;

    try {
      expect(second.isSessionControllerWorkActive("store-duplicate", ["session-duplicate"])).toBe(
        true,
      );
      await expect(
        second.interruptSessionControllerEffects({
          scope: "store-duplicate",
          identities: ["agent:main:child"],
          timeoutMs: 50,
        }),
      ).resolves.toBe(true);
      expect(onInterrupt).toHaveBeenCalledOnce();
      expect(first.isSessionControllerWorkActive("store-duplicate", ["session-duplicate"])).toBe(
        false,
      );
    } finally {
      lease.release();
    }
  });

  function ownedTarget(scope: string, ...identities: string[]) {
    return { ...target(scope, ...identities), owner: Symbol(scope), serializeOwner: true };
  }
  function admissionOutcome(pending: ReturnType<typeof beginAdmission>) {
    return pending.then(
      (lease) => {
        lease.release();
        return "incorrectly admitted";
      },
      (error: unknown) => error,
    );
  }

  it("notifies only the released scope when acquired identity protection shrinks", async () => {
    const scope = "release-observer.sqlite";
    let handoffId = "";
    const listener = vi.fn(() => {
      expect(workActive(scope, ["shared"])).toBe(false);
      expect(consumeHandoff({ handoffId, scope, identities: ["shared"] })).toBeUndefined();
    });
    const otherListener = vi.fn();
    const unsubscribe = observeSessionControllerProtectionReleases(` ${scope} `, listener);
    const unsubscribeOther = observeSessionControllerProtectionReleases(
      "other.sqlite",
      otherListener,
    );
    const first = await beginAdmission({ scope, identities: ["shared"] });
    const second = await beginAdmission({ scope, identities: ["shared"] });
    handoffId = second.createHandoff();
    const unrelated = await beginAdmission({ scope, identities: ["unrelated"] });
    try {
      first.release();
      expect(listener).not.toHaveBeenCalled();
      second.release();
      second.release();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(otherListener).not.toHaveBeenCalled();
      expect(workActive(scope, ["unrelated"])).toBe(true);
      unsubscribe();
      unrelated.release();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      unsubscribeOther();
      first.release();
      second.release();
      unrelated.release();
    }
  });

  it.each(["completed", "cancelled", "cancelled-then-restart", "restart", "timeout"] as const)(
    "uses the adopted run's %s outcome when capturing restart work",
    async (outcome) => {
      const scope = "settling-restart.sqlite";
      const sessionKey = "agent:main:settling";
      const sessionId = "settling-session";
      const identity = target(scope, sessionKey, sessionId);
      const resolveGatewayContext = () => undefined;
      const admission = await admit({
        ...identity,
        resolveGatewayContext,
        isSettling: () => false,
      });
      let settled = false;
      const reason =
        outcome === "restart"
          ? createAgentRunRestartAbortError()
          : outcome.startsWith("cancelled")
            ? createAgentRunDirectAbortError()
            : outcome === "timeout"
              ? Object.assign(new Error("timed out"), { name: "TimeoutError" })
              : undefined;
      const projected = { scope, sessionKey, sessionId };
      const captured = captureGateway(resolveGatewayContext);

      expect(captured.isActive(projected)).toBe(true);
      expect(
        consumeHandoff({
          handoffId: admission.createHandoff(),
          ...identity,
          isSettling: () => settled,
          getAbortReason: () => reason,
        }),
      ).toBe(admission);
      settled = true;
      if (outcome === "cancelled-then-restart") {
        startInterruption({
          ...identity,
          reason: createAgentRunRestartAbortError(),
        });
      }
      const recoverable = !outcome.startsWith("cancelled");
      expect(captured.isActive(projected)).toBe(recoverable);
      expect(captureGateway(resolveGatewayContext).isActive(projected)).toBe(recoverable);
      expect(workActive(scope, [sessionKey, sessionId])).toBe(true);
    },
  );

  it.each(["released", "interrupted", "undeclared", "caller", "wrong receipt"] as const)(
    "targeted run interruption rejects a %s admission",
    async (state) => {
      const owner = { scope: "capture-current.sqlite", identities: ["capture-current-session"] };
      const run = { runId: "captured-run" };
      const onInterrupt = vi.fn(() => ({
        runId: state === "wrong receipt" ? "different-run" : run.runId,
      }));
      const admission = await admit({
        ...owner,
        ...(state === "undeclared" ? {} : { run }),
        onInterrupt,
      });
      const capture = () => captureRuns({ ...owner, accept: () => true });

      const captured = state === "caller" ? await admission.run(async () => capture()) : capture();
      if (state === "undeclared" || state === "caller") {
        expect(captured).toEqual([]);
        expect(onInterrupt).not.toHaveBeenCalled();
        return;
      }
      expect(captured).toHaveLength(1);
      if (state === "released") {
        admission.release();
      } else if (state === "interrupted") {
        startInterruption(owner);
        onInterrupt.mockClear();
      }
      expect(captured[0]!.interrupt(createAgentRunDirectAbortError())).toBe(false);
      expect(onInterrupt).toHaveBeenCalledTimes(state === "wrong receipt" ? 1 : 0);
      const remaining = capture();
      if (state === "interrupted" || state === "wrong receipt") {
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.interrupt(createAgentRunDirectAbortError())).toBe(false);
        const released = vi.fn();
        const completion = remaining[0]!.released.then(released);
        await Promise.resolve();
        expect(released).not.toHaveBeenCalled();
        admission.release();
        await completion;
        expect(released).toHaveBeenCalledOnce();
        expect(capture()).toEqual([]);
      } else {
        expect(remaining).toEqual([]);
      }
    },
  );

  it("serializes pending owners in FIFO order without blocking other owners", async ({
    signal,
  }) => {
    const serialized = {
      ...ownedTarget("serialized.sqlite", "agent:main:serialized", "session"),
      signal,
    };
    const barrier = gate();
    const order: string[] = [];
    const first = admit({
      ...serialized,
      assertAllowed: async () => {
        await barrier.wait();
        order.push("first");
      },
      revalidateAllowed: () => {},
    });
    await withinTest(barrier.entered, signal);
    const follow = (name: string) =>
      admit({
        ...serialized,
        identities: [serialized.identities[1]],
        assertAllowed: () => void order.push(name),
        revalidateAllowed: () => {},
      });
    const followers = [follow("second"), follow("third")] as const;
    const passOtherOwner = async () => {
      (await admit({ ...serialized, owner: Symbol("independent-owner") })).release();
    };

    barrier.release();
    for (const [index, pending] of [first, followers[0]].entries()) {
      const lease = await withinTest(pending, signal);
      await withinTest(passOtherOwner(), signal);
      expect(order).toEqual(["first", "second", "third"].slice(0, index + 1));
      lease.release();
    }
    (await withinTest(followers[1], signal)).release();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps nested work reentrant while independent successors retain FIFO and current authority", async ({
    signal,
  }) => {
    const owner = { ...ownedTarget("nested-owner.sqlite", "nested-owner-session"), signal };
    const outer = await admit(owner);
    const order: string[] = [];
    const follower = admit({
      ...owner,
      assertAllowed: () => {
        order.push("follower");
      },
    });
    let detached: ReturnType<typeof beginAdmission> | undefined;
    let allowed = true;

    await withinTest(
      outer.run(async () => {
        detached = runWithSessionControllerCleanup(() =>
          admit({
            ...owner,
            assertAllowed: () => {
              if (!allowed) {
                throw new Error("successor authority revoked");
              }
              order.push("detached");
            },
          }),
        );
        void detached.catch(() => {});
        const inner = await admit({
          ...owner,
          assertAllowed: () => {
            order.push("nested");
          },
        });
        inner.release();
      }),
      signal,
    );
    expect(outer.isActive()).toBe(true);
    expect(order).toEqual(["nested"]);
    outer.release();
    const next = await withinTest(follower, signal);
    expect(order).toEqual(["nested", "follower"]);
    allowed = false;
    next.release();
    await expect(detached).rejects.toThrow("successor authority revoked");
    expect(order).toEqual(["nested", "follower"]);
  });

  it.for(["caller abort", "Stop", "targeted Stop"])(
    "cancels a pending owner wait on %s before its predecessor releases",
    async (cancellation, { signal }) => {
      const owned = ownedTarget(`cancel-owner-${cancellation}.sqlite`, "cancel-owner-session");
      const { scope, identities } = owned;
      const controller = new AbortController();
      const reason = createAgentRunDirectAbortError();
      const predecessorInterrupt = vi.fn();
      const predecessor = await admit({ ...owned, onInterrupt: predecessorInterrupt });
      const validate = vi.fn();
      const run = { runId: "queued-run" };
      const onInterrupt = vi.fn(() => ({ runId: run.runId }));
      const pending = admissionOutcome(
        admit({
          ...owned,
          ...(cancellation === "targeted Stop"
            ? { run, onInterrupt }
            : { signal: AbortSignal.any([controller.signal, signal]) }),
          assertAllowed: validate,
        }),
      );

      (await admit({ scope, identities, signal })).release();
      if (cancellation === "caller abort") {
        controller.abort(reason);
      } else if (cancellation === "targeted Stop") {
        const captured = captureRuns({ ...owned, accept: () => true });
        expect(captured).toHaveLength(1);
        expect(captured[0]!.interrupt(reason)).toBe(true);
        expect(captured[0]!.interrupt(reason)).toBe(false);
        expect(onInterrupt).toHaveBeenCalledOnce();
      } else {
        await predecessor.run(async () => {
          const interrupted = startInterruption({ scope, identities, reason });
          await withinTest(interrupted.released, signal);
        });
      }
      expect(await withinTest(pending, signal)).toBe(reason);
      expect(validate).not.toHaveBeenCalled();
      expect(predecessorInterrupt).not.toHaveBeenCalled();
      expect(predecessor.isActive()).toBe(true);
    },
  );

  it("rejects arrivals during awaited cleanup and its final microtask, then reopens only after release", async () => {
    const scope = "hostile-await.sqlite";
    const identities: [string, string] = ["agent:main:fence", "fence-session"];
    const barrier = gate();
    const reason = createAgentRunDirectAbortError();
    const onInterrupt = vi.fn();
    let lateResult: unknown;
    const late = () => admissionOutcome(admit({ scope, identities, onInterrupt }));
    const stop = mutate({
      scope,
      identities,
      prepare: async (owner) => {
        owner.closeWorkAdmissions(reason);
        await barrier.wait();
      },
      run: async () => {},
      finalize: async () => {
        await Promise.resolve();
        lateResult = await late();
      },
    });
    await barrier.entered;

    const whileAwaiting = await late();
    expect(whileAwaiting).toBe(reason);
    expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(reason);
    (await admit({ scope, identities: ["other-session"] })).release();
    barrier.release();
    await stop;
    expect(lateResult).toBe(reason);
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    (await admit({ scope, identities, onInterrupt })).release();
    expect(onInterrupt).toHaveBeenCalledTimes(2);
  });

  it("interrupts a preexisting non-chat pending attempt without classifying it as active work", async () => {
    const owner = target("non-chat-pending.sqlite", "agent:main:pending", "pending-session");
    const { scope, identities } = owner;
    const resolveGatewayContext = () => undefined;
    const barrier = gate();
    const interrupted = vi.fn();
    const validate = vi.fn();
    const blocker = mutate({ ...owner, prepare: barrier.wait, run: async () => {} });
    await barrier.entered;
    const pending = admissionOutcome(
      admit({
        ...owner,
        onInterrupt: interrupted,
        resolveGatewayContext,
        assertAllowed: validate,
      }),
    );

    expect(workActive(scope, identities)).toBe(false);
    expect(
      captureGateway(resolveGatewayContext).isActive({
        scope,
        sessionKey: identities[0],
        sessionId: identities[1],
      }),
    ).toBe(false);
    expect(competingActive(scope, identities)).toBe(false);
    expect(getRelease({ scope, identities })).toBeUndefined();
    const competingRelease = getCompetingRelease({ scope, identities });
    expect(competingRelease).toBeDefined();
    expect(collectSessionControllerTargets().get(scope)).toBeUndefined();
    expect(getSessionControllerWorkCount()).toBe(0);
    const reason = createAgentRunDirectAbortError();
    expect(await interrupt({ scope, identities, reason, timeoutMs: 1000 })).toBe(true);
    expect(await pending).toBe(reason);
    await expect(competingRelease).resolves.toBeUndefined();
    expect(interrupted).toHaveBeenCalledExactlyOnceWith(reason);
    expect(validate).not.toHaveBeenCalled();
    barrier.release();
    await blocker;
  });

  it.each(["compaction", "single-use iterator"] as const)(
    "%s queues work behind the exact lifecycle fence without deadlocking release queries",
    async (mode) => {
      const owner = target(`${mode}.sqlite`, `${mode}-session`);
      const { scope, identities } = owner;
      const barrier = gate();
      const validate = vi.fn();
      const mutation = mutate({
        ...owner,
        ...(mode === "compaction" ? { kind: "compaction" as const } : {}),
        prepare: async () => {
          await barrier.wait();
          if (mode === "compaction") {
            await getRelease(owner);
          }
        },
        run: async () => {},
      });
      await barrier.entered;
      const admission = admit({
        scope,
        identities: mode === "compaction" ? identities : identities.values(),
        assertAllowed: validate,
      });

      if (mode === "single-use iterator") {
        (await admit({ scope, identities: ["unrelated-generator"] })).release();
      }
      expect(validate).not.toHaveBeenCalled();
      barrier.release();
      await mutation;
      (await admission).release();
      expect(validate).toHaveBeenCalledOnce();
    },
  );

  it("an initial validator finishing after pending cancellation cannot enter the writer", async () => {
    const owner = target("initial-validator.sqlite", "initial-validator-session");
    const barrier = gate();
    const writer = vi.fn();
    const released = vi.fn();
    const unsubscribe = observeSessionControllerProtectionReleases(owner.scope, released);
    const reason = createAgentRunDirectAbortError();
    const pending = admissionOutcome(
      admit({ ...owner, assertAllowed: barrier.wait, revalidateAllowed: writer }),
    );
    await barrier.entered;
    try {
      const interruption = startInterruption({ ...owner, reason });
      const drained = vi.fn();
      void interruption.released.then(drained);
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      expect(released).not.toHaveBeenCalled();
      barrier.release();
      expect(await pending).toBe(reason);
      await interruption.released;
      // Cancellation retains validator custody without acquiring identity protection.
      await mutate({ ...owner, run: async () => {} });
      expect(writer).not.toHaveBeenCalled();
      expect(released).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      barrier.release();
      await pending;
    }
  });
});
