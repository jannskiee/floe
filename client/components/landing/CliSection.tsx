import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';
import { CliTerminal } from './CliTerminal';
import { InstallTabs } from './InstallTabs';

const COMMANDS = [
    { cmd: 'floe send <path>', desc: 'Share files or entire folders' },
    { cmd: 'floe receive <code>', desc: 'A short code is all the other side needs' },
    { cmd: 'floe update', desc: 'The binary updates itself' },
];

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
                                <code className="shrink-0 font-mono text-[13px] text-zinc-200">{c.cmd}</code>
                                {/* sm:text-right: in the narrow lg text column the desc wraps to
                                    two lines; ragging it right matches DesktopSection's rows */}
                                <span className="text-[13px] text-zinc-500 sm:text-right">{c.desc}</span>
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
