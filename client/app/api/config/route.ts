/**
 * Runtime configuration for the browser client.
 *
 * The browser fetches this on boot to learn where the signaling server lives, so
 * a self-hosted instance can change that address without rebuilding the client
 * image. It is also what makes a single prebuilt image usable by everyone.
 *
 * SOCKET_URL is deliberately NOT prefixed with NEXT_PUBLIC_. Next inlines
 * NEXT_PUBLIC_* into the server bundle at build time too, so a prefixed name here
 * would freeze the build machine's value and ignore whatever the container is
 * actually configured with. A plain name is read from the live process on every
 * request.
 *
 * Empty is a valid answer: it tells the client to use its own origin, which is
 * correct when both services sit behind one reverse proxy.
 */

// Without this, Next prerenders the handler at build time and bakes the builder's
// (empty) environment into a static response, reintroducing the exact problem
// this endpoint exists to solve.
export const dynamic = 'force-dynamic';

export function GET() {
    return Response.json(
        { socketUrl: process.env.SOCKET_URL || '' },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
