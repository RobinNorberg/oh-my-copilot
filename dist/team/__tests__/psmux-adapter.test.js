import { afterEach, describe, expect, it, vi } from 'vitest';
import { win32 } from 'path';
const fsMocks = vi.hoisted(() => ({
    readdir: vi.fn(async () => []),
    rm: vi.fn(async (_path, _options) => undefined),
}));
vi.mock('fs/promises', async (importOriginal) => ({
    ...await importOriginal(),
    readdir: fsMocks.readdir,
    rm: fsMocks.rm,
}));
import { PSMUX_NS_DIR, buildPsmuxNamespacePath, decodeTmuxCommandString, disposePsmuxNamespace, psmuxNamespaceOf, runPsmuxVerifiedCommand, translatePsmuxArgs, } from '../psmux-adapter.js';
/** Same quoting as tmux-session's tmuxCommandString for non-format args. */
function encode(args) {
    return args.map(arg => `'${arg.replace(/#/g, '##').replace(/'/g, `'"'"'`)}'`).join(' ');
}
const nsPath = win32.join(PSMUX_NS_DIR, 'omg-k1-k2-abcdef12');
const identity = { socket_path: nsPath, server_pid: 4242, process_started_at: 'win32:638000000000000000' };
afterEach(() => {
    vi.restoreAllMocks();
});
describe('psmux namespace paths', () => {
    it('builds a private namespace path under ~/.psmux/omg-ns and resolves it back', () => {
        const path = buildPsmuxNamespacePath();
        expect(win32.dirname(path)).toBe(PSMUX_NS_DIR);
        const ns = psmuxNamespaceOf(path);
        expect(ns).toMatch(/^omg-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(buildPsmuxNamespacePath()).not.toBe(path);
    });
    it('rejects paths outside the namespace directory or with unsafe names', () => {
        expect(psmuxNamespaceOf(nsPath.toUpperCase().replace('OMG-K1-K2-ABCDEF12', 'omg-k1-k2-abcdef12'))).toBe('omg-k1-k2-abcdef12');
        expect(psmuxNamespaceOf('C:\\Users\\u\\.psmux/default')).toBeNull();
        expect(psmuxNamespaceOf(win32.join(PSMUX_NS_DIR, 'default'))).toBeNull();
        expect(psmuxNamespaceOf(win32.join(PSMUX_NS_DIR, 'omg-a#b'))).toBeNull();
        expect(psmuxNamespaceOf(win32.join(PSMUX_NS_DIR, 'omg-a|b'))).toBeNull();
        expect(psmuxNamespaceOf(win32.join(PSMUX_NS_DIR, 'omg-a\tb'))).toBeNull();
        expect(psmuxNamespaceOf('/tmp/o-1.sock')).toBeNull();
    });
});
describe('decodeTmuxCommandString', () => {
    it.each([
        [['send-keys', '-t', '%1', '-l', '--', "it's"]],
        [['send-keys', '-t', '%1', '-l', '--', 'a # b ## c #{pane_id}']],
        [['send-keys', '-t', '%1', '-l', '--', 'spaces  and ; semi $HOME %PATH% \t tab']],
        [['kill-session', '-t', '$0']],
        [['send-keys', '-t', '%1', '-l', '--', '']],
        [['send-keys', '-t', '%1', '-l', '--', "''\"'\""]],
    ])('round-trips %j', (args) => {
        expect(decodeTmuxCommandString(encode(args))).toEqual(args);
    });
    it('accepts one bare command word', () => {
        expect(decodeTmuxCommandString('kill-server')).toEqual(['kill-server']);
    });
    it.each([
        '',
        'kill-server; display-message x',
        "'a'  'b'",
        "'a''b'",
        "'unterminated",
        "'a' b",
        " 'a'",
        "'a' ",
    ])('rejects %j', (value) => {
        expect(decodeTmuxCommandString(value)).toBeNull();
    });
});
describe('translatePsmuxArgs', () => {
    it('maps -S <ns path> to -L <ns>, substitutes #{socket_path} and maps format tabs', () => {
        const t = translatePsmuxArgs(['-S', nsPath, 'new-session', '-d', '-P', '-F', '#S:0\t#{pane_id}\t#{socket_path}\t#{pid}', '-s', 'a\tb']);
        expect(t.args).toEqual(['-L', 'omg-k1-k2-abcdef12', 'new-session', '-d', '-P', '-F', `#S:0|#{pane_id}|${nsPath}|#{pid}`, '-s', 'a\tb']);
        expect(t.restore(`t:0|%1|${nsPath}|77\n`)).toBe(`t:0\t%1\t${nsPath}\t77\n`);
    });
    it('maps tabs in display-message -p formats', () => {
        const t = translatePsmuxArgs(['-S', nsPath, 'display-message', '-p', '#{socket_path}\t#{pid}']);
        expect(t.args).toEqual(['-L', 'omg-k1-k2-abcdef12', 'display-message', '-p', `${nsPath}|#{pid}`]);
        expect(t.restore(`${nsPath}|77`)).toBe(`${nsPath}\t77`);
    });
    it('does not restore tabs when no format tab was mapped', () => {
        const t = translatePsmuxArgs(['-S', nsPath, 'capture-pane', '-p', '-t', '%1']);
        expect(t.args).toEqual(['-L', 'omg-k1-k2-abcdef12', 'capture-pane', '-p', '-t', '%1']);
        expect(t.restore('a|b')).toBe('a|b');
    });
    it('throws for any other -S path and leaves non -S argv untouched', () => {
        expect(() => translatePsmuxArgs(['-S', 'C:\\Users\\u\\.psmux/default', 'ls'])).toThrow('psmux_socket_path_unsupported');
        expect(() => translatePsmuxArgs(['-S'])).toThrow('psmux_socket_path_unsupported');
        const t = translatePsmuxArgs(['display-message', '-p', '#{pid}\t#{socket_path}']);
        expect(t.args).toEqual(['display-message', '-p', '#{pid}\t#{socket_path}']);
        expect(t.restore('x|y')).toBe('x|y');
    });
});
describe('runPsmuxVerifiedCommand', () => {
    const command = encode(['kill-pane', '-t', '%2']);
    it('sends nothing and reports not_executed when the identity does not match', async () => {
        for (const state of ['dead', 'unknown']) {
            const exec = vi.fn();
            const result = await runPsmuxVerifiedCommand(identity, command, { observe: async () => state, exec });
            expect(result.outcome).toBe('not_executed');
            expect(exec).not.toHaveBeenCalled();
        }
        const exec = vi.fn();
        const throwing = await runPsmuxVerifiedCommand(identity, command, {
            observe: async () => { throw new Error('probe'); },
            exec,
        });
        expect(throwing.outcome).toBe('not_executed');
        expect(exec).not.toHaveBeenCalled();
    });
    it('runs decoded argv against the namespace and reports executed on clean exit', async () => {
        const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
        const result = await runPsmuxVerifiedCommand(identity, command, { observe: async () => 'matching', exec });
        expect(result.outcome).toBe('executed');
        expect(exec).toHaveBeenCalledExactlyOnceWith(['-S', nsPath, 'kill-pane', '-t', '%2'], { timeout: 5_000, stripTmux: true });
    });
    it('maps no-server to not_executed and other failures to unknown', async () => {
        const noServer = Object.assign(new Error('Command failed'), { stderr: "psmux: no server running on session 'omg-k1__default'" });
        expect((await runPsmuxVerifiedCommand(identity, command, {
            observe: async () => 'matching',
            exec: async () => { throw noServer; },
        })).outcome).toBe('not_executed');
        expect((await runPsmuxVerifiedCommand(identity, command, {
            observe: async () => 'matching',
            exec: async () => { throw new Error('boom'); },
        })).outcome).toBe('unknown');
        expect((await runPsmuxVerifiedCommand(identity, command, {
            observe: async () => 'matching',
            exec: async () => ({ stdout: '', stderr: "can't find pane: %2" }),
        })).outcome).toBe('unknown');
    });
    it('refuses undecodable commands and non-namespace identities without observing', async () => {
        const observe = vi.fn(async () => 'matching');
        const exec = vi.fn();
        expect((await runPsmuxVerifiedCommand(identity, 'kill-pane -t %2; kill-server', { observe, exec })).outcome).toBe('unknown');
        expect((await runPsmuxVerifiedCommand({ ...identity, socket_path: 'C:\\Users\\u\\.psmux/default' }, command, { observe, exec })).outcome).toBe('unknown');
        expect(observe).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
    });
});
describe('disposePsmuxNamespace', () => {
    it('kills the namespace server and confirms an empty inventory', async () => {
        const exec = vi.fn(async (args) => {
            if (args[2] === 'kill-server')
                throw new Error('exit 1');
            return { stdout: '', stderr: '' };
        });
        await expect(disposePsmuxNamespace(nsPath, exec)).resolves.toBe(true);
        expect(exec.mock.calls.map(call => call[0])).toEqual([
            ['-S', nsPath, 'kill-server'],
            ['-S', nsPath, 'ls'],
        ]);
    });
    it('removes only this namespace\'s leftover registry files once it is verified empty', async () => {
        fsMocks.readdir.mockResolvedValueOnce([
            'omg-k1-k2-abcdef12__omc-team-x.pid',
            'omg-k1-k2-abcdef12____warm__.sid',
            'omg-k1-k2-abcdef12-other__s.pid',
            'default__s.pid',
            '__warm__.pid',
        ]);
        fsMocks.rm.mockClear();
        await expect(disposePsmuxNamespace(nsPath, async () => ({ stdout: '', stderr: '' }))).resolves.toBe(true);
        expect(fsMocks.rm.mock.calls.map(call => win32.basename(String(call[0])))).toEqual([
            'omg-k1-k2-abcdef12__omc-team-x.pid',
            'omg-k1-k2-abcdef12____warm__.sid',
        ]);
        fsMocks.rm.mockClear();
        await expect(disposePsmuxNamespace(nsPath, async (args) => ({ stdout: args[2] === 'ls' ? 't: 1 windows\n' : '', stderr: '' }))).resolves.toBe(false);
        expect(fsMocks.rm).not.toHaveBeenCalled();
    });
    it('is unverified while sessions remain or the inventory fails', async () => {
        await expect(disposePsmuxNamespace(nsPath, async (args) => ({ stdout: args[2] === 'ls' ? 't: 1 windows\n' : '', stderr: '' }))).resolves.toBe(false);
        await expect(disposePsmuxNamespace(nsPath, async (args) => {
            if (args[2] === 'ls')
                throw new Error('timeout');
            return { stdout: '', stderr: '' };
        })).resolves.toBe(false);
        await expect(disposePsmuxNamespace(nsPath, async (args) => {
            if (args[2] === 'ls')
                throw Object.assign(new Error('x'), { stderr: 'no server running on session' });
            return { stdout: '', stderr: '' };
        })).resolves.toBe(true);
    });
    it('never touches a non-namespace path', async () => {
        const exec = vi.fn();
        await expect(disposePsmuxNamespace('C:\\Users\\u\\.psmux/default', exec)).resolves.toBe(false);
        expect(exec).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=psmux-adapter.test.js.map