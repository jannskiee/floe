import { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

/**
 * Replaces the former public/robots.txt, which hardcoded floe.one's sitemap URL.
 * That file had to be DELETED rather than left alongside this route: Next checks
 * the public folder before app routes, so a static robots.txt silently wins and
 * this would never be served.
 */
export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            { userAgent: '*', allow: '/' },
            // Explicit entries for the two crawlers that fetch link previews, so
            // a future restrictive default rule cannot break share cards.
            { userAgent: 'facebookexternalhit', allow: '/' },
            { userAgent: 'Twitterbot', allow: '/' },
        ],
        // Pointing a self-hosted instance at floe.one's sitemap was the bug this
        // route exists to fix. No known origin, no Sitemap line.
        ...(siteUrl && { sitemap: `${siteUrl}/sitemap.xml` }),
    };
}
