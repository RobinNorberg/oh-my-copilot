import { describe, expect, it } from 'vitest';

import {
  buildDenySet,
  EMAIL_PLACEHOLDER,
  filterRequestHeaders,
  filterResponseHeaders,
  Redactor,
  restorePlaceholders,
  scanForSecrets,
  SECRET_PLACEHOLDER,
  substitutePaths,
} from '../redact.js';

// Token-shaped values are assembled at runtime so no literal token sits in the repo (push protection, scanners).
const GHP = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const GITHUB_PAT = `github_pat_${'11AAbb22CC'.repeat(5)}`;
const JWT = `eyJ${'hbGciOiJIUzI1'}.${'eyJzdWIiOiIx'}.${'c2lnbmF0dXJl'}`;
const AWS = `AKIA${'ABCDEFGHIJ234567'}`;
const CAPI = `tid=${'abc123'};exp=${'1761234567'};sku=free;proxy-ep=proxy.example`;
const PEM = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${'x'.repeat(20)}\n-----END RSA PRIVATE KEY-----`;

describe('header allowlists', () => {
  it('keeps only allowlisted request headers, authorization first to go', () => {
    expect(filterRequestHeaders({
      Authorization: 'Bearer x', 'Content-Type': 'application/json', 'X-Initiator': 'agent', 'X-Request-Id': 'r1',
      'Openai-Intent': 'conversation-agent', Cookie: 'a=b',
    })).toEqual({ 'content-type': 'application/json', 'x-initiator': 'agent', 'openai-intent': 'conversation-agent' });
  });
  it('keeps content-type and x-ratelimit-* response headers only', () => {
    expect(filterResponseHeaders({
      'Content-Type': 'text/event-stream', 'X-RateLimit-Remaining': '9', 'Set-Cookie': 's=1', 'x-github-request-id': 'id',
    })).toEqual({ 'content-type': 'text/event-stream', 'x-ratelimit-remaining': '9' });
  });
});

describe('buildDenySet', () => {
  it('takes credential env values of 8+ chars, bearer parts and stdin credentials', () => {
    const set = buildDenySet({
      env: { GH_TOKEN: 'gho_envtoken123', COPILOT_GITHUB_TOKEN: 'short', PATH: '/usr/bin:/bin:/usr/local/bin' },
      authorizations: ['Bearer capi-session-abcdef'],
      credentials: ['host-cred-12345678'],
    });
    expect(set).toEqual(new Set(['gho_envtoken123', 'Bearer capi-session-abcdef', 'capi-session-abcdef', 'host-cred-12345678']));
  });
});

describe('Redactor rule 3: deny-set literals', () => {
  const secret = 'S3cr3t"V@lue\\with-escapes';
  const redactor = new Redactor({ denyLiterals: [secret] });

  it('replaces the plain literal', () => {
    expect(redactor.redact(`token is ${secret}.`)).toBe(`token is ${SECRET_PLACEHOLDER}.`);
  });
  it('replaces the JSON-escaped and double-escaped spellings', () => {
    const once = JSON.stringify({ t: secret });
    const twice = JSON.stringify({ args: once });
    expect(redactor.redact(once)).toBe(`{"t":"${SECRET_PLACEHOLDER}"}`);
    expect(redactor.redact(twice)).not.toContain('S3cr3t');
    expect(scanForSecrets(redactor.redact(twice), { denyLiterals: [secret] })).toEqual([]);
  });
  it('counts hits', () => {
    expect(redactor.hits.secret).toBeGreaterThan(0);
  });
});

describe('Redactor rule 4: token patterns', () => {
  const cases: Array<[string, string]> = [
    ['github-token', GHP],
    ['github-token', GHP.replace('ghp_', 'ghs_')],
    ['github-pat', GITHUB_PAT],
    ['capi-token', CAPI],
    ['jwt', JWT],
    ['bearer', 'Bearer abc.def-123'],
    ['aws-key', AWS],
    ['private-key', PEM],
  ];
  it.each(cases)('%s', (rule, value) => {
    const redactor = new Redactor();
    const out = redactor.redact(`before ${value} after`);
    expect(out).toBe(`before <redacted:${rule}> after`);
    expect(redactor.hits[rule]).toBe(1);
    expect(scanForSecrets(out)).toEqual([]);
  });
  it('redacts tokens inside JSON-escaped text', () => {
    const text = JSON.stringify(JSON.stringify({ env: `GH_TOKEN=${GHP}`, auth: 'Bearer zzzzzzzzzz' }));
    const out = new Redactor().redact(text);
    expect(out).not.toContain(GHP);
    expect(out).not.toContain('zzzzzzzzzz');
    expect(scanForSecrets(out)).toEqual([]);
  });
  it('generic secret assignments keep JSON valid, plain and escaped', () => {
    const redactor = new Redactor();
    const plain = redactor.redact('{"password": "hunter2hunter2", "api_key":"k-123456789"}');
    expect(JSON.parse(plain)).toEqual({ password: '<redacted:generic>', api_key: '<redacted:generic>' });
    const escaped = redactor.redact(JSON.stringify(JSON.stringify({ secret: 'abcdefghijkl' })));
    expect(JSON.parse(JSON.parse(escaped))).toEqual({ secret: '<redacted:generic>' });
    expect(redactor.redact("secret='abcdefghij'")).toBe("secret='<redacted:generic>'");
  });
  it.each([
    ['env file', 'SECRET=topsecretvalue1\nDB_PASSWORD=hunter2hunter2', 'SECRET=<redacted:generic>\nDB_PASSWORD=<redacted:generic>'],
    ['CLI flag =', 'login --password=hunter2hunter2 --user x', 'login --password=<redacted:generic> --user x'],
    ['CLI flag space', 'gh auth --with-token abcdefgh1234 && omg --api-key k-12345678', 'gh auth --with-token <redacted:generic> && omg --api-key <redacted:generic>'],
    ['YAML', 'db:\n  password: hunter2hunter2\n  client_secret: s3cr3t-value-x', 'db:\n  password: <redacted:generic>\n  client_secret: <redacted:generic>'],
  ])('unquoted assignments: %s', (_label, text, expected) => {
    expect(new Redactor().redact(text)).toBe(expected);
    expect(scanForSecrets(text).length).toBeGreaterThan(0);
    expect(scanForSecrets(expected)).toEqual([]);
  });
  it.each([
    'password: "short", the secret of a good test is no secret at all',
    'Enter your password: requirements are listed below. The token: authorization happens later.',
    'set password=$DB_PASS or token=${TOKEN}; see --token-file /etc/x and --password-stdin',
    'Basic instructions apply; a basic understanding of tokens helps.',
  ])('leaves ordinary text alone: %s', (text) => {
    expect(new Redactor().redact(text)).toBe(text);
    expect(scanForSecrets(text)).toEqual([]);
  });
  it('Basic and Bearer credentials anywhere in text', () => {
    const basic = Buffer.from('x-access-token:ghs_xxxxxxxx').toString('base64');
    const text = `git -c http.extraheader="AUTHORIZATION: basic ${basic}" fetch; curl -H 'Authorization: Basic ${basic}' -H "Authorization: Bearer tok_123456789"`;
    const out = new Redactor().redact(text);
    expect(out).not.toContain(basic);
    expect(out).not.toContain('tok_123456789');
    expect(out).toContain('basic <redacted:basic-auth>');
    expect(scanForSecrets(text).map((h) => h.rule)).toEqual(expect.arrayContaining(['basic-auth', 'bearer']));
    expect(scanForSecrets(out)).toEqual([]);
  });
});

describe('Redactor rule 5: identity', () => {
  it('replaces emails outside reserved domains', () => {
    const redactor = new Redactor();
    expect(redactor.redact('by robin@platypus.se and omg-smoke@example.invalid via git@github.com:o/r'))
      .toBe(`by ${EMAIL_PLACEHOLDER} and omg-smoke@example.invalid via git@github.com:o/r`);
    expect(redactor.hits.email).toBe(1);
  });
  it('replaces user, host and login as whole words, any case', () => {
    const redactor = new Redactor({ identity: { user: 'norbe', host: 'DESKTOP-ABC1', login: 'RobinNorberg' } });
    expect(redactor.redact('norbe on desktop-abc1 as robinnorberg; norberg stays; xnorbe stays'))
      .toBe('<user> on <host> as <login>; norberg stays; xnorbe stays');
  });
  it('ignores identity strings shorter than 3 characters', () => {
    expect(new Redactor({ identity: { user: 'ab' } }).redact('ab cd')).toBe('ab cd');
  });
});

describe('Redactor rule 6: path placeholders', () => {
  const win = {
    PROJECT: 'C:\\Users\\norbe\\AppData\\Local\\Temp\\omg-smoke-x\\project',
    HOME: 'C:\\Users\\norbe\\AppData\\Local\\Temp\\omg-smoke-x\\home',
    TMP: 'C:\\Users\\norbe\\AppData\\Local\\Temp\\omg-smoke-x',
    USERHOME: 'C:\\Users\\norbe',
  };
  const posix = { PROJECT: '/tmp/omg-smoke-x/project', TMP: '/tmp/omg-smoke-x', USERHOME: '/home/runner' };

  it('Windows dirs in plain, forward-slash, JSON-escaped and double-escaped spellings, longest first', () => {
    const r = new Redactor({ dirs: win });
    expect(r.redact('C:\\Users\\norbe\\AppData\\Local\\Temp\\omg-smoke-x\\project\\src\\a.ts')).toBe('${PROJECT}/src/a.ts');
    expect(r.redact('c:/users/NORBE/appdata/local/temp/omg-smoke-x/project/src/a.ts')).toBe('${PROJECT}/src/a.ts');
    expect(r.redact(JSON.stringify({ path: `${win.PROJECT}\\src\\a.ts`, home: win.HOME, other: `${win.TMP}\\log.txt` })))
      .toBe('{"path":"${PROJECT}/src/a.ts","home":"${HOME}","other":"${TMP}/log.txt"}');
    const twice = JSON.stringify({ arguments: JSON.stringify({ path: `${win.PROJECT}\\b.ts` }) });
    expect(r.redact(twice)).toBe(JSON.stringify({ arguments: JSON.stringify({ path: '${PROJECT}/b.ts' }) }));
    expect(r.redact(`${win.USERHOME}\\.gitconfig`)).toBe('${USERHOME}/.gitconfig');
    expect(r.hits['path.PROJECT']).toBe(4);
  });
  it('does not take an escaped newline after a path for a separator', () => {
    const r = new Redactor({ dirs: win });
    const text = JSON.stringify(`${win.PROJECT}\\x.ts\nnext line`);
    expect(r.redact(text)).toBe('"${PROJECT}/x.ts\\nnext line"');
  });
  it('POSIX dirs end at a segment boundary', () => {
    const r = new Redactor({ dirs: posix });
    expect(r.redact('/tmp/omg-smoke-x/project/a and /tmp/omg-smoke-x/project2/b and /tmp/omg-smoke-x'))
      .toBe('${PROJECT}/a and ${TMP}/project2/b and ${TMP}');
  });
  it('any other user-home path becomes ${USERHOME}', () => {
    const r = new Redactor();
    expect(r.redact('C:\\Users\\someone\\x\\y.txt /home/bob/.ssh/id /Users/alice/Library'))
      .toBe('${USERHOME}/x/y.txt ${USERHOME}/.ssh/id ${USERHOME}/Library');
    expect(r.redact(JSON.stringify('C:\\Users\\someone\\a\nb'))).toBe('"${USERHOME}/a\\nb"');
  });
  it('round-trips placeholders to the replay machine dirs', () => {
    const recorded = new Redactor({ dirs: win }).redact(`cd ${win.PROJECT}\\src && type ${win.HOME}\\config.json`);
    expect(recorded).toBe('cd ${PROJECT}/src && type ${HOME}/config.json');
    const replay = { PROJECT: '/tmp/r/project', HOME: '/tmp/r/home' };
    expect(restorePlaceholders(recorded, replay)).toBe('cd /tmp/r/project/src && type /tmp/r/home/config.json');
    // And the replay side digests the same text after substituting its own dirs.
    expect(substitutePaths(restorePlaceholders(recorded, replay), replay)).toBe(recorded);
  });
  it('restores Windows dirs natively with JSON escaping at the requested depth', () => {
    const dirs = { PROJECT: 'D:\\r\\project' };
    expect(restorePlaceholders('${PROJECT}/a.ts', dirs)).toBe('D:/r/project/a.ts');
    expect(restorePlaceholders('${PROJECT}/a.ts', dirs, { separator: 'native' })).toBe('D:\\r\\project\\a.ts');
    const body = JSON.stringify({ arguments: JSON.stringify({ path: '${PROJECT}/a.ts' }) });
    const restored = restorePlaceholders(body, dirs, { separator: 'native', jsonDepth: 2 });
    expect(JSON.parse(JSON.parse(restored).arguments)).toEqual({ path: 'D:\\r\\project\\a.ts' });
    expect(restorePlaceholders('${ROOT}/x', dirs)).toBe('${ROOT}/x'); // unknown dir: left as is
  });
});

describe('scanForSecrets (the gate)', () => {
  it('finds a planted ghp_ token and masks it', () => {
    const hits = scanForSecrets(`{"out":"export GH_TOKEN=${GHP}"}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: 'github-token', masked: 'ghp_****' });
    expect(JSON.stringify(hits)).not.toContain(GHP.slice(4));
  });
  it('finds a deny-set literal in any escaping, fully masked', () => {
    const literal = 'plain-looking-credential';
    const text = JSON.stringify({ a: literal, b: JSON.stringify({ c: literal }) });
    const hits = scanForSecrets(text, { denyLiterals: [literal] });
    expect(hits.map((h) => h.rule)).toEqual(['secret', 'secret']);
    expect(hits.every((h) => h.masked === '****')).toBe(true);
  });
  it('finds emails, identity and user-home paths', () => {
    const rules = scanForSecrets('robin@platypus.se norbe C:\\Users\\norbe\\x /home/runner/w', { identity: { user: 'norbe' } })
      .map((h) => h.rule);
    expect(rules).toEqual(expect.arrayContaining(['email', 'user', 'path.USERHOME']));
  });
  it('passes redacted output and placeholders', () => {
    const r = new Redactor({ denyLiterals: ['deny-literal-1'], identity: { user: 'norbe' }, dirs: { USERHOME: 'C:\\Users\\norbe' } });
    const out = r.redact(`deny-literal-1 ${GHP} Bearer x.y.z robin@platypus.se C:\\Users\\norbe\\a "password":"abcdefghi" norbe`);
    expect(scanForSecrets(out, { denyLiterals: ['deny-literal-1'], identity: { user: 'norbe' } })).toEqual([]);
  });
});

