interface FloeRuntimeConfig {
    socketUrl?: string;
    socketPort?: string;
}

declare global {
    interface Window {
        __FLOE_CONFIG__?: FloeRuntimeConfig;
    }
}

interface SocketUrlOptions {
    runtimeUrl?: string;
    buildTimeUrl?: string;
    socketPort?: string;
    browserOrigin?: string;
}

function normalizedUrl(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed.replace(/\/$/, '') : undefined;
}

export function resolveSocketUrl({
    runtimeUrl,
    buildTimeUrl,
    socketPort = '3001',
    browserOrigin,
}: SocketUrlOptions): string {
    const configuredUrl =
        normalizedUrl(runtimeUrl) || normalizedUrl(buildTimeUrl);
    if (configuredUrl) return configuredUrl;

    if (!browserOrigin) return 'http://localhost:3001';

    const url = new URL(browserOrigin);
    url.port = socketPort;
    return url.origin;
}

/**
 * Resolve the signaling server URL at runtime.
 *
 * Published container images cannot bake an Unraid host address into the Next.js
 * bundle. The container entrypoint therefore writes window.__FLOE_CONFIG__ before
 * the app starts. Source builds can keep using NEXT_PUBLIC_SOCKET_URL, while an
 * unconfigured container derives the server URL from the browser host and port
 * 3001.
 */
export function getSocketUrl(): string {
    const runtimeConfig =
        typeof window === 'undefined' ? undefined : window.__FLOE_CONFIG__;

    return resolveSocketUrl({
        runtimeUrl: runtimeConfig?.socketUrl,
        buildTimeUrl: process.env.NEXT_PUBLIC_SOCKET_URL,
        socketPort: runtimeConfig?.socketPort,
        browserOrigin:
            typeof window === 'undefined' ? undefined : window.location.origin,
    });
}
