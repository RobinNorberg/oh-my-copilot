export interface WikiSessionEndBootstrapInput {
    session_id: string;
    cwd: string;
}
export interface WikiSessionEndBootstrapResult {
    continue: true;
}
/**
 * Wiki SessionEnd producer: no foreground lock or wiki write, it only seals a
 * durable capture/no-op intent and hands off to the existing worker.
 *
 * Kept out of `index.ts` so `scripts/wiki-session-end.mjs` does not load the
 * full SessionEnd module graph (~100ms) inside run.cjs's 300ms foreground
 * budget — the same split `foreground-bootstrap.ts` makes for `session-end.mjs`.
 */
export declare function processWikiSessionEnd(input: WikiSessionEndBootstrapInput): Promise<WikiSessionEndBootstrapResult>;
//# sourceMappingURL=wiki-foreground-bootstrap.d.ts.map