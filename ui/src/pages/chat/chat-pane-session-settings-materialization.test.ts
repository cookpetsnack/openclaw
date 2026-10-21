/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { renderPaneModelControl } from "./chat-pane-model-control.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { renderPaneTestControls } from "./chat-pane-runtime.test-support.ts";
import { readChatPaneMutationAccess } from "./chat-pane-session-controls.ts";
import { switchChatSetting } from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function draftRow(key: string): GatewaySessionRow {
  return { key, agentId: "main", kind: "direct", updatedAt: 1 };
}

function materializedRow(key: string, sessionId: string) {
  return { ...draftRow(key), sessionId, updatedAt: 2, thinkingLevel: "high" };
}

function materializationReceipt(row: ReturnType<typeof materializedRow>): SessionsPatchResult {
  const { key, sessionId, updatedAt, thinkingLevel } = row;
  return { ok: true, key, path: "", entry: { sessionId, updatedAt, thinkingLevel } };
}

async function mountSettingsPane(fixture: ReturnType<typeof createMountedPanes>, key: string) {
  await fixture.sessions.refresh({ agentId: "main", force: true });
  const pane = fixture.mount(key);
  await refreshPane(pane);
  return pane;
}

it.each([
  { initialState: "absent", source: "preceding write" },
  { initialState: "placeholder", source: "preceding write" },
  { initialState: "absent", source: "failed preceding write" },
  { initialState: "placeholder", source: "replacement" },
] as const)(
  "binds queued settings only to an acknowledged materialization ($initialState / $source)",
  async ({ initialState, source }) => {
    const placeholder = draftRow("agent:main:settings-materialization");
    const materialized = materializedRow(placeholder.key, "settings-created-incarnation");
    const unrelated = {
      ...materialized,
      sessionId: "settings-unrelated-incarnation",
      updatedAt: 3,
      thinkingLevel: "off",
    } satisfies GatewaySessionRow;
    const rows: GatewaySessionRow[] = initialState === "placeholder" ? [placeholder] : [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const firstReceipt = materializationReceipt(materialized);
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      const params = asOptionalRecord(raw);
      if (params?.thinkingLevel === "high") {
        return firstReply.promise;
      }
      if (params?.thinkingLevel !== "low" || !rows[0]?.sessionId) {
        throw new Error("Unexpected settings materialization fixture patch");
      }
      const current = rows[0];
      const sessionId = current.sessionId;
      if (!sessionId) {
        throw new Error("Expected the materialized fixture session identity");
      }
      if (params.expectedSessionId !== undefined && params.expectedSessionId !== sessionId) {
        throw new Error("Session changed before queued settings dispatch");
      }
      rows[0] = { ...current, thinkingLevel: "low", updatedAt: 4 };
      return materializationReceipt({
        ...placeholder,
        sessionId,
        thinkingLevel: "low",
        updatedAt: 4,
      });
    });
    const fixture = createMountedPanes(rows, "main", undefined, { "sessions.patch": patch });
    const { sessions } = fixture;
    let first: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    try {
      const pane = await mountSettingsPane(fixture, placeholder.key);
      expect(selectedChatSessionRow(pane.state)).toEqual(
        initialState === "placeholder" ? expect.objectContaining(placeholder) : undefined,
      );
      const connection = sessions.captureConnectionScope();
      first = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "high" });
      queued = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "low" });
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toEqual({ key: placeholder.key, thinkingLevel: "high" });

      // The first receipt can trail row publication. A failed predecessor proves
      // no identity; an acknowledged A also cannot authorize a later replacement B.
      rows.splice(0, rows.length, source === "preceding write" ? materialized : unrelated);
      await sessions.refresh({ agentId: "main", force: true });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(rows[0]!);
      expect(connection && sessions.isConnectionScopeCurrent(connection)).toBe(true);
      expect(patch).toHaveBeenCalledOnce();
      if (source === "failed preceding write") {
        firstReply.reject(new Error("Synthetic first settings write rejection"));
      } else {
        firstReply.resolve(firstReceipt);
      }
      await expect(first).resolves.toBe(source !== "failed preceding write");
      const completed = await queued;
      const adoptsMaterialization = source === "preceding write";
      expect.soft(completed).toBe(adoptsMaterialization);
      expect.soft(patch).toHaveBeenCalledTimes(adoptsMaterialization ? 2 : 1);
      if (adoptsMaterialization) {
        expect(patch.mock.calls[1]?.[1]).toMatchObject({
          key: placeholder.key,
          thinkingLevel: "low",
          expectedSessionId: materialized.sessionId,
        });
        expect(selectedChatSessionRow(pane.state)).toMatchObject({
          sessionId: materialized.sessionId,
          thinkingLevel: "low",
        });
      } else {
        expect(rows[0]).toEqual(unrelated);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(unrelated);
      }
    } finally {
      firstReply.resolve(firstReceipt);
      await Promise.allSettled([first, queued]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["unbound", "materialized"] as const)(
  "keeps acknowledged materialization through a failed middle settings write (%s)",
  async (lastTarget) => {
    const key = "agent:main:settings-materialization-chain";
    const materialized = {
      ...materializedRow(key, "settings-chain-incarnation"),
      model: "fixture-model",
      modelProvider: "fixture",
      thinkingLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    } satisfies GatewaySessionRow;
    const rows: GatewaySessionRow[] = [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const middleReply = createDeferred<SessionsPatchResult>();
    const middleDispatched = createDeferred();
    const primaryRead = createDeferred<SessionsListResult>();
    const primaryReadStarted = createDeferred();
    let firstAcknowledged = false;
    let holdPrimaryRead = lastTarget === "unbound";
    const firstReceipt = materializationReceipt(materialized);
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      const params = asOptionalRecord(raw);
      if (params?.thinkingLevel === "high") {
        return firstReply.promise.then((receipt) => {
          firstAcknowledged = true;
          return receipt;
        });
      }
      if (params?.thinkingLevel === "low") {
        middleDispatched.resolve();
        return middleReply.promise;
      }
      if (params?.thinkingLevel !== "medium" || rows[0]?.sessionId !== materialized.sessionId) {
        throw new Error("Unexpected settings materialization chain patch");
      }
      rows[0] = { ...materialized, thinkingLevel: "medium", updatedAt: 3 };
      return materializationReceipt({ ...materialized, thinkingLevel: "medium", updatedAt: 3 });
    });
    const fixture = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": (_method, raw) => {
        if (firstAcknowledged && holdPrimaryRead && asOptionalRecord(raw)?.archived !== "all") {
          primaryReadStarted.resolve();
          return primaryRead.promise;
        }
        return sessionsResult([...rows], 2);
      },
    });
    const { sessions, context } = fixture;
    let first: Promise<boolean> | undefined;
    let middle: Promise<boolean> | undefined;
    let last: Promise<boolean> | undefined;
    let managedRead: Promise<void> | undefined;
    let stopManaged: (() => void) | undefined;
    try {
      const pane = await mountSettingsPane(fixture, key);
      pane.state.chatModelCatalog = [
        { id: "fixture-model", name: "Fixture model", provider: "fixture", reasoning: true },
      ];
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      first = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "high" });
      middle = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "low" });
      const middleReady = getPendingChatPickerPatch(pane.state, key, "main");
      if (lastTarget === "materialized") {
        rows.push(materialized);
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(materialized);
      }
      last = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "medium" });
      const lastReady = getPendingChatPickerPatch(pane.state, key, "main");
      expect(patch).toHaveBeenCalledOnce();

      if (lastTarget === "unbound") {
        rows.push(materialized);
      }
      firstReply.resolve(firstReceipt);
      if (lastTarget === "unbound") {
        await Promise.race([primaryReadStarted.promise, first]);
        const query = { agentId: "main", archivedFilter: "all" as const };
        let managedFrame:
          | { thinkingLevel?: string; paneSessionId?: string; preview?: string }
          | undefined;
        stopManaged = sessions.subscribeList(query, (snapshot) => {
          const row = snapshot.result?.sessions.find((entry) => entry.key === key);
          if (!snapshot.loading && row && !managedFrame) {
            managedFrame = {
              thinkingLevel: row.thinkingLevel,
              paneSessionId: selectedChatSessionRow(pane.state)?.sessionId,
              preview: sessions.settingsPreview(key, "main")?.thinkingLevel,
            };
          }
        });
        managedRead = sessions.refreshList({ ...query, force: true });
        await managedRead;
        // Projecting into one list must not retire another consumer's pending preview.
        expect(managedFrame).toMatchObject({
          thinkingLevel: "medium",
          preview: "medium",
        });
        holdPrimaryRead = false;
        primaryRead.resolve(sessionsResult([...rows], 2));
      }
      await expect(first).resolves.toBe(true);
      await Promise.race([middleDispatched.promise, middle]);
      expect(patch).toHaveBeenCalledTimes(2);
      expect.soft(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: materialized.sessionId,
        thinkingLevel: "medium",
      });
      const access = readChatPaneMutationAccess(context.gateway.snapshot, key);
      const controls = renderPaneTestControls(pane.state, {
        selectedSession: selectedChatSessionRow(pane.state),
        modelAccess: access.model,
        effortAccess: access.effort,
        contextWindowAccess: access.contextWindow,
        permissionAccess: access.permission,
        canSelectFull: false,
      });
      const container = document.createElement("div");
      renderPaneModelControl(controls.composerControls, container);
      expect
        .soft(
          container.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset
            .chatThinkingValue,
        )
        .toBe("medium");
      expect
        .soft(container.querySelector(".chat-controls__effort-picker summary")?.textContent)
        .toContain("Medium");
      middleReply.reject(new Error("Synthetic rejection of the middle settings choice"));
      await expect(Promise.all([first, middle, last])).resolves.toEqual([true, false, true]);
      await expect(middleReady).resolves.toBe(false);
      await expect(lastReady).resolves.toBe(true);
      expect(patch.mock.calls.map((call) => call[1])).toEqual([
        { key, thinkingLevel: "high" },
        { key, thinkingLevel: "low", expectedSessionId: materialized.sessionId },
        { key, thinkingLevel: "medium", expectedSessionId: materialized.sessionId },
      ]);
      expect(selectedChatSessionRow(pane.state)).toMatchObject({
        sessionId: materialized.sessionId,
        thinkingLevel: "medium",
      });
      expect(getPendingChatPickerPatch(pane.state, key, "main")).toBeUndefined();
    } finally {
      stopManaged?.();
      holdPrimaryRead = false;
      primaryRead.resolve(sessionsResult([...rows], 2));
      firstReply.resolve(firstReceipt);
      middleReply.resolve(firstReceipt);
      await Promise.allSettled([first, middle, last, managedRead]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each([
  { initialState: "absent", outcome: "success" },
  { initialState: "placeholder", outcome: "reasoning rejection" },
  { initialState: "absent", outcome: "rejection" },
  { initialState: "published placeholder", outcome: "reasoning rejection" },
])(
  "settles each queued preview when its ACK-adopted row stays unobserved ($initialState / $outcome)",
  async ({ initialState, outcome }) => {
    const key = "agent:main:settings-unobserved-adoption";
    const placeholder = draftRow(key);
    // The Gateway acknowledges a physical row that is still outside the UI's
    // observed roster. Neither history nor list reads invent its publication.
    const rows: GatewaySessionRow[] = initialState === "placeholder" ? [placeholder] : [];
    const firstReceipt = materializationReceipt(materializedRow(key, "unobserved-ack-session"));
    const firstReply = createDeferred<SessionsPatchResult>();
    const replies = Array.from({ length: 3 }, () => createDeferred<SessionsPatchResult>());
    const dispatched = Array.from({ length: 3 }, () => createDeferred());
    const requested = [
      { thinkingLevel: "low" },
      { fastMode: true },
      { contextWindow: "128k" },
    ] as const;
    const remainingPreviews = [
      { fastMode: true, effectiveFastMode: true, contextWindow: "128k" },
      { contextWindow: "128k" },
      undefined,
    ];
    const patch = vi.fn<GatewayRequestHandler>((_method, raw): Promise<SessionsPatchResult> => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise;
      }
      const index = patch.mock.calls.length - 2;
      const reply = replies[index];
      const started = dispatched[index];
      if (!reply || !started) {
        throw new Error("Unexpected unobserved settings request");
      }
      expect(raw).toEqual({
        key,
        ...requested[index],
        expectedSessionId: firstReceipt.entry.sessionId,
      });
      started.resolve();
      return reply.promise;
    });
    const fixture = createMountedPanes(rows, "main", undefined, { "sessions.patch": patch });
    const { sessions } = fixture;
    let first: Promise<boolean> | undefined;
    const queued: Promise<boolean>[] = [];
    try {
      const pane = await mountSettingsPane(fixture, key);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      first = switchChatSetting(pane.state, { kind: "thinkingLevel", value: "high" });
      queued.push(switchChatSetting(pane.state, { kind: "thinkingLevel", value: "low" }));
      queued.push(switchChatSetting(pane.state, { kind: "fastMode", value: "on" }));
      queued.push(switchChatSetting(pane.state, { kind: "contextWindow", value: "128k" }));
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toEqual({ key, thinkingLevel: "high" });
      const pendingPreview = {
        thinkingLevel: "low",
        fastMode: true,
        effectiveFastMode: true,
        contextWindow: "128k",
      };
      expect(sessions.settingsPreview(key, "main")).toEqual(pendingPreview);

      if (initialState === "published placeholder") {
        rows.push(placeholder);
        await sessions.refresh({ agentId: "main", force: true });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(placeholder);
        expect(patch).toHaveBeenCalledOnce();
      }

      firstReply.resolve(firstReceipt);
      await expect(first).resolves.toBe(true);
      for (const [index, reply] of replies.entries()) {
        const started = dispatched[index];
        const operation = queued[index];
        if (!started || !operation) {
          throw new Error("Expected each queued settings operation");
        }
        await Promise.race([started.promise, operation]);
        expect(patch).toHaveBeenCalledTimes(index + 2);
        if (index === 0) {
          expect(sessions.settingsPreview(key, "main")).toEqual(pendingPreview);
        }
        const rejected =
          outcome === "rejection" || (outcome === "reasoning rejection" && index === 0);
        if (rejected) {
          reply.reject(new Error(`Synthetic queued setting ${index} rejection`));
        } else {
          reply.resolve({
            ...firstReceipt,
            entry: {
              sessionId: firstReceipt.entry.sessionId,
              ...requested[index],
              updatedAt: index + 3,
            },
          });
        }
        await expect(operation).resolves.toBe(!rejected);
        // Releasing one field must retain the independently queued fields.
        expect.soft(sessions.settingsPreview(key, "main")).toEqual(remainingPreviews[index]);
        expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
        if (outcome === "success") {
          expect(pane.state.chatError).toBeNull();
        } else {
          // A later speed or context choice does not supersede the rejected reasoning choice.
          const failedIndex = outcome === "reasoning rejection" ? 0 : index;
          expect(pane.state.chatError).toContain(
            `Synthetic queued setting ${failedIndex} rejection`,
          );
          expect(pane.state.lastError).toBe(pane.state.chatError);
        }
      }
      expect(getPendingChatPickerPatch(pane.state, key, "main")).toBeUndefined();
    } finally {
      firstReply.resolve(firstReceipt);
      for (const reply of replies) {
        reply.resolve(firstReceipt);
      }
      await Promise.allSettled([first, ...queued]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["current", "replacement", "same-client reconnect", "failed readback", "unbound"] as const)(
  "settles queued settings against their current owner (%s)",
  async (outcome) => {
    const readbackFails = outcome === "failed readback";
    const key = "agent:main:settings";
    const row = materializedRow(key, "acknowledged-session");
    const receipt = materializationReceipt(row);
    const rows: GatewaySessionRow[] = [];
    const firstReply = createDeferred<SessionsPatchResult>();
    const latestReply = createDeferred<SessionsPatchResult>();
    const dispatched = createDeferred();
    const readbackError = new Error("Synthetic roster read failure after settings ACK");
    let acknowledged = false;
    let failedReads = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise.then((result) => {
          acknowledged = true;
          return result;
        });
      }
      dispatched.resolve();
      return latestReply.promise;
    });
    const mounted = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
      ...(readbackFails
        ? {
            "sessions.list": () => {
              if (acknowledged) {
                failedReads++;
                throw readbackError;
              }
              return sessionsResult([...rows], 1);
            },
          }
        : {}),
    });
    const pane = await mountSettingsPane(mounted, key);
    const state = pane.state;
    const selected = () => selectedChatSessionRow(state);
    const owned = outcome === "current" || outcome === "unbound";
    expect(selected()).toBeUndefined();
    const first = switchChatSetting(state, { kind: "thinkingLevel", value: "high" });
    const latest = switchChatSetting(state, { kind: "thinkingLevel", value: "low" });
    try {
      expect(patch).toHaveBeenCalledOnce();
      if (outcome === "unbound") {
        firstReply.reject(new Error("Synthetic superseded first rejection"));
      } else {
        if (outcome !== "failed readback") {
          rows.push(row);
        }
        firstReply.resolve(receipt);
      }
      await expect(first).resolves.toBe(outcome !== "unbound");
      await Promise.race([dispatched.promise, latest]);
      expect(patch).toHaveBeenCalledTimes(2);
      if (outcome === "unbound") {
        expect(patch.mock.calls[1]?.[1]).toEqual({ key, thinkingLevel: "low" });
        expect(state.chatError).toBeNull();
      } else {
        expect(patch.mock.calls[1]?.[1]).toMatchObject({
          key,
          thinkingLevel: "low",
          expectedSessionId: row.sessionId,
        });
      }
      if (outcome === "failed readback") {
        expect(failedReads).toBeGreaterThan(0);
        expect(selected()).toBeUndefined();
        expect(mounted.sessions.state.error).toBe(readbackError.message);
        expect(state.sessionsError).toBe(readbackError.message);
        latestReply.resolve({
          ...receipt,
          entry: { ...receipt.entry, thinkingLevel: "low", updatedAt: 3 },
        });
        await expect(latest).resolves.toBe(true);
        expect(mounted.sessions.state.error).toBe(readbackError.message);
        expect(state).toMatchObject({
          sessionsError: readbackError.message,
          chatError: null,
          lastError: null,
        });
        return;
      }
      if (outcome !== "unbound") {
        expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "low" });
      }
      if (outcome === "replacement") {
        rows[0] = { ...row, sessionId: "replacement-session", updatedAt: 3 };
        await mounted.sessions.refresh({ agentId: "main", force: true });
      } else if (outcome === "same-client reconnect") {
        const snapshot = mounted.context.gateway.snapshot;
        pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        pane.applyGatewaySnapshot(snapshot);
      }
      if (!owned) {
        state.lastError = state.chatError = "Synthetic current owner error";
      }
      latestReply.reject(new Error("Synthetic latest acknowledged-target rejection"));
      await expect(latest).resolves.toBe(false);
      expect(state.chatError).toContain(
        owned ? "Synthetic latest acknowledged-target rejection" : "Synthetic current owner error",
      );
      expect(state.lastError).toBe(state.chatError);
      if (outcome === "current") {
        expect(selected()).toMatchObject({ sessionId: row.sessionId, thinkingLevel: "high" });
      }
    } finally {
      firstReply.resolve(receipt);
      latestReply.resolve(receipt);
      await Promise.allSettled([first, latest]);
      await vi.dynamicImportSettled();
    }
  },
);
