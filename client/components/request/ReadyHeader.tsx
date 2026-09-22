import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';

/** The Ready header: eyebrow with the Beta chip, the intro, and the support
 *  line. The controls below it arrive with S1-WEB-03. */
export function ReadyHeader() {
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
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
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                {visitorCopy.betaSupport}
            </p>
        </section>
    );
}
