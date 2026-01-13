'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const FAQItem = ({ question, answer }: { question: string; answer: string }) => {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="border-b border-white/10 last:border-0">
            <button onClick={() => setIsOpen(!isOpen)} className="flex w-full items-center justify-between py-4 text-left font-medium text-white transition-all hover:text-zinc-200">
                {question}
                <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            <div className={`overflow-hidden transition-all duration-300 ${isOpen ? 'max-h-96 pb-4' : 'max-h-0'}`}>
                <p className="text-sm text-zinc-400 leading-relaxed">{answer}</p>
            </div>
        </div>
    );
};

export const FAQSection = () => {
    return (
        <section id="faq" className="mt-32 max-w-2xl w-full space-y-8 scroll-mt-28">
            <h2 className="text-2xl font-bold text-center text-white tracking-tight">Frequently Asked Questions</h2>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-6 backdrop-blur-sm">
                <FAQItem question="Where are my files stored?" answer="Nowhere! Floe is a serverless P2P transfer tool. The file streams directly from the sender's device to the receiver's device. Once the tab is closed, the data is gone." />
                <FAQItem question="Is there a file size limit?" answer="Technically, no. Because we don't store your files, there is no storage limit. However, very large files might require a stable internet connection and keeping the browser active." />
                <FAQItem question="Why do I need to keep the tab open?" answer="Since there is no server acting as a middleman, your browser is the server. If you close the tab, the connection breaks and the transfer stops immediately." />
                <FAQItem question="Is this secure?" answer="Yes. We use WebRTC to establish a direct connection. Your data is encrypted in transit and no one (including us) can see the contents of your files." />
            </div>
        </section>
    );
};