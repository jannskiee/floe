import {describe, expect, it} from 'vitest';
import {requestLinkKind} from './requestLink';

// A request link or a drop link pasted into Receive > CODE (S1-DSK-07). String
// inputs only: nothing here opens or fetches anything, and the floe.one form
// appears only as a string (L-10).
describe('requestLinkKind', () => {
    const room = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

    it('requestLinkKind recognizes /r/, /d/ and /drop including a self-hosted base path', () => {
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        expect(requestLinkKind(`https://www.floe.one/r/Xk3p9Q0aB1c/#${room}`)).toBe('request');
        expect(requestLinkKind(`http://localhost:3000/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        expect(requestLinkKind(`https://files.example.com/floe/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        // Surrounding whitespace from a paste, and no fragment at all.
        expect(requestLinkKind(`  https://floe.one/r/Xk3p9Q0aB1c  `)).toBe('request');
        expect(requestLinkKind('https://floe.one/d/aBcD1234#k=s3cr3t')).toBe('drop');
        expect(requestLinkKind('https://floe.one/drop/aBcD1234')).toBe('drop');
        expect(requestLinkKind('https://files.example.com/floe/drop/aBcD1234/')).toBe('drop');
    });

    it('requestLinkKind rejects a 10-character id, a #room= link and non-http schemes', () => {
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1#${room}`)).toBeNull(); // 10 characters
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1cc#${room}`)).toBeNull(); // 12 characters
        expect(requestLinkKind(`https://floe.one/?s=abc#room=${room}`)).toBeNull();
        expect(requestLinkKind(`https://floe.one/#room=${room}`)).toBeNull();
        expect(requestLinkKind('file:///C:/r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('javascript:alert(1)//r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('floe://x/r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('amber-otter-cloud')).toBeNull();
        expect(requestLinkKind('')).toBeNull();
        // The id in a query or the fragment is not a path.
        expect(requestLinkKind(`https://floe.one/?r=Xk3p9Q0aB1c#/r/Xk3p9Q0aB1c`)).toBeNull();
        expect(requestLinkKind('https://floe.one/rr/Xk3p9Q0aB1c')).toBeNull();
    });
});
