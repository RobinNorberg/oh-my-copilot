/**
 * `omg smoke copilot` — load-check the plugin inside the real Copilot CLI.
 * Exit codes: 0 all checks ok; 1 any check failed (or bad options / a crash);
 * 2 skipped because the copilot binary or the optional `@github/copilot-sdk`
 * peer is missing and no other check failed.
 * With --json a SmokeReport is ALWAYS printed, including for option errors and
 * crashes (then `ok:false` with one `cli.error` check).
 */
import { homedir } from 'os';
import { join, resolve } from 'path';
import { colors } from '../utils/formatting.js';
import { ALL_SCENARIOS, cassetteOptionsError, KNOWN_SCENARIOS, MIN_MAX_CREDITS, runCopilotSmoke, } from '../../smoke/copilot-smoke.js';
import { SDK_MISSING_DETAIL } from '../../smoke/copilot-sdk-scenarios.js';
import { gateCassettes, importCassettes, platformTag, writeSelfVerify } from '../../smoke/replay/run.js';
/** A leading `~` as the home dir: PowerShell passes `~/omg-cassettes` to a native command unexpanded. */
export function expandHome(dir) {
    return dir === '~' || /^~[\\/]/.test(dir) ? join(homedir(), dir.slice(2)) : dir;
}
function parsePositiveInt(value, flag) {
    if (value === undefined)
        return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0)
        throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
    return n;
}
/** Parse `--scenario a,b` / `all` into a deduplicated, validated list; `all` never includes the opt-in scenarios (OPT_IN_SCENARIOS). */
export function parseScenarios(raw) {
    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length === 0)
        throw new Error('--scenario needs at least one name (or `all`)');
    const out = [];
    for (const name of names) {
        const expanded = name === 'all' ? ALL_SCENARIOS : [name];
        for (const n of expanded) {
            if (!KNOWN_SCENARIOS.includes(n)) {
                throw new Error(`--scenario: unknown scenario ${JSON.stringify(n)} (expected ${KNOWN_SCENARIOS.join(', ')} or all)`);
            }
            if (!out.includes(n))
                out.push(n);
        }
    }
    return out;
}
export function toSmokeOptions(cli, env = process.env) {
    const wantsTier2 = cli.sdkStatic === true || cli.scenario !== undefined || cli.record !== undefined || cli.replay !== undefined;
    const tierRaw = cli.tier ?? (wantsTier2 ? '2' : '0');
    if (tierRaw !== '0' && tierRaw !== '1' && tierRaw !== '2') {
        throw new Error(`--tier must be 0, 1 or 2, got ${JSON.stringify(tierRaw)}`);
    }
    const tier = Number(tierRaw);
    if (wantsTier2 && tier !== 2)
        throw new Error('--scenario and --sdk-static need --tier 2');
    if (cli.sdkStatic && cli.scenario !== undefined)
        throw new Error('--sdk-static runs no scenarios; drop --scenario');
    if (tier === 2 && cli.delegate)
        throw new Error('--delegate is tier 1 only; at tier 2 use --scenario delegate');
    const maxCredits = parsePositiveInt(cli.maxCredits, '--max-credits');
    if (maxCredits !== undefined && maxCredits < MIN_MAX_CREDITS) {
        throw new Error(`--max-credits must be at least ${MIN_MAX_CREDITS} (Copilot CLI minimum), got ${maxCredits}`);
    }
    // Tier 2 without --scenario/--sdk-static leaves `scenarios` unset: the library default applies.
    const scenarios = cli.sdkStatic ? [] : cli.scenario !== undefined ? parseScenarios(cli.scenario) : undefined;
    const options = {
        tier,
        ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
        ...(cli.model ? { model: cli.model } : {}),
        ...(maxCredits !== undefined ? { maxCredits } : {}),
        ...(cli.timeout !== undefined ? { timeoutMs: parsePositiveInt(cli.timeout, '--timeout') } : {}),
        keepHome: cli.keepHome ?? false,
        delegate: cli.delegate ?? false,
        ...(scenarios !== undefined ? { scenarios } : {}),
        ...(cli.record !== undefined ? { record: expandHome(cli.record) } : {}),
        ...(cli.recordOverwrite ? { recordOverwrite: true } : {}),
        ...(cli.replay !== undefined ? { replay: expandHome(cli.replay) } : {}),
        ...(cli.replayStrict ? { replayStrict: true } : {}),
    };
    const refusal = cassetteOptionsError(options, env);
    if (refusal)
        throw new Error(refusal);
    return options;
}
/** A failed check that only says "could not run": missing binary, missing SDK peer, or a dependent skip. */
function isSkipFailure(check) {
    return check.id === 'copilot.binary' || check.detail === 'skipped' || check.detail === SDK_MISSING_DETAIL;
}
/**
 * 2 only for a pure skip: every failed check is the missing binary/SDK or a
 * dependent "skipped" check. A real failure alongside the skip is 1.
 */
