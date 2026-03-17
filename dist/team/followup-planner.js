// src/team/followup-planner.ts
/**
 * Post-ralplan follow-up planner.
 *
 * Detects short follow-up requests after a ralplan cycle has completed
 * and an approved execution plan exists.  When all conditions are met,
 * the follow-up can bypass the ralplan gate and launch the approved
 * team / ralph execution directly.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
function readPlanningArtifacts(cwd) {
    const plansDir = join(cwd, '.omg', 'plans');
    if (!existsSync(plansDir)) {
        return { prdPaths: [], testSpecPaths: [] };
    }
    let entries;
    try {
        entries = readdirSync(plansDir);
    }
    catch {
        return { prdPaths: [], testSpecPaths: [] };
    }
    const prdPaths = [];
    const testSpecPaths = [];
    for (const entry of entries) {
        if (entry.startsWith('prd-') && entry.endsWith('.md')) {
            prdPaths.push(join(plansDir, entry));
        }
        else if (entry.startsWith('test-spec-') && entry.endsWith('.md')) {
            testSpecPaths.push(join(plansDir, entry));
        }
    }
    // Sort descending so newest (lexicographically last) is first
    prdPaths.sort((a, b) => b.localeCompare(a));
    testSpecPaths.sort((a, b) => b.localeCompare(a));
    return { prdPaths, testSpecPaths };
}
function isPlanningComplete(artifacts) {
    return artifacts.prdPaths.length > 0 && artifacts.testSpecPaths.length > 0;
}
const TEAM_LAUNCH_RE = /\bomc\s+team\s+(?:(\d+):(\w+)\s+)?"([^"]+)"((?:\s+--[\w-]+)*)/g;
const RALPH_LAUNCH_RE = /\bomc\s+ralph\s+"([^"]+)"((?:\s+--[\w-]+)*)/g;
function parseFlags(flagStr) {
    return {
        linkedRalph: /--linked-ralph/.test(flagStr),
    };
}
function readApprovedExecutionLaunchHint(cwd, mode) {
    const artifacts = readPlanningArtifacts(cwd);
    if (artifacts.prdPaths.length === 0)
        return null;
    const prdPath = artifacts.prdPaths[0];
    let content;
    try {
        content = readFileSync(prdPath, 'utf-8');
    }
    catch {
        return null;
    }
    if (mode === 'team') {
        TEAM_LAUNCH_RE.lastIndex = 0;
        const match = TEAM_LAUNCH_RE.exec(content);
        if (!match)
            return null;
        const [fullMatch, workerCountStr, agentType, task, flagStr] = match;
        const { linkedRalph } = parseFlags(flagStr ?? '');
        return {
            mode: 'team',
            command: fullMatch.trim(),
            task,
            workerCount: workerCountStr ? parseInt(workerCountStr, 10) : undefined,
            agentType: agentType || undefined,
            linkedRalph,
            sourcePath: prdPath,
        };
    }
    if (mode === 'ralph') {
        RALPH_LAUNCH_RE.lastIndex = 0;
        const match = RALPH_LAUNCH_RE.exec(content);
        if (!match)
            return null;
        const [fullMatch, task, flagStr] = match;
        const { linkedRalph } = parseFlags(flagStr ?? '');
        return {
            mode: 'ralph',
            command: fullMatch.trim(),
            task,
            linkedRalph,
            sourcePath: prdPath,
        };
    }
    return null;
}
/**
 * Short team follow-up patterns.
 * Matches: "team", "team please", "/team", "run team", etc.
 */
const SHORT_TEAM_PATTERNS = [
    /^\s*\/?\s*team\s*$/i,
    /^\s*team\s+please\s*$/i,
    /^\s*run\s+team\s*$/i,
    /^\s*start\s+team\s*$/i,
    /^\s*team으로\s+해줘\s*$/i,
    /^\s*launch\s+team\s*$/i,
    /^\s*go\s+team\s*$/i,
];
/**
 * Short ralph follow-up patterns.
 * Matches: "ralph", "ralph please", "/ralph", "run ralph", etc.
 */
const SHORT_RALPH_PATTERNS = [
    /^\s*\/?\s*ralph\s*$/i,
    /^\s*ralph\s+please\s*$/i,
    /^\s*run\s+ralph\s*$/i,
    /^\s*start\s+ralph\s*$/i,
    /^\s*launch\s+ralph\s*$/i,
    /^\s*go\s+ralph\s*$/i,
];
/**
 * Returns true if the text is a short team follow-up request.
 */
export function isShortTeamFollowupRequest(text) {
    return SHORT_TEAM_PATTERNS.some(re => re.test(text));
}
/**
 * Returns true if the text is a short ralph follow-up request.
 */
export function isShortRalphFollowupRequest(text) {
    return SHORT_RALPH_PATTERNS.some(re => re.test(text));
}
/**
 * Returns true when ALL of the following conditions hold:
 * 1. Planning is complete (planningComplete === true)
 * 2. The prior skill was 'ralplan'
 * 3. The text matches a short follow-up for the given mode
 */
export function isApprovedExecutionFollowupShortcut(mode, text, context) {
    if (!context.planningComplete)
        return false;
    if (context.priorSkill !== 'ralplan')
        return false;
    if (mode === 'team')
        return isShortTeamFollowupRequest(text);
    if (mode === 'ralph')
        return isShortRalphFollowupRequest(text);
    return false;
}
/**
 * Resolve the full follow-up context for a short team follow-up.
 * Reads the approved plan and extracts the launch configuration.
 * Returns null when no approved plan is available.
 */
export function resolveApprovedTeamFollowupContext(cwd, _task) {
    const artifacts = readPlanningArtifacts(cwd);
    if (!isPlanningComplete(artifacts))
        return null;
    const hint = readApprovedExecutionLaunchHint(cwd, 'team');
    if (!hint)
        return null;
    return {
        hint,
        launchCommand: hint.command,
    };
}
//# sourceMappingURL=followup-planner.js.map