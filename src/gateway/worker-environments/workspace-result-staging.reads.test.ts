import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import * as gitWorker from "../../infra/git-worker.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as commandRuntime from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import type { GitHubRepositoryPublicationSnapshot } from "../github-repository-publication-snapshot.js";
import {
  captureWorkspaceSnapshot,
  prepareWorkspaceStageInput,
} from "./workspace-manifest-worker.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { updateWorkspaceResultRefs, workspaceResultGitCommand } from "./workspace-result-git.js";
import { buildWorkspaceStageInput } from "./workspace-result-preparation.runtime.js";
import {
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  readStagedWorkerWorkspaceResult,
  preparedWorkerWorkspaceResultRef,
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const manifestRef = (raw: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const manifest = (entries: WorkerWorkspaceManifestEntry[]) =>
  serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries });
type FixtureOptions = {
  largeFileBytes?: number;
  objectFormat?: "sha1" | "sha256";
  linked?: boolean;
};
function flipByte(bytes: Buffer, index: number, mask = 0xff) {
  bytes[index] = bytes[index]! ^ mask;
  return bytes;
}

function corruptBatch(
  repository: string,
  corrupt: (bytes: Buffer) => Buffer,
  matches = (args: string[]) => args.includes("--batch"),
) {
  const runBuffered = commandRuntime.runCommandBuffered;
  const transform = vi.fn(corrupt);
  vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
    const result = await runBuffered(argv, options);
    if (
      argv[argv.indexOf("-C") + 1] === repository &&
      matches(argv.slice(argv.indexOf("-C") + 2))
    ) {
      return { ...result, stdout: transform(Buffer.from(result.stdout)) };
    }
    return result;
  });
  return transform;
}

const git = (root: string, args: string[]) =>
  requireGit(root, ["-c", "core.longpaths=true", ...args], { timeoutMs: 10_000 });

