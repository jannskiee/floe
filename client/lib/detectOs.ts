/**
 * Coarse OS classification for the download page: which arrangement of the
 * download panel a visitor should see first. Detection only reorders emphasis;
 * every option stays visible, so a wrong guess costs one extra glance.
 *
 * Pure so it can be unit-tested; the client island feeds it real values from
 * navigator on mount. userAgentData.platform is preferred where present
 * (Chromium), the user-agent string is the fallback everywhere else.
 */

export type VisitorOs = 'windows' | 'mac' | 'linux' | 'mobile';

export function detectOs(userAgent: string, uaDataPlatform?: string): VisitorOs {
    const ua = userAgent.toLowerCase();

    // Mobile first: iPadOS reports "Macintosh" in its UA, and Android reports
    // "Linux", so the mobile checks must win over the desktop ones.
    if (/iphone|ipad|ipod|android/.test(ua)) return 'mobile';
    if (uaDataPlatform === 'Android' || uaDataPlatform === 'iOS') return 'mobile';

    const platform = (uaDataPlatform || '').toLowerCase();
    if (platform.includes('windows')) return 'windows';
    if (platform.includes('mac')) return 'mac';
    if (platform.includes('linux') || platform.includes('chrome os')) return 'linux';

    if (ua.includes('windows')) return 'windows';
    if (ua.includes('macintosh') || ua.includes('mac os')) return 'mac';
    if (ua.includes('linux') || ua.includes('x11') || ua.includes('cros')) return 'linux';

    // The desktop beta is Windows-only, and Windows is the majority visitor:
    // the server-rendered default arrangement, kept for unknown agents.
    return 'windows';
}
