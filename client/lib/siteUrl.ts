/**
 * Resolves the public base URL of THIS deployment, used for canonical links,
 * Open Graph and Twitter images, the JSON-LD block, and the sitemap.
 *
 * Unlike the signaling server address (see lib/socketUrl.ts), this one cannot be
 * resolved at runtime: Next bakes metadata into the prerendered HTML at build
 * time, so a published image genuinely cannot know the domain it will be served
 * from.
 *
 * Resolution order:
 *
 *   1. NEXT_PUBLIC_SITE_URL, when set to a non-empty value. Self-hosters who want
 *      their own domain in share previews set this and build the client
 *      themselves (see docker-compose.build.yml).
 *   2. Undefined, for the image we publish to ghcr.io. That image is handed to
 *      strangers, so it must claim nothing rather than claim floe.one. Callers
 *      omit the field entirely instead of substituting a wrong absolute URL.
 *   3. floe.one, for every other build. This keeps the canonical deployment
 *      byte-identical to its historical behaviour.
 *
 * Why a build flag rather than simply dropping the fallback: floe.one relies on
 * this default today, and Next suppresses its own "metadataBase is not set"
 * warning when VERCEL is set. Removing the fallback outright would therefore
 * regress the live site silently if the environment variable were ever missing,
 * with nothing in CI or the build log to catch it. Gating on a flag that only
 * our own Dockerfile sets makes this change a provable no-op everywhere else.
 */

// Set only by client/Dockerfile, immediately before `pnpm build`.
const isDistributableImage = process.env.FLOE_DISTRIBUTABLE_IMAGE === '1';

// Read as this exact expression: Next replaces the literal text
// `process.env.NEXT_PUBLIC_SITE_URL` at build time, so destructuring it or
// computing the key would leave it undefined.
const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();

/**
 * The public origin of this deployment, or undefined when it is unknowable.
 *
 * Trailing slashes are stripped so callers can append `/sitemap.xml` safely.
 * The check is truthiness-based on purpose: client/Dockerfile declares
 * `ARG NEXT_PUBLIC_SITE_URL=`, so the value that actually arrives is the empty
 * string, and `new URL('')` throws.
 */
export const siteUrl: string | undefined = explicit
    ? explicit.replace(/\/+$/, '')
    : isDistributableImage
      ? undefined
      : 'https://www.floe.one';

/**
 * `metadataBase` for Next's Metadata API, or null when the origin is unknown.
 *
 * null matters: without it Next falls back to http://localhost:3000 and resolves
 * every relative Open Graph image against it, which is worse than no image at all.
 */
export const metadataBase: URL | null = siteUrl ? new URL(siteUrl) : null;