export function smokeExitCode(report) {
    if (report.ok)
        return 0;
    if (!report.skipped)
        return 1;
    return report.checks.some((c) => !c.ok && !isSkipFailure(c)) ? 1 : 2;
}
/** A report for option errors and crashes, so --json output is always a SmokeReport. */
export function errorReport(cli, err, started) {
    const tier = cli.tier === '1' ? 1 : cli.tier === '2' || (cli.tier === undefined && (cli.sdkStatic || cli.scenario !== undefined)) ? 2 : 0;
    return {
        ok: false,
        tier,
        pluginRoot: cli.pluginRoot ? resolve(cli.pluginRoot) : '',
        pluginVersion: null,
        copilot: { bin: null, version: null },
        checks: [{ id: 'cli.error', ok: false, detail: err instanceof Error ? err.message : String(err) }],
        artifacts: {},
        durationMs: Date.now() - started,
    };
}
/** Output group for a check id at tier 2: `sdk` for SDK static checks, `scenario <name>` for `scn.<name>.*`. */
function checkGroup(id) {
    if (id.startsWith('sdk.'))
        return 'sdk (static, no model call)';
    const scn = /^scn\.([^.]+)\./.exec(id);
    return scn ? `scenario ${scn[1]}` : null;
}
export function formatSmokeReport(report) {
    const lines = [];
    lines.push(`omg smoke copilot — tier ${report.tier}, plugin ${report.pluginVersion ?? '?'} at ${report.pluginRoot}`);
    lines.push(`copilot: ${report.copilot.bin ?? 'not found'}${report.copilot.version ? ` (v${report.copilot.version})` : ''}`);
    if (report.sdk) {
        const { version, runtimeVersion, protocolVersion, model } = report.sdk;
        lines.push(`sdk: @github/copilot-sdk ${version ?? '?'} driving runtime ${runtimeVersion ?? '?'} (protocol ${protocolVersion ?? '?'}), model ${model}`);
    }
    let group = null;
    for (const check of report.checks) {
        const next = checkGroup(check.id);
        if (next !== group) {
            if (next)
                lines.push(colors.bold(`── ${next}`));
            group = next;
        }
        const mark = check.ok ? colors.green('✓') : colors.red('✗');
        lines.push(`${mark} ${check.id} — ${check.detail}`);
        if (!check.ok && check.evidence) {
            for (const line of check.evidence.split('\n'))
                lines.push(colors.gray(`    ${line}`));
        }
    }
    if (report.cost) {
        lines.push(`cost: ${Number(report.cost.credits.toFixed(3))} AI credit(s), legacy ${report.cost.premiumRequests} premium request(s)`);
    }
    for (const [key, value] of Object.entries(report.artifacts)) {
        if (!value)
            continue;
        if (typeof value === 'object') {
            for (const [name, path] of Object.entries(value))
                lines.push(colors.gray(`  ${key}.${name}: ${String(path)}`));
        }
        else {
            lines.push(colors.gray(`  ${key}: ${String(value)}`));
        }
    }
    const failed = report.checks.filter((c) => !c.ok).length;
    const summary = report.skipped
        ? colors.yellow(`SKIPPED: ${report.skipped}`)
        : report.ok
            ? colors.green(`PASS: ${report.checks.length} checks in ${report.durationMs} ms`)
            : colors.red(`FAIL: ${failed}/${report.checks.length} checks failed in ${report.durationMs} ms`);
    lines.push(summary);
    return lines.join('\n');
}
export async function smokeCopilotCommand(cli) {
    const started = Date.now();
    let report;
    try {
        report = await runCopilotSmoke(toSmokeOptions(cli));
    }
    catch (err) {
        if (cli.json) {
            console.log(JSON.stringify(errorReport(cli, err, started), null, 2));
        }
        else {
            console.error(err instanceof Error ? err.message : String(err));
        }
        return 1;
    }
    console.log(cli.json ? JSON.stringify(report, null, 2) : formatSmokeReport(report));
    const code = smokeExitCode(report);
    if (cli.record === undefined || code !== 0)
        return code;
    // Step 2 of the capture (design section 6): gate and replay what was just recorded, free.
    const recorded = (report.checks.filter((c) => c.ok && /^scn\.[^.]+\.record$/.test(c.id)).map((c) => c.id.split('.')[1]));
    const verify = await verifyCassettes(expandHome(cli.record), {
        scenarios: recorded,
        ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
        ...(cli.timeout !== undefined ? { timeoutMs: parsePositiveInt(cli.timeout, '--timeout') } : {}),
    });
    console.error(verify.lines.join('\n'));
    return verify.ok ? 0 : 1;
}
/**
 * `omg smoke cassette verify <dir>`: the redaction gate over every cassette
 * under `dir` (a failure writes REDACTION-FAILED into that cassette), then a
 * replay of this machine's cassettes that passed, credential-free; each
 * replayed cassette's manifest gets `selfVerify`.
 */
