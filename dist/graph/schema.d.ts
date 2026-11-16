/**
 * Graph Core strict Zod content schemas.
 *
 * Contract-authored from spec `deep-interview-issue-3570-graph-core.md` and the
 * ralplan stage-04 revision (`pending-approval.md`); oracle `99ffe31` used only
 * for behavioral cross-checks, never as import authority or copied structure.
 *
 * Exported parser utilities (`parseGraphDescriptorShape`, `parseGraphNodeResult`,
 * `parseGraphApprovalDecision`, `parseGraphEvidenceReference`) throw `ZodError`
 * BY DOCUMENTED CONTRACT; callers that need a closed error boundary wrap them.
 */
import { z } from "zod";
import type { GraphApprovalDecision, GraphDescriptor, GraphEvidenceReference, GraphNodeResult } from "./types.js";
/** Stable identifier: 1–128 chars, ASCII alphanumeric first, then `[A-Za-z0-9._:-]`. */
export declare const idSchema: z.ZodString;
/** Long-form text bound (goal, instructions, command, prompt). */
export declare const textSchema: z.ZodString;
export declare const graphAgentNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"agent">;
    instructions: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, z.core.$strict>], "policy">;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>;
export declare const graphCommandNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"command">;
    command: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, z.core.$strict>], "policy">;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>;
export declare const graphHumanApprovalNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"human-approval">;
    prompt: z.ZodString;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>;
export declare const graphJoinNodeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"join">;
    fan_out_node_id: z.ZodString;
    input_branch_ids: z.ZodArray<z.ZodString>;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>;
export declare const graphNodeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"agent">;
    instructions: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, z.core.$strict>], "policy">;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"command">;
    command: z.ZodString;
    timeout_ms: z.ZodNumber;
    max_attempts: z.ZodNumber;
    effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
        policy: z.ZodLiteral<"side_effect_free">;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"idempotent">;
        idempotency_key_template: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        policy: z.ZodLiteral<"reconcile">;
    }, z.core.$strict>], "policy">;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"human-approval">;
    prompt: z.ZodString;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"join">;
    fan_out_node_id: z.ZodString;
    input_branch_ids: z.ZodArray<z.ZodString>;
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$strict>], "kind">;
export declare const graphFixedEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"fixed">;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>;
export declare const graphConditionalEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"conditional">;
    route: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>;
export declare const graphFanOutEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"fan_out">;
    branch_id: z.ZodString;
    owner_join_id: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>;
export declare const graphBackEdgeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"back_edge">;
    route: z.ZodString;
    max_traversals: z.ZodNumber;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>;
export declare const graphEdgeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"fixed">;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"conditional">;
    route: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"fan_out">;
    branch_id: z.ZodString;
    owner_join_id: z.ZodString;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"back_edge">;
    route: z.ZodString;
    max_traversals: z.ZodNumber;
    id: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strict>], "kind">;
export declare const graphDescriptorSchema: z.ZodObject<{
    descriptor_version: z.ZodLiteral<1>;
    run_id: z.ZodString;
    revision_id: z.ZodString;
    goal: z.ZodString;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"agent">;
        instructions: z.ZodString;
        timeout_ms: z.ZodNumber;
        max_attempts: z.ZodNumber;
        effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
            policy: z.ZodLiteral<"side_effect_free">;
        }, z.core.$strict>, z.ZodObject<{
            policy: z.ZodLiteral<"idempotent">;
            idempotency_key_template: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            policy: z.ZodLiteral<"reconcile">;
        }, z.core.$strict>], "policy">;
        id: z.ZodString;
        title: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"command">;
        command: z.ZodString;
        timeout_ms: z.ZodNumber;
        max_attempts: z.ZodNumber;
        effect_policy: z.ZodDiscriminatedUnion<[z.ZodObject<{
            policy: z.ZodLiteral<"side_effect_free">;
        }, z.core.$strict>, z.ZodObject<{
            policy: z.ZodLiteral<"idempotent">;
            idempotency_key_template: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            policy: z.ZodLiteral<"reconcile">;
        }, z.core.$strict>], "policy">;
        id: z.ZodString;
        title: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"human-approval">;
        prompt: z.ZodString;
        id: z.ZodString;
        title: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"join">;
        fan_out_node_id: z.ZodString;
        input_branch_ids: z.ZodArray<z.ZodString>;
        id: z.ZodString;
        title: z.ZodString;
    }, z.core.$strict>], "kind">>;
    edges: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fixed">;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"conditional">;
        route: z.ZodString;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"fan_out">;
        branch_id: z.ZodString;
        owner_join_id: z.ZodString;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"back_edge">;
        route: z.ZodString;
        max_traversals: z.ZodNumber;
        id: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>], "kind">>;
    entry_node_ids: z.ZodArray<z.ZodString>;
    concurrency_limit: z.ZodNumber;
    terminal_verification_node_id: z.ZodString;
    descriptor_hash: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const graphEvidenceReferenceSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        url: "url";
        test: "test";
        command: "command";
        file: "file";
        human: "human";
    }>;
    ref: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const graphNodeResultSchema: z.ZodObject<{
    outcome: z.ZodEnum<{
        failed: "failed";
        succeeded: "succeeded";
    }>;
    attempt_id: z.ZodString;
    route: z.ZodOptional<z.ZodString>;
    output_summary: z.ZodOptional<z.ZodString>;
    evidence_refs: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            url: "url";
            test: "test";
            command: "command";
            file: "file";
            human: "human";
        }>;
        ref: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    external_idempotency_key: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const graphApprovalDecisionSchema: z.ZodObject<{
    decision: z.ZodEnum<{
        approved: "approved";
        denied: "denied";
    }>;
    evidence_refs: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            url: "url";
            test: "test";
            command: "command";
            file: "file";
            human: "human";
        }>;
        ref: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    output_summary: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Strict shape parse; throws `ZodError` by documented contract. */
export declare function parseGraphDescriptorShape(input: unknown): GraphDescriptor;
/** Strict shape parse; throws `ZodError` by documented contract. */
export declare function parseGraphNodeResult(input: unknown): GraphNodeResult;
/** Strict shape parse; throws `ZodError` by documented contract. */
export declare function parseGraphApprovalDecision(input: unknown): GraphApprovalDecision;
/** Strict shape parse; throws `ZodError` by documented contract. */
export declare function parseGraphEvidenceReference(input: unknown): GraphEvidenceReference;
/**
 * Non-throwing stable-id predicate: `true` iff the value is a string matching
 * `idSchema` (1–128 chars, stable charset). Used by the scheduler for identity
 * values, entry identity keys/values, and identity-map keys.
 */
export declare function isValidStableId(value: unknown): boolean;
//# sourceMappingURL=schema.d.ts.map