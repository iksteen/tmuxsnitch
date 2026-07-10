mod helpers;

#[test]
fn modes() {
    helpers::fixture("modes");
}

#[test]
fn alternate_buffer() {
    helpers::fixture("alternate_buffer");
}

// shellglass: synchronized update (DEC private mode 2026) — mode bit plus
// wrapping BSU/ESU counters so a sampling consumer can see edges that opened
// and closed within one read.
#[test]
fn synchronized_update() {
    let mut vt = vt100::Parser::default();
    assert!(!vt.screen().synchronized_update());
    assert_eq!(vt.screen().synchronized_update_starts(), 0);
    assert_eq!(vt.screen().synchronized_update_ends(), 0);

    vt.process(b"\x1b[?2026h");
    assert!(vt.screen().synchronized_update());
    assert_eq!(vt.screen().synchronized_update_starts(), 1);
    assert_eq!(vt.screen().synchronized_update_ends(), 0);

    vt.process(b"\x1b[?2026l");
    assert!(!vt.screen().synchronized_update());
    assert_eq!(vt.screen().synchronized_update_ends(), 1);

    // A full update plus the start of the next, all in one read: the mode bit
    // says "in progress" while the counters expose the completed one.
    vt.process(b"\x1b[?2026hdraw\x1b[?2026l\x1b[?2026h");
    assert!(vt.screen().synchronized_update());
    assert_eq!(vt.screen().synchronized_update_starts(), 3);
    assert_eq!(vt.screen().synchronized_update_ends(), 2);
}

// shellglass: DECAWM (CSI ? 7 h/l) — with autowrap off the cursor clamps at
// the right margin and text overwrites the edge cell, like xterm; nothing
// spills onto the next line. DECSTR restores the wrap-on default.
#[test]
fn decawm_off_clamps_at_the_margin() {
    let mut vt = vt100::Parser::new(3, 10, 0);
    vt.process(b"\x1b[?7l0123456789ABC");
    assert_eq!(vt.screen().contents(), "012345678C");
    assert_eq!(vt.screen().cursor_position(), (0, 10));
    // A wide glyph at the margin overwrites the last two cells.
    vt.process("\u{65e5}\u{672c}".as_bytes());
    assert_eq!(vt.screen().contents(), "01234567\u{672c}");
    // Re-enabled: wrapping is back.
    vt.process(b"\x1b[2J\x1b[H\x1b[?7h0123456789xy");
    assert_eq!(vt.screen().cursor_position(), (1, 2));
    // (row 0 wrapped into row 1, so contents joins them)
    assert_eq!(vt.screen().contents(), "0123456789xy");
    // DECSTR resets autowrap to on.
    vt.process(b"\x1b[2J\x1b[H\x1b[?7l\x1b[!p0123456789Z");
    assert_eq!(vt.screen().cursor_position(), (1, 1));
    assert_eq!(vt.screen().contents(), "0123456789Z");
}

// shellglass: IRM (CSI 4 h/l) — insert mode shifts the rest of the row right;
// replace mode (the default) overwrites. DECSTR resets to replace.
#[test]
fn irm_insert_shifts_replace_overwrites() {
    let mut vt = vt100::Parser::default();
    vt.process(b"abc\r\x1b[4hXY");
    assert_eq!(vt.screen().contents(), "XYabc");
    // Back to replace: overwrite in place.
    vt.process(b"\x1b[4l\rZ");
    assert_eq!(vt.screen().contents(), "ZYabc");
    // Insert mode set again, then DECSTR → replace again.
    vt.process(b"\x1b[4h\x1b[!p\rQ");
    assert_eq!(vt.screen().contents(), "QYabc");
}