export async function verifyCassettes(root, opts = {}) {
    const lines = [];
    const gate = gateCassettes(root);
    if (gate.length === 0)
        return { ok: false, lines: [`no cassette (a dir with manifest.json) under ${root}`] };
    for (const g of gate)
        lines.push(`${g.ok ? colors.green('✓') : colors.red('✗')} gate ${g.dir}${g.ok ? '' : `\n${g.detail}`}`);
    const gateOk = gate.every((g) => g.ok);
    if (opts.gateOnly)
        return { ok: gateOk, lines };
    const mine = resolve(root, platformTag());
    const passed = new Map(gate.filter((g) => g.ok && resolve(g.dir, '..') === mine).map((g) => [g.dir.slice(mine.length + 1), g.dir]));
    const scenarios = [...passed.keys()].filter((s) => KNOWN_SCENARIOS.includes(s) && (!opts.scenarios || opts.scenarios.includes(s)));
    if (scenarios.length === 0) {
        lines.push(`no cassette for ${platformTag()} to replay under ${root}`);
        return { ok: gateOk, lines };
    }
    const report = await (opts.runSmoke ?? runCopilotSmoke)({
        tier: 2,
        scenarios,
        replay: root,
        ...(opts.pluginRoot ? { pluginRoot: opts.pluginRoot } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    lines.push(formatSmokeReport(report));
    for (const scenario of scenarios) {
        const result = report.replay?.[scenario];
        if (result)
            writeSelfVerify(passed.get(scenario), result);
    }
    return { ok: gateOk && report.ok, lines };
}
export async function smokeCassetteVerifyCommand(dir, cli) {
    try {
        const result = await verifyCassettes(expandHome(dir), {
            ...(cli.pluginRoot ? { pluginRoot: cli.pluginRoot } : {}),
            ...(cli.timeout !== undefined ? { timeoutMs: parsePositiveInt(cli.timeout, '--timeout') } : {}),
            ...(cli.gateOnly ? { gateOnly: true } : {}),
        });
        console.log(result.lines.join('\n'));
        return result.ok ? 0 : 1;
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
    }
}
/** Where `omg smoke cassette import` copies to by default: the repo's replay fixtures. */
export const CASSETTE_FIXTURES_DIR = join('src', 'smoke', '__tests__', 'fixtures', 'cassettes');
export function smokeCassetteImportCommand(dir, cli) {
    try {
        const result = importCassettes(expandHome(dir), expandHome(cli.to ?? CASSETTE_FIXTURES_DIR), !!cli.overwrite);
        for (const label of result.imported)
            console.log(`imported ${label} -> ${join(result.dest, label)}`);
        console.log('Review the diff before committing; nothing was committed.');
        return 0;
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
    }
}
//# sourceMappingURL=smoke.js.map