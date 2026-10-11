'use client';

import React, { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { SectionHeader, sectionClass } from '@/components/landing/SectionHeader';

const FAQItem = ({ question, answer }: { question: string; answer: ReactNode }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="border-b border-white/[0.06]">
            <button
                onClick={() => setIsOpen(!isOpen)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 py-5 text-left text-[15px] font-medium text-zinc-100 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
            >
                {question}
                <ChevronDown
                    className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
            </button>
            {/* 0fr -> 1fr grid rows track the answer's true height at every viewport width,
                unlike a fixed max-h cap that silently clips long answers on narrow screens */}
            <div className={`grid transition-[grid-template-rows] duration-300 ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                {/* invisible, not just clipped: a 0fr row still leaves its links in the
                    tab order and in the accessibility tree, so keyboard users could land
                    on a link inside a collapsed answer and screen readers read every
                    answer aloud while aria-expanded says false. visibility:hidden removes
                    it from both and still animates. */}
                <div className={`overflow-hidden ${isOpen ? '' : 'invisible'}`}>
                    <div className="pb-5 text-sm leading-relaxed text-zinc-400">{answer}</div>
                </div>
            </div>
        </div>
    );
};

// One class string for every link inside an answer, so they cannot drift apart.
const ANSWER_LINK = 'text-zinc-300 underline decoration-white/20 underline-offset-2 transition hover:text-ice';

export const FAQSection = () => {
    return (
        <section id="faq" className={sectionClass}>
            <SectionHeader eyebrow="FAQ" headline="Questions, answered plainly." />
            <div className="mt-10 max-w-3xl border-t border-white/[0.06]">
                <FAQItem
                    question="What is Floe?"
                    answer="Floe is a free file-sharing tool that lets you send files directly to another person: no sign-up, no files stored on any server, and nothing to install: it runs right in your browser, with an optional desktop app and CLI if you want them. Think of it like handing a USB drive to someone, but over the internet. Floe sets no size limit on a direct connection, though a receiving browser can only hold so much; relay connections are capped at 2 GB per session."
                />
                <FAQItem
                    question="What does 'Peer-to-Peer' (P2P) mean?"
                    answer="Normally when you share a file online, it gets uploaded to a company's server first, then the other person downloads it from there. With peer-to-peer (P2P), your file travels straight from your device to the recipient's device. In some network environments, a secure relay server acts as a bridge, but your files remain encrypted end-to-end and are never stored."
                />
                <FAQItem
                    question="How do I use Floe? (Step-by-step)"
                    answer={
                        <div className="space-y-4">
                            <p>It&apos;s simple! Here&apos;s how it works:</p>

                            <div className="space-y-2">
                                <p className="font-semibold text-zinc-200">For Senders:</p>
                                <ol className="list-decimal list-inside space-y-1 pl-2">
                                    <li>Drag and drop your files (or click to select them)</li>
                                    <li>Click &quot;Create secure link&quot;, then copy the link that appears</li>
                                    <li>Send that link to your friend</li>
                                    <li>Keep your browser tab open until the transfer finishes</li>
                                </ol>
                            </div>

                            <div className="space-y-2">
                                <p className="font-semibold text-zinc-200">For Receivers:</p>
                                <ol className="list-decimal list-inside space-y-1 pl-2">
                                    <li>Open the link your friend sent you</li>
                                    <li>Wait for the connection (the status badge shows &quot;Direct&quot; or &quot;Relay&quot;)</li>
                                    <li>The files arrive on their own, straight from your friend&apos;s device</li>
                                    <li>Save each file with its download button, or use &quot;Download All&quot; or &quot;Download ZIP&quot; when there is more than one</li>
                                </ol>
                            </div>

                            <p className="text-zinc-500 italic">That&apos;s it! No accounts needed, no waiting for uploads.</p>
                        </div>
                    }
                />
                <FAQItem
                    question="Can I use Floe from the terminal?"
                    answer="Yes. The floe CLI installs as a single binary and talks to the same infrastructure as the web app, so browser-to-terminal transfers work in every direction. Run floe send with a file or folder and share what it prints: the link opens in a browser, and the link or the code works with floe receive and in Floe Desktop."
                />
                <FAQItem
                    question="Is there a desktop app?"
                    answer={
                        <p>
                            Yes, in Beta. Floe Desktop is a small native app for Windows that speaks
                            the same protocol as the web app and the CLI, so any two can transfer to
                            each other. It sends folders without zipping, pastes screenshots and
                            copied files straight from the clipboard, and shows a notification when
                            a transfer finishes. Install it from the Microsoft Store via the{' '}
                            <a href="/download" className={ANSWER_LINK}>
                                download page
                            </a>
                            .
                        </p>
                    }
                />
                <FAQItem
                    question="Can someone send files to me?"
                    answer={
                        <p>
                            Yes, with a request link, which is in Beta. In Floe Desktop, open Receive,
                            choose Request link, and make a link to send to the other person. They open
                            it in current Chrome or Edge on a computer and pick what to send, or run
                            floe send --to with the link in the CLI. Floe Desktop shows you how many
                            files are coming and how large they are, and nothing is saved until you
                            accept, unless you turned on Auto-accept for that link. A link takes one
                            drop, and it works only while Floe Desktop is open on your PC. The details
                            are in{' '}
                            <a
                                href="https://www.floe.one/docs/desktop/request-links"
                                target="_blank"
                                rel="noreferrer"
                                className={ANSWER_LINK}
                            >
                                Request links
                            </a>
                            .
                        </p>
                    }
                />
                <FAQItem
                    question="Where are my files stored?"
                    answer="Your files are never stored on any server. In direct connections, data flows straight between devices. In relay connections, encrypted data passes through a TURN relay in transit (on floe.one, Cloudflare's network) but is never saved or inspected. What you receive stays on your own device: a browser holds it, ready to save, until you close the tab, and Floe Desktop and the CLI write it straight to a folder on your disk. Floe Desktop also keeps a history of your last 50 transfers on your PC (file names, sizes, and times, never the files), which you can clear."
                />
                <FAQItem
                    question="Is there a file size limit?"
                    answer="It depends on your connection type. Floe sets no size limit on a direct connection, though a browser that receives is limited by what that browser can hold. If your connection uses a relay, transfers are capped at 2 GB per session. The app shows your connection type in real time, so you will always know which applies."
                />
                <FAQItem
                    question="How big a file can a browser receive?"
                    answer={
                        <p>
                            As much as that browser can hold, because the web app keeps what it
                            receives inside the browser until the tab closes. Chrome and Edge in a
                            normal window move what does not fit in memory into temporary files on
                            disk, so the ceiling there is set by your disk. Firefox, Safari, private
                            windows, and every browser on iPhone and iPad keep it all in memory and
                            fill up much sooner. When a browser runs out, the transfer stops, and Floe
                            says so if the tab is still running. For multi-gigabyte files, receive
                            with Floe Desktop or the CLI, which write straight to disk. The limits
                            browser by browser are in{' '}
                            <a
                                href="https://www.floe.one/docs/how-it-works/known-limitations#a-browser-receiver-is-limited-by-what-the-browser-can-hold"
                                target="_blank"
                                rel="noreferrer"
                                className={ANSWER_LINK}
                            >
                                Known limitations
                            </a>
                            .
                        </p>
                    }
                />
                <FAQItem
                    question="Why do I need to keep the tab open?"
                    answer="Because files are never uploaded to a storage server, your browser must remain open to send the data. If you close the tab or lose your connection, the transfer will stop. Think of it like a live video call: both sides need to stay connected for it to work."
                />
                <FAQItem
                    question="Is this secure?"
                    answer={
                        <p>
                            Yes. All transfers use DTLS encryption built into WebRTC, with keys that
                            exist only on the two devices. Whether your connection is direct or
                            relayed, everything in between, the relay included, handles only encrypted
                            packets and cannot read your files. One limit is worth knowing: the
                            certificate fingerprints the two devices use to agree on those keys pass
                            through Floe&apos;s signaling server, so that server is trusted to
                            introduce you honestly, and no Floe app shows a verification code to check
                            it today. The full list of what Floe does not protect against is in{' '}
                            <a
                                href="https://www.floe.one/docs/how-it-works/known-limitations"
                                target="_blank"
                                rel="noreferrer"
                                className={ANSWER_LINK}
                            >
                                Known limitations
                            </a>
                            .
                        </p>
                    }
                />
                <FAQItem
                    question="How do I know a file arrived intact?"
                    answer={
                        <p>
                            Floe checks every file for you. Each one must match the size the sender
                            announced, and the sender also computes a SHA-256 of each file, which the
                            receiver compares with what actually arrived. A file that does not match
                            is discarded instead of saved. When every file matched, the browser and
                            the CLI show &quot;SHA-256 matched&quot; and Floe Desktop shows a green
                            check mark; without that, at least one file was checked by size only. The
                            sender sees the same once a CLI or Floe Desktop receiver confirms that
                            everything was saved. What the check proves is in{' '}
                            <a
                                href="https://www.floe.one/docs/how-it-works/file-checks"
                                target="_blank"
                                rel="noreferrer"
                                className={ANSWER_LINK}
                            >
                                File checks
                            </a>
                            .
                        </p>
                    }
                />
            </div>
        </section>
    );
};
