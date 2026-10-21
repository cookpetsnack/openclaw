import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForCliSignalExit, waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import {
  readGatewayLockProcessNamespace,
  type GatewayLockRole,
} from "../infra/gateway-lock-payload.js";
import {
  acquireGatewayLock,
  readLockPayloadSync,
  resolveGatewayLockPaths,
  resolveGatewayOwnerStatus,
} from "../infra/gateway-lock.js";
import {
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "../infra/gateway-shutdown-budget.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorRepair } from "./doctor-maintenance.admission.test-support.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function restoreHost() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
}

// With no recorded rehearsal, waits end 30 min after Doctor started, less the 10 min floor.
const FALLBACK_DEADLINE_MS = 1_200_000;

function holdState(
  role: GatewayLockRole,
  update: boolean,
  pid = process.ppid,
  seed: Parameters<typeof withOpenClawStateStartupMigrationCheckpointDatabase>[0] = () => {},
) {
  const stateDir = dirs.make("doctor-contention-wait-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : "");
  withOpenClawStateStartupMigrationCheckpointDatabase(seed);
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  // The in-process owner stands in for another OpenClaw process: Doctor never waits
  // on its own PID, so the recorded holder is this test's parent process.
  const holder = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid,
      processNamespace: readGatewayLockProcessNamespace(),
      role,
      createdAt: new Date().toISOString(),
      configPath: path.join(stateDir, "openclaw.json"),
      stateDir,
    },
  });
  return {
    databasePath,
    holder,
    before: fs.readFileSync(databasePath),
    startDoctor,
    [Symbol.dispose]: () => holder.release(),
  };
}

