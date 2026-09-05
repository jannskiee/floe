import React from 'react';
import type { Metadata } from 'next';
import {
    InlineCode,
    LegalCallout,
    LegalLedger,
    LegalLink,
    LegalList,
    LegalSection,
    LegalShell,
    sectionIndex,
} from '@/components/legal/LegalShell';
import { sharedOpenGraph, sharedTwitter } from '@/lib/socialMetadata';

export const metadata: Metadata = {
    // Bare title: the "%s - Floe" template in app/layout.tsx adds the suffix.
    title: 'Privacy Policy',
    description:
        'How Floe handles your data: files stream peer to peer and are never stored, and the only tally we keep is one anonymous global byte total.',
    alternates: {
        canonical: '/privacy',
    },
    // Spread before overriding: a bare object here would replace the root's
    // whole openGraph block and drop the images with it.
    openGraph: { ...sharedOpenGraph, title: 'Floe Privacy Policy' },
    twitter: { ...sharedTwitter, title: 'Floe Privacy Policy' },
};

// Every sentence below was checked against the code it describes on
// 2026-09-05 (server/server.js, server/turn.js, client/sentry.*.config.ts,
// client/app/layout.tsx, cli/, desktop/) and against docs/security-privacy.mdx.
// When a flag, label, hostname or number changes, this page changes with it.
const toc = [
    { id: 'transfer', label: 'How the transfer works' },
    { id: 'collect', label: 'Information we collect' },
    { id: 'third-parties', label: 'Third-party services' },
    { id: 'relay', label: 'Relay server' },
    { id: 'errors', label: 'Error monitoring' },
    { id: 'analytics', label: 'Usage analytics' },
    { id: 'browser', label: 'The web app on your device' },
    { id: 'desktop', label: 'The desktop app' },
    { id: 'cli', label: 'The CLI' },
    { id: 'contact', label: 'Contact & reports' },
];

