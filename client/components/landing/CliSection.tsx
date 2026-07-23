'use client';

import React, { useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';
import { CliTerminal } from './CliTerminal';

// Install commands are copied verbatim from README.md; keep them in sync.
const TABS = [
    { label: 'macOS', prompt: '$', command: 'brew install --cask jannskiee/tap/floe' },
    { label: 'Windows', prompt: '>', command: 'winget install jannskiee.floe' },
    { label: 'Linux', prompt: '$', command: 'curl -fsSL https://floe.one/install.sh | sh' },
];

const COMMANDS = [
    { cmd: 'floe send <path>', desc: 'Share files or entire folders' },
    { cmd: 'floe receive <code>', desc: 'A short code is all the other side needs' },
    { cmd: 'floe update', desc: 'The binary updates itself' },
];

function InstallTabs() {
    const [active, setActive] = useState(0);
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(TABS[active].command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (permissions or insecure context); the command stays selectable.
        }
    };

    return (
        <div>
            <div className="flex gap-1 border-b border-white/[0.06]" aria-label="Install command by operating system">
                {TABS.map((tab, i) => (
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
                <code className="custom-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-zinc-200">
                    <span className="select-none text-zinc-600">{TABS[active].prompt} </span>
                    {TABS[active].command}
                </code>
                <button
                    type="button"
                    onClick={copy}
                    aria-label="Copy install command"
                    className="relative before:absolute before:-inset-2 shrink-0 rounded p-1.5 text-zinc-500 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                </button>
            </div>
        </div>
    );
}

export function CliSection() {
    return (
        <section id="cli" className={sectionClass}>
            <SectionHeader
                eyebrow="Command line"
                headline="The same transfer, without the browser."
                lede="floe is a single static binary that talks to the same signaling infrastructure as the web app. Browser to terminal works in every direction, and folders arrive with their structure intact."
            />
            <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-12">
                <div className="min-w-0 lg:col-span-5">
                    <InstallTabs />
                    <ul className="mt-8 divide-y divide-white/[0.06] border-y border-white/[0.06]">
                        {COMMANDS.map((c) => (
                            <li
                                key={c.cmd}
                                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                            >
                                <code className="font-mono text-[13px] text-zinc-200">{c.cmd}</code>
                                <span className="text-[13px] text-zinc-500">{c.desc}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="mt-6 text-[13px] leading-relaxed text-zinc-500">
                        Also available via Scoop, a PowerShell one-liner, and{' '}
                        <code className="font-mono text-[12px]">go install</code>.{' '}
                        <a
                            href="https://www.floe.one/docs/cli/installation"
                            target="_blank"
                            rel="noreferrer"
                            className="group inline-flex items-center gap-1 text-zinc-300 transition hover:text-ice"
                        >
                            Installation guide
                            <ArrowUpRight className="h-3 w-3 text-zinc-500 transition group-hover:text-ice" />
                        </a>
                    </p>
                </div>
                <div className="min-w-0 lg:col-span-7">
                    <CliTerminal />
                </div>
            </div>
        </section>
    );
}
