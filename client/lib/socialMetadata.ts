import type { Metadata } from 'next';
import { siteUrl } from './siteUrl';

/**
 * The Open Graph and Twitter fields every route shares.
 *
 * These exist because metadata merging in the App Router is SHALLOW. A page that
 * declares `openGraph` REPLACES the root layout's entire openGraph object rather
 * than merging into it, so a page setting only `openGraph: { title }` silently
 * drops siteName, type, locale and the images along with it. Spreading these
 * back in is the documented remedy and the only one. Every page below must
 * spread before it overrides:
 *
 *     openGraph: { ...sharedOpenGraph, title: '...' }
 *
 * Before this module existed, no page declared either block, so all six routes
 * inherited the root's wholesale and shipped an identical og:title. Sharing
 * /download or /privacy anywhere social showed the home page's headline.
 *
 * Both image arrays stay conditional on siteUrl, and they must stay conditional
 * TOGETHER. With metadataBase null (the FLOE_DISTRIBUTABLE_IMAGE=1 build for
 * ghcr.io) a relative image resolves against http://localhost:3000, which
 * renders nothing in a link preview, so omitting beats emitting a broken URL.
 * Next copies the resolved Open Graph images into twitter when twitter declares
 * none, so dropping only one of them still leaks localhost into the other.
 *
 * There is deliberately no `description` here. Next's postProcessMetadata fills
 * an absent openGraph/twitter description from the page's own `description`, so
 * leaving it out gives every route a per-page social description for free.
 * Putting one here would pin all five routes to a single string.
 */
export const sharedOpenGraph = {
    siteName: 'Floe',
    type: 'website' as const,
    locale: 'en_US',
    images: siteUrl
        ? [
              {
                  // Relative path resolves against metadataBase in app/layout.tsx.
                  url: '/og.png?v=3',
                  width: 1200,
                  height: 630,
                  alt: 'Floe: encrypted peer-to-peer file transfer',
              },
          ]
        : undefined,
} satisfies NonNullable<Metadata['openGraph']>;

export const sharedTwitter = {
    // Without an image, a large-image card renders as an empty box.
    card: (siteUrl ? 'summary_large_image' : 'summary') as 'summary_large_image' | 'summary',
    images: siteUrl ? ['/og.png?v=3'] : undefined,
} satisfies NonNullable<Metadata['twitter']>;
