'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        Sentry.captureException(error);
    }, [error]);

    return (
        <html>
            <body>
                {/* Render the default Next.js error page but report to Sentry */}
                <NextError statusCode={0} />
                <button
                    onClick={reset}
                    style={{
                        position: 'fixed',
                        bottom: '2rem',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        padding: '0.75rem 1.5rem',
                        background: '#18181b',
                        color: '#fff',
                        border: '1px solid #3f3f46',
                        borderRadius: '0.5rem',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                    }}
                >
                    Try again
                </button>
            </body>
        </html>
    );
}
