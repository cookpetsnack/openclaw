import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDeviceAuthToken } from "../infra/device-auth-store.test-support.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const noteMock = vi.hoisted(() => vi.fn());

// mock-isolation: exercise doctor response handling without opening network connections.
vi.mock("../gateway/call.js", () => ({ callGateway: callGatewayMock }));
// mock-isolation: capture user-facing notes without terminal output.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

function requireNoteMessage(included: string[] = [], excluded: string[] = []): string {
  const message: unknown = noteMock.mock.calls[0]?.[0];
  if (typeof message !== "string") {
    throw new Error("expected doctor note message");
  }
  for (const text of included) {
    expect(message).toContain(text);
  }
  for (const text of excluded) {
    expect(message).not.toContain(text);
  }
  return message;
}

const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState(
    { prefix: "openclaw-doctor-device-pairing-", env: { OPENCLAW_TEST_FAST: "1" } },
    run,
  );

const localHealth = { cfg: { gateway: { mode: "local" as const } }, healthOk: false };
const remoteHealth = { cfg: { gateway: { mode: "remote" as const } }, healthOk: true };
const operatorToken = { role: "operator", token: "stale-local-token", scopes: ["operator.read"] };
const operatorRequest = {
  role: operatorToken.role,
  scopes: operatorToken.scopes,
  clientId: "control-ui",
  clientMode: "webchat",
  displayName: "Dashboard",
};
const pendingDevice = {
  ...operatorRequest,
  requestId: "req-gateway-1",
  deviceId: "device-gateway-1",
  publicKey: "pubkey",
  roles: ["operator"],
  ts: 1,
  isRepair: false,
};

const legacyDeviceAuthContents = JSON.stringify({
  version: 1,
  deviceId: "synthetic-device",
  tokens: {
    operator: {
      ...operatorToken,
      token: "synthetic-legacy-token",
      updatedAtMs: 10,
    },
  },
});

