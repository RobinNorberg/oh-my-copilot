/** Small helpers shared by job.ts and sandbox-session.ts. */
export const errText = (err) => (err instanceof Error ? err.message : String(err));
export function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
//# sourceMappingURL=timeout.js.map