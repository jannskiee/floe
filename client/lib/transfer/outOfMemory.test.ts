import { describe, it, expect } from 'vitest';
import { isOutOfMemory } from './outOfMemory';

describe('isOutOfMemory', () => {
    it('recognizes V8, the FLOE-M shape', () => {
        expect(isOutOfMemory(new RangeError('Array buffer allocation failed'))).toBe(true);
    });

    it('recognizes JavaScriptCore', () => {
        expect(isOutOfMemory(new RangeError('Out of memory'))).toBe(true);
    });

    it('recognizes SpiderMonkey, which throws a bare string', () => {
        expect(isOutOfMemory('out of memory')).toBe(true);
    });

    it('leaves a RangeError that is a bug in the caller alone', () => {
        expect(isOutOfMemory(new RangeError('Invalid array length'))).toBe(false);
        expect(isOutOfMemory(new RangeError('offset is out of bounds'))).toBe(false);
    });

    it('needs a RangeError, not just the words', () => {
        // A TypeError that happens to say "out of memory" in its text is still
        // a TypeError: something called the wrong thing.
        expect(isOutOfMemory(new TypeError('out of memory'))).toBe(false);
        expect(isOutOfMemory(new Error('Array buffer allocation failed'))).toBe(false);
    });

    it('is false for anything else that can be thrown', () => {
        expect(isOutOfMemory(undefined)).toBe(false);
        expect(isOutOfMemory(null)).toBe(false);
        expect(isOutOfMemory(42)).toBe(false);
        expect(isOutOfMemory('Cannot read properties of null')).toBe(false);
        expect(isOutOfMemory({ message: 'out of memory' })).toBe(false);
    });
});
