import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
    // Mirrors siteUrl in app/layout.tsx; set NEXT_PUBLIC_SITE_URL when self-hosting.
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.floe.one';

    return [
        {
            url: baseUrl,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: 1.0,
        },
        {
            url: `${baseUrl}/how-it-works`,
            lastModified: new Date(),
            changeFrequency: 'monthly',
            priority: 0.7,
        },
        {
            url: `${baseUrl}/privacy`,
            lastModified: new Date(),
            changeFrequency: 'monthly',
            priority: 0.3,
        },
        {
            url: `${baseUrl}/terms`,
            lastModified: new Date(),
            changeFrequency: 'monthly',
            priority: 0.3,
        },
    ];
}
