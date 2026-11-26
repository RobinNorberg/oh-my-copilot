/** Small helpers shared by job.ts and sandbox-session.ts. */
export const errText = (err) => (err instanceof Error ? err.message : String(err));
/** The rejection of {@link withTimeout}: the call may still complete later. */
export class TimeoutError extends Error {
}
export function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
//# sourceMappingURL=timeout.js.map