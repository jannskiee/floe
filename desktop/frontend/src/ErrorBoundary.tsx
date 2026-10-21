import {Component, type CSSProperties, type ErrorInfo, type ReactNode} from 'react';
import {Quit, WindowReload} from '../wailsjs/runtime';

// The fallback is the only chrome left when the app tree is gone, so it owns a
// drag strip of its own and never reads App state.
const drag = {['--wails-draggable' as never]: 'drag'} as CSSProperties;

interface Props {
    children: ReactNode;
}

interface State {
    failed: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
    state: State = {failed: false};

    static getDerivedStateFromError(): State {
        return {failed: true};
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // Keep the details in the console; the fallback must never render the
        // message or stack, which can contain local file names.
        console.error('Floe failed to render', error, info);
    }

    render(): ReactNode {
        if (!this.state.failed) {
            return this.props.children;
        }

        return (
            <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
                <div
                    style={drag}
                    className="flex h-9 shrink-0 select-none items-center border-b border-white/[0.06] pl-3 font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-500"
                >
                    Floe
                </div>
                <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                    <h1 className="text-lg font-medium text-zinc-100">Something went wrong</h1>
                    <p className="max-w-md text-sm text-zinc-400">
                        Floe could not draw this window. Reload to try again, or close Floe.
                    </p>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => WindowReload()}
                            className="rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/[0.08]"
                        >
                            Reload
                        </button>
                        <button
                            type="button"
                            onClick={() => Quit()}
                            className="rounded-lg border border-white/15 bg-white/[0.02] px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                            Close Floe
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
