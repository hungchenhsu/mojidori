//! Read-only hex/bytes preview for files that failed to decode as text.
//! Raw bytes never cross the IPC boundary (ARCHITECTURE.md hard constraint):
//! this module reads bytes from disk and formats them into a plain-text hex
//! dump entirely on the Rust side before returning.

use serde::Serialize;
use std::io::Read;

/// Hard cap on how much of a file is ever read for a hex preview, regardless
/// of what the caller asks for.
pub const MAX_HEX_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexDumpResult {
    /// Classic hex dump: 8-digit offset, 16 bytes/row in hex, ASCII column.
    pub text: String,
    /// Full size of the file on disk.
    pub total_size: u64,
    /// How many bytes were actually read and included in `text`.
    pub shown_bytes: usize,
}

/// Format bytes as a classic hex dump: `OFFSET  hex hex ... hex  |ascii|`,
/// 16 bytes per row, offset as 8 lowercase hex digits, non-printable ASCII
/// (outside 0x20..=0x7e) rendered as `.` in the ASCII column. Short trailing
/// rows are padded with blanks so the ASCII column stays aligned.
pub fn format_hex_dump(bytes: &[u8]) -> String {
    let mut out = String::new();
    for (row_index, chunk) in bytes.chunks(16).enumerate() {
        let offset = row_index * 16;
        out.push_str(&format!("{offset:08x}  "));
        for i in 0..16 {
            match chunk.get(i) {
                Some(b) => out.push_str(&format!("{b:02x} ")),
                None => out.push_str("   "),
            }
            if i == 7 {
                out.push(' ');
            }
        }
        out.push_str(" |");
        for &b in chunk {
            if (0x20..=0x7e).contains(&b) {
                out.push(b as char);
            } else {
                out.push('.');
            }
        }
        out.push_str("|\n");
    }
    out
}

/// Read up to `min(max_bytes, MAX_HEX_BYTES)` bytes from the start of `path`
/// and format them as a hex dump. `total_size` reports the full file size so
/// the UI can show "first N of M".
#[tauri::command]
pub fn read_hex_dump(path: String, max_bytes: usize) -> Result<HexDumpResult, String> {
    let cap = max_bytes.min(MAX_HEX_BYTES);
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mut buf = vec![0u8; cap];
    let mut read_total = 0usize;
    loop {
        if read_total == cap {
            break;
        }
        let n = file
            .read(&mut buf[read_total..])
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        read_total += n;
    }
    buf.truncate(read_total);
    Ok(HexDumpResult {
        text: format_hex_dump(&buf),
        total_size,
        shown_bytes: buf.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_produces_empty_dump() {
        assert_eq!(format_hex_dump(&[]), "");
    }

    #[test]
    fn fewer_than_sixteen_bytes_produce_one_padded_row() {
        // "ABC\n\0"
        let bytes = [0x41u8, 0x42, 0x43, 0x0a, 0x00];
        let dump = format_hex_dump(&bytes);
        let lines: Vec<&str> = dump.lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(dump.ends_with('\n'));
        // Present bytes are followed by blank padding up to column 16, and
        // the ASCII column only ever shows the 5 real bytes.
        assert!(lines[0].starts_with("00000000  41 42 43 0a 00 "));
        assert!(lines[0].ends_with("|ABC..|"));
    }

    #[test]
    fn exactly_sixteen_bytes_produce_one_unpadded_row_exact_text() {
        let bytes: Vec<u8> = (0u8..16).collect();
        let dump = format_hex_dump(&bytes);
        assert_eq!(
            dump,
            "00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|\n"
        );
    }

    #[test]
    fn all_byte_values_render_printable_ascii_or_dot() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let dump = format_hex_dump(&bytes);
        let lines: Vec<&str> = dump.lines().collect();
        assert_eq!(lines.len(), 16);

        // Row for bytes 0x20..0x30: all printable ASCII, shown verbatim.
        assert_eq!(
            lines[2],
            "00000020  20 21 22 23 24 25 26 27  28 29 2a 2b 2c 2d 2e 2f  | !\"#$%&'()*+,-./|"
        );
        // Row for bytes 0xf0..0x100: all non-printable, shown as dots.
        assert_eq!(
            lines[15],
            "000000f0  f0 f1 f2 f3 f4 f5 f6 f7  f8 f9 fa fb fc fd fe ff  |................|"
        );
        // 0x7f (DEL) is outside the printable range and must be a dot.
        assert_eq!(
            lines[7],
            "00000070  70 71 72 73 74 75 76 77  78 79 7a 7b 7c 7d 7e 7f  |pqrstuvwxyz{|}~.|"
        );
    }

    #[test]
    fn read_hex_dump_reports_empty_file() {
        let path = crate::testutil::temp_path("mojidori-hexdump-empty.txt");
        std::fs::write(&path, []).unwrap();
        let result = read_hex_dump(path.to_string_lossy().into_owned(), 65536).unwrap();
        assert_eq!(result.text, "");
        assert_eq!(result.total_size, 0);
        assert_eq!(result.shown_bytes, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_hex_dump_caps_at_64kb_even_when_more_is_requested() {
        let path = crate::testutil::temp_path("mojidori-hexdump-large.bin");
        let data = vec![0xabu8; MAX_HEX_BYTES + 10_000];
        std::fs::write(&path, &data).unwrap();

        let result =
            read_hex_dump(path.to_string_lossy().into_owned(), MAX_HEX_BYTES + 10_000).unwrap();
        assert_eq!(result.shown_bytes, MAX_HEX_BYTES);
        assert_eq!(result.total_size, data.len() as u64);
        assert_eq!(result.text.lines().count(), MAX_HEX_BYTES / 16);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_hex_dump_also_caps_when_caller_asks_for_more_than_the_hard_cap() {
        let path = crate::testutil::temp_path("mojidori-hexdump-cap-request.bin");
        std::fs::write(&path, vec![0x00u8; 100]).unwrap();

        // Caller asks for way more than MAX_HEX_BYTES; min() must still win.
        let result = read_hex_dump(path.to_string_lossy().into_owned(), 10_000_000).unwrap();
        assert_eq!(result.shown_bytes, 100);
        assert_eq!(result.total_size, 100);
        std::fs::remove_file(&path).ok();
    }
}
