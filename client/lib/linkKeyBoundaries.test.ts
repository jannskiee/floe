import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What the main page does with a link key, read as TEXT: vitest runs in node and
// nothing here can mount P2PTransfer. e2e/link-key.spec.ts drives the real page; this
// keeps the rules a running page cannot show, because the failure they guard against
// is silent. A key that reaches a report, a frame that leads the proof, a listener
// that attaches after the first frame: each works until the day it matters.

const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');

/** The argument text of every call to `name(` in `src`, balanced on parens. */
function callArgs(src: string, name: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(name + '(', from);
        if (at < 0) return out;
        let depth = 0;
        let i = at + name.length;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
        }
        out.push(src.slice(at + name.length + 1, i));
        from = i;
    }
}

/** From `head` to the brace that closes the block it opens. */
function block(head: string): string {
    const at = page.indexOf(head);
    expect(at, head).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = at + head.length - 1; i < page.length; i++) {
        if (page[i] === '{') depth++;
        else if (page[i] === '}' && --depth === 0) return page.slice(at, i + 1);
    }
    throw new Error(`unbalanced block: ${head}`);
}

const between = (from: string, to: string, src = page) => {
    const start = src.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = src.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return src.slice(start, end);
};

// Comments may name what they guard against; the rules are about code.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pageCode = code(page);

// The rendered half of the component.
const jsx = pageCode.slice(pageCode.indexOf('if (isSender === null) {'));
const handleCreateLink = block('const handleCreateLink = () => {');
const joinRoomAsReceiver = block('const joinRoomAsReceiver = (roomId: string) => {');
const sendAllFiles = block('const sendAllFiles = async (');
const tellAndClose = block('const tellAndClose = async (');

describe('the whole link in another component', () => {
    it('InAppBrowserGuard keeps it only where its overlay draws it', () => {
        const guard = readFileSync(fileURLToPath(new URL('../components/InAppBrowserGuard.tsx', import.meta.url)), 'utf8');
        expect(guard).toContain("currentUrl: app ? window.location.href : ''");
        expect(guard.match(/location\.href/g)).toHaveLength(1);
    });
});

