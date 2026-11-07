import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import { parseMaxWorkers } from '../../scripts/ci/parse-max-workers.mjs';
describe('parseMaxWorkers', () => {
    it.each([['2', 2], ['10', 10], ['16', 16], [' 6 ', 6]])('accepts %j', (input, expected) => {
        expect(parseMaxWorkers(input)).toBe(expected);
    });
    it.each(['8d', '1.5', '-2', '0', '', 'abc', undefined, '9'.repeat(30)])('rejects %j', (input) => {
        expect(parseMaxWorkers(input)).toBe(0);
    });
});
//# sourceMappingURL=parse-max-workers.test.js.map