import { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

// The short version on purpose: the owner asked on 2026-11-05 for only the
// things that matter most, so nothing here may call this list complete. The full
// list is docs/security-privacy.mdx, "What the signaling server can see", which
// the link below the columns opens. client/app/privacy/page.tsx states most of it,
// but not the Origin check or a request link's times. When what the server keeps
// changes, those two change; this list changes only when one of its rows stops
// being true. All four rows were rechecked against server/ on 2026-11-05.
const handled: ReactNode[] = [
    // handleSignal walks each signal for its size and shape (signalFits) and
    // relays it; nothing is kept or logged. Candidates carry network addresses.
    'The messages two devices trade to connect, which carry their network addresses',
    // rooms and roomMeta hold the room id, and no console call ever prints it. A
    // request room's id can stay for a day after the link ends (usedMarkers,
    // endedLinks), which is why this row names no duration. codeToRoom holds a
    // code: forgetCode retires it at pairing, when the room is destroyed and on
    // re-register, and the 10 min TTL is the ceiling. "The server's own log" and
    // not "no log" because a code travels in the path of GET /api/code/:code, and a
    // proxy in front of the server may log paths.
    "The room id in your link, or a short room code, held in memory and never in the server's own log",
    // The limiter maps hold a rate key for a 60 s window plus a 60 s sweep; the peer
    // object holds it for as long as its socket is open (createSocketIOPeer,
    // createWSPeer).
    'Your IP address, in memory while your device is connected and, to rate-limit abuse, for up to about two minutes after its last request',
    'One anonymous running total of bytes for the public counter',
];

const neverSees: ReactNode[] = [
    'Your files, file names, or folder structure',
    // The server is handed the room id itself (join-room, the roomId a browser
    // receiver puts beside each signal, and POST /api/code from the CLI and the
    // desktop app), so "your share link" cannot sit in this column. What stays
    // true is where the fragment never travels.
    <>
        The <code className="font-mono text-[12px] text-zinc-300">#room</code> part of your share
        link in any page request, referrer, or analytics event. It travels in none of them
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
                        <span className="text-pretty">{item}</span>
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
                lede="Floe's signaling server exists to introduce two devices. These are the main things it handles."
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
            {/* The two lists above are the signaling server's. The website has
                two tools of its own (UmamiScript.tsx, sentry.client.config.ts),
                and a reader who stops at this section should not conclude it
                has none. Floe Desktop and the CLI import neither. */}
            <p className="mt-10 max-w-2xl text-sm leading-relaxed text-zinc-500">
                The floe.one website also runs cookieless analytics (Umami) and error monitoring
                (Sentry). Floe Desktop and the CLI have neither. What they do send is in the{' '}
                <a
                    href="/privacy"
                    className="text-zinc-400 underline decoration-white/20 underline-offset-2 transition hover:text-ice"
                >
                    privacy policy
                </a>
                .
            </p>
            <div className="mt-6">
                <a
                    href="https://www.floe.one/docs/security-privacy#what-the-signaling-server-can-see"
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-1.5 text-sm text-zinc-300 transition hover:text-ice"
                >
                    See the full list in the security model
                    <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 transition group-hover:text-ice" />
                </a>
            </div>
        </section>
    );
}
