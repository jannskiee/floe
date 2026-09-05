// Pure scroll-spy logic for the legal pages' "On this page" list.
//
// One line, 96px below the viewport's top edge, decides which section is
// current: the section that has crossed it and sits lowest on the page. Before
// any section reaches the line (the top of the page, where the intro sits) the
// topmost section is current, so the list never shows nothing marked. At the
// bottom of the page the lowest section is current even when it is too short
// to ever reach the line: a short closing section above a tall footer would
// otherwise be the one entry the reader can never light up.
//
// Every pick is by measured position, never by array order, so the caller may
// pass the sections in any order.
//
// The line is a fixed offset rather than a share of the viewport on purpose.
// A share (30% was tried) is taller than the shortest terms sections, so
// scrolling one of those to the top lit up the section after it. 96px sits
// above the 40px anchor offset the TOC links scroll to (scroll-mt on each
// section), so a clicked section always counts as current, and below the
// height of every section on either page.

export interface SectionTop {
    id: string;
    /** Distance from the viewport's top edge to the section's top edge, in px. */
    top: number;
}

export const ACTIVE_LINE_PX = 96;

function lowest(sections: readonly SectionTop[]): SectionTop {
    return sections.reduce((a, b) => (b.top > a.top ? b : a));
}

function highest(sections: readonly SectionTop[]): SectionTop {
    return sections.reduce((a, b) => (b.top < a.top ? b : a));
}

export function pickActiveSection(sections: readonly SectionTop[], atBottom: boolean): string | null {
    if (sections.length === 0) return null;
    if (atBottom) return lowest(sections).id;
    const crossed = sections.filter((section) => section.top <= ACTIVE_LINE_PX);
    return (crossed.length > 0 ? lowest(crossed) : highest(sections)).id;
}
