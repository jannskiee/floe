import type {Dispatch, SetStateAction} from 'react';
import {ArrowDownLeft, ArrowUpRight, ChevronDown} from 'lucide-react';
import {OpenFolder, RevealFile} from '../../wailsjs/go/main/App';
import {cn, Eyebrow} from './ui';
import {fmtWhen, histKey, type HistEntry} from '../history';
import {fmtBytes} from '../incoming';

/** HistoryView is the History console: the header with Clear and its inline
 *  confirm, the empty state, and the list of expandable rows.
 *
 *  All six values are owned by App.tsx and passed through unchanged. The state
 *  cannot move in here: App's leave-history effect abandons a pending Clear
 *  confirmation, and Start over resets both confirmClear and expandedRow, so
 *  both writers live outside this view. The names in each row came from the
 *  other machine (see the floe:history row of the consumer map); they reach
 *  React as text nodes only, and RevealFile is gated by safeLeaf in reveal.go. */
export default function HistoryView({history, setHistory, confirmClear, setConfirmClear, expandedRow, setExpandedRow}: {
    history: HistEntry[];
    setHistory: Dispatch<SetStateAction<HistEntry[]>>;
    confirmClear: boolean;
    setConfirmClear: Dispatch<SetStateAction<boolean>>;
    expandedRow: string | null;
    setExpandedRow: Dispatch<SetStateAction<string | null>>;
}) {
    return (
        <div className="space-y-3">
            <div className="flex items-baseline justify-between px-0.5">
                <Eyebrow>History</Eyebrow>
                {history.length > 0 && !confirmClear && (
                    <button
                        onClick={() => setConfirmClear(true)}
                        className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 transition-colors hover:text-zinc-300"
                    >
                        Clear
                    </button>
                )}
                {confirmClear && (
                    <span className="animate-floe-in flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em]">
                        <span className="text-zinc-500">Clear all?</span>
                        <button
                            onClick={() => { setHistory([]); setConfirmClear(false); }}
                            className="text-red-400 transition-colors hover:text-red-300"
                        >
                            Yes
                        </button>
                        <button
                            onClick={() => setConfirmClear(false)}
                            className="text-zinc-600 transition-colors hover:text-zinc-300"
                        >
                            No
                        </button>
                    </span>
                )}
            </div>
            {history.length === 0 ? (
                <p className="py-8 text-center text-xs text-zinc-500">No transfers yet.</p>
            ) : (
                <ul className="custom-scrollbar max-h-80 divide-y divide-white/[0.04] overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02]">
                    {history.map((h, i) => {
                        const key = histKey(h);
                        const multi = h.count > 1;
                        const expanded = expandedRow === key;
                        const panelId = `floe-hist-panel-${i}`;
                        return (
                            <li key={key} className="transition-colors hover:bg-white/[0.03]">
                                {/* The whole row is one disclosure button, the same idiom as the
                                    Advanced section. Every entry expands, single-file rows included,
                                    because collapsed titles truncate. Nothing else is clickable on
                                    the row; the actions live inside the panel as labeled text. */}
                                <button
                                    type="button"
                                    onClick={() => setExpandedRow(expanded ? null : key)}
                                    aria-expanded={expanded}
                                    aria-controls={expanded ? panelId : undefined}
                                    className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ice/60"
                                >
                                    {h.kind === 'send'
                                        ? <ArrowUpRight className="size-4 shrink-0 text-zinc-500"/>
                                        : <ArrowDownLeft className="size-4 shrink-0 text-zinc-500"/>}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-zinc-200">
                                            {h.count === 1 ? (h.names[0] || '1 file') : `${h.count} files`}
                                        </span>
                                        <span className="flex items-center gap-2 text-xs text-zinc-500">
                                            <span>{h.kind === 'send' ? 'Sent' : 'Received'}</span>
                                            {h.bytes != null && h.bytes > 0 && <span>{fmtBytes(h.bytes)}</span>}
                                            <span>{fmtWhen(h.at)}</span>
                                        </span>
                                    </span>
                                    <ChevronDown className={cn('size-3.5 shrink-0 text-zinc-600 transition-[color,transform] duration-200 group-hover:text-zinc-400 motion-reduce:transition-none', expanded && 'rotate-180')}/>
                                </button>
                                {expanded && (
                                    <div id={panelId} className="animate-floe-in space-y-2 px-3.5 pb-2.5 motion-reduce:animate-none">
                                        {multi ? (
                                            <ul className="custom-scrollbar max-h-32 space-y-1 overflow-y-auto pl-7">
                                                {h.names.map((n, j) => (
                                                    <li key={`${key}-${j}`} className="truncate text-xs text-zinc-500">{n}</li>
                                                ))}
                                            </ul>
                                        ) : h.names[0] ? (
                                            <p className="break-all pl-7 text-xs text-zinc-500">{h.names[0]}</p>
                                        ) : null}
                                        {h.kind === 'recv' && h.dir && (
                                            <p className="truncate pl-7 font-mono text-xs text-zinc-500" title={h.dir}>{h.dir}</p>
                                        )}
                                        {/* Footer actions behind an inset hairline. The border-t is the
                                            row dividers' white/[0.04] but stops at the px-3.5 content
                                            edges, so it reads as this panel's footer, not the next row's
                                            edge. Both actions group to the right rail, dialog-footer
                                            style with the destructive action outermost: Show in folder,
                                            then Remove. Remove's -mr-2 cancels its own px-2 so its label
                                            right-aligns to the px-3.5 rail under the chevron (hover pill
                                            mirroring into the gutter) - the same right-rail grammar as
                                            the header Clear and Settings' Reset. gap-4 keeps the safe
                                            action a deliberate reach away from the destructive one, and
                                            DOM order keeps Show in folder before Remove for Tab. */}
                                        <div className="flex items-center justify-end gap-4 border-t border-white/[0.04] pt-2">
                                            {h.kind === 'recv' && h.dir && (
                                                <button
                                                    type="button"
                                                    onClick={() => { (h.count === 1 ? RevealFile(h.dir!, h.names[0] || '') : OpenFolder(h.dir!)).catch(() => {}); }}
                                                    className="rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                                >
                                                    Show in folder
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => { setHistory((prev) => prev.filter((_, idx) => idx !== i)); setExpandedRow(null); }}
                                                className="-mr-2 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-red-400/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
