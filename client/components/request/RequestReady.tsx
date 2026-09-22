import React, { type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { relayCapNotice, sendLabel, visitorCopy } from '@/lib/request/visitorCopy';
import type { SendBlock } from '@/lib/request/visitorState';
import { ReadyHeader } from '@/components/request/ReadyHeader';
import { RequestDropzone } from '@/components/request/RequestDropzone';
import { RequestFileList } from '@/components/request/RequestFileList';
import { HideMyIpSwitch } from '@/components/request/HideMyIpSwitch';
import type { PathRow } from '@/components/request/ArrivedList';

export interface RequestReadyProps {
    rows: PathRow[];
    size: number;
    /** The pick refusal, already an approved string, or null. */
    notice: string | null;
    emptyFolders: number;
    reading: boolean;
    isDragging: boolean;
    canPickFolders: boolean;
    coarsePointer: boolean;
    hideIp: boolean;
    /** V6b: the last Send stopped because Hide my IP has no relay to use. */
    needsRelay: boolean;
    /** Why Send is off, or null. */
    block: SendBlock;
    onHideIp: (on: boolean) => void;
    onSend: () => void;
    onClear: () => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onFiles: (e: ChangeEvent<HTMLInputElement>) => void;
    onFolder: (e: ChangeEvent<HTMLInputElement>) => void;
    /** The right side of the footer row (Report this link). */
    footerEnd?: ReactNode;
}

/**
 * V3 Ready (W1, W3; WV-01 to WV-08), also drawn for V3c, V6b and V6d, which
 * are Ready with one more line. Before the first pick only the dropzone, the
 * switch and the notice show; the count, Send and Clear arrive with a file.
 * Button labels never change to explain themselves: when Send is off, the
 * reason is the sentence next to it (C-31).
 */
export function RequestReady(props: RequestReadyProps) {
    const hasFiles = props.rows.length > 0;
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
            <ReadyHeader />
            <RequestDropzone
                hasFiles={hasFiles}
                isDragging={props.isDragging}
                reading={props.reading}
                canPickFolders={props.canPickFolders}
                coarsePointer={props.coarsePointer}
                onDragOver={props.onDragOver}
                onDragLeave={props.onDragLeave}
                onDrop={props.onDrop}
                onFiles={props.onFiles}
                onFolder={props.onFolder}
            />
            {!props.canPickFolders && (
                <p className="mt-3 text-sm leading-relaxed text-zinc-300">{visitorCopy.foldersUnsupported}</p>
            )}
            {props.notice && <p className="mt-3 text-sm leading-relaxed text-zinc-300">{props.notice}</p>}
            {hasFiles && <RequestFileList rows={props.rows} size={props.size} emptyFolders={props.emptyFolders} />}
            <HideMyIpSwitch checked={props.hideIp} onChange={props.onHideIp} />
            {props.block === 'relay-cap' && (
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{relayCapNotice(props.size)}</p>
            )}
            {props.needsRelay && props.hideIp && (
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{visitorCopy.hideIpNeedsRelay}</p>
            )}
            {props.coarsePointer && hasFiles && (
                <p className="mt-4 text-sm leading-relaxed text-zinc-300">{visitorCopy.coarsePointer}</p>
            )}
            {hasFiles && (
                <div className="mt-4 flex gap-2">
                    <Button type="button" className="flex-1" disabled={props.block !== null} onClick={props.onSend}>
                        {sendLabel(props.rows.length)}
                    </Button>
                    <Button type="button" variant="outline" onClick={props.onClear}>
                        {visitorCopy.clear}
                    </Button>
                </div>
            )}
            <div className="mt-4 flex items-end justify-between gap-4">
                <p className="text-xs leading-relaxed text-zinc-500">{visitorCopy.ipNotice}</p>
                {props.footerEnd}
            </div>
        </section>
    );
}
