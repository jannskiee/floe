import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECEIVER_CONFIRMS } from './transfer/protocol';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// One line, so a wrapped sentence still matches.
const tiles = read('../components/landing/CapabilitiesSection.tsx').replace(/\s+/g, ' ');

function lastSentence(title: string): string | undefined {
    const tile = tiles.match(new RegExp(`title: '${title}', body: '([^']*)'`));
    return tile?.[1].split('. ').at(-1);
}

describe('the home page: Checked on arrival', () => {
    // A browser receiver confirms delivery while RECEIVER_CONFIRMS is on.
    // Turn it off and this sentence changes too.
    it('names every receiver that confirms delivery', () => {
        expect(RECEIVER_CONFIRMS).toBe(true);
        expect(lastSentence('Checked on arrival')).toBe('Browser, CLI, and Floe Desktop receivers confirm delivery.');
    });
});
