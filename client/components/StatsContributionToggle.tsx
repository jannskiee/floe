interface StatsContributionToggleProps {
    enabled: boolean;
    onChange: (enabled: boolean) => void;
}

/**
 * Receiver-side "Contribute to global stats" opt-out checkbox card, shown while
 * waiting before any file arrives. Purely presentational; the preference lives in
 * P2PTransfer (via useTransferAnalytics, persisted to localStorage there).
 */
export function StatsContributionToggle({ enabled, onChange }: StatsContributionToggleProps) {
    return (
        <div className="border-t border-white/[0.06] pt-4">
            <label className="flex items-start gap-3 cursor-pointer group/report select-none">
                <div className="relative flex-shrink-0 mt-0.5">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => onChange(e.target.checked)}
                        className="sr-only"
                    />
                    <div className={`h-4 w-4 rounded-sm border transition-all duration-150 flex items-center justify-center ${enabled
                            ? 'bg-white border-white'
                            : 'bg-transparent border-zinc-600 group-hover/report:border-zinc-400'
                        }`}>
                        {enabled && (
                            <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5">
                                <path d="M1 4l2.5 2.5L9 1" stroke="#09090b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        )}
                    </div>
                </div>
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-zinc-200 leading-none">Contribute to global stats</p>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                        Adds only this transfer&apos;s byte count to Floe&apos;s public total. File names and contents are never sent.{' '}
                        <a
                            href="/privacy"
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
        </div>
    );
}
