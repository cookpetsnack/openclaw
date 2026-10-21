import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";

it.runIf(process.env.OPENCLAW_SESSION_PUBLICATIONS_BENCH === "1")(
  "reuses selection over 8,000 rows with ten appends and three list calls per simulated second",
  () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      setRuntimeConfigSnapshot(cfg);
      const clients = [0, 1, 2].map((index) =>
        identifiedClient(ensureProfileForEmail(`list-bench-${index}@example.test`).id),
      );
      writeResidentEntries(
        Object.fromEntries(
          Array.from({ length: 8_000 }, (_, index) => [
            `agent:main:dashboard:bench-${index}`,
            { sessionId: `bench-${index}`, updatedAt: index + 1, visibility: "shared" as const },
          ]),
        ),
      );
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const scans = vi.spyOn(projection, "selectEntries");
      const rpc = async (client: (typeof clients)[number]) => {
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "benchmark", method: "sessions.list" },
          params: {},
          client,
          context,
          isWebchatConnect: () => false,
          respond(ok, result) {
            expect(ok).toBe(true);
            const page = result as SessionsListResult;
            expect(page.sessions).toHaveLength(100);
            expect(page.totalCount).toBe(8_000);
            JSON.stringify(page);
          },
        });
      };
      try {
        await projection.ensureMaterialized();
        for (let warmup = 0; warmup < 5; warmup++) {
          for (const client of clients) {
            await rpc(client);
          }
        }
        scans.mockClear();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        for (let tick = 0; tick < 240; tick++) {
          const index = 7_997 + (tick % 3);
          const target = {
            agentId: "main",
            sessionId: `bench-${index}`,
            sessionKey: `agent:main:dashboard:bench-${index}`,
          };
          runOpenClawAgentWriteTransaction(
            (database) =>
              appendTranscriptEventsInTransaction(database, target, [
                {
                  type: "message",
                  id: `append-${tick}`,
                  message: { role: "assistant", content: "Synthetic stream" },
                },
              ]),
            { agentId: "main" },
          );
          emitSessionTranscriptUpdate({ target });
          await vi.advanceTimersByTimeAsync(100);
          await projection.ensureMaterialized();
          const clientIndex = [0, 3, 6].indexOf(tick % 10);
          if (clientIndex >= 0) {
            await rpc(clients[clientIndex]!);
          }
        }
        expect(scans.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      } finally {
        scans.mockRestore();
        projection.dispose();
        release();
        vi.useRealTimers();
      }
    }),
  120_000,
);
