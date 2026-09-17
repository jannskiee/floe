'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/serviceWorkerRegistration';

export function ServiceWorkerRegistration() {
    useEffect(() => {
        registerServiceWorker({
            isProduction: process.env.NODE_ENV === 'production',
            hasServiceWorker: 'serviceWorker' in navigator,
            readyState: () => document.readyState,
            addLoadListener: (listener) => window.addEventListener('load', listener),
            register: () => navigator.serviceWorker.register('/sw.js'),
        });
    }, []);

    return null;
}
