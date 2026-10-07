/**
 * scripts/port/upstream-drift.mjs against a fixture pair: a fake upstream and
 * a fake fork that shares its history (docs/DEVELOPERS.md, "Upstream drift bot").
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { renameLine } from "../../scripts/port/upstream-drift.mjs";

const SCRIPT = join(import.meta.dirname, "../../scripts/port/upstream-drift.mjs");
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=dev", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

type Files = Record<string, string | Buffer | null>;

function write(repo: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    if (content === null) { rmSync(abs); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function commit(repo: string, message: string, files: Files, stage?: (repo: string) => void): string {
  write(repo, files);
  git(repo, "add", "-A");
  stage?.(repo);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function drift(fork: string, ...args: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: fork, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const read = (repo: string, path: string) => readFileSync(join(repo, path), "utf8");

interface Pair { upstream: string; fork: string; base: string; head: string }

/**
 * upstream: base commit, then `change`. fork: clone of base plus `forkChange`
 * (already renamed text, fork-only edits), with the marker seeded at base.
 */
function makePair(
  baseFiles: Record<string, string>,
  forkChange: Files,
  change: Files,
  stageUpstream?: (repo: string) => void,
): Pair {
  const root = mkdtempSync(join(tmpdir(), "drift-fixture-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q");
  const base = commit(upstream, "base", baseFiles);
  git(root, "-c", "core.autocrlf=false", "clone", "-q", upstream, "fork");
  const fork = join(root, "fork");
  git(fork, "config", "core.autocrlf", "false");
  git(fork, "remote", "rename", "origin", "upstream");
  commit(fork, "fork: rename and diverge", {
    ...forkChange,
    ".github/upstream-port.json": `${JSON.stringify({ upstream_sha: base, upstream_branch: "dev", ported_at: "2026-10-06", fork_version: "5.8.1" }, null, 2)}\n`,
  });
  const head = commit(upstream, "upstream: next", change, stageUpstream);
  git(fork, "fetch", "-q", "upstream");
  return { upstream, fork, base, head };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("renameLine", () => {
  it("applies the mechanical map and is idempotent", () => {
    const line = "const p = join(root, '.omc', 'state'); // see .omc/state, oh-my-claudecode, CLAUDE_CONFIG_DIR, .claude/omc.jsonc, getClaudeSkillPermissionMode, omc-hud";
    const once = renameLine(line);
    expect(once).toBe("const p = join(root, '.omg', 'state'); // see .omg/state, oh-my-copilot, COPILOT_HOME, .copilot/omg.jsonc, getCopilotSkillPermissionMode, omg-hud");
    expect(renameLine(once)).toBe(once);
  });

  it("keeps DO-NOT-RENAME tokens and per-file exceptions", () => {
    const line = "see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1 and oh-my-claudecode; CLAUDE_PLUGIN_ROOT platform.claude.com claudeAiOauth .claude/settings.local.json";
    expect(renameLine(line)).toBe("see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1 and oh-my-copilot; CLAUDE_PLUGIN_ROOT platform.claude.com claudeAiOauth .claude/settings.local.json");
    expect(renameLine("CLAUDE_CONFIG_DIR", "src/hooks/permission-handler/index.ts")).toBe("CLAUDE_CONFIG_DIR");
    expect(renameLine("CLAUDE_CONFIG_DIR", "src/other.ts")).toBe("COPILOT_HOME");
    expect(renameLine("x.omc/y .omc-workspace OMC_STATE_DIR")).toBe("x.omc/y .omc-workspace OMC_STATE_DIR");
    expect(renameLine("mkdtemp('omc-hud-4237-') omc-hud.mjs")).toBe("mkdtemp('omc-hud-4237-') omg-hud.mjs");
  });
});

describe("upstream-drift --check", () => {
  it("exits 1 with the commit list when upstream moved and 0 when it did not", () => {
    const pair = makePair({ "src/a.ts": "a\n" }, {}, { "src/a.ts": "a2\n" });
    const moved = drift(pair.fork, "--check", "--json");
    expect(moved.status).toBe(1);
    const check = JSON.parse(moved.stdout);
    expect(check).toMatchObject({ base: pair.base, head: pair.head, upstream_ref: "upstream/dev", count: 1 });
    expect(check.commits).toEqual([{ sha: pair.head, subject: "upstream: next" }]);
    const current = drift(pair.fork, "--check", "--base", pair.head);
    expect(current.status).toBe(0);
    expect(current.stdout).toContain("0 new upstream commits");
  });
});

describe("upstream-drift --apply, clean range", () => {
  const pair = makePair(
    {
      "src/a.ts": "export const name = 'oh-my-claudecode';\nexport const one = 1;\n",
      "src/legacy.ts": "// legacy corpus: oh-my-claudecode\nexport const v = 1;\n",
      "src/gone.ts": "export const gone = true;\n",
      "CHANGELOG.md": "# changes\n",
      "package.json": '{\n  "name": "oh-my-claudecode",\n  "version": "1.0.0"\n}\n',
      "assets/logo.bin": "\u0000\u0001\u0002",
    },
    {
      // the fork already renamed a.ts but keeps the legacy corpus verbatim
      "src/a.ts": "export const name = 'oh-my-copilot';\nexport const one = 1;\n",
      "package.json": '{\n  "name": "oh-my-copilot",\n  "version": "5.8.1"\n}\n',
    },
    {
      "src/a.ts": "export const name = 'oh-my-claudecode';\nexport const one = 1;\nexport const dir = '.omc/state';\n",
      "src/legacy.ts": "// legacy corpus: oh-my-claudecode\nexport const v = 2;\n",
      "src/new.ts": [
        "// https://github.com/Yeachan-Heo/oh-my-claudecode/issues/42",
        "export const home = process.env.CLAUDE_CONFIG_DIR;",
        "export const root = process.env.CLAUDE_PLUGIN_ROOT;",
        "export const cfg = '.claude/omc.jsonc';",
        "export const pkg = 'oh-my-claudecode';",
        "",
      ].join("\n"),
      "src/gone.ts": null,
      "CHANGELOG.md": "# changes\n- upstream\n",
      "package.json": '{\n  "name": "oh-my-claudecode",\n  "version": "1.1.0",\n  "files": ["dist", "new"]\n}\n',
      ".github/RELEASE_SIGNOFF": "signed\n",
      ".github/workflows/ci.yml": "name: ci\n",
      ".github/actions/setup/action.yml": "name: setup\n",
      "assets/logo.bin": "\u0000\u0001\u0003",
    },
  );
  const first = drift(pair.fork, "--apply", "--date", "2026-10-07");

  it("exits 0 and stages the port with the rename map applied to new lines only", () => {
    expect(first.status, first.stderr).toBe(0);
    expect(read(pair.fork, "src/a.ts")).toBe("export const name = 'oh-my-copilot';\nexport const one = 1;\nexport const dir = '.omg/state';\n");
    expect(read(pair.fork, "src/legacy.ts")).toBe("// legacy corpus: oh-my-claudecode\nexport const v = 2;\n");
    expect(read(pair.fork, "src/new.ts")).toBe([
      "// https://github.com/Yeachan-Heo/oh-my-claudecode/issues/42",
      "export const home = process.env.COPILOT_HOME;",
      "export const root = process.env.CLAUDE_PLUGIN_ROOT;",
      "export const cfg = '.copilot/omg.jsonc';",
      "export const pkg = 'oh-my-copilot';",
      "",
    ].join("\n"));
    expect(existsSync(join(pair.fork, "src/gone.ts"))).toBe(false);
    expect(readFileSync(join(pair.fork, "assets/logo.bin"))).toEqual(Buffer.from([0, 1, 3]));
    expect(git(pair.fork, "status", "--porcelain")).toBe([
      "M  .github/upstream-port.json",
      "M  assets/logo.bin",
      "M  src/a.ts",
      "D  src/gone.ts",
      "M  src/legacy.ts",
      "A  src/new.ts",
    ].join("\n"));
  });

  it("leaves excluded, dropped and workflow files alone and moves the marker", () => {
    expect(read(pair.fork, "CHANGELOG.md")).toBe("# changes\n");
    expect(read(pair.fork, "package.json")).toContain('"version": "5.8.1"');
    expect(existsSync(join(pair.fork, ".github/RELEASE_SIGNOFF"))).toBe(false);
    expect(existsSync(join(pair.fork, ".github/workflows/ci.yml"))).toBe(false);
    expect(existsSync(join(pair.fork, ".github/actions/setup/action.yml"))).toBe(false);
    expect(JSON.parse(read(pair.fork, ".github/upstream-port.json"))).toEqual({
      upstream_sha: pair.head, upstream_branch: "dev", ported_at: "2026-10-07", fork_version: "unreleased",
    });
  });

  it("reports commits, files, package.json delta and a clean leak scan", () => {
    const report = JSON.parse(drift(pair.fork, "--report", "--base", pair.base).stdout);
    expect(report.clean).toBe(true);
    expect(report.conflicts).toEqual([]);
    expect(report.commits.map((c: { subject: string }) => c.subject)).toEqual(["upstream: next"]);
    expect(report.files).toEqual([
      { status: "A", path: ".github/RELEASE_SIGNOFF", action: "dropped" },
      { status: "A", path: ".github/actions/setup/action.yml", action: "skipped" },
      { status: "A", path: ".github/workflows/ci.yml", action: "skipped" },
      { status: "M", path: "CHANGELOG.md", action: "excluded" },
      { status: "M", path: "assets/logo.bin", action: "apply" },
      { status: "M", path: "package.json", action: "excluded" },
      { status: "M", path: "src/a.ts", action: "apply" },
      { status: "D", path: "src/gone.ts", action: "apply" },
      { status: "M", path: "src/legacy.ts", action: "apply" },
      { status: "A", path: "src/new.ts", action: "apply" },
    ]);
    expect(report.package_json_delta).toContain('-  "version": "1.0.0"');
    expect(report.package_json_delta).toContain('+  "files": ["dist", "new"]');
    expect(report.leaks).toEqual([]);
    const md = drift(pair.fork, "--report", "--base", pair.base, "--markdown").stdout;
    expect(md.startsWith(`<!-- upstream-drift-head: ${pair.head} -->\n<!-- upstream-drift-base: ${pair.base} -->\n`)).toBe(true);
    expect(md).toContain("applied cleanly");
    expect(md).toContain("```diff");
  });

  it("is idempotent: a fresh fork applying the same range produces the same tree, and a dirty tree is refused", () => {
    const again = drift(pair.fork, "--apply", "--base", pair.base, "--date", "2026-10-07");
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("clean checkout");
    const tree = git(pair.fork, "write-tree");
    git(pair.fork, "reset", "-q", "--hard", "HEAD");
    expect(drift(pair.fork, "--apply", "--date", "2026-10-07").status).toBe(0);
    expect(git(pair.fork, "write-tree")).toBe(tree);
  });
});

describe("upstream-drift --apply, conflicting range", () => {
  const pair = makePair(
    {
      "src/b.ts": "export const b = 1;\n",
      "src/old.ts": "export const old = 1;\n",
      "src/dropped-by-fork.ts": "export const d = 1;\n",
      "src/ok.ts": "export const ok = 1;\n",
    },
    {
      "src/b.ts": "export const b = 'fork';\n",
      "src/old.ts": "export const old = 'fork-owned';\n",
      "src/dropped-by-fork.ts": null,
      "src/both.ts": "export const both = 'fork';\n",
    },
    {
      "src/b.ts": "export const b = 'upstream';\n",
      "src/old.ts": null,
      "src/dropped-by-fork.ts": "export const d = 2;\n",
      "src/both.ts": "export const both = 'oh-my-claudecode';\n",
      "src/ok.ts": "export const ok = 'oh-my-claudecode';\n",
    },
  );
  const result = drift(pair.fork, "--apply", "--date", "2026-10-07");

  it("exits 1 and lists UU, UD, DU and AA conflicts", () => {
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(drift(pair.fork, "--report").stdout);
    expect(report.clean).toBe(false);
    expect(report.conflicts).toEqual([
      { status: "UU", path: "src/b.ts" },
      { status: "AA", path: "src/both.ts" },
      { status: "DU", path: "src/dropped-by-fork.ts" },
      { status: "UD", path: "src/old.ts" },
    ]);
    expect(result.stdout).toContain("UU src/b.ts");
  });

  it("keeps the fork side of a file deleted upstream, writes markers, still renames and stages clean files", () => {
    expect(read(pair.fork, "src/old.ts")).toBe("export const old = 'fork-owned';\n");
    expect(read(pair.fork, "src/dropped-by-fork.ts")).toBe("export const d = 2;\n");
    expect(read(pair.fork, "src/b.ts")).toMatch(/<<<<<<< [\s\S]*'fork'[\s\S]*=======[\s\S]*'upstream'[\s\S]*>>>>>>> /);
    expect(read(pair.fork, "src/both.ts")).toMatch(/<<<<<<< HEAD\nexport const both = 'fork';\n=======\nexport const both = 'oh-my-copilot';\n>>>>>>> /);
    expect(read(pair.fork, "src/ok.ts")).toBe("export const ok = 'oh-my-copilot';\n");
    expect(git(pair.fork, "diff", "--cached", "--name-only", "--", "src/ok.ts")).toBe("src/ok.ts");
  });

  it("titles the issue with the commit and conflict counts", async () => {
    // @ts-expect-error -- plain .mjs script without type declarations
    const mod = await import("../../scripts/port/upstream-drift.mjs");
    const report = JSON.parse(drift(pair.fork, "--report").stdout);
    expect(mod.issueTitle(report)).toBe(`Upstream drift: 1 commits since ${pair.base.slice(0, 9)}, conflicts in 4 files`);
    expect(mod.prTitle(report)).toBe(`port: upstream ${pair.base.slice(0, 9)}..${pair.head.slice(0, 9)} (bot)`);
    expect(report.titles).toEqual({ pr: mod.prTitle(report), issue: mod.issueTitle(report) });
    expect(mod.renderMarkdown(report)).toContain("### Conflicts\n\n- `UU` src/b.ts");
    const linked = mod.renderMarkdown({ ...report, commits: [{ sha: "c".repeat(40), subject: "Merge pull request #4253 from @someone/`x`" }] });
    expect(linked).toContain("- ccccccccc `Merge pull request #4253 from @someone/'x'`");
  });
});

describe("upstream-drift --apply, entries the rename pass must not touch", () => {
  const CORPUS = "src/installer/legacy-claude-md-corpus.ts";
  const FIXTURE = "src/installer/__tests__/fixtures/legacy-guides.json";
  const RECEIPT = "receipts/issue-1/receipt.json";
  const LINK_TARGET = "../oh-my-claudecode/.omc/state";
  const verbatim: Record<string, string | Buffer> = {
    [CORPUS]: "export const corpus = [{ openingLine: '# oh-my-claudecode - Intelligent Multi-Agent Orchestration', rawSha256: 'abc' }];\n",
    [FIXTURE]: '{ "finalLine": "<!-- OMC:END --> oh-my-claudecode .omc/state", "dataBase64": "AAA=" }\n',
    [RECEIPT]: '{ "repo": "oh-my-claudecode", "state": ".omc/state" }\n',
    // Latin-1, not UTF-8: decoding and re-encoding would change the bytes.
    "src/latin1.txt": Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(" oh-my-claudecode .omc/x\n")]),
  };
  let gitlinkSha = "";
  const pair = makePair({ "src/keep.ts": "export const k = 1;\n" }, {}, { ...verbatim, "src/naïve.ts": "export const n = 'oh-my-claudecode';\n" }, (repo) => {
    const target = join(repo, "..", "link-target.txt");
    writeFileSync(target, LINK_TARGET);
    const blob = git(repo, "hash-object", "-w", target);
    gitlinkSha = git(repo, "rev-parse", "HEAD");
    git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},src/link`);
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},vendor/sub`);
  });
  const result = drift(pair.fork, "--apply", "--date", "2026-10-07");

  it("applies the content-addressed corpus, its fixture and receipts byte-identical", () => {
    expect(result.status, result.stderr).toBe(0);
    for (const path of [CORPUS, FIXTURE, RECEIPT]) {
      expect(readFileSync(join(pair.fork, path)), path).toEqual(Buffer.from(verbatim[path] as string));
    }
  });

  it("leaves a non-UTF-8 file byte-identical and still renames a file with a non-ASCII path", () => {
    expect(readFileSync(join(pair.fork, "src/latin1.txt"))).toEqual(verbatim["src/latin1.txt"]);
    expect(read(pair.fork, "src/naïve.ts")).toBe("export const n = 'oh-my-copilot';\n");
  });

  it("skips symlinks and gitlinks", () => {
    expect(git(pair.fork, "ls-files", "-s", "--", "src/link", "vendor/sub").split("\n").map((l) => l.split(/\s/)[0])).toEqual(["120000", "160000"]);
    expect(git(pair.fork, "cat-file", "-p", ":src/link")).toBe(LINK_TARGET);
    expect(git(pair.fork, "rev-parse", ":vendor/sub")).toBe(gitlinkSha);
    if (existsSync(join(pair.fork, "src/link"))) {
      // core.symlinks=false (Windows) checks the link out as a plain file holding the target.
      expect(git(pair.fork, "diff", "--name-only", "--", "src/link")).toBe("");
    }
    expect(result.stdout).not.toMatch(/renamed .* in (src\/link|vendor\/sub)/);
  });
});

describe("upstream-drift leak scan", () => {
  it("flags new oh-my-claudecode lines the map could not rename, ignoring protected links and fork-retained lines", () => {
    const pair = makePair(
      { "src/c.ts": "// oh-my-claudecode kept on purpose\nexport const c = 1;\n" },
      {},
      { "src/c.ts": "// oh-my-claudecode kept on purpose\nexport const c = 2;\n// see https://github.com/Yeachan-Heo/oh-my-claudecode/pull/9\n" },
    );
    expect(drift(pair.fork, "--apply").status).toBe(0);
    // Simulate a hand edit that reintroduces the upstream name.
    write(pair.fork, { "src/c.ts": `${read(pair.fork, "src/c.ts")}const leak = "oh-my-claudecode";\n` });
    const report = JSON.parse(drift(pair.fork, "--report", "--base", pair.base).stdout);
    expect(report.leaks).toEqual([{ path: "src/c.ts", line: 4, text: 'const leak = "oh-my-claudecode";' }]);
  });
});
