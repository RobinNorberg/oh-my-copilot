import { spawnSync } from 'child_process';
const OMC_CLI_BINARY = 'omg';
const OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
function commandExists(command, env) {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, [command], {
        stdio: 'ignore',
        env,
    });
    return result.status === 0;
}
export function isOmcCliAvailable(env = process.env) {
    return commandExists(OMC_CLI_BINARY, env);
}
export function resolveOmcCliPrefix(options = {}) {
    const env = options.env ?? process.env;
    const omcAvailable = options.omcAvailable ?? isOmcCliAvailable(env);
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
    // The prefix does not depend on the suffix. Resolve it once per text, not per
    // match: each PATH lookup spawns `where`, ~75 ms on Windows.
    const prefix = resolveOmcCliPrefix(options);
    return text
        .replace(/`omc ([^`\r\n]+)`/g, (_match, suffix) => `\`${prefix} ${suffix}\``)
        .replace(/(^|\n)([ \t>*-]*)omc ([^\n]+)/g, (_match, lineStart, leader, suffix) => `${lineStart}${leader}${prefix} ${suffix}`);
}
//# sourceMappingURL=omc-cli-rendering.js.map