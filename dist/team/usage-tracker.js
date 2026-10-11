// src/team/usage-tracker.ts
/**
 * Usage tracker for team sessions.
 *
 * Tracks wall-clock time and prompt/response character counts per task.
 * NOTE: Token counts are not available from Codex/Gemini CLI output.
 * Character counts serve as a rough proxy for usage estimation.
 *
 * Storage: append-only JSONL at .omg/logs/team-usage-{team}.jsonl
 */
import { z } from 'zod';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { appendFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
function getUsageLogPath(workingDirectory, teamName) {
    return join(getOmcRoot(workingDirectory), 'logs', `team-usage-${teamName}.jsonl`);
}
/**
 * Record usage for a completed task.
 */
export function recordTaskUsage(workingDirectory, teamName, record) {
    const logPath = getUsageLogPath(workingDirectory, teamName);
    const dir = join(getOmcRoot(workingDirectory), 'logs');
    // logPath lives under getOmcRoot(...)/logs, which in a .omc-workspace layout
    // is ABOVE workingDirectory. Validate against the shared logs dir (still
    // catches teamName traversal) instead of the sub-repo.
    validateResolvedPath(logPath, dir);
    ensureDirWithMode(dir);
    appendFileWithMode(logPath, JSON.stringify(record) + '\n');
}
/** Count UTF-8 Unicode code points with bounded memory, preserving split characters. */
function countFileCharacters(filePath) {
    const descriptor = openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new StringDecoder('utf8');
        let count = 0;
        let bytesRead;
        while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            for (const _character of decoder.write(buffer.subarray(0, bytesRead)))
                count++;
        }
        for (const _character of decoder.end())
            count++;
        return count;
    }
    finally {
        closeSync(descriptor);
    }
}
/**
 * Compute Unicode code point counts from UTF-8 prompt and output files.
 * Combining marks count separately; these are not grapheme or token counts.
 * Returns { promptChars, responseChars }. Returns 0 for missing/unreadable files.
 */
export function measureCharCounts(promptFilePath, outputFilePath) {
    let promptChars = 0;
    let responseChars = 0;
    try {
        promptChars = countFileCharacters(promptFilePath);
    }
    catch { /* missing or unreadable file */ }
    try {
        responseChars = countFileCharacters(outputFilePath);
    }
    catch { /* missing or unreadable file */ }
    return { promptChars, responseChars };
}
const nonemptyString = z.string().refine(value => value.trim().length > 0);
const taskUsageRecordSchema = z.object({
    taskId: nonemptyString,
    workerName: nonemptyString,
    provider: z.enum(['codex', 'gemini']),
    model: z.string(),
    startedAt: nonemptyString,
    completedAt: nonemptyString,
    wallClockMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    promptChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    responseChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const ZERO_DURATION = { coefficient: 0n, scale: 0 };
const MAX_SAFE_DURATION = { coefficient: BigInt(Number.MAX_SAFE_INTEGER), scale: 0 };
function exactDecimalFromNumber(value) {
    const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    let coefficient = BigInt(`${whole}${fraction}`);
    let scale = fraction.length - Number(exponentText ?? 0);
    if (scale < 0) {
        coefficient *= 10n ** BigInt(-scale);
        scale = 0;
    }
    return { coefficient, scale };
}
function alignExactDecimals(left, right) {
    const scale = Math.max(left.scale, right.scale);
    return [
        left.coefficient * 10n ** BigInt(scale - left.scale),
        right.coefficient * 10n ** BigInt(scale - right.scale),
        scale,
    ];
}
function addExactDecimals(left, right) {
    const [leftCoefficient, rightCoefficient, scale] = alignExactDecimals(left, right);
    return { coefficient: leftCoefficient + rightCoefficient, scale };
}
function compareExactDecimals(left, right) {
    const [leftCoefficient, rightCoefficient] = alignExactDecimals(left, right);
    return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}
function exactDecimalToNumber(value) {
    const isNegative = value.coefficient < 0n;
    const digits = (isNegative ? -value.coefficient : value.coefficient).toString();
    const integerLength = digits.length - value.scale;
    const magnitude = value.scale === 0
        ? digits
        : integerLength > 0
            ? `${digits.slice(0, integerLength)}.${digits.slice(integerLength)}`
            : `0.${'0'.repeat(-integerLength)}${digits}`;
    return Number(isNegative ? `-${magnitude}` : magnitude);
}
/**
 * Read all usage records from the JSONL log.
 */
function readUsageRecords(workingDirectory, teamName) {
    const logPath = getUsageLogPath(workingDirectory, teamName);
    if (!existsSync(logPath))
        return [];
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const records = [];
    for (const line of lines) {
        try {
            const record = taskUsageRecordSchema.safeParse(JSON.parse(line));
            if (record.success)
                records.push(record.data);
        }
        catch { /* skip malformed */ }
    }
    return records;
}
/**
 * Generate usage report for a team session.
 * Aggregates TaskUsageRecords from the JSONL log.
 */
export function generateUsageReport(workingDirectory, teamName) {
    const records = readUsageRecords(workingDirectory, teamName);
    // Aggregate per worker
    const workerMap = new Map();
    const workerDurationTotals = new Map();
    let totalWallClockMsExact = ZERO_DURATION;
    for (const r of records) {
        const existing = workerMap.get(r.workerName);
        const currentWallClockMsExact = workerDurationTotals.get(r.workerName) ?? ZERO_DURATION;
        const durationExact = exactDecimalFromNumber(r.wallClockMs);
        const nextWallClockMsExact = addExactDecimals(currentWallClockMsExact, durationExact);
        const nextPromptChars = (existing?.totalPromptChars ?? 0) + r.promptChars;
        const nextResponseChars = (existing?.totalResponseChars ?? 0) + r.responseChars;
        const nextTotalWallClockMsExact = addExactDecimals(totalWallClockMsExact, durationExact);
        if (compareExactDecimals(nextWallClockMsExact, MAX_SAFE_DURATION) > 0
            || compareExactDecimals(nextTotalWallClockMsExact, MAX_SAFE_DURATION) > 0)
            continue;
        const nextWallClockMs = exactDecimalToNumber(nextWallClockMsExact);
        const nextTotalWallClockMs = exactDecimalToNumber(nextTotalWallClockMsExact);
        if (!Number.isFinite(nextWallClockMs) || !Number.isFinite(nextTotalWallClockMs)
            || !Number.isSafeInteger(nextPromptChars) || !Number.isSafeInteger(nextResponseChars))
            continue;
        workerDurationTotals.set(r.workerName, nextWallClockMsExact);
        totalWallClockMsExact = nextTotalWallClockMsExact;
        if (existing) {
            existing.taskCount++;
            existing.totalWallClockMs = nextWallClockMs;
            existing.totalPromptChars = nextPromptChars;
            existing.totalResponseChars = nextResponseChars;
        }
        else {
            workerMap.set(r.workerName, {
                workerName: r.workerName,
                provider: r.provider,
                model: r.model,
                taskCount: 1,
                totalWallClockMs: nextWallClockMs,
                totalPromptChars: r.promptChars,
                totalResponseChars: r.responseChars,
            });
        }
    }
    const workers = Array.from(workerMap.values());
    return {
        teamName,
        totalWallClockMs: exactDecimalToNumber(totalWallClockMsExact),
        taskCount: workers.reduce((sum, w) => sum + w.taskCount, 0),
        workers,
    };
}
//# sourceMappingURL=usage-tracker.js.map