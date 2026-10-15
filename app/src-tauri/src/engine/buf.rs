//! RGBA byte buffer with wrap-aware sampling helpers.

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Buf {
    pub w: usize,
    pub h: usize,
    /// Straight (non-premultiplied) RGBA, len = w * h * 4
    pub data: Vec<u8>,
}

impl Buf {
    pub fn new(w: usize, h: usize) -> Self {
        Self { w, h, data: vec![0u8; w * h * 4] }
    }

    pub fn filled(w: usize, h: usize, px: [u8; 4]) -> Self {
        let mut d = vec![0u8; w * h * 4];
        for c in d.chunks_exact_mut(4) {
            c.copy_from_slice(&px);
        }
        Self { w, h, data: d }
    }

    pub fn idx(&self, x: isize, y: isize) -> usize {
        let wx = x.rem_euclid(self.w as isize) as usize;
        let wy = if y < 0 { 0 } else if y >= self.h as isize { self.h - 1 } else { y as usize };
        (wy * self.w + wx) * 4
    }

    /// Row slice (mutable) for parallel iteration.
    pub fn rows_mut(&mut self) -> impl Iterator<Item = &mut [u8]> {
        self.data.chunks_mut(self.w * 4)
    }
}

/// Neutral flow value: no movement, fully mobile.
pub const NEUTRAL: [u8; 4] = [128, 128, 255, 255];

#[inline]
pub fn wrap_i(v: isize, n: usize) -> usize {
    v.rem_euclid(n as isize) as usize
}
