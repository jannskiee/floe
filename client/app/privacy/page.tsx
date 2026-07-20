import React from 'react';
import type { Metadata } from 'next';
import {
    InlineCode,
    LegalCallout,
    LegalList,
    LegalSection,
    LegalShell,
} from '@/components/legal/LegalShell';

export const metadata: Metadata = {
    title: 'Privacy Policy · Floe',
    description:
        'How Floe handles your data: files stream peer to peer and are never stored, and the only tally we keep is one anonymous global byte total.',
    alternates: {
        canonical: '/privacy',
    },
};

const toc = [
    { id: 'transfer', label: 'How the transfer works' },
    { id: 'collect', label: 'Information we collect' },
    { id: 'third-parties', label: 'Third-party services' },
    { id: 'relay', label: 'Relay server' },
    { id: 'errors', label: 'Error monitoring & session replay' },
    { id: 'analytics', label: 'Usage analytics' },
];

export default function PrivacyPolicy() {
    return (
        <LegalShell
            eyebrow="Legal"
            title="Privacy policy"
            updated="Last updated: July 2026"
            toc={toc}
            footerLinks={[
                { name: 'Home', href: '/' },
                { name: 'How it works', href: '/how-it-works' },
                { name: 'Terms', href: '/terms' },
            ]}
            intro={
                <LegalCallout label="The short version" tone="positive">
                    <p>
                        Floe is a <strong className="font-semibold text-zinc-200">peer-to-peer</strong>{' '}
                        file transfer service. Your files stream directly from the sender&apos;s device
                        to the receiver&apos;s device whenever possible.
                    </p>
                    <p>
                        <strong className="font-semibold text-zinc-200">
                            We do not store, view, or process your files.
                        </strong>{' '}
                        In direct connections, files never touch our servers. In relay connections,
                        encrypted file data passes through our TURN server in transit but is never
                        stored or inspected. The only tally we keep is one anonymous number: the
                        running total of bytes transferred across all users, shown by the counter on
                        our homepage. You can opt out of contributing to it at any time. The
                        cookieless, aggregate analytics and error monitoring we use are described
                        below.
                    </p>
                </LegalCallout>
            }
        >
            <LegalSection id="transfer" index="01" title="How the transfer works">
                <p>
                    When you send a file, we use{' '}
                    <strong className="font-semibold text-zinc-200">WebRTC</strong> to establish a
                    connection between you and the recipient. Our signaling server introduces the two
                    devices and then steps aside. In most cases, data flows directly between browsers.
                    When a direct path is not available, our TURN relay server bridges the connection.
                    Even through the relay, files remain encrypted and are never stored.
                </p>
            </LegalSection>

            <LegalSection id="collect" index="02" title="Information we collect">
                <LegalList
                    marker={null}
                    items={[
                        <>
                            <strong className="font-semibold text-zinc-200">Files.</strong> We do not
                            collect or store any files.
                        </>,
                        <>
                            <strong className="font-semibold text-zinc-200">Metadata.</strong>{' '}
                            Filenames and sizes travel directly between the two devices over the
                            encrypted data channel so the receiver can see what is arriving. They
                            never pass through, and are never stored on, our servers.
                        </>,
                        <>
                            <strong className="font-semibold text-zinc-200">
                                Aggregate transfer total.
                            </strong>{' '}
                            When a transfer completes, the receiving side reports only the number of
                            bytes it received. We add this to one shared, all-time counter of total
                            bytes transferred, shown on our homepage. The sender never reports. We do
                            not store file names, file contents, or any link between this number and
                            you. You can opt out of this report: uncheck
                            &quot;Contribute to global stats&quot; on the receiver view in the browser,
                            or use <InlineCode>--no-report</InlineCode> (or set{' '}
                            <InlineCode>FLOE_NO_STATS=1</InlineCode>) when using the CLI.
                        </>,
                        <>
                            <strong className="font-semibold text-zinc-200">IP addresses.</strong> Like
                            all web servers, our hosting provider may log connection request IP
                            addresses for security and abuse prevention. We do not link this to your
                            identity.
                        </>,
                    ]}
                />
            </LegalSection>

            <LegalSection id="third-parties" index="03" title="Third-party services">
                <p>
                    Floe uses third-party infrastructure providers for hosting and network relay
                    services. The web app is hosted on Vercel, the signaling server runs on Microsoft
                    Azure, and when a relay is needed, encrypted file data passes through
                    Cloudflare&apos;s TURN network. For usage analytics we use only Umami, which is
                    cookieless and does not track you across sites, and we optionally use Sentry for
                    error monitoring. The link you share carries its room id in the URL fragment (the
                    part after the <InlineCode>#</InlineCode>). Browsers never include the fragment in
                    HTTP requests, so it stays out of hosting logs, referrer headers, and analytics.
                    Our signaling server receives the room id only when your app joins the room to be
                    paired with your peer; it is held in memory for the life of the session and never
                    logged. Please refer to each provider&apos;s privacy policy regarding data
                    handling.
                </p>
            </LegalSection>

            <LegalSection id="relay" index="04" title="Relay server">
                <p>
                    When a direct connection cannot be established, file data is routed through
                    Cloudflare&apos;s TURN relay network (<InlineCode>turn.cloudflare.com</InlineCode>).
                    The relay processes encrypted data packets in transit and does not store, decrypt,
                    or inspect any file contents. Relay sessions are limited to 2 GB per session.
                    Connection metadata (timestamps, IP addresses) may be logged by the infrastructure
                    provider for security purposes.
                </p>
            </LegalSection>

            <LegalSection id="errors" index="05" title="Error monitoring & session replay">
                <p>Floe uses Sentry to monitor application errors and performance. Sentry may capture:</p>
                <LegalList
                    items={[
                        'Error stack traces and browser metadata (browser version, OS, device type)',
                        'Connection type (direct or relay), transfer progress, file count, and total size at the time of an error',
                        <>
                            <strong className="font-semibold text-zinc-200">Session replay.</strong> An
                            anonymized, video-like recording of a small sample of browser sessions,
                            plus any session where an error occurs. All on-screen text and media are
                            masked, so file names and file contents are never captured.
                        </>,
                    ]}
                />
                <p>
                    Sentry does <strong className="font-semibold text-zinc-200">not</strong> capture
                    file names, file contents, or any personally identifiable information. Session
                    recordings are used solely for debugging technical issues.{' '}
                    <a
                        href="https://sentry.io/privacy/"
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-300 underline decoration-white/20 underline-offset-4 transition hover:text-ice"
                    >
                        Sentry Privacy Policy
                    </a>
                    .
                </p>
            </LegalSection>

            <LegalSection id="analytics" index="06" title="Usage analytics">
                <p>
                    Floe uses Umami, a privacy-focused analytics tool, to understand how the service is
                    used. Umami collects:
                </p>
                <LegalList
                    items={[
                        'Aggregate transfer metrics: number of files and total bytes transferred per session',
                        'Connection type (direct or relay) and whether a transfer succeeded or failed',
                        'Standard page view data: pages visited, browser type, country (not city)',
                    ]}
                />
                <p>
                    Umami does <strong className="font-semibold text-zinc-200">not</strong> use
                    cookies, does not collect personally identifiable information, and does not track
                    individuals across sessions or websites. File names and file contents are never
                    recorded.{' '}
                    <a
                        href="https://umami.is/privacy"
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-300 underline decoration-white/20 underline-offset-4 transition hover:text-ice"
                    >
                        Umami Privacy Policy
                    </a>
                    .
                </p>
            </LegalSection>
        </LegalShell>
    );
}
