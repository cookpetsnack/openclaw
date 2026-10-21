import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentUserMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  placements,
  readWorkerTurnTranscriptStorageRows,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  executeRemoteExecTurn as executeRemoteExecTurnCore,
  reconcileWorkspaceAfterTurn as reconcileWorkspaceAfterTurnCore,
} from "./workspace-result-finalize.js";

function workspaceTunnel(
  overrides: Partial<WorkerWorkspaceTunnelHandle> = {},
): WorkerWorkspaceTunnelHandle {
  return {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: vi.fn(),
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    syncWorkspace: vi.fn(),
    stop: async () => {},
    ...overrides,
  };
}

function claimLocalTurn(runId: string) {
  return placements.claimTurn({
    ...sessionTarget,
    owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    claimId: runId,
    runId,
  });
}

function reconcileWorkspaceAfterTurn(
  params: Parameters<typeof reconcileWorkspaceAfterTurnCore>[0],
) {
  return withWorkerTurnTranscriptDatabase(
    { ...params.transcriptTarget, sessionTarget: params.transcriptTarget },
    {
      assertCurrent() {},
      prepareAuthority: () => params.placements.prepareTurnClaimAuthority(params.turnClaim),
    },
    (transcriptTarget) => reconcileWorkspaceAfterTurnCore({ ...params, transcriptTarget }),
  );
}

async function activePlacement(remote?: string) {
  await seedActivePlacement("remote-exec", remote);
  const placement = placements.get(SESSION_ID);
  if (placement?.state !== "active") {
    throw new Error("expected active placement");
  }
  return placement;
}

beforeEach(setupWorkerTurnLauncherTest);
afterEach(cleanupWorkerTurnLauncherTest);

it.each(
  (["prior", "report"] as const).flatMap((phase) =>
    (["current", "draining", "claim", "session"] as const).map((change) => ({ phase, change })),
  ),
)("revalidates $change settlement after $phase transcript hydration", async ({ phase, change }) => {
  const placement = await activePlacement();
  const source = SessionManager.open(sessionTarget);
  source.appendMessage(
    makeAgentUserMessage({ content: "Durable input 🦞\nunchanged", timestamp: 1 }),
  );
  const before = source.getPersistedEntries();
  const beforeRows = readWorkerTurnTranscriptStorageRows();
  const claim = await claimLocalTurn(`hydrate-${phase}-${change}`);
  await placements.markWorkspaceResultPending(claim);
  const entered = createDeferred();
  const release = createDeferred();
  const open = SessionManager.openAsync.bind(SessionManager);
  let reads = 0;
  const hydration = vi.spyOn(SessionManager, "openAsync").mockImplementation(async (...args) => {
    const manager = await open(...args);
    if (++reads === (phase === "prior" ? 1 : 2)) {
      entered.resolve();
      await release.promise;
    }
    return manager;
  });
  const publish = vi.fn();
  const quiesce = vi.fn(async () => ({ assertActive: async () => {}, resume: async () => {} }));
  const tunnel = workspaceTunnel({
    quiesceWorkspace: quiesce,
    reconcileWorkspace: async (request) => {
      if (request.source.kind !== "local" || !request.source.stagedResult) {
        throw new Error("expected local staged result");
      }
      await request.source.stagedResult.record(request.source.stagedResult.ref);
      return {
        ...(await reconcileUnchangedLocalWorkspace(request)),
        getAppliedWorkspaceResult: () => ({
          manifestRef: MANIFEST_REF,
          manifest: { version: 1, baseCommit: null, entries: [] },
          conflictPaths: ["src/retained.ts"],
          verifyLocalStable: async () => {},
        }),
      };
    },
  });
  const operation = reconcileWorkspaceAfterTurn({
    placement,
    placements,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    turnClaim: claim,
    workspace: { kind: "local", path: root },
    transcriptTarget: { ...sessionTarget },
    tunnel,
    publishAcceptedWorkspace: publish,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, operation, "settled before hydration");
    if (change === "draining") {
      await placements.startWorkspaceResultDrain(claim);
    } else if (change === "claim") {
      const pending = (await placements.listPendingWorkspaceResultsAsync(SESSION_ID))[0];
      if (!pending) {
        throw new Error("expected retained result");
      }
      await placements.failWorkspaceResultAndReleaseTurn(
        pending,
        new Error("fixture replaced result"),
      );
    } else if (change === "session") {
      await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
    }
    release.resolve();
    const outcome = await operation;
    if (change === "current" || change === "draining") {
      expect(outcome).toMatchObject({ value: { paths: ["src/retained.ts"] } });
      expect(publish).toHaveBeenCalledOnce();
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      const after = SessionManager.open(sessionTarget).getPersistedEntries();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(readWorkerTurnTranscriptStorageRows().slice(0, beforeRows.length)).toEqual(beforeRows);
      expect(after.at(-1)).toMatchObject({
        type: "custom_message",
        customType: "cloud-workspace-conflict",
      });
    } else {
      expect(outcome).toMatchObject({ error: expect.any(Error) });
      expect(publish).not.toHaveBeenCalled();
      if (phase === "prior") {
        expect(quiesce).not.toHaveBeenCalled();
      }
      if (change !== "session") {
        expect(SessionManager.open(sessionTarget).getPersistedEntries()).toEqual(before);
        expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
      }
    }
  } finally {
    release.resolve();
    await operation;
    hydration.mockRestore();
  }
});

