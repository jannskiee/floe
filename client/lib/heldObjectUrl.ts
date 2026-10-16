/**
 * One object URL kept alive for a while after its download starts, then
 * revoked. Download ZIP's archive (hooks/useDownloadManager.ts) uses it.
 *
 * Never revoked right after the click: the browser opens the download after
 * the click returns, and a URL revoked first fails it, which for a
 * multi-gigabyte archive throws the whole build away. Not kept for the life of
 * the tab either: where Blob bytes stay in memory (Firefox, Safari, a private
 * window) the archive is a second copy of every file. So the URL goes when
 * the hold runs out, when the next one replaces it, or on `release`.
 */
export interface HeldObjectUrl {
    /** Revokes the URL held before, then makes one for `blob` and holds it. */
    hold(blob: Blob): string;
    /** Revokes the held URL now, if there is one. */
    release(): void;
}

export interface ObjectUrlApi {
    create: (blob: Blob) => string;
    revoke: (url: string) => void;
}

const browserUrls: ObjectUrlApi = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
};

export function holdObjectUrl(holdMs: number, api: ObjectUrlApi = browserUrls): HeldObjectUrl {
    let held: { url: string; timer: ReturnType<typeof setTimeout> } | null = null;

    const release = () => {
        if (held === null) return;
        clearTimeout(held.timer);
        api.revoke(held.url);
        held = null;
    };

    return {
        hold(blob) {
            release();
            const url = api.create(blob);
            held = { url, timer: setTimeout(release, holdMs) };
            return url;
        },
        release,
    };
}
