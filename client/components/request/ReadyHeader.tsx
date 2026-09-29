import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';
import { REQUEST_LINK_DOCS_PATH } from '@/lib/request/constants';

/** The Ready header: eyebrow with the Beta chip, the intro, the support line,
 *  then "What is a request link?" on its own row at the right, in the approved
 *  WV-01 order: the text block closes with its help link, the way the card
 *  closes with Report this link. It opens the Ready card; the controls follow
 *  it inside the same card. */
export function ReadyHeader() {
    return (
        <>
            <div className="flex items-baseline justify-between gap-4">
                {/* The page's heading, drawn as the mono eyebrow the approved
                    frame shows. A heading element rather than a paragraph so
                    the Ready state has one, like the two notice states do. It
                    starts on the text edge like every line under it: a
                    pl-[0.2em] repays tracking only on a centered label.
                    zinc-400 (7.34:1 on the card, where zinc-500 was 4.00:1):
                    with the intro no longer naming the page, the heading is
                    one of the lines that say what it is. */}
                <h1 className="font-mono text-[11px] leading-none tracking-[0.2em] text-zinc-400">
                    {visitorCopy.readyEyebrow}
                </h1>
                <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-400">
                    {visitorCopy.betaChip}
                </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-zinc-300">
                {visitorCopy.readyIntro}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                {visitorCopy.betaSupport}
            </p>
            <p className="mt-1.5 text-right text-sm">
                {/* A new tab, because a same-tab click would drop the picked
                    files: Ready has no leave-page prompt. rel="noopener
                    noreferrer" on top of the /r no-referrer header: the path
                    carries the link id, and this is a same-origin link into
                    the docs rewrite. */}
                <a
                    href={REQUEST_LINK_DOCS_PATH}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-300 underline underline-offset-2 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
                >
                    {visitorCopy.whatIsRequestLink}
                </a>
            </p>
        </>
    );
}
