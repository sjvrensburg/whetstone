//! A rope-backed editable text buffer with a cursor.
//!
//! Cursor positions and edit offsets are **char offsets** (matching ropey's
//! char-indexed API) — the unit used throughout the editor, region, and
//! grammar layers. Harper's `Span<char>` maps onto these directly.

use ropey::Rope;
use unicode_width::UnicodeWidthChar;

use super::transaction::Change;

/// A rope-backed editable text buffer with a cursor (char offset) and an
/// optional selection anchor (the other end of a selection; the cursor is the
/// moving end).
pub struct Buffer {
    rope: Rope,
    cursor: usize,
    anchor: Option<usize>,
}

impl Buffer {
    pub fn new(s: &str) -> Self {
        Self {
            rope: Rope::from_str(s),
            cursor: 0,
            anchor: None,
        }
    }

    // --- selection ---------------------------------------------------------

    /// Begin (or keep) a selection anchored at the current cursor. Call before
    /// a cursor move to extend a selection (Shift+arrows).
    pub fn begin_selection(&mut self) {
        if self.anchor.is_none() {
            self.anchor = Some(self.cursor);
        }
    }

    /// Drop any active selection.
    pub fn clear_selection(&mut self) {
        self.anchor = None;
    }

    /// The selected `[start, end)` char range, if any (empty selections → None).
    pub fn selection(&self) -> Option<(usize, usize)> {
        let a = self.anchor?;
        let (s, e) = (a.min(self.cursor), a.max(self.cursor));
        (s < e).then_some((s, e))
    }

    /// The selected text, if any.
    pub fn selected_text(&self) -> Option<String> {
        let (s, e) = self.selection()?;
        Some(self.rope.slice(s..e).to_string())
    }

    /// Set an explicit selection `[start, end)` with the caret at `end`.
    pub fn set_selection(&mut self, start: usize, end: usize) {
        let n = self.len_chars();
        self.anchor = Some(start.min(n));
        self.cursor = end.min(n);
    }

    /// Select the whole buffer.
    pub fn select_all(&mut self) {
        if self.len_chars() > 0 {
            self.anchor = Some(0);
            self.cursor = self.len_chars();
        }
    }

    /// Select the word (alphanumeric/underscore run) under `offset`; if the
    /// char there isn't a word char, select just that one character.
    pub fn select_word(&mut self, offset: usize) {
        let n = self.len_chars();
        if n == 0 {
            return;
        }
        let off = offset.min(n - 1);
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        if !is_word(self.rope.char(off)) {
            self.anchor = Some(off);
            self.cursor = off + 1;
            return;
        }
        let mut start = off;
        while start > 0 && is_word(self.rope.char(start - 1)) {
            start -= 1;
        }
        let mut end = off;
        while end < n && is_word(self.rope.char(end)) {
            end += 1;
        }
        self.anchor = Some(start);
        self.cursor = end;
    }

    /// Select the whole content of `line` (excluding its trailing newline).
    pub fn select_line(&mut self, line: usize) {
        let last = self.rope.len_lines().saturating_sub(1);
        let line = line.min(last);
        let start = self.rope.line_to_char(line);
        self.anchor = Some(start);
        self.cursor = start + self.line_content_len(line);
    }

    /// Delete the active selection, returning the applied [`Change`].
    pub fn delete_selection(&mut self) -> Option<Change> {
        let (s, e) = self.selection()?;
        self.anchor = None;
        Some(self.remove(s, e))
    }

