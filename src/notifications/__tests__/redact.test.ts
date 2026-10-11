import { describe, it, expect } from 'vitest';
import { redactTokens } from '../redact.js';

describe('redactTokens', () => {
  // ── Slack tokens ──────────────────────────────────────────────────────

  it('redacts Slack bot tokens (xoxb-)', () => {
    const input = 'token is xoxb-123456789012-abcDEF here';
    const result = redactTokens(input);
    expect(result).not.toContain('123456789012-abcDEF');
    expect(result).toContain('xoxb-****');
  });

  it('redacts xoxb- tokens behind Bearer prefix', () => {
    const input = 'Authorization: Bearer xoxb-123456789012-abcDEF';
    const result = redactTokens(input);
    expect(result).not.toContain('123456789012-abcDEF');
    expect(result).toContain('Bearer ****');
  });

  it('redacts Slack app tokens (xapp-)', () => {
    const input = 'Token: xapp-1-A0B1C2D3E4F5-1234567890-abcdef0123456789';
    const result = redactTokens(input);
    expect(result).not.toContain('A0B1C2D3E4F5');
    expect(result).toContain('xapp-****');
  });

  it('redacts Slack user tokens (xoxp-)', () => {
    const input = 'xoxp-fake-test-value';
    const result = redactTokens(input);
    expect(result).not.toContain('fake-test-value');
    expect(result).toContain('xoxp-****');
  });

  it('redacts xoxa- tokens', () => {
    const input = 'token=xoxa-2-abc123def456';
    const result = redactTokens(input);
    expect(result).not.toContain('abc123def456');
    expect(result).toContain('xoxa-****');
  });

  // ── Telegram tokens ───────────────────────────────────────────────────

  it('redacts Telegram bot tokens in URL paths', () => {
    const input = 'GET /bot1234567890:AAHfoo-bar_BazQux123456789/getUpdates';
    const result = redactTokens(input);
    expect(result).not.toContain('AAHfoo-bar_BazQux123456789');
    expect(result).toContain('/bot1234567890:****');
    expect(result).toContain('/getUpdates');
  });

  it('redacts standalone Telegram bot tokens', () => {
    const input = 'Token is 1234567890:AAHdKq3lx_abcdefghij12345678901';
    const result = redactTokens(input);
    expect(result).not.toContain('AAHdKq3lx_abcdefghij12345678901');
    expect(result).toContain('1234567890:****');
  });

  // ── Bearer / Bot auth values ──────────────────────────────────────────

  it('redacts Bearer token values', () => {
    const input = 'Error: request failed with Bearer xoxb-secret-token-value';
    const result = redactTokens(input);
    expect(result).not.toContain('secret-token-value');
    expect(result).toContain('Bearer ****');
  });

  it('redacts Bot token values', () => {
    const input = 'Authorization: Bot MTIzNDU2Nzg5MDEy.abc.xyz123';
    const result = redactTokens(input);
    expect(result).not.toContain('MTIzNDU2Nzg5MDEy');
    expect(result).toContain('Bot ****');
  });

  it('is case-insensitive for Bearer/Bot', () => {
    const input = 'BEARER some-secret and bearer another-secret';
    const result = redactTokens(input);
    expect(result).not.toContain('some-secret');
    expect(result).not.toContain('another-secret');
  });

  // ── Safe strings (no false positives) ─────────────────────────────────

  it('does not modify strings without tokens', () => {
    const input = 'Slack Socket Mode connected';
    expect(redactTokens(input)).toBe(input);
  });

  it('does not modify normal error messages', () => {
    const input = 'HTTP 401 Unauthorized';
    expect(redactTokens(input)).toBe(input);
  });

  it('does not modify short numeric sequences', () => {
    const input = 'PID 12345 started';
    expect(redactTokens(input)).toBe(input);
  });

  it('preserves non-token parts of the message', () => {
    const input = 'Slack Socket Mode connection error: fetch failed for Bearer xoxb-secret-123';
    const result = redactTokens(input);
    expect(result).toContain('Slack Socket Mode connection error:');
    expect(result).toContain('fetch failed for');
    expect(result).not.toContain('secret-123');
  });

  // ── Multiple tokens in one string ─────────────────────────────────────

  it('redacts multiple different tokens in one string', () => {
    const input = 'appToken=xapp-1-AAA-BBB botToken=xoxb-123-secret channelId=C12345';
    const result = redactTokens(input);
    expect(result).not.toContain('AAA-BBB');
    expect(result).not.toContain('123-secret');
    expect(result).toContain('xapp-****');
    expect(result).toContain('xoxb-****');
    expect(result).toContain('channelId=C12345');
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles empty string', () => {
    expect(redactTokens('')).toBe('');
  });

  it('handles string with only whitespace', () => {
    expect(redactTokens('   ')).toBe('   ');
  });

  it('redacts tokens in error stack-like strings', () => {
    const input = 'Error: apps.connections.open failed\n  at fetch (Bearer xoxb-my-secret-token)';
    const result = redactTokens(input);
    expect(result).not.toContain('my-secret-token');
  });

  // ── Command lines (Copilot permission prompts) ────────────────────────

  it.each([
    ['curl -H "Authorization: Bearer abc.def-ghi" https://api.example.com', 'abc.def-ghi'],
    ['git clone https://ghp_A1b2C3d4E5f6G7h8I9j0@github.com/o/r', 'A1b2C3d4E5f6G7h8I9j0'],
    ['gh api -H "token github_pat_11ABC_def456" /user', '11ABC_def456'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls', 'wJalrXUtnFEMI'],
    ['aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['GITHUB_TOKEN="s3cr3t value" npm publish', 's3cr3t'],
    ['$env:OPENAI_API_KEY = \'sk-live-123\'; node app.js', 'sk-live-123'],
    ['mysql --password=hunter2 -u root', 'hunter2'],
    ['tool --api-key hunter3 --verbose', 'hunter3'],
    ['psql postgres://admin:pa55word@db.local/app', 'pa55word'],
  ])('redacts the secret in %s', (input, secret) => {
    const result = redactTokens(input);
    expect(result).not.toContain(secret);
    expect(result).toContain('****');
  });

  it('keeps the command and non-secret arguments readable', () => {
    expect(redactTokens('AWS_SECRET_ACCESS_KEY=abc aws s3 ls --region eu-north-1'))
      .toBe('AWS_SECRET_ACCESS_KEY=**** aws s3 ls --region eu-north-1');
    expect(redactTokens('mysql --password=hunter2 -u root')).toBe('mysql --password=**** -u root');
    expect(redactTokens('tool --api-key hunter3 --verbose')).toBe('tool --api-key **** --verbose');
    expect(redactTokens('ping -n 3 127.0.0.1')).toBe('ping -n 3 127.0.0.1');
  });

  // Adversarial corpus (PR #237 review): command lines and text that leaked
  // through the first command-line patterns. [input, secret]
  it.each([
    ['curl -d \'{"password":"hunter2","user":"a"}\' https://x', 'hunter2'],
    ['curl -d \'{"api_key": "sk-abc123"}\' https://x', 'sk-abc123'],
    ['curl -d "{\\"token\\":\\"tok999\\"}" https://x', 'tok999'],
    ['echo hi &&\nexport GITHUB_TOKEN=multi1\nnpm publish', 'multi1'],
    ['echo c2VjcmV0cGFzc3dvcmQ= | base64 -d > ~/.netrc', 'c2VjcmV0cGFzc3dvcmQ='],
    ['GITHUB_TOKEN="value with spaces" npm publish', 'with spaces'],
    ["PASSWORD='quoted spaced pw' ./run", 'spaced pw'],
    ['$env:GH_TOKEN="ghtok"; gh pr list', 'ghtok'],
    ['set DB_PASSWORD=winpw && run', 'winpw'],
    ['mysql -u root -pHunter22 db', 'Hunter22'],
    ['mysql --password hunter4 -u root', 'hunter4'],
    ['tool --api-key=-dashleading', 'dashleading'],
    ['tool --token -dashval', 'dashval'],
    ['tool --client-secret s3', 's3'],
    ['tool --auth abcsecret', 'abcsecret'],
    ['curl -u admin:pa55 https://x', 'pa55'],
    ['curl -H "X-API-Key: keyval123" https://x', 'keyval123'],
    ['curl -H "Authorization: Basic YWRtaW46cGFzcw==" https://x', 'YWRtaW46cGFzcw'],
    ['curl -H "Authorization: token ghp_abcdef123456" https://x', 'abcdef123456'],
    ['git clone https://user:p%40ss@github.com/o/r', 'p%40ss'],
    ['psql "postgresql://admin:pa:ss@db/app"', 'pa:ss'],
    ['redis-cli -u redis://:onlypass@host:6379', 'onlypass'],
    ['export SLACK_WEBHOOK=https://hooks.slack.com/services/T000/B000/XXXXSECRET', 'XXXXSECRET'],
    ['curl -X POST https://hooks.slack.com/services/T000/B000/XXXXSECRET', 'XXXXSECRET'],
    ['curl https://discord.com/api/webhooks/123456/abcWebhookToken', 'abcWebhookToken'],
    ['npm config set //registry.npmjs.org/:_authToken=npmtok123', 'npmtok123'],
    ['az login --service-principal -u id -p azpw123 --tenant t', 'azpw123'],
    ['docker login -p dockpw -u me', 'dockpw'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 used', 'abcdefghijklmnop'],
    ['OPENAI_KEY=sk-proj-abcdef0123456789 node', 'abcdef0123456789'],
    ['key is sk-abcdef0123456789xyz', 'abcdef0123456789xyz'],
    ['xoxb-1234-5678-abcdefSECRET in cmd', 'abcdefSECRET'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretkeymaterial\n-----END', 'MIIEowIBAAKCAQEAsecretkeymaterial'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY----- done', 'MIIEvQ'],
  ])('redacts adversarial input %j', (input, secret) => {
    const result = redactTokens(input);
    expect(result).not.toContain(secret);
    expect(result).toContain('****');
  });

  it.each([
    'mkdir -p build && ssh -p 22 host',
    'git log --author bob --oneline',
    'npm run build -- --watch',
    'git checkout 3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c',
    'Authorization failed for user',
    'curl -u https://example.com',
  ])('leaves ordinary text alone: %s', (input) => {
    expect(redactTokens(input)).toBe(input);
  });
});
