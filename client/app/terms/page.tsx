import React from 'react';
import type { Metadata } from 'next';
import {
    LegalCallout,
    LegalList,
    LegalSection,
    LegalShell,
} from '@/components/legal/LegalShell';

export const metadata: Metadata = {
    title: 'Terms of Use · Floe',
    description:
        'The terms for using Floe: acceptable use, your responsibility for what you send, the MIT license, and relay usage limits.',
    alternates: {
        canonical: '/terms',
    },
};

const toc = [
    { id: 'acceptable-use', label: 'Acceptable use' },
    { id: 'responsibility', label: 'User responsibility' },
    { id: 'license', label: 'Copyright & license' },
    { id: 'relay', label: 'Relay usage' },
];

export default function TermsOfUse() {
    return (
        <LegalShell
            eyebrow="Legal"
            title="Terms of use"
            updated="Effective date: May 2026"
            toc={toc}
            footerLinks={[
                { name: 'Home', href: '/' },
                { name: 'How it works', href: '/how-it-works' },
                { name: 'Privacy', href: '/privacy' },
            ]}
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
            <LegalSection id="acceptable-use" index="01" title="Acceptable use">
                <p>By using Floe, you agree not to:</p>
                <LegalList
                    marker="&#10005;"
                    items={[
                        'Transfer illegal content (e.g., malware, pirated software, child exploitation material).',
                        'Use the service for phishing or social engineering attacks.',
                        'Attempt to disrupt, abuse, or reverse-engineer the signaling or relay servers.',
                    ]}
                />
            </LegalSection>

            <LegalSection id="responsibility" index="02" title="User responsibility">
                <p>
                    Since Floe is a peer-to-peer service, you are solely responsible for the content
                    you send. We do not (and cannot) moderate file contents. You agree to indemnify the
                    developers of Floe against any legal claims arising from your use of the service.
                </p>
            </LegalSection>

            <LegalSection id="license" index="03" title="Copyright & license">
                <p>
                    The source code for Floe is available under the{' '}
                    <strong className="font-semibold text-zinc-200">MIT License</strong>. You are free
                    to inspect, modify, and host your own version of this software, subject to the
                    terms of the license.
                </p>
            </LegalSection>

            <LegalSection id="relay" index="04" title="Relay usage">
                <p>
                    When your connection uses the TURN relay server, transfers are limited to 2 GB per
                    session. Excessive or automated abuse of relay bandwidth may result in rate
                    limiting or temporary access restrictions. These limits exist to keep Floe free for
                    all users.
                </p>
            </LegalSection>
        </LegalShell>
    );
}