it("reports cleanup failure and reclaims the inputs before the next turn without skills", async () => {
  const remote = path.join(await fs.realpath(root), "remote");
  const source = path.join(root, "source");
  await fs.mkdir(remote);
  await fs.mkdir(path.join(source, "skills", "synthetic"), { recursive: true });
  await fs.writeFile(
    path.join(source, "skills", "synthetic", "SKILL.md"),
    "---\ndescription: Synthetic resource\n---\n# Resource\n",
  );
  const placement = await activePlacement(remote);
  const inputTurn = {
    ...turn("cleanup-failure"),
    skillsSnapshot: await buildSkillSnapshot(source, {
      entries: loadWorkspaceSkills(source, { workspaceOnly: true }),
    }),
  };
  let failCleanup = true;
  const tunnel = workspaceTunnel({
    runWorkspaceCommand: async (command) => {
      if (JSON.parse(command.input!).op === "cleanup" && failCleanup) {
        failCleanup = false;
        return {
          code: 1,
          stdout: "",
          stderr: "cleanup denied",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      return await runCommandWithTimeout([...command.argv], {
        cwd: remote,
        input: command.input,
        timeoutMs: 5_000,
      });
    },
  });
  const execute = async (
    input: Parameters<typeof executeRemoteExecTurnCore>[0]["turn"],
    runLocal: Parameters<typeof executeRemoteExecTurnCore>[0]["runLocal"],
  ) => {
    const turnClaim = await claimLocalTurn(input.runId);
    return withWorkerTurnTranscriptDatabase(
      input,
      {
        assertCurrent() {},
        prepareAuthority: () => placements.prepareTurnClaimAuthority(turnClaim),
      },
      () =>
        executeRemoteExecTurnCore({
          environments: { get: attachedEnvironment, startTunnel: async () => tunnel },
          onHandoff: () => {},
          placement,
          placements,
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          turn: input,
          turnClaim,
          workspace: { kind: "local", path: root },
          runLocal,
        }),
    );
  };
  await expect(execute(inputTurn, async () => ({ meta: { durationMs: 1 } }))).rejects.toThrow(
    "Skill resource cleanup failed",
  );
  expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

  expect(await fs.readdir(remote)).toHaveLength(1);
  const runLocal = vi.fn(async () => {
    expect(await fs.readdir(remote)).toEqual([]);
    return { meta: { durationMs: 1 } };
  });
  await execute(turn("cleanup-recovery"), runLocal);
  expect(runLocal).toHaveBeenCalled();
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
});
