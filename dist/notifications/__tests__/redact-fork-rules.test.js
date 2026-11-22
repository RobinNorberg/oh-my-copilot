/**
 * Fork: every rule of the fork's hardened default chain (src/notifications/redact.ts TOKEN_RULES) still masks
 * its secret after upstream moved the rules into TOKEN_RULES and added the opt-in key-shape scan
 * (OMC_REDACT_KEY_SHAPES=1, upstream #5073). Without the switch the output is byte-identical to the chain before
 * the port; with it nothing leaks either.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { redactTokens } from '../redact.js';
// [rule, input, secret, output without the switch (the pre-port chain)]
const RULES = [
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEAcanary\n-----END RSA PRIVATE KEY-----', 'MIIEpQIBAAKCAQEAcanary', '-----BEGIN RSA PRIVATE KEY-----****'],
    ['Slack xox*', 'slack xoxb-1234-canary5678 done', 'canary5678', 'slack xoxb-**** done'],
    ['Slack xapp', 'app xapp-1-canary-99 done', 'canary-99', 'app xapp-**** done'],
    ['Telegram URL', 'GET /bot123456:canaryABCdef/sendMessage', 'canaryABCdef', 'GET /bot123456:****/sendMessage'],
    ['Telegram standalone', 'token 123456789:canaryAAAAAAAAAAAAAAAAAAAA end', 'canaryAAAAAAAAAAAAAAAAAAAA', 'token 123456789:**** end'],
    ['Bearer', 'auth Bearer canaryvalue123 end', 'canaryvalue123', 'auth Bearer **** end'],
    ['Bot', 'auth Bot canaryvalue456 end', 'canaryvalue456', 'auth Bot **** end'],
    ['Anthropic', 'key sk-ant-api03-canary_xyz end', '03-canary_xyz', 'key sk-ant-api**** end'],
    ['OpenAI-style', 'key sk-proj-canary12345678 end', 'canary12345678', 'key sk-proj-**** end'],
    ['GitHub ghp_', 'gh ghp_canary1234567890 end', 'canary1234567890', 'gh ghp_**** end'],
    ['GitHub gho_', 'gh gho_canary1234567890 end', 'canary1234567890', 'gh gho_**** end'],
    ['GitHub ghs_', 'gh ghs_canary1234567890 end', 'canary1234567890', 'gh ghs_**** end'],
    ['GitHub ghu_/ghr_', 'gh ghu_canary123 ghr_canary456 end', 'canary', 'gh ghu_**** ghr_**** end'],
    ['GitHub github_pat_', 'gh github_pat_11AB_canary end', '11AB_canary', 'gh github_pat_**** end'],
    ['AWS access key id', 'aws AKIACANARY1234567890 end', 'CANARY1234567890', 'aws AKIA**** end'],
    ['secret-named JSON field', '{"password":"canary-json","user":"u"}', 'canary-json', '{"password":"****","user":"u"}'],
    ['escaped JSON field', '{\\"token\\":\\"canary-esc\\"}', 'canary-esc', '{\\"token\\":\\"****\\"}'],
    ['credential header', 'X-Api-Key: canary-header', 'canary-header', 'X-Api-Key: ****'],
    ['Authorization Basic', 'Authorization: Basic Y2FuYXJ5OnB3', 'Y2FuYXJ5OnB3', 'Authorization: Basic ****'],
    ['secret-named assignment', 'export GITHUB_TOKEN="canary-assign"', 'canary-assign', 'export GITHUB_TOKEN=****'],
    ['secret-named flag', 'tool --api-key canary-flag --next', 'canary-flag', 'tool --api-key **** --next'],
    ['URL credentials', 'clone https://user:canary-url@example.com/repo', 'canary-url', 'clone https://****@example.com/repo'],
    ['curl -u', 'curl -u admin:canary-curl https://example.com', 'canary-curl', 'curl -u admin:**** https://example.com'],
    ['mysql -p', 'mysql -h db -pcanary-mysql mydb', 'canary-mysql', 'mysql -h db -p**** mydb'],
    ['login -p', 'docker login registry.example.com -u me -p canary-login', 'canary-login', 'docker login registry.example.com -u me -p ****'],
    ['Slack webhook', 'post https://hooks.slack.com/services/T000/B000/canaryhook', 'canaryhook', 'post https://hooks.slack.com/services/****'],
    ['Discord webhook', 'post https://discord.com/api/webhooks/123456/canary-discord', 'canary-discord', 'post https://discord.com/api/webhooks/123456/****'],
    ['padded base64', 'blob c2VjcmV0Y2FuYXJ5cGFzcw== end', 'c2VjcmV0Y2FuYXJ5cGFzcw==', 'blob **** end'],
];
const original = process.env.OMC_REDACT_KEY_SHAPES;
afterEach(() => {
    if (original === undefined)
        delete process.env.OMC_REDACT_KEY_SHAPES;
    else
        process.env.OMC_REDACT_KEY_SHAPES = original;
});
describe('fork default redaction rules survive the TOKEN_RULES port', () => {
    it.each(RULES)('%s: switch off gives the pre-port output', (_rule, input, secret, expected) => {
        delete process.env.OMC_REDACT_KEY_SHAPES;
        const out = redactTokens(input);
        expect(out).toBe(expected);
        expect(out.includes(secret)).toBe(false);
    });
    it.each(RULES)('%s: switch on masks it too', (_rule, input, secret) => {
        process.env.OMC_REDACT_KEY_SHAPES = '1';
        const out = redactTokens(input);
        expect(out.includes(secret)).toBe(false);
        expect(out).not.toBe(input);
    });
    it('switch on: a quoted secret-named value keeps its quotes, as the key-shape scan writes it', () => {
        process.env.OMC_REDACT_KEY_SHAPES = '1';
        expect(redactTokens('export GITHUB_TOKEN="canary-assign"')).toBe('export GITHUB_TOKEN="****"');
    });
    it('a **** already in the text is not taken for the mask of a later match', () => {
        process.env.OMC_REDACT_KEY_SHAPES = '1';
        expect(redactTokens('robot ****)github_pat_x')).toBe('robot ****');
    });
    it('the URL credential rule stays linear on long runs of scheme characters', () => {
        delete process.env.OMC_REDACT_KEY_SHAPES;
        const input = 'a-'.repeat(60000);
        redactTokens(input);
        const start = performance.now();
        expect(redactTokens(input)).toBe(input);
        expect(performance.now() - start).toBeLessThan(500);
    });
    it('the URL credential rule keeps its output on plain and prefixed schemes', () => {
        delete process.env.OMC_REDACT_KEY_SHAPES;
        expect(redactTokens('https://user:pass@host')).toBe('https://****@host');
        expect(redactTokens('foo-https://u:p@h')).toBe('foo-https://****@h');
    });
    it('the URL credential rule masks a scheme longer than 256 characters', () => {
        delete process.env.OMC_REDACT_KEY_SHAPES;
        const out = redactTokens('q'.repeat(300) + 'https://user:pass@host');
        expect(out).toBe('q'.repeat(300) + 'https://****@host');
        expect(out).not.toContain('pass');
    });
    it.each([
        ['login -p', 'login '.repeat(20000) + ' -p'],
        ['mysql -p', 'mysql '.repeat(20000) + ' -p'],
    ])('the %s rule stays fast on a long run of the command word', (_rule, input) => {
        delete process.env.OMC_REDACT_KEY_SHAPES;
        redactTokens(input);
        const start = performance.now();
        redactTokens(input);
        expect(performance.now() - start).toBeLessThan(500);
    });
});
//# sourceMappingURL=redact-fork-rules.test.js.map