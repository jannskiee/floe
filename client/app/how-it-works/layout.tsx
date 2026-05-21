import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'How It Works | Floe',
    description:
        'Learn how Floe transfers files directly between devices using WebRTC, end-to-end encryption, and TURN relay fallback.',
    alternates: {
        canonical: '/how-it-works',
    },
};

export default function HowItWorksLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
