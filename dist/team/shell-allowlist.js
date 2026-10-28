/**
 * The shell ALLOWLIST of a `review` copilot_run session
 * (.omc/plans/2026-10-27-sandboxed-lanes-design.md §4.1).
 *
 * A review session may run only read-only commands: a source command from
 * {@link ALLOWLIST_SOURCES}, piped into at most two filters from
 * {@link ALLOWLIST_FILTERS}, every path argument inside the worktree. Anything
 * the parser does not know is refused, so a new spelling fails closed instead
 * of slipping past a denylist. The rules are the same on every platform (no
 * PowerShell/bash split) and run on the raw text and on
 * normalizeShellCommand's output; both must pass, and every command
 * identifier the runtime parsed must be one this parser saw.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isUnderRoot, normalizeShellCommand } from './sdk-policy.js';
export const MAX_ALLOWLIST_COMMAND_CHARS = 2000;
const MAX_SEGMENTS = 3;
/**
 * Substitution, splatting, here-strings, redirection, chaining, PowerShell
 * escapes and type literals: `|` is the only separator left. `[` is also a
 * bash glob, and `%` covers PowerShell's stop-parsing token `--%` and cmd's
 * `%VAR%`.
 */
const FORBIDDEN_CHARS = /[`$;&><(){}[\]@!%\r\n\0]/;
/**
 * Anything outside printable ASCII (tab allowed): PowerShell reads the
 * Unicode quotes U+2018-U+201F as quotes and the dashes U+2013-U+2015 as
 * `-`, and this parser does not; other code points (spaces, look-alikes) are
 * refused for the same reason.
 */
const NON_ASCII = /[^\t\x20-\x7e]/;
export const ALLOWLIST_SOURCES = new Set([
    'git', 'rg', 'grep', 'findstr', 'select-string', 'sls',
    'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'wc',
    'ls', 'dir', 'get-childitem', 'gci', 'pwd', 'get-location', 'find',
]);
export const ALLOWLIST_FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'select-object', 'measure-object', 'sort-object']);
const GIT_GLOBAL_OPTIONS = new Set(['--no-pager', '-P', '--no-optional-locks']);
const GIT_SUBCOMMANDS = new Set([
    'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'merge-base', 'ls-files', 'ls-tree', 'cat-file',
    'shortlog', 'describe', 'grep', 'name-rev', 'rev-list', 'diff-tree', 'show-ref', 'for-each-ref',
]);
/** git accepts any unique prefix of a long option, so a prefix of these is refused too. */
const GIT_DENIED_LONG = ['--output', '--ext-diff', '--textconv', '--no-index', '--filters'];
const GIT_GREP_DENIED_LONG = ['--open-files-in-pager'];
const RG_DENIED_LONG = new Set(['--pre', '--pre-glob', '--search-zip', '--hostname-bin']);
const SORT_DENIED_LONG = ['--output', '--compress-program'];
const FIND_DENIED = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls']);
const SELECT_OBJECT_OPTIONS = new Set(['-first', '-last', '-skip']);
const deny = (reason) => ({ approve: false, reason: `review allowlist: ${reason}` });
/** Lowercased, `.exe` dropped: the name a command is looked up by. */
function commandName(token) {
    return token.toLowerCase().replace(/\.exe$/, '');
}
/** Whitespace-separated tokens; a quote must span a whole token (`"g"it` is refused). */
function tokenize(segment) {
    const tokens = [];
    let i = 0;
    while (i < segment.length) {
        while (i < segment.length && /\s/.test(segment[i]))
            i++;
        if (i >= segment.length)
            break;
        const ch = segment[i];
        if (ch === '"' || ch === "'") {
            const close = segment.indexOf(ch, i + 1);
            if (close < 0)
                return 'unterminated quote';
            if (close + 1 < segment.length && !/\s/.test(segment[close + 1]))
                return 'quote inside a word';
            tokens.push({ text: segment.slice(i + 1, close), quoted: true });
            i = close + 1;
            continue;
        }
        let end = i;
        while (end < segment.length && !/\s/.test(segment[end]))
            end++;
        const word = segment.slice(i, end);
        if (/["']/.test(word))
            return 'quote inside a word';
        tokens.push({ text: word, quoted: false });
        i = end;
    }
    return tokens;
}
/**
 * `p` with its deepest existing ancestor resolved through links, so a
 * junction in the worktree cannot hide an outside target behind a glob or a
 * missing file (`link/*`).
 */
function realExistingPrefix(p) {
    const tail = [];
    let cur = resolve(p);
    for (;;) {
        try {
            return join(realpathSync.native(cur), ...tail.reverse());
        }
        catch {
            const parent = dirname(cur);
            if (parent === cur)
                return resolve(p);
            tail.push(basename(cur));
            cur = parent;
        }
    }
}
/** Null when `value` names only paths inside the worktree; `gitRev` accepts `<rev>:<path>`. */
function checkPath(value, quoted, gitRev, ctx) {
    if (value === '-')
        return 'reading stdin (-)';
    if (value.startsWith('~') || value.includes('=~') || value.includes(':~'))
        return `home path ${value}`;
    if (value.startsWith('\\\\') || value.startsWith('//'))
        return `UNC path ${value}`;
    // PowerShell reads `a,b` as two paths.
    for (let part of value.split(',')) {
        // A drive path is refused on every platform: off win32 `C:\x` is not
        // absolute and would resolve inside the worktree. Worktree paths are relative.
        if (/^[A-Za-z]:/.test(part))
            return `drive path ${part}`;
        if (part.includes(':')) {
            // `HEAD:src/a.ts`, `:src/a.ts`; a provider path (`env:X`, `HKLM:`) is refused.
            if (!gitRev || part.split(':').length !== 2)
                return `colon in argument ${part}`;
            part = part.slice(part.indexOf(':') + 1);
        }
        // bash (before 5.2) matches `..` with `.*`.
        if (!quoted && part.split(/[\\/]/).some((seg) => seg.startsWith('.') && /[*?]/.test(seg)))
            return `hidden-file glob ${part}`;
        // A backslash separates path segments on every platform (`src\a.ts`, `..\..\x`).
        const slashed = part.replace(/\\/g, '/');
        const abs = isAbsolute(slashed) ? slashed : resolve(ctx.cwd, slashed);
        let inside = false;
        try {
            inside = isUnderRoot(realExistingPrefix(abs), ctx.cwd, ctx.platform);
        }
        catch {
            return `path not resolvable: ${part}`;
        }
        if (!inside)
            return `path outside the worktree: ${part}`;
    }
    return null;
}
/** A short-option cluster (`-nz`) holding one of `letters`. */
const shortHas = (token, letters) => /^-[^-]/.test(token) && [...letters].some((l) => token.slice(1).includes(l));
const prefixOf = (name, denied) => denied.some((d) => d.startsWith(name) || name.startsWith(d));
/** One option token of `cmd` (git: after the subcommand `sub`). */
function checkOption(cmd, sub, token, ctx) {
    if (/[\\~]/.test(token) || (/^-[^-]/.test(token) && /[/:]/.test(token)))
        return `option with an attached path or escape ${token}`;
    const long = token.startsWith('--');
    const eq = token.indexOf('=');
    const name = long && eq > 0 ? token.slice(0, eq) : token;
    switch (cmd) {
        case 'git':
            if (long && prefixOf(name, GIT_DENIED_LONG))
                return `git option ${name}`;
            if (sub === 'grep' && ((long && prefixOf(name, GIT_GREP_DENIED_LONG)) || shortHas(token, 'O')))
                return 'git grep -O (open files in pager)';
            break;
        case 'rg':
            if (RG_DENIED_LONG.has(name) || shortHas(token, 'z'))
                return `rg option ${name}`;
            break;
        case 'sort':
            if ((long && prefixOf(name, SORT_DENIED_LONG)) || shortHas(token, 'o'))
                return `sort option ${name}`;
            break;
        case 'find': {
            const lower = token.toLowerCase();
            if (FIND_DENIED.has(lower) || lower.startsWith('-fprint'))
                return `find action ${token}`;
            break;
        }
        default:
            break;
    }
    return long && eq > 0 ? checkPath(token.slice(eq + 1), false, cmd === 'git', ctx) : null;
}
/** One pipeline segment; `role` says whether it is the source or a filter. */
function checkSegment(tokens, role, ctx) {
    const cmd = commandName(tokens[0].text);
    const table = role === 'source' ? ALLOWLIST_SOURCES : ALLOWLIST_FILTERS;
    if (!table.has(cmd))
        return `${JSON.stringify(tokens[0].text)} is not an allowed ${role} command`;
    let rest = tokens.slice(1);
    let sub = null;
    if (cmd === 'git') {
        let i = 0;
        while (i < rest.length && rest[i].text.startsWith('-')) {
            if (!GIT_GLOBAL_OPTIONS.has(rest[i].text))
                return `git global option ${rest[i].text}`;
            i++;
        }
        sub = rest[i]?.text ?? null;
        if (sub === null || !GIT_SUBCOMMANDS.has(sub))
            return `git subcommand ${JSON.stringify(sub ?? '')} is not allowed`;
        rest = rest.slice(i + 1);
    }
    if (cmd === 'select-object') {
        for (let i = 0; i < rest.length; i += 2) {
            if (!SELECT_OBJECT_OPTIONS.has(rest[i].text.toLowerCase()) || !/^\d+$/.test(rest[i + 1]?.text ?? '')) {
                return 'select-object takes only -First, -Last or -Skip with a number';
            }
        }
        return null;
    }
    let endOfOptions = false;
    for (const tok of rest) {
        const problem = !endOfOptions && tok.text === '--'
            ? null
            : !endOfOptions && tok.text.startsWith('-') && tok.text !== '-'
                ? checkOption(cmd, sub, tok.text, ctx)
                : checkPath(tok.text, tok.quoted, cmd === 'git', ctx);
        if (problem)
            return problem;
        if (tok.text === '--')
            endOfOptions = true;
    }
    return null;
}
/**
 * The command names of `text`'s segments, or why it is refused. `raw`: the
 * text as the shell sees it, whose quoting decides glob expansion (the
 * normalized text has lost it).
 */
function checkText(text, ctx, raw) {
    const segments = text.split('|');
    if (segments.length > MAX_SEGMENTS)
        return `more than ${MAX_SEGMENTS} pipeline segments`;
    const names = [];
    for (const [i, segment] of segments.entries()) {
        const tokens = tokenize(segment);
        if (typeof tokens === 'string')
            return tokens;
        if (tokens.length === 0)
            return 'empty pipeline segment';
        // bash expands an unquoted `*` or `?` (`[` is a forbidden character): a file named `--output=x` would become an option.
        const glob = raw ? tokens.find((t) => !t.quoted && /[*?]/.test(t.text)) : undefined;
        if (glob)
            return `unquoted glob ${glob.text}`;
        const problem = checkSegment(tokens, i === 0 ? 'source' : 'filter', ctx);
        if (problem)
            return problem;
        names.push(commandName(tokens[0].text));
    }
    return names;
}
/** The runtime's parsed identifiers (`commands`, `commandSegments`), reduced to a command name. */
function runtimeIdentifiers(req) {
    const out = [];
    for (const key of ['commands', 'commandSegments']) {
        const list = req[key];
        if (!Array.isArray(list))
            continue;
        for (const entry of list) {
            const id = entry?.identifier;
            if (typeof id !== 'string' || !id.trim())
                continue;
            out.push(commandName(id.trim().split(/[\\/]/).pop().split(/\s+/)[0]));
        }
    }
    return out;
}
/** Approve a review session's shell request only when every rule of §4.1 passes. */
export function reviewShellAllowlist(req, ctx) {
    if (req.kind !== 'shell')
        return deny(`permission kind ${String(req.kind)} is not a shell command`);
    const raw = typeof req.fullCommandText === 'string' ? req.fullCommandText : '';
    if (!raw.trim())
        return deny('shell without command text');
    if (raw.length > MAX_ALLOWLIST_COMMAND_CHARS)
        return deny(`command longer than ${MAX_ALLOWLIST_COMMAND_CHARS} characters`);
    if (req.hasWriteFileRedirection === true)
        return deny('file redirection');
    const wide = NON_ASCII.exec(raw);
    if (wide)
        return deny(`non-ASCII character U+${wide[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    const bad = FORBIDDEN_CHARS.exec(raw);
    if (bad)
        return deny(`forbidden character ${JSON.stringify(bad[0])}`);
    const parsed = checkText(raw, ctx, true);
    if (typeof parsed === 'string')
        return deny(parsed);
    const normalized = checkText(normalizeShellCommand(raw), ctx, false);
    if (typeof normalized === 'string')
        return deny(`${normalized} (after quote normalization)`);
    const seen = new Set([...parsed, ...normalized]);
    const unknown = runtimeIdentifiers(req).find((id) => !seen.has(id));
    if (unknown !== undefined)
        return deny(`the runtime parsed command ${JSON.stringify(unknown)}, which this parser did not see`);
    return { approve: true, reason: 'review allowlist' };
}
//# sourceMappingURL=shell-allowlist.js.map