import React from 'react';
import { Button } from '@/components/ui/button';
import { visitorCopy, type StatusCopy } from '@/lib/request/visitorCopy';
import { ArrivedList, type PathRow } from '@/components/request/ArrivedList';
import { RouteBadge } from '@/components/request/RouteBadge';

/** Where C-80's Learn more goes (APP-3), the main page's relay explainer. */
const SIZE_LIMIT_HREF = '/how-it-works#size-limit';

/** The dot before a status title, 8 px as drawn: a hollow 1.5 px ring for an
 *  ending or a block, a solid zinc dot while connecting or waiting, green once
 *  delivered. No red, and no other color: the route badge owns green and
 *  amber. Its top margin puts its center on the title's first line at
 *  leading 1.3: 6 px for a 15 or 16 px title, 4 px for V13's 12 px mono one.
 *  NoticeCard draws the same dot for V1 and V2. */
export function Marker({ kind }: { kind: StatusCopy['marker'] }) {
    const style =
        kind === 'done'
            ? 'mt-1 bg-green-500'
            : kind === 'active'
              ? 'mt-1.5 bg-zinc-400'
              : 'mt-1.5 border-[1.5px] border-zinc-600 bg-transparent';
    return <span className={`h-2 w-2 shrink-0 rounded-full ${style}`} aria-hidden="true" />;
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
        <section className="w-full rounded-2xl border border-white/[0.08] bg-zinc-950/85 p-6 shadow-[0_40px_90px_-30px_rgb(0_0_0/0.9)] sm:p-7">
            <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-2.5">
                    <Marker kind={copy.marker} />
                    {/* Three title styles, as drawn: V13's mono caps; the
                        "one" style (15 px, medium) for a card whose whole
                        message is one sentence; a 16 px semibold heading
                        for the rest. */}
                    <h1
                        tabIndex={-1}
                        data-card-heading=""
                        className={
                            done
                                ? 'min-w-0 break-words font-mono text-[0.75rem] font-semibold uppercase leading-[1.3] tracking-[0.2em] text-white outline-none'
                                : copy.one
                                  ? 'min-w-0 break-words text-[0.9375rem] font-medium leading-[1.3] tracking-tight text-white outline-none'
                                  : 'min-w-0 break-words text-base font-semibold leading-[1.3] tracking-tight text-white outline-none'
                        }
                    >
                        {copy.title}
                    </h1>
                </div>
                {copy.badge && <RouteBadge route={route} />}
            </div>
            {copy.lines.map((line, i) => (
                // The waiting countdown is one of these lines; it changes once
                // a minute and is deliberately outside any live region. The
                // announcements live in the page's one status span.
                // break-words: C-130 quotes the visitor's raw path, and an
                // ordinary 43-character camera path ran past the card and
                // scrolled the page sideways at 280 to 360 px.
                <p key={line} className="mt-3 break-words text-sm leading-relaxed text-zinc-400">
                    {line}
                    {copy.learnMore && i === copy.lines.length - 1 && (
                        <>
                            {' '}
                            {/* V9, as WV-23 draws it: inline at the end of
                                the body. A new tab: Back to files keeps the
                                picked files, and a same-tab click here would
                                drop them. */}
                            <a
                                href={SIZE_LIMIT_HREF}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="touch-text text-zinc-300 underline underline-offset-2 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
                            >
                                {visitorCopy.learnMore}
                            </a>
                        </>
                    )}
                </p>
            ))}
            {copy.showArrived && <ArrivedList rows={arrived} />}
            {copy.action === 'cancel' && (
                <Button type="button" variant="outline" className="touch-button mt-5 w-full h-auto min-h-9 max-w-full whitespace-normal py-[7px] text-center" onClick={onAction}>
                    {visitorCopy.cancel}
                </Button>
            )}
            {(copy.action === 'try-again' || copy.action === 'back-to-files') && (
                <div className="mt-5 flex justify-end">
                    <Button type="button" variant="outline" className="touch-button h-auto min-h-9 max-w-full whitespace-normal py-[7px] text-center" onClick={onAction}>
                        {copy.action === 'try-again' ? visitorCopy.tryAgain : visitorCopy.backToFiles}
                    </Button>
                </div>
            )}
        </section>
    );
}
