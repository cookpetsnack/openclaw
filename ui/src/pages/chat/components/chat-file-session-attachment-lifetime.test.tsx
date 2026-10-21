/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createComposerProps, resetComposerFixture } from "../chat-composer.test-support.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

afterEach(async () => {
  document.body.replaceChildren();
  await resetComposerFixture();
  vi.unstubAllGlobals();
});

it.each(["content", "destination"] as const)(
  "the native detail bridge retires a held transfer before %s publication",
  async (change) => {
    const held = createDeferredCore<SessionFileDownload | null>();
    const fetcher = vi.fn(async () => new Response("Retired bytes"));
    vi.stubGlobal("fetch", fetcher);
    const attachments: ChatAttachment[] = [];
    let balance = 0;
    let signal: AbortSignal | undefined;
    const chat = createComposerProps({
      getAttachments: () => attachments,
      onAttachmentsChange: (next) => {
        attachments.splice(0, attachments.length, ...next);
      },
      onPendingReadsChange: (delta) => {
        balance += delta;
      },
    });
    const panel = document.createElement("openclaw-chat-detail-panel");
    panel.attachmentRuntime = { connectionEpoch: 1 };
    panel.attachmentChat = chat;
    panel.content = {
      kind: "markdown",
      content: "Synthetic file preview",
      fileDownload: {
        path: "notes.md",
        name: "notes.md",
        download: (nextSignal) => {
          signal = nextSignal;
          return held.promise;
        },
      },
    };
    const container = createChatSidebarContainer();
    container.append(panel);
    document.body.append(container);
    await panel.updateComplete;
    await waitForSolid(() =>
      expect(panel.querySelector('[aria-label="More file actions"]')).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>('[aria-label="More file actions"]')!.click();
    let attach: HTMLElement | undefined;
    await waitForSolid(() => {
      attach = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent?.includes("Attach to session"),
      );
      expect(attach).toBeDefined();
    });
    attach!.click();
    expect(balance).toBe(1);
    await Promise.resolve();
    if (change === "content") {
      panel.content = { kind: "markdown", content: "Replacement preview" };
    } else {
      panel.attachmentChat = { ...chat, sessionKey: "agent:main:replacement" };
    }
    expect(signal?.aborted).toBe(true);
    expect(balance).toBe(0);
    await panel.updateComplete;
    held.resolve({
      filename: "notes.md",
      url: "/api/artifacts/download/synthetic-notes/synthetic-ticket",
    });
    await held.promise;
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    expect(attachments).toEqual([]);
    expect(balance).toBe(0);
  },
);
