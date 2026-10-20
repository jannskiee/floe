// @vitest-environment jsdom
/**
 * FileIcon reads its extension table by own key only. A name ending in
 * .constructor or .__proto__ used to return an Object.prototype member, and
 * rendering it blanked the whole window (#693).
 */
import {render} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import FileIcon from './FileIcon';

describe('FileIcon', () => {
    it.each([
        'a.constructor',
        'B.CONSTRUCTOR',
        'x.__proto__',
        'C:\\x\\stuff.constructor',
    ])('renders the generic icon for %s', (name) => {
        const {container} = render(<FileIcon name={name}/>);
        expect(
            container.querySelector('svg.lucide-file-text'),
        ).not.toBeNull();
    });

    it.each([
        ['photo.PNG', 'lucide-file-image'],
        ['archive.tar.gz', 'lucide-file-archive'],
        ['main.go', 'lucide-file-code'],
        ['zip', 'lucide-file-text'],
        ['C:\\dir.v2\\README', 'lucide-file-text'],
    ])('preserves existing mapping for %s', (name, iconClass) => {
        const {container} = render(<FileIcon name={name}/>);
        expect(
            container.querySelector(`svg.${iconClass}`),
        ).not.toBeNull();
    });
});
