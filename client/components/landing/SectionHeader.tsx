import React, { ReactNode } from 'react';

/**
 * Shared rhythm for every landing section below the hero:
 * hairline top rule, generous vertical spacing, anchor offset for the fixed navbar.
 */
export const sectionClass =
    'mt-20 w-full max-w-5xl scroll-mt-28 border-t border-white/[0.06] pt-14 sm:mt-24 sm:pt-16';

export function SectionHeader({
    eyebrow,
    headline,
    lede,
}: {
    eyebrow: string;
    headline: string;
    lede?: ReactNode;
}) {
    return (
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-12">
            <div className="lg:col-span-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ice">{eyebrow}</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-100 sm:text-4xl">
                    {headline}
                </h2>
            </div>
            {lede ? (
                <div className="lg:col-span-7 lg:pt-11">
                    <p className="max-w-xl text-base leading-relaxed text-zinc-400">{lede}</p>
                </div>
            ) : null}
        </div>
    );
}
