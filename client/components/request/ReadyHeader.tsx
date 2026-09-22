import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';
import { REQUEST_LINK_DOCS_PATH } from '@/lib/request/constants';

/** The Ready header: eyebrow with the Beta chip, the intro, "What is a request
 *  link?" under it on the right, and the support line. It opens the Ready
 *  card; the controls follow it inside the same card. */
export function ReadyHeader() {
    return (
        <>
            <div className="flex items-baseline justify-between gap-4">
                {/* The page's heading, drawn as the mono eyebrow the approved
                    frame shows. A heading element rather than a paragraph so
                    the Ready state has one, like the two notice states do. */}
                <h1 className="pl-[0.2em] font-mono text-[11px] leading-none tracking-[0.2em] text-zinc-500">
                    {visitorCopy.readyEyebrow}
                </h1>
                <span className="shrink-0 rounded-full border border-ice/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ice">
                    {visitorCopy.betaChip}
                </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-zinc-300">
                {visitorCopy.readyIntro}
            </p>
            <p className="mt-1 text-right text-sm">
                {/* rel="noreferrer" on top of the /r no-referrer header: the
                    path carries the link id, and this is a same-origin link
                    into the docs rewrite. */}
                <a
                    href={REQUEST_LINK_DOCS_PATH}
                    rel="noreferrer"
                    className="text-zinc-300 underline underline-offset-2 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
                >
                    {visitorCopy.whatIsRequestLink}
                </a>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                {visitorCopy.betaSupport}
            </p>
        </>
    );
}
