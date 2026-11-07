import { describe, expect, it } from 'vitest';
import { acceptanceSectionOf, backlogFileId, backlogSlug, BacklogParseError, parseBacklogFile, renderBacklogFile } from '../backlog.js';
const P = '.copilot/backlog/1-add-remove.md';
function parseError(path, text) {
    try {
        parseBacklogFile(path, text);
    }
    catch (err) {
        expect(err).toBeInstanceOf(BacklogParseError);
        return err.message;
    }
    throw new Error('expected a BacklogParseError');
}
describe('backlog file names', () => {
    it.each([
        ['1-add-remove.md', 1],
        ['42-x.md', 42],
        ['README.md', undefined],
        ['0-zero.md', undefined],
        ['1-Upper.md', undefined],
        ['1-add.markdown', undefined],
        ['1-.md', undefined],
    ])('%s -> %s', (name, id) => {
        expect(backlogFileId(name)).toBe(id);
    });
    it('slugs a title', () => {
        expect(backlogSlug('Add remove() to the TODO list!')).toBe('add-remove-to-the-todo-list');
        expect(backlogSlug('***')).toBe('item');
        expect(backlogSlug('x'.repeat(80))).toHaveLength(60);
    });
});
describe('parseBacklogFile', () => {
    it('parses inline and block lists, quoted scalars, comments and the acceptance section', () => {
        const text = [
            '---',
            'title: "Add remove(): drop an item"',
            'state: open',
            '# a comment line',
            'labels: [factory, "size:2"]',
            'dependsOn:',
            '  - 2',
            '  - 3',
            'parent: 7',
            'priority: 2',
            'size: 3',
            '---',
            '',
            'Body text.',
            'Depends on #4',
            '',
            '## Acceptance',
            '- [ ] `remove(id)` deletes the item',
            '- [ ] `npm test` passes',
            '',
            '## Notes',
            'not acceptance',
        ].join('\r\n');
        const item = parseBacklogFile(P, text);
        expect(item).toMatchObject({
            id: 1,
            path: P,
            title: 'Add remove(): drop an item',
            state: 'open',
            labels: ['factory', 'size:2'],
            dependsOn: [2, 3, 4],
            parent: 7,
            priority: 2,
            size: 3,
            acceptance: '- [ ] `remove(id)` deletes the item\n- [ ] `npm test` passes',
        });
        expect(item.fields.dependsOn).toEqual([2, 3]);
        expect(item.body.startsWith('Body text.')).toBe(true);
    });
    it('defaults state to open and takes the parent from a "Part of #n" line', () => {
        const item = parseBacklogFile('b/2-x.md', "---\ntitle: 'it''s fine'\n---\nPart of #9\n");
        expect(item).toMatchObject({ id: 2, title: "it's fine", state: 'open', labels: [], dependsOn: [], parent: 9 });
        expect(item.fields).not.toHaveProperty('parent');
    });
    it.each([
        ['no frontmatter', 'title: x\n', 'must start with a "---"'],
        ['an unclosed frontmatter', '---\ntitle: x\n', 'no closing "---"'],
        ['an unknown key', '---\ntitle: x\nowner: me\n---\n', 'unknown key owner'],
        ['a duplicate key', '---\ntitle: x\ntitle: y\n---\n', 'duplicate key title'],
        ['a missing title', '---\nstate: open\n---\n', 'title is required'],
        ['a bad state', '---\ntitle: x\nstate: done\n---\n', 'state must be open or closed'],
        ['a non-numeric dependsOn', '---\ntitle: x\ndependsOn: [two]\n---\n', 'dependsOn must be a positive integer'],
        ['a list for a scalar key', '---\ntitle: x\nparent: [1]\n---\n', 'parent takes one value'],
        ['an unclosed list', '---\ntitle: x\nlabels: [a, b\n---\n', 'unclosed list'],
        ['a malformed line', '---\ntitle: x\njust words\n---\n', 'expected "key: value"'],
        ['a bad double quote', '---\ntitle: "x\n---\n', 'malformed double-quoted'],
        ['a label with a comma-free but leading dash', '---\ntitle: x\nlabels: [-x]\n---\n', 'is not a plain name'],
    ])('refuses %s with an error naming the file', (_name, text, detail) => {
        const message = parseError(P, text);
        expect(message).toContain(P);
        expect(message).toContain(detail);
    });
    it('refuses a file name without an id', () => {
        expect(parseError('b/notes.md', '---\ntitle: x\n---\n')).toContain('<id>-<slug>.md');
    });
});
describe('renderBacklogFile', () => {
    it('round-trips through parseBacklogFile', () => {
        const fields = { title: 'Say "hi": now', state: 'closed', labels: ['factory', 'needs review'], dependsOn: [2], parent: 1, priority: 3, size: 2 };
        const text = renderBacklogFile(fields, 'Body\r\n\n\n');
        expect(text.endsWith('Body\n')).toBe(true);
        const item = parseBacklogFile('d/5-say-hi.md', text);
        expect(item.fields).toEqual(fields);
        expect(item.body).toBe('Body\n');
    });
    it('refuses a multi-line title and a bad label', () => {
        expect(() => renderBacklogFile({ title: 'a\nb', state: 'open', labels: [], dependsOn: [] }, '')).toThrow(/title/);
        expect(() => renderBacklogFile({ title: 'a', state: 'open', labels: ['a,b'], dependsOn: [] }, '')).toThrow(/label/);
    });
});
describe('acceptanceSectionOf', () => {
    it('reads "## Acceptance criteria" up to the next heading, and nothing when absent', () => {
        expect(acceptanceSectionOf('x\n## Acceptance criteria\n- a\n# Other\n- b')).toBe('- a');
        expect(acceptanceSectionOf('x\n### Acceptance\n- a')).toBeUndefined();
        expect(acceptanceSectionOf('## Acceptance\n\n')).toBeUndefined();
    });
});
//# sourceMappingURL=backlog.test.js.map