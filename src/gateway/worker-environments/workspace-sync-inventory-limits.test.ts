import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  parseRemoteWorkspaceManifestEnvelope,
  workspaceStatIdentity,
} from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { sha256, workspaceFile } from "./workspace-manifest-fixtures.test-support.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  initializeScriptGitWorkspace,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const manifestWorkspace = async () =>
  createScriptWorkspace(await fs.realpath(tempDirs.make("openclaw-manifest-")));

async function gitWorkspace() {
  const fixture = await manifestWorkspace();
  const { workspace } = fixture;
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");
  return { ...fixture, baseCommit };
}

it.each([
  { firstSize: 8, secondSize: 11, cached: true, accepted: true },
  { firstSize: 8, secondSize: 12, cached: true, accepted: false },
  { firstSize: 12, secondSize: 7, cached: false, accepted: true },
])(
  "budgets opened files ($firstSize + $secondSize) and symlink bytes with cached=$cached",
  async ({ firstSize, secondSize, cached, accepted }) => {
    const { root, workspace, manifestRoot, readManifest, runScript } = await manifestWorkspace();
    const first = path.join(workspace, "a.txt");
    const second = path.join(workspace, "b.txt");
    const auditPath = path.join(root, "handles.json");
    const contents = Buffer.alloc(8, 65);
    await Promise.all([fs.writeFile(first, contents), fs.writeFile(second, contents)]);
    await fs.symlink("a.txt", path.join(workspace, "link"));
    const digest = createHash("sha256").update(contents).digest("hex");
    const memo = cached
      ? [[workspaceStatIdentity("worker", await fs.stat(first, { bigint: true })), digest]]
      : [];
    // Keep real descriptors and hashing; resize only after inventory, at open.
    const prelude = String.raw`{
      const io = require("node:fs");
      const sizes = new Map(${JSON.stringify([
        [first, firstSize],
        [second, secondSize],
      ])});
      const handles = [];
      const open = io.promises.open.bind(io.promises);
      io.promises.open = async (...args) => {
        const size = sizes.get(args[0]);
        if (size !== undefined && io.statSync(args[0]).size !== size) {
          io.truncateSync(args[0], size);
        }
        const handle = await open(...args);
        if (size !== undefined) handles.push(handle);
        return handle;
      };
      process.once("exit", () => io.writeFileSync(
        ${JSON.stringify(auditPath)}, JSON.stringify(handles.map((handle) => handle.fd === -1)),
      ));
    }
    `;
    // Scale the existing limit so this race uses bytes, not GiB of I/O.
    const script = REMOTE_WORKSPACE_MANIFEST_JS.replace(
      `const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES};`,
      "const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = 24;",
    );
    expect(script).not.toBe(REMOTE_WORKSPACE_MANIFEST_JS);
    const result = await runScript(prelude + script)(["", "all", "memo-v1"], {
      input: JSON.stringify(memo),
    });
    expect(JSON.parse(await fs.readFile(auditPath, "utf8"))).toEqual([true, true]);
    if (!accepted) {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("eligible byte limit");
      expect(result.stdout).toBe("");
      expect(await fs.readdir(manifestRoot)).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(result.stdout) as {
      manifestRef: string;
      metrics: { contentHashCount: number; memoHitCount: number };
    };
    expect(response.metrics).toMatchObject({
      contentHashCount: cached ? 1 : 2,
      memoHitCount: cached ? 1 : 0,
    });
    const manifest = await readManifest(response.manifestRef);
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: "a.txt", type: "file", size: firstSize }),
      expect.objectContaining({ path: "b.txt", type: "file", size: secondSize }),
      expect.objectContaining({ path: "link", type: "symlink", target: "a.txt" }),
    ]);
  },
);

