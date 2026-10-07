import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';

/** C-08: a real checkbox with a visible label. Session only, off by default,
 *  never stored. On, the peer asks for relay candidates only
 *  (iceTransportPolicy 'relay'), so the host sees the relay's address and not
 *  the visitor's. */
export function HideMyIpSwitch({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        // items-start and the box's 2 px top margin center the box on the
        // FIRST line (20 px at text-sm), which is where items-center put it
        // while the label was one line; at 344 px and under the label wraps,
        // and items-center had dropped the box 10 px, between the two lines.
        <label className="touch-text mt-5 flex cursor-pointer select-none items-start gap-3 text-sm text-zinc-200">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-white"
            />
            <span>{visitorCopy.hideIp}</span>
        </label>
    );
}
