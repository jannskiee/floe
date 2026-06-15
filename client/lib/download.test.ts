import { describe, it, expect } from 'vitest';
import { dedupeFileName } from './download';

describe('dedupeFileName', () => {
    it('returns the original name when unused', () => {
        const used = new Set<string>();
        expect(dedupeFileName('photo.jpg', used)).toBe('photo.jpg');
    });

    it('adds the name to the used set', () => {
        const used = new Set<string>();
        dedupeFileName('doc.pdf', used);
        expect(used.has('doc.pdf')).toBe(true);
    });

    it('appends (1) on first collision with extension', () => {
        const used = new Set(['photo.jpg']);
        expect(dedupeFileName('photo.jpg', used)).toBe('photo (1).jpg');
    });

    it('appends (2) on second collision with extension', () => {
        const used = new Set(['photo.jpg', 'photo (1).jpg']);
        expect(dedupeFileName('photo.jpg', used)).toBe('photo (2).jpg');
    });

    it('handles files with no extension', () => {
        const used = new Set(['README']);
        expect(dedupeFileName('README', used)).toBe('README (1)');
    });

    it('handles multiple collisions in sequence', () => {
        const used = new Set<string>();
        dedupeFileName('file.txt', used); // file.txt
        dedupeFileName('file.txt', used); // file (1).txt
        dedupeFileName('file.txt', used); // file (2).txt
        expect([...used]).toEqual(['file.txt', 'file (1).txt', 'file (2).txt']);
    });

    it('handles dotfiles (name starts with dot)', () => {
        const used = new Set(['.gitignore']);
        // lastIndexOf('.') === 0 → base='', ext='.gitignore' → ' (1).gitignore'
        // Matches the original inline loop behavior in P2PTransfer.tsx
        const result = dedupeFileName('.gitignore', used);
        expect(result).toBe(' (1).gitignore');
    });
});
