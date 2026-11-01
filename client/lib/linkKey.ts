// The link key k: 16 random bytes that ride a link's fragment and no server ever
// sees. Each side proves it holds them after DTLS opens (transfer/keyCheck.ts), so
// a signaling server that steps in between two peers is caught.
//
// k must never reach a log, a Sentry event, an analytics payload, a server request,
// a stored file or an error string. The class is how that holds by accident as well
// as on purpose: a key that strays into a context or a state object serializes as
// a fixed placeholder (Sentry's normalize calls toJSON first), its text and bytes
// live in a module WeakMap where no object walk finds them, and the only route back
// to text is linkKeyText, for the code that builds a link.

import { getRoomFromUrl, isValidRoomId } from './roomLink';

/** 22 unpadded base64url characters, canonical: the last one carries 2 data bits,
 *  so only A, Q, g and w can end a key. Twin of linkkey.Parse in cli/engine/linkkey. */
export const LINK_KEY_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;

const KEY_BYTES = 16;
const PLACEHOLDER = '[link key]';

const material = new WeakMap<LinkKey, { text: string; bytes: Uint8Array }>();

export class LinkKey {
    constructor(bytes: Uint8Array) {
        if (bytes.length !== KEY_BYTES) throw new Error('a link key is 16 bytes');
        const own = new Uint8Array(bytes);
        material.set(this, { text: base64UrlEncode(own), bytes: own });
    }

    toString(): string {
        return PLACEHOLDER;
    }

    toJSON(): string {
        return PLACEHOLDER;
    }
}

function materialOf(k: LinkKey): { text: string; bytes: Uint8Array } {
    const found = material.get(k);
    if (!found) throw new Error('not a link key');
    return found;
}

/** A new key from the browser's CSPRNG. `fill` is a seam for tests. */
export function makeLinkKey(fill: (bytes: Uint8Array<ArrayBuffer>) => unknown = (b) => crypto.getRandomValues(b)): LinkKey {
    const bytes = new Uint8Array(KEY_BYTES);
    fill(bytes);
    return new LinkKey(bytes);
}

/** The key a string names, or null for anything that is not one canonical key. The
 *  text came from a link the other party wrote, and is never quoted in an error. */
export function parseLinkKey(text: unknown): LinkKey | null {
    if (typeof text !== 'string' || !LINK_KEY_RE.test(text)) return null;
    return new LinkKey(base64UrlDecode(text, KEY_BYTES));
}

/** The key as link text. For the code that builds a link, and nothing else. */
export function linkKeyText(k: LinkKey): string {
    return materialOf(k).text;
}

/** A copy of the key's bytes, for the HMAC. */
export function linkKeyBytes(k: LinkKey): Uint8Array<ArrayBuffer> {
    return new Uint8Array(materialOf(k).bytes);
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url of `bytes`. */
export function base64UrlEncode(bytes: Uint8Array): string {
    let out = '';
    let acc = 0;
    let bits = 0;
    for (const byte of bytes) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += BASE64URL[(acc >> bits) & 63];
        }
        acc &= (1 << bits) - 1;
    }
    if (bits > 0) out += BASE64URL[(acc << (6 - bits)) & 63];
    return out;
}

/** The `byteLength` bytes that canonical base64url text names. Validation is the
 *  caller's, a regex that fixes the length, the alphabet and the padding bits. */
export function base64UrlDecode(text: string, byteLength: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(byteLength);
    let acc = 0;
    let bits = 0;
    let at = 0;
    for (let i = 0; i < text.length && at < byteLength; i++) {
        acc = (acc << 6) | BASE64URL.indexOf(text[i]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[at++] = (acc >> bits) & 0xff;
            acc &= (1 << bits) - 1;
        }
    }
    return out;
}

export interface ShareFragment {
    /** The room to join, or null. Read `incomplete` first. */
    room: string | null;
    key: LinkKey | null;
    /** The link was cut or damaged: show Link Invalid, and never read this as the
     *  sender page or as a keyless join. */
    incomplete: boolean;
}

/**
 * What a share link's URL says. `hash` and `search` are passed in, as in
 * getRoomFromUrl, so this stays testable without a window.
 *
 * With no `k` in the fragment, `room` is exactly what getRoomFromUrl has always
 * answered, the legacy ?room= query included, so a keyless link behaves as it did.
 * The one addition is B14: a fragment that carries `room` and leaves no valid room
 * is incomplete, because a page that took a cut link for "no room" opened the sender
 * view instead of the Link Invalid card.
 *
 * With a `k`, the link is whole only with exactly one k that parses and exactly one
 * `room` in the fragment that passes isValidRoomId. Anything else is incomplete with
 * neither value, so no caller can drop the key and join: that would be a downgrade.
 * The ?room= query is never read here, for the same reason. Parameter order is free
 * and an unknown parameter is ignored.
 */
export function readShareFragment(hash: string, search: string): ShareFragment {
    const fragment = new URLSearchParams(hash.replace(/^#/, ''));
    if (!fragment.has('k')) {
        const room = getRoomFromUrl(hash, search);
        const incomplete = fragment.has('room') && (room === null || !isValidRoomId(room));
        return { room, key: null, incomplete };
    }
    const keys = fragment.getAll('k');
    const rooms = fragment.getAll('room');
    const key = keys.length === 1 ? parseLinkKey(keys[0]) : null;
    if (key === null || rooms.length !== 1 || !isValidRoomId(rooms[0])) {
        return { room: null, key: null, incomplete: true };
    }
    return { room: rooms[0], key, incomplete: false };
}
