// The pieces the send and receive consoles are assembled from.

import type {CSSProperties} from 'react';
import {AlertCircle, ChevronDown, Files, Folder, Loader2, UploadCloud, X} from 'lucide-react';
import {Button, cn} from './ui';
import FileIcon from './FileIcon';
import {baseName} from '../paths';

export function ProgressRow({prog}: {prog: {pct: number; label: string}}) {
    return (
        <div className="animate-floe-in space-y-2">
            <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-zinc-400">
                <span className="truncate">{prog.label}</span>
                <span className="shrink-0 text-zinc-500">{prog.pct}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full rounded-full bg-white transition-[width] duration-150"
                    style={{width: `${prog.pct}%`}}
                />
            </div>
        </div>
    );
}

/** StatusLine is the small centred status/error line under a card.
 *
 *  `live` is opt-in. An aria-live region only announces changes while it is in the
 *  DOM, so the element has to stay mounted through the empty state to work, which
 *  costs a permanently reserved 20px. That is right for the Settings server test,
 *  where the result arrives seconds later and is the entire point of pressing the
 *  button, and wrong for the send and receive lines, which sit in tight layouts and
 *  should collapse to nothing when idle. */
export function StatusLine({text, busy, live}: {text: string; busy: boolean; live?: boolean}) {
    if (!text && !live) return null;
    const isError = text.startsWith('Error');
    return (
        <p
            {...(live ? {role: 'status' as const, 'aria-live': 'polite' as const} : {})}
            className={cn('flex min-h-5 items-center justify-center gap-2 text-center text-xs', isError ? 'text-red-400' : 'text-zinc-500')}
        >
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin"/>}
            {isError && <AlertCircle className="size-3.5 shrink-0"/>}
            <span>{text}</span>
        </p>
    );
}

/** FooterNote is the reassurance/warning line under the card and the settings
 *  screen, styled to match the browser transfer card's footer. */
export function FooterNote({busy}: {busy: boolean}) {
    return (
        <p className={cn('text-center text-[10px] uppercase leading-relaxed tracking-wide', busy ? 'text-amber-300/80' : 'text-zinc-500')}>
            {busy ? 'Keep this window open. Closing it cancels the transfer.' : 'End-to-end encrypted. Files are never stored on a server.'}
        </p>
    );
}

// Wails highlights the element carrying this var while an OS drag hovers it.
// Dropping works window-wide regardless (OnFileDrop useDropTarget=false); the
// var only drives the hover highlight.
const dropVar = {['--wails-drop-target' as never]: 'drop'} as CSSProperties;

/** Dropzone is the file selector: a full invitation while the selection is empty,
 *  a slim "Add files" row once files are picked. */
export function Dropzone({expanded, onPickFiles, onPickFolder}: {
    expanded: boolean;
    onPickFiles: () => void;
    onPickFolder: () => void;
}) {
    if (!expanded) {
        return (
            <div style={dropVar} className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-white/40 bg-white/[0.02] py-1.5 pl-3 pr-1.5 transition-colors hover:border-white/70">
                <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="text-sm font-medium text-zinc-200">Add files</span>
                    <span className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">or drop anywhere</span>
                </span>
                <span className="flex shrink-0 gap-1">
                    <Button variant="ghost" className="px-2 py-1.5" onClick={onPickFiles} aria-label="Add files">
                        <Files/>
                    </Button>
                    <Button variant="ghost" className="px-2 py-1.5" onClick={onPickFolder} aria-label="Add a folder">
                        <Folder/>
                    </Button>
                </span>
            </div>
        );
    }
    return (
        <div style={dropVar} className="group rounded-xl border border-dashed border-white/40 bg-white/[0.02] p-5 text-center transition-colors hover:border-white/70 hover:bg-white/[0.03]">
            <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] transition group-hover:border-white/25">
                <UploadCloud className="h-5 w-5 text-white/70 transition group-hover:text-white"/>
            </span>
            <p className="text-sm font-medium text-zinc-200">Select files to send</p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">or drag them onto the window</p>
            <div className="mt-3 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={onPickFiles}>
                    <Files/> Files
                </Button>
                <Button variant="outline" className="flex-1" onClick={onPickFolder}>
                    <Folder/> Folder
                </Button>
            </div>
        </div>
    );
}

/** FileList is the editable selection: compact rows with a remove control. */
export function FileList({files, onRemove}: {files: string[]; onRemove: (path: string) => void}) {
    return (
        <ul className="custom-scrollbar max-h-40 space-y-1.5 overflow-y-auto">
            {files.map((f) => (
                <li key={f} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] py-1.5 pl-2 pr-1">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] ring-1 ring-inset ring-white/10">
                        <FileIcon name={f}/>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{baseName(f)}</span>
                    <button
                        onClick={() => onRemove(f)}
                        aria-label={`Remove ${baseName(f)}`}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-600 transition-colors hover:bg-white/10 hover:text-zinc-200"
                    >
                        <X className="size-3.5"/>
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** FileSummary collapses the selection to one row while a transfer is in flight;
 *  the chevron expands a read-only list. */
export function FileSummary({files, open, onToggle}: {files: string[]; open: boolean; onToggle: () => void}) {
    return (
        <div className="space-y-1.5">
            <button
                onClick={onToggle}
                className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
            >
                <span className="flex items-center gap-2.5">
                    <Files className="size-4 text-zinc-400"/>
                    <span className="text-sm text-zinc-300">{files.length} {files.length === 1 ? 'item' : 'items'}</span>
                </span>
                <ChevronDown className={cn('size-4 text-zinc-500 transition-transform', open && 'rotate-180')}/>
            </button>
            {open && (
                <ul className="custom-scrollbar max-h-32 space-y-1.5 overflow-y-auto">
                    {files.map((f) => (
                        <li key={f} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                            <FileIcon name={f}/>
                            <span className="min-w-0 truncate text-sm text-zinc-300">{baseName(f)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
