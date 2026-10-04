// The UIA request link verbs (S1-REL-03a step 5; FU-26, a 17 P-15 carry-over
// for the shipped-profile desktop cells): lib/desktop.mjs UiaDriver against
// tests/fake-request-uia.mjs, a helper client over the scripted host view of
// tests/fake-request-dom.mjs. No window, no exe, no helper process: the fake
// clock carries the 1.2 s Accept wait.
//
// Run: node --test .claude/skills/<skill>/scripts/lib/desktop-uia-request.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    ACCEPT_WAIT_MS,
    REQUEST_STRINGS,
    UiaDriver,
    desktopFmtBytes,
    requestStateFromItems,
} from './desktop.mjs';
import { FAKE_LINK, fakeRequestDom } from './tests/fake-request-dom.mjs';
import { fakeRequestUiaClient } from './tests/fake-request-uia.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'uia-request-'));
const MiB = 1024 * 1024;

function hostWith(domOpts = {}, uiaOpts = {}) {
    const h = fakeRequestDom({ link: FAKE_LINK, ...domOpts });
    const client = fakeRequestUiaClient(h, { activates: false, ...uiaOpts });
    const driver = new UiaDriver(client, 4242, {});
    return { h, client, driver, clock: { now: h.now, nap: h.nap } };
}

const clicksOf = (client, name) =>
    client.calls.filter(
        ([cmd, p]) => cmd === 'click' && String(p.name).toLowerCase() === name.toLowerCase()
    );