it("stops hashing a growing file at its opened size and settles its stream and handle", async () => {
  const { root, workspace, manifestRoot, runScript } = await manifestWorkspace();
  const target = path.join(workspace, "growing.txt");
  const auditPath = path.join(root, "stream.json");
  await fs.writeFile(target, "12345678");
  const prelude = String.raw`{
    const io = require("node:fs");
    const crypto = require("node:crypto");
    const target = ${JSON.stringify(target)};
    const audit = { consumed: 0, hashed: 0, grew: false, streamClosed: false };
    let opened;
    let reading;
    const createHash = crypto.createHash.bind(crypto);
    crypto.createHash = (...args) => {
      const hash = createHash(...args);
      const update = hash.update.bind(hash);
      hash.update = (chunk, ...options) => {
        audit.hashed += chunk.length;
        return update(chunk, ...options);
      };
      return hash;
    };
    const open = io.promises.open.bind(io.promises);
    io.promises.open = async (...args) => {
      const handle = await open(...args);
      if (args[0] !== target) return handle;
      opened = handle;
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        const stream = createReadStream({ ...options, highWaterMark: 2 });
        reading = stream;
        stream.on("data", (chunk) => {
          audit.consumed += chunk.length;
          if (!audit.grew) {
            audit.grew = true;
            io.appendFileSync(target, Buffer.alloc(64));
          }
        });
        stream.once("close", () => { audit.streamClosed = true; });
        return stream;
      };
      return handle;
    };
    process.once("exit", () => io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
      ...audit, handleClosed: opened.fd === -1, streamDestroyed: reading.destroyed,
    })));
  }
  `;
  const result = await runScript(prelude + REMOTE_WORKSPACE_MANIFEST_JS)();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("file changed while it was being read");
  expect(result.stdout).toBe("");
  const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as {
    consumed: number;
    hashed: number;
  };
  expect(audit).toMatchObject({
    grew: true,
    handleClosed: true,
    streamClosed: true,
    streamDestroyed: true,
  });
  expect(audit.consumed).toBeLessThan(72);
  expect(audit.hashed).toBeLessThanOrEqual(8);
  expect((await fs.stat(target)).size).toBe(72);
  expect(await fs.readdir(manifestRoot)).toEqual([]);
});

it.each([
  ["full workspace above 4 GiB", "eligible byte limit"],
  ["prior manifest above the entry limit", "invalid prior workspace manifest"],
])("rejects a %s", async (kind, message) => {
  const { workspace, baseCommit, manifestRoot, runManifest } = await gitWorkspace();
  const args = [baseCommit, "eligible"];
  if (kind.startsWith("full")) {
    const oversized = path.join(workspace, "oversized.bin");
    await fs.writeFile(oversized, "");
    await fs.truncate(oversized, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);
  } else {
    await fs.mkdir(manifestRoot, { recursive: true });
    const raw = JSON.stringify({
      version: 1,
      baseCommit: null,
      entries: Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES + 1 }, () => null),
    });
    const digest = createHash("sha256").update(raw).digest("hex");
    await fs.writeFile(path.join(manifestRoot, digest + ".json"), raw);
    args.push(digest);
  }
  const result = await runManifest(args);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
});

it("budgets raw Git candidates separately from materialized eligible inventory", async () => {
  expect(MAX_WORKSPACE_GIT_CANDIDATES).toBe(4 * MAX_WORKSPACE_INVENTORY_ENTRIES);
  const { home, baseCommit, runManifest: run, readManifest } = await gitWorkspace();
  const bin = path.join(home, "bin");
  const mockGit = path.join(bin, "git");
  await fs.mkdir(bin);
  await fs.writeFile(
    mockGit,
    `#!/usr/bin/env node
const count = Number(process.env.OPENCLAW_TEST_GIT_CANDIDATES);
process.stdout.write("missing\\0".repeat(count));
`,
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_INVENTORY_ENTRIES + 1),
  };

  const accepted = await run([baseCommit, "eligible"], { timeoutMs: 20_000, baseEnv });
  expect(accepted.code, accepted.stderr).toBe(0);
  const manifestRef = accepted.stdout.trim();
  expect(manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  const manifest = await readManifest(manifestRef);
  expect(manifest.entries).toEqual([]);

  const rejected = await run([baseCommit, "eligible"], {
    timeoutMs: 20_000,
    baseEnv: {
      ...baseEnv,
      OPENCLAW_TEST_GIT_CANDIDATES: String(MAX_WORKSPACE_GIT_CANDIDATES + 1),
    },
  });
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("too many Git path candidates");
}, 30_000);

async function auditedWorkspace() {
  const { root, home, workspace, runScript } = await manifestWorkspace();
  const auditPath = path.join(root, "audit.json");
  return {
    home,
    workspace,
    capture: async (prelude: string, args: string[] = [], memo?: Array<[string, string]>) => {
      const instrument = String.raw`{
        const io = require("node:fs"), open = io.promises.open.bind(io.promises);
        const handles = [], audit = {};
        const closed = () => handles.every((handle) => handle.fd === -1);
        ${prelude}
        for (const output of [process.stdout, process.stderr]) {
          const write = output.write.bind(output);
          output.write = (...args) => { audit.atResult = snapshot(); return write(...args); };
        }
        process.once("exit", () => io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
          ...audit, ...snapshot(), opened: handles.length, closed: closed(),
        })));
      }
      `;
      const result = await runScript(instrument + REMOTE_WORKSPACE_MANIFEST_JS)(args, {
        input: JSON.stringify(memo),
      });
      const audit: Record<string, unknown> = JSON.parse(await fs.readFile(auditPath, "utf8"));
      return { result, audit };
    },
  };
}

