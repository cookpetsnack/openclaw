// Register the shared Git transport before any publication or run-lease consumer.
// oxfmt-ignore
import {
  BRANCH,
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  commands,
  createRealPublicationWorkspace,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../state/github-personal-publication-lifecycle.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.worker.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserGitHubConnectionAsync } from "../state/user-github-connections.js";
import { readPersonalGitHubPublicationInDatabase } from "./github-personal-publication-store.worker.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  createForeignPublicationSession,
  readPersonalPublicationFixtureStatus,
  personalPublicationAccount as account,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import { readLocalGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";

const mocks = githubPublicationTestMocks();

function holdReceiptDeletion(afterPreparation?: () => Promise<void>) {
  const waiting = createDeferredCore();
  const release = createDeferredCore();
  const runOperation = stateWorker.runOpenClawStateWorkerOperation;
  const holdReceipt = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(runOperation, {
      apply(
        target,
        receiver,
        [workerContext, operation, options]: Parameters<typeof runOperation>,
      ) {
        return Reflect.apply(target, receiver, [
          workerContext,
          (scope: Parameters<typeof operation>[0]) =>
            operation({
              execute: new Proxy(scope.execute, {
                async apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                  if (args[0].type === "githubPublication.deleteSessionReceipts") {
                    waiting.resolve();
                    await release.promise;
                  }
                  const result = await Reflect.apply(execute, executeReceiver, args);
                  if (args[0].type === "githubPublication.prepareSessionReceiptDeletion") {
                    await afterPreparation?.();
                  }
                  return result;
                },
              }),
            }),
          options,
        ]);
      },
    }),
  );
  return { waiting, release, restore: () => holdReceipt.mockRestore() };
}

async function waitForReceiptDeletion(waiting: Promise<void>, deletion: Promise<unknown>) {
  await Promise.race([
    waiting,
    deletion.then((outcome) => {
      throw new Error("Session deletion settled before receipt cleanup reached its worker", {
        cause: outcome,
      });
    }),
  ]);
}

