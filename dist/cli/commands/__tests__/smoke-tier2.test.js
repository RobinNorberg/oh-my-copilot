import { describe, it, expect } from 'vitest';
import { formatSmokeReport, parseScenarios, smokeExitCode, toSmokeOptions } from '../smoke.js';
import { SDK_MISSING_DETAIL as SDK_HINT } from '../../../smoke/copilot-sdk-scenarios.js';
function report(partial) {
    return {
        ok: false, tier: 2, pluginRoot: '/r', pluginVersion: '5.6.2', copilot: { bin: '/c', version: '1.0.91' },
        checks: [], artifacts: {}, durationMs: 5, ...partial,
    };
}
describe('omg smoke copilot — tier 2 options', () => {
    it('maps --tier 2, --scenario and --sdk-static', () => {
        expect(toSmokeOptions({ tier: '2' })).toEqual({ tier: 2, keepHome: false, delegate: false });
        expect(toSmokeOptions({ sdkStatic: true })).toEqual({ tier: 2, keepHome: false, delegate: false, scenarios: [] });
        expect(toSmokeOptions({ tier: '2', scenario: 'guardrail, smoke' }))
            .toMatchObject({ tier: 2, scenarios: ['guardrail', 'smoke'] });
        expect(toSmokeOptions({ scenario: 'all', maxCredits: '60' }))
            .toMatchObject({ tier: 2, maxCredits: 60, scenarios: ['smoke', 'guardrail', 'skill', 'delegate'] });
    });
    it('rejects inconsistent tier 2 flags', () => {
        expect(() => toSmokeOptions({ tier: '3' })).toThrow(/--tier must be 0, 1 or 2/);
        expect(() => toSmokeOptions({ tier: '1', scenario: 'smoke' })).toThrow(/need --tier 2/);
        expect(() => toSmokeOptions({ tier: '0', sdkStatic: true })).toThrow(/need --tier 2/);
        expect(() => toSmokeOptions({ sdkStatic: true, scenario: 'smoke' })).toThrow(/drop --scenario/);
        expect(() => toSmokeOptions({ tier: '2', delegate: true })).toThrow(/--scenario delegate/);
    });
    it('parses scenario lists: all, dedupe, unknown, empty', () => {
        expect(parseScenarios('skill,all,skill')).toEqual(['skill', 'smoke', 'guardrail', 'delegate']);
        expect(() => parseScenarios('smoke,nope')).toThrow(/unknown scenario "nope"/);
        expect(() => parseScenarios(' , ')).toThrow(/at least one/);
    });
});
describe('omg smoke copilot — tier 2 exit codes and output', () => {
    it('exits 2 when only the SDK peer is missing, 1 when a real check also failed', () => {
        const skipped = report({
            skipped: SDK_HINT,
            checks: [
                { id: 'plugin.manifest', ok: true, detail: 'ok' },
                { id: 'sdk.available', ok: false, detail: SDK_HINT },
                { id: 'sdk.plugins', ok: false, detail: SDK_HINT },
                { id: 'scn.smoke.reply', ok: false, detail: 'skipped' },
            ],
        });
        expect(smokeExitCode(skipped)).toBe(2);
        expect(smokeExitCode({ ...skipped, checks: [...skipped.checks, { id: 'plugin.hooks', ok: false, detail: 'drift' }] })).toBe(1);
    });
    it('groups sdk.* and scn.<name>.* checks and prints sdk, cost and event artifacts', () => {
        const text = formatSmokeReport(report({
            ok: true,
            sdk: { version: '1.0.16', runtimeVersion: '1.0.91', protocolVersion: 3, model: 'auto' },
            cost: { premiumRequests: 3, credits: 0.7 },
            checks: [
                { id: 'plugin.manifest', ok: true, detail: 'ok' },
                { id: 'sdk.available', ok: true, detail: '1.0.16' },
                { id: 'sdk.mcp', ok: true, detail: 't connected' },
                { id: 'scn.smoke.reply', ok: true, detail: 'SMOKE_OK' },
                { id: 'scn.guardrail.denied', ok: true, detail: 'Git guardrail' },
            ],
            artifacts: { events: { smoke: '/h/smoke.jsonl', guardrail: '/h/guardrail.jsonl' } },
        }));
        const lines = text.split('\n');
        const idx = (needle) => lines.findIndex((l) => l.includes(needle));
        expect(text).toContain('sdk: @github/copilot-sdk 1.0.16 driving runtime 1.0.91 (protocol 3), model auto');
        expect(idx('── sdk')).toBeLessThan(idx('sdk.available'));
        expect(idx('── sdk')).toBeGreaterThan(idx('plugin.manifest'));
        expect(idx('── scenario smoke')).toBe(idx('scn.smoke.reply') - 1);
        expect(idx('── scenario guardrail')).toBe(idx('scn.guardrail.denied') - 1);
        expect(text).toContain('cost: 3 premium request(s), 0.7 credit(s)');
        expect(text).toContain('events.smoke: /h/smoke.jsonl');
        expect(text).not.toContain('[object Object]');
    });
});
//# sourceMappingURL=smoke-tier2.test.js.map