it("hashes concurrently within four readers and preserves manifest and memo ordering", async () => {
  const { home, workspace, capture } = await auditedWorkspace();
  const entries = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const name = `${index}.bin`;
      const content = Buffer.alloc(1024, index);
      const file = path.join(workspace, name);
      await fs.writeFile(file, content, { mode: 0o600 });
      return workspaceFile(name, content);
    }),
  );
  const prelude = String.raw`
    let active = 0;
    audit.maximum = 0;
    const snapshot = () => ({ active });
    io.promises.open = async (...args) => {
      active++;
      audit.maximum = Math.max(audit.maximum, active);
      const handle = await open(...args);
      handles.push(handle);
      const close = handle.close.bind(handle);
      let closed = false;
      handle.close = async () => {
        await close();
        if (!closed) { closed = true; active--; }
      };
      return handle;
    };
  `;
  let memo: Array<[string, string]> = [];
  let manifestRef: string | undefined;
  for (const cached of [false, true]) {
    const { result, audit } = await capture(prelude, ["", "all", "memo-v1"], memo);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = parseRemoteWorkspaceManifestEnvelope(result.stdout);
    expect(response.metrics).toMatchObject({
      contentHashCount: cached ? 0 : entries.length,
      memoHitCount: cached ? entries.length : 0,
      memoTruncatedCount: 0,
    });
    const raw = await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${response.manifestRef.slice(7)}.json`),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ version: 1, baseCommit: null, entries });
    expect(response.manifestRef).toBe(`sha256:${sha256(raw)}`);
    if (cached) {
      expect(response.manifestRef).toBe(manifestRef);
      expect(response.memo).toEqual(memo);
    }
    memo = response.memo;
    manifestRef = response.manifestRef;
    expect(audit).toMatchObject({ atResult: { active: 0 }, closed: true, opened: entries.length });
    expect(audit.maximum).toBeGreaterThan(1);
    expect(audit.maximum).toBeLessThanOrEqual(4);
  }
});

it.each(["pending-open", "active-reader"] as const)(
  "preserves the first failure and joins a %s before reporting it",
  async (mode) => {
    const { home, workspace, capture } = await auditedWorkspace();
    const first = path.join(workspace, "a.bin");
    const second = path.join(workspace, "b.bin");
    await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, Buffer.alloc(64))]);
    // Real opens and streams are held at their I/O boundaries, without a timing race.
    const prelude = String.raw`
      const first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)};
      const mode = ${JSON.stringify(mode)};
      const openGate = Promise.withResolvers(), readGate = Promise.withResolvers();
      let pending = 0, secondStarted = false, reading;
      Object.assign(audit, { readStarted: false, secondStats: 0 });
      const snapshot = () => ({ pending, closed: closed(), streamDestroyed: reading?.destroyed });
      io.promises.open = async (...args) => {
        const file = args[0];
        if (file === second) secondStarted = true;
        pending++;
        if (file === second && mode === "pending-open") await openGate.promise;
        const handle = await open(...args);
        pending--;
        handles.push(handle);
        const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
        handle.stat = async (...options) => {
          if (file === first) {
            if (mode === "active-reader" && secondStarted) await readGate.promise;
            throw new Error("first manifest failure");
          }
          audit.secondStats++;
          return stat(...options);
        };
        handle.close = async () => {
          await close();
          if (file === first) {
            await new Promise((resolve) => setImmediate(resolve));
            openGate.resolve();
            throw new Error("secondary close failure");
          }
        };
        if (file === second && mode === "active-reader") {
          const createReadStream = handle.createReadStream.bind(handle);
          handle.createReadStream = (options) => {
            const stream = createReadStream({ ...options, highWaterMark: 2 });
            reading = stream;
            const iterate = stream[Symbol.asyncIterator].bind(stream);
            const aborted = new Promise((resolve) => {
              if (options.signal?.aborted) resolve();
              else options.signal?.addEventListener("abort", resolve, { once: true });
            });
            stream[Symbol.asyncIterator] = async function* () {
              for await (const chunk of iterate()) {
                audit.readStarted = true;
                readGate.resolve();
                await aborted;
                yield chunk;
              }
            };
            return stream;
          };
        }
        return handle;
      };
    `;
    const { result, audit } = await capture(prelude);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("first manifest failure");
    expect(result.stderr).not.toContain("secondary close failure");
    expect(audit).toMatchObject({
      opened: 2,
      pending: 0,
      closed: true,
      readStarted: mode === "active-reader",
      atResult: { pending: 0, closed: true },
    });
    expect(audit).toMatchObject(
      mode === "pending-open" ? { secondStats: 0 } : { streamDestroyed: true },
    );
    expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
  },
);
