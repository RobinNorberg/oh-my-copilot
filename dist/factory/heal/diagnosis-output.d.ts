/**
 * The debugger lane's output contract (design §5). The final assistant
 * message ends with exactly one fenced `json` block, under the same fence
 * rules as the review lane (review-output.ts):
 *
 *   { "class": "regression" | "env-change" | "test-bug" | "flaky" | "unknown",
 *     "rootCause": "...", "evidence": ["failures/1.log:12", "env-diff.json:git"],
 *     "reproduced": true | false, "reproCommand"?: "npx vitest run <file>",
 *     "fix": { "summary": "...", "files": ["src/..."], "acceptance": ["..."] } | null }
 *
 * The lane read untrusted CI text, so anything off-contract is `invalid`.
 * Each evidence citation must name a file in the bundle and an anchor in it:
 * a line number within the file, or, for a JSON file, a key it holds. A
 * schema-valid diagnosis is `rejected` (recorded, never acted on) when its
 * class is `flaky` (known-flaky additions are human-only) or its fix names a
 * protected path.
 */
import type { EvidenceBundle } from './evidence.js';
export declare const DIAGNOSIS_CLASSES: readonly ["regression", "env-change", "test-bug", "flaky", "unknown"];
export type DiagnosisClass = (typeof DIAGNOSIS_CLASSES)[number];
export declare const DIAGNOSIS_LIMITS: Readonly<{
    rootCause: 2000;
    evidence: 20;
    citation: 200;
    reproCommand: 300;
    fixSummary: 1000;
    fixFiles: 20;
    acceptance: 10;
    acceptanceItem: 300;
}>;
export interface Diagnosis {
    class: DiagnosisClass;
    rootCause: string;
    evidence: string[];
    reproduced: boolean;
    reproCommand?: string;
    fix: {
        summary: string;
        files: string[];
        acceptance: string[];
    } | null;
}
export type ParsedDiagnosis = {
    kind: 'valid';
    diagnosis: Diagnosis;
} | {
    kind: 'rejected';
    diagnosis: Diagnosis;
    reason: string;
} | {
    kind: 'invalid';
    reason: string;
};
/** Why a citation does not point into the bundle, or null. */
export declare function citationProblem(citation: string, bundle: EvidenceBundle): string | null;
export declare function parseDiagnosisOutput(finalText: string | null | undefined, bundle: EvidenceBundle): ParsedDiagnosis;
/**
 * The contract on a parsed diagnosis object. `bundle` null skips the
 * citation check only: the ci-heal engine re-checks its sealed copy of a
 * diagnosis whose citations were checked when the lane answered.
 */
export declare function checkDiagnosis(raw: unknown, bundle: EvidenceBundle | null): ParsedDiagnosis;
//# sourceMappingURL=diagnosis-output.d.ts.map