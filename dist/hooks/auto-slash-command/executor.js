/**
 * Auto Slash Command Executor
 *
 * Discovers and executes slash commands from various sources.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getCopilotConfigDir } from '../../utils/config-dir.js';
import { resolveLiveData } from './live-data.js';
import { parseFrontmatter, parseFrontmatterAliases, stripOptionalQuotes } from '../../utils/frontmatter.js';
import { renderSkillResourcesGuidance } from '../../utils/skill-resources.js';
import { renderBundledSkillBody } from '../../features/builtin-skills/skills.js';
/** Copilot config directory */
const COPILOT_CONFIG_DIR = getCopilotConfigDir();
/**
 * Copilot CLI native commands that must not be shadowed by user skills.
 * Skills whose canonical name or alias matches one of these will be prefixed
 * with `omc-` to avoid overriding built-in CC slash commands.
 */
const CC_NATIVE_COMMANDS = new Set([
    'review',
    'plan',
    'security-review',
    'init',
    'doctor',
    'help',
    'config',
    'clear',
    'compact',
    'memory',
]);
function toSafeSkillName(name) {
    const normalized = name.trim();
    return CC_NATIVE_COMMANDS.has(normalized.toLowerCase())
        ? `omc-${normalized}`
        : normalized;
}
function getFrontmatterString(data, key) {
    const value = data[key];
    if (!value)
        return undefined;
    const normalized = stripOptionalQuotes(value);
    return normalized.length > 0 ? normalized : undefined;
}
/**
 * Discover commands from a directory
 */
