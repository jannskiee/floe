import React from 'react';
import { Marker } from '@/components/request/RequestStatus';

/** V1 and V2. Both are terminal, both were decided locally, and neither offers a
 *  button: there is nothing here for the page to retry. The dot is the status
 *  cards' ending ring (WV-09, WV-10). */
export function NoticeCard({ title, body }: { title: string; body: string }) {
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
            <div className="flex items-start gap-2.5">
                <Marker kind="ended" />
                <h1 className="text-base font-semibold leading-[1.3] tracking-tight text-white">{title}</h1>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{body}</p>
        </section>
    );
}
