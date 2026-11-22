/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */
const SECRET_NAME = String.raw `[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?|WEBHOOK|_KEY\b)[A-Za-z0-9_-]*`;
// Short flag names that are secrets only as a whole word (`--auth`, not `--author`).
const FLAG_NAME = String.raw `(?:${SECRET_NAME}|(?:auth|pass|pw|passphrase|key)(?![A-Za-z0-9_-]))`;
const QUOTED_OR_BARE = String.raw `("[^"]*"|'[^']*'|[^\s"']+)`;
// A value an earlier pattern already masked keeps its recognisable prefix (xoxb-****).
const maskValue = (name, sep, value) => `${name}${sep}${value.includes('****') ? value : '****'}`;
// The regex rules, in the order they run, each with its replacement: what the replacement keeps of the match
// stays visible and the rest becomes ****.
// Fork: the hardened chain (PEM blocks, OpenAI-style keys, ghu_/ghr_, secret-named JSON fields, credential
// headers, NAME=value and --flag value secrets, URL credentials, curl -u, mysql -p, `login -p`, Slack/Discord
// webhooks, padded base64) is on by default, not behind OMC_REDACT_KEY_SHAPES; upstream's rules are a subset.
const TOKEN_RULES = [
    // PEM private keys: the whole body, up to the END line or the end of the text
    [/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '$1****'],
    // Slack tokens: xoxb-..., xapp-..., xoxp-..., xoxa-...
    [/\b(xox[bpae]-)[A-Za-z0-9-]+/g, '$1****'],
    [/\b(xapp-)[A-Za-z0-9-]+/g, '$1****'],
    // Telegram bot tokens in URL paths: /bot123456:ABC.../
    [/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****'],
    // Telegram bot tokens standalone: 123456789:AAHfoo-bar_Baz
    [/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****'],
    // Bearer/Bot authorization values in error strings
    [/(Bearer\s+)\S+/gi, '$1****'],
    [/(Bot\s+)\S+/gi, '$1****'],
    // Anthropic API keys: sk-ant-api...
    [/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****'],
    // OpenAI-style keys: sk-..., sk-proj-...
    [/\b(sk-(?:proj-|live-|test-|svcacct-)?)(?!ant-api)[A-Za-z0-9_-]{8,}/g, '$1****'],
    // GitHub tokens: ghp_, gho_, ghs_, github_pat_
    [/\b(ghp_)[A-Za-z0-9]+/g, '$1****'],
    [/\b(gho_)[A-Za-z0-9]+/g, '$1****'],
    [/\b(ghs_)[A-Za-z0-9]+/g, '$1****'],
    [/\b(gh[ur]_)[A-Za-z0-9]+/g, '$1****'],
    [/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****'],
    // AWS access key IDs: AKIA...
    [/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****'],
    // Secret-named JSON fields, also with escaped quotes: {"password":"x"}, {\"token\":\"x\"}
    [new RegExp(String.raw `((\\?["'])${SECRET_NAME}\2\s*:\s*)(?:(\\?["'])(.*?)\3|([^\s,}\]"'\\]+))`, 'gi'),
        (_m, head, _q, vq, quoted, bare) => vq !== undefined ? `${head}${vq}${(quoted ?? '').includes('****') ? quoted : '****'}${vq}` : `${head}${bare?.includes('****') ? bare : '****'}`],
    // Credential headers: Authorization: Basic x, X-API-Key: x, Cookie: x (the scheme is kept)
    [/\b((?:Proxy-)?Authorization|Cookie|X-[A-Za-z0-9-]*(?:Key|Token|Secret|Auth|Signature)[A-Za-z0-9-]*)(\s*:\s*)((?:Bearer|Basic|Bot|Token|Digest|Negotiate)\s+)?([^"'\\\r\n]+)/gi,
        (_m, name, sep, scheme, value) => `${name}${sep}${scheme ?? ''}${value.includes('****') ? value : '****'}`],
    // Secret-named env assignments / --flag=value: GITHUB_TOKEN=..., --password="..."
    [new RegExp(String.raw `(\b${SECRET_NAME})(\s*=\s*)${QUOTED_OR_BARE}`, 'gi'), (_m, name, sep, value) => maskValue(name, sep, value)],
    // Secret-named flags with a separate value: --token abc, --api-key abc, --token -abc (not --next-flag)
    [new RegExp(String.raw `(--?${FLAG_NAME})(=|\s+)(?!--)${QUOTED_OR_BARE}`, 'gi'), (_m, name, sep, value) => maskValue(name, sep, value)],
    // URL credentials: scheme://user:pass@host, scheme://:pass@host
    // The scheme is bounded (256 characters): an unbounded run made the scan quadratic on long runs such as
    // `a-a-a-...` (every word start read the whole run looking for `://`).
    [/(\b[a-z][a-z0-9+.-]{0,255}:\/\/)[^\s/:@]*:[^\s/@]+@/gi, '$1****@'],
    // curl -u user:pass / --user user:pass (not `-u redis://...`)
    [/(\s(?:-u|--user)(?:=|\s+)["']?[^\s:"']*:)((?!\/)[^\s"']+)/g, (_m, head, value) => `${head}${value.includes('****') ? value : '****'}`],
    // mysql/mariadb -pSecret (attached password)
    [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p)([^\s-][^\s]*)/g, '$1****'],
    // `... login ... -p secret` (docker/podman/helm/az login)
    [/(\blogin\b[^\n|;&]*?\s-p\s+)("[^"]*"|'[^']*'|\S+)/g, '$1****'],
    // Webhook URL secrets: hooks.slack.com/services/..., discord.com/api/webhooks/...
    [/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"']+/gi, '$1****'],
    [/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^\s"'/?]+/gi, '$1****'],
    // Padded base64 blobs: c2VjcmV0cGFzc3dvcmQ=
    [/(?<![A-Za-z0-9+/=*])[A-Za-z0-9+/]{16,}={1,2}(?![A-Za-z0-9+/=])/g, '****'],
];
const MASK = '****';
/** Whether the opt-in key-shape redaction is on: OMC_REDACT_KEY_SHAPES is exactly `1`. */
export function keyShapesEnabled() {
    return process.env.OMC_REDACT_KEY_SHAPES === '1';
}
/** What `replacement` makes of one match; `args` are the arguments String.prototype.replace passes. */
function replaced(replacement, args) {
    if (typeof replacement === 'function')
        return replacement(...args);
    // Only `$n` templates are used by the rules.
    return replacement.replace(/\$(\d)/g, (_t, n) => {
        const group = args[Number(n)];
        return typeof group === 'string' ? group : '';
    });
}
/**
 * Redact sensitive tokens from a string.
 *
 * Patterns masked:
 * - PEM private key blocks: -----BEGIN ... PRIVATE KEY----- ...
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace tokens: xoxp-..., xoxa-...
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 * - Anthropic and OpenAI-style keys (sk-ant-api..., sk-proj-..., sk-...)
 * - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_), AWS access key IDs
 * - Secret-named JSON fields, plain or escaped: {"password":"..."}, {\"token\":\"...\"}
 * - Credential headers: Authorization (keeping the scheme), Proxy-Authorization,
 *   Cookie, X-*-Key / X-*-Token / X-*-Secret / X-*-Auth
 * - Secret-named assignments and flags: AWS_SECRET_ACCESS_KEY=..., GITHUB_TOKEN="...",
 *   OPENAI_KEY=..., --password=..., --api-key ..., --token -dashvalue, --auth ...
 *   (the value is masked, the name is kept)
 * - Command-specific password arguments: curl -u user:pass, mysql -pSecret,
 *   `... login ... -p secret` (docker, az, podman, ...)
 * - Credentials in URLs: https://user:pass@host, redis://:pass@host
 * - Slack and Discord webhook URL secrets
 * - Padded base64 blobs (16+ characters ending in `=`)
 * - With OMC_REDACT_KEY_SHAPES=1 (opt-in): key shapes and NAME=value assignments
 *   (see keyShapeRanges)
 *
 * Without the switch the regex rules run one after the other on the text, as they always did. With it, the
 * rules and the key-shape scan all look at the ORIGINAL text: a rule that has masked a part of it cannot
 * take the name, the quote or the separator of an assignment away from the scan (`ghp_PASSWORD=canary` is
 * an assignment whatever the `ghp_` rule does to its name). Every range they find is masked in one pass.
 */
export function redactTokens(input) {
    if (!keyShapesEnabled()) {
        return TOKEN_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
    }
    const ranges = [];
    // The rules run one after the other, each on what the one before left, as without the switch. The text
    // keeps its length (a masked part becomes `*` characters, which no rule treats differently from ****), so
    // the position of every match is a position in the original input.
    // Fork: a replacement may keep text after the mask (`$1****@`, a closing quote), so the masked part of a match
    // is what lies between the longest common prefix and suffix of the match and its replacement.
    let text = input;
    for (const [pattern, replacement] of TOKEN_RULES) {
        text = text.replace(pattern, (...args) => {
            const match = args[0];
            const offset = args.find((arg, index) => index > 0 && typeof arg === 'number');
            const out = replaced(replacement, args);
            if (out === match)
                return match;
            // Every rule writes its mask as the last **** of its output; what the match shares with the output before
            // and after it stays visible (a **** that was already in the text is not taken for the mask).
            const maskAt = out.lastIndexOf(MASK);
            if (maskAt < 0)
                return match;
            let head = 0;
            while (head < maskAt && head < match.length && match[head] === out[head])
                head++;
            let tail = 0;
            while (tail < out.length - maskAt - MASK.length && tail < match.length - head
                && match[match.length - 1 - tail] === out[out.length - 1 - tail])
                tail++;
            let end = match.length - tail;
            if (end <= head)
                return match;
            const mask = out.slice(head, out.length - tail) || MASK;
            // A value rule (NAME=value, --flag value) that masks one quoted value keeps its quotes, as the key-shape scan
            // writes it (`PASSWORD="****"`).
            if (typeof replacement === 'function' && /^(?:"[^"]*"|'[^']*')$/.test(match.slice(head, end)) && !/^["']/.test(mask)) {
                head++;
                end--;
                if (end === head)
                    return match; // empty quotes hold nothing to mask
            }
            ranges.push([offset + head, offset + end, mask]);
            return match.slice(0, head) + '*'.repeat(end - head) + match.slice(end);
        });
    }
    for (const range of keyShapeRanges(input))
        ranges.push(range);
    return applyMasks(input, ranges);
}
/**
 * The first `max` characters of `text` for a log line or an error message.
 *
 * With OMC_REDACT_KEY_SHAPES=1 the whole text is redacted before it is cut, so a key that starts shortly
 * before the cut cannot leave a fragment that is too short to be recognized. Without the switch the
 * text is cut first, and the caller's own redaction masks what is left, so the output does not change.
 *
 * `finish` is a transformation of the text that the caller applies before it logs it and that adds syntax the
 * scan would misread (escapes: `\"` becomes `\\"` and ends a quoted value). It runs on the redacted text,
 * before the cut, so the redaction always sees the text as it was before the transformation.
 */
export function redactedPrefix(text, max, finish = (redacted) => redacted) {
    return finish(keyShapesEnabled() ? redactTokens(text) : text).slice(0, max);
}
/**
 * The start of `text` for a log line: its first `max` characters (see redactedPrefix), followed by `...` when
 * there is more. `cut` is how many characters of `text` the caller really uses (for example what it types
 * into a pane); the rest is ignored. `finish` is the one of redactedPrefix.
 */
export function redactedPreview(text, max, cut = text.length, finish) {
    const shown = redactedPrefix(text, cut, finish);
    return `${shown.slice(0, max)}${shown.length > max ? '...' : ''}`;
}
// Key prefixes and the minimum number of characters that must follow each prefix.
const REDACT_KEY_SHAPES_PREFIXES = [
    ['sk-', 8],
    ['sk_live_', 16],
    ['sk_test_', 16],
    ['rk_', 16],
    ['AIza', 20],
    ['gsk_', 20],
    ['xai-', 20],
    ['hf_', 20],
];
// Name fragments that make a NAME=value or NAME: value assignment a candidate (matched case-insensitively).
const REDACT_KEY_SHAPES_PHRASES = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD', 'CREDENTIALS'];
function isWordChar(code) {
    return code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // [A-Za-z0-9_]
}
function isTokenChar(code) {
    return code === 45 || isWordChar(code); // [A-Za-z0-9_-]
}
/**
 * The end of the NAME that starts at word boundary `i`, or -1 when no assignment name starts there. NAME is
 * the whole run of letters, digits and underscores (whatever its length) and contains one of the phrases.
 * Every run is read once, from its own boundary, so the total cost over an input is linear.
 */
function assignmentNameEnd(input, i) {
    const n = input.length;
    let j = i;
    while (j < n && isWordChar(input.charCodeAt(j)))
        j++;
    if (j - i < 3)
        return -1; // shorter than every phrase
    const name = input.slice(i, j).toUpperCase();
    return REDACT_KEY_SHAPES_PHRASES.some((phrase) => name.includes(phrase)) ? j : -1;
}
function isSkippable(c) {
    return c === '"' || c === "'" || c === '[' || c === ']';
}
/**
 * The positions of the separators (`=` or `:`) that can belong to the NAME that ends at `from`. Quotes, `]` and
 * `[index]` parts of any length may stand between the name and the separator, and spaces and tabs may stand
 * anywhere between those parts (`NAME ["a"] ["b"] = x`). A `[` is read both ways: as the start of an index,
 * which is jumped over up to the next `]`, and as an ordinary character, so that an index that swallows the
 * separator (`PASSWORD[=x ]`) cannot hide it. A `[` followed by a quoted key is also read as an index that
 * ends at the first `]` after the closing quote, so a `]` inside the key (`CREDENTIALS["a]b"]=x`) does not end
 * the index; the key is read with and without backslash escapes (the escape is optional in single quotes).
 * Every position is followed at most once for the whole input (a position gives the same separators
 * whichever name led to it), so the total cost is linear however many names and brackets there are. A run of spaces and tabs is entered only at its start (the character before
 * it is never a space or a tab), so skipping it does not make the scan quadratic.
 */
function separatorsAfter(input, from, tables) {
    const n = input.length;
    const found = [];
    const skipBlanks = (start) => {
        let k = start;
        while (k < n && (input[k] === ' ' || input[k] === '\t'))
            k++;
        return k;
    };
    const first = skipBlanks(from);
    if (!isSkippable(input[first])) { // the usual case: nothing stands between the name and the separator
        if (input[first] === '=' || input[first] === ':')
            found.push(first);
        return found;
    }
    const followed = (tables.followed ??= new Uint8Array(n + 1));
    const stack = [first];
    while (stack.length > 0) {
        const entry = stack.pop();
        if (followed[entry])
            continue;
        followed[entry] = 1;
        const k = skipBlanks(entry);
        if (!isSkippable(input[k])) {
            if (input[k] === '=' || input[k] === ':')
                found.push(k);
            continue;
        }
        if (input[k] === '[') {
            const close = (tables.closeFrom ??= closeIndexes(input))[k + 1];
            if (close >= 0)
                stack.push(close + 1);
            const open = skipBlanks(k + 1);
            const quote = input[open];
            if (quote === '"' || quote === "'") {
                for (const escaped of quote === '"' ? [true] : [false, true]) {
                    const map = quote === "'" && escaped ? tables.keyEnds : tables.ends; // double quotes: the table of values
                    let table = map.get(quote);
                    if (!table) {
                        table = valueEnds(input, quote, escaped);
                        map.set(quote, table);
                    }
                    const end = table[open + 1];
                    if (input[end] !== quote)
                        continue; // the key is not closed on this line
                    const after = skipBlanks(end + 1);
                    if (input[after] === ']')
                        stack.push(after + 1);
                }
            }
        }
        stack.push(k + 1);
    }
    return found;
}
function closeIndexes(input) {
    const n = input.length;
    const closeFrom = new Int32Array(n + 1);
    closeFrom[n] = -1;
    for (let p = n - 1; p >= 0; p--)
        closeFrom[p] = input.charCodeAt(p) === 93 ? p : closeFrom[p + 1];
    return closeFrom;
}
/**
 * For every position p of `input`, the end of a value that is scanned from p (`ends[p]`), so that the end of
 * any value is found in constant time and values that contain other values never make the scan quadratic.
 * A quoted value ends at the next matching quote or line break; in double quotes a backslash escapes the
 * next character, but never a line break; in single quotes it is literal. A bare value ends at a space, tab,
 * line break, quote, `&`, `;`, `|`, `,`, `)` or `}`. With `escapes` set, a backslash also escapes in single
 * quotes (a quoted index key).
 */
function valueEnds(input, quote, escapes = quote === '"') {
    const n = input.length;
    const ends = new Int32Array(n + 1);
    ends[n] = n;
    for (let p = n - 1; p >= 0; p--) {
        const c = input[p];
        if (quote ? c === quote || c === '\n' : ' \t\r\n"\'&;|,)}'.includes(c))
            ends[p] = p;
        else if (quote && escapes && c === '\\' && p + 1 < n && input[p + 1] !== '\n')
            ends[p] = ends[p + 2];
        else
            ends[p] = ends[p + 1];
    }
    return ends;
}
/**
 * The parts of `input` that hold key shapes, found in linear time (no regular expressions, so no
 * backtracking) on the original text, before any other rule has changed it (see redactTokens).
 *
 * - Prefixed keys: the prefix stays visible and the rest is replaced by `****`
 *   (for example `sk-****`). The minimum length counts the characters after the prefix.
 * - JWTs: three base64url segments, the first starting with `eyJ`; masked as `eyJ***`.
 * - NAME=value and NAME: value, where NAME contains KEY, TOKEN, SECRET, PASSWORD,
 *   PASSWD, PASS, PWD or CREDENTIALS (matched case-insensitively, anywhere in the name). The name and the
 *   quotes and `[index]` parts between it, and the spaces and tabs around them, have no length limit (see
 *   separatorsAfter).
 *   A quoted value runs to the matching quote on the same line, or to the end of the line when the quote is
 *   missing (a truncated preview); see valueEnds for escapes and for where a bare value ends.
 *
 * Every word boundary is examined on its own, by all three rules, so that nothing a rule has already matched
 * can hide a later one: a value can contain the name of another assignment (a quote that opens the next value
 * was taken as the closing quote, `abc:TOKEN="x"`), and a key can be followed by one (`sk-...-PASSWORD=x`).
 * Masks that overlap are merged into one. The only starts that are skipped are those that provably end where
 * the start before them ended (inside the run of characters of a key or of a JWT's first segment), so their
 * masks lie inside masks that were already made.
 */
function keyShapeRanges(input) {
    const n = input.length;
    const ranges = [];
    const tables = { ends: new Map(), keyEnds: new Map() };
    let keySkipUntil = 0;
    let jwtSkipUntil = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0 && isWordChar(input.charCodeAt(i - 1)))
            continue; // not a word boundary (\b)
        const nameEnd = assignmentNameEnd(input, i);
        if (nameEnd >= 0) {
            for (const separator of separatorsAfter(input, nameEnd, tables)) {
                let valueStart = separator + 1;
                while (valueStart < n && (input[valueStart] === ' ' || input[valueStart] === '\t'))
                    valueStart++;
                const quote = input[valueStart] === '"' || input[valueStart] === "'" ? input[valueStart] : '';
                if (quote)
                    valueStart++;
                let table = tables.ends.get(quote);
                if (!table)
                    tables.ends.set(quote, (table = valueEnds(input, quote)));
                if (table[valueStart] > valueStart)
                    ranges.push([valueStart, table[valueStart], MASK]);
            }
        }
        if (i >= keySkipUntil) {
            for (const [prefix, minLength] of REDACT_KEY_SHAPES_PREFIXES) {
                if (!input.startsWith(prefix, i))
                    continue;
                let j = i + prefix.length;
                while (j < n && isTokenChar(input.charCodeAt(j)))
                    j++;
                if (j - (i + prefix.length) >= minLength) {
                    ranges.push([i + prefix.length, j, MASK]);
                    keySkipUntil = j;
                }
                break; // at most one prefix can match at a position
            }
        }
        if (i >= jwtSkipUntil && input.startsWith('eyJ', i)) {
            let j = i + 3;
            while (j < n && isTokenChar(input.charCodeAt(j)))
                j++;
            jwtSkipUntil = j; // an "eyJ" inside this run ends its first segment at j as well and meets the same later segments
            if (j - i >= 11 && input[j] === '.') {
                let k = j + 1;
                while (k < n && isTokenChar(input.charCodeAt(k)))
                    k++;
                if (k - (j + 1) >= 8 && input[k] === '.') {
                    let m = k + 1;
                    while (m < n && isTokenChar(input.charCodeAt(m)))
                        m++;
                    if (m - (k + 1) >= 8)
                        ranges.push([i + 3, m, '***']);
                }
            }
        }
    }
    return ranges;
}
/** `input` with every range replaced by its mask; ranges that overlap are merged into the earlier mask. */
function applyMasks(input, ranges) {
    if (ranges.length === 0)
        return input;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [start, end, mask] of ranges) {
        if (start < pos) { // overlap: merge into the earlier mask
            if (end > pos)
                pos = end;
            continue;
        }
        out += input.slice(pos, start) + mask;
        pos = end;
    }
    return out + input.slice(pos);
}
//# sourceMappingURL=redact.js.map