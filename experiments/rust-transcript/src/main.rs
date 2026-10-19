//! Experimental read-only helper. fd 3 is opened and validated by the Node caller.
//! Frames are LE u64 byte offset, LE u32 payload length, then original UTF-8 bytes.
use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::FromRawFd;

const RECORD_LIMIT: usize = 64 * 1024 * 1024;

fn frame(out: &mut impl Write, offset: u64, parts: &[&[u8]], bytes: usize) -> io::Result<()> {
    if bytes > RECORD_LIMIT {
        return Err(io::Error::other("record exceeds 64 MiB"));
    }
    out.write_all(&offset.to_le_bytes())?;
    out.write_all(&(bytes as u32).to_le_bytes())?;
    for part in parts {
        out.write_all(part)?;
    }
    Ok(())
}

fn reverse(file: &mut File, mut position: u64, out: &mut impl Write) -> io::Result<()> {
    let mut pending: Vec<Vec<u8>> = Vec::new();
    let mut pending_bytes = 0;
    while position > 0 {
        let size = position.min(64 * 1024) as usize;
        position -= size as u64;
        let mut chunk = vec![0; size];
        file.seek(SeekFrom::Start(position))?;
        file.read_exact(&mut chunk)?;
        let mut right = size;
        let mut cursor = size;
        while cursor > 0 {
            cursor -= 1;
            if chunk[cursor] != b'\n' {
                continue;
            }
            let part = &chunk[cursor + 1..right];
            let bytes = part.len() + pending_bytes;
            if bytes > 0 {
                let mut parts = vec![part];
                parts.extend(pending.iter().rev().map(|part| part.as_slice()));
                frame(out, position + cursor as u64 + 1, &parts, bytes)?;
            } else {
                while cursor > 0 && chunk[cursor - 1] == b'\n' {
                    cursor -= 1;
                }
                let offset = if position == 0 && cursor == 0 {
                    0
                } else {
                    position + cursor as u64 + 1
                };
                frame(out, offset, &[], 0)?;
            }
            pending.clear();
            pending_bytes = 0;
            right = cursor;
        }
        if right > 0 {
            pending.push(chunk[..right].to_vec());
            pending_bytes += right;
        }
        if pending_bytes > RECORD_LIMIT {
            return Err(io::Error::other("record exceeds 64 MiB"));
        }
    }
    if pending_bytes > 0 {
        let parts: Vec<_> = pending.iter().rev().map(|part| part.as_slice()).collect();
        frame(out, 0, &parts, pending_bytes)?;
    }
    out.flush()
}

#[cfg(unix)]
fn main() -> io::Result<()> {
    let end: u64 = std::env::args()
        .nth(1)
        .ok_or_else(|| io::Error::other("missing end offset"))?
        .parse()
        .map_err(io::Error::other)?;
    // SAFETY: the parent exclusively assigns a duplicated read-only file handle to fd 3.
    let mut file = unsafe { File::from_raw_fd(3) };
    if end > file.metadata()?.len() {
        return Err(io::Error::other("file shrank"));
    }
    reverse(&mut file, end, &mut BufWriter::new(io::stdout().lock()))
}

#[cfg(not(unix))]
fn main() {
    eprintln!("This measurement prototype requires Unix fd passing");
    std::process::exit(1);
}
