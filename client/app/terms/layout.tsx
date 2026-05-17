import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Terms of Use | Floe',
    description:
        'Terms and conditions for using Floe, the free peer-to-peer encrypted file transfer service.',
};

export default function TermsLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
