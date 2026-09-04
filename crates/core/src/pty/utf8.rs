//! Incremental UTF-8 decoding: a multibyte sequence (e.g. Korean, 3 bytes) may be
//! split across two pty reads. We hold the incomplete tail until the next read.

#[derive(Default, Debug)]
pub struct Utf8Decoder {
    carry: Vec<u8>,
}

impl Utf8Decoder {
    /// Decode `bytes` (plus any carried tail). Invalid bytes become U+FFFD; an
    /// incomplete trailing sequence is kept for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut pos = 0usize;
        loop {
            match std::str::from_utf8(&buf[pos..]) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // SAFETY-free: the prefix is valid per `valid_up_to`.
                    out.push_str(std::str::from_utf8(&buf[pos..pos + valid]).unwrap_or(""));
                    pos += valid;
                    match e.error_len() {
                        None => {
                            // Incomplete sequence at the end: carry it over.
                            self.carry = buf[pos..].to_vec();
                            break;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            pos += bad;
                        }
                    }
                }
            }
        }
        out
    }

    /// Emit whatever is still buffered (lossy). Call at EOF.
    pub fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        let s = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_korean_across_reads() {
        let bytes = "한글 ok".as_bytes();
        let mut d = Utf8Decoder::default();
        let mut out = String::new();
        // split inside the first (3-byte) char and inside the second
        out.push_str(&d.push(&bytes[..1]));
        out.push_str(&d.push(&bytes[1..4]));
        out.push_str(&d.push(&bytes[4..]));
        out.push_str(&d.flush());
        assert_eq!(out, "한글 ok");
    }

    #[test]
    fn invalid_bytes_become_replacement() {
        let mut d = Utf8Decoder::default();
        let out = d.push(&[b'a', 0xff, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(d.flush().is_empty());
    }

    #[test]
    fn flush_emits_incomplete_tail() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(&[0xed, 0x95]), "");
        assert_eq!(d.flush(), "\u{FFFD}");
    }
}
