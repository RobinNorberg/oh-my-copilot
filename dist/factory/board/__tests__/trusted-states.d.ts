/**
 * Test helper: record every run state on disk in the engine ledger, as the
 * engine records its own writes. The board and poll show a state the ledger
 * does not hold as "not verified"; tests of trusted output call this after
 * planting their states. A state that fails its seal stays untrusted.
 */
export declare function engineWroteAll(root: string, ledgerDir: string): void;
//# sourceMappingURL=trusted-states.d.ts.map