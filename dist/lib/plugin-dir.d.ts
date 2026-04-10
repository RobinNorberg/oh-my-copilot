/**
 * Shared helper for resolving a --plugin-dir argument to an absolute path.
 *
 * Used by both `src/cli/launch.ts` (non-consuming parse of the raw argv array)
 * and `src/cli/index.ts` (Commander option value passed as a string).
 */
/**
 * Resolve a raw `--plugin-dir` value (relative or absolute string) to an
 * absolute path.  Throws with a clear message if the value is empty.
 */
export declare function resolvePluginDirArg(rawPath: string): string;
//# sourceMappingURL=plugin-dir.d.ts.map