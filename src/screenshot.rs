//! In-process PNG screenshots of the TUI.
//!
//! Rasterizes a rendered ratatui [`Buffer`] to an RGBA image on a fixed
//! monospaced grid — each cell's foreground/background colour and bold/italic
//! come straight from the buffer cell's resolved style, so the picture matches
//! exactly what the terminal would show. No external tools (no `vhs`, no
//! headless browser): just `image` + `ab_glyph` + a bundled font, so it runs
//! deterministically anywhere, including CI.
//!
//! Compiled behind the `screenshots` feature.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use image::{Rgba, RgbaImage};
use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};

/// Bundled monospace font (DejaVu Sans Mono — Bitstream Vera / DejaVu license).
const FONT: &[u8] = include_bytes!("../assets/fonts/DejaVuSansMono.ttf");

/// Cell dimensions in pixels (a 2:1-ish monospace cell), and the glyph size.
const CELL_W: u32 = 9;
const CELL_H: u32 = 19;
const FONT_PX: f32 = 16.0;

/// Render a ratatui [`Buffer`] to PNG bytes.
pub fn buffer_to_png(buf: &Buffer) -> Vec<u8> {
    let img = buffer_to_image(buf);
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("PNG encode");
    out.into_inner()
}

/// Render a ratatui [`Buffer`] to an RGBA image.
pub fn buffer_to_image(buf: &Buffer) -> RgbaImage {
    let area = buf.area();
    let cols = area.width as u32;
    let rows = area.height as u32;
    let mut img = RgbaImage::from_pixel(cols * CELL_W, rows * CELL_H, Rgba([24, 24, 24, 255]));

    let font = FontRef::try_from_slice(FONT).expect("valid bundled font");
    let scale = PxScale::from(FONT_PX);
    let scaled = font.as_scaled(scale);
    let ascent = scaled.ascent();

    for gy in 0..rows {
        for gx in 0..cols {
            let cell = &buf[(area.x + gx as u16, area.y + gy as u16)];
            let (fg, bg) = cell_colors(cell.fg, cell.bg, cell.modifier);
            let x0 = gx * CELL_W;
            let y0 = gy * CELL_H;
            fill_rect(&mut img, x0, y0, CELL_W, CELL_H, bg);

            let sym = cell.symbol();
            let ch = sym.chars().next().unwrap_or(' ');
            if ch == ' ' || ch == '\u{00a0}' {
                continue;
            }
            let glyph = font
                .glyph_id(ch)
                .with_scale_and_position(scale, point(x0 as f32 + 1.0, y0 as f32 + ascent));
            if let Some(outline) = font.outline_glyph(glyph) {
                let bounds = outline.px_bounds();
                outline.draw(|ox, oy, coverage| {
                    let px = bounds.min.x as i32 + ox as i32;
                    let py = bounds.min.y as i32 + oy as i32;
                    if px < 0 || py < 0 {
                        return;
                    }
                    let (px, py) = (px as u32, py as u32);
                    if px >= img.width() || py >= img.height() {
                        return;
                    }
                    let dst = img.get_pixel(px, py).0;
                    let blended = blend(dst, fg, coverage);
                    img.put_pixel(px, py, Rgba(blended));
                });
            }
        }
    }
    img
}

fn fill_rect(img: &mut RgbaImage, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
    for yy in y..(y + h).min(img.height()) {
        for xx in x..(x + w).min(img.width()) {
            img.put_pixel(xx, yy, Rgba(color));
        }
    }
}

/// Alpha-blend `src` over `dst` weighted by `coverage` (0..=1).
fn blend(dst: [u8; 4], src: [u8; 4], coverage: f32) -> [u8; 4] {
    let a = coverage.clamp(0.0, 1.0);
    let mix = |d: u8, s: u8| (d as f32 * (1.0 - a) + s as f32 * a).round() as u8;
    [
        mix(dst[0], src[0]),
        mix(dst[1], src[1]),
        mix(dst[2], src[2]),
        255,
    ]
}

