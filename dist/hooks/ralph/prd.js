/**
 * Ralph PRD (Product Requirements Document) Support
 *
 * Implements structured task tracking using prd.json format from the original Ralph.
 * Each user story has:
 * - id: Unique identifier (e.g., "US-001")
 * - title: Short description
 * - description: User story format
 * - acceptanceCriteria: List of criteria to pass
 * - priority: Execution order (1 = highest)
 * - passes: Boolean indicating completion
 * - notes: Optional notes from implementation
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
// ============================================================================
// Constants
// ============================================================================
export const PRD_FILENAME = 'prd.json';
export const PRD_EXAMPLE_FILENAME = 'prd.example.json';
function normalizeStory(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const story = candidate;
    if (typeof story.id !== 'string' ||
        typeof story.title !== 'string' ||
        typeof story.description !== 'string' ||
        !Array.isArray(story.acceptanceCriteria) ||
        !story.acceptanceCriteria.every(criterion => typeof criterion === 'string') ||
        typeof story.priority !== 'number' ||
        !Number.isFinite(story.priority) ||
        typeof story.passes !== 'boolean') {
        return null;
    }
    return {
        id: story.id,
        title: story.title,
        description: story.description,
        acceptanceCriteria: [...story.acceptanceCriteria],
        priority: story.priority,
        passes: story.passes,
        architectVerified: story.architectVerified === true,
        notes: typeof story.notes === 'string' ? story.notes : undefined
    };
}
function normalizePrd(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const prd = candidate;
    if (typeof prd.project !== 'string' ||
        typeof prd.branchName !== 'string' ||
        typeof prd.description !== 'string' ||
        !Array.isArray(prd.userStories)) {
        return null;
    }
    const userStories = prd.userStories
        .map(normalizeStory);
    if (userStories.some(story => story === null)) {
        return null;
    }
    return {
        project: prd.project,
        branchName: prd.branchName,
        description: prd.description,
        userStories: userStories
    };
}
function readPrdFromPath(prdPath) {
    try {
        const content = readFileSync(prdPath, 'utf-8');
        const parsed = JSON.parse(content);
        const normalized = normalizePrd(parsed);
        if (!normalized) {
            return { error: `Invalid PRD structure in ${prdPath}.` };
        }
        return { prd: normalized };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to read ${prdPath}: ${message}` };
    }
}
function isStoryComplete(story) {
    return story.passes && story.architectVerified === true;
}
// ============================================================================
// File Operations
// ============================================================================
/**
 * Get the path to the prd.json file in a directory
 */
export function getPrdPath(directory) {
    return join(directory, PRD_FILENAME);
}
/**
 * Get the path to the prd.json in .omc subdirectory
 */
export function getOmcPrdPath(directory) {
    return join(getOmcRoot(directory), PRD_FILENAME);
}
/**
 * Find prd.json in a directory (checks both root and .omc)
 */
export function findPrdPath(directory) {
    const rootPath = getPrdPath(directory);
    if (existsSync(rootPath)) {
        return rootPath;
    }
    const omcPath = getOmcPrdPath(directory);
    if (existsSync(omcPath)) {
        return omcPath;
    }
    return null;
}
/**
 * Read PRD from disk
 */
export function readPrd(directory) {
    const prdPath = findPrdPath(directory);
    if (!prdPath) {
        return null;
    }
    return readPrdFromPath(prdPath).prd ?? null;
}
/**
 * Write PRD to disk
 */
