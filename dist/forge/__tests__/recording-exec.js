/** A value naming a placeholder directory gets the placeholder and `/` separators; any other value is kept as is. */
export function normalize(value, places) {
    for (const [name, dir] of Object.entries(places)) {
        if (value.includes(dir))
            return value.split(dir).join(name).replace(/\\/g, '/');
    }
    return value;
}
/** One recorded call as a single line. */
export function callLine(cmd, args, opts, places = {}) {
    const parts = [`${cmd} ${JSON.stringify(args.map((a) => normalize(a, places)))}`];
    if (opts?.cwd !== undefined)
        parts.push(`cwd=${normalize(opts.cwd, places)}`);
    if (opts?.env !== undefined)
        parts.push(`env=${Object.keys(opts.env).sort().join(',')}`);
    if (opts?.input !== undefined)
        parts.push(`stdin=${JSON.stringify(opts.input)}`);
    return parts.join(' ');
}
/**
 * Wrap `inner` so every call is recorded before it runs. `only` limits the
 * record to those commands (the forge move touches gh; git and node stay put).
 */
export function recordingExec(inner, places = {}, only) {
    const calls = [];
    const exec = (cmd, args, opts) => {
        if (!only || only.includes(cmd))
            calls.push(callLine(cmd, args, opts, places));
        return inner(cmd, args, opts);
    };
    return { exec, calls };
}
//# sourceMappingURL=recording-exec.js.map