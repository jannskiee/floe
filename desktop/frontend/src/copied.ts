// The Copied mark of the app's copy buttons: the share panel's code and link,
// Settings > About, and a request link's Copy link.

import {useEffect, useRef, useState} from 'react';

/** useCopied writes text to the clipboard and names what was copied for 1.5 s
 *  from that copy: a second copy inside the window starts its own 1.5 s, and the
 *  timer goes with the component (the share panel unmounts when the receiver
 *  joins). A clipboard that refuses leaves the mark as it was. */
export function useCopied<T>() {
    const [copied, setCopied] = useState<T | null>(null);
    const timer = useRef<number | null>(null);
    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
    async function copyText(what: T, text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(what);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(null), 1500);
        } catch {
            // clipboard unavailable
        }
    }
    return {copied, copyText};
}
