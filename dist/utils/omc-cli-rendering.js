import { spawnSync } from 'child_process';
const OMC_CLI_BINARY = 'omcp';
const OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
// Per-process cache: `where`/`which` spawnSync on Windows costs ~150ms/call,
// and rewriteOmcCliInvocations is called for every OMC CLI reference in every
// bundled skill body (~400+ calls per skill catalog load). Cache by PATH+PATHEXT
// so any env change still triggers a fresh probe.
const commandExistsCache = new Map();
function commandExists(command, env) {
    const pathValue = env.PATH ?? env.Path ?? '';
    const pathExt = env.PATHEXT ?? '';
    const cacheKey = `${command}\u0000${pathValue}\u0000${pathExt}`;
    const cached = commandExistsCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, [command], {
        stdio: 'ignore',
        env,
    });
    const found = result.status === 0;
    commandExistsCache.set(cacheKey, found);
    return found;
}
export function resolveOmcCliPrefix(options = {}) {
    const env = options.env ?? process.env;
    const omcAvailable = options.omcAvailable ?? commandExists(OMC_CLI_BINARY, env);
    if (omcAvailable) {
        return OMC_CLI_BINARY;
    }
    const pluginRoot = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.trim() : '';
    if (pluginRoot) {
        return OMC_PLUGIN_BRIDGE_PREFIX;
    }
    return OMC_CLI_BINARY;
}
function resolveInvocationPrefix(commandSuffix, options = {}) {
    void commandSuffix;
    return resolveOmcCliPrefix(options);
}
export function formatOmcCliInvocation(commandSuffix, options = {}) {
    const suffix = commandSuffix.trim().replace(/^omc\s+/, '');
    return `${resolveInvocationPrefix(suffix, options)} ${suffix}`.trim();
}
export function rewriteOmcCliInvocations(text, options = {}) {
    if (!text.includes('omc ')) {
        return text;
    }
    return text
        .replace(/`omc ([^`\r\n]+)`/g, (_match, suffix) => {
        const prefix = resolveInvocationPrefix(suffix, options);
        return `\`${prefix} ${suffix}\``;
    })
        .replace(/(^|\n)([ \t>*-]*)omc ([^\n]+)/g, (_match, lineStart, leader, suffix) => {
        const prefix = resolveInvocationPrefix(suffix, options);
        return `${lineStart}${leader}${prefix} ${suffix}`;
    });
}
//# sourceMappingURL=omc-cli-rendering.js.map