import { describe, it, expect } from 'vitest';
import { classifyThrow } from './receiveFailure';

describe('classifyThrow: out of memory', () => {
    it('recognizes V8, the FLOE-M shape', () => {
        expect(classifyThrow(new RangeError('Array buffer allocation failed'))).toBe('out-of-memory');
    });

    it('recognizes JavaScriptCore', () => {
        expect(classifyThrow(new RangeError('Out of memory'))).toBe('out-of-memory');
    });

    it('recognizes SpiderMonkey, which throws a bare string', () => {
        expect(classifyThrow('out of memory')).toBe('out-of-memory');
    });

    it('leaves a RangeError that is a bug in the caller alone', () => {
        expect(classifyThrow(new RangeError('Invalid array length'))).toBe('internal');
        expect(classifyThrow(new RangeError('offset is out of bounds'))).toBe('internal');
    });

    it('needs a RangeError, not just the words', () => {
        // A TypeError that happens to say "out of memory" is still a TypeError:
        // something called the wrong thing.
        expect(classifyThrow(new TypeError('out of memory'))).toBe('internal');
        expect(classifyThrow(new Error('Array buffer allocation failed'))).toBe('internal');
    });
});

describe('classifyThrow: channel closed', () => {
    it('recognizes RTCDataChannel.send on a channel that is no longer open', () => {
        const err = new DOMException(
            "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
            'InvalidStateError'
        );
        expect(classifyThrow(err)).toBe('channel-closed');
    });

    it("recognizes simple-peer's send after destroy", () => {
        const err = Object.assign(new Error('cannot send after peer is destroyed'), { code: 'ERR_DESTROYED' });
        expect(classifyThrow(err)).toBe('channel-closed');
    });

    it('does not read every DOMException as a closed channel', () => {
        expect(classifyThrow(new DOMException('send queue is full', 'OperationError'))).toBe('internal');
    });
});

describe('classifyThrow: everything else', () => {
    it('is internal', () => {
        expect(classifyThrow(new TypeError("Cannot read properties of null (reading 'id')"))).toBe('internal');
        expect(classifyThrow(undefined)).toBe('internal');
        expect(classifyThrow(null)).toBe('internal');
        expect(classifyThrow(42)).toBe('internal');
        expect(classifyThrow('Cannot read properties of null')).toBe('internal');
        expect(classifyThrow({ message: 'out of memory' })).toBe('internal');
    });
});
