/**
 * OMC HUD - Factory Element
 *
 * What the software factory needs from you, from `omg factory attention`'s
 * collector (local state only, read-only, the same trust rules):
 * Off on every host (opt-in, `elements.factory: true`): a status-line render
 * in a repository with factory state loads the factory modules and collects
 * (about 0.5 s measured on Windows). `factory:4! inspect` (4 items, the worst
 * group Inspect), with `run:1` when
 * an engine is live; `factory:run:1` when engines run and nothing waits;
 * nothing at all when neither. Numbers and fixed words only: no title,
 * reason or other text from a state reaches the status line.
 *
 * Cost: one stat when the repository has no factory state dir (the factory
 * modules are not even loaded then). A deleted state dir whose runs only the
 * engine ledger still records is not shown here; `omg factory attention`
 * lists those.
 */
/** The group ids of src/factory/attention/actions.ts ATTENTION_GROUPS: the short names the element prints. */
export declare const FACTORY_HUD_GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
declare const GROUPS: readonly ["inspect", "broken", "decide", "merge", "fix", "limits"];
export interface FactoryStateForHud {
    total: number;
    worst: (typeof GROUPS)[number] | null;
    engines: number;
}
/** The summary for `directory` (a repository root), or null when it has no factory state or anything fails. */
export declare function readFactoryStateForHud(directory: string, load?: () => Promise<{
    attentionSummary: (root: string) => {
        total: number;
        worst: string | null;
        engines: number;
    };
}>): Promise<FactoryStateForHud | null>;
export declare function renderFactory(state: FactoryStateForHud | null | undefined): string | null;
export {};
//# sourceMappingURL=factory.d.ts.map