test('UIA MakeLink sets the Save to field, makes the link and waits for the waiting view; ReadLink reads the whole link from the link field', async () => {
    const dir = tmp();
    try {
        const { h, driver, clock } = hostWith();
        const made = await driver.makeRequestLink({ saveDir: dir, ...clock });
        assert.equal(made.made, true);
        assert.equal(made.lifetime, '24h');
        assert.equal(h.dom.state, 'waiting');
        assert.equal(h.dom.linkSaveDir, dir);
        const read = await driver.readRequestLink();
        assert.equal(read.link, FAKE_LINK);
        assert.equal(read.via, 'uia-value');
        assert.equal(read.onScreen, true);
        assert.match(read.shown, /#<room>$/);
        assert.ok(!read.shown.includes('6f1c2b9e'), 'the shown form never carries the room');
        const snap = await driver.requestSnapshot();
        assert.equal(snap.state, 'waiting');
        assert.equal(snap.source, 'uia');
        assert.equal(snap.gen, 1, 'the driver counts the links it made');
        assert.equal(snap.saveDir, dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA MakeLink refuses a relative folder, a Save to field that will not take (SKIP desktop-savedir, no link) and names an error view by its code', async () => {
    const dir = tmp();
    try {
        const rel = hostWith();
        await assert.rejects(
            rel.driver.makeRequestLink({ saveDir: 'relative\\out', ...rel.clock }),
            (e) => e.reason === 'request-savedir'
        );
        assert.equal(clicksOf(rel.client, REQUEST_STRINGS.makeLink).length, 0);

        const stuck = hostWith({ saveDirStuck: true });
        await assert.rejects(
            stuck.driver.makeRequestLink({ saveDir: dir, ...stuck.clock }),
            (e) => e.verdict === 'SKIP' && e.reason === 'desktop-savedir'
        );
        assert.equal(clicksOf(stuck.client, REQUEST_STRINGS.makeLink).length, 0, 'no link is made');
        assert.equal(stuck.h.dom.gen, 0);

        const failing = hostWith({ makeError: 'disabled' });
        await assert.rejects(
            failing.driver.makeRequestLink({ saveDir: dir, ...failing.clock }),
            (e) => e.signatureKey === 'request-flow' && e.code === 'disabled'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA AcceptRequest never invokes before 1200 ms from the first sight of the prompt, on a fake clock', async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        h.requestAt(h.now() + 10, { files: 1, totalBytes: 64 * MiB });
        const r = await driver.acceptRequest({ timeoutMs: 30_000, ...clock });
        const accepts = clicksOf(client, 'Accept');
        assert.ok(accepts.length >= 1);
        assert.ok(r.waitedMs >= ACCEPT_WAIT_MS, `waited ${r.waitedMs} ms`);
        for (const [, , t] of accepts)
            assert.ok(t - r.seenAt >= ACCEPT_WAIT_MS, `an Accept at +${t - r.seenAt} ms`);
        assert.equal(h.dom.state, 'receiving');
        assert.equal(h.dom.ignored.length, 0, 'no click landed inside the guard');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA AcceptRequest on an inactive window: the Invoke that activates it is swallowed by the re-armed guard, and the next comes 1200 ms later and lands (G2-F1)', async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        // The window lost the foreground while the link waited.
        client.state.focused = false;
        h.requestAt(h.now() + 10, { files: 1, totalBytes: 64 * MiB });
        const r = await driver.acceptRequest({ timeoutMs: 30_000, ...clock });
        assert.equal(client.state.swallowed.length, 1, 'the activating Invoke was swallowed');
        assert.equal(r.invokes, 2);
        const at = clicksOf(client, 'Accept').map(([, , t]) => t);
        assert.equal(at.length, 2);
        assert.ok(at[1] - at[0] >= ACCEPT_WAIT_MS, `the second Invoke came ${at[1] - at[0]} ms after the first`);
        assert.equal(h.dom.state, 'receiving');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA DeclineRequest then KeepWaiting: Keep waiting shows after the decline, reopens the link, and is refused before any decline', async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        await assert.rejects(driver.keepWaiting(clock), /Keep waiting is not showing/);
        h.requestAt(h.now() + 10, { files: 1, totalBytes: MiB });
        const d = await driver.declineRequest({ timeoutMs: 30_000, ...clock });
        assert.ok(d.waitedMs >= ACCEPT_WAIT_MS);
        assert.equal(h.dom.state, 'declined');
        assert.equal((await driver.requestSnapshot()).state, 'declined');
        const k = await driver.keepWaiting(clock);
        assert.equal(k.reopened, true);
        assert.equal(h.dom.reopens, 1);
        assert.equal(h.dom.state, 'waiting');
        const order = client.calls
            .filter(([cmd]) => cmd === 'click')
            .map(([, p]) => p.name)
            .filter((n) => ['Decline', 'Keep waiting'].includes(n));
        assert.deepEqual(order, ['Decline', 'Keep waiting']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA CloseLink ends the link, CancelDrop stops a drop and Dismiss puts the result away', async () => {
    const dir = tmp();
    try {
        const a = hostWith();
        await a.driver.makeRequestLink({ saveDir: dir, ...a.clock });
        const closed = await a.driver.closeRequestLink(a.clock);
        assert.equal(closed.closed, true);
        assert.equal((await a.driver.requestSnapshot()).state, 'ended');

        const b = hostWith();
        await b.driver.makeRequestLink({ saveDir: dir, ...b.clock });
        b.h.requestAt(b.h.now() + 10, { files: 1, totalBytes: MiB });
        await b.driver.acceptRequest({ timeoutMs: 30_000, ...b.clock });
        assert.equal((await b.driver.requestSnapshot()).state, 'receiving');
        await b.driver.cancelRequestDrop(b.clock);
        const stopped = await b.driver.requestSnapshot();
        assert.equal(stopped.state, 'stopped');
        await b.driver.dismissRequestResult(b.clock);
        assert.equal((await b.driver.requestSnapshot()).state, 'ready');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Settings has no Request links switch since H7 (D-160); the generic switch
// verb still serves Hide my IP, the relay forcer.
test('UIA setToggle sets the Hide my IP switch through TogglePattern and reads it back; a stuck switch reads unchanged; the Beta switch is gone', async () => {
    const { h, driver } = hostWith({ settings: { hideIP: false } });
    await driver.click('Settings', { controlType: 'Button' });
    const on = await driver.setToggle(/^Hide my IP/, true);
    assert.deepEqual([on.before, on.after, on.changed], [false, true, true]);
    assert.equal(h.dom.settings.hideIP, true);
    const again = await driver.setToggle(/^Hide my IP/, true);
    assert.equal(again.changed, false, 'no Toggle when it already reads on');
    await assert.rejects(driver.setToggle(/^Request links/, true), (e) => e.reason === 'not-found');
    await driver.click('Settings', { controlType: 'Button' });

    const stuck = hostWith({ settings: { hideIP: false }, switchStuck: true });
    await stuck.driver.click('Settings', { controlType: 'Button' });
    const r = await stuck.driver.setToggle(/^Hide my IP/, true);
    assert.deepEqual([r.before, r.after, r.changed], [false, false, false]);
});

test('UIA awaitRequestTab: from Send it clicks RECEIVE once and sees the REQUEST LINK choice, on Receive it clicks nothing, and a build without the tab reports not shown', async () => {
    const a = hostWith();
    a.h.dom.mode = 'send';
    const r = await a.driver.awaitRequestTab(a.clock);
    assert.equal(r.shown, true);
    assert.equal(r.via, 'uia');
    assert.equal(clicksOf(a.client, 'Receive').length, 1);

    const b = hostWith();
    assert.equal((await b.driver.awaitRequestTab(b.clock)).shown, true);
    assert.equal(b.client.calls.filter(([c]) => c === 'click').length, 0, 'already on Receive: no click');

    const c = hostWith({ hideTab: true });
    const none = await c.driver.awaitRequestTab({ ...c.clock, timeoutMs: 2_000 });
    assert.equal(none.shown, false);
    assert.equal(c.h.dom.settingsOpen, false, 'Settings was never opened');
});

test('the away guard: an exe request host re-reads the input idle time before every pattern call and stops as SKIP present when the owner is back, having clicked nothing', async () => {
    const dir = tmp();
    try {
        const { client, driver, clock } = hostWith({}, { idle: 30 });
        driver.awayOnly = true;
        await assert.rejects(
            driver.makeRequestLink({ saveDir: dir, ...clock }),
            (e) => e.verdict === 'SKIP' && e.reason === 'present'
        );
        assert.equal(client.calls.filter(([c]) => c === 'click' || c === 'set-value' || c === 'toggle').length, 0);
        client.state.idle = 600;
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        const checks = client.calls.filter(([c]) => c === 'foreground-check').length;
        const patterns = client.calls.filter(([c]) => ['click', 'set-value', 'toggle'].includes(c)).length;
        assert.ok(checks >= patterns + 1, `${checks} idle checks for ${patterns} pattern calls`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA readRequestResult and requestSnapshot on the done view: the heading, the SHA-256 line, and the drop folder found by its name under the made save folder', async () => {
    const dir = tmp();
    try {
        const { h, driver, clock } = hostWith();
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        h.requestAt(h.now() + 10, { files: 1, totalBytes: 64 * MiB });
        await driver.acceptRequest({ timeoutMs: 30_000, ...clock });
        const folder = path.join(dir, 'Request 2026-09-30 2140');
        mkdirSync(folder);
        mkdirSync(path.join(dir, 'Request 2026-09-30 2139'));
        h.dom.state = 'done';
        h.dom.result = { files: 1, saved: 1, bytes: 64 * MiB, verified: 1, renamed: 0, folder, names: [] };
        const snap = await driver.requestSnapshot();
        assert.equal(snap.state, 'done');
        assert.deepEqual(
            { files: snap.result.files, saved: snap.result.saved, verified: snap.result.verified, folder: snap.result.folder },
            { files: 1, saved: 1, verified: 1, folder }
        );
        const view = await driver.readRequestResult();
        assert.equal(view.files, 1);
        assert.equal(view.verifiedLine, true);
        assert.match(view.heading, /^RECEIVED 1 FILE, 64\.0 MB$/);
        // D-161: the words are the check mark's screen-reader text, a Text
        // node of its own after the heading, and nothing else on the done
        // view carries them (DN5 left the view).
        const texts = (await driver._items()).filter((x) => x.type === 'Text').map((x) => x.name);
        assert.deepEqual(texts.filter((t) => /SHA-256|malware|scan files/i.test(t)), ['SHA-256 matched']);
        // A window that does not expose the span reads as no verified line.
        h.dom.forceVerifiedLine = false;
        assert.equal((await driver.readRequestResult()).verifiedLine, false);
        h.dom.forceVerifiedLine = undefined;
        // Without the SHA line the counts it vouches for are unknown.
        h.dom.result = { ...h.dom.result, verified: 0 };
        const short = await driver.requestSnapshot();
        assert.equal(short.result.saved, 1);
        assert.equal(short.result.verified, null);
        assert.equal(short.result.files, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('requestStateFromItems names every view from its buttons and fixed copy', () => {
    const B = (name, extra = {}) => ({ type: 'Button', name, ...extra });
    const T = (name) => ({ type: 'Text', name });
    const cases = [
        [[B('Make link')], { state: 'ready' }],
        [[B('Make link'), T('Request links are turned off on this server right now.')], { state: 'error', code: 'disabled' }],
        [[B('Make link'), T('You already have a request link open. Close it to make a new one.')], { state: 'error', code: 'already-open' }],
        [[B('Making the link...', { enabled: false })], { state: 'making' }],
        [[B('Copy link'), B('Close link'), T('Waiting for files.')], { state: 'waiting' }],
        [[B('Copied'), B('Close link')], { state: 'waiting' }],
        [[B('Copy link'), B('Close link'), B('Retry now'), T('No connection to the Floe server.')], { state: 'reconnecting' }],
        [[B('Copy link'), B('Close link'), T('Connecting to their computer.')], { state: 'connecting' }],
        [[B('Copy link'), B('Close link'), B('Accept'), B('Decline')], { state: 'deciding' }],
        [[B('Copy link'), B('Close link'), B('Keep waiting')], { state: 'declined' }],
        [[B('Cancel drop'), T('RECEIVING 1 OF 3')], { state: 'receiving' }],
        [[B('Dismiss'), B('Make another link'), T('RECEIVED 3 FILES, 64.0 MB')], { state: 'done' }],
        [[B('Dismiss'), B('Make another link'), T('DROP STOPPED'), T('A file did not match what was sent, so Floe deleted it. 2 of 3 files were saved.')], { state: 'stopped', code: 'hash-mismatch' }],
        [[B('Dismiss'), B('Make another link'), T('DROP STOPPED'), T('You stopped this drop. Nothing was saved.')], { state: 'stopped', code: 'stopped' }],
        [[B('Make another link'), T('Link closed.')], { state: 'ended', code: 'closed' }],
        [[B('Make another link'), T('Link ended at 2:05 PM.')], { state: 'ended', code: 'expired' }],
        [[B('SEND'), B('RECEIVE'), B('Settings')], { state: 'unknown' }],
    ];
    for (const [items, want] of cases) {
        const s = requestStateFromItems(items);
        assert.equal(s.state, want.state, JSON.stringify(items));
        if (want.code) assert.equal(s.code, want.code, JSON.stringify(items));
    }
    // H7 (D-161): the answer window sits on the size row as its own text,
    // and the laptop line is no longer on the prompt (it shows on Receiving,
    // and only on a PC with a battery), so a prompt without it reads clean.
    const deciding = requestStateFromItems([
        B('Accept'),
        B('Decline'),
        T('SOMEONE WANTS TO SEND YOU FILES'),
        T('3 files, 64.0 MB'),
        T('Answer within 9 min'),
        T('Into '),
        T('C:\\audit\\out\\Request 2026-09-30 2140'),
        T('Only 1.0 GB free on C:. The drop will stop when the drive fills.'),
    ], { saveDir: 'C:\\audit\\out' });
    assert.deepEqual(deciding.prompt, {
        files: 3,
        totalBytes: null,
        sizeText: '64.0 MB',
        folder: 'C:\\audit\\out\\Request 2026-09-30 2140',
        warnings: ['low-space'],
    });
    // The laptop line stays readable where a build still draws it on the
    // prompt (pre-H7), but its absence is never a finding.
    const legacy = requestStateFromItems([
        B('Accept'),
        B('Decline'),
        T('3 files, 64.0 MB'),
        T('On a laptop, plug in and keep the lid open.'),
    ]);
    assert.deepEqual(legacy.prompt.warnings, ['laptop-power']);
    const cap = requestStateFromItems([B('Accept'), B('Decline'), T('1 file, 3.0 GB'), T('Hide my IP is on, so this 3.0 GB drop will stop before any file.')]);
    assert.deepEqual(cap.prompt.warnings, ['relay-over-cap']);
    const stopped = requestStateFromItems([B('Dismiss'), T('DROP STOPPED'), T('The sender stopped this drop. 1 of 2 files were saved.')]);
    assert.deepEqual([stopped.code, stopped.result.saved, stopped.result.files], ['peer-abort', 1, 2]);
    assert.equal(desktopFmtBytes(64 * MiB), '64.0 MB');
    assert.equal(desktopFmtBytes(4 * MiB), '4.0 MB');
    assert.equal(desktopFmtBytes(512), '512 B');
});
