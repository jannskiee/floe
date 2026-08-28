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
 *
 * `commit` is the source revision this client was deployed from. It is an
 * unauthenticated version oracle: anyone can compare what an instance is running
 * against the public repository without trusting a version string the page
 * renders about itself. On Vercel it is VERCEL_GIT_COMMIT_SHA, the full 40-hex
 * SHA of the commit that triggered the deployment, which the platform sets at
 * build time and at runtime. A self-hosted instance may set SOURCE_COMMIT
 * instead. Both are plain names for the same reason as SOCKET_URL. When neither
 * is set, or both are empty, the field is null: an unknown revision is reported
 * as unknown, never guessed.
 */

// Without this, Next prerenders the handler at build time and bakes the builder's
// (empty) environment into a static response, reintroducing the exact problem
// this endpoint exists to solve.
export const dynamic = 'force-dynamic';

export function GET() {
    return Response.json(
        {
            socketUrl: process.env.SOCKET_URL || '',
            commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || null,
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
