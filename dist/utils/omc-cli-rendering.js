import { spawnSync } from 'child_process';
const OMC_CLI_BINARY = 'omcp';
const OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
function isClaudeSession(env) {
    return Boolean(env.CLAUDECODE?.trim()
        || env.CLAUDE_SESSION_ID?.trim()
        || env.CLAUDECODE_SESSION_ID?.trim());
}
function commandExists(command, env) {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, [command], {
        stdio: 'ignore',
        env,
    });
    return result.status === 0;
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
    const env = options.env ?? process.env;
    const normalizedSuffix = commandSuffix.trim();
    // Ask flows are intentionally safe inside Claude Code and must not be
    // rewritten to the bridge binary, which can re-enter the launch guard.
    if (/^ask(?:\s|$)/.test(normalizedSuffix) && isClaudeSession(env)) {
        return OMC_CLI_BINARY;
    }
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