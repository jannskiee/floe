import React from 'react';
import Link from 'next/link';
import { SectionHeader, sectionClass } from './SectionHeader';
import { AppWindow } from './AppWindow';

const FEATURES = [
    { name: 'Send with Floe', desc: 'Right-click any file or folder in Explorer' },
    { name: 'Folders', desc: 'Sent as folders, no zipping' },
    { name: 'Minimized', desc: 'Transfers keep running while the window is minimized' },
    { name: 'History', desc: 'What you sent and received, stored locally' },
];

/**
 * The second movement of "beyond the browser": the CLI section's sibling.
 * Mirrored layout on purpose (artifact left, text right) so two consecutive
 * artifact sections read as a spread rather than a template; source order
 * stays text-first so mobile stacks like every other section.
 */
export function DesktopSection() {
    return (
        <section id="desktop" className={sectionClass}>
            <SectionHeader
                eyebrow="Desktop"
                headline="Transfers that outlive the tab."
                lede="Floe Desktop is the same app, running natively on Windows. Right-click a folder to send it, minimize the window while it transfers, get a notification when it lands. Same rooms, same end-to-end encryption as browser and CLI peers."
            />
            <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-12">
                <div className="min-w-0 lg:order-2 lg:col-span-5">
                    <ul className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
                        {FEATURES.map((f) => (
                            <li
                                key={f.name}
                                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                            >
                                <span className="shrink-0 font-mono text-[13px] text-zinc-200">{f.name}</span>
                                <span className="text-[13px] text-zinc-500 sm:text-right">{f.desc}</span>
                            </li>
                        ))}
                    </ul>
                    <div className="mt-8">
                        <Link
                            href="/download"
                            data-umami-event="desktop-section-cta"
                            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            Get the desktop app
                        </Link>
                        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                            v0.1.0 beta · Windows · macOS and Linux planned
                        </p>
                    </div>
                </div>
                <div className="min-w-0 lg:order-1 lg:col-span-7">
                    <AppWindow />
                </div>
            </div>
        </section>
    );
}
