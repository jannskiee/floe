import React, { useEffect, useRef, type ChangeEvent, type DragEvent } from 'react';
import { Plus, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { visitorCopy } from '@/lib/request/visitorCopy';

// webkitdirectory is not in React's input attribute types. Spread as a plain
// attribute, React writes it to the DOM as is.
const FOLDER_PICKER = { webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>;

export interface RequestDropzoneProps {
    hasFiles: boolean;
    isDragging: boolean;
    /** A drop is still being walked: shown as busy, never as a drop of nothing. */
    reading: boolean;
    /** Choose folder is shown only where folder picking works (canPickFolders). */
    canPickFolders: boolean;
    /** On a phone or tablet the drop line is hidden; the buttons stay. */
    coarsePointer: boolean;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onFiles: (e: ChangeEvent<HTMLInputElement>) => void;
    onFolder: (e: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * W1's dropzone before the first pick, and the compact "Add more files" strip
 * after it (the shipped transfer card's pattern). Dropzone hover stays white;
 * ice is only for the engaged state while files are dragged over it.
 *
 * The file inputs are hidden and driven by labeled buttons, so every name a
 * screen reader hears is an approved string.
 *
 * The two layouts swap the control that held focus out from under it: Choose
 * files after the first pick, Clear (beside Send) after clearing. Focus then
 * fell to <body> and a keyboard user restarted from the top of the page, so it
 * moves to the control that took its place, and only when it was lost. After
 * a pick, only when a pick button held it: a drop never did, and focusing the
 * strip then drew its ring for a mouse user who had only dragged files in
 * (Chromium counts a script focus with no earlier focus as focus-visible).
 */
export function RequestDropzone(props: RequestDropzoneProps) {
    const filesInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const chooseFiles = useRef<HTMLButtonElement>(null);
    const addMore = useRef<HTMLInputElement>(null);
    const shown = useRef(props.hasFiles);
    const pickedByButton = useRef(false);
    const { isDragging, reading, hasFiles } = props;

    useEffect(() => {
        if (shown.current === hasFiles) return;
        shown.current = hasFiles;
        const fromButton = pickedByButton.current;
        pickedByButton.current = false;
        if (hasFiles && !fromButton) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        (hasFiles ? addMore.current : chooseFiles.current)?.focus();
    }, [hasFiles]);

    const inputs = (
        <>
            <input ref={filesInput} type="file" multiple hidden tabIndex={-1} onChange={props.onFiles} />
            {props.canPickFolders && (
                <input
                    ref={folderInput}
                    type="file"
                    multiple
                    hidden
                    tabIndex={-1}
                    onChange={props.onFolder}
                    {...FOLDER_PICKER}
                />
            )}
        </>
    );

    const zone = isDragging
        ? 'border-ice bg-ice/[0.04]'
        : 'border-white/15 hover:border-white/35 hover:bg-white/[0.02]';

    if (hasFiles) {
        return (
            <div
                onDragOver={props.onDragOver}
                onDragLeave={props.onDragLeave}
                onDrop={props.onDrop}
                aria-busy={reading}
                // The input covering the strip is invisible, so the strip
                // draws its keyboard focus: the Button's own ring.
                className={`group relative mt-5 flex items-center justify-center gap-2 rounded-lg border border-dashed py-3 transition-all has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/50 ${zone} ${reading ? 'opacity-60' : ''}`}
            >
                <Plus className={`h-3.5 w-3.5 transition ${isDragging ? 'text-ice' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                <span className="text-xs font-medium text-zinc-400 transition group-hover:text-zinc-200">
                    {isDragging ? visitorCopy.releaseToAdd : visitorCopy.addMoreFiles}
                </span>
                {/* 40 px tall; on a touch screen it reaches 2 px past each
                    edge, 44 px to the finger, drawn as nothing. */}
                <input
                    ref={addMore}
                    type="file"
                    multiple
                    aria-label={visitorCopy.addMoreFiles}
                    onChange={props.onFiles}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 pointer-coarse:-inset-y-0.5 pointer-coarse:h-auto"
                />
            </div>
        );
    }

    return (
        <div
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onDrop={props.onDrop}
            aria-busy={reading}
            className={`group mt-5 flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-9 text-center transition-all ${zone} ${reading ? 'opacity-60' : ''}`}
        >
            <div
                className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full border transition ${
                    isDragging ? 'border-ice/60 bg-ice/10' : 'border-white/10 bg-white/[0.03] group-hover:border-white/25'
                }`}
            >
                <UploadCloud className={`h-5 w-5 transition ${isDragging ? 'text-ice' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
            </div>
            {!props.coarsePointer && (
                <p className="mb-4 text-sm font-medium text-zinc-200">
                    {isDragging ? visitorCopy.releaseToAdd : visitorCopy.dropHere}
                </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                    ref={chooseFiles}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="touch-button h-auto min-h-8 max-w-full whitespace-normal py-[5px] text-center"
                    onClick={(e) => {
                        pickedByButton.current = document.activeElement === e.currentTarget;
                        filesInput.current?.click();
                    }}
                >
                    {visitorCopy.chooseFiles}
                </Button>
                {props.canPickFolders && (
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="touch-button h-auto min-h-8 max-w-full whitespace-normal py-[5px] text-center"
                        onClick={(e) => {
                            pickedByButton.current = document.activeElement === e.currentTarget;
                            folderInput.current?.click();
                        }}
                    >
                        {visitorCopy.chooseFolder}
                    </Button>
                )}
            </div>
            {inputs}
        </div>
    );
}