    /// Replace the active selection with `s` (a single replace [`Change`]).
    pub fn replace_selection(&mut self, s: &str) -> Option<Change> {
        let (a, b) = self.selection()?;
        self.anchor = None;
        self.rope.remove(a..b);
        self.rope.insert(a, s);
        self.cursor = a + s.chars().count();
        Some(Change {
            from: a,
            to: b,
            insert: s.to_string(),
        })
    }

    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    pub fn is_empty(&self) -> bool {
        self.len_chars() == 0
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn set_cursor(&mut self, offset: usize) {
        self.cursor = offset.min(self.len_chars());
    }

    /// Number of lines in the buffer.
    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    /// Move the cursor to a `(line, col)`, clamping both into range (used for
    /// mouse clicks). `col` is clamped to the line's content length.
    pub fn set_cursor_line_col(&mut self, line: usize, col: usize) {
        let last = self.rope.len_lines().saturating_sub(1);
        let line = line.min(last);
        let max_col = self.line_content_len(line);
        let col = col.min(max_col);
        self.cursor = self.rope.line_to_char(line) + col;
    }

    /// Char offset where line `line` begins.
    pub fn line_char_start(&self, line: usize) -> usize {
        self.rope.line_to_char(line)
    }

    /// The text of line `line`, without its trailing newline.
    pub fn line_text(&self, line: usize) -> String {
        let s = self.rope.line(line).to_string();
        s.trim_end_matches(['\n', '\r']).to_string()
    }

    /// The `(line, column)` of the cursor, both 0-based. The column is the
    /// char offset within the line.
    pub fn cursor_line_col(&self) -> (usize, usize) {
        let total = self.len_chars();
        let c = self.cursor.min(total);
        let line = self.rope.char_to_line(c);
        let line_start = self.rope.line_to_char(line);
        (line, c - line_start)
    }

    /// Terminal display width (columns) of `line` up to char column `col`.
    /// Accounts for wide glyphs (CJK/emoji), so the drawn cursor and mouse
    /// hit-testing agree with what the terminal actually renders.
    pub fn display_width(&self, line: usize, col: usize) -> usize {
        self.line_text(line)
            .chars()
            .take(col)
            .map(|c| UnicodeWidthChar::width(c).unwrap_or(0))
            .sum()
    }

    /// The char column in `line` whose rendered cell is at (or just past)
    /// terminal display column `target` — the inverse of [`Self::display_width`]
    /// used to turn a mouse click into a cursor offset.
    pub fn char_col_for_display(&self, line: usize, target: usize) -> usize {
        let text = self.line_text(line);
        let mut width = 0usize;
        for (i, c) in text.chars().enumerate() {
            let cw = UnicodeWidthChar::width(c).unwrap_or(0);
            if width + cw > target {
                return i;
            }
            width += cw;
        }
        text.chars().count()
    }

    /// Usable char length of a line, excluding its trailing newline.
    fn line_content_len(&self, line: usize) -> usize {
        let s = self.rope.line(line).to_string();
        let n = s.chars().count();
        if s.ends_with('\n') || s.ends_with('\r') {
            n - 1
        } else {
            n
        }
    }

    // --- mutation: each returns the applied [`Change`] ---------------------

    pub fn type_char(&mut self, c: char) -> Change {
        self.insert_str(self.cursor, &c.to_string())
    }

    pub fn type_str(&mut self, s: &str) -> Change {
        self.insert_str(self.cursor, s)
    }

    pub fn insert_str(&mut self, offset: usize, s: &str) -> Change {
        self.rope.insert(offset, s);
        self.cursor = offset + s.chars().count();
        Change {
            from: offset,
            to: offset,
            insert: s.to_string(),
        }
    }

    pub fn delete_backward(&mut self) -> Option<Change> {
        if self.cursor == 0 {
            return None;
        }
        let from = self.cursor - 1;
        Some(self.remove(from, self.cursor))
    }

    pub fn delete_forward(&mut self) -> Option<Change> {
        if self.cursor >= self.len_chars() {
            return None;
        }
        let to = self.cursor + 1;
        Some(self.remove(self.cursor, to))
    }

    pub fn remove(&mut self, from: usize, to: usize) -> Change {
        self.rope.remove(from..to);
        self.cursor = from;
        Change {
            from,
            to,
            insert: String::new(),
        }
    }

    // --- movement ----------------------------------------------------------

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.len_chars());
    }

    pub fn move_up(&mut self) {
        let (line, col) = self.cursor_line_col();
        if line == 0 {
            self.cursor = 0;
            return;
        }
        let target = line - 1;
        let new_col = col.min(self.line_content_len(target));
        self.cursor = self.rope.line_to_char(target) + new_col;
    }

    pub fn move_down(&mut self) {
        let (line, col) = self.cursor_line_col();
        let last = self.rope.len_lines().saturating_sub(1);
        if line >= last {
            self.cursor = self.len_chars();
            return;
        }
        let target = line + 1;
        let new_col = col.min(self.line_content_len(target));
        self.cursor = self.rope.line_to_char(target) + new_col;
    }

    pub fn move_line_start(&mut self) {
        let (line, _) = self.cursor_line_col();
        self.cursor = self.rope.line_to_char(line);
    }

    pub fn move_line_end(&mut self) {
        let (line, _) = self.cursor_line_col();
        self.cursor = self.rope.line_to_char(line) + self.line_content_len(line);
    }

    /// "Smart home": toggle between the first non-blank column and column 0.
    pub fn move_smart_home(&mut self) {
        let (line, col) = self.cursor_line_col();
        let start = self.rope.line_to_char(line);
        let first = self.first_non_blank(line);
        self.cursor = if col == first { start } else { start + first };
    }

    // --- word-wise --------------------------------------------------------

    fn is_word(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// Offset one word to the left of the cursor (skip whitespace, then a run
    /// of word chars).
    pub fn word_left(&self) -> usize {
        let mut i = self.cursor;
        while i > 0 && self.rope.char(i - 1).is_whitespace() {
            i -= 1;
        }
        while i > 0 && Self::is_word(self.rope.char(i - 1)) {
            i -= 1;
        }
        i
    }

    /// Offset one word to the right of the cursor.
    pub fn word_right(&self) -> usize {
        let n = self.len_chars();
        let mut i = self.cursor;
        while i < n && self.rope.char(i).is_whitespace() {
            i += 1;
        }
        while i < n && Self::is_word(self.rope.char(i)) {
            i += 1;
        }
        i
    }

    pub fn move_word_left(&mut self) {
        self.cursor = self.word_left();
    }

    pub fn move_word_right(&mut self) {
        self.cursor = self.word_right();
    }

    pub fn delete_word_left(&mut self) -> Option<Change> {
        let target = self.word_left();
        (target < self.cursor).then(|| self.remove(target, self.cursor))
    }

    pub fn delete_word_right(&mut self) -> Option<Change> {
        let target = self.word_right();
        (target > self.cursor).then(|| self.remove(self.cursor, target))
    }

    // --- bracket matching -------------------------------------------------

    /// If a bracket sits at or just before the cursor, return
    /// `(bracket_pos, match_pos)` — the char offsets of that bracket and its
    /// matching partner. Returns `None` when no bracket is adjacent to the
    /// cursor or it has no match. The char *at* the cursor takes precedence
    /// over the one before it (matching VS Code's behavior).
    pub fn matching_bracket(&self) -> Option<(usize, usize)> {
        let n = self.len_chars();
        let at = (self.cursor < n).then(|| self.rope.char(self.cursor));
        let before = (self.cursor > 0).then(|| self.rope.char(self.cursor - 1));
        let (pos, ch) = if let Some(c) = at.filter(|c| Self::bracket_of(*c).is_some()) {
            (self.cursor, c)
        } else if let Some(c) = before.filter(|c| Self::bracket_of(*c).is_some()) {
            (self.cursor - 1, c)
        } else {
            return None;
        };
        self.scan_match(pos, ch).map(|m| (pos, m))
    }

    /// The `(open, close)` pair that `c` belongs to, or `None` if `c` is not a
    /// bracket.
    fn bracket_of(c: char) -> Option<(char, char)> {
        match c {
            '(' | ')' => Some(('(', ')')),
            '[' | ']' => Some(('[', ']')),
            '{' | '}' => Some(('{', '}')),
            _ => None,
        }
    }

    /// Scan outward from the bracket `ch` at `pos` for its depth-balanced
    /// partner: forward for an opener, backward for a closer.
    fn scan_match(&self, pos: usize, ch: char) -> Option<usize> {
        let (open, close) = Self::bracket_of(ch)?;
        let n = self.len_chars();
        let mut depth = 1i32;
        if ch == open {
            for i in (pos + 1)..n {
                let c = self.rope.char(i);
                if c == open {
                    depth += 1;
                } else if c == close {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
            }
        } else {
            for i in (0..pos).rev() {
                let c = self.rope.char(i);
                if c == close {
                    depth += 1;
                } else if c == open {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
            }
        }
        None
    }

    // --- indentation ------------------------------------------------------

    /// The leading whitespace of `line` (spaces/tabs).
    pub fn line_indent(&self, line: usize) -> String {
        self.line_text(line)
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect()
    }

    /// Column of the first non-whitespace char on `line` (or its length).
    pub fn first_non_blank(&self, line: usize) -> usize {
        self.line_text(line)
            .chars()
            .take_while(|c| c.is_whitespace())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_and_delete() {
        let mut b = Buffer::new("hello");
        b.set_cursor(5);
        b.type_char('!');
        assert_eq!(b.text(), "hello!");
        assert_eq!(b.cursor(), 6);
        b.delete_backward();
        assert_eq!(b.text(), "hello");
        assert_eq!(b.cursor(), 5);
    }

    #[test]
    fn cursor_moves_vertically_by_column() {
        let mut b = Buffer::new("abcd\nef\nghi");
        b.set_cursor(2); // line 0, col 2 ("c")
        b.move_down(); // → line 1, col 2 clamps to line1 len 2 → col 2 ("after f")
        let (line, col) = b.cursor_line_col();
        assert_eq!((line, col), (1, 2));
        b.move_down(); // line 2, col 2 ("i" +1? line2 len 3 → col 2 = "i")
        let (line, col) = b.cursor_line_col();
        assert_eq!((line, col), (2, 2));
        b.move_up(); // back to line 1 col 2
        let (line, col) = b.cursor_line_col();
        assert_eq!((line, col), (1, 2));
    }

    #[test]
    fn line_start_and_end() {
        let mut b = Buffer::new("hello world\nsecond");
        b.set_cursor(7);
        b.move_line_start();
        assert_eq!(b.cursor_line_col(), (0, 0));
        b.move_line_end();
        assert_eq!(b.cursor_line_col(), (0, 11));
    }

    #[test]
    fn selection_extend_copy_and_replace() {
        let mut b = Buffer::new("hello world");
        b.set_cursor(0);
        b.begin_selection();
        for _ in 0..5 {
            b.move_right();
        }
        assert_eq!(b.selection(), Some((0, 5)));
        assert_eq!(b.selected_text().as_deref(), Some("hello"));
        let ch = b.replace_selection("HI").unwrap();
        assert_eq!(b.text(), "HI world");
        assert_eq!((ch.from, ch.to, ch.insert.as_str()), (0, 5, "HI"));
        assert_eq!(b.cursor(), 2);
        assert_eq!(b.selection(), None);
    }

    #[test]
    fn word_movement_and_delete() {
        let mut b = Buffer::new("alpha beta gamma");
        b.set_cursor(16); // end
        b.move_word_left(); // → start of "gamma" (11)
        assert_eq!(b.cursor(), 11);
        b.move_word_left(); // → start of "beta" (6)
        assert_eq!(b.cursor(), 6);
        b.delete_word_right(); // removes "beta"
        assert_eq!(b.text(), "alpha  gamma");
        b.set_cursor(5);
        b.delete_word_left(); // removes "alpha"
        assert_eq!(b.text(), "  gamma");
    }

    #[test]
    fn smart_home_toggles() {
        let mut b = Buffer::new("    indented");
        b.set_cursor(12); // end
        b.move_smart_home(); // → first non-blank (col 4)
        assert_eq!(b.cursor_line_col(), (0, 4));
        b.move_smart_home(); // → col 0
        assert_eq!(b.cursor_line_col(), (0, 0));
    }

    #[test]
    fn select_word_and_line() {
        let mut b = Buffer::new("foo bar_baz qux\nsecond");
        b.select_word(5); // inside "bar_baz"
        assert_eq!(b.selected_text().as_deref(), Some("bar_baz"));
        b.select_line(0);
        assert_eq!(b.selected_text().as_deref(), Some("foo bar_baz qux"));
    }

    #[test]
    fn select_all_and_delete() {
        let mut b = Buffer::new("abc");
        b.select_all();
        assert_eq!(b.selection(), Some((0, 3)));
        b.delete_selection();
        assert_eq!(b.text(), "");
    }

    #[test]
    fn matching_bracket_finds_partners_both_directions() {
        let mut b = Buffer::new("a(b[c]d)e");
        // Cursor on the opening '(' (offset 1) → match its ')' at offset 7.
        b.set_cursor(1);
        assert_eq!(b.matching_bracket(), Some((1, 7)));
        // Cursor on the closing ')' (offset 7) → back to '(' at 1.
        b.set_cursor(7);
        assert_eq!(b.matching_bracket(), Some((7, 1)));
        // Nested: '[' at 3 ↔ ']' at 5.
        b.set_cursor(3);
        assert_eq!(b.matching_bracket(), Some((3, 5)));
    }

    #[test]
    fn matching_bracket_prefers_char_at_cursor_then_before() {
        let mut b = Buffer::new("()");
        // Between the two: char at cursor is ')' (closer) → matches '(' at 0.
        b.set_cursor(1);
        assert_eq!(b.matching_bracket(), Some((1, 0)));
        // Past the end: only the char before (')') is a bracket.
        b.set_cursor(2);
        assert_eq!(b.matching_bracket(), Some((1, 0)));
    }

    #[test]
    fn matching_bracket_none_when_unmatched_or_absent() {
        let mut b = Buffer::new("a(b");
        b.set_cursor(1); // '(' with no closer
        assert_eq!(b.matching_bracket(), None);
        b.set_cursor(0); // 'a', not a bracket
        assert_eq!(b.matching_bracket(), None);
    }

    #[test]
    fn matching_bracket_ignores_mismatched_kinds() {
        // The ']' has no matching '[' to its left; the '(' is a different kind.
        let mut b = Buffer::new("(]");
        b.set_cursor(1);
        assert_eq!(b.matching_bracket(), None);
    }

    #[test]
    fn insert_str_records_change() {
        let mut b = Buffer::new("ac");
        let change = b.insert_str(1, "b");
        assert_eq!(b.text(), "abc");
        assert_eq!(change.from, 1);
        assert_eq!(change.insert, "b");
    }
}
