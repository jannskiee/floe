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
        // What stays dim on purpose: the dropzone's plus icon, which is not
        // text. The Privacy and Terms footer was dim too until the 2026-10-08
        // QA measured it at 4.05 to 4.15:1 on the backdrop, under AA's 4.5:1
        // for 12 px text; the owner chose zinc-400 ("Fix both").
        const dim: string[] = [];
        for (const name of readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort()) {
            for (const line of read(name).split(/\r?\n/)) {
                if (line.includes('text-zinc-500')) dim.push(`${name} ${line.trim().split(' ')[0]}`);
            }
        }
        expect(dim).toEqual(['RequestDropzone.tsx <Plus']);
        expect(classesBefore(read('RequestShell.tsx'), '\n                Privacy')).toContain('touch-text');
        expect(read('RequestShell.tsx')).toMatch(/<footer className="[^"]*\btext-zinc-400\b/);
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

// The 2026-10-08 QA (work/46-r-qa): the measured defects each fix answers are
// named in the component comments. Read as text, like everything above; the
// rendered result is measured by e2e/responsive.spec.ts and request-look.spec.ts.
describe('the /r layout at every size', () => {
    it('rows that hold two things wrap rather than spill', () => {
        const ready = read('RequestReady.tsx');
        // Send and Clear: at 280 px a 100+ file count made Send wider than the row.
        expect(ready).toMatch(/<div className="mt-4 flex flex-wrap gap-2">/);
        // The IP notice and Report this link: at 200% text the link left the
        // card; the notice keeps 10.5rem and the link moves to its own line.
        const notice = classesBefore(ready, '{visitorCopy.ipNotice}');
        expect(notice).toContain('flex-[1_1_10.5rem]');
        expect(ready).toMatch(/<div className="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">/);
        expect(classesBefore(read('ReportLink.tsx'), '{visitorCopy.reportLink}')).toContain('ml-auto');
        // Keep sending and Stop: 195 px in 164 at 280.
        expect(read('RequestProgress.tsx')).toMatch(/<div className="mt-4 flex flex-wrap gap-2">/);
        // The Sending header and its route badge: 91 px of page scroll at 280
        // with 200% text.
        expect(read('RequestProgress.tsx')).toContain('<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">');
        // The eyebrow and the Beta chip.
        expect(read('ReadyHeader.tsx')).toContain('<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">');
        expect(classesBefore(read('ReadyHeader.tsx'), '{visitorCopy.readyEyebrow}')).toContain('flex-[1_1_9.5rem]');
    });

    it('a status line breaks a long path instead of widening the page', () => {
        expect(classesBefore(read('RequestStatus.tsx'), '{copy.learnMore && i ===')).toContain('break-words');
    });

    it('the eyebrow never leaves one word on a line', () => {
        expect(classesBefore(read('ReadyHeader.tsx'), '{visitorCopy.readyEyebrow}')).toContain('text-balance');
    });

    it('a path row keeps its end: no row truncates the whole path from the right', () => {
        const rows = read('ArrivedList.tsx');
        expect(rows).toContain('displayPath(path.replace(');
        expect(rows).toContain('splitTail(shown)');
        expect(rows).not.toMatch(/\btruncate\b/);
        // Read once and whole by assistive tech; drawn as two aria-hidden
        // halves; right-to-left names laid out right to left; the tail gives
        // way from its start.
        expect(rows).toContain('<span className="sr-only">{shown}</span>');
        expect(rows.split('aria-hidden="true"').length - 1).toBe(2);
        expect(rows).toContain("dir={rtl ? 'rtl' : 'ltr'}");
        expect(rows).toContain("dir={rtl ? 'ltr' : 'rtl'}");
        expect(rows).toContain('<bdi');
        expect(read('RequestProgress.tsx')).toContain('<PathText path={props.currentPath} />');
        expect(read('RequestProgress.tsx')).not.toMatch(/\btruncate\b/);
        // Four rows instead of six on a window under 800 px tall, so Send
        // stays in view on a 1366 x 768 laptop.
        expect(rows).toContain('max-h-60');
        expect(rows).toContain('[@media(max-height:50rem)]:max-h-40');
    });

    it('Add more files draws the Button focus ring when its hidden input has focus', () => {
        const zone = read('RequestDropzone.tsx');
        for (const c of ['has-[input:focus-visible]:border-ring', 'has-[input:focus-visible]:ring-[3px]', 'has-[input:focus-visible]:ring-ring/50']) {
            expect(zone).toContain(c);
        }
    });

    it('a card title beside its dot can shrink and break a long word', () => {
        expect(read('NoticeCard.tsx')).toMatch(/<h1[^>]*className="min-w-0 break-words /);
        const status = read('RequestStatus.tsx');
        expect(status.split("'min-w-0 break-words ").length - 1).toBe(3);
    });

    it('a button keeps its drawn height at 100% text and wraps its label at 200%', () => {
        // h-auto lets a label wrap; the padding then sets the height, so an
        // outline button (1 px border) takes 1 px less of it: 32 and 36 px.
        for (const name of ['RequestReady.tsx', 'RequestStatus.tsx', 'RequestProgress.tsx', 'RequestDropzone.tsx']) {
            const src = read(name);
            for (const m of src.matchAll(/<Button\b[\s\S]*?className="([^"]*)"/g)) {
                const c = m[1].split(/\s+/);
                expect(c, `${name}: ${m[1]}`).toContain('whitespace-normal');
                expect(c, `${name}: ${m[1]}`).toContain('h-auto');
                const outline = /variant="outline"/.test(m[0]);
                const sm = /size="sm"/.test(m[0]);
                if (outline) expect(c, `${name}: ${m[1]}`).toContain(sm ? 'py-[5px]' : 'py-[7px]');
                expect(c, `${name}: ${m[1]}`).toContain(sm ? 'min-h-8' : 'min-h-9');
            }
        }
    });

    it('every card has a heading that can take focus back', () => {
        for (const name of ['ReadyHeader.tsx', 'RequestStatus.tsx', 'RequestProgress.tsx', 'NoticeCard.tsx']) {
            const src = read(name);
            expect(src, name).toContain('tabIndex={-1}');
            expect(src, name).toContain('data-card-heading=""');
            expect(src, name).toMatch(/<h1[\s\S]*?outline-none/);
        }
    });

    it('every control gets the invisible touch area', () => {
        for (const name of readdirSync(DIR).filter((f) => f.endsWith('.tsx')).sort()) {
            const src = read(name);
            const buttons = src.split('<Button').length - 1;
            expect(src.split('touch-button').length - 1, name).toBe(buttons);
            const anchors = (src.match(/<a\b/g) ?? []).length;
            expect(src.split('touch-text').length - 1, name).toBeGreaterThanOrEqual(anchors);
        }
        const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');
        for (const name of ['touch-button', 'touch-text']) {
            const from = css.indexOf(`@utility ${name} {`);
            expect(from, name).toBeGreaterThan(-1);
            // This utility alone: up to the next one or the next top-level rule.
            const rest = css.slice(from + 1);
            const next = rest.search(/\n(@utility|@layer|@media|@keyframes|\/\*|\.)/);
            const block = next === -1 ? rest : rest.slice(0, next);
            expect(block.indexOf('@media (pointer: coarse)'), name).toBeGreaterThan(-1);
            expect(block.slice(0, block.indexOf('}\n}')), name).toContain('&::after');
        }
    });
});