export default function PrivacyPolicy() {
    return (
        <LegalShell
            document="privacy"
            title="Privacy policy"
            dates={[{ label: 'Last updated', iso: '2026-09', text: 'September 2026' }]}
            historyHref="https://github.com/jannskiee/floe/commits/main/client/app/privacy/page.tsx"
            toc={toc}
            intro={
                <LegalCallout label="The short version" tone="summary">
                    <p>
                        Floe is a <strong>peer-to-peer</strong> file transfer service. Your files
                        stream directly from the sender&apos;s device to the receiver&apos;s device
                        whenever possible, encrypted from end to end.
                    </p>
                    <p>
                        <strong>We do not store, view, or process your files.</strong> In direct
                        connections, files never touch our servers. In relay connections, encrypted
                        file data passes through a TURN relay in transit (on floe.one, Cloudflare&apos;s
                        network) but is never stored or inspected. The only tally we keep is one
                        anonymous number: the running total of bytes transferred across all users,
                        shown by the counter on our homepage, and you can opt out of contributing to
                        it. The cookieless, aggregate analytics and the error monitoring the website
                        uses are described below.
                    </p>
                    <p>
                        This policy describes floe.one and the servers we run for it. Floe is open
                        source, and an instance someone else hosts is theirs to run, under their own
                        policy.
                    </p>
                </LegalCallout>
            }
        >
            <LegalSection id="transfer" index={sectionIndex(toc, 'transfer')} title="How the transfer works">
                <p>
                    When you send a file, we use <strong>WebRTC</strong> to open a connection between
                    you and the recipient. Our signaling server introduces the two devices and then
                    steps aside. In most cases, data then flows directly between the two devices,
                    whether each one is a browser, Floe Desktop, or the CLI. When a direct path is not
                    available, a TURN relay (on floe.one, Cloudflare&apos;s network) bridges the
                    connection. Even through the relay, files remain encrypted and are never stored.
                </p>
                <p>
                    The encryption is WebRTC&apos;s own (DTLS), with keys that exist only on the two
                    devices for that one transfer. The certificate fingerprints the two devices use to
                    agree on those keys pass through our signaling server, so that server is trusted
                    to introduce you honestly, and no Floe client shows a verification code to check
                    it today. This is true of every WebRTC application; the full list of what Floe
                    does not protect against is in{' '}
                    <LegalLink href="https://www.floe.one/docs/how-it-works/known-limitations">
                        Known limitations
                    </LegalLink>
                    .
                </p>
                <p>
                    Peer-to-peer means the two devices connect to each other, so on a direct
                    connection each learns the other&apos;s IP address, in the same way a video call
                    does. A receiver page joins the room as soon as the link opens, with no click, and
                    your browser begins exchanging its network addresses with the sender at that
                    point. If you would rather not reveal your address to the other person, Floe
                    Desktop&apos;s &quot;Hide my IP address&quot; setting and the CLI&apos;s{' '}
                    <InlineCode>--relay-only</InlineCode> flag (or{' '}
                    <InlineCode>FLOE_RELAY_ONLY=1</InlineCode>) route your side through the relay
                    instead, so the other person sees the relay&apos;s address; relayed transfers are
                    slower and capped at 2 GB. The web app has no equivalent: its &quot;Network relay
                    fallback&quot; checkbox does the opposite, turning the relay off so only a direct
                    connection is attempted.
                </p>
            </LegalSection>

            <LegalSection id="collect" index={sectionIndex(toc, 'collect')} title="Information we collect">
                <LegalLedger
                    rows={[
                        {
                            term: 'Files',
                            body: <p>We do not collect or store any files.</p>,
                        },
                        {
                            term: 'Connection setup',
                            body: (
                                <p>
                                    To pair two devices, our signaling server receives the room id and
                                    relays the WebRTC connection messages (offers, answers, and ICE
                                    candidates, which carry each device&apos;s network addresses)
                                    between them. It forwards them from memory, unread, and keeps
                                    nothing once the room closes. When the sender uses the CLI or Floe
                                    Desktop, the server also maps a random three-word code to the room
                                    id for ten minutes.
                                </p>
                            ),
                        },
                        {
                            term: 'Metadata',
                            body: (
                                <p>
                                    Filenames and sizes travel between the two devices over the
                                    encrypted data channel so the receiver can see what is arriving.
                                    They never reach our signaling server. On a relayed transfer they
                                    pass through the relay in the same encrypted stream as the file
                                    data, which the relay cannot read.
                                </p>
                            ),
                        },
                        {
                            term: 'Byte total',
                            body: (
                                <>
                                    <p>
                                        When a transfer completes, the receiving side reports only the
                                        number of bytes it received. We add this to one shared,
                                        all-time counter of total bytes transferred, shown on our
                                        homepage and stored as a single number in a hosted Redis
                                        database (Upstash). The sender never reports. We do not store
                                        file names, file contents, or any link between this number and
                                        you.
                                    </p>
                                    <p>
                                        You can opt out: uncheck &quot;Contribute to global stats&quot;
                                        on the receiver view in the browser or in Floe Desktop&apos;s
                                        Settings, or use <InlineCode>--no-report</InlineCode> (or set{' '}
                                        <InlineCode>FLOE_NO_STATS=1</InlineCode>) with the CLI. This
                                        switch covers the public counter and nothing else: on floe.one
                                        the site analytics described under Usage analytics record a
                                        transfer&apos;s outcome separately, and the desktop app and the
                                        CLI send no such event.
                                    </p>
                                </>
                            ),
                        },
                        {
                            term: 'IP addresses',
                            body: (
                                <p>
                                    Our signaling server keeps your IP address in memory only long
                                    enough to rate-limit abuse (at most about two minutes after your
                                    last request), and the server itself writes no log of it. Like all
                                    web servers, the reverse proxy in front of it and the providers
                                    that host us may log connection request IP addresses for security
                                    and abuse prevention. We do not link any of this to your identity.
                                    Who else sees your IP address, and how to hide it from the other
                                    person, is under How the transfer works.
                                </p>
                            ),
                        },
                    ]}
                />
            </LegalSection>

            <LegalSection id="third-parties" index={sectionIndex(toc, 'third-parties')} title="Third-party services">
                <p>
                    Floe uses third-party infrastructure providers for hosting and connection setup.
                    The web app is hosted on Vercel and the signaling server runs on Microsoft Azure.
                    Connection setup uses Cloudflare on every transfer, direct or relayed, and relayed
                    file data passes through Cloudflare&apos;s TURN network; Relay server below says
                    exactly what it sees. If your app cannot get relay credentials from our signaling
                    server, because the server is unreachable, has rate limited you, or has none to
                    hand out at that moment, it falls back to Google&apos;s public STUN servers (
                    <InlineCode>stun.l.google.com</InlineCode>) to learn its own public address.
                    Google then sees your IP address and nothing about the transfer; STUN carries no
                    file data.
                </p>
                <p>
                    The running total behind the homepage counter is stored in a hosted Redis database
                    (Upstash); the only thing ever written there is that single number, by our server,
                    never by your device. Floe Desktop and the CLI contact GitHub only to check for or
                    download updates: Floe Desktop&apos;s GitHub build once a day unless you turn the
                    check off (Microsoft Store builds never check), and the CLI only when you run{' '}
                    <InlineCode>floe version</InlineCode>, <InlineCode>floe update</InlineCode>, or{' '}
                    <InlineCode>floe update --check</InlineCode>. Both are described in their own
                    sections below. The documentation at floe.one/docs is served by Mintlify, a
                    third-party documentation host: requests to those pages reach Mintlify, its pages
                    load Mintlify&apos;s own scripts, and Mintlify may collect page-view data there.
                </p>
                <p>
                    For usage analytics we use only Umami, which is cookieless and does not track you
                    across sites, and for error monitoring we use Sentry. Both apply to the floe.one
                    website only and are described below; the desktop app and the CLI have neither,
                    and a self-hosted copy of Floe ships with both turned off.
                </p>
                <p>
                    The link you share carries its room id in the URL fragment (the part after the{' '}
                    <InlineCode>#</InlineCode>). Browsers never include the fragment in HTTP requests,
                    so it stays out of hosting logs and referrer headers, and our analytics script is
                    configured to drop it as well; what our error monitoring receives is described
                    under Error monitoring. Links from the web app and Floe Desktop also carry a short
                    random marker before the <InlineCode>#</InlineCode> (the{' '}
                    <InlineCode>?s=</InlineCode> part); it exists only so each link opens as a
                    distinct page, it says nothing about you or the room, and links printed by the CLI
                    do not carry one. Our signaling server receives the room id when your app joins
                    the room to be paired with your peer, and, for a transfer started from the CLI or
                    Floe Desktop, when it registers the three-word code that stands in for the link.
                    Both are held in memory only: the room is dropped when the last device leaves it,
                    and a code&apos;s mapping to its room id expires ten minutes after the code was
                    made. Neither is written to a log.
                </p>
                <p>
                    Please refer to each provider&apos;s privacy policy regarding data handling:{' '}
                    <LegalLink href="https://vercel.com/legal/privacy-notice">Vercel</LegalLink>,{' '}
                    <LegalLink href="https://www.microsoft.com/privacy/privacystatement">
                        Microsoft
                    </LegalLink>
                    , <LegalLink href="https://www.cloudflare.com/privacypolicy/">Cloudflare</LegalLink>
                    , <LegalLink href="https://mintlify.com/legal/privacy">Mintlify</LegalLink>, and the
                    Sentry and Umami policies linked in the sections below.
                </p>
            </LegalSection>

            <LegalSection id="relay" index={sectionIndex(toc, 'relay')} title="Relay server">
                <p>
                    When a direct connection cannot be established, file data is routed through
                    Cloudflare&apos;s TURN relay network (<InlineCode>turn.cloudflare.com</InlineCode>
                    ). The relay forwards encrypted packets it cannot decrypt: the keys exist only on
                    the two devices. It does not store or inspect file contents. Relay sessions are
                    limited to 2 GB per session.
                </p>
                <p>
                    Cloudflare is involved before the route is decided, not only when a relay is
                    needed. To find a working path, your app asks Cloudflare&apos;s STUN server (
                    <InlineCode>stun.cloudflare.com</InlineCode>) for its own public address and,
                    unless you turned relay fallback off in the browser or passed{' '}
                    <InlineCode>--no-relay</InlineCode> to the CLI, opens a standby relay allocation
                    on <InlineCode>turn.cloudflare.com</InlineCode>. That happens on every transfer,
                    whichever route wins, so Cloudflare sees your IP address and the timing of the
                    connection attempt on every transfer. File data crosses Cloudflare only when the
                    relay is the route that wins.
                </p>
                <p>
                    Before connecting, your app fetches relay credentials from our signaling server.
                    On floe.one these are one shared credential set, minted from Cloudflare and valid
                    for 24 hours, served to every client until we refresh it. They are not tied to
                    you, your device, or an account.
                </p>
                <p>
                    The relay is a hop both devices connect to, so Cloudflare sees both IP addresses
                    and the timing and amount of data it forwards, and may log that for its own
                    security purposes. See{' '}
                    <LegalLink href="https://www.cloudflare.com/privacypolicy/">
                        Cloudflare&apos;s privacy policy
                    </LegalLink>{' '}
                    for its handling of that data.
                </p>
            </LegalSection>

            <LegalSection id="errors" index={sectionIndex(toc, 'errors')} title="Error monitoring">
                <p>
                    The <strong>web app</strong> uses Sentry to monitor application errors and a 10%
                    sample of page performance traces. This applies to the floe.one website only; the
                    desktop app and the CLI contain no error monitoring. Sentry is configured to attach
                    no cookies and no IP address to what it sends; each report does carry the page
                    address, your browser&apos;s user agent, and the page that referred you. It may
                    capture:
                </p>
                <LegalList
                    items={[
                        'Error stack traces and browser metadata (browser version, OS, device type, language, and time zone)',
                        'Connection type (direct or relay), transfer progress, file count, and total size at the time of an error',
                    ]}
                />
                <p>
                    Session replay is <strong>not</strong> enabled. Floe used to record a sample of
                    browser sessions. A recording reported the page address, and on a receiver page
                    that address contains the room link, so replay was removed rather than kept: the
                    room link is the only thing protecting a transfer.
                </p>
                <p>
                    Sentry does <strong>not</strong> capture file names, file contents, or any
                    personally identifiable information. The room link is stripped from every error
                    report, breadcrumb, and performance trace before it is sent.{' '}
                    <LegalLink href="https://sentry.io/privacy/">Sentry Privacy Policy</LegalLink>.
                </p>
            </LegalSection>

            <LegalSection id="analytics" index={sectionIndex(toc, 'analytics')} title="Usage analytics">
                <p>
                    The <strong>web app</strong> uses Umami Cloud, the hosted analytics service run by
                    Umami&apos;s makers, to understand how the service is used. This applies to the
                    floe.one website only; the desktop app and the CLI contain no analytics. Umami
                    collects:
                </p>
                <LegalList
                    items={[
                        'Transfer outcomes: for a completed transfer, the number of files, the total size in bytes, whether you were sending or receiving, and whether the connection was direct or relayed; for a failure, your role, one of five fixed labels (for example "ice-failed"), and, when you were sending, the file count and total size',
                        "Which download button you clicked on the download page, the homepage, or the navigation bar, and, when Floe opens inside another app's built-in browser (such as Facebook or Instagram), the name of that app and whether it was Android or iOS",
                        'Standard page view data: the page path, referring site, browser, operating system, device type, screen size, language, and approximate location (country, region, and city), derived from your IP address by Umami, which does not store the address',
                    ]}
                />
                <p>
                    Umami does not use cookies and stores nothing on your device. It does not collect
                    personally identifiable information: your IP address and browser signature are
                    hashed with a salt that rotates on a schedule, so Umami can count a returning
                    visitor for a while without keeping the address, and the hash is tied to
                    floe.one, so it cannot follow you to other websites. File names and file contents
                    are never recorded. It is configured to drop the URL fragment and the query string
                    before reporting a page view, so the room link never reaches it. If your browser
                    sends the Do Not Track signal, Umami records nothing at all for your visit.{' '}
                    <LegalLink href="https://umami.is/privacy">Umami Privacy Policy</LegalLink>.
                </p>
            </LegalSection>

            <LegalSection id="browser" index={sectionIndex(toc, 'browser')} title="The web app on your device">
                <p>
                    The web app keeps a few small things in your browser, and none of them leave it.
                    So that floe.one loads quickly and can open without a network, your browser caches
                    the app&apos;s pages and build files, the same files every visitor downloads; that
                    cache never holds file data or anything from our API. Your &quot;Contribute to
                    global stats&quot; choice is remembered in this browser&apos;s local storage, and a
                    timestamp is kept for the life of the tab to avoid reload loops after a new version
                    is deployed.
                </p>
                <p>
                    Files you receive are held in the tab&apos;s memory until you download them;
                    closing the tab discards anything you did not save, and nothing about a
                    transfer&apos;s files is written to browser storage. While a transfer is running
                    the app asks your browser to keep the screen awake and releases that when the
                    transfer ends. The app writes to your clipboard only when you press Copy and never
                    reads it, and it never asks for notification permission.
                </p>
            </LegalSection>

            <LegalSection id="desktop" index={sectionIndex(toc, 'desktop')} title="The desktop app">
                <p>
                    Floe Desktop runs the same peer-to-peer engine as the CLI and speaks the same
                    protocol as the web app, as a Windows application. It talks to the same servers
                    the web app does: it contacts our signaling server to pair you with your peer (and
                    to register the three-word code it shows), fetches relay credentials, and then
                    streams file data directly between devices, or through the relay described above
                    when no direct path exists or when &quot;Hide my IP address&quot; is on. Two more
                    requests happen only when you ask for them: the Test button in Settings contacts
                    only the server address you typed, and if the Microsoft WebView2 runtime that
                    draws the interface is missing, the app offers to download it from Microsoft
                    before it starts. It contains{' '}
                    <strong>no analytics, no error monitoring, and no telemetry</strong>.
                </p>
                <p>
                    It makes two optional requests, each with its own off switch: the same anonymous
                    byte total described above, which you can turn off with &quot;Contribute to global
                    stats&quot; in Settings, and a once-a-day update check. The update check (GitHub
                    builds 0.2.3 and later) asks GitHub whether a newer release exists; it carries
                    nothing about you beyond what any web request reveals (your IP address and a user
                    agent), nothing about your files or transfers is in it, and nothing downloads or
                    installs by itself. Turn off &quot;Check for updates&quot; in Settings (or set{' '}
                    <InlineCode>FLOE_NO_UPDATE_CHECK=1</InlineCode>, the same variable the CLI honors)
                    and no request is made at all. Microsoft Store builds never check; the Store
                    updates them itself.
                </p>
                <p>
                    It also adds one privacy switch the web app does not have. On a direct connection
                    the other device learns your IP address, as in any peer-to-peer connection. Turn
                    on &quot;Hide my IP address&quot; in Settings and the app uses only the relay, so
                    the other person sees the relay&apos;s address instead; relayed transfers are
                    slower and capped at 2 GB.
                </p>
                <p>Everything else it does stays on your device:</p>
                <LegalLedger
                    rows={[
                        {
                            term: 'Clipboard',
                            body: (
                                <p>
                                    The app reads your clipboard only when you paste (Ctrl+V) to stage
                                    copied files or a screenshot for sending. It never reads the
                                    clipboard in the background.
                                </p>
                            ),
                        },
                        {
                            term: 'Files',
                            body: (
                                <p>
                                    Received files are written to the folder you choose (your Downloads
                                    folder by default). Nothing is uploaded anywhere.
                                </p>
                            ),
                        },
                        {
                            term: 'History',
                            body: (
                                <p>
                                    The app keeps a list of your last 50 transfers on your device: for
                                    each one, the direction, the file names (for a received transfer,
                                    the names as saved and the folder they went to), the file count,
                                    the total size, and the time. It never leaves your device. Remove
                                    one entry with Remove inside its row, or all of them with Clear in
                                    the History view. Reset in Settings and uninstalling the app both
                                    leave it in place.
                                </p>
                            ),
                        },
                        {
                            term: 'Settings',
                            body: (
                                <p>
                                    Your preferences are stored locally in your user profile and are
                                    not removed automatically when the app is uninstalled.
                                </p>
                            ),
                        },
                        {
                            term: 'Right-click menu',
                            body: (
                                <p>
                                    The GitHub build adds a &quot;Send with Floe&quot; entry to the
                                    File Explorer right-click menu. It is on by default: the first time
                                    the app runs it writes one per-user registry key (with a command
                                    subkey) that holds the app&apos;s location, and if you move the app
                                    it rewrites that key at the next start. Turn off &quot;Show in
                                    right-click menu&quot; in Settings and the key is removed; the
                                    installer&apos;s uninstall removes it too. The portable zip has no
                                    uninstaller, so turn the switch off before deleting that build. The
                                    Microsoft Store build does not offer this entry.
                                </p>
                            ),
                        },
                        {
                            term: 'Notifications',
                            body: (
                                <p>
                                    The app shows standard Windows notifications when a transfer
                                    completes or fails.
                                </p>
                            ),
                        },
                    ]}
                />
                <p>
                    When installed from the Microsoft Store, installation and automatic updates are
                    handled by Microsoft; see{' '}
                    <LegalLink href="https://www.microsoft.com/privacy/privacystatement">
                        Microsoft&apos;s privacy statement
                    </LegalLink>{' '}
                    for what the Store itself collects.
                </p>
            </LegalSection>

            <LegalSection id="cli" index={sectionIndex(toc, 'cli')} title="The CLI">
                <p>
                    The <InlineCode>floe</InlineCode> command line tool runs the same peer-to-peer
                    engine as Floe Desktop. <InlineCode>floe send</InlineCode> and{' '}
                    <InlineCode>floe receive</InlineCode> contact our signaling server (api.floe.one,
                    or the server you name with <InlineCode>--server</InlineCode> or{' '}
                    <InlineCode>FLOE_SERVER</InlineCode>) to register or look up a short code, fetch
                    relay credentials, and pair you with your peer, and then stream file data directly
                    between devices, or through the relay described above when no direct path exists.
                    The CLI contains no analytics, no error monitoring, and no telemetry, and it keeps
                    no history or log of your transfers. It makes two optional requests, each with its
                    own off switch:
                </p>
                <LegalLedger
                    rows={[
                        {
                            term: 'Byte total',
                            body: (
                                <p>
                                    After a transfer completes, <InlineCode>floe receive</InlineCode>{' '}
                                    sends the number of bytes it received to the signaling server it
                                    used, so on a self-hosted server the count goes to that server and
                                    not to us. Pass <InlineCode>--no-report</InlineCode>, or set{' '}
                                    <InlineCode>FLOE_NO_STATS=1</InlineCode>, and no request is made.{' '}
                                    <InlineCode>floe send</InlineCode> never reports.
                                </p>
                            ),
                        },
                        {
                            term: 'Update check',
                            body: (
                                <p>
                                    <InlineCode>floe version</InlineCode> asks GitHub whether a newer
                                    release exists when you run it, at most once a day (the answer is
                                    kept for 24 hours in a small file in your user configuration
                                    folder). The request carries nothing about you beyond what any web
                                    request reveals (your IP address and a generic user agent); nothing
                                    about your files or transfers is in it, and nothing downloads or
                                    installs by itself. Set <InlineCode>FLOE_NO_UPDATE_CHECK=1</InlineCode>{' '}
                                    and no request is made. <InlineCode>floe send</InlineCode> and{' '}
                                    <InlineCode>floe receive</InlineCode> never check, and a build
                                    compiled from source never checks.
                                </p>
                            ),
                        },
                    ]}
                />
                <p>
                    <InlineCode>floe update</InlineCode> is you asking for an update: it fetches the
                    latest release, its checksum file, and the archive for your platform from GitHub,
                    verifies the SHA-256 checksum, and replaces the binary. On an install managed by
                    Homebrew, Scoop, or Winget it stops before any request and points you at your
                    package manager instead. Received files go to the folder you pass with{' '}
                    <InlineCode>-o</InlineCode> (the folder you ran the command in, by default), and{' '}
                    <InlineCode>--relay-only</InlineCode> (or{' '}
                    <InlineCode>FLOE_RELAY_ONLY=1</InlineCode>) routes your side through the relay so
                    the other device sees the relay&apos;s address instead of yours.
                </p>
            </LegalSection>

            <LegalSection id="contact" index={sectionIndex(toc, 'contact')} title="Contact & reports">
                <p>
                    Questions about this policy, bug reports, and abuse reports go to our public
                    issue tracker:{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/issues">
                        github.com/jannskiee/floe/issues
                    </LegalLink>
                    . Two things should not go there. If you have found a security vulnerability,
                    report it privately through GitHub&apos;s{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/security/advisories/new">
                        Report a vulnerability
                    </LegalLink>{' '}
                    form or the email address in our{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/security/policy">
                        security policy
                    </LegalLink>
                    , so the problem is not public before there is a fix. If an abuse report includes
                    personal details about anyone, or copies of the content itself, send it through
                    those same private channels instead of opening a public issue.
                </p>
                <p>
                    Because Floe is peer-to-peer, transferred content never sits on our servers: a
                    direct transfer never touches them, and a relayed one passes through the relay only
                    as encrypted packets it cannot read. We cannot see, store, or remove files that
                    users send to each other. What we can do in response to a report is limited, and
                    we would rather say so plainly. Our signaling server keeps no record of who joined
                    which room, and the relay credentials it hands out are shared by every client
                    rather than issued per person, so we cannot identify a particular sender after the
                    fact or cut off their relay access alone. Per-address rate limits apply to everyone
                    automatically, and that is the extent of what the service does on its own.
                </p>
                <p>
                    If you believe Floe is being used to send you illegal or harmful content, do not
                    open further links or codes from that sender (a transfer only starts when you open
                    one, and the command line asks before it accepts) and report the details as
                    described above.
                </p>
            </LegalSection>
        </LegalShell>
    );
}
