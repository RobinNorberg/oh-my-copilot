/**
 * The local forge's backlog files (offline forge plan §1.1): one
 * `<id>-<slug>.md` per item in factory.forge.local.backlogDir, with a small
 * strict frontmatter. Pure: parse and render text; tracker.ts reads files.
 *
 *   ---
 *   title: Add remove()
 *   state: open                 # open | closed (default open)
 *   labels: [factory, size:2]   # or a block list of "- name" lines
 *   dependsOn: [2]
 *   parent: 1
 *   priority: 2
 *   size: 3
 *   ---
 *   Markdown body. An "## Acceptance" (or "## Acceptance criteria") section
 *   becomes ForgeItem.acceptance.
 */
/** `<id>-<slug>.md`; other files in the directory (a README) are not items. */
export declare const BACKLOG_FILE: RegExp;
export interface BacklogFields {
    title: string;
    state: 'open' | 'closed';
    labels: string[];
    dependsOn: number[];
    parent?: number;
    priority?: number;
    size?: number;
}
export interface BacklogItem extends BacklogFields {
    id: number;
    /** Repo-relative path, `/`-separated. */
    path: string;
    /** The markdown after the frontmatter. */
    body: string;
    /** The text of the "## Acceptance" section, if any. */
    acceptance?: string;
    /** The frontmatter alone (dependsOn/parent above also include the body's edge lines); a rewrite starts from it. */
    fields: BacklogFields;
}
export declare class BacklogParseError extends Error {
    readonly path: string;
    constructor(path: string, detail: string);
}
/** The id a backlog file name carries, or undefined for a file that is not an item. */
export declare function backlogFileId(name: string): number | undefined;
/** A file-name slug for a title: lowercase words joined by `-`, 1-60 characters. */
export declare function backlogSlug(title: string): string;
/** Split the "## Acceptance" section out of a body (up to the next `#`/`##` heading). */
export declare function acceptanceSectionOf(body: string): string | undefined;
/**
 * Parse one backlog file. `path` is the repo-relative path (it names the
 * file in every error, and its basename carries the id).
 */
export declare function parseBacklogFile(path: string, text: string): BacklogItem;
/** Render a backlog file (frontmatter in a fixed key order, then the body). */
export declare function renderBacklogFile(fields: BacklogFields, body: string): string;
//# sourceMappingURL=backlog.d.ts.map