function discoverCommandsFromDir(commandsDir, scope) {
    if (!existsSync(commandsDir)) {
        return [];
    }
    let entries;
    try {
        entries = readdirSync(commandsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const commands = [];
    for (const entry of entries) {
        // Only process .md files
        if (!entry.isFile() || !entry.name.endsWith('.md'))
            continue;
        const commandPath = join(commandsDir, entry.name);
        const commandName = basename(entry.name, '.md');
        try {
            const content = readFileSync(commandPath, 'utf-8');
            const { metadata: fm, body } = parseFrontmatter(content);
            const commandMetadata = {
                name: commandName,
                description: fm.description || '',
                argumentHint: fm['argument-hint'],
                model: fm.model,
                agent: fm.agent,
            };
            commands.push({
                name: commandName,
                path: commandPath,
                metadata: commandMetadata,
                content: body,
                scope,
            });
        }
        catch {
            continue;
        }
    }
    return commands;
}
/**
 * Discover all available commands from multiple sources
 */
export function discoverAllCommands() {
    const userCommandsDir = join(COPILOT_CONFIG_DIR, 'commands');
    const projectCommandsDir = join(process.cwd(), '.copilot', 'commands');
    const skillsDir = join(COPILOT_CONFIG_DIR, 'skills');
    const userCommands = discoverCommandsFromDir(userCommandsDir, 'user');
    const projectCommands = discoverCommandsFromDir(projectCommandsDir, 'project');
    // Discover skills (each skill directory may have a SKILL.md)
    const skillCommands = [];
    if (existsSync(skillsDir)) {
        try {
            const skillDirs = readdirSync(skillsDir, { withFileTypes: true });
            for (const dir of skillDirs) {
                if (!dir.isDirectory())
                    continue;
                const skillPath = join(skillsDir, dir.name, 'SKILL.md');
                if (existsSync(skillPath)) {
                    try {
                        const content = readFileSync(skillPath, 'utf-8');
                        const { metadata: fm, body } = parseFrontmatter(content);
                        const rawName = getFrontmatterString(fm, 'name') || dir.name;
                        const canonicalName = toSafeSkillName(rawName);
                        const aliases = Array.from(new Set(parseFrontmatterAliases(fm.aliases)
                            .map((alias) => toSafeSkillName(alias))
                            .filter((alias) => alias.toLowerCase() !== canonicalName.toLowerCase())));
                        const commandNames = [canonicalName, ...aliases];
                        const description = getFrontmatterString(fm, 'description') || '';
                        const argumentHint = getFrontmatterString(fm, 'argument-hint');
                        const model = getFrontmatterString(fm, 'model');
                        const agent = getFrontmatterString(fm, 'agent');
                        for (const commandName of commandNames) {
                            const isAlias = commandName !== canonicalName;
                            const metadata = {
                                name: commandName,
                                description,
                                argumentHint,
                                model,
                                agent,
                                aliases: isAlias ? undefined : aliases,
                                aliasOf: isAlias ? canonicalName : undefined,
                                deprecatedAlias: isAlias || undefined,
                                deprecationMessage: isAlias
                                    ? `Alias "/${commandName}" is deprecated. Use "/${canonicalName}" instead.`
                                    : undefined,
                            };
                            skillCommands.push({
                                name: commandName,
                                path: skillPath,
                                metadata,
                                content: body,
                                scope: 'skill',
                            });
                        }
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        catch {
            // Ignore errors reading skills directory
        }
    }
    // Priority: project > user > skills
    const prioritized = [...projectCommands, ...userCommands, ...skillCommands];
    const seen = new Set();
    return prioritized.filter((command) => {
        const key = command.name.toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/**
 * Find a specific command by name
 */
export function findCommand(commandName) {
    const allCommands = discoverAllCommands();
    return (allCommands.find((cmd) => cmd.name.toLowerCase() === commandName.toLowerCase()) ?? null);
}
/**
 * Resolve $ARGUMENTS placeholder in command content
 */
function resolveArguments(content, args) {
    return content.replace(/\$ARGUMENTS/g, args || '(no arguments provided)');
}
function hasInvocationFlag(args, flag) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(args);
}
function stripInvocationFlag(args, flag) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return args
        .replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'g'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function renderDeepInterviewAutoresearchGuidance(args) {
    const missionSeed = stripInvocationFlag(args, '--autoresearch');
    const lines = [
        '## Autoresearch Setup Mode',
        'This deep-interview invocation was launched as the zero-learning-curve setup lane for the stateful `autoresearch` skill.',
        '',
        'Required behavior in this mode:',
        '- If the mission is not already clear, start by asking: "What should autoresearch improve or prove for this repo?"',
        '- Treat evaluator clarity as a required readiness gate before launch.',
        '- When the mission and evaluator are ready, write setup artifacts and hand off with:',
        '  `Skill("oh-my-copilot:autoresearch")`',
        '- Do **not** hand off to `omc-plan`, `autopilot`, `ralph`, `team`, or the hard-deprecated `omcp autoresearch` CLI in this mode.',
    ];
    if (missionSeed) {
        lines.push('', `Mission seed from invocation: \`${missionSeed}\``);
    }
    return lines.join('\n');
}
/**
 * Format command template with metadata header
 */
function formatCommandTemplate(cmd, args) {
    const sections = [];
    sections.push(`<command-name>/${cmd.name}</command-name>\n`);
    if (cmd.metadata.description) {
        sections.push(`**Description**: ${cmd.metadata.description}\n`);
    }
    if (args) {
        sections.push(`**Arguments**: ${args}\n`);
    }
    if (cmd.metadata.model) {
        sections.push(`**Model**: ${cmd.metadata.model}\n`);
    }
    if (cmd.metadata.agent) {
        sections.push(`**Agent**: ${cmd.metadata.agent}\n`);
    }
    sections.push(`**Scope**: ${cmd.scope}\n`);
    if (cmd.metadata.aliasOf) {
        sections.push(`⚠️ **Deprecated Alias**: \`/${cmd.name}\` is deprecated and will be removed in a future release. Use \`/${cmd.metadata.aliasOf}\` instead.\n`);
    }
    sections.push('---\n');
    // Resolve arguments in content, then execute any live-data commands
    const resolvedContent = resolveArguments(cmd.content || '', args);
    const baseContent = resolveLiveData(resolvedContent);
    const injectedContent = cmd.scope === 'skill'
        ? renderBundledSkillBody(cmd.metadata.name, baseContent)
        : baseContent;
    sections.push(injectedContent.trim());
    // Add skill resources guidance (bundled files in skill directory)
    const resourcesGuidance = cmd.path ? renderSkillResourcesGuidance(cmd.path) : '';
    if (resourcesGuidance) {
        sections.push('\n\n---\n');
        sections.push(resourcesGuidance);
    }
    if (args && !cmd.content?.includes('$ARGUMENTS')) {
        sections.push('\n\n---\n');
        sections.push('## User Request\n');
        sections.push(args);
    }
    return sections.join('\n');
}
/**
 * Execute a slash command and return replacement text
 */
export function executeSlashCommand(parsed) {
    const command = findCommand(parsed.command);
    if (!command) {
        return {
            success: false,
            error: `Command "/${parsed.command}" not found. Available commands are in ${COPILOT_CONFIG_DIR}/commands/ or .copilot/commands/`,
        };
    }
    try {
        const template = formatCommandTemplate(command, parsed.args);
        return {
            success: true,
            replacementText: template,
        };
    }
    catch (err) {
        return {
            success: false,
            error: `Failed to load command "/${parsed.command}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
/**
 * List all available commands
 */
export function listAvailableCommands() {
    return listAvailableCommandsWithOptions();
}
export function listAvailableCommandsWithOptions(options) {
    const { includeAliases = false } = options ?? {};
    const commands = discoverAllCommands();
    const visibleCommands = includeAliases
        ? commands
        : commands.filter((cmd) => !cmd.metadata.aliasOf);
    return visibleCommands.map((cmd) => ({
        name: cmd.name,
        description: cmd.metadata.description,
        scope: cmd.scope,
    }));
}
//# sourceMappingURL=executor.js.map