describe('the key on a sending page', () => {
    it('is made once, behind its lever, as a const of handleCreateLink', () => {
        expect(pageCode.match(/makeLinkKey\(/g)).toHaveLength(1);
        expect(handleCreateLink).toContain('const key = MAKE_LINK_KEYS ? makeLinkKey() : null;');
        expect(handleCreateLink).toContain('buildShareLink(window.location.origin, newRoomId, nonce, key)');
    });

    // The receiver's key has the same count, below. Its const, the link, the session.
    it('has exactly three readers in handleCreateLink', () => {
        expect(code(handleCreateLink).match(/\bkey\b/g)).toHaveLength(3);
    });

    it('reaches the session of each connection through the closure, as a value it was given', () => {
        const connected = handleCreateLink.slice(handleCreateLink.indexOf('onUserConnected(async'));
        expect(connected).toMatch(/createKeySession\(\{[\s\S]*?\bkey,/);
    });
});

describe('the key on a receiving page', () => {
    it('is read from the fragment at mount, into one ref, once', () => {
        expect(pageCode.match(/joinedKeyRef\.current = /g)).toHaveLength(1);
        const mount = between('let cancelled = false;', 'return () => {', pageCode);
        expect(mount).toContain('joinedKeyRef.current = link.key;');
        expect(mount).toContain('readShareFragment(window.location.hash, window.location.search)');
    });

    it('is what every join hands the session, so a re-join keeps the check', () => {
        expect(joinRoomAsReceiver).toMatch(/createKeySession\(\{[\s\S]*?key: joinedKeyRef\.current,/);
    });

    it('is compared with the address and goes nowhere else', () => {
        const reads = pageCode.match(/joinedKeyRef\.current/g) ?? [];
        // The write at mount, the session, the hash comparison.
        expect(reads).toHaveLength(3);
        expect(pageCode).toContain('key: joinedKeyRef.current,');
    });
});

describe('the key never reaches', () => {
    // The names it goes by in this file. `key` is matched as a word: a React key on
    // an element would be a new reader, and has to be looked at.
    const names = /\b(?:key|joinedKeyRef|linkKey|LinkKey|keyText)\b/;

    it('state, a prop or the page it renders', () => {
        expect(pageCode).not.toMatch(/useState<[^>]*LinkKey/);
        expect(pageCode).not.toMatch(/\bset(?:Link)?Key\b/);
        expect(jsx).not.toMatch(names);
        expect(jsx).not.toMatch(/\bks\b/);
    });

    it('text: this page cannot turn one into its characters or its bytes', () => {
        expect(pageCode).not.toContain('linkKeyText');
        expect(pageCode).not.toContain('linkKeyBytes');
    });

    for (const callee of [
        'Sentry.addBreadcrumb',
        'Sentry.captureMessage',
        'Sentry.captureException',
        'scope.setContext',
        'scope.setTags',
        'scope.setTag',
        'track',
        'reportBytes',
        'console.log',
        'console.info',
        'console.warn',
        'console.error',
        'console.debug',
        'localStorage.setItem',
        'sessionStorage.setItem',
        'sendSignal',
        'joinRoom',
        'setError',
        'setStatus',
        'setGeneratedLink',
    ]) {
        it(`${callee}(`, () => {
            for (const args of callArgs(pageCode, callee)) {
                expect(args, args).not.toMatch(names);
            }
        });
    }

    it('a report by any other route: the one report is an enum, from the session', () => {
        expect(pageCode.match(/reportLinkKey\(/g)).toHaveLength(2);
        expect(pageCode).not.toContain('Link key check failed');
        for (const args of callArgs(pageCode, 'reportLinkKey')) expect(args).toBe('report');
    });
});

describe('a session is the first thing on every peer', () => {
    // simple-peer pushes frames from the moment the channel opens, so what listens
    // first decides what can be missed, and the session's 'connect' listener has to
    // run ahead of the page's for its kc to lead.
    const builders = pageCode.split('new SimplePeer({').slice(1);

    it('there are two peers, and each has one', () => {
        expect(builders).toHaveLength(2);
        expect(pageCode.match(/createKeySession\(\{/g)).toHaveLength(2);
    });

    for (const [i, side] of [
        [0, 'receiver'],
        [1, 'sender'],
    ] as const) {
        it(`the ${side}: right after new SimplePeer, ahead of any listener`, () => {
            const after = builders[i];
            const session = after.indexOf('createKeySession({');
            const listener = after.search(/\bpeer\.on\(/);
            expect(session).toBeGreaterThan(-1);
            expect(listener).toBeGreaterThan(session);
            expect(after).toContain(`fileRole: '${side}',`);
            expect(after).toContain(`linkKeyMode('share-${side}')`);
            expect(after).toContain(`reportRole: '${side}',`);
        });
    }
});

describe('nothing leaves a keyed peer around its session', () => {
    it('no raw send and no raw data listener anywhere in the page', () => {
        expect(pageCode).not.toMatch(/\bpeer\.send\(/);
        expect(pageCode).not.toMatch(/\bpeer\.on\('data'/);
        expect(pageCode).not.toMatch(/\bpeer\.off\('data'/);
    });

    it('the relay-off and over-limit aborts send through the session', () => {
        for (const head of ["if (verdict.action === 'block-relay-disabled') {", "if (verdict.action === 'block-over-limit') {"]) {
            const branch = code(block(head));
            expect(branch, head).toContain('(d) => ks.send(d)');
        }
    });

    it('tellAndClose finds the session of the peer it is given', () => {
        expect(code(tellAndClose)).toContain('(keySessionOf(peer) ?? peer).send(d)');
    });

    it('the send takes send and onData from the session and hands it the check', () => {
        const body = code(sendAllFiles);
        expect(body).toContain('send: (d) => ks.send(d),');
        expect(body).toContain('onData: (handler) => ks.onData(handler),');
        expect(body).toContain('{ keyCheck: ks }');
    });

    it('the receiver sends and hears through the session, wired at construction', () => {
        const body = code(joinRoomAsReceiver);
        expect(body).toContain('send: (d) => ks.send(d),');
        expect(body).toContain('{ keyCheck: ks }');
        expect(body).toContain('ks.onData(rx.handleMessage);');
        // In the same turn as the peer: nothing awaits between them.
        const wiring = body.slice(body.indexOf('new SimplePeer({'), body.indexOf('ks.onData(rx.handleMessage);'));
        expect(wiring).not.toMatch(/^\s*await\b/m);
    });
});

// The session replays what came early inside the subscribe. PR-3 met this as a
// ReferenceError on every tampered link: a handler read a const of the caller
// declared below the subscribe, in its temporal dead zone.
describe('what a replayed frame can reach is already declared', () => {
    it('on the send: the holder its callbacks write, ahead of the call that subscribes', () => {
        const body = code(sendAllFiles);
        expect(body.indexOf('const failed:')).toBeGreaterThan(-1);
        expect(body.indexOf('const failed:')).toBeLessThan(body.indexOf('await sendFilesEngine('));
    });

    it('on the receive: the engine, ahead of its subscribe', () => {
        const body = code(joinRoomAsReceiver);
        expect(body.indexOf('const rx = createReceiver(')).toBeGreaterThan(-1);
        expect(body.indexOf('const rx = createReceiver(')).toBeLessThan(body.indexOf('ks.onData(rx.handleMessage);'));
    });

    it('on a connection: the record the report writes, ahead of the session that reports', () => {
        const after = pageCode.split('new SimplePeer({')[2];
        expect(after.indexOf('const keyState')).toBeGreaterThan(-1);
        expect(after.indexOf('const keyState')).toBeLessThan(after.indexOf('const ks = createKeySession({'));
    });
});

describe('the order of a send', () => {
    it('the route probe awaits the proof before it does anything else', () => {
        const probe = code(between('iceProbeRef.current = setTimeout(async () => {', '}, relayProbeDelayMs('));
        const first = probe.slice(probe.indexOf('{') + 1).trim();
        expect(first.startsWith('await ks.ownKcOut;')).toBe(true);
    });

    it('a sender page closes a connection whose check ended it, once the send has returned', () => {
        const after = code(sendAllFiles.slice(sendAllFiles.indexOf('await sendFilesEngine(')));
        const end = after.slice(after.lastIndexOf('if (failed.key) {'));
        expect(end).toContain('closedByUsRef.current = peer;');
        expect(end.indexOf('closedByUsRef.current = peer;')).toBeLessThan(end.indexOf('peer.destroy();'));
    });
});

describe('every signal goes through the gate', () => {
    const onSignal = code(between('onSignal: (data) => {', 'onPeerDisconnected: () => {'));

    it('through the WeakMap, after the skip of a late answer and before simple-peer', () => {
        const skip = onSignal.indexOf("sig.type === 'answer'");
        const gate = onSignal.indexOf('keySessionOf(peer)');
        const admit = onSignal.indexOf('admitSignal(sig)');
        const apply = onSignal.indexOf('peer.signal(sig)');
        expect(skip).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(skip);
        expect(admit).toBeGreaterThan(gate);
        expect(apply).toBeGreaterThan(admit);
    });

    it('a dropped signal says so in fixed words and returns', () => {
        const drop = onSignal.slice(onSignal.indexOf('admitSignal(sig)'), onSignal.indexOf('peer.signal(sig)'));
        expect(drop).toContain("message: 'Dropped a signal a keyed link does not allow'");
        expect(drop).toContain('return;');
    });
});

describe('reading the link', () => {
    it('the page reads it through readShareFragment, every time', () => {
        expect(pageCode).not.toContain('getRoomFromUrl');
        expect(pageCode.match(/readShareFragment\(window\.location\.hash, window\.location\.search\)/g)).toHaveLength(3);
    });

    it('an incomplete link is neither a sending page nor a join', () => {
        expect(pageCode).toContain('setIsSender(!link.room && !link.incomplete);');
        const mount = between('let cancelled = false;', 'return () => {', pageCode);
        const refusal = mount.indexOf('link.incomplete ||');
        expect(refusal).toBeGreaterThan(-1);
        expect(refusal).toBeLessThan(mount.indexOf('setError(LINK_INVALID);'));
        expect(mount.indexOf('setError(LINK_INVALID);')).toBeLessThan(mount.indexOf('joinRoomAsReceiver('));
    });

    it('a fragment-only navigation compares room and key, through one pure function', () => {
        const effect = between("const linkChanged = () =>", "window.addEventListener('hashchange'", pageCode);
        expect(effect).toContain('shareLinkChanged(');
        expect(effect).toContain('room: joinedRoomRef.current');
        expect(effect).toContain('key: joinedKeyRef.current');
    });
});

describe('what a failed check puts on the page', () => {
    it('fixed lines chosen by enum, written nowhere in this file', () => {
        expect(pageCode).not.toContain("couldn't confirm");
        expect(pageCode).not.toContain("can't check");
        expect(pageCode).toContain('receiverKeyLine(');
        expect(pageCode).toContain('senderKeyLine(');
    });

    it('never a banner of a sent reason on a keyed stop: the receiver takes its own callback', () => {
        const body = code(joinRoomAsReceiver);
        const failed = body.slice(body.indexOf('onKeyCheckFailed:'));
        expect(failed.slice(0, failed.indexOf('},'))).toContain('wireReasonRef.current = true;');
    });

    it('the transfer-failed label goes with it, on both sides', () => {
        expect(pageCode.match(/reason: 'unverified'/g)?.length).toBeGreaterThanOrEqual(2);
        expect(code(sendAllFiles)).toContain("stop.code === 'unverified' ? 'unverified' : 'peer-reason'");
    });

    // The engine reports a closed channel in the ack wait's words on the cutover's
    // enforce wait too, and leaves a teardown of the page's own to the page (sender.ts,
    // waitForKeyProof). A failure the close handler already told outranks those words.
    it('the send engine cannot talk over a teardown or a failure already told', () => {
        const onError = between('onError: (msg) => {', 'setError(peerBanner(msg, ');
        expect(onError).toContain('if (peerRef.current !== peer) return;');
        expect(onError).toContain('if (closedByUsRef.current === peer || keyState.told) return;');
    });

    // simple-peer raises 'error' and then 'close' when the other side goes. A proof
    // that failed ahead of that has to be what the page says, at progress 0 too,
    // where the close handler otherwise says nothing and the error handler blames
    // the connection.
    it('the connection going first does not swallow it: both peer handlers ask', () => {
        const after = pageCode.split('new SimplePeer({')[2];
        const close = after.slice(after.indexOf("peer.on('close', () => {"));
        expect(close.indexOf('endedOnKeyCheck()')).toBeGreaterThan(-1);
        expect(close.indexOf('endedOnKeyCheck()')).toBeLessThan(close.indexOf('senderCloseInterrupted('));
        const error = after.slice(after.indexOf("peer.on('error', (err) => {"));
        expect(error.indexOf('if (wireReasonRef.current) return;')).toBeLessThan(error.indexOf('endedOnKeyCheck()'));
        expect(error.indexOf('endedOnKeyCheck()')).toBeLessThan(error.indexOf('classifyPeerError('));
    });
});
