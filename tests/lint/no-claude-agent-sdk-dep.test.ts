/**
 * Guard: @anthropic-ai/claude-agent-sdk stays an optional peer (PR #558).
 *
 * Upstream ports re-add the SDK as a dependency and as static imports (see
 * .omc/skills/stale-main-dependency-reintroduction-expertise.md); a merge
 * that does so applies cleanly and builds, so only this test catches it.
 * The one allowed loader is src/graph/runtime/executors/agent.ts, which
 * lazy-imports the SDK through a variable specifier.
 */

import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK = "@anthropic-ai/claude-agent-sdk";
const ALLOWED_LOADER = "src/graph/runtime/executors/agent.ts";

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
    .filter((path) => path.endsWith(".ts"));
}

describe("no @anthropic-ai/claude-agent-sdk dependency", () => {
  it("package.json lists the SDK only as a peer", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(SDK);
    expect(Object.keys(pkg.optionalDependencies ?? {})).not.toContain(SDK);
  });

  it("only the graph agent executor loads the SDK, and never statically", () => {
    const offenders = sourceFiles("src")
      .filter((path) => path !== ALLOWED_LOADER)
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
