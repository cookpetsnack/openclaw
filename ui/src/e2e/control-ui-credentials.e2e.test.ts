// Control UI tests cover browser credential submission and visible recovery.
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Gateway secret E2E",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
const requireRecord = createRequireRecord("record", "expected-object-value");

function readConnectAuth(request: MockGatewayRequest): Record<string, unknown> | undefined {
  const auth = requireRecord(request.params).auth;
  return auth == null ? undefined : requireRecord(auth);
}

async function createCredentialPage() {
  const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
  const response = await page.goto(suite.server.baseUrl);
  expect(response?.status()).toBe(200);
  return { context, gateway, page };
}

type CredentialFlow = Awaited<ReturnType<typeof createCredentialPage>>;

async function submitSecret({ page, gateway }: CredentialFlow, secret: string) {
  const previousCount = (await gateway.getRequests("connect")).length;
  await gateway.deferNext("connect");
  await page.getByLabel("Gateway secret", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const request = await gateway.waitForRequest("connect", { after: previousCount });
  expect(await gateway.getRequests("connect")).toHaveLength(previousCount + 1);
  expect(readConnectAuth(request)).toMatchObject({
    token: secret,
    password: secret,
  });
}

async function acceptSecret({ page, gateway }: CredentialFlow) {
  await gateway.resolveDeferred("connect");
  await page.locator("openclaw-app-shell").waitFor();
  expect(await page.locator("openclaw-login-gate").count()).toBe(0);
}

async function rejectInitialConnect(
  { page, gateway }: CredentialFlow,
  code: string,
  message: string,
): Promise<void> {
  const initialConnect = await gateway.waitForRequest("connect");
  expect(readConnectAuth(initialConnect)).toBeUndefined();
  await gateway.rejectDeferred("connect", {
    code: "UNAUTHORIZED",
    details: { code },
    message,
  });
  await page.locator("openclaw-login-gate").waitFor();
}

suite.define(() => {
  it.each([
    ["token", ConnectErrorDetailCodes.AUTH_TOKEN_MISSING],
    ["password", ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING],
  ])("submits the %s secret with visible acceptance and rejection recovery", async (mode, code) => {
    const flow = await createCredentialPage();
    const errors: string[] = [];
    flow.page.on("pageerror", (error) => errors.push(String(error)));
    await rejectInitialConnect(flow, code, `unauthorized: gateway ${mode} required`);
    if (mode === "password") {
      await submitSecret(flow, "password-rejected-by-mock");
      await flow.gateway.rejectDeferred("connect", {
        code: "UNAUTHORIZED",
        details: { code: ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH },
        message: "unauthorized: gateway password mismatch",
      });
      const failure = flow.page.locator(".login-gate__failure");
      await failure.waitFor();
      expect(await failure.getAttribute("role")).toBe("status");
      expect(await failure.getAttribute("aria-live")).toBe("polite");
      expect(await failure.textContent()).toContain("This Gateway expects its password");
      expect(
        (await failure.locator(".login-gate__failure-raw").textContent())?.toLowerCase(),
      ).toContain("gateway password mismatch");
      expect(await failure.locator(".login-gate__failure-steps").isVisible()).toBe(true);
      expect(await flow.page.locator("openclaw-app-shell").count()).toBe(0);
    }
    await submitSecret(flow, `${mode}-accepted-by-mock`);
    await acceptSecret(flow);
    expect(errors).toEqual([]);
    await suite.closeBrowserContext(flow.context);
  });
});