describe("noteDevicePairingHealth", () => {
  let collectDevicePairingHealthFindings: typeof import("./doctor-device-pairing.js").collectDevicePairingHealthFindings;
  let noteDevicePairingHealth: typeof import("./doctor-device-pairing.js").noteDevicePairingHealth;

  async function withApprovedOperatorPairing(
    run: (context: {
      identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
      publicKey: string;
    }) => Promise<void>,
  ): Promise<void> {
    await withState(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
      const initial = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        ...operatorRequest,
      });
      await approveDevicePairing(initial.request.requestId, { callerScopes: ["operator.read"] });
      await run({ identity, publicKey });
    });
  }

  async function localNote(included: string[] = [], excluded: string[] = []): Promise<void> {
    await noteDevicePairingHealth(localHealth);
    expect(noteMock).toHaveBeenCalledTimes(1);
    requireNoteMessage(included, excluded);
  }

  beforeAll(async () => {
    vi.resetModules();
    ({ collectDevicePairingHealthFindings, noteDevicePairingHealth } =
      await import("./doctor-device-pairing.js"));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
    noteMock.mockReset();
  });

  it("warns about pending scope upgrades from local pairing state when the gateway is down", async () => {
    await withApprovedOperatorPairing(async ({ identity, publicKey }) => {
      const pending = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        ...operatorRequest,
        scopes: ["operator.admin"],
      });

      await localNote(["Pending scope upgrade", "operator.admin", "openclaw devices approve"]);
      expect(noteMock.mock.calls[0]?.[1]).toBe("Device pairing");

      const findings = await collectDevicePairingHealthFindings(localHealth);
      expect(findings).toMatchObject([
        {
          checkId: "core/doctor/device-pairing",
          severity: "warning",
          path: "devices.pending",
          target: identity.deviceId + ":" + pending.request.requestId,
          requirement: "scope-upgrade",
          message: expect.stringContaining("Pending scope upgrade"),
          fixHint: expect.stringContaining("openclaw devices approve"),
        },
      ]);
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["nodes/paired.json", "local", "devices.legacy-store", "pairing-store-legacy-file"],
    [
      "identity/device-auth.json",
      "remote",
      "identity.device-auth",
      "device-auth-store-legacy-file",
    ],
  ] as const)(
    "warns about unimported %s in %s mode without changing it",
    async (file, mode, findingPath, requirement) => {
      await withState(async (state) => {
        const content =
          requirement === "pairing-store-legacy-file" ? "{not-json}" : legacyDeviceAuthContents;
        const sourcePath = await state.writeText(file, content);
        const params = { cfg: { gateway: { mode } }, healthOk: false };

        const findings = await collectDevicePairingHealthFindings(params);
        expect.soft(findings).toMatchObject([
          {
            checkId: "core/doctor/device-pairing",
            severity: "warning",
            path: findingPath,
            requirement,
            message: expect.stringContaining(
              requirement === "pairing-store-legacy-file"
                ? "has not been imported"
                : "is still present",
            ),
            fixHint: expect.stringContaining("openclaw doctor --fix"),
          },
        ]);
        await noteDevicePairingHealth(params);
        expect.soft(noteMock).toHaveBeenCalledTimes(1);
        expect(noteMock).toHaveBeenCalledWith(
          expect.stringContaining(path.basename(sourcePath)),
          "Device pairing",
        );
        requireNoteMessage([], ["synthetic-legacy-token"]);
        expect(await fs.readFile(sourcePath, "utf8")).toBe(content);
        await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it("does not report retained imported device-auth JSON as migration debt", async () => {
    await withState(async (state) => {
      const sourcePath = await state.writeText(
        "identity/device-auth.json",
        legacyDeviceAuthContents,
      );
      const migrated = await migrateLegacyDeviceAuth({
        detected: detectLegacyDeviceAuth({
          stateDir: state.stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir: state.stateDir,
        env: state.env,
      });
      expect(migrated.warnings).toEqual([]);
      const params = { cfg: { gateway: { mode: "remote" as const } }, healthOk: false };
      const findings = await collectDevicePairingHealthFindings(params);
      expect(findings).toEqual([]);
      await noteDevicePairingHealth(params);
      expect(noteMock).not.toHaveBeenCalled();
      expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
    });
  });

  it.each(["rotated token", "unapproved role", "revoked token"] as const)(
    "diagnoses local auth with a %s without misleading recovery advice",
    async (scenario) => {
      await withApprovedOperatorPairing(async ({ identity: { deviceId } }) => {
        seedDeviceAuthToken(
          scenario === "unapproved role"
            ? { deviceId, role: "node", token: "stale-node-token", scopes: [] }
            : {
                deviceId,
                ...operatorToken,
                ...(scenario === "rotated token" ? { updatedAtMs: 1 } : {}),
              },
        );
        if (scenario === "rotated token") {
          expect((await rotateDeviceToken({ deviceId, role: "operator" })).ok).toBe(true);
        } else if (scenario === "revoked token") {
          await revokeDeviceToken({ deviceId, role: "operator" });
        }
        if (scenario === "rotated token") {
          await localNote(["stale device-token pattern", "openclaw devices rotate"]);
        } else if (scenario === "unapproved role") {
          await localNote(
            [
              "Local cached node device auth",
              "role is no longer approved",
              "remove the stale cached node auth entry",
            ],
            ["--role node"],
          );
        } else {
          await localNote(
            ["has no active operator device token"],
            ["no longer has a matching active gateway token"],
          );
        }
      });
    },
  );

  it("preserves pairing diagnostics when the token inventory read rejects", async () => {
    await withApprovedOperatorPairing(async () => {
      const inventory = vi
        .spyOn(await import("../infra/device-auth-store.js"), "loadDeviceAuthTokens")
        .mockRejectedValueOnce(new Error("synthetic inventory failure"));
      try {
        await expect(collectDevicePairingHealthFindings(localHealth)).resolves.toEqual([]);
        expect(inventory).toHaveBeenCalledOnce();
      } finally {
        inventory.mockRestore();
      }
    });
  });

  it.each([
    { role: "node", tokenScopes: ["operator.read"], recoveryOption: " --no-scopes" },
    { role: "operator", tokenScopes: ["operator.admin"], recoveryOption: "" },
  ])(
    "recommends explicit scope recovery only for legacy node tokens: $role",
    async ({ role, tokenScopes, recoveryOption }) => {
      callGatewayMock.mockResolvedValue({
        pending: [],
        paired: [
          {
            deviceId: "paired-device",
            publicKey: "paired-public-key",
            roles: [role],
            scopes: ["operator.read"],
            tokens: [{ role, scopes: tokenScopes, createdAtMs: 1 }],
            createdAtMs: 1,
            approvedAtMs: 1,
          },
        ],
      });

      const findings = await collectDevicePairingHealthFindings(remoteHealth);

      expect(findings).toContainEqual(
        expect.objectContaining({
          requirement: "token-outside-approved-scope",
          fixHint: `Rotate it with openclaw devices rotate --device paired-device --role ${role}${recoveryOption}.`,
        }),
      );
    },
  );

  it("sanitizes device labels before printing doctor notes", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          ...pendingDevice,
          scopes: ["operator.admin"],
          clientId: "control-ui\tclient",
          displayName: "\u001b[2Kbad\nname",
        },
      ],
      paired: [],
    });

    await noteDevicePairingHealth(remoteHealth);

    requireNoteMessage(["req-gateway-1", "bad\\nname"], ["\u001b", "control-ui\tclient"]);
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith({
      method: "device.pair.list",
      timeoutMs: 5_000,
      sharedStateMode: "read-only",
      config: { gateway: { mode: "remote" } },
    });
    expect(noteMock).toHaveBeenCalledTimes(1);
  });

  it("quotes untrusted device pairing fields in suggested commands", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          ...pendingDevice,
          deviceId: "device; echo pwn",
          publicKey: "pending-pubkey",
          isRepair: true,
        },
      ],
      paired: [
        {
          deviceId: "device; echo pwn",
          publicKey: "paired-pubkey",
          displayName: "Dashboard",
          clientId: "control-ui",
          clientMode: "webchat",
          role: "operator; touch /tmp/pwn",
          roles: ["operator; touch /tmp/pwn"],
          scopes: [],
          approvedScopes: [],
          tokens: [],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      ],
    });

    await noteDevicePairingHealth(remoteHealth);

    requireNoteMessage([
      "openclaw devices remove 'device; echo pwn'",
      "openclaw devices rotate --device 'device; echo pwn' --role 'operator; touch /tmp/pwn'",
    ]);
  });
});
