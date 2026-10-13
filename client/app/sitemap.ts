import { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

export default function sitemap(): MetadataRoute.Sitemap {
    // A sitemap has to carry absolute URLs; the schema rejects relative <loc>
    // values. The published image cannot know its own domain, so it serves a
    // valid but empty urlset rather than advertising floe.one's pages as its own.
    if (!siteUrl) {
        return [];
    }

    // No modification date on any entry. A date here is a claim that the page
    // changed then, and none is tracked: every entry used to carry the time
    // of the build, so each deploy told crawlers that all five pages had just
    // changed.
    return [
        {
            url: siteUrl,
            changeFrequency: 'weekly',
            priority: 1.0,
        },
        {
            url: `${siteUrl}/download`,
            changeFrequency: 'monthly',
            priority: 0.8,
        },
        {
            url: `${siteUrl}/how-it-works`,
            changeFrequency: 'monthly',
            priority: 0.7,
        },
        {
            url: `${siteUrl}/privacy`,
            changeFrequency: 'monthly',
            priority: 0.3,
        },
        {
            url: `${siteUrl}/terms`,
            changeFrequency: 'monthly',
            priority: 0.3,
        },
    ];
}
