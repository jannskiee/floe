// Floe connection verification code. Mirrors cli/engine/verify/verify.go and MUST
// stay in sync with it so a browser peer computes the same code as a CLI/desktop
// peer.
//
// WebRTC data channels are encrypted with DTLS, but the certificate fingerprints
// are exchanged through the signaling server, which could swap them and MITM the
// "peer to peer" connection (RFC 8827). Comparing this code out of band reveals a
// mismatch if a fingerprint was altered. This is the ZRTP / Signal "safety
// number" model.

function normalize(fp: string): string {
    return fp.trim().toUpperCase();
}

/**
 * verifyCode derives the shared verification code from the two DTLS fingerprints
 * of a connection (as they appear in the SDP, e.g. "sha-256 AB:CD:..."). The
 * inputs are sorted, so both peers compute the same code unless a fingerprint was
 * altered in transit.
 */
export async function verifyCode(fpA: string, fpB: string): Promise<string> {
    const pair = [normalize(fpA), normalize(fpB)].sort();
    const data = new TextEncoder().encode(pair[0] + '\n' + pair[1]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    // Big-endian uint32 of the first 4 bytes, mod 1e8, as "NNNN NNNN".
    const u32 = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
    const n = u32 % 100000000;
    const pad = (x: number) => x.toString().padStart(4, '0');
    return `${pad(Math.floor(n / 10000))} ${pad(n % 10000)}`;
}

/** extractFingerprint returns the value of the first "a=fingerprint:" line in an
 *  SDP (e.g. "sha-256 AB:CD:..."), or "" if absent. */
export function extractFingerprint(sdp?: string | null): string {
    if (!sdp) return '';
    for (const line of sdp.split('\n')) {
        const t = line.trim();
        if (t.startsWith('a=fingerprint:')) return t.slice('a=fingerprint:'.length).trim();
    }
    return '';
}
