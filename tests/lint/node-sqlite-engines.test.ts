/**
 * Engines contract for the built-in node:sqlite backend.
 *
 * State mutation locking and the job state database use Node's built-in
 * `node:sqlite`, unflagged from Node 22.13.0 and 23.4.0. The native
 * better-sqlite3 addon (and its prebuild-install / tar-fs chain) is gone, so
 * the published package must neither depend on it nor claim Node 20 or the
 * flag-gated 22.0-22.12 / 23.0-23.3 releases.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { MIN_NODE_VERSION } from "../../src/utils/node-version.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as T;

type Manifest = { engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lockfile = { packages?: Record<string, { engines?: { node?: string } }> };

describe("node:sqlite engines contract", () => {
  it("declares Node 22.13+ / 23.4+ and no Node 20", () => {
    const engines = readJson<Manifest>("package.json").engines?.node ?? "";
    expect(engines).toBe("^22.13.0 || ^23.4.0 || 24.x || 25.x || 26.x");
    expect(engines).not.toMatch(/\b20\./);
  });

  it("keeps the lockfile root engines equal to package.json", () => {
    const manifest = readJson<Manifest>("package.json");
    const lock = readJson<Lockfile>("package-lock.json");
    expect(lock.packages?.[""]?.engines?.node).toBe(manifest.engines?.node);
  });

  it("depends on no native SQLite addon", () => {
    const manifest = readJson<Manifest>("package.json");
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(declared).not.toHaveProperty("better-sqlite3");
    expect(declared).not.toHaveProperty("@types/better-sqlite3");
    const locked = Object.keys(readJson<Lockfile>("package-lock.json").packages ?? {});
    expect(locked.filter(path => /node_modules\/(better-sqlite3|prebuild-install)$/.test(path))).toEqual([]);
  });

  it("keeps the hook runtime floor at the engines major", () => {
    expect(MIN_NODE_VERSION).toBe(22);
  });
});
