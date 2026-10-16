// The UIA request link verbs (S1-REL-03a step 5; FU-26, a 17 P-15 carry-over
// for the shipped-profile desktop cells): lib/desktop.mjs UiaDriver against
// tests/fake-request-uia.mjs, a helper client over the scripted host view of
// tests/fake-request-dom.mjs. No window, no exe, no helper process: the fake
// clock carries the 1.2 s Accept wait.
//
// Run: node --test .claude/skills/<skill>/scripts/lib/desktop-uia-request.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    ACCEPT_UNDRIVABLE,
    ACCEPT_WAIT_MS,
    RE,
    REQUEST_STRINGS,
    UiaDriver,
    desktopFmtBytes,
    isAuditFolder,
    requestStateFromItems,
} from './desktop.mjs';
import { ownerStateFor } from './ownerstate.mjs';
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

/**
 * The owner's own click on the prompt, past its 1 s guard. On a built exe
 * this is the only way a prompted drop is answered: the driver never invokes
 * Accept or Decline (F2), so a test that needs a drop under way or a declined
 * view puts it there the way a person would.
 */
async function ownerClicks(h, name) {
    await h.nap(1300);
    h.tick();
    h.views.click(name);
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

test('UIA MakeLink picks a non-default lifetime by its option name, leaves 24h alone, and refuses any other key before a click', async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        const made = await driver.makeRequestLink({ saveDir: dir, lifetime: '3d', ...clock });
        assert.equal(made.lifetime, '3d');
        assert.equal(clicksOf(client, REQUEST_STRINGS.lifetimes['3d']).length, 1);
        assert.deepEqual(h.dom.picked, ['In 3 days']);
        assert.equal(h.dom.madeLifetime, '3d');
        assert.equal(h.dom.state, 'waiting');

        // The default is the select's own value: no option is clicked.
        const def = hostWith();
        await def.driver.makeRequestLink({ saveDir: dir, ...def.clock });
        for (const label of Object.values(REQUEST_STRINGS.lifetimes))
            assert.equal(clicksOf(def.client, label).length, 0, label);
        assert.equal(def.h.dom.madeLifetime, '24h');

        for (const lifetime of ['15m', '7D', '']) {
            const bad = hostWith();
            await assert.rejects(
                bad.driver.makeRequestLink({ saveDir: dir, lifetime, ...bad.clock }),
                /MakeLink takes 30m, 1h, 8h, 24h, 3d or 7d/
            );
            assert.equal(bad.client.calls.length, 0, `${lifetime}: nothing was asked of the helper`);
        }
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

// F2 (field result 2026-10-11, Store 1.3.0.0): a UIA Invoke never presses
// Accept on a built exe. The prompt ignores input for 1 s after every focus
// change, an Invoke changes the focus, the button reads disabled within
// 100 ms of each Invoke, and a third one throws ElementNotEnabledException,
// with the window in the foreground too. The two tests that used to stand
// here encoded "wait 1.2 s and the next Invoke lands", which the app never
// did. What the lane can prove is the prompt itself, so that is where it
// stops, by name, having invoked nothing.
test('UIA AcceptRequest proves the prompt and stops as SKIP request-accept-undrivable with zero Invokes, whether or not the window has the foreground', async () => {
    const dir = tmp();
    try {
        for (const focused of [true, false]) {
            const { h, client, driver, clock } = hostWith();
            await driver.makeRequestLink({ saveDir: dir, ...clock });
            client.state.focused = focused;
            h.requestAt(h.now() + 10, { files: 1, totalBytes: 64 * MiB });
            const before = client.calls.length;
            await assert.rejects(
                driver.acceptRequest({ timeoutMs: 30_000, ...clock }),
                (e) => {
                    assert.equal(e.name, 'PhaseError');
                    assert.equal(e.phase, 'request');
                    assert.equal(e.verdict, 'SKIP');
                    assert.equal(e.reason, ACCEPT_UNDRIVABLE);
                    assert.equal(
                        ACCEPT_UNDRIVABLE,
                        'request-accept-undrivable'
                    );
                    assert.match(
                        e.message,
                        /^request-accept-undrivable: the prompt is up \("Accept" is showing\) and nothing was invoked/
                    );
                    assert.equal(
                        e.harness,
                        undefined,
                        'a precondition of the lane, never a harness fault'
                    );
                    return true;
                }
            );
            const since = client.calls.slice(before).map(([c]) => c);
            assert.deepEqual(
                since.filter((c) => c !== 'snapshot'),
                [],
                `focused ${focused}: only reads, no click, no set-value, no toggle`
            );
            assert.equal(clicksOf(client, 'Accept').length, 0);
            assert.equal(client.state.swallowed.length, 0);
            // The prompt it proved is still up and still reads the drop.
            assert.equal(h.dom.state, 'deciding');
            const snap = await driver.requestSnapshot();
            assert.deepEqual(
                { files: snap.prompt.files, sizeText: snap.prompt.sizeText },
                { files: 1, sizeText: '64.0 MB' }
            );
        }
        // A prompt that never shows is still a wait that ran out, not this SKIP.
        const none = hostWith();
        await none.driver.makeRequestLink({ saveDir: dir, ...none.clock });
        await assert.rejects(
            none.driver.acceptRequest({ timeoutMs: 2_000, ...none.clock }),
            (e) =>
                e.verdict === undefined &&
                /"Accept" did not appear within 2000 ms/.test(e.message)
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Decline is the same button row under the same guard, so it stops the same
// way. Keep waiting is not: its guard runs from the moment the declined view
// renders and never re-arms on focus, so the driver still presses it.
test('UIA DeclineRequest stops the same way, and the app source is why: one guard for both answers, re-armed on focus, and none of that on Keep waiting', async () => {
    const dir = tmp();
    try {
        const view = readFileSync(
            new URL(
                '../../../../../desktop/frontend/src/components/RequestLinkView.tsx',
                import.meta.url
            ),
            'utf8'
        );
        // Prompt: both buttons go through answer(), which the one guard gates,
        // and the guard takes the window's focus time.
        assert.ok(view.includes("onClick={answer('accept')}"));
        assert.ok(view.includes("onClick={answer('decline')}"));
        assert.ok(
            view.includes(
                'if (guardActive(Date.now(), mountedAt.current, focusAt.current)) return;'
            )
        );
        assert.ok(view.includes("window.addEventListener('focus', onFocus);"));
        // Declined: Keep waiting's guard has no focus term.
        assert.ok(
            view.includes(
                'if (guardActive(Date.now(), mountedAt.current, null)) return;'
            )
        );

        const { h, client, driver, clock } = hostWith();
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        await assert.rejects(driver.keepWaiting(clock), /Keep waiting is not showing/);
        h.requestAt(h.now() + 10, { files: 1, totalBytes: MiB });
        await assert.rejects(
            driver.declineRequest({ timeoutMs: 30_000, ...clock }),
            (e) =>
                e.verdict === 'SKIP' &&
                e.reason === ACCEPT_UNDRIVABLE &&
                /"Decline" is showing/.test(e.message)
        );
        assert.equal(clicksOf(client, 'Decline').length, 0);
        assert.equal(h.dom.state, 'deciding');

        // Once the owner has declined, Keep waiting is the driver's to press.
        await ownerClicks(h, 'Decline');
        assert.equal((await driver.requestSnapshot()).state, 'declined');
        const k = await driver.keepWaiting(clock);
        assert.equal(k.reopened, true);
        assert.equal(h.dom.reopens, 1);
        assert.equal(h.dom.state, 'waiting');
        assert.equal(clicksOf(client, 'Keep waiting').length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA CloseLink ends the link, CancelDrop stops a drop and Make another link puts the result away', async () => {
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
        await ownerClicks(b.h, 'Accept');
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
        await ownerClicks(h, 'Accept');
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
        [[B('Make link'), T('Request links are off on this server')], { state: 'error', code: 'disabled' }],
        [[B('Make link'), T('Close your open link to make a new one')], { state: 'error', code: 'already-open' }],
        [[B('Making link...', { enabled: false })], { state: 'making' }],
        [[B('Copy link'), B('Close link'), T('Waiting for files')], { state: 'waiting' }],
        [[B('Copied'), B('Close link')], { state: 'waiting' }],
        [[B('Copy link'), B('Close link'), B('Retry now'), T("Can't reach the Floe server")], { state: 'reconnecting' }],
        [[B('Copy link'), B('Close link'), T('Connecting to the sender...')], { state: 'connecting' }],
        [[B('Copy link'), B('Close link'), B('Accept'), B('Decline')], { state: 'deciding' }],
        [[B('Copy link'), B('Close link'), B('Keep waiting')], { state: 'declined' }],
        [[B('Cancel drop'), T('RECEIVING 1 OF 3')], { state: 'receiving' }],
        [[B('Make another link'), T('RECEIVED 3 FILES, 64.0 MB')], { state: 'done' }],
        [[B('Make another link'), T('DROP STOPPED'), T("A file didn't match what was sent and was deleted · 2 of 3 files saved")], { state: 'stopped', code: 'hash-mismatch' }],
        [[B('Make another link'), T('DROP STOPPED'), T('You stopped this drop · Nothing saved')], { state: 'stopped', code: 'stopped' }],
        [[B('Make another link'), T('Link closed')], { state: 'ended', code: 'closed' }],
        [[B('Make another link'), T('Link ended at 2:05 PM')], { state: 'ended', code: 'expired' }],
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
        T('9 min to answer'),
        T('Into '),
        T('C:\\audit\\out\\Request 2026-09-30 2140'),
        T('Only 1.0 GB free on C:, not enough for this drop'),
    ], { saveDir: 'C:\\audit\\out' });
    assert.deepEqual(deciding.prompt, {
        files: 3,
        totalBytes: null,
        sizeText: '64.0 MB',
        folder: 'C:\\audit\\out\\Request 2026-09-30 2140',
        warnings: ['low-space'],
    });
    // The laptop line stays readable where a build still draws it on the
    // prompt (pre-H7), but its absence is never a finding. H7 words it
    // "Keep this laptop plugged in and open" and draws it on Receiving only,
    // so on a prompt either wording is a line that should not be there: it
    // is read as laptop-power and lands in the attempt's evidence.
    for (const line of ['On a laptop, plug in and keep the lid open.', 'Keep this laptop plugged in and open']) {
        const withLine = requestStateFromItems([B('Accept'), B('Decline'), T('3 files, 64.0 MB'), T(line)]);
        assert.deepEqual(withLine.prompt.warnings, ['laptop-power'], line);
    }
    const stopped = requestStateFromItems([B('Make another link'), T('DROP STOPPED'), T('The sender stopped this drop · 1 of 2 files saved')]);
    assert.deepEqual([stopped.code, stopped.result.saved, stopped.result.files], ['peer-abort', 1, 2]);
    assert.equal(desktopFmtBytes(64 * MiB), '64.0 MB');
    assert.equal(desktopFmtBytes(4 * MiB), '4.0 MB');
    assert.equal(desktopFmtBytes(512), '512 B');
});

// Three request link lines changed after desktop-v0.3.0 (the owner,
// 2026-10-14): P6 names the relay where it named Hide my IP, ST6 counts what
// was saved where it always said Nothing saved, and P5 is gone. One audit
// reads the released Store app and a build of HEAD, so the reader takes both.
test('requestStateFromItems reads the relay prompt line and the relay stop card as desktop-v0.3.0 and as a later build word them', () => {
    const B = (name) => ({ type: 'Button', name });
    const T = (name) => ({ type: 'Text', name });
    const prompt = (line) => requestStateFromItems([B('Accept'), B('Decline'), T('1 file, 3.0 GB'), T(line)]).prompt;
    for (const line of [
        'This 3.0 GB drop is over the 2 GB Hide my IP limit', // desktop-v0.3.0
        'This 3.0 GB drop is over the 2 GB relay limit',
    ])
        assert.deepEqual(prompt(line).warnings, ['relay-over-cap'], line);
    // Neither wording is read out of a longer sentence.
    assert.deepEqual(prompt('This 3.0 GB drop is over the 2 GB relay limit today').warnings, []);
    assert.deepEqual(prompt('This 3.0 GB drop is over the 2 GB limit').warnings, []);
    // P5: desktop-v0.3.0 has the line and no path in it draws it; a later
    // build has no such line. A build that drew it would show in the evidence.
    assert.deepEqual(prompt("This drive can't save files over 4 GB").warnings, ['file-too-large-for-drive']);

    const stop = (card) => {
        const s = requestStateFromItems([B('Make another link'), T('DROP STOPPED'), T(card)]);
        return [s.state, s.code, s.result.saved, s.result.files];
    };
    // desktop-v0.3.0: the fixed card, whatever was saved.
    assert.deepEqual(stop('Over the 2 GB relay limit · Nothing saved'), ['stopped', 'relay-cap', 0, null]);
    // A later build: the same card when nothing was saved, the count otherwise.
    assert.deepEqual(stop('Over the 2 GB relay limit · 2 of 5 files saved'), ['stopped', 'relay-cap', 2, 5]);
    assert.deepEqual(stop('Over the 2 GB relay limit · 1 of 1 file saved'), ['stopped', 'relay-cap', 1, 1]);
    // The count alone is still the unknown stop (ST14), never the relay one.
    assert.deepEqual(stop('2 of 5 files saved'), ['stopped', 'unknown', 2, 5]);
});

test('the request link lines the reader keys on are the ones requestCopy.ts draws today', () => {
    const copy = readFileSync(
        new URL('../../../../../desktop/frontend/src/requestCopy.ts', import.meta.url),
        'utf8'
    );
    const B = (name) => ({ type: 'Button', name });
    const T = (name) => ({ type: 'Text', name });
    // P6, with fmtBytes' rendering in the size slot.
    const p6 = /return `This \$\{fmtBytes\(p\.totalBytes\)\} (drop is over the 2 GB [^`]+)`; \/\/ P6/.exec(copy);
    assert.ok(p6, 'requestCopy.ts no longer has the P6 line in the form this test reads');
    assert.deepEqual(
        requestStateFromItems([B('Accept'), B('Decline'), T('1 file, 3.0 GB'), T(`This 3.0 GB ${p6[1]}`)]).prompt.warnings,
        ['relay-over-cap']
    );
    // ST6: the card sentence, which the app follows with " · " and the count.
    const st6 = /'relay-cap': \{card: '([^']+)',/.exec(copy);
    assert.ok(st6, 'requestCopy.ts no longer has the ST6 card in the form this test reads');
    const s = requestStateFromItems([B('Make another link'), T('DROP STOPPED'), T(`${st6[1]} · 2 of 5 files saved`)]);
    assert.deepEqual([s.code, s.result.saved, s.result.files], ['relay-cap', 2, 5]);
    // P5 left the app: no line for the code, so its reader is for released builds only.
    assert.ok(!copy.includes("case 'file-too-large-for-drive'"));
});

// The Auto-accept twins: the one delivery a built exe can prove, since nothing
// has to press Accept (F2). An exe has no GetRequestLink, so the lane cannot
// read the host's own record of the choice. It sets the form's check through
// TogglePattern, reads it back, and then takes the link block's own words as
// the record: W5a, "Ends <when> · Accepts automatically", which the app draws
// only on a link that holds the choice and is not asking first.
test('UIA MakeLink with autoAccept sets the Auto-accept check through TogglePattern before Make link, and the link block saying Accepts automatically is its record of the choice', async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        const made = await driver.makeRequestLink({
            saveDir: dir,
            autoAccept: true,
            ...clock,
        });
        assert.equal(made.autoAccept, true);
        assert.deepEqual(h.dom.switched, ['Auto-accept']);
        assert.equal(
            h.dom.autoAccept,
            true,
            'the host holds an automatic link'
        );
        const toggles = client.calls.filter(([c]) => c === 'toggle');
        assert.equal(toggles.length, 1);
        assert.equal(toggles[0][1].value, true);
        assert.ok(
            new RegExp(toggles[0][1].regex, 'i').test(
                REQUEST_STRINGS.autoAcceptSwitch
            )
        );
        assert.ok(
            !new RegExp(toggles[0][1].regex, 'i').test('About Auto-accept'),
            'never the info icon'
        );
        const patterns = client.calls
            .filter(([c]) => ['click', 'set-value', 'toggle'].includes(c))
            .map(([c, p]) => (c === 'click' ? p.name : c));
        assert.deepEqual(patterns.slice(-3), [
            'set-value',
            'toggle',
            'Make link',
        ]);
        const snap = await driver.requestSnapshot();
        assert.equal(snap.state, 'waiting');
        assert.equal(snap.autoAccept, true);
        assert.equal(snap.autoAsks, '');
        // The words are the app's own (requestCopy.ts W5a).
        const copy = readFileSync(
            new URL(
                '../../../../../desktop/frontend/src/requestCopy.ts',
                import.meta.url
            ),
            'utf8'
        );
        assert.equal(
            REQUEST_STRINGS.acceptsAutomatically,
            'Accepts automatically'
        );
        assert.ok(
            copy.includes(
                `export const ACCEPTS_AUTOMATICALLY = '${REQUEST_STRINGS.acceptsAutomatically}';`
            )
        );
        assert.ok(copy.includes('return `${w5} · ${ACCEPTS_AUTOMATICALLY}`;'));
        assert.ok(
            copy.includes("export const AUTO_ACCEPT_LABEL = 'Auto-accept';")
        );

        // Off: the check is never touched and the lane's record says so.
        const off = hostWith();
        const plain = await off.driver.makeRequestLink({
            saveDir: dir,
            autoAccept: false,
            ...off.clock,
        });
        assert.equal(plain.autoAccept, false);
        assert.equal(
            off.client.calls.filter(([c]) => c === 'toggle').length,
            0
        );
        assert.equal(off.h.dom.autoAccept, false);
        const offSnap = await off.driver.requestSnapshot();
        assert.deepEqual([offSnap.autoAccept, offSnap.autoAsks], [false, '']);

        // The next link of the same driver starts from off again.
        await driver.closeRequestLink(clock);
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        assert.equal((await driver.requestSnapshot()).autoAccept, false);

        const bad = hostWith();
        await assert.rejects(
            bad.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: 'yes',
                ...bad.clock,
            }),
            /MakeLink takes autoAccept true or false, not yes/
        );
        assert.equal(
            bad.client.calls.length,
            0,
            'nothing was asked of the helper'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('UIA MakeLink with autoAccept names what stands in the way: no check on the form (SKIP request-no-auto-switch), a check that will not turn on, a link that does not say it accepts, a drive under the floor (W5b), and an automatic link nobody asked for', async () => {
    const dir = tmp();
    try {
        const none = hostWith({ autoSwitch: false });
        await assert.rejects(
            none.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: true,
                ...none.clock,
            }),
            (e) =>
                e.verdict === 'SKIP' &&
                e.reason === 'request-no-auto-switch' &&
                /no link is made/.test(e.message)
        );
        assert.equal(clicksOf(none.client, REQUEST_STRINGS.makeLink).length, 0);
        assert.equal(none.h.dom.gen, 0);

        const stuck = hostWith({ autoSwitchStuck: true });
        await assert.rejects(
            stuck.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: true,
                ...stuck.clock,
            }),
            (e) =>
                e.verdict === undefined &&
                /the Auto-accept check did not turn on; no link is made/.test(
                    e.message
                )
        );
        assert.equal(
            clicksOf(stuck.client, REQUEST_STRINGS.makeLink).length,
            0
        );

        // From here the link exists, so the driver counts it and the runner's
        // release closes it.
        const silent = hostWith({ autoScope: 'none' });
        await assert.rejects(
            silent.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: true,
                ...silent.clock,
            }),
            (e) =>
                e.signatureKey === 'request-flow' &&
                /^request-flow: the link was made with the Auto-accept check on, but its link block does not say "Accepts automatically"/.test(
                    e.message
                )
        );
        const silentSnap = await silent.driver.requestSnapshot();
        assert.deepEqual(
            [silentSnap.state, silentSnap.gen, silentSnap.autoAccept],
            ['waiting', 1, false]
        );

        const low = hostWith({ autoScope: 'low-space' });
        await assert.rejects(
            low.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: true,
                ...low.clock,
            }),
            (e) =>
                e.signatureKey === 'request-flow' &&
                /the link reads "Asks first, low space on C:"/.test(
                    e.message
                ) &&
                /--out/.test(e.message)
        );
        const lowSnap = await low.driver.requestSnapshot();
        assert.deepEqual(
            [lowSnap.gen, lowSnap.autoAccept, lowSnap.autoAsks],
            [1, false, 'low-space']
        );

        // A cell that asked for a prompt would never see one on a link that
        // accepts by itself: the same finding the dev page lane words.
        const stale = hostWith();
        stale.h.dom.autoOn = true;
        await assert.rejects(
            stale.driver.makeRequestLink({
                saveDir: dir,
                autoAccept: false,
                ...stale.clock,
            }),
            (e) =>
                e.signatureKey === 'request-flow' &&
                /the host made the link with autoAccept true, not the false this cell chose/.test(
                    e.message
                )
        );
        assert.equal(
            stale.client.calls.filter(([c]) => c === 'toggle').length,
            0
        );
        assert.equal((await stale.driver.requestSnapshot()).gen, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("requestStateFromItems reads the scope line of an automatic link: W5a is what the link says now, W5b is autoAsks low-space, and autoAccept is only ever the driver's own record", () => {
    const B = (name) => ({ type: 'Button', name });
    const T = (name) => ({ type: 'Text', name });
    const waiting = (line) => [
        B('Copy link'),
        B('Close link'),
        T(line),
        T('Waiting for files'),
    ];
    const plain = requestStateFromItems(waiting('Ends Oct 13, 9:41 PM'));
    assert.deepEqual(
        [plain.state, plain.autoAccept, plain.autoShown, plain.autoAsks],
        ['waiting', false, false, '']
    );
    const auto = requestStateFromItems(
        waiting('Ends Oct 13, 9:41 PM · Accepts automatically'),
        { autoAccept: true }
    );
    assert.deepEqual(
        [auto.autoAccept, auto.autoShown, auto.autoAsks],
        [true, true, '']
    );
    // The view saying so is not the record: only a link this driver made is.
    const unknown = requestStateFromItems(
        waiting('Ends today, 9:41 PM · Accepts automatically')
    );
    assert.deepEqual([unknown.autoAccept, unknown.autoShown], [false, true]);
    const asks = requestStateFromItems(
        waiting('Ends today, 9:41 PM · Asks first, low space on D:'),
        { autoAccept: true }
    );
    assert.deepEqual(
        [asks.autoShown, asks.autoAsks, asks.autoAsksDrive],
        [false, 'low-space', 'D:']
    );
    // W5c (desktop-v0.3.2): a drive that cannot carry the downloaded-file mark.
    const noMark = requestStateFromItems(
        waiting("Ends today, 9:41 PM · Asks first, Windows can't mark files on G:"),
        { autoAccept: true }
    );
    assert.deepEqual(
        [noMark.autoShown, noMark.autoAsks, noMark.autoAsksDrive],
        [false, 'no-mark', 'G:']
    );
    // UIA reports the rendered case, and the words count only at the line's end.
    assert.equal(
        requestStateFromItems(
            waiting('ENDS TODAY, 9:41 PM · ACCEPTS AUTOMATICALLY')
        ).autoShown,
        true
    );
    assert.equal(
        requestStateFromItems(
            waiting('Accepts automatically when you turn it on')
        ).autoShown,
        false
    );
    // Off the link phases the line means nothing.
    const done = requestStateFromItems([
        B('Make another link'),
        T('RECEIVED 1 FILE, 4.0 KB'),
        T('x · Accepts automatically'),
    ]);
    assert.deepEqual(
        [done.state, done.autoShown, done.autoAsks],
        ['done', false, '']
    );
});

// B2: the Store app runs on the owner's own profile, where the Make link
// form's Save to field is kept between launches (App.tsx writes localStorage
// floe:requestSaveDir on every change, and ValuePattern.SetValue is a change).
// The driver keeps what the field read before it first set it and puts that
// back once the link is closed. Portable and head exes run on a redirected
// profile and the dev page in a throwaway context, so only the Store lane
// calls this (lib/request.mjs releaseHost).
test('UIA restoreRequestSaveDir puts the Save to field back to what it read before this driver first set it, from the ended view, and does nothing when the driver never set it', async () => {
    const dir = tmp();
    try {
        for (const before of ['D:\\owner\\Floe drops', '']) {
            const { h, client, driver, clock } = hostWith();
            h.dom.saveDir = before;
            assert.deepEqual(
                await driver.restoreRequestSaveDir(clock),
                { before: null, restored: null, after: null, leftover: null, recalled: false },
                'nothing was set yet'
            );
            assert.equal(
                client.calls.filter(([c]) => c !== 'snapshot').length,
                0,
                'and nothing was asked'
            );
            await driver.makeRequestLink({ saveDir: dir, ...clock });
            assert.equal(h.dom.saveDir, dir);
            // A second link of the same driver never takes the run's own
            // folder for the owner's.
            await driver.closeRequestLink(clock);
            await driver.makeRequestLink({
                saveDir: path.join(dir, 'second'),
                ...clock,
            });
            await driver.closeRequestLink(clock);
            // The ended view: Make another link brings the form back first.
            const back = await driver.restoreRequestSaveDir(clock);
            assert.deepEqual(back, { before, restored: true, after: before, leftover: null, recalled: false });
            assert.equal(h.dom.saveDir, before);
            assert.equal(h.dom.state, 'ready');
            assert.equal(h.dom.gen, 2, 'no link was made to do it');
        }

        // A field that will not take the old value reads back as not restored.
        const stuck = hostWith();
        stuck.h.dom.saveDir = 'D:\\owner';
        await stuck.driver.makeRequestLink({ saveDir: dir, ...stuck.clock });
        await stuck.driver.closeRequestLink(stuck.clock);
        stuck.h.dom.saveDirStuck = true;
        assert.deepEqual(
            await stuck.driver.restoreRequestSaveDir(stuck.clock),
            {
                before: 'D:\\owner',
                restored: false,
                after: dir,
                leftover: null,
                recalled: false,
            }
        );

        // With the link still open there is no form to set, and the helper's
        // own refusal comes through for the runner to file.
        const open = hostWith();
        await open.driver.makeRequestLink({ saveDir: dir, ...open.clock });
        await assert.rejects(
            open.driver.restoreRequestSaveDir(open.clock),
            (e) => e.reason === 'not-found'
        );
        assert.equal(
            open.h.dom.state,
            'waiting',
            'the open link was not touched'
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Review of #542, finding 6: the count-based away test above passed with the
// idle check deleted from the Toggle call, because closeAndWait sends the
// same command and padded the count. Order is the claim, so order is checked.
test('every pattern call an away-only host sends is directly preceded by its own idle read, the Auto-accept toggle included', async () => {
    const dir = tmp();
    try {
        const { client, driver, clock } = hostWith({}, { idle: 600 });
        driver.awayOnly = true;
        await driver.makeRequestLink({ saveDir: dir, autoAccept: true, ...clock });
        const cmds = client.calls.map(([c]) => c);
        const patterns = ['click', 'set-value', 'toggle'];
        assert.ok(cmds.includes('toggle'), 'the Auto-accept check was toggled');
        cmds.forEach((c, i) => {
            if (patterns.includes(c))
                assert.equal(cmds[i - 1], 'foreground-check', `${c} at ${i} has no idle read before it`);
        });
        // With the owner back, the toggle is refused and never sent.
        const back = hostWith({}, { idle: 600 });
        back.driver.awayOnly = true;
        back.client.state.idle = 30;
        await assert.rejects(
            back.driver.setToggle(RE.autoAcceptCheck, true),
            (e) => e.verdict === 'SKIP' && e.reason === 'present'
        );
        assert.equal(back.client.calls.filter(([c]) => c === 'toggle').length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Finding 1: a release that never happened leaves the Save to field on an
// audit folder, and the next run's driver read that folder as the owner's
// value, put it "back" and reported it restored.
test("an earlier audit's own folder in the Save to field is never taken for the owner's value: the field goes back to empty and the result says what was found", async () => {
    assert.equal(isAuditFolder('C:\\Users\\x\\AppData\\Local\\Temp\\lta\\20261013-031359-shipped-default\\cells\\S-DIR-W2D-reqauto\\attempt-1\\out'), true);
    assert.equal(isAuditFolder('/tmp/run/cells/H-DIR-W2D-req/attempt-2/host-drops'), true);
    assert.equal(isAuditFolder('C:\\run\\cells\\S-DIR-D2C\\attempt-12'), true);
    for (const own of ['D:\\owner\\Floe drops', '', 'C:\\Users\\x\\Downloads\\Floe', 'D:\\cells\\attempts', 'D:\\work\\cells\\notes\\attempt-x', null, undefined])
        assert.equal(isAuditFolder(own), false, String(own));

    const dir = tmp();
    try {
        const left = 'C:\\Users\\x\\AppData\\Local\\Temp\\lta\\20261012-200000-shipped-default\\cells\\S-DIR-W2D-reqauto\\attempt-1\\out';
        const { h, client, driver, clock } = hostWith();
        h.dom.saveDir = left;
        await driver.makeRequestLink({ saveDir: dir, ...clock });
        // Read before the set, with a call that activates nothing.
        const cmds = client.calls.map(([c]) => c);
        assert.ok(cmds.indexOf('get-value') >= 0 && cmds.indexOf('get-value') < cmds.indexOf('set-value'));
        assert.equal(driver.requestSaveDirBefore(), '', 'not the leftover');
        await driver.closeRequestLink(clock);
        assert.deepEqual(await driver.restoreRequestSaveDir(clock), {
            before: '',
            restored: true,
            after: '',
            leftover: left,
            recalled: false,
        });
        assert.equal(h.dom.saveDir, '', "the app's default again");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Second review, finding A: one command runs one cell, and the owner's own
// folder lived only in the memory of the command that read it. After a
// release that never happened, the next command had nothing better to put
// back than the app's default. The value is now kept under --out.
test("a leftover in the Save to field goes back to the owner's folder when an earlier command of the same --out read it", async () => {
    const out = tmp();
    const dir = tmp();
    try {
        const owner = 'D:\\owner\\Floe drops';
        // Command 1: reads the owner's folder, sets its own, and dies before
        // its release (no restore is called on this driver).
        const first = hostWith();
        first.h.dom.saveDir = owner;
        const d1 = new UiaDriver(first.client, 4242, { ownerState: ownerStateFor(out) });
        await d1.makeRequestLink({ saveDir: path.join(dir, 'cells', 'S-DIR-W2D-reqauto', 'attempt-1', 'out'), ...first.clock });
        const left = first.h.dom.saveDir;
        assert.equal(isAuditFolder(left), true);
        assert.equal(ownerStateFor(out).recall('requestSaveTo').value, owner);

        // Command 2: a new process, a new driver, the same --out.
        const next = hostWith();
        next.h.dom.saveDir = left;
        const d2 = new UiaDriver(next.client, 4242, { ownerState: ownerStateFor(out) });
        await d2.makeRequestLink({ saveDir: path.join(dir, 'cells', 'S-DIR-W2D-req', 'attempt-1', 'out'), ...next.clock });
        assert.equal(d2.requestSaveDirBefore(), owner);
        assert.deepEqual(d2.requestSaveDirLeftover(), { leftover: left, recalled: true });
        await d2.closeRequestLink(next.clock);
        assert.deepEqual(await d2.restoreRequestSaveDir(next.clock), {
            before: owner,
            restored: true,
            after: owner,
            leftover: left,
            recalled: true,
        });
        assert.equal(next.h.dom.saveDir, owner, "the owner's folder, not the default");
        // The leftover never replaced the kept value.
        assert.equal(ownerStateFor(out).recall('requestSaveTo').value, owner);

        // A driver given no record (a portable or head exe) keeps nothing.
        const other = tmp();
        try {
            const plain = hostWith();
            plain.h.dom.saveDir = 'E:\\portable profile';
            await plain.driver.makeRequestLink({ saveDir: dir, ...plain.clock });
            assert.equal(ownerStateFor(other).recall('requestSaveTo'), null);
            assert.equal(ownerStateFor(out).recall('requestSaveTo').value, owner, 'and never writes the Store record');
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

// Finding 5: the Safety table said "forced foreground: 0 times" on every
// run, from a counter nothing ever wrote.
test('the driver counts each pattern call it sends to a built app, and none it was refused', async () => {
    const dir = tmp();
    try {
        const h = fakeRequestDom({ link: FAKE_LINK });
        const client = fakeRequestUiaClient(h, { activates: false, idle: 600 });
        const counter = { exe: 0 };
        const driver = new UiaDriver(client, 4242, { counter });
        const clock = { now: h.now, nap: h.nap };
        await driver.makeRequestLink({ saveDir: dir, autoAccept: true, ...clock });
        const sent = client.calls.filter(([c]) => ['click', 'set-value', 'toggle'].includes(c)).length;
        assert.ok(sent >= 4, `${sent} pattern calls`);
        assert.equal(counter.exe, sent);
        driver.awayOnly = true;
        client.state.idle = 5;
        await assert.rejects(driver.click('Close link'), (e) => e.reason === 'present');
        assert.equal(counter.exe, sent, 'a refused call is not counted');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Why the field is read before it is set: the set's own answer is the only
// other place its old value appears, and an answer can be lost after the
// value has landed (a helper timeout). Without the read the driver would then
// hold no value to put back, and the owner's folder would stay replaced.
test("a Save to set whose answer is lost still leaves the owner's folder known, and the release puts it back", async () => {
    const dir = tmp();
    try {
        const { h, client, driver, clock } = hostWith();
        h.dom.saveDir = 'D:\\owner\\Floe drops';
        const request = client.request.bind(client);
        let lose = true;
        client.request = async (cmd, params) => {
            const answer = await request(cmd, params);
            if (cmd === 'set-value' && lose) {
                lose = false;
                throw Object.assign(new Error('helper timeout after 30000 ms'), { reason: 'timeout' });
            }
            return answer;
        };
        await assert.rejects(driver.makeRequestLink({ saveDir: dir, ...clock }), /helper timeout/);
        assert.equal(h.dom.saveDir, dir, 'the value landed although its answer did not');
        assert.equal(driver.requestSaveDirBefore(), 'D:\\owner\\Floe drops');
        assert.deepEqual(await driver.restoreRequestSaveDir(clock), {
            before: 'D:\\owner\\Floe drops',
            restored: true,
            after: 'D:\\owner\\Floe drops',
            leftover: null,
            recalled: false,
        });
        assert.equal(h.dom.saveDir, 'D:\\owner\\Floe drops');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
