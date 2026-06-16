//! A rope-backed editable text buffer with a cursor.
//!
//! Cursor positions and edit offsets are **char offsets** (matching ropey's
//! char-indexed API) — the unit used throughout the editor, region, and
//! grammar layers. Harper's `Span<char>` maps onto these directly.

use ropey::Rope;

use super::transaction::Change;

/// A rope-backed editable text buffer with a cursor (char offset).
pub struct Buffer {
    rope: Rope,
    cursor: usize,
}

impl Buffer {
    pub fn new(s: &str) -> Self {
        Self {
            rope: Rope::from_str(s),
            cursor: 0,
        }
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
    fn insert_str_records_change() {
        let mut b = Buffer::new("ac");
        let change = b.insert_str(1, "b");
        assert_eq!(b.text(), "abc");
        assert_eq!(change.from, 1);
        assert_eq!(change.insert, "b");
    }
}
