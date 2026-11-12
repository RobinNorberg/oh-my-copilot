/**
 * Workspaces (monorepos) in the gate's node_modules tree (prepare.ts
 * linkNodeModules): which package dirs of your checkout get a nested
 * per-run tree, from the workspace globs of the TRUSTED BASE (root
 * `package.json` `workspaces`, or `pnpm-workspace.yaml` `packages`), never
 * the PR head's. Globs are expanded against your checkout, bounded
 * (WORKSPACE_MAX_PACKAGES, WORKSPACE_MAX_DEPTH, WORKSPACE_MAX_DIRS), never
 * following a link and never leaving the checkout; a glob with `..`, an
 * absolute path or a backslash is dropped with a note.
 *
 * Supported: npm, pnpm and yarn workspaces with a node_modules layout (yarn
 * classic, yarn berry with `nodeLinker: node-modules`). Not supported, named
 * as a problem: Yarn Plug'n'Play (`.pnp.cjs`), a workspace package that is a
 * nested git repository, and a layout over the bounds.
 */
/** The most workspace package dirs a tree is built for. */
export declare const WORKSPACE_MAX_PACKAGES = 256;
/** The deepest a workspace package dir may lie below your checkout (path segments). */
export declare const WORKSPACE_MAX_DEPTH = 6;
/** The most dirs read while expanding the globs. */
export declare const WORKSPACE_MAX_DIRS = 20000;
/** The largest base `package.json` / `pnpm-workspace.yaml` read for the globs. */
export declare const WORKSPACE_FILE_MAX_BYTES: number;
/**
 * The workspace globs of the base: `workspaces` (an array, or yarn's
 * `{ packages: [...] }`) of the root package.json, else the `packages` list
 * of pnpm-workspace.yaml. Negations (`!glob`) are kept. Unreadable or
 * oversized input is no workspaces.
 */
export declare function parseWorkspacePatterns(packageJson: string | null, pnpmWorkspaceYaml: string | null): string[];
/**
 * A relative workspace path of the exact shape the tree accepts: forward
 * slashes, no empty segment, no dot segment (`.`, `..`, `.omg`, `.git`:
 * the engine's state and other runs' checkouts live there), no
 * node_modules segment, not absolute, no drive, no backslash or control
 * character, at most WORKSPACE_MAX_DEPTH segments. The sandbox grant check
 * (copilot-run/sandbox.ts gateTreeNestedRels) applies the same shape.
 */
export declare function validWorkspaceRel(rel: string): boolean;
/** `<base>/<rel>` when every segment of it is a plain directory (no link, junction or file on the way); else null. */
export declare function plainDirUnder(base: string, rel: string): string | null;
export interface WorkspaceDirs {
    /** Relative package dirs (forward slashes), sorted. */
    dirs: string[];
    /** Why the layout is not supported (the folder named), or null. */
    problem: string | null;
}
/**
 * The workspace package dirs of `root` (dirs with a package.json) the base
 * globs match, plus the unsupported-layout problem: Yarn Plug'n'Play, a
 * nested git repository, or more than the bounds. Links are never
 * followed and `node_modules` / `.git` dirs are never entered.
 */
export declare function expandWorkspaceDirs(root: string, patterns: readonly string[], warn?: (message: string) => void): WorkspaceDirs;
/** The base's workspace globs through `read` (a trusted base reader: a path at the base commit, or null). */
export declare function baseWorkspacePatterns(read: (path: string) => string | null): string[];
/**
 * Where a link in your node_modules goes in the gate's tree when it points
 * into your working tree outside any node_modules (a workspace self-link
 * such as `node_modules/@scope/pkg -> ../../packages/pkg`, or a `file:`
 * dependency): the same dir of the GATE checkout, so the gate tests the
 * PR's code and never writes yours. `{ keep: true }`: not such a link (it is
 * linked to yours read-only as before). `{ skip }`: such a link whose dir
 * is not a plain dir in the gate checkout (left out, with the reason).
 */
export declare function workspaceLinkTarget(entry: string, root: string, checkout: string): {
    keep: true;
} | {
    to: string;
} | {
    skip: string;
};
//# sourceMappingURL=workspace-tree.d.ts.map