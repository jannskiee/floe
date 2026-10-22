import {Component, type CSSProperties, type ErrorInfo, type ReactNode} from 'react';
import {ConfirmClose} from '../wailsjs/go/main/App';
import {WindowReload} from '../wailsjs/runtime/runtime';
import {Button} from './components/ui';

// The fallback is the only chrome left when the app tree is gone, so it owns a
// drag strip of its own and never reads App state.
const drag = {['--wails-draggable' as never]: 'drag'} as CSSProperties;

// The fallback's words (#695), approved by the owner. Desktop lines carry no
// closing period. Fixed text only: the error's message and stack never reach
// the screen.
const CRASH_HEADING = 'Something went wrong';
const CRASH_RELOAD_LINE = 'Reload the window to try again';
const CRASH_CLOSE_LINE = 'Closing Floe stops any transfer in progress and any open request link';
const CRASH_RELOAD = 'Reload window';
const CRASH_CLOSE = 'Close Floe';

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
                <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
                    <div role="alert" className="space-y-2">
                        <h1 className="text-lg font-medium text-zinc-100">{CRASH_HEADING}</h1>
                        <p className="max-w-md text-sm text-zinc-400">{CRASH_RELOAD_LINE}</p>
                        <p className="max-w-md text-sm text-zinc-400">{CRASH_CLOSE_LINE}</p>
                    </div>
                    <div className="flex gap-2">
                        {/* The gentler way out takes focus: Go keeps a running
                            transfer going across a reload. */}
                        <Button autoFocus onClick={() => WindowReload()}>{CRASH_RELOAD}</Button>
                        {/* ConfirmClose, never Quit(). Quit goes through
                            onBeforeClose, which keeps the window open and emits
                            close:blocked while a send, a receive or a request
                            link is live, and the only listener for that event
                            was in App, which is gone. The button would do
                            nothing exactly when it matters. ConfirmClose ends
                            what is in progress and quits. */}
                        <Button variant="outline" onClick={() => { ConfirmClose().catch(() => {}); }}>
                            {CRASH_CLOSE}
                        </Button>
                    </div>
                </div>
            </div>
        );
    }
}
