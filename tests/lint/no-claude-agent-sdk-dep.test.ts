/**
 * Guard: @anthropic-ai/claude-agent-sdk stays out of package.json (PR #558),
 * and so does the Copilot SDK (v1 @github/copilot-sdk, v2 @microsoft/copilot-sdk).
 * Socket.dev scores every declared package,
 * optional peers included, so both SDKs are loaded lazily and installed by the
 * users who need them.
 *
 * Upstream ports re-add the SDK as a dependency and as static imports (see
 * .omc/skills/stale-main-dependency-reintroduction-expertise.md); a merge
 * that does so applies cleanly and builds, so only this test catches it.
 * Every src file is scanned: the lazy loader in src/graph/runtime/executors/agent.ts
 * uses a variable specifier, which the static pattern does not match.
 */

import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK = "@anthropic-ai/claude-agent-sdk";
const COPILOT_SDKS = ["@github/copilot-sdk", "@microsoft/copilot-sdk"];
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"];

function readPackageJson(): Record<string, Record<string, unknown> | undefined> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    Record<string, unknown> | undefined
  >;
}

const toPosix = (path: string): string => path.replace(/\\/g, "/");

/** Source text with block and line comments removed (comments may name the SDK). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const quoted = `['"\`]${SDK.replace(/[/-]/g, "\\$&")}(?:/[^'"\`]*)?['"\`]`;
const STATIC_LOAD = new RegExp(
  [
    `\\b(?:import|export)\\b[^;]*?\\bfrom\\s*${quoted}`, // import/export ... from
    `\\bimport\\s*${quoted}`, // side-effect import
    `\\bimport\\s*\\(\\s*${quoted}`, // import("…") with a literal specifier
    `\\brequire\\s*\\(\\s*${quoted}`, // require("…")
  ].join("|"),
);

function sourceFiles(dir: string): string[] {
  return (readdirSync(join(REPO_ROOT, dir), { recursive: true }) as string[])
    .map((entry) => toPosix(join(dir, entry)))
    .filter((path) => /\.[cm]?ts$/.test(path));
}

describe("no @anthropic-ai/claude-agent-sdk dependency", () => {
  it("package.json does not declare the Claude Agent SDK in any dependency field", () => {
    const pkg = readPackageJson();
    for (const field of [...DEPENDENCY_FIELDS, "devDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), field).not.toContain(SDK);
    }
  });

  it("package.json does not declare the Copilot SDK (v1 or v2) as a dependency or peer", () => {
    const pkg = readPackageJson();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of COPILOT_SDKS) expect(Object.keys(pkg[field] ?? {}), `${field} ${name}`).not.toContain(name);
    }
  });

  it("no src file loads the SDK statically", () => {
    const offenders = sourceFiles("src")
      .filter((path) => STATIC_LOAD.test(stripComments(readFileSync(join(REPO_ROOT, path), "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the forms an upstream port brings back", () => {
    for (const line of [
      `import { query } from "${SDK}";`,
      `import type { Options } from '${SDK}';`,
      `export { tool } from "${SDK}";`,
      `const sdk = await import("${SDK}");`,
      `const { query } = require('${SDK}');`,
      `import {\n  createSdkMcpServer,\n  tool,\n} from "${SDK}";`,
    ]) {
      expect(STATIC_LOAD.test(stripComments(line)), line).toBe(true);
    }
    expect(STATIC_LOAD.test(stripComments(`// import { query } from "${SDK}";`))).toBe(false);
    expect(STATIC_LOAD.test(stripComments(`const CLAUDE_AGENT_SDK = "${SDK}";`))).toBe(false);
  });

  it("the shipped bridge bundles no in-process SDK MCP server", () => {
    const bundles = readdirSync(join(REPO_ROOT, "bridge")).filter((name) => name.endsWith(".cjs"));
    expect(bundles.length).toBeGreaterThan(0);
    const offenders = bundles.filter((name) =>
      readFileSync(join(REPO_ROOT, "bridge", name), "utf8").includes("createSdkMcpServer"),
    );
    expect(offenders).toEqual([]);
  });
});
