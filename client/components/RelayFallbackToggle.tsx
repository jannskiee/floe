import { AlertTriangle } from 'lucide-react';

interface RelayFallbackToggleProps {
    relayEnabled: boolean;
    onChange: (enabled: boolean) => void;
}

/**
 * Sender-side "Network Relay Fallback" checkbox card, shown after files are
 * picked but before the share link is created. Purely presentational; the
 * relayEnabled state lives in P2PTransfer (via useRelayConfiguration).
 */
export function RelayFallbackToggle({ relayEnabled, onChange }: RelayFallbackToggleProps) {
    return (
        <div className="mb-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <label className="flex items-start gap-3 cursor-pointer group/relay select-none">
                <div className="relative flex-shrink-0 mt-0.5">
                    <input
                        type="checkbox"
                        checked={relayEnabled}
                        onChange={(e) => onChange(e.target.checked)}
                        className="sr-only"
                    />
                    <div className={`h-4 w-4 rounded-sm border transition-all duration-150 flex items-center justify-center ${relayEnabled
                            ? 'bg-white border-white'
                            : 'bg-transparent border-zinc-600 group-hover/relay:border-zinc-400'
                        }`}>
                        {relayEnabled && (
                            <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5">
                                <path d="M1 4l2.5 2.5L9 1" stroke="#09090b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        )}
                    </div>
                </div>
                <div className="space-y-1.5">
                    <p className="text-sm font-medium text-zinc-200 leading-none">Network Relay Fallback</p>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                        Only used when a direct connection can&apos;t be established. Most transfers stay direct, even on mobile data. 2 GB limit when relayed.{' '}
                        <a
                            href="/how-it-works"
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-zinc-400 hover:text-white underline underline-offset-2 transition-colors"
                        >
                            Learn more
                        </a>
                    </p>
                </div>
            </label>
            {!relayEnabled && (
                <div className="mt-3 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-300 leading-relaxed">
                        Relay fallback is disabled. Transfers may fail if either device is on mobile data or a restricted network and a direct connection cannot be established.
                    </p>
                </div>
            )}
        </div>
    );
}
