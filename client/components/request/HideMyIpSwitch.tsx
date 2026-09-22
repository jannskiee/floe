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
        <label className="mt-5 flex cursor-pointer select-none items-center gap-3 text-sm text-zinc-200">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="h-4 w-4 shrink-0 cursor-pointer accent-white"
            />
            <span>{visitorCopy.hideIp}</span>
        </label>
    );
}
