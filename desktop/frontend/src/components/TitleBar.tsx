import type {CSSProperties} from 'react';
import {Minus, Square, X} from 'lucide-react';
import {WindowMinimise, WindowToggleMaximise, Quit} from '../../wailsjs/runtime/runtime';
import {BoltMark} from './ui';

// Wails turns any element with `--wails-draggable: drag` into a window drag
// handle; children marked `no-drag` (the window controls) stay clickable.
const drag = {['--wails-draggable' as never]: 'drag'} as CSSProperties;
const noDrag = {['--wails-draggable' as never]: 'no-drag'} as CSSProperties;

/** TitleBar is the custom frameless chrome: brand lockup on the left, window
 *  controls on the right. The whole strip drags the window; double-click
 *  toggles maximise. */
export default function TitleBar() {
    return (
        <div
            style={drag}
            onDoubleClick={() => WindowToggleMaximise()}
            className="flex h-9 shrink-0 select-none items-center justify-between border-b border-white/[0.06] bg-zinc-950 pl-3.5"
        >
            <div className="flex items-center gap-2">
                <BoltMark className="size-3.5 text-white"/>
                <span className="text-[13px] font-semibold tracking-tight text-white">Floe</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">desktop</span>
            </div>

            <div style={noDrag} className="flex items-center">
                <button
                    aria-label="Minimise"
                    onClick={() => WindowMinimise()}
                    className="grid h-9 w-11 place-items-center text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
                >
                    <Minus className="size-4"/>
                </button>
                <button
                    aria-label="Maximise"
                    onClick={() => WindowToggleMaximise()}
                    className="grid h-9 w-11 place-items-center text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
                >
                    <Square className="size-3.5"/>
                </button>
                <button
                    aria-label="Close"
                    onClick={() => Quit()}
                    className="grid h-9 w-11 place-items-center text-zinc-500 transition-colors hover:bg-red-500/90 hover:text-white"
                >
                    <X className="size-4"/>
                </button>
            </div>
        </div>
    );
}
