// Registers /sw.js for the root layout. The logic lives here rather than in
// ServiceWorkerRegistration.tsx so the node vitest environment can drive it
// with fakes; the component only supplies the real window, document and
// navigator.

export interface ServiceWorkerRegistrationDeps {
    isProduction: boolean;
    hasServiceWorker: boolean;
    readyState: () => DocumentReadyState;
    addLoadListener: (listener: () => void) => void;
    register: () => Promise<unknown>;
}

export function registerServiceWorker(deps: ServiceWorkerRegistrationDeps): void {
    if (!deps.hasServiceWorker || !deps.isProduction) return;
    const register = () => {
        deps.register().catch(() => { });
    };
    // The component's effect runs after hydration, so load has usually fired
    // already and a listener added now would never run: the worker then never
    // registered on its own, and floe-cache-v6 never replaced a v5 cache that
    // held share links. Waiting for load still keeps registration off the
    // initial render when the page is slow.
    if (deps.readyState() === 'complete') register();
    else deps.addLoadListener(register);
}
