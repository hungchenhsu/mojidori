//! Test-only paths isolated across processes and repeated fixture names.
//! Callers own creation and cleanup so missing-path and permission-error
//! fixtures retain their original semantics. No runtime code uses this.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path(name: &str) -> PathBuf {
    let sequence = NEXT_PATH.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{}-{sequence}-{name}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn parallel_same_named_fixtures_keep_their_own_bytes() {
        let barrier = Barrier::new(8);
        std::thread::scope(|scope| {
            for value in 0..8u8 {
                let barrier = &barrier;
                scope.spawn(move || {
                    let path = temp_path("mojidori-isolation.bin");
                    std::fs::write(&path, [value]).unwrap();
                    barrier.wait();
                    let bytes = std::fs::read(&path).unwrap();
                    std::fs::remove_file(&path).unwrap();
                    assert_eq!(bytes, [value]);
                });
            }
        });
    }
}
