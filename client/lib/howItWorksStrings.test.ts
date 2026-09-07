import { describe, it, expect } from 'vitest';
import * as strings from './howItWorksStrings';

describe('howItWorksStrings', () => {
    it('derives the relay cap figure from RELAY_SIZE_LIMIT', () => {
        // The docs, the CLI error and the page all say "2 GB". If relay.ts ever
        // moves the limit, this is the assertion that says the page moved too.
        expect(strings.RELAY_CAP).toBe('2 GB');
    });

    it('matches the badge words the app renders', () => {
        expect(strings.BADGE_DIRECT).toBe('Direct');
        expect(strings.BADGE_RELAY).toBe('Relay');
    });

    it('never carries an em dash or an en dash', () => {
        for (const [name, value] of Object.entries(strings)) {
            expect(typeof value, name).toBe('string');
            expect(value, name).not.toMatch(/[–—]/);
        }
    });
});