/** `startMs` is how long this Doctor process ran before entering maintenance. */
function startDoctor(startMs = 0, waitForMaintenance = false, assertCurrent?: () => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const clock = { ms: startMs };
  vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
  const firstLog = createDeferredCore();
  const log = vi.fn((..._args: unknown[]) => firstLog.resolve());
  let settled = false;
  // Published drivers can run the activation Doctor without an update authority callback.
  const result = beginDoctorMaintenance({
    waitForMaintenance,
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log, error: vi.fn(), exit: vi.fn() },
    assertCurrent,
  })
    .then(
      (maintenance) => ({ maintenance }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  const advanceTo = async (ms: number) => {
    clock.ms = ms;
    await vi.advanceTimersToNextTimerAsync();
  };
  // Without the wait, admission settles before logging anything.
  const firstWait = Promise.race([firstLog.promise, result]);
  return { log, result, advanceTo, firstWait, isSettled: () => settled };
}

describe("foreground update settlement", () => {
  afterEach(restoreHost);
  function foregroundFixture(published: boolean) {
    const owner = {
      pid: process.pid,
      host: hostname(),
      startedAt: getFileLockProcessStartTime(process.pid),
    };
    expect(owner.startedAt).not.toBeNull();
    const { databasePath, holder } = holdState("gateway", true, process.pid, (db) => {
      if (published) {
        db.prepare(
          `INSERT INTO state_leases
       (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
       VALUES ('gateway-owner', 'global', 'previous-gateway', ?, ?, ?, ?, ?)`,
        ).run(
          Date.now() + 600_000,
          Date.now(),
          JSON.stringify({
            owner,
            port: 19483,
            mode: "foreground",
            supervisor: null,
          }),
          Date.now(),
          Date.now(),
        );
      }
    });
    return { databasePath, predecessor: holder };
  }
  it.each(["slow-released", "authority-lost", "rowless-released"] as const)(
    "settles the foreground state owner before update Doctor admission: %s",
    async (outcome) => {
      const { databasePath, predecessor } = foregroundFixture(outcome !== "rowless-released");
      const before = fs.readFileSync(databasePath);
      let authorized = true;
      const doctor = startDoctor(0, false, () => {
        if (!authorized) {
          throw new Error("update owner was revoked");
        }
      });
      try {
        await doctor.firstWait;
        expect(doctor.isSettled()).toBe(false);
        expect(fs.readFileSync(databasePath)).toEqual(before);
        if (outcome === "slow-released") {
          await doctor.advanceTo(
            TICK_INTERVAL_MS +
              resolveGatewayRestartDeferralTimeoutMs() +
              GATEWAY_SHUTDOWN_TIMEOUT_MS -
              1,
          );
          expect(doctor.isSettled()).toBe(false);
          expect(fs.readFileSync(databasePath)).toEqual(before);
        }
        if (outcome === "rowless-released") {
          await doctor.advanceTo(GATEWAY_SHUTDOWN_RESERVE_MS - 50);
          expect(doctor.isSettled()).toBe(false);
        }
        const released = outcome === "slow-released" || outcome === "rowless-released";
        if (outcome === "slow-released") {
          withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
            db.prepare(
              "DELETE FROM state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global' AND owner = 'previous-gateway'",
            ).run();
          });
        } else if (!released) {
          authorized = false;
        }
        predecessor?.release();
        if (outcome === "rowless-released") {
          await doctor.advanceTo(GATEWAY_SHUTDOWN_RESERVE_MS);
        } else {
          await vi.advanceTimersToNextTimerAsync();
        }
        const completed = await doctor.result;
        if (released) {
          expect(completed).toHaveProperty("maintenance");
          if ("maintenance" in completed) {
            expect(completed.maintenance).toBeDefined();
            await completed.maintenance?.finish({});
          }
        } else {
          expect("error" in completed ? completed.error : undefined).toMatchObject({
            message: expect.stringContaining("update owner was revoked"),
          });
        }
      } finally {
        predecessor?.release();
        if (!doctor.isSettled()) {
          await vi.runOnlyPendingTimersAsync();
        }
        const completed = await doctor.result;
        if ("maintenance" in completed) {
          await completed.maintenance?.release();
        }
        if (outcome === "rowless-released") {
          expect(vi.getTimerCount()).toBe(0);
        }
      }
    },
  );

  it("keeps the published legacy startup gate through nested Doctor work and resource drainage", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-legacy-startup-exclusion" },
      async (state) => {
        const maintenance = await beginDoctorRepair();
        if (!maintenance) {
          throw new Error("Expected Doctor maintenance ownership");
        }
        const { stateLockPath } = resolveGatewayLockPaths(state.env);
        // Published 2026.9.4 startup claims this path with exclusive creation and
        // preserves it when the recorded process identity is still live.
        const canClaimLegacyStateLock = () => {
          fs.mkdirSync(path.dirname(stateLockPath), { recursive: true });
          let descriptor: number;
          try {
            descriptor = fs.openSync(stateLockPath, "wx", 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              return false;
            }
            throw error;
          }
          fs.closeSync(descriptor);
          fs.unlinkSync(stateLockPath);
          return true;
        };
        const closing = createDeferredCore();
        const settle = createDeferredCore();
        let releasing: Promise<void> | undefined;
        try {
          expect(canClaimLegacyStateLock()).toBe(false);
          const identity = readLockPayloadSync(stateLockPath, true);
          expect(identity).toMatchObject({ pid: process.pid, role: "agent-embedded" });
          expect(await resolveGatewayOwnerStatus(process.pid, identity, process.platform)).toBe(
            "alive",
          );
          await maintenance.run(async () => {
            const child = await acquireGatewayLock({
              env: state.env,
              role: "sqlite-maintenance",
              allowInTests: true,
              timeoutMs: 0,
            });
            expect(child).not.toBeNull();
            await child?.release();
            expect(canClaimLegacyStateLock()).toBe(false);
            const scope = getOpenClawDatabaseMaintenanceScope();
            if (!scope) {
              throw new Error("Expected Doctor's resource scope");
            }
            scope.own({}, "shared-resources", async () => {
              closing.resolve();
              await settle.promise;
            });
          });
          releasing = maintenance.release();
          await Promise.race([
            closing.promise,
            releasing.then(() => {
              throw new Error("Doctor released before draining its resource");
            }),
          ]);
          expect(canClaimLegacyStateLock()).toBe(false);
          settle.resolve();
          await releasing;
          expect(fs.existsSync(stateLockPath)).toBe(false);
          expect(canClaimLegacyStateLock()).toBe(true);
        } finally {
          settle.resolve();
          await releasing;
          await maintenance.release();
        }
      },
    );
  });
});

