import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The /r look fixes that are a rule rather than a color (D-136 D5), read as
// TEXT, like requestShell.test.ts: vitest runs in node and cannot mount a
// component. e2e/request-look.spec.ts measures the rendered contrast.

const DIR = fileURLToPath(new URL('../../components/request/', import.meta.url));
const read = (name: string) => readFileSync(DIR + name, 'utf8');

/** The class list of the nearest element opened before `needle`. */
function classesBefore(src: string, needle: string): string[] {
    const at = src.indexOf(needle);
    expect(at, needle).toBeGreaterThan(-1);
    const all = [...src.slice(0, at).matchAll(/className="([^"]*)"/g)];
    expect(all.length, needle).toBeGreaterThan(0);
    return all[all.length - 1][1].split(/\s+/).filter(Boolean);
}

describe('the /r look', () => {
    it('both help links open a new tab and send no referrer', () => {
        // A same-tab click on "What is a request link?" or V9's Learn more
        // dropped the picked files: Ready and V9 have no leave-page prompt
        // (guards.ts). noreferrer keeps the /r path, which carries the link
        // id, out of the docs request even where the page's no-referrer
        // header is missing.
        const links = [
            [read('ReadyHeader.tsx'), 'href={REQUEST_LINK_DOCS_PATH}'],
            [read('RequestStatus.tsx'), 'href={SIZE_LIMIT_HREF}'],
        ] as const;
        for (const [src, href] of links) {
            const start = src.indexOf(href);
            expect(start, href).toBeGreaterThan(-1);
            const tag = src.slice(src.lastIndexOf('<a', start), src.indexOf('>', start) + 1);
            expect(tag, href).toContain('target="_blank"');
            const rel = /rel="([^"]*)"/.exec(tag)?.[1].split(/\s+/) ?? [];
            expect(rel, href).toContain('noopener');
            expect(rel, href).toContain('noreferrer');
        }
    });

    it("V9's Learn more follows the body inline, after a space, as WV-23 draws it", () => {
        const src = read('RequestStatus.tsx');
        const body = src.indexOf('{line}');
        const space = src.indexOf("{' '}", body);
        const link = src.indexOf('href={SIZE_LIMIT_HREF}', body);
        const end = src.indexOf('</p>', body);
        expect(body).toBeGreaterThan(-1);
        expect(space).toBeGreaterThan(body);
        expect(link).toBeGreaterThan(space);
        expect(end).toBeGreaterThan(link);
        // Only the last line takes it, so it ends the card's text.
        expect(src).toContain('copy.learnMore && i === copy.lines.length - 1');
    });

    it('every line that carries information reads at zinc-400, the IP notice first', () => {
        // zinc-500 on the card is 3.99:1, under WCAG 1.4.3's 4.5:1; zinc-400
        // is 7.35:1 (spec 07 4.18). The IP notice is the page's one privacy
        // disclosure before Send.
        expect(classesBefore(read('RequestReady.tsx'), '{visitorCopy.ipNotice}')).toContain('text-zinc-400');
        expect(classesBefore(read('ReadyHeader.tsx'), '{visitorCopy.betaSupport}')).toContain('text-zinc-400');
        expect(classesBefore(read('ReportLink.tsx'), '{visitorCopy.reportLink}')).toContain('text-zinc-400');
        expect(classesBefore(read('RequestProgress.tsx'), '{visitorCopy.keepInFront}')).toContain('text-zinc-400');
        // The page heading too: since C-02 lost "This is a Floe request
        // link.", the heading is one of the lines that say what the page is.
        expect(classesBefore(read('ReadyHeader.tsx'), '{visitorCopy.readyEyebrow}')).toContain('text-zinc-400');
        // What stays dim on purpose: the Privacy and Terms footer, and the
        // dropzone's plus icon, which is not text.
        const dim: string[] = [];
        for (const name of readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort()) {
            for (const line of read(name).split(/\r?\n/)) {
                if (line.includes('text-zinc-500')) dim.push(`${name} ${line.trim().split(' ')[0]}`);
            }
        }
        expect(dim).toEqual(['RequestDropzone.tsx <Plus', 'RequestShell.tsx <footer']);
    });

    it('every card is the same opaque surface over the backdrop, with plain edges', () => {
        // Since D-165 art sits behind the card. A see-through card would let
        // it under the text, where e2e/request-look.spec.ts cannot measure it
        // (it composites background colors, not art), so the card is at least
        // 85% opaque zinc-950, and one class string on every card. No backdrop
        // blur: at 85% it drew nothing and still cost a pass on every scroll.
        const files = ['RequestReady.tsx', 'RequestStatus.tsx', 'RequestProgress.tsx', 'NoticeCard.tsx'];
        const cards = files.map((name) => {
            const m = /<section className="([^"]*)"/.exec(read(name));
            expect(m, name).not.toBeNull();
            return m![1];
        });
        expect(new Set(cards).size, cards.join(' | ')).toBe(1);
        const classes = cards[0].split(/\s+/);
        const alpha = classes.map((c) => /^bg-zinc-950\/(\d+)$/.exec(c)?.[1]).find(Boolean);
        expect(Number(alpha ?? 0), cards[0]).toBeGreaterThanOrEqual(85);
        // No glow on the card's edges, the top edge above all (the owner,
        // 2026-10-07): no ice tint or ice-colored shadow, no lit pseudo-element
        // or 1px child line, no lighter top border, no inner highlight. A plain
        // hairline border and a neutral depth shadow.
        expect(cards[0], cards[0]).not.toMatch(/ice|191|before:|after:|inset|ring-|border-t-|via-|from-|bg-linear|bg-gradient|backdrop-blur/);
        for (const name of files) expect(read(name), name).not.toMatch(/-top-px|top-\[-1px\]/);
    });
});
