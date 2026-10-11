import React, { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

// Every row was rechecked against the code on 2026-10-11 (server/server.js,
// server/turn.js, server/stats.js, server/ratekey.js). When one of them
// changes, this list changes with it: the lede calls it complete.
const handled: ReactNode[] = [
    // handleSignal walks each signal for its size and shape (signalFits) and
    // relays it; nothing is kept or logged.
    'WebRTC offers, answers, and ICE candidates',
    // rooms and roomMeta, both deleted in destroyRoom. The room id is the secret
    // half of a share link, and no console call ever prints it.
    'The room id that pairs two devices, which is the secret part of a share link, held in memory while the room is open',
    // codeToRoom: forgetCode retires a code at pairing (handleJoinRoom), when
    // the room is destroyed and on re-register; the 10 min TTL is the ceiling.
    'A short room code when the sender uses the CLI or desktop app, dropped when the receiver joins or the room closes, and after about 10 minutes at the latest',
    // turn.js: CF_TURN_TTL and the coturn ttl are both 24 h. On floe.one one set
    // is shared by every client inside a 5 minute window (CF_CACHE_MS).
    'TURN relay credentials, valid for 24 hours and not tied to you or an account',
    'One anonymous running total of bytes for the public counter',
    // The lede promises this is the COMPLETE list, so the per-IP rate limiting in
    // server.js has to appear here or the promise is false. The limiter maps
    // hold a rate key for a 60 s window plus a 60 s sweep; the peer object holds
    // it for as long as its socket is open (createSocketIOPeer, createWSPeer).
    'Your IP address, in memory while your device is connected and, to rate-limit abuse, for up to about two minutes after its last request',
    // The room seal (roomMeta.keys, sealDigest): an HMAC-SHA256 of the rate key
    // (an IPv4 address in full, an IPv6 /64) of every peer that has routed a
    // signal in an ordinary room, under a secret drawn once per process. Deleted
    // with the room in destroyRoom. Not kept for a request room (handleSignal).
    'While a room is open, a keyed hash of the network address (IPv4 in full, IPv6 by its /64) of each device that has sent connection messages through it, never the address itself, so that a third network cannot take a seat',
    // Request links (server.js request rooms, D-130, D-176): the reservation
    // keeps SHA-256(hostToken), never the token, with its own times (createdAt,
    // seatedAt, hostAbsentSince, endsAt); a sealed close leaves a used
    // mark for 24 h, and every other end an ended mark (endedLinks: the room id
    // and the end time only) until 24 h after the link's end, which for a link that
    // lapsed while its PC was away can be its whole life later (W3 R1-02,
    // C1-01); requestCreates keeps create times, and liveByKey
    // the count of open links, under sealDigest(rateKey) for the 20-a-day and
    // 10-open budgets. The grace sweep makes "about 10 minutes" 10 to 11. All in
    // memory. No denylist exists (E-25). "Room id" here is the UUID after the #
    // of a request link; the link id before it never reaches this server.
    'For a request link, a hash of its secret token and its timestamps (made, joined, left, due to end) while the link is open and for about 10 minutes after Floe Desktop disconnects, then its room id with a mark that it was used or ended, until a day after it closes or ends',
    'For 24 hours, when each network made new request links, under a keyed hash of its address',
    'While request links are open, how many each network has open, under the same keyed hash',
];

const neverSees: ReactNode[] = [
    'Your files, file names, or folder structure',
    // The server is handed the room id itself (join-room, the roomId a browser
    // receiver puts beside each signal, and POST /api/code from the CLI and the
    // desktop app), so "your share link" cannot sit in this column. What stays
    // true is where the fragment never travels.
    <>
        Your share link in a page request, referrer, or analytics event. The{' '}
        <code className="font-mono text-[12px] text-zinc-300">#room</code> fragment travels in none
        of them; the server is handed the room id by the devices themselves, to pair them, and
        writes it to no log
    </>,
    "The link id in a request link's address (the part before the #), which only the web host sees",
    'Any transfer traffic. Once the peers connect, the data channel bypasses it entirely',
    'Relayed traffic in the clear. Relay packets stay encrypted end to end',
];

function LedgerColumn({
    label,
    marker,
    markerClass,
    items,
}: {
    label: string;
    marker: string;
    markerClass: string;
    items: ReactNode[];
}) {
    return (
        <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
            <ul className="mt-5 border-t border-white/[0.06]">
                {items.map((item, i) => (
                    <li
                        key={i}
                        className="flex items-baseline gap-3 border-b border-white/[0.06] py-3.5 text-sm leading-relaxed text-zinc-400"
                    >
                        <span className={`select-none font-mono text-xs ${markerClass}`} aria-hidden="true">
                            {marker}
                        </span>
                        <span>{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function PrivacySection() {
    return (
        <section className={sectionClass}>
            <SectionHeader
                eyebrow="Privacy"
                headline="The server can't read what it never receives."
                lede="Floe's signaling server exists to introduce two devices, and that is all it does. This is the complete list."
            />
            <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-12">
                <LedgerColumn
                    label="The signaling server handles"
                    marker="&rarr;"
                    markerClass="text-zinc-600"
                    items={handled}
                />
                <LedgerColumn
                    label="It never sees"
                    marker="&#10005;"
                    markerClass="text-ice/60"
                    items={neverSees}
                />
            </div>
            <div className="mt-10">
                <a
                    href="https://www.floe.one/docs/security-privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-1.5 text-sm text-zinc-300 transition hover:text-ice"
                >
                    Read the security model
                    <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 transition group-hover:text-ice" />
                </a>
            </div>
        </section>
    );
}
