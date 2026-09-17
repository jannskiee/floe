import { describe, expect, it } from 'vitest';
import { registerServiceWorker, type ServiceWorkerRegistrationDeps } from './serviceWorkerRegistration';

function fakeDeps(overrides: Partial<ServiceWorkerRegistrationDeps> = {}) {
    const listeners: Array<() => void> = [];
    let registrations = 0;
    const deps: ServiceWorkerRegistrationDeps = {
        isProduction: true,
        hasServiceWorker: true,
        readyState: () => 'loading',
        addLoadListener: (listener) => { listeners.push(listener); },
        register: () => { registrations += 1; return Promise.resolve({}); },
        ...overrides,
    };
    return {
        deps,
        fireLoad: () => listeners.forEach((listener) => listener()),
        listenerCount: () => listeners.length,
        registrations: () => registrations,
    };
}

describe('registerServiceWorker', () => {
    it('registers on the load event', () => {
        const f = fakeDeps();
        registerServiceWorker(f.deps);
        expect(f.registrations()).toBe(0);
        f.fireLoad();
        expect(f.registrations()).toBe(1);
    });

    it('waits for load while the document is interactive', () => {
        const f = fakeDeps({ readyState: () => 'interactive' });
        registerServiceWorker(f.deps);
        expect(f.registrations()).toBe(0);
        expect(f.listenerCount()).toBe(1);
    });

    it('does nothing outside production', () => {
        const f = fakeDeps({ isProduction: false, readyState: () => 'complete' });
        registerServiceWorker(f.deps);
        f.fireLoad();
        expect(f.registrations()).toBe(0);
        expect(f.listenerCount()).toBe(0);
    });

    it('does nothing without serviceWorker support', () => {
        const f = fakeDeps({ hasServiceWorker: false, readyState: () => 'complete' });
        registerServiceWorker(f.deps);
        f.fireLoad();
        expect(f.registrations()).toBe(0);
        expect(f.listenerCount()).toBe(0);
    });

    it('swallows a registration rejection', async () => {
        let caught = false;
        const rejected = Promise.reject(new Error('blocked'));
        const f = fakeDeps({
            register: () => {
                const observed = rejected.catch((err) => { caught = true; throw err; });
                return observed;
            },
        });
        registerServiceWorker(f.deps);
        f.fireLoad();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(caught).toBe(true);
    });
});
