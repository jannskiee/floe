// The wailsdev request link verbs of lib/desktop.mjs (S1-REL-03a step 5):
// Make link, Read link, Accept after the 1 s guard, Decline, Keep waiting,
// Close link, and (WP-R2) the Save to folder, the done view, Make another link, Cancel
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
import { FAKE_LINK, HIDE_IP_NOTE, LIFETIME_OPTIONS, SAVE_TO, VERIFIED_LINE, fakeRequestDom } from './tests/fake-request-dom.mjs';

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
        // D-173: the six Link ends keys (requestLifetime in Go), in list order.
        lifetimes: {
            '30m': 'In 30 minutes',
            '1h': 'In 1 hour',
            '8h': 'In 8 hours',
            '24h': 'In 24 hours',
            '3d': 'In 3 days',
            '7d': 'In 7 days',
        },
        makeLink: 'Make link',
        copyLink: 'Copy link',
        closeLink: 'Close link',
        accept: 'Accept',
        decline: 'Decline',
        keepWaiting: 'Keep waiting',
        makeAnother: 'Make another link',
        saveToPlaceholder: 'Downloads\\Floe',
        cancelDrop: 'Cancel drop',
        verifiedLine: 'SHA-256 matched',
        autoAcceptSwitch: 'Save files without asking',
        autoAcceptPill: 'Auto-accept',
    });
    // The fake page draws the same bytes, so a fake-driven test proves the
    // real strings, not the fake against itself.
    assert.equal(SAVE_TO, REQUEST_STRINGS.saveToPlaceholder);
    assert.equal(VERIFIED_LINE, REQUEST_STRINGS.verifiedLine);
    assert.deepEqual(LIFETIME_OPTIONS, Object.values(REQUEST_STRINGS.lifetimes));
    assert.equal(REQUEST_STRINGS.lifetimes['24h'], REQUEST_STRINGS.lifetime24h);
    assert.equal(REQUEST_STRINGS.lifetimes['7d'], REQUEST_STRINGS.lifetime7d);
    assert.ok(Object.isFrozen(REQUEST_STRINGS.lifetimes));
    assert.equal(HIDE_IP_NOTE, 'Hide my IP limits transfers to 2 GB');
    assert.equal(ACCEPT_GUARD_MS, 1000);
    assert.ok(ACCEPT_WAIT_MS >= 1200);
    // H7 (D-160): no Settings > Beta > Request links row to key on.
    assert.equal('requestLinksRow' in RE, false);
    assert.ok(RE.requestDone.test('RECEIVED 1 FILE, 64.0 MB'));
    assert.ok(RE.requestDone.test('RECEIVED 12 FILES, 38.0 GB'));
    assert.ok(!RE.requestDone.test('RECEIVING 1 OF 1'));
});