describe("maintenance contention", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    restoreHost();
  });
  it.each(["update", "startup"] as const)(
    "waits for a transient OpenClaw command before %s maintenance",
    async (mode) => {
      using state = holdState("agent-embedded", mode === "update");
      const { databasePath, holder, before } = state;
      const doctor = state.startDoctor(0, mode === "startup");
      await doctor.firstWait;
      expect(doctor.log).toHaveBeenCalledWith(
        `Waiting up to 1200 s for the OpenClaw agent-embedded process ${process.ppid} to release ${databasePath} before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
      );
      await doctor.advanceTo(45_000);
      expect(doctor.log).toHaveBeenCalledWith(
        `Still waiting for the OpenClaw agent-embedded process ${process.ppid} to release ${databasePath} (45 s of 1200 s).`,
      );
      // Waiting holds no lock and writes nothing; the holder can finish and release.
      await doctor.advanceTo(FALLBACK_DEADLINE_MS - 1_000);
      expect(doctor.isSettled()).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
      holder.release();
      await doctor.advanceTo(FALLBACK_DEADLINE_MS - 500);
      const completed = await doctor.result;
      expect(completed).toHaveProperty("maintenance");
      expect(doctor.log).toHaveBeenCalledWith(
        "State ownership released after 1200 s; continuing Doctor maintenance.",
      );
      await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
    },
  );

  it.each([
    ["elapsed startup time", 100_000, 0, FALLBACK_DEADLINE_MS, 1100],
    ["twice the rehearsal reserved for Doctor", 0, 400_000, 1_000_000, 1000],
  ] as const)(
    "enforces the wait deadline with %s",
    async (_name, startMs, rehearsalMs, deadline, seconds) => {
      using state = holdState("agent-embedded", true);
      if (rehearsalMs) {
        const { runId } = createUpdateRun({ trigger: "cli" });
        recordUpdateRunStep(runId, {
          step: "candidate-doctor",
          status: "completed",
          startedAtMs: 1_000,
          endedAtMs: 1_000 + rehearsalMs,
        });
        closeOpenClawStateDatabaseForTest();
      }
      const doctor = state.startDoctor(startMs);
      await doctor.firstWait;
      expect(doctor.log).toHaveBeenCalledWith(
        expect.stringContaining(`Waiting up to ${seconds} s`),
      );
      await doctor.advanceTo(deadline - 1);
      expect(doctor.isSettled()).toBe(false);
      await doctor.advanceTo(deadline);
      const completed = await doctor.result;
      const error = "error" in completed ? completed.error : undefined;
      expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
      // Contention stays a deferred refusal: no data is at risk.
      expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
        kind: "deferred",
        reason: "coordinator-contention",
      });
      const message = (error as Error).message;
      expect(message).toContain("Doctor could not enter maintenance.");
      expect(message).toContain(
        `Doctor waited ${seconds} s for the OpenClaw agent-embedded process ${process.ppid} to finish;`,
      );
      expect(message).toContain(`The holder ${process.ppid} is alive on this host, stop it first.`);
      expect(message).toContain("then run openclaw doctor --fix from an independent shell.");
    },
  );

  it("preserves accepted shutdown after cancelling a startup maintenance wait", async () => {
    using state = holdState("agent-embedded", false);
    const { databasePath, holder, before } = state;
    const doctor = state.startDoctor(0, true);
    try {
      await doctor.firstWait;
      const drain = waitForSignalExitBarriers("SIGTERM").catch((error: unknown) => error);
      const completed = await doctor.result;
      await drain;
      expect(completed).toHaveProperty("error");
      const error = "error" in completed ? completed.error : undefined;
      expect(error).not.toBeInstanceOf(DoctorMaintenanceRefusalError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Doctor interrupted by SIGTERM");
      expect(await waitForCliSignalExit()).toBe(143);
      expect(fs.readFileSync(databasePath)).toEqual(before);
    } finally {
      holder.release();
      await doctor.result;
      await waitForCliSignalExit();
    }
  });

  it.each([
    ["manual doctor --fix with a transient holder", "agent-embedded", false, process.ppid],
    ["update Doctor with a Gateway holder", "gateway", true, process.ppid],
    // This process's own owner cannot release while Doctor waits on it.
    ["update Doctor with its own process's owner", "sqlite-maintenance", true, process.pid],
  ] as const)("keeps immediate contention failure for %s", async (_name, role, update, pid) => {
    using state = holdState(role, update, pid);
    const doctor = state.startDoctor();
    const completed = await doctor.result;
    expect(completed).toMatchObject({
      error: { message: expect.stringContaining("OpenClaw state database is busy at") },
    });
    expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
  });
});
