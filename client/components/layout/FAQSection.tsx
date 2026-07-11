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
                <div className="overflow-hidden">
                    <div className="pb-5 text-sm leading-relaxed text-zinc-400">{answer}</div>
                </div>
            </div>
        </div>
    );
};

export const FAQSection = () => {
    return (
        <section id="faq" className={sectionClass}>
            <SectionHeader eyebrow="FAQ" headline="Questions, answered plainly." />
            <div className="mt-10 max-w-3xl border-t border-white/[0.06]">
                <FAQItem
                    question="What is Floe?"
                    answer="Floe is a free file-sharing tool that lets you send files directly to another person, with no sign-up, no app download, and no files stored on any server. Think of it like handing a USB drive to someone, but over the internet. Direct connections have no size limit; relay connections are capped at 2 GB per session."
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
                                    <li>Copy the link that appears</li>
                                    <li>Send that link to your friend</li>
                                    <li>Keep your browser tab open until they finish downloading</li>
                                </ol>
                            </div>

                            <div className="space-y-2">
                                <p className="font-semibold text-zinc-200">For Receivers:</p>
                                <ol className="list-decimal list-inside space-y-1 pl-2">
                                    <li>Open the link your friend sent you</li>
                                    <li>Wait for the connection (the status badge shows &quot;Direct&quot; or &quot;Relay&quot;)</li>
                                    <li>Click &quot;Download All&quot; and the files come straight from your friend&apos;s device</li>
                                </ol>
                            </div>

                            <p className="text-zinc-500 italic">That&apos;s it! No accounts needed, no waiting for uploads.</p>
                        </div>
                    }
                />
                <FAQItem
                    question="Can I use Floe from the terminal?"
                    answer="Yes. The floe CLI installs as a single binary and talks to the same infrastructure as the web app, so browser-to-terminal transfers work in every direction. Run floe send with a file or folder, share the printed code or link, and the other side receives it in a browser or with floe receive."
                />
                <FAQItem
                    question="Where are my files stored?"
                    answer="Your files are never stored on any server. In direct connections, data flows straight between devices. In relay connections, encrypted data passes through our TURN relay server in transit but is never saved or inspected. Once the transfer is complete and both tabs are closed, nothing is retained."
                />
                <FAQItem
                    question="Is there a file size limit?"
                    answer="It depends on your connection type. Direct connections have no file size limit. If your connection uses a relay, transfers are capped at 2 GB per session. The app shows your connection type in real time, so you will always know which applies."
                />
                <FAQItem
                    question="Why do I need to keep the tab open?"
                    answer="Because files are never uploaded to a storage server, your browser must remain open to send the data. If you close the tab or lose your connection, the transfer will stop. Think of it like a live video call: both sides need to stay connected for it to work."
                />
                <FAQItem
                    question="Is this secure?"
                    answer="Yes. All transfers use DTLS encryption built into WebRTC. Whether your connection is direct or relayed, only you and your recipient can read the data. Even the relay server handles only encrypted packets and cannot access your files."
                />
            </div>
        </section>
    );
};
