// The wailsdev request link verbs of lib/desktop.mjs (S1-REL-03a step 5):
// Make link, Read link, Accept after the 1 s guard, Decline, Keep waiting,
// Close link, and (WP-R2) the Save to folder, the done view, Dismiss, Cancel
// drop and the address switch the TA-13 blip needs, against a scripted host
// view on a fake clock (tests/fake-request-dom.mjs). No browser, no app, no
// sleep.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/desktop-request.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
    ACCEPT_GUARD_MS,
    ACCEPT_WAIT_MS,
    PlaywrightDriver,
    REQUEST_LINK_RE,
    REQUEST_STRINGS,
    RE,
    redactRequestLink,
    safeCode,
    samePath,
} from './desktop.mjs';
import { FAKE_LINK, SAVE_TO, VERIFIED_LINE, fakeRequestDom } from './tests/fake-request-dom.mjs';

const ROOM = FAKE_LINK.slice(FAKE_LINK.indexOf('#') + 1);
const DIR = path.join(tmpdir(), 'lta-request-out');

function driverOn(fake) {
    return new PlaywrightDriver(fake.page, null, {});
}

const make = (d, f, extra = {}) =>
    d.makeRequestLink({ saveDir: DIR, now: f.now, nap: f.nap, ...extra });

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
        betaSwitch: 'Request links',
        saveToPlaceholder: SAVE_TO,
        dismiss: 'Dismiss',
        cancelDrop: 'Cancel drop',
        verifiedLine: VERIFIED_LINE,
    });
    assert.equal(ACCEPT_GUARD_MS, 1000);
    assert.ok(ACCEPT_WAIT_MS >= 1200);
    assert.ok(RE.requestLinksRow.test(REQUEST_STRINGS.betaSwitch));
    assert.ok(RE.requestDone.test('RECEIVED 1 FILE, 64.0 MB'));
    assert.ok(RE.requestDone.test('RECEIVED 12 FILES, 38.0 GB'));
    assert.ok(!RE.requestDone.test('RECEIVING 1 OF 1'));
});

test('wailsdev AcceptRequest never clicks before 1200 ms from the prompt, on a fake clock', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f);
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
    await make(d, f);
    await assert.rejects(
        d.acceptRequest({ now: f.now, nap: f.nap, timeoutMs: 2_000 }),
        /"Accept" did not appear within 2000 ms/
    );
    assert.equal(f.dom.clicks.filter((c) => c.name === 'Accept').length, 0);
});

test('wailsdev Decline then Keep waiting: the order holds, and Keep waiting refuses before a decline', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f);
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
    await make(d, f, { lifetime: '7d' });
    assert.deepEqual(f.dom.picked, ['In 7 days']);
    assert.equal(f.dom.state, 'waiting');
    await assert.rejects(
        driverOn(fakeRequestDom()).makeRequestLink({ lifetime: '1h', saveDir: DIR }),
        /MakeLink takes 24h or 7d/
    );
});

test('wailsdev MakeLink types the run folder into Save to, and the host holds the link with it', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    const r = await make(d, f);
    assert.equal(r.saveDir, DIR);
    assert.equal(f.dom.linkSaveDir, DIR, 'the link carries the run folder');
    assert.ok(samePath(DIR.toUpperCase(), `${DIR}\\`), 'paths compare without case or a trailing slash');
    assert.ok(!samePath(DIR, ''), 'an empty folder is never the same folder');
});

test('wailsdev MakeLink refuses without the run folder, and a Save to field that does not take is SKIP desktop-savedir', async () => {
    // No folder at all: the verb refuses before any click, because an empty
    // Save to field is the owner's own Downloads\Floe requests.
    for (const saveDir of [undefined, '', 'relative\\dir']) {
        const f = fakeRequestDom();
        await assert.rejects(
            driverOn(f).makeRequestLink({ saveDir, now: f.now, nap: f.nap }),
            (e) => /needs the run's own save folder/.test(e.message) && e.reason === 'request-savedir',
            String(saveDir)
        );
        assert.deepEqual(f.dom.clicks, [], 'nothing was clicked');
    }
    const stuck = fakeRequestDom({ saveDirStuck: true });
    await assert.rejects(
        make(driverOn(stuck), stuck),
        (e) => e.verdict === 'SKIP' && e.reason === 'desktop-savedir'
    );
    assert.ok(
        !stuck.dom.clicks.some((c) => c.name === 'Make link'),
        'no link is made when the folder did not take'
    );
    assert.equal(stuck.dom.state, 'ready');
});

test('wailsdev MakeLink fails at once when the host answers with an error code', async () => {
    const f = fakeRequestDom({ makeError: 'disabled' });
    const t0 = f.now();
    await assert.rejects(make(driverOn(f), f), (e) =>
        /request-flow: Make link ended in error \(disabled\)/.test(e.message) &&
        e.signatureKey === 'request-flow'
    );
    assert.ok(f.now() - t0 < 30_000, 'well before the 30 s wait');
    assert.equal(safeCode('no-relay'), 'no-relay');
    assert.equal(safeCode('<script>'), '?', 'anything that is not a lane key is never quoted');
});

test('wailsdev ReadLink returns the host link, checks it against the screen, and its shown form hides the room', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await assert.rejects(d.readRequestLink(), /no request link to read \(state ready\)/);
    await make(d, f);
    const r = await d.readRequestLink();
    assert.equal(r.link, FAKE_LINK);
    assert.ok(REQUEST_LINK_RE.test(r.link));
    assert.equal(r.onScreen, true, 'the link block input holds it');
    assert.ok(!r.shown.includes(ROOM), 'the shown form never carries the room');
    assert.equal(r.shown, 'http://localhost:3000/r/Xk3p9Q0aB1c#<room>');
    assert.equal(redactRequestLink('no-fragment'), 'no-fragment');

    const other = fakeRequestDom({
        screenText:
            'localhost:3000/r/Xk3p9Q0aB1c#00000000-0000-4000-8000-000000000000',
    });
    const d2 = driverOn(other);
    await make(d2, other);
    await assert.rejects(
        d2.readRequestLink(),
        /the link on screen is not the link the host holds/
    );
});

