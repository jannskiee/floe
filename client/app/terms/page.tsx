import React from 'react';
import type { Metadata } from 'next';
import {
    LegalCallout,
    LegalLink,
    LegalList,
    LegalSection,
    LegalShell,
    sectionIndex,
} from '@/components/legal/LegalShell';
import { sharedOpenGraph, sharedTwitter } from '@/lib/socialMetadata';

export const metadata: Metadata = {
    // Bare title: the "%s - Floe" template in app/layout.tsx adds the suffix.
    title: 'Terms of Use',
    description:
        'The terms for using Floe: acceptable use, your responsibility for what you send, the MIT license, and relay usage limits.',
    alternates: {
        canonical: '/terms',
    },
    // Spread before overriding: a bare object here would replace the root's
    // whole openGraph block and drop the images with it.
    openGraph: { ...sharedOpenGraph, title: 'Floe Terms of Use' },
    twitter: { ...sharedTwitter, title: 'Floe Terms of Use' },
};

const toc = [
    { id: 'acceptable-use', label: 'Acceptable use' },
    { id: 'responsibility', label: 'User responsibility' },
    { id: 'license', label: 'Copyright & license' },
    { id: 'relay', label: 'Relay usage' },
    { id: 'contact', label: 'Contact & reports' },
];

export default function TermsOfUse() {
    return (
        <LegalShell
            document="terms"
            title="Terms of use"
            // Effective when these terms were first published; the contact
            // section arrived in August 2026 and the acceptable-use wording
            // changed in September 2026, so both dates are shown.
            dates={[
                { label: 'Effective', iso: '2026-05', text: 'May 2026' },
                { label: 'Last updated', iso: '2026-09', text: 'September 2026' },
            ]}
            historyHref="https://github.com/jannskiee/floe/commits/main/client/app/terms/page.tsx"
            toc={toc}
            intro={
                <LegalCallout label="Disclaimer" tone="caution">
                    <p>
                        Floe is provided &quot;as is&quot; without any warranties. As an open-source
                        project, we do not guarantee uptime, data integrity, or fitness for a
                        particular purpose. Use this service at your own risk.
                    </p>
                </LegalCallout>
            }
        >
            <LegalSection id="acceptable-use" index={sectionIndex(toc, 'acceptable-use')} title="Acceptable use">
                <p>By using Floe, you agree not to:</p>
                <LegalList
                    marker="&#10005;"
                    items={[
                        'Transfer illegal content (e.g., malware, pirated software, child exploitation material).',
                        'Use the service for phishing or social engineering attacks.',
                        'Disrupt, overload, or abuse the signaling server or the relay service behind floe.one.',
                    ]}
                />
                <p>
                    The code itself is open source: reading it, running your own copy, and reporting
                    what you find are welcome. See Copyright &amp; license below and our{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/security/policy">
                        security policy
                    </LegalLink>
                    .
                </p>
            </LegalSection>

            <LegalSection id="responsibility" index={sectionIndex(toc, 'responsibility')} title="User responsibility">
                <p>
                    Since Floe is a peer-to-peer service, you are solely responsible for the content
                    you send. We do not (and cannot) moderate file contents. You agree to indemnify the
                    developers of Floe against any legal claims arising from your use of the service.
                </p>
            </LegalSection>

            <LegalSection id="license" index={sectionIndex(toc, 'license')} title="Copyright & license">
                <p>
                    The source code for Floe is available under the <strong>MIT License</strong>. You
                    are free to inspect, modify, and host your own version of this software, subject
                    to the terms of the license.
                </p>
            </LegalSection>

            <LegalSection id="relay" index={sectionIndex(toc, 'relay')} title="Relay usage">
                <p>
                    When your connection uses the TURN relay, transfers are limited to 2 GB per
                    session. Excessive or automated use of the relay may result in rate limiting or
                    restrictions on access to the signaling and relay infrastructure. These limits
                    exist to keep Floe free for all users.
                </p>
            </LegalSection>

            <LegalSection id="contact" index={sectionIndex(toc, 'contact')} title="Contact & reports">
                <p>
                    Questions about these terms, bug reports, and abuse reports go to our public
                    issue tracker:{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/issues">
                        github.com/jannskiee/floe/issues
                    </LegalLink>
                    . Security vulnerabilities, and abuse reports that include personal details or
                    copies of the content, go privately instead: use the vulnerability report form or
                    the email address in our{' '}
                    <LegalLink href="https://github.com/jannskiee/floe/security/policy">
                        security policy
                    </LegalLink>{' '}
                    rather than a public issue.
                </p>
                <p>
                    Because transfers are peer-to-peer, we cannot inspect or remove content sent
                    between users, and our signaling server keeps no record of who took part in a
                    transfer. Automatic per-address rate limits are the only restriction the service
                    applies on its own.
                </p>
            </LegalSection>
        </LegalShell>
    );
}
