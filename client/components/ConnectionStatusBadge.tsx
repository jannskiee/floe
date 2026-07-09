import { useState, useEffect } from 'react';
import { Wifi, Info } from 'lucide-react';

interface ConnectionStatusBadgeProps {
    isSender: boolean;
    isConnected: boolean;
    ping: number;
    connectionType: 'direct' | 'relay' | null;
    progress: number;
}

/**
 * The connection status indicator shown above the transfer card: the sender's
 * Wifi/ping readout, the direct/relay/ready/offline dot and label, and the Info
 * tooltip explaining the active connection type. Purely presentational — it owns
 * only the tooltip's open/close state.
 */
export function ConnectionStatusBadge({
    isSender,
    isConnected,
    ping,
    connectionType,
    progress,
}: ConnectionStatusBadgeProps) {
    const [showInfoTooltip, setShowInfoTooltip] = useState(false);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setShowInfoTooltip(false); }, [connectionType]);

    useEffect(() => {
        if (!showInfoTooltip) return;
        const close = () => setShowInfoTooltip(false);
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, [showInfoTooltip]);

    return (
        <div
            className={`flex justify-end items-center gap-3 text-[10px] uppercase font-bold tracking-widest text-zinc-500 mb-1 ${progress > 0 ? '' : 'pr-2'}`}
        >
            {isSender && (
                <div className="flex items-center gap-1">
                    <Wifi className="w-3 h-3" />
                    <span className="font-mono">
                        {isConnected
                            ? `${ping < 1 ? ping : Math.round(ping)}ms`
                            : '--'}
                    </span>
                </div>
            )}
            <div className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                    <span
                        className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${connectionType === 'direct' ? 'bg-green-400' :
                                connectionType === 'relay' ? 'bg-amber-400' :
                                    isConnected ? 'bg-green-400' :
                                        'bg-red-500'
                            }`}
                    ></span>
                    <span
                        className={`relative inline-flex rounded-full h-2 w-2 ${connectionType === 'direct' ? 'bg-green-500' :
                                connectionType === 'relay' ? 'bg-amber-500' :
                                    isConnected ? 'bg-green-500' :
                                        'bg-red-600'
                            }`}
                    ></span>
                </span>
                <span>
                    {connectionType === 'direct'
                        ? 'Direct'
                        : connectionType === 'relay'
                            ? 'Relay'
                            : isConnected
                                ? 'Ready'
                                : 'Offline'}
                </span>
                {(connectionType === 'direct' || connectionType === 'relay') && (
                    <div className="relative group/info inline-flex items-center p-0.5 cursor-help"
                        onClick={(e) => { e.stopPropagation(); setShowInfoTooltip(v => !v); }}
                    >
                        <Info className="w-2.5 h-2.5 text-zinc-600 group-hover/info:text-zinc-400 transition-colors" />
                        <div className={`absolute z-[9999] w-52 transition-opacity duration-150 top-full right-0 mt-2 sm:top-1/2 sm:right-full sm:left-auto sm:-translate-y-1/2 sm:mt-0 sm:mr-2 ${showInfoTooltip ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'} group-hover/info:opacity-100 group-hover/info:pointer-events-auto`}>
                            {/* invisible bridge above to prevent hover gap */}
                            <div className="hidden sm:block absolute top-0 bottom-0 left-full w-3" />
                            <div className="relative bg-zinc-950 border border-zinc-800 rounded-xl p-3 shadow-2xl text-left">
                                {/* caret: up on mobile, right on desktop */}
                                <div className="sm:hidden absolute bottom-full right-3 h-0 w-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-zinc-800" />
                                <div className="hidden sm:block absolute left-full top-1/2 -translate-y-1/2 h-0 w-0 border-t-[6px] border-b-[6px] border-l-[6px] border-t-transparent border-b-transparent border-l-zinc-800" />
                                {connectionType === 'direct' ? (
                                    <>
                                        <p className="text-[10px] font-bold text-green-400 uppercase tracking-wider mb-1">Direct Connection</p>
                                        <p className="text-[10px] font-normal normal-case tracking-normal text-zinc-400 leading-relaxed">
                                            Your files go directly to the other device, even across different networks like mobile data. No servers involved. Unlimited speed and size.{' '}
                                            <a href="/how-it-works" target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-white underline underline-offset-2 transition-colors">
                                                Learn more
                                            </a>
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-1">Relay Connection</p>
                                        <p className="text-[10px] font-normal normal-case tracking-normal text-zinc-400 leading-relaxed">
                                            A server bridges the connection when a direct path is unavailable. Your files stay encrypted. 2 GB limit per session.{' '}
                                            <a href="/how-it-works" target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-white underline underline-offset-2 transition-colors">
                                                Learn more
                                            </a>
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
