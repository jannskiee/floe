'use client';

import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Install commands are copied verbatim from README.md; keep them in sync.
export const CLI_INSTALL_TABS = [
    { label: 'macOS', prompt: '$', command: 'brew install --cask jannskiee/tap/floe' },
    { label: 'Windows', prompt: '>', command: 'winget install jannskiee.floe' },
    { label: 'Linux', prompt: '$', command: 'curl -fsSL https://floe.one/install.sh | sh' },
];

export function InstallTabs() {
    const [active, setActive] = useState(0);
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(CLI_INSTALL_TABS[active].command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (permissions or insecure context); the command stays selectable.
        }
    };

    return (
        <div>
            {/* role="group": an aria-label on a plain div is ignored by AT */}
            <div role="group" className="flex gap-1 border-b border-white/[0.06]" aria-label="Install command by operating system">
                {CLI_INSTALL_TABS.map((tab, i) => (
                    <button
                        key={tab.label}
                        type="button"
                        aria-pressed={i === active}
                        onClick={() => {
                            setActive(i);
                            setCopied(false);
                        }}
                        className={`-mb-px border-b px-3 py-2 font-mono text-xs transition focus-visible:outline-2 focus-visible:outline-ice ${
                            i === active
                                ? 'border-ice text-zinc-100'
                                : 'border-transparent text-zinc-500 hover:text-zinc-300'
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/40 px-4 py-3">
                {/* Long commands scroll inside the pill on phones; the right-edge fade
                    signals the cut instead of hard-clipping against the copy button. */}
                <code className="custom-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-zinc-200 max-sm:[mask-image:linear-gradient(to_right,black_calc(100%_-_20px),transparent)]">
                    <span className="select-none text-zinc-600">{CLI_INSTALL_TABS[active].prompt} </span>
                    {CLI_INSTALL_TABS[active].command}
                </code>
                <button
                    type="button"
                    onClick={copy}
                    aria-label={copied ? 'Copied' : 'Copy install command'}
                    className="relative before:absolute before:-inset-2 shrink-0 rounded p-1.5 text-zinc-500 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                </button>
            </div>
        </div>
    );
}
