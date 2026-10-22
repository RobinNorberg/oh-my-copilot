import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync as realExecFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});
import { execFileSync } from "child_process";

function canonical(path: string): string {
  return realpathSync(path);
}
import {
  clearWorktreeCache,
  getGitTopLevel,
  getProjectIdentifier,
  getOmcRoot,
  getWorktreeRoot,
  probeGitTopLevel,
  setGitShowToplevelProbeForTests,
  validateWorkingDirectory,
  withWorktreePathRenderScope,
  withProjectIdentifierScope,
} from "../worktree-paths.js";

const mockedExecFileSync = vi.mocked(execFileSync);

function git(cwd: string, args: string[]): string {
  return realExecFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "--quiet"]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=omc-test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  ]);
}

function showToplevelCalls(): number {
  return mockedExecFileSync.mock.calls.filter(
    ([, args]) =>
      Array.isArray(args) &&
      args[0] === "rev-parse" &&
      args[1] === "--show-toplevel",
  ).length;
}

describe("git top-level memoization", () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omc-toplevel-cache-"));
    process.chdir(originalCwd);
    clearWorktreeCache();
    mockedExecFileSync.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("memoizes repeated state-root lookups without repeating show-toplevel", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getOmcRoot(repo)).toBe(join(repo, ".omg"));
    expect(getOmcRoot(repo)).toBe(join(repo, ".omg"));
    expect(getOmcRoot(repo)).toBe(join(repo, ".omg"));
    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps a 171-call state render to one top-level probe", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    for (let renderCall = 0; renderCall < 171; renderCall++) {
      expect(getOmcRoot(repo)).toBe(join(repo, ".omg"));
    }

    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps the root correct across repository and child-directory lookups", () => {
    const repo = join(tempDir, "repo");
    const child = join(repo, "src");
    initRepo(repo);
    mkdirSync(child, { recursive: true });

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    expect(getGitTopLevel(child)).toBe(canonical(repo));
    expect(getGitTopLevel(child)).toBe(canonical(repo));
    expect(showToplevelCalls()).toBe(2);
  });

  it("shares a positive entry between real and symlinked paths", () => {
    const repo = join(tempDir, "repo");
    const alias = join(tempDir, "repo-link");
    initRepo(repo);

    try {
      symlinkSync(repo, alias, "dir");
    } catch {
      return;
    }

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    expect(getGitTopLevel(alias)).toBe(canonical(repo));
    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps linked worktree roots in separate cache entries", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-cache-test",
      linked,
    ]);

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    expect(getGitTopLevel(linked)).toBe(canonical(linked));
    expect(getGitTopLevel(linked)).toBe(canonical(linked));
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a linked-worktree cache when common config changes", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-common-config-test",
      linked,
    ]);

    expect(getGitTopLevel(linked)).toBe(canonical(linked));
    git(repo, ["config", "core.bare", "false"]);

    expect(getGitTopLevel(linked)).toBe(canonical(linked));
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached parent root when a nested repository appears", () => {
    const repo = join(tempDir, "repo");
    const nested = join(repo, "nested");
    initRepo(repo);
    mkdirSync(nested, { recursive: true });

    expect(getGitTopLevel(nested)).toBe(canonical(repo));
    initRepo(nested);
    expect(getGitTopLevel(nested)).toBe(canonical(nested));
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates the state-anchor cache when a nested repository appears", () => {
    const repo = join(tempDir, "repo");
    const nested = join(repo, "nested");
    initRepo(repo);
    mkdirSync(nested, { recursive: true });

    expect(getWorktreeRoot(nested)).toBe(canonical(repo));
    initRepo(nested);
    expect(getWorktreeRoot(nested)).toBe(canonical(nested));
  });

  it("invalidates the state-anchor cache when Git discovery environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousPath = process.env.PATH;
    try {
      expect(getWorktreeRoot(repo)).toBe(canonical(repo));
      process.env.PATH = `${previousPath ?? ""}${process.platform === "win32" ? ";" : ":"}${tempDir}`;

      expect(getWorktreeRoot(repo)).toBe(canonical(repo));
      expect(showToplevelCalls()).toBe(2);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("invalidates a cached superproject anchor when its gitlink is removed", () => {
    const superproject = join(tempDir, "superproject");
    const submodule = join(tempDir, "submodule");
    const checkedOutSubmodule = join(superproject, "nested");
    initRepo(superproject);
    initRepo(submodule);
    git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      submodule,
      "nested",
    ]);
    git(superproject, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=omc-test",
      "commit",
      "--quiet",
      "-m",
      "add submodule",
    ]);

    // Normalize separators: the superproject anchor comes from git output,
    // which uses forward slashes even on Windows.
    expect(getWorktreeRoot(checkedOutSubmodule)?.replace(/\\/g, "/")).toBe(canonical(superproject).replace(/\\/g, "/"));
    git(superproject, ["update-index", "--force-remove", "nested"]);
    git(superproject, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=omc-test",
      "commit",
      "--quiet",
      "-m",
      "remove submodule gitlink",
    ]);

    expect(getWorktreeRoot(checkedOutSubmodule)?.replace(/\\/g, "/")).toBe(canonical(checkedOutSubmodule).replace(/\\/g, "/"));
  });

  it("invalidates a linked-worktree entry when its gitdir disappears", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-metadata-test",
      linked,
    ]);

    expect(getGitTopLevel(linked)).toBe(canonical(linked));
    const gitDir = readFileSync(join(linked, ".git"), "utf8").match(
      /^\s*gitdir:\s*(.+?)\s*$/im,
    );
    expect(gitDir).not.toBeNull();
    rmSync(resolve(linked, gitDir![1]), { recursive: true, force: true });

    expect(getGitTopLevel(linked)).toBeNull();
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached root when repository HEAD metadata disappears", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    rmSync(join(repo, ".git", "HEAD"));

    expect(getGitTopLevel(repo)).toBeNull();
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached root when Git discovery environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousGitDir = process.env.GIT_DIR;
    try {
      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      process.env.GIT_DIR = join(repo, ".git");

      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      expect(showToplevelCalls()).toBe(2);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it("distinguishes unset and empty Git environment values", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousPath = process.env.PATH;
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return `${repo}\n`;
    });
    try {
      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      delete process.env.PATH;
      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      process.env.PATH = "";
      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      process.env.PATH = "<unset>";
      expect(getGitTopLevel(repo)).toBe(canonical(repo));
      expect(probeCalls).toBe(4);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("invalidates a cached root when Git config metadata changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    git(repo, ["config", "core.bare", "false"]);

    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    expect(showToplevelCalls()).toBe(2);
  });

  it("re-probes a cached non-repository result after git init", () => {
    const repo = join(tempDir, "repo");

    expect(getGitTopLevel(repo)).toBeNull();
    initRepo(repo);
    expect(getGitTopLevel(repo)).toBe(canonical(repo));
    expect(showToplevelCalls()).toBe(2);
  });

  it("memoizes a non-repository answer across OMC_STATE_DIR state-root lookups", () => {
    const plain = join(tempDir, "plain");
    mkdirSync(plain, { recursive: true });
    const previousStateDir = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = join(tempDir, "state");
    try {
      const first = getOmcRoot(plain);
      for (let call = 0; call < 50; call++) {
        expect(getOmcRoot(plain)).toBe(first);
      }
      expect(getGitTopLevel(plain)).toBeNull();
      expect(showToplevelCalls()).toBe(1);
    } finally {
      if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previousStateDir;
    }
  });

  it("re-probes a cached non-repository result when Git discovery environment changes", () => {
    const plain = join(tempDir, "plain");
    mkdirSync(plain, { recursive: true });
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    try {
      expect(getGitTopLevel(plain)).toBeNull();
      expect(getGitTopLevel(plain)).toBeNull();
      process.env.GIT_CEILING_DIRECTORIES = tempDir;
      expect(getGitTopLevel(plain)).toBeNull();
      expect(showToplevelCalls()).toBe(2);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it("does not cache git-missing or failed probes", () => {
    const plain = join(tempDir, "plain");
    mkdirSync(plain, { recursive: true });
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });

    expect(getGitTopLevel(plain)).toBeNull();
    expect(getGitTopLevel(plain)).toBeNull();
    expect(probeCalls).toBe(2);

    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return "not-an-absolute-root\n";
    });
    expect(getGitTopLevel(plain)).toBeNull();
    expect(getGitTopLevel(plain)).toBeNull();
    expect(probeCalls).toBe(4);
  });

  it("keeps direct boundary probes uncached", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(showToplevelCalls()).toBe(2);
  });

  it("memoizes probes by canonical cwd only inside a render scope", () => {
    const repo = join(tempDir, "repo");
    const alias = join(tempDir, "repo-link");
    initRepo(repo);

    try {
      symlinkSync(repo, alias, "dir");
    } catch {
      return;
    }

    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return `${repo}\n`;
    });

    withWorktreePathRenderScope(() => {
      expect(probeGitTopLevel(repo).status).toBe("ok");
      expect(probeGitTopLevel(alias).status).toBe("ok");
    });
    expect(probeCalls).toBe(1);

    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(probeCalls).toBe(3);
  });

  it("memoizes negative probe results only inside a render scope", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return "not-an-absolute-root\n";
    });

    withWorktreePathRenderScope(() => {
      expect(probeGitTopLevel(repo).status).toBe("probe_failed");
      expect(probeGitTopLevel(repo).status).toBe("probe_failed");
    });

    expect(probeCalls).toBe(1);
    expect(probeGitTopLevel(repo).status).toBe("probe_failed");
    expect(probeCalls).toBe(2);
  });

  it("memoizes project identifiers by canonical root within a render scope", () => {
    const repo = join(tempDir, "repo");
    const alias = join(tempDir, "repo-link");
    initRepo(repo);

    try {
      symlinkSync(repo, alias, "dir");
    } catch {
      return;
    }

    const remoteCalls = () =>
      mockedExecFileSync.mock.calls.filter(
        ([command, args]) =>
          command === "git" &&
          Array.isArray(args) &&
          args[0] === "remote" &&
          args[1] === "get-url",
      ).length;
    const commonDirCalls = () =>
      mockedExecFileSync.mock.calls.filter(
        ([command, args]) =>
          command === "git" &&
          Array.isArray(args) &&
          args[0] === "rev-parse" &&
          args.includes("--git-common-dir"),
      ).length;

    withWorktreePathRenderScope(() => {
      expect(getProjectIdentifier(repo)).toBe(getProjectIdentifier(alias));
    });
    expect(remoteCalls()).toBe(1);
    expect(commonDirCalls()).toBe(1);
  });

  it("re-evaluates project identifiers in a fresh scope after remote metadata changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    git(repo, ["remote", "add", "origin", "https://example.test/first.git"]);

    let firstIdentifier: string;
    withWorktreePathRenderScope(() => {
      firstIdentifier = getProjectIdentifier(repo);
    });

    git(repo, ["remote", "set-url", "origin", "https://example.test/second.git"]);

    let secondIdentifier: string;
    withWorktreePathRenderScope(() => {
      secondIdentifier = getProjectIdentifier(repo);
    });

    expect(secondIdentifier!).not.toBe(firstIdentifier!);
  });

  it("memoizes project identifiers in an operation scope and re-probes after git remote set-url", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    git(repo, ["remote", "add", "origin", "https://example.test/first.git"]);
    const remoteCalls = () => mockedExecFileSync.mock.calls.filter(([command, args]) => command === "git" && Array.isArray(args) && args[0] === "remote" && args[1] === "get-url").length;
    let first: string;
    withProjectIdentifierScope(() => {
      first = getProjectIdentifier(repo);
      getProjectIdentifier(repo);
    });
    expect(remoteCalls()).toBe(1);
    withProjectIdentifierScope(() => getProjectIdentifier(repo));
    expect(getProjectIdentifier(repo)).toBe(first!);
    expect(remoteCalls()).toBe(1);

    git(repo, ["remote", "set-url", "origin", "https://example.test/second.git"]);
    const second = withProjectIdentifierScope(() => getProjectIdentifier(repo));
    expect(second).not.toBe(first!);
    expect(remoteCalls()).toBe(2);
  });

  it("re-probes a cached project identifier when the linked worktree common config changes", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, ["worktree", "add", "--quiet", "-b", "linked-projid-test", linked]);
    git(repo, ["remote", "add", "origin", "https://example.test/first.git"]);

    const first = getProjectIdentifier(linked);
    expect(getProjectIdentifier(linked)).toBe(first);
    git(repo, ["remote", "set-url", "origin", "https://example.test/second.git"]);
    expect(getProjectIdentifier(linked)).not.toBe(first);
  });

  it("re-probes a cached project identifier when OMC_STATE_DIR or Git environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const remoteCalls = () => mockedExecFileSync.mock.calls.filter(([command, args]) => command === "git" && Array.isArray(args) && args[0] === "remote" && args[1] === "get-url").length;
    const previousStateDir = process.env.OMC_STATE_DIR;
    const previousGitDir = process.env.GIT_DIR;
    try {
      getProjectIdentifier(repo);
      getProjectIdentifier(repo);
      expect(remoteCalls()).toBe(1);
      process.env.OMC_STATE_DIR = join(tempDir, "state");
      getProjectIdentifier(repo);
      expect(remoteCalls()).toBe(2);
      process.env.GIT_DIR = join(repo, ".git");
      getProjectIdentifier(repo);
      expect(remoteCalls()).toBe(3);
    } finally {
      if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previousStateDir;
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it("bounds the project identifier cache and evicts the least recently used root", () => {
    const repos = Array.from({ length: 9 }, (_, index) => join(tempDir, `repo-${index}`));
    for (const repo of repos) initRepo(repo);
    const remoteCallsFor = (repo: string) => mockedExecFileSync.mock.calls.filter(([command, args, options]) => command === "git" && Array.isArray(args) && args[0] === "remote" && (options as { cwd?: string } | undefined)?.cwd === repo).length;

    for (const repo of repos.slice(0, 8)) getProjectIdentifier(repo);
    getProjectIdentifier(repos[0]);
    expect(remoteCallsFor(repos[0])).toBe(1);

    getProjectIdentifier(repos[8]);
    getProjectIdentifier(repos[0]);
    getProjectIdentifier(repos[1]);
    expect(remoteCallsFor(repos[0])).toBe(1);
    expect(remoteCallsFor(repos[1])).toBe(2);
  });

  it("does not cache a project identifier derived from a timed-out git probe", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    git(repo, ["remote", "add", "origin", "https://example.test/first.git"]);
    const timeout = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM" });
    mockedExecFileSync.mockImplementationOnce(() => { throw timeout; });

    const fallback = getProjectIdentifier(repo);
    const recovered = getProjectIdentifier(repo);
    expect(recovered).not.toBe(fallback);
    expect(getProjectIdentifier(repo)).toBe(recovered);
  });

  it("does not cache a project identifier derived from a dubious-ownership refusal", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    git(repo, ["remote", "add", "origin", "https://example.test/first.git"]);
    const refusal = Object.assign(new Error("Command failed: git remote get-url origin"), {
      status: 128,
      stderr: "fatal: detected dubious ownership in repository\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /repo\n",
    });
    mockedExecFileSync.mockImplementationOnce(() => { throw refusal; });

    const fallback = getProjectIdentifier(repo);
    const recovered = getProjectIdentifier(repo);
    expect(recovered).not.toBe(fallback);
    expect(getProjectIdentifier(repo)).toBe(recovered);
  });

  it("does not cache project identifiers for a bare repository or when GIT_DIR is set", () => {
    const bare = join(tempDir, "bare.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "--bare", "--quiet"]);
    git(bare, ["remote", "add", "origin", "https://example.test/first.git"]);
    const remoteCallsFor = (cwd: string) => mockedExecFileSync.mock.calls.filter(([command, args, options]) => command === "git" && Array.isArray(args) && args[0] === "remote" && args[1] === "get-url" && (options as { cwd?: string } | undefined)?.cwd === cwd).length;

    const first = getProjectIdentifier(bare);
    expect(getProjectIdentifier(bare)).toBe(first);
    expect(remoteCallsFor(bare)).toBe(2);
    git(bare, ["remote", "set-url", "origin", "https://example.test/second.git"]);
    expect(getProjectIdentifier(bare)).not.toBe(first);

    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousGitDir = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(repo, ".git");
      getProjectIdentifier(repo);
      getProjectIdentifier(repo);
      expect(remoteCallsFor(repo)).toBe(2);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it("keeps concurrent render scopes isolated", async () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return `${repo}\n`;
    });

    await Promise.all([
      withWorktreePathRenderScope(async () => {
        expect(probeGitTopLevel(repo).status).toBe("ok");
        await Promise.resolve();
        expect(probeGitTopLevel(repo).status).toBe("ok");
      }),
      withWorktreePathRenderScope(async () => {
        expect(probeGitTopLevel(repo).status).toBe("ok");
        await Promise.resolve();
        expect(probeGitTopLevel(repo).status).toBe("ok");
      }),
    ]);

    expect(probeCalls).toBe(2);
  });

  it("re-evaluates probes in a fresh scope after the environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return `${repo}\n`;
    });

    withWorktreePathRenderScope(() => {
      expect(probeGitTopLevel(repo).status).toBe("ok");
      expect(probeGitTopLevel(repo).status).toBe("ok");
    });

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${previousPath ?? ""}${process.platform === "win32" ? ";" : ":"}${tempDir}`;
      withWorktreePathRenderScope(() => {
        expect(probeGitTopLevel(repo).status).toBe("ok");
        expect(probeGitTopLevel(repo).status).toBe("ok");
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(probeCalls).toBe(2);
  });

  it("fails closed when the validator sees a transient git probe failure", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    process.chdir(repo);
    setGitShowToplevelProbeForTests(() => {
      const error = new Error("git unavailable") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    expect(() => validateWorkingDirectory()).toThrow(/git probe failed and was not used/);
  });
});
