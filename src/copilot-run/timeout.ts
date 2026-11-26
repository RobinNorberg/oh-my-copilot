/** Small helpers shared by job.ts and sandbox-session.ts. */

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The rejection of {@link withTimeout}: the call may still complete later. */
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
