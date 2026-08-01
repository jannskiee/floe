/**
 * Evergreen deep link to the newest desktop installer, for the README, docs,
 * and anywhere a URL must outlive individual releases.
 *
 * GitHub's own /releases/latest permalink can never serve this purpose here:
 * the desktop ships as pre-releases with make_latest false, so "latest"
 * permanently resolves to the CLI release (the install scripts, `floe update`,
 * and the back-compat CI depend on exactly that). The newest desktop release
 * must instead be found by filtering the release list for desktop-v* tags.
 *
 * The GitHub call is cached for 15 minutes via the fetch data cache, so the
 * unauthenticated 60-requests-per-hour API budget is never a concern; setting
 * GITHUB_TOKEN (optional, public-repo read-only) raises it regardless. Every
 * failure path falls back to the pinned current release, so this route
 * redirects somewhere real no matter what.
 */

import { NextResponse } from 'next/server';
import { DESKTOP_SETUP_URL } from '@/lib/desktopRelease';

type Release = {
    tag_name: string;
    draft: boolean;
    assets: { name: string; browser_download_url: string }[];
};

export async function GET() {
    let target = DESKTOP_SETUP_URL;
    try {
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const res = await fetch('https://api.github.com/repos/jannskiee/floe/releases?per_page=20', {
            headers,
            next: { revalidate: 900 },
        });
        if (res.ok) {
            const releases = (await res.json()) as Release[];
            const desktop = releases.find((r) => !r.draft && r.tag_name.startsWith('desktop-v'));
            const asset = desktop?.assets.find((a) => /^floe-desktop-setup-.+\.exe$/.test(a.name));
            if (asset) target = asset.browser_download_url;
        }
    } catch {
        // Network or parse failure: the pinned fallback already stands.
    }
    return NextResponse.redirect(target, {
        status: 302,
        headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=86400' },
    });
}
