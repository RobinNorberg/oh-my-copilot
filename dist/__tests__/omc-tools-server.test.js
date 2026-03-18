import { describe, it, expect } from 'vitest';
import { omcToolsServer, omcToolNames, getOmcToolNames } from '../mcp/omc-tools-server.js';
const totalTools = 40;
const withoutLsp = 28;
const withoutAst = 38;
const withoutPython = 39;
const withoutSkills = 37;
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
    });
    describe('omcToolsServer', () => {
        it('should be defined', () => {
            expect(omcToolsServer).toBeDefined();
        });
    });
});
//# sourceMappingURL=omc-tools-server.test.js.map