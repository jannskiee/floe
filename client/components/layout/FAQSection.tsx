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
                    answer="Floe is a free file-sharing website that lets you send files directly to another person — no sign-up, no app download, and no file size limits. Think of it like handing a USB drive to someone, but over the internet."
                />
                <FAQItem
                    question="What does 'Peer-to-Peer' (P2P) mean?"
                    answer="Normally when you share a file online, it gets uploaded to a company's server first, then the other person downloads it from there. With peer-to-peer (P2P), your file goes directly from your device to the other person's device — no middleman. It's like a direct phone call instead of leaving a voicemail."
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
                    answer="Nowhere! Your files are never uploaded to any server. They stream directly from the sender's device to the receiver's device. Once you close the browser tab, there's nothing left behind — no copies, no traces."
                />
                <FAQItem
                    question="Is there a file size limit?"
                    answer="Technically, no. Because we don't store your files, there's no storage limit. You can send files of any size. However, very large files (like 10GB+) might need a stable internet connection and patience while both devices stay connected."
                />
                <FAQItem
                    question="Why do I need to keep the tab open?"
                    answer="Since there's no server storing your file, your browser IS the server. Your device sends the file directly. If you close the tab or lose internet, the connection breaks and the transfer stops. Think of it like a phone call — both people need to stay on the line."
                />
                <FAQItem
                    question="Is this secure?"
                    answer="Yes! Your files are encrypted during transfer using the same technology that secures video calls (WebRTC). No one — not even us — can see what you're sending. It goes directly from you to your recipient, with no copies made anywhere."
                />
            </div>
        </section>
    );
};