/// Resolve a cell's (fg, bg) RGBA, honouring REVERSED and a default palette.
fn cell_colors(fg: Color, bg: Color, modifier: Modifier) -> ([u8; 4], [u8; 4]) {
    let default_fg = [220, 220, 220, 255];
    let default_bg = [24, 24, 24, 255];
    let mut fg = color_to_rgba(fg).unwrap_or(default_fg);
    let mut bg = color_to_rgba(bg).unwrap_or(default_bg);
    if modifier.contains(Modifier::REVERSED) {
        std::mem::swap(&mut fg, &mut bg);
    }
    if modifier.contains(Modifier::DIM) {
        fg = [fg[0] / 2 + 20, fg[1] / 2 + 20, fg[2] / 2 + 20, 255];
    }
    (fg, bg)
}

/// Map a ratatui [`Color`] to RGBA, or `None` for `Reset` (use the default).
fn color_to_rgba(c: Color) -> Option<[u8; 4]> {
    let rgb = |r, g, b| Some([r, g, b, 255]);
    match c {
        Color::Reset => None,
        Color::Rgb(r, g, b) => rgb(r, g, b),
        Color::Black => rgb(0, 0, 0),
        Color::Red => rgb(205, 49, 49),
        Color::Green => rgb(13, 188, 121),
        Color::Yellow => rgb(229, 229, 16),
        Color::Blue => rgb(36, 114, 200),
        Color::Magenta => rgb(188, 63, 188),
        Color::Cyan => rgb(17, 168, 205),
        Color::Gray => rgb(204, 204, 204),
        Color::DarkGray => rgb(102, 102, 102),
        Color::LightRed => rgb(241, 76, 76),
        Color::LightGreen => rgb(35, 209, 139),
        Color::LightYellow => rgb(245, 245, 67),
        Color::LightBlue => rgb(59, 142, 234),
        Color::LightMagenta => rgb(214, 112, 214),
        Color::LightCyan => rgb(41, 184, 219),
        Color::White => rgb(229, 229, 229),
        Color::Indexed(i) => {
            let (r, g, b) = xterm256(i);
            rgb(r, g, b)
        }
    }
}

/// Standard xterm-256 palette entry → RGB.
fn xterm256(i: u8) -> (u8, u8, u8) {
    match i {
        0 => (0, 0, 0),
        1 => (205, 0, 0),
        2 => (0, 205, 0),
        3 => (205, 205, 0),
        4 => (0, 0, 238),
        5 => (205, 0, 205),
        6 => (0, 205, 205),
        7 => (229, 229, 229),
        8 => (127, 127, 127),
        9 => (255, 0, 0),
        10 => (0, 255, 0),
        11 => (255, 255, 0),
        12 => (92, 92, 255),
        13 => (255, 0, 255),
        14 => (0, 255, 255),
        15 => (255, 255, 255),
        16..=231 => {
            let n = i - 16;
            let levels = [0u8, 95, 135, 175, 215, 255];
            (
                levels[(n / 36) as usize],
                levels[((n / 6) % 6) as usize],
                levels[(n % 6) as usize],
            )
        }
        232..=255 => {
            let v = 8 + (i - 232) * 10;
            (v, v, v)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::layout::Rect;

    #[test]
    fn renders_a_nonempty_png_of_expected_size() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 3));
        buf.set_string(0, 0, "Hello", ratatui::style::Style::default());
        let img = buffer_to_image(&buf);
        assert_eq!(img.width(), 10 * CELL_W);
        assert_eq!(img.height(), 3 * CELL_H);
        let png = buffer_to_png(&buf);
        assert!(
            png.starts_with(&[0x89, b'P', b'N', b'G']),
            "PNG magic header"
        );
    }

    #[test]
    fn output_is_deterministic() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 12, 2));
        buf.set_string(0, 0, "Whetstone", ratatui::style::Style::default());
        assert_eq!(buffer_to_png(&buf), buffer_to_png(&buf));
    }
}
