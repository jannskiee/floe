import React from 'react';
import { Button } from '@/components/ui/button';
import { visitorCopy, type StatusCopy } from '@/lib/request/visitorCopy';
import { ArrivedList, type PathRow } from '@/components/request/ArrivedList';
import { RouteBadge } from '@/components/request/RouteBadge';

/** Where C-80's Learn more goes (APP-3), the main page's relay explainer. */
const SIZE_LIMIT_HREF = '/how-it-works#size-limit';

/** The dot before a status title. A hollow ring for an ending or a block, a
 *  solid zinc dot while connecting or waiting, green once delivered. No red,
 *  and no other color: the route badge owns green and amber. */
function Marker({ kind }: { kind: StatusCopy['marker'] }) {
    const style =
        kind === 'done'
            ? 'bg-green-500'
            : kind === 'active'
              ? 'bg-zinc-400'
              : 'border border-zinc-600 bg-transparent';
    return <span className={`mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full ${style}`} aria-hidden="true" />;
}

/**
 * Every state card that is not Ready and not Sending: the server answers, the
 * connecting and waiting screens, the refusals and the endings. Words come only
 * from StatusCopy, which is built from the frozen table by state and
 * allowlisted code.
 *
 * Buttons sit where the frames put them: Try again and Back to files on the
 * right, Cancel full width.
 */
export function RequestStatus({
    copy,
    route,
    arrived,
    onAction,
}: {
    copy: StatusCopy;
    route: 'direct' | 'relay' | null;
    arrived: PathRow[];
    onAction: () => void;
}) {
    const done = copy.marker === 'done';
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
            <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-2.5">
                    <Marker kind={copy.marker} />
                    <h1
                        className={
                            done
                                ? 'font-mono text-[12px] font-semibold uppercase tracking-[0.2em] text-white'
                                : 'text-base font-semibold tracking-tight text-white'
                        }
                    >
                        {copy.title}
                    </h1>
                </div>
                {copy.badge && <RouteBadge route={route} />}
            </div>
            {copy.learnMore && (
                <p className="mt-2 text-sm">
                    <a
                        href={SIZE_LIMIT_HREF}
                        rel="noreferrer"
                        className="text-zinc-400 underline underline-offset-2 transition hover:text-white"
                    >
                        {visitorCopy.learnMore}
                    </a>
                </p>
            )}
            {copy.lines.map((line) => (
                // The waiting countdown is one of these lines; it changes once
                // a minute and is deliberately outside any live region. The
                // announcements live in the page's one status span.
                <p key={line} className="mt-3 text-sm leading-relaxed text-zinc-400">
                    {line}
                </p>
            ))}
            {copy.showArrived && <ArrivedList rows={arrived} />}
            {copy.action === 'cancel' && (
                <Button type="button" variant="outline" className="mt-5 w-full" onClick={onAction}>
                    {visitorCopy.cancel}
                </Button>
            )}
            {(copy.action === 'try-again' || copy.action === 'back-to-files') && (
                <div className="mt-5 flex justify-end">
                    <Button type="button" variant="outline" onClick={onAction}>
                        {copy.action === 'try-again' ? visitorCopy.tryAgain : visitorCopy.backToFiles}
                    </Button>
                </div>
            )}
        </section>
    );
}
