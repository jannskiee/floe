'use client';

import React, { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

const FAQItem = ({ question, answer }: { question: string; answer: ReactNode }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="border-b border-white/10 last:border-0">
            <button onClick={() => setIsOpen(!isOpen)} className="flex w-full items-center justify-between py-4 text-left font-medium text-white transition-all hover:text-zinc-200">
                {question}
                <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            <div className={`overflow-hidden transition-all duration-300 ${isOpen ? 'max-h-[600px] pb-4' : 'max-h-0'}`}>
                <div className="text-sm text-zinc-400 leading-relaxed">{answer}</div>
            </div>
        </div>
    );
};

export const FAQSection = () => {
    return (
        <section id="faq" className="mt-32 max-w-2xl w-full space-y-8 scroll-mt-28">
            <h2 className="text-2xl font-bold text-center text-white tracking-tight">Frequently Asked Questions</h2>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-6 backdrop-blur-sm">
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
                                    <li>Wait for the connection (you&apos;ll see &quot;Connected&quot;)</li>
                                    <li>Click &quot;Download&quot; — the file comes directly from your friend&apos;s device</li>
                                </ol>
                            </div>

                            <p className="text-zinc-500 italic">That&apos;s it! No accounts needed, no waiting for uploads.</p>
                        </div>
                    }
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
                    answer="Because files are never uploaded to a storage server, your browser must remain open to send the data. If you close the tab or lose your connection, the transfer will stop. Think of it like a live video call — both sides need to stay connected for it to work."
                />
                <FAQItem
                    question="Is this secure?"
                    answer="Yes. All transfers use DTLS-SRTP encryption, the same standard used to secure video calls. Whether your connection is direct or relayed, only you and your recipient can read the data. Even our own relay server handles only encrypted packets and cannot access your files."
                />
            </div>
        </section>
    );
};
