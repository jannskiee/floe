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
    deps.addLoadListener(() => {
        deps.register().catch(() => { });
    });
}