describe('review fixes (#349)', () => {
  it('COPILOT_HMAC_KEY and *_KEY env values join the deny set', () => {
    const set = buildDenySet({ env: { COPILOT_HMAC_KEY: 'realhmackeyvalue123', SOME_SIGNING_KEY: 'signingkey-0987654' } });
    expect(set).toEqual(new Set(['realhmackeyvalue123', 'signingkey-0987654']));
  });
  it('non-secret git config env stays out of the deny set; credential-bearing values stay in', () => {
    const set = buildDenySet({
      env: {
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_GLOBAL: '/home/runner/.gitconfig-smoke',
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!gh auth git-credential',
        GIT_CONFIG_KEY_1: 'http.extraheader', GIT_CONFIG_VALUE_1: 'AUTHORIZATION: basic c2VjcmV0dmFsdWU=',
      },
    });
    expect(set).toEqual(new Set(['AUTHORIZATION: basic c2VjcmV0dmFsdWU=']));
  });
  it('Git Bash and WSL user-home paths', () => {
    const r = new Redactor();
    expect(r.redact('cd /c/Users/norbe/proj && ls /mnt/c/Users/norbe/proj/a.ts'))
      .toBe('cd ${USERHOME}/proj && ls ${USERHOME}/proj/a.ts');
    expect(scanForSecrets('ls /mnt/c/Users/norbe/proj').map((h) => h.rule)).toEqual(['path.USERHOME']);
  });
  it('Windows home paths at any escape depth', () => {
    let text = 'C:\\Users\\norbe\\proj\\a.ts';
    for (let i = 0; i < 3; i++) text = JSON.stringify({ v: text });
    expect(scanForSecrets(text).map((h) => h.rule)).toEqual(['path.USERHOME']);
    expect(new Redactor().redact(text)).not.toContain('norbe');
  });
  it.each([
    '{"client_secret":"abcdefgh12345"}',
    'db_password="hunter2hunter2"',
    'AWS_SECRET_ACCESS_KEY="abcd1234abcd1234"',
    '{"access_token":"abcdefghijklmn"}',
  ])('generic rule inside longer names: %s', (text) => {
    const out = new Redactor().redact(text);
    expect(out).toContain('<redacted:generic>');
    expect(scanForSecrets(text).map((h) => h.rule)).toEqual(['generic']);
  });
  it('generic rule at escape depth 3 keeps the JSON valid', () => {
    let text = JSON.stringify({ password: 'hunter2hunter2' });
    for (let i = 0; i < 2; i++) text = JSON.stringify({ v: text });
    const out = new Redactor().redact(text);
    expect(out).not.toContain('hunter2');
    expect(JSON.parse(JSON.parse(JSON.parse(out).v).v)).toEqual({ password: '<redacted:generic>' });
  });
  it('PGP private key blocks', () => {
    const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY${'x'.repeat(20)}\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(new Redactor().redact(`a ${pgp} b`)).toBe('a <redacted:private-key> b');
  });
});

