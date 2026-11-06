// The pure half of the link-key check: which certificates are bound, the tag over
// them, its frame, and the guard on signals. Fake RTCPeerConnection objects stand in
// for a browser; the shapes come from captured Firefox and Chromium SDP, and the
// shared vector file ties the result to the Go engine and to real certificates.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseLinkKey, type LinkKey } from '../linkKey';
import { classifyControl, type KeyCheckFrame } from './protocol';
import {
    KC_TAG_RE,
    certHashes,
    createSignalGate,
    kcFrame,
    keyCheckTag,
    parseKeyCheckTag,
    tagsEqual,
    type CertSource,
} from './keyCheck';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

/** Colon-separated upper-case hex, as every stack writes a fingerprint. */
const printed = (bytes: Uint8Array) =>
    [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

const VECTORS = JSON.parse(
    readFileSync(new URL('../../../cli/engine/transfer/testdata/keycheck-vectors.json', import.meta.url), 'utf8')
) as {
    tagRows: Array<{ name: string; key: string; roomId: string; role: 's' | 'r'; hS: string; hR: string; tag: string }>;
    certRows: Array<{ name: string; source: string; der: string; fingerprint: string; algorithm: string }>;
};

const LOCAL = sha(new TextEncoder().encode('local certificate'));
const REMOTE = sha(new TextEncoder().encode('remote certificate'));
const DER = new TextEncoder().encode('remote DER bytes');
const DER_HASH = sha(DER);
const derBuffer = () => DER.buffer.slice(DER.byteOffset, DER.byteOffset + DER.byteLength) as ArrayBuffer;

const CRLF = '\r\n';

/** The shape Firefox writes: one fingerprint at session level. */
function firefoxSdp(fingerprint: Uint8Array): string {
    return [
        'v=0',
        'o=mozilla...THIS_IS_SDPARTA-99.0 1234 0 IN IP4 0.0.0.0',
        's=-',
        't=0 0',
        'a=sendrecv',
        `a=fingerprint:sha-256 ${printed(fingerprint)}`,
        'a=group:BUNDLE 0',
        'a=ice-options:trickle',
        'a=msid-semantic:WMS *',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=sendrecv',
        'a=ice-pwd:0123456789abcdef0123456789abcdef',
        'a=ice-ufrag:abcdefgh',
        'a=mid:0',
        'a=setup:actpass',
        'a=sctp-port:5000',
        'a=max-message-size:1073741823',
        '',
    ].join(CRLF);
}

/** The shape Chromium writes: one fingerprint inside the one media section. */
function chromiumSdp(fingerprint: Uint8Array): string {
    return [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'a=extmap-allow-mixed',
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=ice-ufrag:abcd',
        'a=ice-pwd:0123456789abcdef01234567',
        'a=ice-options:trickle',
        `a=fingerprint:sha-256 ${printed(fingerprint)}`,
        'a=setup:actpass',
        'a=mid:0',
        'a=sctp-port:5000',
        'a=max-message-size:262144',
        '',
    ].join(CRLF);
}

/** The critic's BUNDLE offer: no session line, a dummy first section holding the
 *  honest fingerprint, and BUNDLE naming a second section that holds the attacker's. */
function bundleOnSecondSdp(honest: Uint8Array, attacker: Uint8Array): string {
    return [
        'v=0',
        'o=- 1 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE 0',
        'm=text 9 UDP/TLS/RTP/SAVPF 96',
        'a=mid:x',
        `a=fingerprint:sha-256 ${printed(honest)}`,
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'a=mid:0',
        `a=fingerprint:sha-256 ${printed(attacker)}`,
        '',
    ].join(CRLF);
}

function dtlsWith(getRemoteCertificates: unknown) {
    return { sctp: { transport: { getRemoteCertificates } } };
}

function pc(fields: {
    local?: string | null;
    remote?: string | null;
    sctp?: unknown;
}): CertSource {
    const { local = chromiumSdp(LOCAL), remote = chromiumSdp(REMOTE), sctp = dtlsWith(() => [derBuffer()]).sctp } = fields;
    return {
        localDescription: local === null ? null : { sdp: local },
        remoteDescription: remote === null ? null : { sdp: remote },
        sctp,
    } as unknown as CertSource;
}

describe('certHashes: the DER path', () => {
    it('hashes the certificate DTLS actually used, and takes the local hash from the page\'s own SDP', () => {
        const got = certHashes(pc({}), 'sender', { sdpFallback: true });
        expect(got).not.toBeNull();
        expect(got?.path).toBe('der');
        expect(hex(got!.hS)).toBe(hex(LOCAL));
        expect(hex(got!.hR)).toBe(hex(DER_HASH));
    });

    it('maps the two hashes by file role, whichever side offered', () => {
        const got = certHashes(pc({}), 'receiver', { sdpFallback: true });
        expect(hex(got!.hS)).toBe(hex(DER_HASH));
        expect(hex(got!.hR)).toBe(hex(LOCAL));
    });

    it('calls the method on the transport, as a browser needs', () => {
        const transport = {
            getRemoteCertificates(this: unknown) {
                if (this !== transport) throw new TypeError('Illegal invocation');
                return [derBuffer()];
            },
        };
        expect(certHashes(pc({ sctp: { transport } }), 'sender', { sdpFallback: false })?.path).toBe('der');
    });

    it('never looks at the remote SDP when the API answers', () => {
        // The remote description here could not pass the fallback's shape rules.
        const got = certHashes(pc({ remote: bundleOnSecondSdp(LOCAL, REMOTE) }), 'sender', { sdpFallback: true });
        expect(got?.path).toBe('der');
        expect(hex(got!.hR)).toBe(hex(DER_HASH));
    });

    it('takes the first certificate of the chain', () => {
        const other = new TextEncoder().encode('an issuer');
        const got = certHashes(pc({ sctp: dtlsWith(() => [derBuffer(), other.buffer]).sctp }), 'sender', { sdpFallback: false });
        expect(hex(got!.hR)).toBe(hex(DER_HASH));
    });
});

describe('certHashes: the local fingerprint', () => {
    const local = (sdp: string | null) => certHashes(pc({ local: sdp }), 'sender', { sdpFallback: false });

    it('reads a Firefox-shaped session line and a Chromium-shaped media line alike', () => {
        expect(hex(local(firefoxSdp(LOCAL))!.hS)).toBe(hex(LOCAL));
        expect(hex(local(chromiumSdp(LOCAL))!.hS)).toBe(hex(LOCAL));
    });

    it('ignores case and colons in the hex', () => {
        const lower = chromiumSdp(LOCAL).replace(printed(LOCAL), printed(LOCAL).toLowerCase());
        const bare = chromiumSdp(LOCAL).replace(printed(LOCAL), hex(LOCAL));
        expect(hex(local(lower)!.hS)).toBe(hex(LOCAL));
        expect(hex(local(bare)!.hS)).toBe(hex(LOCAL));
    });

    it('takes several sha-256 lines when every one agrees, as a page with more sections writes', () => {
        const sdp = chromiumSdp(LOCAL) + `m=application 9 UDP/DTLS/SCTP webrtc-datachannel${CRLF}a=fingerprint:sha-256 ${printed(LOCAL)}${CRLF}`;
        expect(hex(local(sdp)!.hS)).toBe(hex(LOCAL));
    });

    it('fails closed when two sha-256 lines disagree', () => {
        const sdp = chromiumSdp(LOCAL) + `a=fingerprint:sha-256 ${printed(REMOTE)}${CRLF}`;
        expect(local(sdp)).toBeNull();
    });

    it('ignores another algorithm beside a sha-256 line, and fails closed with no sha-256 line at all', () => {
        const both = chromiumSdp(LOCAL).replace('a=setup:actpass', `a=fingerprint:sha-1 ${printed(LOCAL.subarray(0, 20))}${CRLF}a=setup:actpass`);
        expect(hex(local(both)!.hS)).toBe(hex(LOCAL));
        const none = chromiumSdp(LOCAL).replace('sha-256', 'sha-512');
        expect(local(none)).toBeNull();
        expect(local('v=0\r\n')).toBeNull();
        expect(local('')).toBeNull();
    });

    it('fails closed on a value that is not 32 bytes of hex', () => {
        for (const value of [printed(LOCAL.subarray(0, 31)), printed(LOCAL) + ':00', printed(LOCAL).replace(/^../, 'GG'), '']) {
            expect(local(`a=fingerprint:sha-256 ${value}${CRLF}`), value).toBeNull();
        }
    });

    it('fails closed with no local description', () => {
        expect(local(null)).toBeNull();
    });
});

describe('certHashes: when the fallback is allowed', () => {
    const missing: Array<[string, unknown]> = [
        ['pc.sctp is null', null],
        ['pc.sctp is undefined', undefined],
        ['transport is null', { transport: null }],
        ['the method is missing', { transport: {} }],
        ['the method is not a function', dtlsWith(7).sctp],
        ['it returns an empty list', dtlsWith(() => []).sctp],
        ['it returns nothing', dtlsWith(() => undefined).sctp],
        ['it throws', dtlsWith(() => { throw new Error('not implemented'); }).sctp],
        ['the first entry is not an ArrayBuffer', dtlsWith(() => ['MII']).sctp],
        ['the first entry is a view, not an ArrayBuffer', dtlsWith(() => [new Uint8Array(4)]).sctp],
        ['the first entry is empty', dtlsWith(() => [new ArrayBuffer(0)]).sctp],
    ];

    for (const [name, sctp] of missing) {
        it(`${name}: reads the SDP when the lever allows, and fails closed when it does not`, () => {
            const source = pc({ sctp: sctp ?? null });
            const got = certHashes(source, 'sender', { sdpFallback: true });
            expect(got?.path).toBe('sdp');
            expect(hex(got!.hR)).toBe(hex(REMOTE));
            expect(certHashes(source, 'sender', { sdpFallback: false })).toBeNull();
        });
    }

    it('a throwing pc.sctp getter counts the same way', () => {
        const source = {
            localDescription: { sdp: chromiumSdp(LOCAL) },
            remoteDescription: { sdp: chromiumSdp(REMOTE) },
            get sctp(): null {
                throw new Error('closed');
            },
        } as unknown as CertSource;
        expect(certHashes(source, 'sender', { sdpFallback: true })?.path).toBe('sdp');
        expect(certHashes(source, 'sender', { sdpFallback: false })).toBeNull();
    });

    it('maps the fallback\'s hashes by file role too', () => {
        const got = certHashes(pc({ sctp: null }), 'receiver', { sdpFallback: true });
        expect(hex(got!.hS)).toBe(hex(REMOTE));
        expect(hex(got!.hR)).toBe(hex(LOCAL));
    });
});

describe('certHashes: the strict shape of a remote description', () => {
    const remote = (sdp: string | null) => certHashes(pc({ remote: sdp, sctp: null }), 'sender', { sdpFallback: true });
    const refused = (sdp: string | null, why: string) => expect(remote(sdp), why).toBeNull();

    it('takes Firefox shape, a session-level fingerprint in front of the one media section', () => {
        expect(hex(remote(firefoxSdp(REMOTE))!.hR)).toBe(hex(REMOTE));
    });

    it('takes Chromium shape, a media-level fingerprint in the one media section', () => {
        expect(hex(remote(chromiumSdp(REMOTE))!.hR)).toBe(hex(REMOTE));
    });

    it('takes a description split on bare newlines, and one that mixes the two endings', () => {
        const lines = chromiumSdp(REMOTE).split(CRLF);
        expect(hex(remote(lines.join('\n'))!.hR)).toBe(hex(REMOTE));
        expect(hex(remote(lines.map((l, i) => l + (i % 2 ? '\n' : '\r\n')).join(''))!.hR)).toBe(hex(REMOTE));
    });

    it('takes upper or lower case hex', () => {
        const lower = chromiumSdp(REMOTE).replace(printed(REMOTE), printed(REMOTE).toLowerCase());
        expect(hex(remote(lower)!.hR)).toBe(hex(REMOTE));
    });

    it('refuses two fingerprints, even of different algorithms', () => {
        refused(chromiumSdp(REMOTE).replace('a=setup:actpass', `a=fingerprint:sha-1 ${printed(REMOTE.subarray(0, 20))}${CRLF}a=setup:actpass`), 'sha-256 and sha-1');
        refused(chromiumSdp(REMOTE).replace('a=setup:actpass', `a=fingerprint:sha-256 ${printed(LOCAL)}${CRLF}a=setup:actpass`), 'two sha-256 values');
    });

    it('refuses a session line plus a media line, even when both say the same thing', () => {
        const both = firefoxSdp(REMOTE).replace('a=mid:0', `a=fingerprint:sha-256 ${printed(REMOTE)}${CRLF}a=mid:0`);
        refused(both, 'session plus media level');
    });

    it('refuses two m= sections, the BUNDLE offer that fools a first-line reader', () => {
        refused(bundleOnSecondSdp(REMOTE, LOCAL), 'BUNDLE on the second section');
        // Still two m= lines with only one fingerprint in the whole description.
        const oneFingerprint = chromiumSdp(REMOTE) + `m=text 9 UDP/TLS/RTP/SAVPF 96${CRLF}a=mid:x${CRLF}`;
        refused(oneFingerprint, 'two sections, one fingerprint');
    });

    it('refuses a line that still holds a carriage return, wherever it sits', () => {
        const base = chromiumSdp(REMOTE);
        const line = `a=fingerprint:sha-256 ${printed(REMOTE)}`;
        refused(base.replace(line, `\r${line}`), 'a CR leading the fingerprint line');
        refused(base.replace(line, `${line}\r`), 'two CRs ending the fingerprint line');
        refused(base.replace('a=mid:0', '\ra=mid:0'), 'a CR leading another line');
        refused(base.replace('a=mid:0', `a=mid:0\r${line}`), 'a line hidden behind a bare CR');
        refused(base.replace('m=application', '\rm=application'), 'a CR leading the m= line');
    });

    it('refuses anything but sha-256 as the one fingerprint', () => {
        refused(chromiumSdp(REMOTE).replace('sha-256', 'sha-512'), 'sha-512');
        refused(chromiumSdp(REMOTE).replace('sha-256', 'sha-1'), 'sha-1');
        refused(chromiumSdp(REMOTE).replace(`sha-256 ${printed(REMOTE)}`, printed(REMOTE)), 'no algorithm');
    });

    it('refuses a fingerprint value that does not decode to 32 bytes', () => {
        const line = `sha-256 ${printed(REMOTE)}`;
        for (const value of [printed(REMOTE.subarray(0, 31)), `${printed(REMOTE)}:00`, printed(REMOTE).replace(/^../, 'GG'), '', ' ', `${printed(REMOTE)} `, ` ${printed(REMOTE)}`]) {
            refused(chromiumSdp(REMOTE).replace(line, `sha-256 ${value}`), JSON.stringify(value));
        }
    });

    it('counts a fingerprint line however it is cased, so a second one cannot hide', () => {
        const hidden = chromiumSdp(REMOTE).replace('a=setup:actpass', `A=FINGERPRINT:sha-256 ${printed(LOCAL)}${CRLF}a=setup:actpass`);
        refused(hidden, 'an upper-case second line');
    });

    it('counts an m= line however it is cased, so a second one cannot hide', () => {
        const hidden = chromiumSdp(REMOTE).replace('a=setup:actpass', `M=application 9 UDP/DTLS/SCTP webrtc-datachannel${CRLF}a=setup:actpass`);
        refused(hidden, 'an upper-case second section');
    });

    it('refuses a description with no m= line or no fingerprint', () => {
        refused(chromiumSdp(REMOTE).replace(/m=application[^\r]*\r\n/, ''), 'no m= line');
        refused(chromiumSdp(REMOTE).replace(/a=fingerprint[^\r]*\r\n/, ''), 'no fingerprint');
        refused('', 'empty');
        refused(null, 'no remote description');
    });

    it('refuses a value that is not a string', () => {
        const source = { ...pc({ sctp: null }), remoteDescription: { sdp: 7 } } as unknown as CertSource;
        expect(certHashes(source, 'sender', { sdpFallback: true })).toBeNull();
    });
});

describe('certHashes: what it reads', () => {
    it('takes a real RTCPeerConnection, whatever a test passes', () => {
        // Checked by tsc: this file is in the project, and the call is the proof.
        expectTypeOf<RTCPeerConnection>().toExtend<CertSource>();
    });
});

describe('certHashes: nothing to read', () => {
    it('fails closed for a peer with no connection left', () => {
        expect(certHashes(undefined, 'sender', { sdpFallback: true })).toBeNull();
        expect(certHashes(null, 'receiver', { sdpFallback: true })).toBeNull();
    });

    it('never throws out of a connection that does', () => {
        const hostile = {
            get localDescription(): never {
                throw new Error('closed');
            },
        } as unknown as CertSource;
        expect(certHashes(hostile, 'sender', { sdpFallback: true })).toBeNull();
    });
});

describe('keyCheckTag', () => {
    const key = parseLinkKey('AAAAAAAAAAAAAAAAAAAAAA') as LinkKey;

    it('holds rows in the shared vector file', () => {
        expect(VECTORS.tagRows.length).toBeGreaterThan(4);
    });

    for (const row of VECTORS.tagRows) {
        it(`tagRows ${row.name}: equals the independent HMAC`, () => {
            const k = parseLinkKey(row.key) as LinkKey;
            const tag = keyCheckTag(k, row.role === 's' ? 'sender' : 'receiver', row.roomId, unhex(row.hS), unhex(row.hR));
            expect(Buffer.from(tag).toString('base64url')).toBe(row.tag);
            expect(KC_TAG_RE.test(row.tag)).toBe(true);
        });
    }

    it('writes the message the wire spec names, byte for byte', () => {
        const room = '6f207790-92a6-4662-bb68-4c4059f75139';
        const message = Buffer.concat([
            Buffer.from('floe-kc-v1'),
            Buffer.from([0x00, 0x72, room.length]),
            Buffer.from(room),
            Buffer.from(LOCAL),
            Buffer.from(REMOTE),
        ]);
        const want = createHmac('sha256', Buffer.alloc(16, 0)).update(message).digest('hex');
        expect(hex(keyCheckTag(key, 'receiver', room, LOCAL, REMOTE))).toBe(want);
    });

    it('binds the role, the room as held, both hashes and their order', () => {
        const base = hex(keyCheckTag(key, 'sender', 'room', LOCAL, REMOTE));
        expect(hex(keyCheckTag(key, 'receiver', 'room', LOCAL, REMOTE))).not.toBe(base);
        expect(hex(keyCheckTag(key, 'sender', 'ROOM', LOCAL, REMOTE))).not.toBe(base);
        expect(hex(keyCheckTag(key, 'sender', 'room', REMOTE, LOCAL))).not.toBe(base);
        expect(hex(keyCheckTag(parseLinkKey('AAAAAAAAAAAAAAAAAAAAAQ') as LinkKey, 'sender', 'room', LOCAL, REMOTE))).not.toBe(base);
    });

    it('measures the room id in bytes, and takes 1 to 255 of them', () => {
        expect(keyCheckTag(key, 'sender', 'x', LOCAL, REMOTE)).toHaveLength(32);
        expect(keyCheckTag(key, 'sender', 'x'.repeat(255), LOCAL, REMOTE)).toHaveLength(32);
        expect(() => keyCheckTag(key, 'sender', 'x'.repeat(256), LOCAL, REMOTE)).toThrow();
        expect(() => keyCheckTag(key, 'sender', '', LOCAL, REMOTE)).toThrow();
        // 128 characters, 256 bytes.
        expect(() => keyCheckTag(key, 'sender', 'é'.repeat(128), LOCAL, REMOTE)).toThrow();
    });

    it('refuses a hash that is not 32 bytes, so the message stays unambiguous', () => {
        expect(() => keyCheckTag(key, 'sender', 'room', LOCAL.subarray(0, 31), REMOTE)).toThrow();
        expect(() => keyCheckTag(key, 'sender', 'room', LOCAL, new Uint8Array(33))).toThrow();
    });

    it('throws fixed words that name neither the key nor the room', () => {
        const secretRoom = 'x'.repeat(300);
        let message = '';
        try {
            keyCheckTag(key, 'sender', secretRoom, LOCAL, REMOTE);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain('xxx');
        expect(message).not.toContain('AAAA');
    });
});

describe('certRows of the shared vector file: a certificate hashes to what its stack announced', () => {
    it('are all sha-256 rows, each naming the stack it came from', () => {
        for (const row of VECTORS.certRows) {
            expect(row.algorithm, row.name).toBe('sha-256');
            expect(row.source, row.name).toMatch(/^(pion v\d+\.\d+\.\d+|chrome \d+|firefox \d+)$/);
        }
    });

    for (const row of VECTORS.certRows) {
        it(`${row.name} (${row.source})`, () => {
            const der = Buffer.from(row.der, 'base64');
            expect(row.algorithm).toBe('sha-256');
            expect(der.byteLength).toBeGreaterThan(100);
            expect(hex(sha(der))).toBe(row.fingerprint.replace(/:/g, '').toLowerCase());
            // And a browser reading that same certificate gets that hash.
            const buffer = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
            const got = certHashes(pc({ sctp: dtlsWith(() => [buffer]).sctp }), 'sender', { sdpFallback: false });
            expect(hex(got!.hR)).toBe(row.fingerprint.replace(/:/g, '').toLowerCase());
        });
    }
});

describe('kcFrame', () => {
    const tag = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + seed) & 0xff);

    it('writes type first and nothing else, in 65 bytes', () => {
        const frame = kcFrame(new Uint8Array(32));
        expect(frame).toBe('{"type":"kc","tag":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}');
        expect(new TextEncoder().encode(frame).byteLength).toBe(65);
    });

    it('always writes a canonical tag that reads back as the same bytes', () => {
        for (let seed = 0; seed < 256; seed++) {
            const bytes = tag(seed);
            const frame = kcFrame(bytes);
            const msg = classifyControl(frame) as KeyCheckFrame;
            expect(msg.type).toBe('kc');
            expect(KC_TAG_RE.test(msg.tag as string)).toBe(true);
            expect(hex(parseKeyCheckTag(msg)!)).toBe(hex(bytes));
        }
    });

    it('reads back through the bytes a file receiver sends', () => {
        const frame = new TextEncoder().encode(kcFrame(tag(1)));
        expect(hex(parseKeyCheckTag(classifyControl(frame) as KeyCheckFrame)!)).toBe(hex(tag(1)));
    });

    it('refuses to frame anything but a 32-byte tag', () => {
        expect(() => kcFrame(new Uint8Array(31))).toThrow();
        expect(() => kcFrame(new Uint8Array(33))).toThrow();
    });
});

