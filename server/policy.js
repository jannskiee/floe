'use strict';

// The request-link kill switch: a small JSON file named by POLICY_FILE, read
// once at startup and again on every tick of the 60 s cleanup interval, so an
// operator can turn request links off for every installed build without a
// restart. A restart would wipe every in-memory room and code and end every
// waiting share link, because the Go signaling client never reconnects.
//
// Fails closed. No path, a missing file, or a server that never read a good
// file means request links are off. A file that cannot be read or parsed, or
// that is over the size cap, keeps the last good policy, so a half-written file
// during an edit never flips the feature (edit by writing a temp file and
// renaming it over the real one).
//
// Synchronous on purpose: the reload runs inside a setInterval callback, and an
// un-awaited promise there is one more way for a throw to reach the process
// backstop. JSON.parse is iterative in V8, so a deeply nested file cannot
// overflow the stack.
//
// Never logs the file's content, its path, or anything a caller sent: at most
// one fixed line per effective change and one per failure streak.

const fs = require('fs');

const DEFAULT_POLICY = Object.freeze({ requestLinks: false });
const POLICY_MAX_BYTES = 64 * 1024;

const LOG_ON = 'request links: on';
const LOG_OFF = 'request links: off';
const LOG_UNREADABLE = 'policy file unreadable, keeping previous policy';

// Pure. Only `requestLinks: true` (the boolean) turns the feature on; the
// string "true" and every other value are off. Unknown keys are ignored, so
// the file can grow keys later without an older server rejecting it.
function parsePolicy(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return { policy: null, error: 'parse' };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { policy: null, error: 'shape' };
    }
    return { policy: Object.freeze({ requestLinks: value.requestLinks === true }), error: null };
}

// The stamp of a read: the file's identity as well as its mtime and size
// (CP-SE F1-2). mtime and size alone skipped a same-length off-file whose
// mtime was kept (cp -p, tar x, rsync -a, docker cp), and request links stayed
// on while the file said off. A file renamed over the path (the runbook's
// edit, rsync, tar) is a new inode; a same-size edit in place (cp -p onto the
// file) keeps the inode but moves the change time, which no user tool can set
// back. BigInt stats: a 64-bit NTFS file id past 2^53 would round in a Number.
function stampOf(st) {
    return { ino: st.ino, ctimeNs: st.ctimeNs, mtimeNs: st.mtimeNs, size: st.size };
}

function sameStamp(a, b) {
    return a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

// One read. `lastStamp` is the stamp of the last good read, so an unchanged
// file is not read or parsed again. Returns a kind the store acts on:
//   missing    no path, or the file does not exist: the defaults (off)
//   unchanged  the same file, change time, mtime and size as the last good read
//   ok         parsed; `policy` is the new object and `stamp` its stamp
//   error      anything else: keep the last good policy
function readPolicyFile(path, lastStamp) {
    if (!path) return { kind: 'missing', policy: DEFAULT_POLICY, stamp: null };
    let st;
    try {
        st = fs.statSync(path, { bigint: true });
    } catch (err) {
        if (err && err.code === 'ENOENT') return { kind: 'missing', policy: DEFAULT_POLICY, stamp: null };
        return { kind: 'error', policy: null, stamp: lastStamp };
    }
    // isFile before any read: a FIFO or a device at the path would block the
    // event loop inside readFileSync.
    if (!st.isFile() || st.size > POLICY_MAX_BYTES) return { kind: 'error', policy: null, stamp: lastStamp };
    const stamp = stampOf(st);
    if (lastStamp && sameStamp(lastStamp, stamp)) {
        return { kind: 'unchanged', policy: null, stamp: lastStamp };
    }
    let text;
    try {
        text = fs.readFileSync(path, 'utf8');
    } catch {
        return { kind: 'error', policy: null, stamp: lastStamp };
    }
    // The file can change between the stat and the read.
    if (Buffer.byteLength(text, 'utf8') > POLICY_MAX_BYTES) return { kind: 'error', policy: null, stamp: lastStamp };
    const { policy } = parsePolicy(text);
    if (!policy) return { kind: 'error', policy: null, stamp: lastStamp };
    return { kind: 'ok', policy, stamp };
}

// The live policy. `onChange(prev, next)` runs after the swap, only when the
// effective flag changed; server.js purges unsealed request rooms there.
function createPolicyStore({ path = '', onChange = () => {}, log = (line) => console.log(line) } = {}) {
    let current = DEFAULT_POLICY;
    let stamp = null;
    let failing = false;

    function swap(next) {
        const prev = current;
        current = next; // one assignment: a reader sees the old or the new object, never a mix
        if (prev.requestLinks !== next.requestLinks) {
            log(next.requestLinks ? LOG_ON : LOG_OFF);
            onChange(prev, next);
        }
    }

    return {
        current: () => current,
        requestLinks: () => current.requestLinks === true,
        // Returns the outcome kind, for tests. Never throws on anything the
        // file can contain; the cleanup tick still wraps it.
        reload() {
            const r = readPolicyFile(path, stamp);
            if (r.kind === 'error') {
                if (!failing) log(LOG_UNREADABLE);
                failing = true;
                return 'error';
            }
            failing = false;
            if (r.kind === 'unchanged') return 'unchanged';
            stamp = r.stamp;
            swap(r.policy);
            return r.kind;
        },
        // Test seam: install a policy as if a file had said it. The stamp is
        // cleared so the next reload reads the file again.
        apply(object) {
            const { policy } = parsePolicy(JSON.stringify(object === undefined ? null : object));
            stamp = null;
            failing = false;
            swap(policy || DEFAULT_POLICY);
        },
    };
}

module.exports = {
    DEFAULT_POLICY,
    POLICY_MAX_BYTES,
    parsePolicy,
    readPolicyFile,
    createPolicyStore,
};