// H7 (D-160): the tab is always there, so a request host waits for it
// instead of toggling a switch. A page on Send gets one RECEIVE click.
test('wailsdev awaitRequestTab: from Send it clicks RECEIVE once and sees the choice; on Receive it clicks nothing; a build without the tab reports not shown', async () => {
    const a = fakeRequestDom();
    a.dom.mode = 'send';
    const r = await driverOn(a).awaitRequestTab({ now: a.now, nap: a.nap });
    assert.equal(r.shown, true);
    assert.equal(r.via, 'playwright');
    assert.deepEqual(a.dom.clicks.map((c) => c.name), ['Receive']);

    const b = fakeRequestDom();
    assert.equal((await driverOn(b).awaitRequestTab({ now: b.now, nap: b.nap })).shown, true);
    assert.deepEqual(b.dom.clicks, [], 'already on Receive: no click');

    const c = fakeRequestDom({ hideTab: true });
    const t0 = c.now();
    const none = await driverOn(c).awaitRequestTab({ now: c.now, nap: c.nap, timeoutMs: 2_000 });
    assert.equal(none.shown, false);
    assert.ok(none.waitedMs >= 2_000 && c.now() - t0 < 5_000, 'it waited out its own budget and no longer');
    assert.equal(c.dom.settingsOpen, false, 'Settings was never opened');
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

test('wailsdev MakeLink picks a non-default lifetime by its label on the select, leaves 24h alone, and refuses any other key', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    await make(d, f, { lifetime: '1h' });
    assert.deepEqual(f.dom.picked, ['In 1 hour']);
    assert.equal(f.dom.madeLifetime, '1h');
    assert.equal(f.dom.state, 'waiting');
    // Every key the host takes, each by its own label; the default is the
    // select's own value, so 24h picks nothing (every cell makes 24h).
    for (const [key, label] of Object.entries(REQUEST_STRINGS.lifetimes)) {
        const g = fakeRequestDom();
        const r = await make(driverOn(g), g, { lifetime: key });
        assert.equal(r.lifetime, key);
        assert.deepEqual(g.dom.picked, key === '24h' ? [] : [label], key);
        assert.equal(g.dom.madeLifetime, key, key);
    }
    // A page that draws no select gets the label clicked instead.
    const plain = fakeRequestDom({ lifetimeSelect: false });
    await make(driverOn(plain), plain, { lifetime: '7d' });
    assert.deepEqual(plain.dom.picked, ['In 7 days']);
    for (const lifetime of ['15m', '1d', '24H', ' 24h', '', 'In 1 hour', 24]) {
        const g = fakeRequestDom();
        await assert.rejects(
            driverOn(g).makeRequestLink({ lifetime, saveDir: DIR }),
            /MakeLink takes 30m, 1h, 8h, 24h, 3d or 7d/,
            String(lifetime)
        );
        assert.deepEqual(g.dom.clicks, [], 'nothing was clicked');
    }
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
    // Save to field is the owner's own Downloads\Floe.
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

test('the pill reads one word with Hide my IP off and on: the screen-reader twin is the word\'s sibling (D-135)', async () => {
    for (const hideIP of [false, true]) {
        const f = fakeRequestDom({ settings: { hideIP } });
        const d = driverOn(f);
        assert.deepEqual(await d.readText(RE.pill), ['Ready'], `hideIP ${hideIP}`);
        await make(d, f);
        assert.deepEqual(await d.readText(RE.pill), ['Ready'], `hideIP ${hideIP}, a link waits`);
        // The twin's sentence is never read as a status word.
        assert.deepEqual(await d.readText(/Hide my IP limits/), hideIP ? [`, ${HIDE_IP_NOTE}`] : []);
        f.dom.state = 'receiving';
        f.dom.route = 'relay';
        assert.deepEqual(await d.readText(RE.pill), ['Relay'], `hideIP ${hideIP}, a drop moves`);
        assert.deepEqual(await d.readText(/Hide my IP limits/), [], 'no twin while a drop moves');
    }
});

test('wailsdev done view: the heading counts the files, the SHA sentence shows only when every file verified, and Make another link puts it away', async () => {
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
    assert.equal(f.dom.state, 'ready', 'the lane is back to Ready');

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

    // The done view: its heading, then Make another link.
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

// TA-10a (D-173): the Make link form's Auto-accept switch, found by its
// label. Only TA-10a turns it on; every other cell leaves the form's own off
// alone, and the host must hold the link with the choice the cell asked for.
test('wailsdev MakeLink autoAccept turns the switch on by its label, and the host holds an automatic link', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    const r = await make(d, f, { autoAccept: true });
    assert.equal(r.autoAccept, true);
    assert.deepEqual(f.dom.switched, ['Save files without asking']);
    assert.equal((await d.requestSnapshot()).autoAccept, true);
    // The chip reads AUTO-ACCEPT while the link waits: RE.pillAuto keeps it,
    // RE.pill (every other cell's reader) never matches it.
    assert.deepEqual(await d.readText(RE.pillAuto), ['Auto-accept']);
    assert.deepEqual(await d.readText(RE.pill), []);
    assert.equal(RE.pillAuto.test('AUTO-ACCEPT'), true, 'UIA reports the rendered case');
    assert.equal(RE.pill.test('AUTO-ACCEPT'), false);
    // An automatic link takes the visitor's drop with no prompt at all.
    f.requestAt(f.clock.t + 10);
    await f.nap(20);
    f.tick();
    assert.equal(f.dom.state, 'receiving');
    assert.equal(f.dom.promptGen, 0, 'no prompt was ever mounted');
    assert.deepEqual(await d.readText(RE.pillAuto), ['Active'], 'a moving word wins');
});

test('wailsdev MakeLink leaves the switch off for every other cell, and the next form starts off again', async () => {
    const f = fakeRequestDom();
    const d = driverOn(f);
    const r = await make(d, f);
    assert.equal(r.autoAccept, false);
    assert.deepEqual(f.dom.switched, [], 'the switch was never touched');
    assert.equal((await d.requestSnapshot()).autoAccept, false);
    assert.deepEqual(await d.readText(RE.pill), ['Ready']);
    // After an automatic link, the next form is off (D-173: never remembered).
    const g = fakeRequestDom();
    const e = driverOn(g);
    await make(e, g, { autoAccept: true });
    await e.closeRequestLink({ now: g.now, nap: g.nap });
    await make(e, g);
    assert.equal((await e.requestSnapshot()).autoAccept, false);
});

test('wailsdev MakeLink autoAccept on a build without the switch is SKIP request-no-auto-switch, and no link is made', async () => {
    const f = fakeRequestDom({ autoSwitch: false });
    await assert.rejects(
        make(driverOn(f), f, { autoAccept: true }),
        (e) => e.verdict === 'SKIP' && e.reason === 'request-no-auto-switch' && /has no "Save files without asking" switch/.test(e.message)
    );
    assert.ok(!f.dom.clicks.some((c) => c.name === 'Make link'), 'no link was made');
    // The same build still makes a link with the switch off for every other cell.
    await make(driverOn(f), f);
    assert.equal(f.dom.state, 'waiting');
});

test('wailsdev MakeLink refuses an autoAccept that is not a boolean, a switch that will not turn on, and a host that holds the other choice', async () => {
    await assert.rejects(
        driverOn(fakeRequestDom()).makeRequestLink({ autoAccept: 'yes', saveDir: DIR }),
        /MakeLink takes autoAccept true or false, not yes/
    );
    const stuck = fakeRequestDom({ autoSwitchStuck: true });
    await assert.rejects(
        make(driverOn(stuck), stuck, { autoAccept: true }),
        /the Auto-accept switch did not turn on; no link is made/
    );
    assert.ok(!stuck.dom.clicks.some((c) => c.name === 'Make link'), 'no link was made');
    // A host whose form came up with the switch on: a cell that asks would
    // never see its prompt, so it fails at Make link, by name.
    const f = fakeRequestDom();
    f.dom.autoOn = true;
    await assert.rejects(
        make(driverOn(f), f),
        (e) => e.signatureKey === 'request-flow' && /made the link with autoAccept true, not the false this cell chose/.test(e.message)
    );
});
