// The calm-copy rule (D-167) as a check: no line the app shows ends in a
// period. An ellipsis ("Connecting...") is not one, and text only a screen
// reader hears (sr-only) keeps its punctuation, because there the period is
// what makes the reader pause.

/** endsInPeriod: a closing period that is not part of an ellipsis. */
export function endsInPeriod(s: string): boolean {
    const t = s.trimEnd();
    return t.endsWith('.') && !t.endsWith('..');
}

/** closingPeriods lists every visible line under root that ends in a period:
 *  each element's own text, and the placeholder, title and aria-label it
 *  carries. Empty when the rule holds. */
export function closingPeriods(root: ParentNode): string[] {
    const found: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        if (el.closest('.sr-only, script, style')) continue;
        const own = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent ?? '')
            .join('');
        // An element's own text can be split by inline children (the reset
        // dialog's "... not <span>path</span>"), so the line is judged by the
        // element's whole text when it has any of its own.
        if (own.trim() !== '' && endsInPeriod(el.textContent ?? '')) found.push(el.textContent!.trim());
        for (const attr of ['placeholder', 'title', 'aria-label']) {
            const v = el.getAttribute(attr);
            if (v && endsInPeriod(v)) found.push(`${attr}: ${v}`);
        }
    }
    return [...new Set(found)];
}