test('wailsdev CloseLink ends the link and the ended view shows Make another link', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f);
    const r = await d.closeRequestLink({ now: f.now, nap: f.nap });
    assert.equal(r.closed, true);
    assert.equal(f.dom.state, 'closed');
    assert.equal((await d.requestSnapshot()).state, 'ended');
    await assert.rejects(d.readRequestLink(), /no request link to read/);
    // The next MakeLink starts from that ended view: Make another link
    // first, then the form.
    await make(d, f);
    assert.equal(f.dom.state, 'waiting');
    assert.deepEqual(
        f.dom.clicks.map((c) => c.name).slice(-4),
        ['Receive', 'Request link, beta', 'Make another link', 'Make link']
    );
});

test('wailsdev done view: the heading counts the files, the SHA sentence shows only when every file verified, and Dismiss puts it away', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f);
    f.dom.state = 'done';
    f.dom.result = { files: 1, saved: 1, bytes: 64 * 1024 * 1024, verified: 1, renamed: 0, folder: DIR, names: ['a.bin'] };
    assert.deepEqual(await d.readRequestResult(), {
        heading: 'RECEIVED 1 FILE, 64.0 MB',
        files: 1,
        verifiedLine: true,
    });
    f.dom.result = { ...f.dom.result, verified: 0 };
    assert.equal((await d.readRequestResult()).verifiedLine, false);
    await d.dismissRequestResult({ now: f.now, nap: f.nap });
    assert.equal(f.dom.state, 'ready', 'the lane is back to Ready, so the Beta switch unlocks');

    const g = fakeRequestDom();
    const e = driverOn(g);
    await make(e, g);
    g.requestAt(g.clock.t + 1);
    await e.acceptRequest({ now: g.now, nap: g.nap });
    await e.cancelRequestDrop({ now: g.now, nap: g.nap });
    assert.equal(g.dom.state, 'stopped');
});

// The first live TA-17 run (2026-09-24): another leg's page staged its
// files, the dev server rebroadcast files:open, and the host page moved to
// Send. Close link was then not on screen, the release timed out, and the
// link stayed open into the next cell. Every request verb now brings the
// page back to Receive > REQUEST LINK before it clicks.
test('wailsdev request verbs bring a page that moved to Send back to Receive > REQUEST LINK before they click', async () => {
    const moved = (f) => {
        f.dom.addFiles(['C:\\fx\\a.bin']);
        assert.equal(f.dom.mode, 'send', 'the page left Receive');
    };
    const tail = (f, n) => f.dom.clicks.map((c) => c.name).slice(-n);

    // Close link, the release's verb.
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f);
    moved(f);
    await d.closeRequestLink({ now: f.now, nap: f.nap });
    assert.equal(f.dom.state, 'closed');
    assert.deepEqual(tail(f, 3), ['Receive', 'Request link, beta', 'Close link']);

    // Decline, Keep waiting, Accept and Cancel drop.
    const g = fakeRequestDom();
    const e = driverOn(g);
    await make(e, g);
    g.requestAt(g.clock.t + 10);
    moved(g);
    await e.declineRequest({ now: g.now, nap: g.nap });
    assert.equal(g.dom.state, 'declined');
    moved(g);
    await e.keepWaiting({ now: g.now, nap: g.nap });
    assert.equal(g.dom.state, 'waiting');
    g.requestAt(g.clock.t + 10);
    moved(g);
    await e.acceptRequest({ now: g.now, nap: g.nap });
    assert.equal(g.dom.state, 'receiving');
    moved(g);
    await e.cancelRequestDrop({ now: g.now, nap: g.nap });
    assert.equal(g.dom.state, 'stopped');

    // The done view: its heading, then Dismiss.
    const h = fakeRequestDom();
    const k = driverOn(h);
    await make(k, h);
    h.dom.state = 'done';
    h.dom.result = { files: 1, saved: 1, bytes: 1024 * 1024, verified: 1, renamed: 0, folder: DIR, names: ['a.bin'] };
    moved(h);
    assert.equal((await k.readRequestResult()).files, 1);
    moved(h);
    await k.dismissRequestResult({ now: h.now, nap: h.nap });
    assert.equal(h.dom.state, 'ready');

    // Already on the view: no extra click.
    const q = fakeRequestDom();
    const p = driverOn(q);
    await make(p, q);
    await p.closeRequestLink({ now: q.now, nap: q.nap });
    assert.deepEqual(
        q.dom.clicks.map((c) => c.name),
        ['Receive', 'Request link, beta', 'Make link', 'Close link']
    );
});

test('wailsdev setAddresses points the host at another server and web, and keeps Hide my IP and reportStats', async () => {
    const f = fakeRequestDom({ settings: { hideIP: true } });
    const d = driverOn(f);
    const after = await d.setAddresses('http://127.0.0.1:45999', 'http://localhost:3000');
    assert.equal(after.server, 'http://127.0.0.1:45999');
    assert.equal(after.web, 'http://localhost:3000');
    assert.deepEqual(f.dom.setSettingsCalls, [
        {
            server: 'http://127.0.0.1:45999',
            web: 'http://localhost:3000',
            hideIP: true,
            reportStats: false,
        },
    ]);
    const bare = fakeRequestDom({ withBinding: false });
    assert.equal(await driverOn(bare).setAddresses('a', 'b'), null);
});
