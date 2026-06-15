/**
 * Resolves a collision-free name for a ZIP entry.
 * If `name` is already in `used`, appends " (N)" before the extension
 * until a free slot is found, then adds the result to `used`.
 */
export function dedupeFileName(name: string, used: Set<string>): string {
    let finalName = name;
    let counter = 1;
    while (used.has(finalName)) {
        const dot = name.lastIndexOf('.');
        finalName = dot === -1
            ? `${name} (${counter})`
            : `${name.substring(0, dot)} (${counter})${name.substring(dot)}`;
        counter++;
    }
    used.add(finalName);
    return finalName;
}
