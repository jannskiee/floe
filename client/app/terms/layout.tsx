import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Terms of Use | Floe',
    description:
        'Terms and conditions for using Floe, the free peer-to-peer encrypted file transfer service.',
    alternates: {
        canonical: '/terms',
    },
};

export default function TermsLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
