// The wailsdev request link verbs of lib/desktop.mjs (S1-REL-03a step 5):
// Make link, Read link, Accept after the 1 s guard, Decline, Keep waiting
// and Close link, against a scripted host view on a fake clock
// (tests/fake-request-dom.mjs). No browser, no app, no sleep.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/desktop-request.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ACCEPT_GUARD_MS,
    ACCEPT_WAIT_MS,
    PlaywrightDriver,
    REQUEST_LINK_RE,
    REQUEST_STRINGS,
    redactRequestLink,
} from './desktop.mjs';
import { FAKE_LINK, fakeRequestDom } from './tests/fake-request-dom.mjs';

const ROOM = FAKE_LINK.slice(FAKE_LINK.indexOf('#') + 1);

function driverOn(fake) {
    return new PlaywrightDriver(fake.page, null, {});
}

test('the request strings are the frozen copy, and the wait exceeds the guard', () => {
    assert.deepEqual(REQUEST_STRINGS, {
        choice: 'Request link, beta',
        lifetime24h: 'In 24 hours',
        lifetime7d: 'In 7 days',
        makeLink: 'Make link',
        copyLink: 'Copy link',
        closeLink: 'Close link',
        accept: 'Accept',
        decline: 'Decline',
        keepWaiting: 'Keep waiting',
        makeAnother: 'Make another link',
    });
    assert.equal(ACCEPT_GUARD_MS, 1000);
    assert.ok(ACCEPT_WAIT_MS >= 1200);
});

test('wailsdev AcceptRequest never clicks before 1200 ms from the prompt, on a fake clock', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await d.makeRequestLink({ now: f.now, nap: f.nap });
    f.requestAt(f.clock.t + 5_000);
    const r = await d.acceptRequest({ now: f.now, nap: f.nap });
    const accept = f.dom.clicks.filter((c) => c.name === 'Accept');
    assert.equal(accept.length, 1, 'one Accept click, none inside the guard');
    assert.deepEqual(f.dom.ignored, [], 'the frontend ignored no click');
    assert.ok(
        accept[0].t - f.dom.promptMountedAt >= ACCEPT_WAIT_MS,
        `clicked ${accept[0].t - f.dom.promptMountedAt} ms after the prompt mounted`
    );
    assert.ok(r.waitedMs >= ACCEPT_WAIT_MS);
    assert.equal(f.dom.state, 'receiving', 'the view left the prompt state');
});

test('wailsdev AcceptRequest waits for a prompt that is not there yet, and fails when none comes', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await d.makeRequestLink({ now: f.now, nap: f.nap });
    await assert.rejects(
        d.acceptRequest({ now: f.now, nap: f.nap, timeoutMs: 2_000 }),
        /"Accept" did not appear within 2000 ms/
    );
    assert.equal(f.dom.clicks.filter((c) => c.name === 'Accept').length, 0);
});

test('wailsdev Decline then Keep waiting: the order holds, and Keep waiting refuses before a decline', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await d.makeRequestLink({ now: f.now, nap: f.nap });
    await assert.rejects(
        d.keepWaiting({ now: f.now, nap: f.nap }),
        /Keep waiting is not showing; decline first/
    );
    f.requestAt(f.clock.t + 100);
    const r = await d.declineRequest({ now: f.now, nap: f.nap });
    assert.ok(r.waitedMs >= ACCEPT_WAIT_MS, 'Decline honors the same guard');
    assert.equal(f.dom.state, 'declined');
    await d.keepWaiting({ now: f.now, nap: f.nap });
    assert.equal(f.dom.state, 'waiting');
    assert.equal(f.dom.reopens, 1, 'Keep waiting reopened the link once');
    assert.deepEqual(
        f.dom.clicks.map((c) => c.name),
        ['Receive', 'Request link, beta', 'Make link', 'Decline', 'Keep waiting']
    );
    // A second visitor can then be answered on the same link.
    f.requestAt(f.clock.t + 10);
    await d.acceptRequest({ now: f.now, nap: f.nap });
    assert.equal(f.dom.state, 'receiving');
});

test('wailsdev MakeLink 7d picks the option, and MakeLink refuses any other lifetime', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await d.makeRequestLink({ lifetime: '7d', now: f.now, nap: f.nap });
    assert.deepEqual(f.dom.picked, ['In 7 days']);
    assert.equal(f.dom.state, 'waiting');
    await assert.rejects(
        driverOn(fakeRequestDom()).makeRequestLink({ lifetime: '1h' }),
        /MakeLink takes 24h or 7d/
    );
});

test('wailsdev ReadLink returns the host link, checks it against the screen, and its shown form hides the room', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await assert.rejects(d.readRequestLink(), /no request link to read \(state ready\)/);
    await d.makeRequestLink({ now: f.now, nap: f.nap });
    const r = await d.readRequestLink();
    assert.equal(r.link, FAKE_LINK);
    assert.ok(REQUEST_LINK_RE.test(r.link));
    assert.equal(r.onScreen, true);
    assert.ok(!r.shown.includes(ROOM), 'the shown form never carries the room');
    assert.equal(r.shown, 'http://localhost:3000/r/Xk3p9Q0aB1c#<room>');
    assert.equal(redactRequestLink('no-fragment'), 'no-fragment');

    const other = fakeRequestDom({
        screenText:
            'localhost:3000/r/Xk3p9Q0aB1c#00000000-0000-4000-8000-000000000000',
    });
    const d2 = driverOn(other);
    await d2.makeRequestLink({ now: other.now, nap: other.nap });
    await assert.rejects(
        d2.readRequestLink(),
        /the link on screen is not the link the host holds/
    );
});

test('wailsdev CloseLink ends the link and the ended view shows Make another link', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await d.makeRequestLink({ now: f.now, nap: f.nap });
    const r = await d.closeRequestLink({ now: f.now, nap: f.nap });
    assert.equal(r.closed, true);
    assert.equal(f.dom.state, 'closed');
    await assert.rejects(d.readRequestLink(), /no request link to read/);
});
