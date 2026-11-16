import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { omcToolsServer, omcToolNames, getOmcToolNames, resolveOmcMcpServerPath, } from '../mcp/omc-tools-server.js';
// The stdio server does not serve the interop tools, so they are never listed.
const totalTools = 50;
const withoutLsp = 38;
const withoutAst = 48;
const withoutPython = 49;
const withoutSkills = 47;
describe('omc-tools-server', () => {
    describe('omcToolNames', () => {
        it('should export expected tools total', () => {
            expect(omcToolNames).toHaveLength(totalTools);
        });
        it('should have 12 LSP tools', () => {
            const lspTools = omcToolNames.filter(n => n.includes('lsp_'));
            expect(lspTools).toHaveLength(12);
        });
        it('should have 2 AST tools', () => {
            const astTools = omcToolNames.filter(n => n.includes('ast_'));
            expect(astTools).toHaveLength(2);
        });
        it('should have python_repl tool', () => {
            expect(omcToolNames).toContain('mcp__t__python_repl');
        });
        it('should have session_search tool', () => {
            expect(omcToolNames).toContain('mcp__t__session_search');
        });
        it('should use correct MCP naming format', () => {
            omcToolNames.forEach(name => {
                expect(name).toMatch(/^mcp__t__/);
            });
        });
    });
    describe('getOmcToolNames', () => {
        it('should return all tools by default', () => {
            const tools = getOmcToolNames();
            expect(tools).toHaveLength(totalTools);
        });
        it('should filter out LSP tools when includeLsp is false', () => {
            const tools = getOmcToolNames({ includeLsp: false });
            expect(tools.some(t => t.includes('lsp_'))).toBe(false);
            expect(tools).toHaveLength(withoutLsp);
        });
        it('should filter out AST tools when includeAst is false', () => {
            const tools = getOmcToolNames({ includeAst: false });
            expect(tools.some(t => t.includes('ast_'))).toBe(false);
            expect(tools).toHaveLength(withoutAst);
        });
        it('should filter out python_repl when includePython is false', () => {
            const tools = getOmcToolNames({ includePython: false });
            expect(tools.some(t => t.includes('python_repl'))).toBe(false);
            expect(tools).toHaveLength(withoutPython);
        });
        it('should filter out skills tools', () => {
            const names = getOmcToolNames({ includeSkills: false });
            expect(names).toHaveLength(withoutSkills);
            expect(names.every(n => !n.includes('load_omc_skills') && !n.includes('list_omc_skills'))).toBe(true);
        });
        it('should have 3 skills tools', () => {
            const skillsTools = omcToolNames.filter(n => n.includes('load_omc_skills') || n.includes('list_omc_skills'));
            expect(skillsTools).toHaveLength(3);
        });
        it('supports includeInterop filter option', () => {
            const withInterop = getOmcToolNames({ includeInterop: true });
            const withoutInterop = getOmcToolNames({ includeInterop: false });
            expect(withInterop.some(n => n.includes('interop_'))).toBe(false);
            expect(withoutInterop.some(n => n.includes('interop_'))).toBe(false);
        });
    });
    describe('resolveOmcMcpServerPath', () => {
        function makeTree(withBridge) {
            const root = mkdtempSync(join(tmpdir(), 'omc-mcp-path-'));
            mkdirSync(join(root, 'dist', 'mcp'), { recursive: true });
            if (withBridge) {
                mkdirSync(join(root, 'bridge'));
                writeFileSync(join(root, 'bridge', 'mcp-server.cjs'), '');
            }
            return root;
        }
        const moduleUrlIn = (root) => pathToFileURL(join(root, 'dist', 'mcp', 'omc-tools-server.js')).href;
        it('uses the package root when it has the bridge', () => {
            const root = makeTree(true);
            try {
                expect(resolveOmcMcpServerPath(root, null)).toBe(join(root, 'bridge', 'mcp-server.cjs'));
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
        it('falls back to the bridge two levels above the module when no package root is found', () => {
            const root = makeTree(true);
            try {
                expect(resolveOmcMcpServerPath(null, moduleUrlIn(root))).toBe(join(root, 'bridge', 'mcp-server.cjs'));
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
        it('throws a clear error when no candidate exists', () => {
            const root = makeTree(false);
            try {
                expect(() => resolveOmcMcpServerPath(null, moduleUrlIn(root))).toThrow('bridge/mcp-server.cjs not found');
                expect(() => resolveOmcMcpServerPath(null, null)).toThrow('no candidate paths');
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
    describe('omcToolsServer', () => {
        it('is a stdio config that launches the shipped standalone server', () => {
            expect(omcToolsServer.command).toBe(process.execPath);
            expect(omcToolsServer.args).toHaveLength(1);
            expect(omcToolsServer.args[0].replace(/\\/g, '/')).toMatch(/\/bridge\/mcp-server\.cjs$/);
        });
    });
});
//# sourceMappingURL=omc-tools-server.test.js.map