describe('parseKeyCheckTag', () => {
    const VALID = 'A'.repeat(43);
    const of = (value: unknown) => parseKeyCheckTag({ type: 'kc', tag: value });

    it('reads a canonical tag', () => {
        expect(of(VALID)).toEqual(new Uint8Array(32));
        expect(of('xJgBMZk3OsXxCjLFjYdncS5CaBBliB8cBpai84L62Zc')).toHaveLength(32);
    });

    it('refuses everything else, without throwing', () => {
        for (const bad of [
            undefined, null, 7, true, {}, [VALID], { tag: VALID }, '',
            VALID.slice(1), `${VALID}A`, `${VALID}=`, `+${VALID.slice(1)}`, `/${VALID.slice(1)}`, `.${VALID.slice(1)}`,
            `${VALID.slice(0, 42)}B`, `${VALID}\n`, `\n${VALID}`, ` ${VALID}`,
        ]) {
            expect(of(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('takes every last character the two padding bits allow and no other', () => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const accepted = [...alphabet].filter((c) => of(VALID.slice(0, 42) + c) !== null);
        expect(accepted.join('')).toBe('AEIMQUYcgkosw048');
    });

    it('reads its own key by exact name, and never through the prototype', () => {
        expect(parseKeyCheckTag({ type: 'kc' })).toBeNull();
        expect(parseKeyCheckTag(JSON.parse(`{"type":"kc","TAG":"${VALID}"}`) as KeyCheckFrame)).toBeNull();
        expect(parseKeyCheckTag(JSON.parse(`{"type":"kc","__proto__":{"tag":"${VALID}"}}`) as KeyCheckFrame)).toBeNull();
        expect(parseKeyCheckTag(Object.assign(Object.create({ tag: VALID }), { type: 'kc' }) as KeyCheckFrame)).toBeNull();
    });
});

describe('tagsEqual', () => {
    const tag = () => Uint8Array.from({ length: 32 }, (_, i) => i);

    it('holds for equal bytes', () => {
        expect(tagsEqual(tag(), tag())).toBe(true);
    });

    it('notices one flipped bit at every position', () => {
        for (let i = 0; i < 32; i++) {
            for (const mask of [0x01, 0x80]) {
                const other = tag();
                other[i] ^= mask;
                expect(tagsEqual(tag(), other), `byte ${i} mask ${mask}`).toBe(false);
            }
        }
    });

    it('refuses a different length, whichever side is short', () => {
        expect(tagsEqual(tag(), tag().subarray(0, 31))).toBe(false);
        expect(tagsEqual(tag().subarray(0, 31), tag())).toBe(false);
    });

    it('walks every byte: no early exit to time', () => {
        // Counted through a Proxy over the second array: a compare that stopped at
        // the first difference would read one element here, not 32.
        let reads = 0;
        const other = new Proxy(new Uint8Array(32).fill(0xff), {
            get(target, prop) {
                if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
                const value = Reflect.get(target, prop, target) as unknown;
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            },
        });
        expect(tagsEqual(new Uint8Array(32), other)).toBe(false);
        expect(reads).toBe(32);
    });
});

describe('createSignalGate', () => {
    const OFFER = { type: 'offer', sdp: 'v=0' };
    const ANSWER = { type: 'answer', sdp: 'v=0' };
    const CANDIDATE = { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.1.1.1 1 typ host', sdpMid: '0' } };

    it('admits exactly one description of the expected type (the initiator expects an answer)', () => {
        const gate = createSignalGate('answer');
        expect(gate.admit(OFFER)).toBe(false);
        expect(gate.admit(ANSWER)).toBe(true);
        expect(gate.admit(ANSWER)).toBe(false);
        expect(gate.admit(OFFER)).toBe(false);
    });

    it('admits exactly one description of the expected type (the answerer expects an offer)', () => {
        const gate = createSignalGate('offer');
        expect(gate.admit(ANSWER)).toBe(false);
        expect(gate.admit(OFFER)).toBe(true);
        expect(gate.admit(OFFER)).toBe(false);
        expect(gate.admit(ANSWER)).toBe(false);
    });

    it('a description refused for its type does not use up the one allowed', () => {
        const gate = createSignalGate('offer');
        expect(gate.admit(ANSWER)).toBe(false);
        expect(gate.admit(OFFER)).toBe(true);
    });

    it('passes candidates before and after the description, in either form simple-peer reads', () => {
        const gate = createSignalGate('offer');
        expect(gate.admit(CANDIDATE)).toBe(true);
        expect(gate.admit({ candidate: { candidate: 'candidate:2' } })).toBe(true);
        expect(gate.admit(OFFER)).toBe(true);
        expect(gate.admit(CANDIDATE)).toBe(true);
    });

    it('drops every renegotiate and transceiverRequest, on either role, whatever else rides with them', () => {
        for (const expect_ of ['offer', 'answer'] as const) {
            const gate = createSignalGate(expect_);
            expect(gate.admit({ type: 'renegotiate', renegotiate: true })).toBe(false);
            expect(gate.admit({ type: 'transceiverRequest', transceiverRequest: { kind: 'audio' } })).toBe(false);
            expect(gate.admit({ renegotiate: false })).toBe(false);
            // Dropped whole, never stripped: an emptied signal would destroy the peer.
            expect(gate.admit({ ...CANDIDATE, renegotiate: true })).toBe(false);
            expect(gate.admit({ ...CANDIDATE, transceiverRequest: { kind: 'video' } })).toBe(false);
            const description = expect_ === 'offer' ? OFFER : ANSWER;
            expect(gate.admit({ ...description, renegotiate: true })).toBe(false);
            // None of those used up the one description.
            expect(gate.admit(description)).toBe(true);
        }
    });

    it('drops a late description that also carries a candidate, whole', () => {
        const gate = createSignalGate('answer');
        expect(gate.admit(ANSWER)).toBe(true);
        expect(gate.admit({ ...ANSWER, ...CANDIDATE, type: 'answer' })).toBe(false);
    });

    it('drops a signal simple-peer would destroy the peer over, rather than pass it on', () => {
        const gate = createSignalGate('offer');
        for (const bad of [
            null, undefined, '', 'text', '{"type":"offer","sdp":"v=0"}', 7, true, [], [OFFER], {},
            { type: 'offer' }, { candidate: null }, { candidate: '' }, { candidate: 0 },
            { type: 'offer', sdp: '' }, { type: 'offer', sdp: 7 }, { type: 'offer', sdp: {} },
        ]) {
            expect(gate.admit(bad), JSON.stringify(bad) ?? 'undefined').toBe(false);
        }
        // None of them used up the one description.
        expect(gate.admit(OFFER)).toBe(true);
    });

    it('changes nothing about what it is handed', () => {
        const signal = { ...OFFER };
        createSignalGate('offer').admit(signal);
        expect(signal).toEqual(OFFER);
    });

    it('holds its count per gate, one gate to a peer instance', () => {
        const a = createSignalGate('offer');
        const b = createSignalGate('offer');
        expect(a.admit(OFFER)).toBe(true);
        expect(b.admit(OFFER)).toBe(true);
    });
});
