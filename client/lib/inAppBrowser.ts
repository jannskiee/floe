// The in-app browser table: which webviews Floe refuses to run a transfer in,
// and the platform split the overlay copy depends on. Pure so it can be tested
// under client/vitest.config.ts, which has no DOM.
//
// Both functions take the user agent as a parameter, and must keep doing so:
// under vitest, Node's own navigator.userAgent is "Node.js/22", so a version
// that read the global itself would pass a "returns null" test without testing
// anything. InAppBrowserGuard reads navigator.userAgent once and hands it in.

export type DetectedApp =
    | 'Facebook'
    | 'Messenger'
    | 'Instagram'
    | 'TikTok'
    | 'Snapchat'
    | 'LINE'
    | 'Twitter'
    | 'WeChat'
    | 'InAppBrowser';

export function detectInAppBrowser(ua: string): DetectedApp | null {
    if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
    if (/FB_IAB.*FBAV/i.test(ua) || /\bMessenger\b/i.test(ua)) return 'Messenger';
    if (/Instagram/i.test(ua)) return 'Instagram';
    if (/musical_ly|TikTok/i.test(ua)) return 'TikTok';
    if (/Snapchat/i.test(ua)) return 'Snapchat';
    if (/\bLine\/\d/i.test(ua)) return 'LINE';
    if (/Twitter/i.test(ua)) return 'Twitter';
    if (/MicroMessenger|WeChat/i.test(ua)) return 'WeChat';
    if (/Android/.test(ua) && /wv\)/.test(ua) && !/Chrome\/\d/.test(ua)) return 'InAppBrowser';
    return null;
}

export function isAndroid(ua: string): boolean {
    return /Android/i.test(ua);
}
