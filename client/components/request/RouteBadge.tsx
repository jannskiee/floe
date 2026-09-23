import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';

/** C-55: Direct or Relay, from the connection-type poll. The green and amber
 *  dots keep the meaning they have everywhere else in Floe, and they are the
 *  only colored dots on the page. Nothing until the route is known: a guess
 *  that flips from Direct to Relay would be worse than a blank. */
export function RouteBadge({ route }: { route: 'direct' | 'relay' | null }) {
    if (!route) return null;
    return (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            <span
                className={`h-1.5 w-1.5 rounded-full ${route === 'direct' ? 'bg-green-500' : 'bg-amber-500'}`}
                aria-hidden="true"
            />
            {route === 'direct' ? visitorCopy.badgeDirect : visitorCopy.badgeRelay}
        </span>
    );
}
