import React from 'react';

/** V1 and V2. Both are terminal, both were decided locally, and neither offers a
 *  button: there is nothing here for the page to retry. */
export function NoticeCard({ title, body }: { title: string; body: string }) {
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
            <div className="flex items-center gap-2.5">
                <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600"
                    aria-hidden="true"
                />
                <h1 className="text-base font-semibold tracking-tight text-white">{title}</h1>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{body}</p>
        </section>
    );
}
