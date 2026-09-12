import { describe, it, expect } from 'vitest';
import { detectInAppBrowser, isAndroid } from './inAppBrowser';

// Every case hands a user-agent string in. Both functions take `ua` as a
// parameter on purpose: under vitest, Node's own navigator.userAgent is
// "Node.js/22", so a version that read the global itself would make every
// "returns null" assertion below pass without testing anything.

const IOS_FACEBOOK =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.35.108;FBBV/542017005;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/17.1;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0]';
const ANDROID_FACEBOOK =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.31.107;]';
// Every shipping Messenger build identifies itself with the FBAN/FBAV block
// above and lands on the Facebook branch first, so this is the shape a user
// agent has to take to reach the Messenger branch at all: the product token
// on its own.
const IOS_MESSENGER_BARE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Messenger/440.0.0.30.108';
const IOS_INSTAGRAM =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 309.0.0.15.108 (iPhone14,2; iOS 17_1_1; en_US; en; scale=3.00; 1170x2532; 541096306)';
const ANDROID_TIKTOK =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 trill_2023109020 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/31.9.2 ByteLocale/en ByteFullLocale/en Region/US';
const IOS_TIKTOK =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok 31.9.0 rv:319000 (iPhone; iOS 17.1; en_US) Cronet';
const IOS_SNAPCHAT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.60.0.40 (iPhone14,2; iOS 17.1; gzip)';
const IOS_LINE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.18.0';
const IOS_TWITTER =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.10';
const IOS_WECHAT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c2d) NetType/WIFI Language/en';
const ANDROID_BARE_WEBVIEW =
    'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36';
const ANDROID_CHROME_WEBVIEW =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36';
const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
const IOS_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const NODE = 'Node.js/22';

describe('detectInAppBrowser', () => {
    it('names Facebook from its FBAN and FBAV tokens on both platforms', () => {
        expect(detectInAppBrowser(IOS_FACEBOOK)).toBe('Facebook');
        expect(detectInAppBrowser(ANDROID_FACEBOOK)).toBe('Facebook');
    });

    it('names Messenger from a bare Messenger product token', () => {
        expect(detectInAppBrowser(IOS_MESSENGER_BARE)).toBe('Messenger');
    });

    it('names Instagram', () => {
        expect(detectInAppBrowser(IOS_INSTAGRAM)).toBe('Instagram');
    });

    it('names TikTok from either its musical_ly or its TikTok token', () => {
        expect(detectInAppBrowser(ANDROID_TIKTOK)).toBe('TikTok');
        expect(detectInAppBrowser(IOS_TIKTOK)).toBe('TikTok');
    });

    it('names Snapchat', () => {
        expect(detectInAppBrowser(IOS_SNAPCHAT)).toBe('Snapchat');
    });

    it('names LINE from a Line/<version> token', () => {
        expect(detectInAppBrowser(IOS_LINE)).toBe('LINE');
    });

    it('names Twitter', () => {
        expect(detectInAppBrowser(IOS_TWITTER)).toBe('Twitter');
    });

    it('names WeChat from MicroMessenger, and never reads that as Messenger', () => {
        // \bMessenger\b needs a word boundary before the M; MicroMessenger has
        // none, so the WeChat branch is the one that answers.
        expect(detectInAppBrowser(IOS_WECHAT)).toBe('WeChat');
    });

    it('names a generic Android webview only when it carries no Chrome version', () => {
        expect(detectInAppBrowser(ANDROID_BARE_WEBVIEW)).toBe('InAppBrowser');
        expect(detectInAppBrowser(ANDROID_CHROME_WEBVIEW)).toBeNull();
    });

    it('returns null for a real browser', () => {
        expect(detectInAppBrowser(DESKTOP_CHROME)).toBeNull();
        expect(detectInAppBrowser(IOS_SAFARI)).toBeNull();
        expect(detectInAppBrowser(ANDROID_CHROME)).toBeNull();
    });

    it('returns null for the strings a test runner would hand it', () => {
        expect(detectInAppBrowser('')).toBeNull();
        expect(detectInAppBrowser(NODE)).toBeNull();
    });
});

describe('isAndroid', () => {
    it('is true for Android user agents', () => {
        expect(isAndroid(ANDROID_CHROME)).toBe(true);
        expect(isAndroid(ANDROID_FACEBOOK)).toBe(true);
    });

    it('is false for iOS, desktop and the test runner', () => {
        expect(isAndroid(IOS_SAFARI)).toBe(false);
        expect(isAndroid(IOS_FACEBOOK)).toBe(false);
        expect(isAndroid(DESKTOP_CHROME)).toBe(false);
        expect(isAndroid(NODE)).toBe(false);
    });
});
