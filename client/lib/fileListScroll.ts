// When the sender's and the receiver's file lists become scroll boxes.
//
// Each row carries a tooltip with the whole file name, placed under the name
// and transparent until hover. Inside a scroll box a transparent box still
// counts toward the scrollable height, so a list that fit had something to
// scroll: measured with one file, scrollHeight 89 against clientHeight 66 on
// the receiving page and 83 against 58 on the sending page. The receiving page
// scrolls its list to the bottom after each file lands, which cut 23 px off
// the top of the first row, and both lists drew a scrollbar beside one row.
//
// Hiding the tooltip with display: none fixed that and broke the tooltip: on
// hover the last row's box opened below the list's edge, clipped to a sliver,
// and the scrollbar popped in under the pointer. So the tooltip stays as it
// was, and the list is not a scroll box at all until it needs to be. Without
// one there is nothing to scroll and nothing to clip, and the tooltip of the
// last row shows whole.
//
// Four rows fit in the 300 px the lists are capped at: rows are 66 px on the
// receiving page and 58 px on the sending page, 12 px apart. A count and not a
// measurement, because measuring the box is what the tooltip made unreliable.
// If type or zoom makes rows taller, a list of four is a little over 300 px
// before it scrolls at five, which is harmless.

const FILE_LIST_ROWS_BEFORE_SCROLL = 4;

export function fileListScrolls(rows: number): boolean {
    return rows > FILE_LIST_ROWS_BEFORE_SCROLL;
}
