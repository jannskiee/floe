/**
 * lib/ownerstate.mjs: the owner's own Save to and save folder, kept under
 * --out from one command to the next (second review of #542, finding A).
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/ownerstate.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isAuditFolder } from './desktop.mjs';
import {
    OWNER_KEYS,
    OWNER_STATE_FILE,
    ownerStateFor,
    ownerValue,
} from './ownerstate.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'transfer-audit-owner-'));
const RUN_FOLDER = 'C:\\Temp\\lta\\20261013-x\\cells\\S-DIR-W2D-reqauto\\attempt-1\\host-out';

test('a value is kept under --out and read back by a later command', () => {
    const dir = tmp();
    try {
        const first = ownerStateFor(dir, { now: () => new Date('2026-10-13T01:02:03Z') });
        assert.equal(first.recall('requestSaveTo'), null, 'nothing kept yet');
        assert.equal(first.remember('requestSaveTo', 'D:\\Inbox'), true);
        // A second object over the same folder is the next command.
        const next = ownerStateFor(dir);
        assert.deepEqual(next.recall('requestSaveTo'), {
            value: 'D:\\Inbox',
            at: '2026-10-13T01:02:03.000Z',
        });
        assert.equal(next.recall('receiveSaveDir'), null, 'one key says nothing about the other');
        // An empty value is a value: the owner never chose a folder.
        assert.equal(next.remember('receiveSaveDir', ''), true);
        assert.deepEqual(ownerStateFor(dir).recall('receiveSaveDir').value, '');
        assert.ok(existsSync(path.join(dir, OWNER_STATE_FILE)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('only the two known keys and only strings are kept', () => {
    const dir = tmp();
    try {
        const s = ownerStateFor(dir);
        assert.deepEqual([...OWNER_KEYS], ['requestSaveTo', 'receiveSaveDir']);
        assert.equal(s.remember('server', 'https://x.example'), false);
        assert.equal(s.remember('requestSaveTo', null), false);
        assert.equal(s.remember('requestSaveTo', 7), false);
        assert.equal(existsSync(path.join(dir, OWNER_STATE_FILE)), false, 'nothing was written');
        assert.equal(s.recall('server'), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a file that cannot be read, and no --out at all, cost only the convenience', () => {
    const dir = tmp();
    try {
        for (const junk of ['{ not json', '[]', '"text"', 'null', '{"requestSaveTo":{"value":7}}', '{"requestSaveTo":"D:\\\\Inbox"}']) {
            writeFileSync(path.join(dir, OWNER_STATE_FILE), junk);
            assert.equal(ownerStateFor(dir).recall('requestSaveTo'), null, junk);
        }
        // A junk file is replaced by the next good write, not kept broken.
        assert.equal(ownerStateFor(dir).remember('requestSaveTo', 'D:\\Inbox'), true);
        assert.equal(JSON.parse(readFileSync(path.join(dir, OWNER_STATE_FILE), 'utf8')).requestSaveTo.value, 'D:\\Inbox');
        const none = ownerStateFor(null);
        assert.equal(none.file, null);
        assert.equal(none.remember('requestSaveTo', 'D:\\Inbox'), false);
        assert.equal(none.recall('requestSaveTo'), null);
        // A folder that cannot be created: false, never a throw.
        const blocked = path.join(dir, 'a-file');
        writeFileSync(blocked, 'x');
        assert.equal(ownerStateFor(path.join(blocked, 'under-a-file')).remember('requestSaveTo', 'D:\\Inbox'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ownerValue: the owner's value is kept, and put back in place of a leftover", () => {
    const dir = tmp();
    try {
        const s = ownerStateFor(dir);
        // Command 1 reads the owner's folder.
        assert.deepEqual(ownerValue(s, 'requestSaveTo', 'D:\\Inbox', isAuditFolder), {
            before: 'D:\\Inbox',
            leftover: null,
            recalled: false,
        });
        // Its restore never happened. Command 2 reads the run folder.
        assert.deepEqual(ownerValue(ownerStateFor(dir), 'requestSaveTo', RUN_FOLDER, isAuditFolder), {
            before: 'D:\\Inbox',
            leftover: RUN_FOLDER,
            recalled: true,
        });
        // The leftover itself was never written over the owner's value.
        assert.equal(ownerStateFor(dir).recall('requestSaveTo').value, 'D:\\Inbox');
        // The owner changes the field between commands: the latest read wins.
        ownerValue(s, 'requestSaveTo', 'E:\\New', isAuditFolder);
        assert.equal(ownerValue(s, 'requestSaveTo', RUN_FOLDER, isAuditFolder).before, 'E:\\New');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('ownerValue: with nothing kept, or no record at all, a leftover goes back to the default', () => {
    const dir = tmp();
    try {
        const expected = { before: '', leftover: RUN_FOLDER, recalled: false };
        assert.deepEqual(ownerValue(ownerStateFor(dir), 'requestSaveTo', RUN_FOLDER, isAuditFolder), expected);
        assert.equal(existsSync(path.join(dir, OWNER_STATE_FILE)), false, 'a leftover is never kept');
        // No state object: a portable or head exe, whose profile is not the owner's.
        assert.deepEqual(ownerValue(null, 'requestSaveTo', RUN_FOLDER, isAuditFolder), expected);
        assert.deepEqual(ownerValue(null, 'requestSaveTo', 'D:\\Inbox', isAuditFolder), {
            before: 'D:\\Inbox',
            leftover: null,
            recalled: false,
        });
        // A record someone wrote an audit folder into is not believed.
        writeFileSync(
            path.join(dir, OWNER_STATE_FILE),
            JSON.stringify({ requestSaveTo: { value: RUN_FOLDER, at: 'x' } })
        );
        assert.deepEqual(ownerValue(ownerStateFor(dir), 'requestSaveTo', RUN_FOLDER, isAuditFolder), expected);
        // null and undefined read as the empty field.
        assert.equal(ownerValue(null, 'receiveSaveDir', null, isAuditFolder).before, '');
        assert.equal(ownerValue(null, 'receiveSaveDir', undefined, isAuditFolder).before, '');
        // And a field that could not be read is never KEPT as the owner's:
        // an empty record would later go back over a folder they had chosen
        // (third review of #542, finding 4).
        const fresh = tmp();
        try {
            for (const unread of [undefined, null, 7, {}, ['D:' + String.fromCharCode(92) + 'x']]) {
                assert.deepEqual(ownerValue(ownerStateFor(fresh), 'receiveSaveDir', unread, isAuditFolder), {
                    before: '',
                    leftover: null,
                    recalled: false,
                });
                assert.equal(ownerStateFor(fresh).recall('receiveSaveDir'), null, String(unread));
            }
            // The empty string is a real reading: the owner never chose a folder.
            ownerValue(ownerStateFor(fresh), 'receiveSaveDir', '', isAuditFolder);
            assert.equal(ownerStateFor(fresh).recall('receiveSaveDir').value, '');
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('isAuditFolder knows an attempt folder and the P9 probe value, and nothing else', () => {
    for (const p of [
        RUN_FOLDER,
        'C:/Temp/lta/run/cells/H-DIR-W2D-req/attempt-12',
        'C:\\Users\\Admin\\AppData\\Local\\Temp\\lta-closeout\\p9-save-dir',
        'C:/out/p9-save-dir/',
    ])
        assert.equal(isAuditFolder(p), true, p);
    for (const p of [
        '',
        null,
        'D:\\Inbox',
        'C:\\Users\\Admin\\Downloads\\Floe',
        'C:\\cells\\notes',
        'C:\\work\\attempt-1',
        'C:\\out\\p9-save-dir-old',
        'C:\\out\\p9-save-dir\\kept',
    ])
        assert.equal(isAuditFolder(p), false, String(p));
});
