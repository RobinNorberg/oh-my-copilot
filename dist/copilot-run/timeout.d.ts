/** Small helpers shared by job.ts and sandbox-session.ts. */
export declare const errText: (err: unknown) => string;
/** The rejection of {@link withTimeout}: the call may still complete later. */
export declare class TimeoutError extends Error {
}
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
//# sourceMappingURL=timeout.d.ts.map