describe("personal publication outcomes and session lifecycle", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(
      { client: fixture.client, context: fixture.context, coordinator: fixture.coordinator },
      method,
      params,
    );

  const readReceipt = (requestId: string) =>
    readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, fixture.owner, {
      requestId,
    });
  const readLifecycle = (requestId: string) =>
    readGitHubPublicationSessionLifecycle(
      { publicationKind: "personal", requestId },
      openOpenClawStateDatabase().db,
    );

  async function publishReceipt() {
    const { client, context, coordinator } = fixture;
    const session = await persistPublicationTestSession();
    const action = await preparePersonalPublicationFixtureAction({ client, context });
    const published = await coordinator.requestPersonalForSessionV2(request(), action);
    const receipt = readReceipt(published.requestId);
    expect(receipt?.status).toBe("published");
    const binding = published.requestId;
    return {
      session,
      published,
      receipt,
      binding,
      lifecycle: readLifecycle(binding),
    };
  }

  it("revokes captured publication authority after committed receipt cleanup", async () => {
    const { session, receipt } = await publishReceipt();
    const owner = await readLocalGitHubPublicationWorktreeOwner(receipt!);
    try {
      expect(() => owner.assertCurrent()).not.toThrow();
      const remove = await preparePersonalGitHubSessionReceiptDeletion({
        agentId: receipt!.agent_id,
        generations: [
          {
            sessionKey: receipt!.session_key,
            sessionId: receipt!.session_id,
            lifecycleRevision: session.read().lifecycleRevision ?? null,
          },
        ],
      });
      await remove();
      expect(session.read().sessionId).toBe(receipt!.session_id);
      expect(() => owner.assertCurrent()).toThrow(
        "GitHub publication lifecycle authority is unavailable; retry recovery.",
      );
    } finally {
      owner.release();
    }
  });

  it("preserves repository receipts when a session is recreated before receipt deletion admission", async () => {
    const { session, published, receipt, binding, lifecycle } = await publishReceipt();
    const repositories = getSessionRepositoryWorkspaceStore();
    const workspace = await repositories.create({
      agentId: "main",
      sessionKey: SESSION_KEY,
      url: "https://github.com/example/receipt-guard.git",
      requestedRef: "main",
      assertCurrent: () => {},
    });
    const original = session.read();
    const { waiting, release, restore } = holdReceiptDeletion();
    const deletion = applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: session.storePath,
      removals: [{ sessionKey: SESSION_KEY, expectedEntry: original }],
      skipMaintenance: true,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await waitForReceiptDeletion(waiting.promise, deletion);
      expect(session.read()).toBeUndefined();
      expect(readReceipt(published.requestId)).toEqual(receipt);
      const successor = {
        ...original,
        sessionId: "receipt-guard-successor",
        lifecycleRevision: "receipt-guard-successor-generation",
        updatedAt: Date.now(),
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: session.storePath, sessionKey: SESSION_KEY },
        successor,
      );
      release.resolve();
      expect(await deletion).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Repository workspace session changed before deletion"),
        }),
      });
      expect(session.read()).toMatchObject(successor);
      expect(await repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(readReceipt(published.requestId)).toEqual(receipt);
      expect(readLifecycle(binding)).toEqual(lifecycle);
    } finally {
      release.resolve();
      await deletion;
      restore();
    }
  });

  it("preserves receipts and repository ownership when an owner write crosses the native receipt grant", async () => {
    const { session, published, receipt, binding, lifecycle } = await publishReceipt();
    expect(lifecycle).toBeDefined();
    const repositories = getSessionRepositoryWorkspaceStore();
    const workspace = await repositories.create({
      agentId: "main",
      sessionKey: SESSION_KEY,
      url: "https://github.com/example/receipt-grant.git",
      assertCurrent: () => {},
    });
    const original = session.read();
    const successor = {
      ...original,
      sessionId: "receipt-successor",
      lifecycleRevision: "receipt-successor-generation",
      updatedAt: Date.now(),
    };
    // Admit the competing agent writer before receipt cleanup locks the shared-state database.
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(session.storePath, { agentId: "main" }).path,
    });
    let injected = false;
    let receiptAdmitted = false;
    let nativeAbsent = false;
    // A competing writer must not inherit the guarded reader's artifact-preserving context.
    const inWriterContext = AsyncLocalStorage.snapshot();
    const held = holdReceiptDeletion();
    const admission = probe.admission(operationAdmission, (nativeRequest, grant, admit) => {
      const facts = nativeRequest.facts;
      if (
        !injected &&
        receiptAdmitted &&
        nativeRequest.stage === "commit" &&
        (facts === undefined ||
          (isRecord(facts) &&
            facts.kind === "session-entry-current" &&
            facts.domainFacts === undefined &&
            isRecord(facts.source) &&
            facts.source.sessionKey === SESSION_KEY))
      ) {
        nativeAbsent = isRecord(facts) && facts.entry === undefined;
        admit(nativeRequest, () => {
          inWriterContext(() => {
            expect(readExactSessionEntryRow(database, SESSION_KEY)).toBeUndefined();
            runSqliteImmediateTransactionSync(database.db, () =>
              writeSessionEntry(database, SESSION_KEY, successor),
            );
          });
          injected = true;
          return grant();
        });
        return;
      }
      admit(nativeRequest, grant);
    });
    const deletion = applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: session.storePath,
      removals: [{ sessionKey: SESSION_KEY, expectedEntry: original }],
      skipMaintenance: true,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await waitForReceiptDeletion(held.waiting.promise, deletion);
      receiptAdmitted = true;
      held.release.resolve();
      const outcome = await deletion;
      expect(injected, String(outcome.error)).toBe(true);
      expect(session.read()).toEqual(successor);
      expect(await repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(readReceipt(published.requestId)).toEqual(receipt);
      expect(readLifecycle(binding)).toEqual(lifecycle);
      expect(nativeAbsent).toBe(true);
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining(
          "Session currency changed while awaiting its native grant",
        ),
      });
    } finally {
      held.release.resolve();
      await deletion;
      held.restore();
      admission.mockRestore();
    }
  });

  it("preserves a same-key successor receipt while direct deletion removes historical receipts", async () => {
    const { client, context, coordinator, placements } = fixture;
    const {
      session,
      published: historical,
      receipt: oldReceipt,
      binding: oldBinding,
      lifecycle: oldLifecycle,
    } = await publishReceipt();
    await session.reset(placements);
    const original = session.read();
    expect(readReceipt(historical.requestId)).toEqual(oldReceipt);
    expect(oldLifecycle?.lifecycle_revision).not.toBe(original.lifecycleRevision);
    expect(
      await getSessionRepositoryWorkspaceStore().find({ agentId: "main", sessionKey: SESSION_KEY }),
    ).toBeUndefined();

    const lateReceipt = createDeferredCore<string>();
    const { waiting, release, restore } = holdReceiptDeletion(async () => {
      expect(session.read()).toEqual(original);
      const lateAction = await preparePersonalPublicationFixtureAction({ client, context });
      const late = await coordinator.requestPersonalForSessionV2(
        { ...request(), idempotencyKey: "direct-receipt-late-original" },
        lateAction,
      );
      expect(late.requestId).not.toBe(historical.requestId);
      expect(readReceipt(late.requestId)).toMatchObject({
        status: "published",
        session_id: original.sessionId,
      });
      expect(readLifecycle(late.requestId)?.lifecycle_revision).toBe(original.lifecycleRevision);
      lateReceipt.resolve(late.requestId);
    });
    const deletion = deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: session.storePath,
      target: { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] },
      expectedSessionId: original.sessionId,
      archiveTranscript: false,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await waitForReceiptDeletion(waiting.promise, deletion);
      const lateRequestId = await lateReceipt.promise;
      expect(session.read()).toBeUndefined();
      const successor = {
        ...original,
        lifecycleRevision: "direct-receipt-successor-generation",
        updatedAt: Date.now(),
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: session.storePath, sessionKey: SESSION_KEY },
        successor,
      );
      const successorAction = await preparePersonalPublicationFixtureAction({ client, context });
      const published = await coordinator.requestPersonalForSessionV2(
        { ...request(), idempotencyKey: "direct-receipt-successor" },
        successorAction,
      );
      expect(published.requestId).not.toBe(historical.requestId);
      const receipt = readReceipt(published.requestId);
      const binding = published.requestId;
      const lifecycle = readLifecycle(binding);
      expect(receipt).toMatchObject({ status: "published", session_id: successor.sessionId });
      expect(lifecycle?.lifecycle_revision).toBe(successor.lifecycleRevision);
      release.resolve();
      const outcome = await deletion;
      expect(outcome).toMatchObject({ ok: true, value: { deleted: true } });
      expect(readReceipt(published.requestId)).toEqual(receipt);
      expect(readLifecycle(binding)).toEqual(lifecycle);
      expect(session.read()).toMatchObject(successor);
      expect(readReceipt(historical.requestId)).toBeUndefined();
      expect(readLifecycle(oldBinding)).toBeUndefined();
      expect(readReceipt(lateRequestId)).toBeUndefined();
      expect(readLifecycle(lateRequestId)).toBeUndefined();
    } finally {
      release.resolve();
      await deletion;
      restore();
    }
  });

  it("retains logical-session receipts across archive and reset, then removes them through permanent deletion", async () => {
    const { owner, generation, placements } = fixture;
    const installed = new Map<string, unknown>();
    onTestFinished(
      githubPublicationReceipts.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const [key, fact] of change.receipt.facts) {
            installed.set(key, fact);
          }
        }
      }),
    );
    const {
      session,
      published: result,
      receipt,
      binding,
      lifecycle: originalLifecycle,
    } = await publishReceipt();
    const { title: _title, body: _body, next_action: _nextAction, ...authority } = receipt!;
    expect(installed.get(JSON.stringify(["personal", result.requestId]))).toEqual({
      kind: "postimage",
      value: authority,
    });
    expect(installed.get(JSON.stringify(["personal-lifecycle", result.requestId]))).toEqual({
      kind: "postimage",
      value: { ...originalLifecycle, publication_kind: "personal", request_id: result.requestId },
    });
    const lifecycle_revision = session.read().lifecycleRevision;
    expect(originalLifecycle).toEqual({ lifecycle_revision, requester_authority_json: null });
    await session.reset(placements);
    expect(readReceipt(result.requestId)).toEqual(receipt);
    expect(
      (
        await rpc("sessions.github.status", {
          requestId: result.requestId,
          sessionKey: SESSION_KEY,
        })
      )[1],
    ).toMatchObject({ result: { status: "published" }, confirmation: null });
    const storePath = session.storePath;
    await patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY, storePath }, () => ({
      archivedAt: Date.now(),
    }));
    const target = { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] };
    expect(readReceipt(result.requestId)).toEqual(receipt);
    expect(readLifecycle(binding)).toEqual(originalLifecycle);
    const lostReply = probe.command(stateWorker, async (command, options, scope) => {
      const outcome = await scope.execute(command, options);
      if (command.type === "githubPublication.deleteSessionReceipts") {
        throw new Error("committed receipt cleanup reply lost");
      }
      return outcome;
    });
    await expect(
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target,
        archiveTranscript: false,
      }),
    ).rejects.toThrow("committed receipt cleanup reply lost");
    lostReply.mockRestore();
    expect(readReceipt(result.requestId)).toBeUndefined();
    expect(readLifecycle(binding)).toBeUndefined();
    expect(installed.get(JSON.stringify(["personal", result.requestId]))).toEqual({
      kind: "absent",
    });
    expect(installed.get(JSON.stringify(["personal-lifecycle", result.requestId]))).toEqual({
      kind: "absent",
    });
    expect((await readUserGitHubConnectionAsync(owner))?.generation).toBe(generation);
  });

  const status = (requestId: string) => readPersonalPublicationFixtureStatus(fixture, requestId);
  const read = (requestId?: string) =>
    readPersonalGitHubPublicationInDatabase(
      openOpenClawStateDatabase().db,
      fixture.owner,
      requestId
        ? { requestId }
        : { sessionId: SESSION_ID, idempotencyKey: request().idempotencyKey },
    );
  const pull = (
    headSha: string,
    overrides: { url?: string; userId?: number; state?: string; body?: string } = {},
  ) => ({
    url: "https://github.com/openclaw/openclaw/pull/125200",
    userId: account.accountId,
    state: "open",
    body: "",
    headSha,
    headRef: BRANCH,
    baseRef: "main",
    ...overrides,
  });
  it.each([
    ["connection closes", false],
    ["permission ends during readback", true],
  ] as const)(
    "retains an accepted open PR response after the requesting %s",
    async (_boundary, readback) => {
      const workspace = await createRealPublicationWorkspace();
      const transport = mocks.runCommand.getMockImplementation()!;
      let created = false;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        let response = await transport(argv, options);
        const creating = argv.includes("POST") && argv.includes("repos/openclaw/openclaw/pulls");
        if (creating) {
          created = true;
          if (readback) {
            return commandResult("", 1);
          }
        }
        if (readback && created && argv.includes("state=all")) {
          response = commandResult(
            JSON.stringify([pull(await workspace.git("rev-parse", "HEAD"))]),
          );
        }
        if (creating || (readback && created && argv.includes("state=all"))) {
          if (readback) {
            fixture.client.connect.scopes = ["operator.read"];
          } else {
            fixture.runtime.live = false;
          }
        }
        return response;
      });

      const published = await fixture.coordinator.requestPersonalForSessionV2(
        request(),
        fixture.action,
      );

      expect(published).toMatchObject({
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      expect(read(published.requestId)).toMatchObject({
        status: "published",
        pull_request_url: "https://github.com/openclaw/openclaw/pull/125200",
      });
      await fixture.coordinator.resumeSessionRequests();
      expect(workspace.effects).toEqual(["push", "pull_request"]);
    },
  );

  it("does not resume shared GitHub writes after the RPC request loses write permission", async () => {
    fixture.client.internal = {
      ...fixture.client.internal,
      operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(fixture.owner, fixture.config),
    };
    const workspace = await createRealPublicationWorkspace();
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const response = await transport(argv, options);
      if (argv[0] === "git" && argv.includes("push")) {
        await createForeignPublicationSession(fixture.otherOwner);
      }
      return response;
    });
    const idempotencyKey = "shared-rpc-revoked-after-push";
    const response = await rpc("sessions.github.publish", {
      sessionKey: SESSION_KEY,
      idempotencyKey,
      selection: {
        source: "shared",
        expected: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
      },
    });
    expect(response[0]).toBe(false);
    await fixture.coordinator.resumeSessionRequests();
    expect(workspace.effects).toEqual(["push"]);
    const receipt = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
      sessionId: SESSION_ID,
      idempotencyKey,
    });
    expect(receipt).toMatchObject({
      status: "failed",
      head_commit: await workspace.git("rev-parse", "HEAD"),
      pull_request_url: null,
    });
  });

  it.each([
    "no-changes",
    "foreign-after-create",
    "revoked-after-create",
    "unavailable-after-create",
  ] as const)(
    "preserves the original request outcome for %s observation after an earlier effect",
    async (outcome) => {
      const { generation, client } = fixture;
      const foreign = outcome.startsWith("foreign");
      const revoked = outcome.startsWith("revoked");
      const afterCreate = outcome.endsWith("after-create");
      const unavailable = outcome === "unavailable-after-create";
      const workspace = await createRealPublicationWorkspace("push");
      const initial = (await rpc("sessions.github.publish", request()))[1];
      expect(initial.status).toBe("needs_confirmation");
      const pending = await status(initial.requestId);
      const confirm = {
        sessionKey: SESSION_KEY,
        requestId: initial.requestId,
        generation,
        account,
        requestDigest: pending.confirmation!.requestDigest,
      };
      const headSha = await workspace.git("rev-parse", "HEAD");
      const marker = `<!-- openclaw-publication:${initial.requestId} -->`;
      const url = "https://github.com/openclaw/openclaw/pull/125203";
      const dispatched = { kind: "pull_request", status: "dispatched", headCommit: headSha };
      const remote = mocks.runCommand.getMockImplementation()!;
      let created = false;
      let lookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (
          outcome === "no-changes" &&
          argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: headSha }));
        }
        if (argv.includes("POST")) {
          expect(JSON.parse(options?.input ?? "{}").body).toContain(marker);
          await remote(argv, options);
          created = true;
          return commandResult("", 1);
        }
        if (argv.includes("state=all")) {
          if (afterCreate && !created) {
            return commandResult("[]");
          }
          if (outcome === "unavailable-after-create") {
            return commandResult("", 1);
          }
          lookups += 1;
          if (revoked && lookups === 1) {
            client.connect.scopes = ["operator.read"];
          }
          return commandResult(
            JSON.stringify([
              pull(headSha, {
                url,
                userId: foreign ? 202 : account.accountId,
                state: foreign ? "open" : "closed",
                body: marker,
              }),
            ]),
          );
        }
        return await remote(argv, options);
      });
      const confirmed = await rpc("sessions.github.confirm", confirm);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
      if (unavailable) {
        expect(confirmed[0]).toBe(true);
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          requestId: initial.requestId,
          publisher: initial.publisher,
          effect: dispatched,
        });
        expect((await status(initial.requestId)).confirmation).toEqual(pending.confirmation);
        return;
      }
      if (revoked) {
        expect(confirmed[0]).toBe(false);
        expect(read(initial.requestId)).toMatchObject({
          status: "needs_confirmation",
          last_effect: "pull_request",
          effect_state: "observed",
          pull_request_url: url,
        });
        return;
      }
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      expect(confirmed[1]).toMatchObject({
        requestId: initial.requestId,
        status: "failed",
        publisher: initial.publisher,
        code: outcome === "no-changes" ? "no_changes" : "github_rejected",
        effect: afterCreate ? dispatched : initial.effect,
        nextAction: expect.stringContaining(outcome === "no-changes" ? "change" : "permission"),
      });
      expect(await status(initial.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("sessions.github.publish", request()))[1]).toEqual(confirmed[1]);
      expect((await rpc("sessions.github.confirm", confirm))[1]).toEqual(confirmed[1]);
      expect(workspace.effects).toEqual(afterCreate ? ["push", "pull_request"] : ["push"]);
      mocks.runCommand.mockImplementation(remote);
      const fresh = await rpc("sessions.github.publish", {
        ...request(),
        idempotencyKey: "fresh-reviewed-outcome",
      });
      expect(fresh[0], JSON.stringify(fresh[2])).toBe(true);
      expect(fresh[1].status, JSON.stringify(fresh[1])).toBe("published");
      expect(fresh[1].requestId).not.toBe(initial.requestId);
    },
  );

  it("stops offering a pending confirmation once the session is archived", async () => {
    const { client, context, coordinator, generation } = fixture;
    await persistPublicationTestSession();
    const prepared = await preparePersonalPublicationFixtureAction({ client, context });
    const interruption = new Error("Publication claim preparation interrupted.");
    let preparedSources = 0;
    // Interrupt claim preparation after the request commits, preserving its receipt.
    const stopped = {
      ...prepared,
      prepareSource: (selector: Parameters<typeof prepared.prepareSource>[0]) => {
        if (++preparedSources === 2) {
          throw interruption;
        }
        return prepared.prepareSource(selector);
      },
    };
    await expect(coordinator.requestPersonalForSessionV2(request(), stopped)).rejects.toBe(
      interruption,
    );
    const row = read();
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    const requestId = row!.request_id;
    const pending = await rpc("sessions.github.status", { sessionKey: SESSION_KEY, requestId });
    expect(pending[1]).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation, account },
    });
    // Archiving preserves sessionId/lifecycleRevision; archivedAt must retire confirmation.
    await patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY }, () => ({
      archivedAt: Date.now(),
    }));
    const stoppedSession = {
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    };
    expect(
      (await rpc("sessions.github.status", { sessionKey: SESSION_KEY, requestId }))[1],
    ).toMatchObject(stoppedSession);
    expect((await rpc("sessions.github.options"))[1].pendingPersonal).toMatchObject(stoppedSession);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });
});
