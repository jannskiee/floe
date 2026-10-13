import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { webApplicationJsonLd } from './structuredData';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('webApplicationJsonLd', () => {
    it('describes Floe as a free web application at the given address', () => {
        expect(JSON.parse(webApplicationJsonLd('https://www.floe.one'))).toEqual({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Floe',
            url: 'https://www.floe.one',
            description: 'Secure, encrypted P2P file transfer. No accounts, no file storage, no registration required.',
            applicationCategory: 'UtilitiesApplication',
            operatingSystem: 'Any',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            browserRequirements: 'Requires a modern browser with WebRTC support',
        });
    });

    it('leaves the address out when the build cannot know it', () => {
        // The image published for self-hosters: it must claim no origin
        // rather than claim floe.one (lib/siteUrl.ts).
        const data = JSON.parse(webApplicationJsonLd(undefined));
        expect(data).not.toHaveProperty('url');
        expect(data.name).toBe('Floe');
    });

    it('cannot close the script element it is written into', () => {
        // The address comes from an operator's build setting. It goes into a
        // script element as text, where "</script>" would end the element.
        const text = webApplicationJsonLd('https://example.com/</script><script>alert(1)</script>');
        expect(text).not.toContain('<');
        expect(JSON.parse(text).url).toBe('https://example.com/</script><script>alert(1)</script>');
    });
});

// Where the block is rendered. It describes the site, so it belongs on the
// home page. It used to sit in the root layout, which put it on every route,
// the request link page included: a page that is marked noindex and that is
// kept as bare as possible on purpose.
describe('where the block is rendered', () => {
    it('is on the home page, once, and nowhere in the layout or on /r', () => {
        const home = read('../app/page.tsx');
        expect(home.match(/application\/ld\+json/g)).toHaveLength(1);
        expect(home).toContain('__html: webApplicationJsonLd(siteUrl)');
        expect(read('../app/layout.tsx')).not.toContain('ld+json');
        expect(read('../app/r/[linkId]/page.tsx')).not.toContain('ld+json');
    });
});

// A sitemap date is a claim that the page changed then. Every entry carried
// the time of the build, so each deploy told crawlers that all five pages had
// just changed, which teaches a crawler to ignore the field. No date is the
// truthful value when none is tracked.
describe('the sitemap', () => {
    const sitemap = read('../app/sitemap.ts');

    it('claims no modification date', () => {
        expect(sitemap).not.toContain('new Date(');
        expect(sitemap).not.toContain('lastModified');
    });

    it('still lists the five pages', () => {
        const urls = [...sitemap.matchAll(/url: (siteUrl|`\$\{siteUrl\}(\/[a-z-]+)`),/g)].map((m) => m[2] ?? '/');
        expect(urls).toEqual(['/', '/download', '/how-it-works', '/privacy', '/terms']);
    });
});
