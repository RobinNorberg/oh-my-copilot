import { describe, expect, it } from 'vitest';
import { areaTagWiql, boardColumnWiql, escapeWiql, QUERY_ID, WiqlError } from '../wiql.js';
describe('WIQL from config values only', () => {
    it('doubles single quotes', () => {
        expect(escapeWiql("O'Brien's")).toBe("O''Brien''s");
    });
    it('refuses empty values and control characters instead of escaping them', () => {
        for (const v of ['', 'a\nb', 'a\u0000', 'tab\there'])
            expect(() => escapeWiql(v), JSON.stringify(v)).toThrow(WiqlError);
    });
    it('a quote in a config value cannot end the literal', () => {
        const q = areaTagWiql({ type: 'area-tag', areaPath: "Web' OR [System.Id] > '0", tag: 'factory' }, []);
        expect(q).toContain("[System.AreaPath] UNDER 'Web'' OR [System.Id] > ''0'");
        expect(q).not.toContain('[System.WorkItemType]');
    });
    it('board column WIQL takes only a WEF Kanban column field', () => {
        expect(boardColumnWiql('WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column', 'Ready', ['Bug'])).toContain("[WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column] = 'Ready' AND [System.WorkItemType] IN ('Bug')");
        expect(() => boardColumnWiql('System.Title] = 1 OR [System.Id', 'Ready', [])).toThrow(WiqlError);
    });
    it('saved query ids are GUIDs', () => {
        expect(QUERY_ID.test('0b6c6d2e-1a5f-4c83-9d2e-7f1a2b3c4d5e')).toBe(true);
        expect(QUERY_ID.test("0b6c6d2e' OR 1=1")).toBe(false);
    });
});
//# sourceMappingURL=wiql.test.js.map