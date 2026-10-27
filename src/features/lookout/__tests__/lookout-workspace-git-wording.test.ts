/**
 * Lookout repoRoot: git <= 2.55 and >= 2.56 word the "not a repository" exit-128
 * answer differently (git 54a441bcea). Mocked at the git spawn so it holds on any
 * installed git version.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "child_process";
import { LookoutError } from "../types.js";
import { repoRoot } from "../workspace.js";

const WORDINGS = [
  ["git <= 2.55", "fatal: not a git repository: /missing-gitdir\n"],
  ["git >= 2.56", "fatal: gitfile does not point to a valid repository: /work/.git\n"],
] as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omc-lookout-wording-"));
});

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  rmSync(dir, { recursive: true, force: true });
});

function failWith(stderr: string): void {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw Object.assign(new Error("Command failed"), { status: 128, stderr });
  });
}

describe("repoRoot not-a-repository wording", () => {
  it.each(WORDINGS)("treats a plain directory as no repository (%s)", (_v, stderr) => {
    failWith(stderr);
    expect(repoRoot(dir)).toBeNull();
  });

  it.each(WORDINGS)("fails closed when a .git entry exists (%s)", (_v, stderr) => {
    failWith(stderr);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "");
    expect(() => repoRoot(dir)).toThrow(LookoutError);
  });
});