async function stagedFixture(
  fileCount = 64,
  { largeFileBytes = 0, objectFormat = "sha1", linked = false }: FixtureOptions = {},
) {
  const root = await fs.realpath(tempDirs.make("workspace-staged-reads-"));
  let repository = path.join(
    root,
    linked
      ? (process.platform === "win32" ? "repository-" : "repository-\n").padEnd(
          190 - root.length - 1,
          "r",
        )
      : "repository",
  );
  const input = path.join(root, "input");
  await Promise.all([fs.mkdir(repository), fs.mkdir(input)]);
  if (objectFormat === "sha256" || linked) {
    await git(repository, ["init", "--quiet", "--template=", `--object-format=${objectFormat}`]);
  }
  if (linked) {
    await git(repository, ["config", "core.longpaths", "false"]);
    await git(repository, [
      "-c",
      "user.name=Workspace Test",
      "-c",
      "user.email=workspace@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const linkedRoot = path.join(
      root,
      process.platform === "win32" ? "linked-result-worktree" : "linked\nresult-worktree",
    );
    await git(repository, ["worktree", "add", "--quiet", "--detach", "--", linkedRoot, "HEAD"]);
    vi.stubEnv("GIT_COMMON_DIR", path.relative(linkedRoot, path.join(repository, ".git")));
    repository = linkedRoot;
  }
  const originalHead = linked ? await git(repository, ["rev-parse", "HEAD"]) : undefined;
  const files = new Map<string, Buffer>();
  for (let index = 0; index < fileCount; index++) {
    files.set(`file-${String(index).padStart(3, "0")}.txt`, Buffer.from(`payload ${index}\n`));
  }
  const binaryPath = process.platform === "win32" ? "binary.bin" : "binary\nname.bin";
  files.set(binaryPath, Buffer.from([0, 10, 255, 13, 10, 0, 65]));
  files.set("executable.sh", Buffer.from("#!/bin/sh\nexit 0\n"));
  if (largeFileBytes) {
    files.set("large.bin", Buffer.alloc(largeFileBytes, 0x5a));
  }
  const entries: WorkerWorkspaceManifestEntry[] = [];
  for (const [entryPath, content] of files) {
    const target = path.join(input, entryPath);
    await fs.writeFile(target, content, { mode: entryPath === "executable.sh" ? 0o755 : 0o644 });
    const mode = (await fs.stat(target)).mode & 0o111 ? 0o755 : 0o644;
    entries.push({
      path: entryPath,
      type: "file",
      mode,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  if (process.platform !== "win32") {
    await fs.symlink(binaryPath, path.join(input, "current-link"));
    entries.push({ path: "current-link", type: "symlink", mode: 0o777, target: binaryPath });
  }
  const baseManifestRaw = manifest([]);
  const currentManifestRaw = manifest(entries);
  const publishedRef = workerWorkspaceResultRef("read-batch");
  const stagedResultRef = linked ? preparedWorkerWorkspaceResultRef(publishedRef) : publishedRef;
  const commit = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: repository,
    stagingRoot: input,
    stagedResultRef,
    baseManifestRaw,
    currentManifestRaw,
    baseManifestRef: manifestRef(baseManifestRaw),
    currentManifestRef: manifestRef(currentManifestRaw),
  });
  return {
    read: (use: Parameters<typeof withStagedWorkerWorkspaceResult>[1]) =>
      withStagedWorkerWorkspaceResult({ root: repository, stagedResultRef }, use),
    repository,
    stagedResultRef,
    publishedRef,
    originalHead,
    commit,
    files,
    binaryPath,
  };
}

describe("staged workspace reads", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await drainGlobalSingletonLifecycleState();
    vi.unstubAllEnvs();
  });
  it.each<[number, number, FixtureOptions]>([
    [64, 4, { linked: true }],
    [300, 6, {}],
    [0, 4, { largeFileBytes: 9 * 1024 * 1024 }],
    [0, 4, { objectFormat: "sha256" }],
  ])(
    "materializes %i files with at most %i Git reads (%j)",
    async (fileCount, maxReads, fixtureOptions) => {
      const fixture = await stagedFixture(fileCount, fixtureOptions);
      expect(fixture.commit).toBe(
        await git(fixture.repository, ["rev-parse", `${fixture.stagedResultRef}^{commit}`]),
      );
      const gitReads: string[][] = [];
      const runBuffered = commandRuntime.runCommandBuffered;
      vi.spyOn(commandRuntime, "runCommandBuffered").mockImplementation(async (argv, options) => {
        if (argv[argv.indexOf("-C") + 1] === fixture.repository) {
          gitReads.push(argv.slice(argv.indexOf("-C") + 2, argv.indexOf("-C") + 4));
        }
        return await runBuffered(argv, options);
      });
      const writes = vi.spyOn(fs, "writeFile");
      const links = vi.spyOn(fs, "symlink");
      let stagingRoot = "";
      await fixture.read(async (snapshot) => {
        stagingRoot = snapshot.stagingRoot;
        for (const entry of snapshot.changedEntries) {
          const target = path.join(stagingRoot, entry.path);
          if (entry.type === "symlink") {
            expect(await fs.readlink(target)).toBe(entry.target);
          } else {
            // Node compares Buffer bytes without Vitest's per-byte object traversal.
            assert.deepStrictEqual(await fs.readFile(target), fixture.files.get(entry.path));
            if (process.platform !== "win32") {
              expect((await fs.stat(target)).mode & 0o777).toBe(entry.mode);
            }
          }
        }
        const materialized = [
          ...writes.mock.calls.map(([target]) => {
            assert(typeof target === "string");
            return target;
          }),
          ...links.mock.calls.map(([, target]) => String(target)),
        ];
        expect(
          materialized.filter((target) => target.startsWith(stagingRoot + path.sep)).toSorted(),
        ).toEqual(
          snapshot.changedEntries.map((entry) => path.join(stagingRoot, entry.path)).toSorted(),
        );
      });
      await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(gitReads.length, JSON.stringify(gitReads)).toBeLessThanOrEqual(maxReads);
      if (fixtureOptions.linked) {
        const root = fixture.repository;
        const refParams = (stagedResultRef: string) => ({ root, stagedResultRef });
        const hasRef = (ref: string) => hasWorkerWorkspaceResultRef(refParams(ref));
        await updateWorkspaceResultRefs(fixture.repository, [
          { ref: fixture.publishedRef, objectId: fixture.commit },
          { ref: fixture.stagedResultRef },
        ]);
        await expect(hasRef(fixture.stagedResultRef)).resolves.toBe(false);
        const cleanupRef = await moveStagedWorkerWorkspaceResultToCleanup(
          refParams(fixture.publishedRef),
        );
        await expect(hasRef(cleanupRef)).resolves.toBe(true);
        await deleteWorkerWorkspaceResultCleanupRefs({ root: fixture.repository });
        await expect(hasRef(cleanupRef)).resolves.toBe(false);
        expect(await fs.readdir(fixture.repository)).toEqual([".git"]);
        expect(await git(fixture.repository, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
        expect(
          await git(fixture.repository, ["config", "--local", "--get", "core.longpaths"]),
        ).toBe("false");
      }
    },
  );

  it.each(
    (["oid", "type", "size", "digest", "truncated", "trailing", "symlink"] as const).filter(
      (corruption) => corruption !== "symlink" || process.platform !== "win32",
    ),
  )(
    "rejects a batch with invalid %s before writing staged files and cleans its temporary directory",
    async (corruption) => {
      const fixture = await stagedFixture(0);
      const corrupted = corruptBatch(fixture.repository, (bytes) => {
        const headerEnd = bytes.indexOf(0x0a);
        expect(headerEnd).toBeGreaterThan(0);
        switch (corruption) {
          case "oid":
            bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
            return bytes;
          case "type":
            bytes.write("tree", bytes.indexOf(" blob ") + 1);
            return bytes;
          case "size":
            return Buffer.concat([
              Buffer.from(bytes.subarray(0, headerEnd).toString("utf8").replace(/\d+$/u, "0")),
              bytes.subarray(headerEnd),
            ]);
          case "digest":
            return flipByte(bytes, headerEnd + 1);
          case "truncated":
            return bytes.subarray(0, -1);
          case "trailing":
            return Buffer.concat([bytes, Buffer.from([0])]);
          case "symlink": {
            const target = bytes.indexOf(fixture.binaryPath);
            expect(target).toBeGreaterThan(0);
            return flipByte(bytes, target, 1);
          }
          default:
            throw new Error("Unexpected corruption fixture");
        }
      });
      const temporary = vi.spyOn(fs, "mkdtemp");
      const writes = vi.spyOn(fs, "writeFile");
      const links = vi.spyOn(fs, "symlink");
      const use = vi.fn(async () => {});
      await expect(fixture.read(use)).rejects.toThrow(
        corruption === "symlink" ? "payload is invalid: current-link" : "payload",
      );
      expect(corrupted).toHaveBeenCalledOnce();
      for (const effect of [use, writes, links]) {
        expect(effect).not.toHaveBeenCalled();
      }
      expect(temporary).toHaveBeenCalledOnce();
      const created = temporary.mock.results[0];
      assert(created?.type === "return", "Staging did not create its temporary directory");
      await expect(fs.stat(await created.value)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("authenticates the singleton blob returned by checkpoint previews", async () => {
    const fixture = await stagedFixture(0);
    const corrupted = corruptBatch(
      fixture.repository,
      (stdout) => flipByte(stdout, stdout.indexOf(0x0a) + 1),
      (args) => args[0] === "cat-file" && args[1] === "--batch",
    );
    await expect(
      runGitWorkerOperation({
        type: "workspace.artifacts",
        input: {
          root: fixture.repository,
          ref: fixture.stagedResultRef,
          previewPath: fixture.binaryPath,
        },
      }),
    ).rejects.toThrow("payload is invalid");
    expect(corrupted).toHaveBeenCalledOnce();
  });
});

const baseCommit = "a".repeat(40);
const currentManifestRef = "sha256:" + "b".repeat(64);
const candidate = (name: string) => "refs/openclaw/worker-result-candidates/" + name;
const blobId = (content: Buffer) =>
  createHash("sha1")
    .update("blob " + content.byteLength + "\0")
    .update(content)
    .digest("hex");
const emptyManifestRaw = manifest([]);
type PublicationEntry = GitHubRepositoryPublicationSnapshot["entries"][number];
const binding = (publication: { currentManifestRef: string; publicationDigest: string }) =>
  JSON.stringify({
    currentManifestRef: publication.currentManifestRef,
    publicationDigest: publication.publicationDigest,
  });
const write = (root: string, name: string, bytes: string | Buffer) =>
  fs.writeFile(path.join(root, name), bytes, { mode: 0o600 });
const blobPath = (root: string, sha: string) => path.join(root, "blobs", sha);
type InvalidPublicationCase = {
  fault: string;
  blob?: "missing" | "hardlink";
  error?: string | RegExp;
  code?: string;
  metadata?: string;
  baseCommit?: string;
  entry?: { mode: string };
  duplicate?: boolean;
};

async function publicationFixture(kind: "metadata-only" | "mixed" = "mixed") {
  const stagingRoot = tempDirs.make("workspace-publication-source-");
  const blobs = new Map<string, Buffer>();
  const entries: PublicationEntry[] = [];
  const add = (pathname: string, mode: PublicationEntry["mode"], content: Buffer) => {
    const sha = blobId(content);
    blobs.set(sha, content);
    entries.push({ path: pathname, mode, sha });
  };
  if (kind === "mixed") {
    add("run.sh", "100755", Buffer.from("#!/bin/sh\nprintf hello\n"));
    add("copy.sh", "100644", Buffer.from("#!/bin/sh\nprintf hello\n"));
    add("link", "120000", Buffer.from("run.sh"));
    add("empty", "100644", Buffer.alloc(0));
    add("binary", "100644", Buffer.from([0, 255, 128, 13, 10, 0]));
    add("文書/é.txt", "100644", Buffer.from("雪だるま ☃\r\nemoji 🦞\n"));
  }
  entries.push(
    { path: "deleted.txt", mode: "100644", sha: null },
    { path: "submodule", mode: "160000", sha: "c".repeat(40) },
  );
  // Deliberately noncanonical JSON: preservation must not depend on parser key order.
  const metadata =
    " \n" +
    JSON.stringify(
      { entries, workspaceTree: "d".repeat(40), version: 1, baseTree: "e".repeat(40), baseCommit },
      null,
      2,
    ) +
    "\n\t";
  const publication = {
    metadata,
    publicationDigest: manifestRef(metadata),
    currentManifestRef,
    baseCommit,
  };
  await fs.mkdir(path.join(stagingRoot, "blobs"), { mode: 0o700 });
  await write(stagingRoot, "snapshot.json", metadata);
  for (const [sha, bytes] of blobs) {
    await write(stagingRoot, "blobs/" + sha, bytes);
  }
  const contents = new Map<string, Buffer>([
    ["snapshot.json", Buffer.from(metadata)],
    ["binding.json", Buffer.from(binding(publication))],
    ...[...blobs].map(([sha, bytes]): [string, Buffer] => ["blobs/" + sha, bytes]),
  ]);
  return { stagingRoot, publication, blobs, contents };
}

async function legacyPayload(f: Awaited<ReturnType<typeof publicationFixture>>) {
  const root = tempDirs.make("workspace-publication-legacy-");
  // Fixture-owned bytes keep the legacy oracle independent of publication readers.
  await fs.mkdir(path.join(root, "blobs"), { mode: 0o700 });
  for (const [pathname, bytes] of f.contents) {
    await write(root, pathname, bytes);
  }
  const captured = await captureWorkspaceSnapshot({ root, baseCommit: null });
  return {
    stagingRoot: root,
    baseManifestRaw: emptyManifestRaw,
    baseManifestRef: manifestRef(emptyManifestRaw),
    currentManifestRaw: captured.rawManifest,
    currentManifestRef: captured.manifestRef,
  };
}

async function sourceInventory(root: string) {
  const entries = [];
  for (const relative of ["", ...(await fs.readdir(root, { recursive: true })).toSorted()]) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute, { bigint: true });
    entries.push({
      relative,
      mode: stat.mode,
      ino: stat.ino,
      nlink: stat.nlink,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      bytes: stat.isFile() ? await fs.readFile(absolute) : undefined,
    });
  }
  return entries;
}

async function gitRaw(root: string, args: string[]) {
  const result = await runUtf8CommandWithTimeout(workspaceResultGitCommand(root, args), {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  expect(result, result.stderr).toMatchObject({ termination: "exit", code: 0 });
  return result.stdout;
}

async function stagedContents(
  snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>,
) {
  const contents = new Map<string, Buffer>();
  for await (const { entry, content } of snapshot.readEntries()) {
    expect(entry).toMatchObject({ type: "file", mode: 0o644 });
    expect(content).toBeDefined();
    contents.set(entry.path, Buffer.from(content!));
  }
  return contents;
}

describe("publication companion input", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["metadata-only", "mixed"] as const)(
    "imports the exact legacy companion artifact across the real worker boundary (%s)",
    async (kind) => {
      const f = await publicationFixture(kind);
      if (kind === "mixed") {
        const orphan = Buffer.from("unlisted blob must not enter the companion");
        await fs.writeFile(blobPath(f.stagingRoot, blobId(orphan)), orphan);
        await fs.writeFile(path.join(f.stagingRoot, "binding.json"), "untrusted unlisted binding");
        await fs.mkdir(path.join(f.stagingRoot, "unlisted"));
        await fs.writeFile(path.join(f.stagingRoot, "unlisted", "extra"), "do not copy");
      } else {
        expect(await fs.readdir(path.join(f.stagingRoot, "blobs"))).toEqual([]);
      }
      const sourceBefore = await sourceInventory(f.stagingRoot);
      const legacy = await legacyPayload(f);
      const root = tempDirs.make("workspace-publication-result-");
      const oldRef = candidate("legacy");
      const newRef = candidate("direct");
      const assertCurrent = vi.fn(() => {});
      // Call-through only: no worker-context bypass or fake Git input/import.
      const operations = vi.spyOn(gitWorker, "runGitWorkerOperation");
      const oldOid = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root,
        ...legacy,
        stagedResultRef: oldRef,
        assertCurrent,
      });
      const newOid = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root,
        stagingRoot: f.stagingRoot,
        stagedResultRef: newRef,
        publication: f.publication,
        assertCurrent,
      });
      expect(newOid).toBe(oldOid);
      expect(assertCurrent).toHaveBeenCalled();
      const stageInputs = operations.mock.calls.flatMap(([command]) =>
        command.type === "workspace.manifest.stage-input" ? [command.input] : [],
      );
      expect(stageInputs).toHaveLength(2);
      for (const input of stageInputs) {
        expect(input).not.toHaveProperty("assertCurrent");
        expect(input).not.toHaveProperty("root");
        if ("publication" in input) {
          expect(input.publication.metadata).toBeInstanceOf(Uint8Array);
          expect(input.publication.metadata.byteLength).toBe(0);
        } else {
          expect(input).toMatchObject({
            baseManifestRaw: { byteLength: 0 },
            currentManifestRaw: { byteLength: 0 },
          });
        }
      }
      const newResult = await readStagedWorkerWorkspaceResult(root, newRef);
      const { stagingRoot: _stagingRoot, ...manifests } = legacy;
      expect(newResult).toMatchObject({ ...manifests, current: { directories: ["blobs"] } });
      expect(newResult.base).toEqual({
        version: 1,
        baseCommit: null,
        directories: [],
        entries: [],
      });
      // The reader verifies tree modes against these manifest entries before exposing bytes.
      expect(await stagedContents(newResult)).toEqual(f.contents);
      const commit = await gitRaw(root, ["cat-file", "commit", newRef]);
      const separator = commit.indexOf("\n\n");
      expect(commit.slice(0, separator)).toMatch(
        /^tree [a-f0-9]{40}\nauthor OpenClaw <openclaw@localhost> 0 \+0000\ncommitter OpenClaw <openclaw@localhost> 0 \+0000$/u,
      );
      expect(commit.slice(separator + 2)).toBe(
        [
          "OpenClaw worker workspace result",
          "version 2",
          `base-ref ${legacy.baseManifestRef}`,
          `current-ref ${legacy.currentManifestRef}`,
          `base-bytes ${Buffer.byteLength(legacy.baseManifestRaw)}`,
          `current-bytes ${Buffer.byteLength(legacy.currentManifestRaw)}`,
          "",
          legacy.baseManifestRaw + legacy.currentManifestRaw,
        ].join("\n"),
      );
      expect(await gitRaw(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
        newRef + " " + newOid + "\n" + oldRef + " " + oldOid + "\n",
      );
      expect(await sourceInventory(f.stagingRoot)).toEqual(sourceBefore);
    },
  );

  it.for<InvalidPublicationCase>([
    { fault: "json", metadata: "{invalid JSON" },
    { fault: "base", baseCommit: "f".repeat(40), error: /base/i },
    { fault: "mode", entry: { mode: "100600" }, error: /entry/i },
    { fault: "duplicate-path", duplicate: true, error: /entry/i },
    { fault: "missing", blob: "missing", code: "not-found" },
    { fault: "hardlink", blob: "hardlink", code: "hardlink" },
  ])("rejects invalid publication input: $fault", async (test, context) => {
    const { blob, code, error } = test;
    // Windows link privileges and identity differ; retain the existing platform boundary.
    if (process.platform === "win32" && blob === "hardlink") {
      context.skip();
      return;
    }
    const f = await publicationFixture(blob ? "mixed" : "metadata-only");
    const publication = { ...f.publication };
    const output = tempDirs.make("workspace-publication-invalid-");
    let alias: { path: string; bytes: Buffer } | undefined;
    if (blob) {
      const [sha, bytes] = [...f.blobs][0]!;
      const target = blobPath(f.stagingRoot, sha);
      alias = {
        path: path.join(tempDirs.make("workspace-publication-alias-"), "original"),
        bytes,
      };
      await fs.writeFile(alias.path, bytes);
      await fs.rm(target);
      if (blob === "hardlink") {
        await fs.link(alias.path, target);
      }
    } else {
      const snapshot: GitHubRepositoryPublicationSnapshot = JSON.parse(publication.metadata);
      if (test.entry || test.duplicate) {
        const entry = { ...snapshot.entries[0], ...test.entry };
        publication.metadata = JSON.stringify({
          ...snapshot,
          entries: test.duplicate ? [entry, entry] : [entry],
        });
      }
      publication.metadata = test.metadata ?? publication.metadata;
      publication.baseCommit = test.baseCommit ?? publication.baseCommit;
      publication.publicationDigest = manifestRef(publication.metadata);
    }
    const staging = prepareWorkspaceStageInput({
      stagingRoot: f.stagingRoot,
      inputPath: path.join(output, "input"),
      stagedResultRef: candidate("invalid"),
      publication,
    });
    if (code) {
      await expect(staging).rejects.toMatchObject({ code });
    } else {
      await expect(staging).rejects.toThrow(error);
    }
    expect(await fs.readdir(output)).toEqual([]);
    if (alias) {
      await expect(fs.readFile(alias.path)).resolves.toEqual(alias.bytes);
    }
  });

  it.each(["same-size", "removed"] as const)(
    "rejects %s blob changes between inspection and streaming without a partial input",
    async (fault) => {
      const f = await publicationFixture("mixed");
      const [sha, bytes] = [...f.blobs][0]!;
      const target = blobPath(f.stagingRoot, sha);
      const read = publicationSnapshot.readGitHubRepositoryPublicationBlob;
      let reads = 0;
      // Only this race uses the native helper: the spy changes real on-disk bytes,
      // while both passes still use the production fs-safe/SHA-1 verifier.
      vi.spyOn(publicationSnapshot, "readGitHubRepositoryPublicationBlob").mockImplementation(
        async (root, id) => {
          if (id === sha && ++reads === 2) {
            if (fault === "removed") {
              await fs.rm(target);
            } else {
              await fs.writeFile(target, Buffer.alloc(bytes.length, 0x78));
            }
          }
          return await read(root, id);
        },
      );
      const output = tempDirs.make("workspace-publication-race-");
      const staging = buildWorkspaceStageInput({
        stagingRoot: f.stagingRoot,
        inputPath: path.join(output, "input"),
        stagedResultRef: candidate("changed-blob"),
        publication: {
          ...f.publication,
          metadata: new TextEncoder().encode(f.publication.metadata),
        },
      });
      if (fault === "removed") {
        await expect(staging).rejects.toMatchObject({ code: "not-found" });
      } else {
        await expect(staging).rejects.toThrow("blob changed after checkpoint capture");
      }
      expect(reads).toBe(2);
      expect(await fs.readdir(output)).toEqual([]);
    },
  );
});
