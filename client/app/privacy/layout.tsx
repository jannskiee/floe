import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Privacy Policy | Floe',
    description:
        'Floe privacy policy. No data collection, no tracking, no file storage. Your files never touch our servers.',
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