export function writePrd(directory, prd) {
    // Prefer writing to existing location, or .omc by default
    let prdPath = findPrdPath(directory);
    if (!prdPath) {
        const omcDir = getOmcRoot(directory);
        if (!existsSync(omcDir)) {
            try {
                mkdirSync(omcDir, { recursive: true });
            }
            catch {
                return false;
            }
        }
        prdPath = getOmcPrdPath(directory);
    }
    try {
        writeFileSync(prdPath, JSON.stringify(prd, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
// ============================================================================
// PRD Status & Operations
// ============================================================================
/**
 * Get the status of a PRD
 */
export function getPrdStatus(prd) {
    const stories = prd.userStories;
    const pending = stories.filter(s => !isStoryComplete(s));
    const fullyCompleted = stories.filter(isStoryComplete);
    // Sort pending by priority to find next story
    const sortedPending = [...pending].sort((a, b) => a.priority - b.priority);
    return {
        total: stories.length,
        completed: fullyCompleted.length,
        pending: pending.length,
        allComplete: pending.length === 0,
        nextStory: sortedPending[0] || null,
        incompleteIds: pending.map(s => s.id)
    };
}
/**
 * Mark a story as complete (passes: true)
 */
export function markStoryComplete(directory, storyId, notes) {
    const prd = readPrd(directory);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.passes = true;
    story.architectVerified = false;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd);
}
/**
 * Mark a story as incomplete (passes: false)
 */
export function markStoryIncomplete(directory, storyId, notes) {
    const prd = readPrd(directory);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.passes = false;
    story.architectVerified = false;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd);
}
/**
 * Mark a story as architect-verified after reviewer approval
 */
export function markStoryArchitectVerified(directory, storyId, notes) {
    const prd = readPrd(directory);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.architectVerified = true;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd);
}
/**
 * Get a specific story by ID
 */
export function getStory(directory, storyId) {
    const prd = readPrd(directory);
    if (!prd) {
        return null;
    }
    return prd.userStories.find(s => s.id === storyId) || null;
}
/**
 * Get the next incomplete story (highest priority)
 */
export function getNextStory(directory) {
    const prd = readPrd(directory);
    if (!prd) {
        return null;
    }
    const status = getPrdStatus(prd);
    return status.nextStory;
}
/**
 * Create a new PRD with user stories from a task description
 */
export function createPrd(project, branchName, description, stories) {
    return {
        project,
        branchName,
        description,
        userStories: stories.map((s, index) => ({
            ...s,
            priority: s.priority ?? index + 1,
            passes: false,
            architectVerified: false
        }))
    };
}
/**
 * Create a simple PRD from a task description (single story)
 */
export function createSimplePrd(project, branchName, taskDescription) {
    return createPrd(project, branchName, taskDescription, [
        {
            id: 'US-001',
            title: taskDescription.slice(0, 50) + (taskDescription.length > 50 ? '...' : ''),
            description: taskDescription,
            acceptanceCriteria: [
                'Implementation is complete',
                'Code compiles/runs without errors',
                'Tests pass (if applicable)',
                'Changes are committed'
            ],
            priority: 1
        }
    ]);
}
/**
 * Initialize a PRD in a directory
 */
export function initPrd(directory, project, branchName, description, stories) {
    const prd = stories
        ? createPrd(project, branchName, description, stories)
        : createSimplePrd(project, branchName, description);
    return writePrd(directory, prd);
}
/**
 * Ensure Ralph startup has a valid PRD.json to work from.
 * - Missing PRD -> create scaffold
 * - Invalid PRD -> fail clearly
 */
export function ensurePrdForStartup(directory, project, branchName, description, stories) {
    const existingPath = findPrdPath(directory);
    if (!existingPath) {
        const created = initPrd(directory, project, branchName, description, stories);
        const createdPath = findPrdPath(directory);
        const prd = created ? readPrd(directory) : null;
        if (!created || !createdPath || !prd) {
            return {
                ok: false,
                created: false,
                path: createdPath,
                error: `Ralph requires a valid ${PRD_FILENAME} at startup, but scaffold creation failed.`
            };
        }
        if (prd.userStories.length === 0) {
            return {
                ok: false,
                created: true,
                path: createdPath,
                error: `Ralph created ${createdPath}, but it contains no user stories.`
            };
        }
        return { ok: true, created: true, path: createdPath, prd };
    }
    const parsed = readPrdFromPath(existingPath);
    if (!parsed.prd) {
        return {
            ok: false,
            created: false,
            path: existingPath,
            error: parsed.error ?? `Ralph requires a valid ${PRD_FILENAME} at startup.`
        };
    }
    if (parsed.prd.userStories.length === 0) {
        return {
            ok: false,
            created: false,
            path: existingPath,
            error: `${existingPath} must contain at least one user story for Ralph to start.`
        };
    }
    return {
        ok: true,
        created: false,
        path: existingPath,
        prd: parsed.prd
    };
}
// ============================================================================
// PRD Formatting
// ============================================================================
/**
 * Format PRD status as a string for display
 */
export function formatPrdStatus(status) {
    const lines = [];
    lines.push(`[PRD Status: ${status.completed}/${status.total} stories complete]`);
    if (status.allComplete) {
        lines.push('All stories are COMPLETE!');
    }
    else {
        lines.push(`Remaining: ${status.incompleteIds.join(', ')}`);
        if (status.nextStory) {
            lines.push(`Next story: ${status.nextStory.id} - ${status.nextStory.title}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format a story for display
 */
export function formatStory(story) {
    const lines = [];
    lines.push(`## ${story.id}: ${story.title}`);
    const statusLabel = isStoryComplete(story)
        ? 'COMPLETE'
        : story.passes
            ? 'AWAITING ARCHITECT REVIEW'
            : 'PENDING';
    lines.push(`Status: ${statusLabel}`);
    lines.push(`Priority: ${story.priority}`);
    lines.push('');
    lines.push(story.description);
    lines.push('');
    lines.push('**Acceptance Criteria:**');
    story.acceptanceCriteria.forEach((c, i) => {
        lines.push(`${i + 1}. ${c}`);
    });
    if (story.notes) {
        lines.push('');
        lines.push(`**Notes:** ${story.notes}`);
    }
    return lines.join('\n');
}
/**
 * Format entire PRD for display
 */
export function formatPrd(prd) {
    const lines = [];
    const status = getPrdStatus(prd);
    lines.push(`# ${prd.project}`);
    lines.push(`Branch: ${prd.branchName}`);
    lines.push('');
    lines.push(prd.description);
    lines.push('');
    lines.push(formatPrdStatus(status));
    lines.push('');
    lines.push('---');
    lines.push('');
    // Sort by priority for display
    const sortedStories = [...prd.userStories].sort((a, b) => a.priority - b.priority);
    for (const story of sortedStories) {
        lines.push(formatStory(story));
        lines.push('');
        lines.push('---');
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Format next story prompt for injection into ralph
 */
export function formatNextStoryPrompt(story) {
    return `<current-story>

## Current Story: ${story.id} - ${story.title}

${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**Instructions:**
1. Implement this story completely
2. Verify ALL acceptance criteria are met
3. Run quality checks (tests, typecheck, lint)
4. When complete, mark story as passes: true in prd.json
5. If ALL stories are done, run \`/oh-my-copilot:cancel\` to cleanly exit ralph mode and clean up all state files

</current-story>

---

`;
}
//# sourceMappingURL=prd.js.map