describe('review fixes round 3 (#349)', () => {
  const chat = (field: 'content' | 'arguments') => (part: string) => `data: ${JSON.stringify({
    choices: [{ index: 0, delta: field === 'content' ? { content: part } : { tool_calls: [{ index: 0, function: { arguments: part } }] } }],
  })}\n\n`;
  const responses = (type: string) => (part: string) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, item_id: 'it_1', output_index: 0, content_index: 0, delta: part })}\n\n`;
  const split = (text: string, cuts: readonly number[]) => [0, ...cuts].map((at, i, all) => text.slice(at, all[i + 1]));
  const deltasOf = (chunks: string[]) => chunks.map((c) => {
    const data = JSON.parse(/^data: (.*)$/m.exec(c)![1]);
    return (data.delta ?? data.choices[0].delta.content ?? data.choices[0].delta.tool_calls?.[0].function.arguments ?? '') as string;
  }).join('');
  const PATH_ARGS = JSON.stringify({ path: 'C:\\Users\\norbe\\proj\\a.ts' });
  const PASSWORD_TEXT = 'set password=hunter2hunter2 now';

  it.each([
    ['chat tool-call arguments, path over 3 chunks', chat('arguments'), PATH_ARGS, [14, 22], 'norbe'],
    ['chat content, password over 2 chunks', chat('content'), PASSWORD_TEXT, [19], 'hunter2hunter2'],
    ['responses function_call_arguments, path over 3 chunks', responses('response.function_call_arguments.delta'), PATH_ARGS, [14, 22], 'norbe'],
    ['responses output_text, password over 2 chunks', responses('response.output_text.delta'), PASSWORD_TEXT, [19], 'hunter2hunter2'],
  ] as const)('redactResponse redacts a secret split across SSE deltas: %s', (_name, frame, text, cuts, secret) => {
    const chunks = split(text, cuts).map(frame);
    expect(chunks.some((c) => c.includes(secret))).toBe(false);
    const out = new Redactor().redactResponse({ status: 200, headers: { 'content-type': 'text/event-stream', authorization: 'x' }, kind: 'sse', chunks });
    if (out.kind !== 'sse') throw new Error('kind changed');
    expect(out.headers).toEqual({ 'content-type': 'text/event-stream' });
    const joined = deltasOf(out.chunks);
    expect(joined).not.toContain(secret.slice(0, 5));
    expect(scanForSecrets(joined)).toEqual([]);
    expect(joined).toMatch(/\$\{USERHOME\}\/proj\/a\.ts|password=<redacted:generic>/);
    for (const chunk of out.chunks) expect(chunk).toMatch(/\n\n$/);
  });
  it('redactResponse leaves an unaffected stream chunked as it was', () => {
    const chunks = ['hel', 'lo ', 'world'].map(chat('content'));
    const out = new Redactor().redactResponse({ status: 200, headers: {}, kind: 'sse', chunks });
    expect(out).toEqual({ status: 200, headers: {}, kind: 'sse', chunks });
  });
  it('redactResponse redacts a secret split across WebSocket messages', () => {
    const messages = split(PASSWORD_TEXT, [19]).map((part) => ({
      dir: 'in' as const, data: JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: part }),
    }));
    const out = new Redactor().redactResponse({ status: 101, headers: {}, kind: 'ws', messages });
    if (out.kind !== 'ws') throw new Error('kind changed');
    expect(out.messages.map((m) => JSON.parse(m.data).delta).join('')).toBe('set password=<redacted:generic> now');
  });

  it.each([
    '{"clientSecret":"abcdefgh12345"}',
    '{"accessToken":"abcdefgh12345"}',
    '{"refreshToken":"abcdefgh12345"}',
    'authToken=abcdefgh12345',
    '{"privateKey":"abcdefgh12345"}',
    'pwd=abcdefgh12345',
    'passphrase=abcdefgh12345',
  ])('generic rule for camelCase and other names: %s', (text) => {
    expect(new Redactor().redact(text)).toContain('<redacted:generic>');
    expect(scanForSecrets(text).map((h) => h.rule)).toEqual(['generic']);
  });
  it.each([
    ['mixed separators', 'C:\\Users/norbe/proj', '${USERHOME}/proj'],
    ['forward then back', 'C:/Users\\norbe\\proj', '${USERHOME}\\proj'],
    ['percent-encoded file URI', 'file:///c%3A/Users/norbe/proj/a.ts', 'file:///${USERHOME}/proj/a.ts'],
    ['percent-encoded backslashes', 'C%3A%5CUsers%5Cnorbe%5Cproj', '${USERHOME}/proj'],
  ])('user-home path: %s', (_name, text, redacted) => {
    expect(scanForSecrets(text).map((h) => h.rule)).toEqual(['path.USERHOME']);
    expect(new Redactor().redact(text)).toBe(redacted);
  });
  it.each([
    ['openai-key', `sk-proj-${'a1B2c3D4e5'.repeat(4)}`],
    ['openai-key', `sk-${'a1B2c3D4e5'.repeat(4)}`],
    ['slack-token', `xoxb-${'1234567890'}-${'abcdefghijkl'}`],
    ['slack-token', `xoxp-${'1234567890'}-${'abcdefghijkl'}`],
    ['npm-token', `npm_${'a1B2c3D4e5'.repeat(4)}`],
    ['github-token', `gho_${'A1b2C3d4E5'.repeat(4)}`],
    ['github-token', `ghu_${'A1b2C3d4E5'.repeat(4)}`],
    ['github-token', `ghs_${'A1b2C3d4E5'.repeat(4)}`],
    ['aws-key', `ASIA${'ABCDEFGHIJ234567'}`],
  ])('token rule %s', (rule, token) => {
    expect(new Redactor().redact(`x ${token} y`)).toBe(`x <redacted:${rule}> y`);
    expect(scanForSecrets(token).map((h) => h.rule)).toEqual([rule]);
  });
  it.each([
    'Bearer of bad news',
    'token_count: 12345678',
    'secret_version: v2.0.1-beta',
    '{"token_count":"12345678"}',
    'password_policy: minLength8',
    'see icon@2x.png',
  ])('leaves %s alone', (text) => {
    expect(new Redactor().redact(text)).toBe(text);
    expect(scanForSecrets(text)).toEqual([]);
  });
  it('a real bearer token is still redacted', () => {
    expect(new Redactor().redact('Authorization: Bearer abc123def456ghi')).toBe('Authorization: <redacted:bearer>');
  });
  it('SSH_AUTH_SOCK and public keys stay out of the deny set', () => {
    const set = buildDenySet({ env: { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', PUBLIC_KEY: 'notsecretbutlong', SIGNING_PUBLIC_KEY: 'notsecretbutlong2', PRIVATE_KEY: 'reallysecretvalue' } });
    expect(set).toEqual(new Set(['reallysecretvalue']));
  });
});

describe('review fixes round 4 (#349): SDK delta events', () => {
  const split = (text: string, cuts: readonly number[]) => [0, ...cuts].map((at, i, all) => text.slice(at, all[i + 1]));
  const messageDeltas = (text: string, cuts: readonly number[]) => split(text, cuts).map((deltaContent, i) => ({
    type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent }, ephemeral: true, id: `e${i}`,
  }));
  const toolDeltas = (text: string, cuts: readonly number[]) => split(text, cuts).map((inputDelta, i) => ({
    type: 'assistant.tool_call_delta', data: { toolCallId: 'call_1', toolName: 'view', inputDelta }, ephemeral: true, id: `t${i}`,
  }));
  const joinedOf = (events: unknown[], field: 'deltaContent' | 'inputDelta') =>
    events.map((e) => (e as { data: Record<string, string> }).data[field]).join('');

  it('redactEvents redacts a password split across assistant.message_delta events', () => {
    const events = messageDeltas('set password=hunter2hunter2 now', [19]);
    expect(events.some((e) => e.data.deltaContent.includes('hunter2hunter2'))).toBe(false);
    const out = new Redactor().redactEvents(events);
    expect(joinedOf(out, 'deltaContent')).toBe('set password=<redacted:generic> now');
  });
  it('redactEvents redacts a path split across assistant.tool_call_delta events', () => {
    const events = toolDeltas(JSON.stringify({ path: 'C:\\Users\\norbe\\proj\\a.ts' }), [14, 22]);
    const out = new Redactor().redactEvents(events);
    expect(JSON.parse(joinedOf(out, 'inputDelta'))).toEqual({ path: '${USERHOME}/proj/a.ts' });
  });
  it('redactEvents keeps deltas of different messages apart', () => {
    const events = [...messageDeltas('set password=', []), ...messageDeltas('hunter2hunter2', [])];
    events[1].data.messageId = 'm2';
    expect(new Redactor().redactEvents(events)).toEqual(events);
  });
});
