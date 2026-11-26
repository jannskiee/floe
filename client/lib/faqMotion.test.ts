import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The home page FAQ (components/layout/FAQSection.tsx) slid each answer open
// over 300 ms and turned its chevron over 200 ms, also for a visitor whose
// system asks for reduced motion. The legal pages' On this page list already
// turns the same chevron at once for that visitor (components/legal/LegalToc.tsx).
// Reduced motion now stills both FAQ parts, opening and closing; everyone else
// keeps them. vitest runs in Node with no DOM, so the classes are read as text.
const faq = readFileSync(fileURLToPath(new URL('../components/layout/FAQSection.tsx', import.meta.url)), 'utf8');

/** The classes a className template in FAQSection.tsx applies whether the
 *  answer is open or closed: the text before its `${`, on the line that
 *  holds `marker`. */
function alwaysApplied(marker: string): string[] {
    const line = faq.split('\n').find((l) => l.includes(marker));
    expect(line, `the line of FAQSection.tsx that holds ${marker}`).toBeDefined();
    const start = line!.indexOf('`') + 1;
    return line!.slice(start, line!.indexOf('${', start)).trim().split(/\s+/);
}

describe('the home page FAQ under reduced motion', () => {
    it('opens and closes an answer at once', () => {
        expect(alwaysApplied('grid-rows-[0fr]')).toEqual([
            'grid',
            'transition-[grid-template-rows]',
            'duration-300',
            'motion-reduce:transition-none',
        ]);
    });

    it('turns the chevron at once', () => {
        expect(alwaysApplied('rotate-180')).toEqual([
            'h-4',
            'w-4',
            'shrink-0',
            'text-zinc-500',
            'transition-transform',
            'duration-200',
            'motion-reduce:transition-none',
        ]);
    });

    // A hover color is not motion: the questions and the links inside the
    // answers keep their color fades, as the links of the legal pages' On
    // this page list do.
    it('stills nothing else', () => {
        expect(faq.match(/motion-(?:reduce|safe):/g) ?? []).toHaveLength(2);
    });
});
