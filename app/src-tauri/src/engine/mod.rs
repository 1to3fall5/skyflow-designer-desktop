pub mod buf;
pub mod io;
pub mod ops;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use buf::{wrap_i, Buf};
use ops::{apply_disturbance, blur, flood_fill, generate_wind, obstacle_alpha_plane,
          stamp, StampStyle, Projection};

pub type Proj = Projection;

// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub enum LayerKind {
    Paint,
    Wind,
    Obstacle,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LayerParams {
    pub id: String,
    pub name: String,
    pub kind: LayerKind,
    pub visible: bool,
    pub opacity: f32,
    pub blur: f32,
    // wind
    pub direction: f32,
    pub strength: f32,
    // obstacle
    pub disturbance_enabled: bool,
    pub disturbance: f32,
    pub has_mask: bool,
}

pub struct LayerData {
    pub p: LayerParams,
    /// paint content, or cached generated wind field
    pub buf: Buf,
    pub mask: Option<Buf>,
    pub wind_dirty: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LayerSnapshot {
    pub p: LayerParams,
    pub buf: Vec<u8>,
    pub mask: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------

pub struct Engine {
    pub size: usize,
    pub layers: Vec<LayerData>,
    pub active: String,
    pub reference: Option<Buf>,
    pub composite: Buf,
    pub prev_composite: Buf,
    scratch: Buf,
    pub     projection: Projection,
    pub polar_angle: f32,
    pub full_dirty: bool,
    history: Vec<Vec<LayerSnapshot>>,
    hist_idx: usize,
    id_counter: u64,
    /// Per-pixel deposit weight for the stroke in progress. See `ops::stamp`.
    /// Only meaningful while painting a flow layer; `None` clears it.
    stroke_accum: Vec<u8>,
    /// Which (layer, stroke) `stroke_accum` belongs to. `None` means stale.
    stroke_key: Option<(String, u64)>,
}

impl Engine {
    pub fn new(size: usize) -> Self {
        let paint = LayerData {
            p: LayerParams {
                id: "layer-1".into(),
                name: "流向 1".into(),
                kind: LayerKind::Paint,
                visible: true,
                opacity: 1.0,
                blur: 0.0,
                direction: 0.0,
                strength: 0.0,
                disturbance_enabled: false,
                disturbance: 0.0,
                has_mask: false,
            },
            buf: Buf::new(size, size),
            mask: None,
            wind_dirty: false,
        };
        let wind = LayerData {
            p: LayerParams {
                id: "wind-default".into(),
                name: "全局风向".into(),
                kind: LayerKind::Wind,
                visible: true,
                opacity: 1.0,
                blur: 0.0,
                direction: 45.0,
                strength: 0.5,
                disturbance_enabled: false,
                disturbance: 0.0,
                has_mask: false,
            },
            buf: Buf::new(size, size),
            mask: None,
            wind_dirty: true,
        };
        Self {
            size,
            layers: vec![wind, paint],
            active: "layer-1".into(),
            reference: None,
            composite: Buf::filled(size, size, buf::NEUTRAL),
            prev_composite: Buf::filled(size, size, buf::NEUTRAL),
            scratch: Buf::filled(size, size, buf::NEUTRAL),
            projection: Projection::Equirectangular,
            polar_angle: 90.0,
            full_dirty: true,
            history: Vec::new(),
            hist_idx: 0,
            id_counter: 1,
            stroke_accum: Vec::new(),
            stroke_key: None,
        }
    }

    /// Drop the per-stroke deposit record. Anything that rewrites layer pixels
    /// outside of `stroke` has to call this: the accumulator is a delta against
    /// pixels that no longer exist, so keeping it would make the next stroke
    /// deposit too little.
    fn invalidate_accum(&mut self) {
        self.stroke_key = None;
    }

    pub fn resize(&mut self, size: usize) {
        if size == self.size {
            return;
        }
        let old = self.size;
        self.size = size;
        for l in self.layers.iter_mut() {
            l.buf = ops::upscale(&l.buf, size, size);
            if let Some(m) = l.mask.take() {
                l.mask = Some(ops::upscale(&m, size, size));
            }
            l.wind_dirty = true;
        }
        if let Some(r) = self.reference.take() {
            self.reference = Some(ops::upscale(&r, size, size));
        }
        self.composite = Buf::filled(size, size, buf::NEUTRAL);
        self.prev_composite = Buf::filled(size, size, buf::NEUTRAL);
        self.scratch = Buf::filled(size, size, buf::NEUTRAL);
        self.history.clear();
        self.hist_idx = 0;
        self.full_dirty = true;
        self.stroke_accum.clear();
        self.invalidate_accum();
        let _ = old;
    }

    pub fn layer_mut(&mut self, id: &str) -> Option<&mut LayerData> {
        self.layers.iter_mut().find(|l| l.p.id == id)
    }

    pub fn layer(&self, id: &str) -> Option<&LayerData> {
        self.layers.iter().find(|l| l.p.id == id)
    }

    // -- layer management ----------------------------------------------------

    pub fn add_layer(&mut self, kind: LayerKind) -> String {
        self.id_counter += 1;
        let id = format!("{}-{}", kind_name(&kind), self.id_counter);
        let count = self.layers.iter().filter(|l| l.p.kind == kind).count();
        let name = match kind {
            LayerKind::Paint => format!("流向 {}", count + 1),
            LayerKind::Wind => "风向".to_string(),
            LayerKind::Obstacle => "障碍物".to_string(),
        };
        let p = LayerParams {
            id: id.clone(),
            name,
            kind: kind.clone(),
            visible: true,
            opacity: 1.0,
            blur: 0.0,
            direction: 45.0,
            strength: 0.5,
            disturbance_enabled: true,
            disturbance: 0.5,
            has_mask: false,
        };
        self.layers.push(LayerData { p, buf: Buf::new(self.size, self.size), mask: None, wind_dirty: true });
        self.active = id.clone();
        self.full_dirty = true;
        id
    }

    pub fn remove_layer(&mut self, id: &str) -> bool {
        if self.layers.len() <= 1 {
            return false;
        }
        if let Some(i) = self.layers.iter().position(|l| l.p.id == id) {
            self.layers.remove(i);
            if self.active == id {
                self.active = self.layers[self.layers.len() - 1].p.id.clone();
            }
            self.full_dirty = true;
            true
        } else {
            false
        }
    }

    /// Move a layer in the visual (top-first) ordering. `from`/`to` are indices
    /// in the reversed list, matching the UI.
    pub fn reorder_visual(&mut self, from: usize, to: usize) {
        let n = self.layers.len();
        if from >= n || to >= n {
            return;
        }
        let a = n - 1 - from;
        let b = n - 1 - to;
        let l = self.layers.remove(a);
        self.layers.insert(b, l);
        self.full_dirty = true;
    }

    // -- painting ------------------------------------------------------------

    /// Apply a polyline of UV points to the active layer. Returns the dirty
    /// bounding box in pixels.
    ///
    /// `stroke_id` identifies the pointer stroke these points belong to. The
    /// frontend sends one batch per animation frame, so without it there is no
    /// way to tell "more of the same drag" from "a second pass over the same
    /// spot" — and that distinction is exactly what makes low-strength brushes
    /// build up. It only has to change when a new stroke starts.
    pub fn stroke(
        &mut self,
        pts: &[(f32, f32)],
        size: f32,
        hardness: f32,
        strength: f32,
        erase: bool,
        target: &str,
        stroke_id: u64,
        flow: f32,
    ) -> Option<(usize, usize, usize, usize)> {
        let active_id = self.active.clone();
        let layer = self.layer(&active_id)?;
        let is_adj = matches!(layer.p.kind, LayerKind::Wind | LayerKind::Obstacle);
        // Adjustment layers have no paintable content — their pixels are
        // generated from parameters. Painting one always edits its mask, so the
        // brush can never silently do nothing because of a UI mode.
        let _ = target;

        // flow colour is derived per-segment from the drag direction
        let mut out: Option<(usize, usize, usize, usize)> = None;

        let n = self.size;

        // Deposit bookkeeping for the current stroke. Only flow layers build
        // up; a mask's alpha is its payload and has nothing to accumulate
        // towards.
        //
        // Moved out of `self` for the duration of the loop — the layer buffer
        // below is borrowed from `self` too, and they are different fields.
        let key = Some((active_id.clone(), stroke_id));
        let mut accum_opt: Option<Vec<u8>> = if is_adj {
            None
        } else {
            let mut a = std::mem::take(&mut self.stroke_accum);
            if a.len() != n * n {
                a = vec![0u8; n * n];
                self.stroke_key = None;
            }
            if self.stroke_key.as_ref() != key.as_ref() {
                a.fill(0);
                self.stroke_key = key;
            }
            Some(a)
        };

        {
            let layer = self.layer_mut(&active_id).unwrap();
            let dst: &mut Buf = if is_adj {
                if layer.mask.is_none() {
                    // Starts EMPTY (alpha 0). A mask that began fully opaque
                    // would mark the entire sky as obstacle on the first dab.
                    layer.mask = Some(Buf::new(n, n));
                    layer.p.has_mask = true;
                }
                layer.mask.as_mut().unwrap()
            } else {
                &mut layer.buf
            };

            let is_mask = is_adj;
            let mut prev: Option<(f32, f32)> = None;
            let last = pts.len().saturating_sub(1);
            for (i, &(u, v)) in pts.iter().enumerate() {
                let (x, y) = (u * n as f32, v * n as f32);
                // Capsule start. With no previous sample this collapses to the
                // point itself, i.e. a round dab.
                let (lx, ly) = match prev {
                    Some((lu, lv)) => (lu * n as f32, lv * n as f32),
                    None => (x, y),
                };
                // Direction of travel, used for the flow colour. The first
                // sample has no incoming segment, so look *ahead* along the
                // polyline.
                //
                // This used to be faked as a 0.01px horizontal offset, which
                // meant the first sample of every batch stamped a dot pointing
                // hard right. Because the frontend sends `[lastPoint, ...new]`
                // once per animation frame, that was one saturated blue speck
                // per frame, all the way along the stroke.
                let (dx, dy) = match prev {
                    Some(_) => (x - lx, y - ly),
                    None if i < last => {
                        let (nu, nv) = pts[i + 1];
                        ((nu - u) * n as f32, (nv - v) * n as f32)
                    }
                    None => (0.0, 0.0),
                };
                let d = (dx * dx + dy * dy).sqrt();
                // Below half a pixel there is no direction to speak of.
                //
                // For a paint layer that means there is nothing to draw — a
                // click with no drag is a no-op, exactly as the original web app
                // behaved (its stamp early-returned under 0.5px). Inventing a
                // direction here is what produced the speckle bug in the first
                // place. Nothing is lost when dragging: the next batch re-sends
                // this sample as its first element and paints the real segment.
                //
                // A mask has no direction to begin with, so a click on an
                // adjustment layer is a meaningful dab and must land.
                if d < 0.5 && !is_mask {
                    prev = Some((u, v));
                    continue;
                }
                let st = if is_mask {
                    StampStyle { r: 255, g: 255, b: 255, erase, opaque: true, flow: 1.0 }
                } else {
                    let vx = dx / d;
                    let vy = dy / d;
                    // `strength` is the *ceiling*, not the rate — it is the
                    // length of the flow vector you are aiming at, the same job
                    // the foreground colour does in Photoshop. `flow` is how
                    // quickly repeated strokes get there.
                    //
                    // Strength used to be the rate with the ceiling pinned at
                    // full, which meant a weak brush crept up to full strength
                    // if you kept painting — wrong for a vector field, where
                    // "this area flows gently" is a thing you mean.
                    let range = 127.0 * strength;
                    StampStyle {
                        r: (128.0 - vx * range).clamp(0.0, 255.0) as u8,
                        g: (128.0 + vy * range).clamp(0.0, 255.0) as u8,
                        b: 255,
                        erase,
                        opaque: false,
                        flow,
                    }
                };
                let r = self::stamp_wrap(dst, x, y, lx, ly, size, hardness, &st, accum_opt.as_deref_mut());
                out = merge_rect(out, r);
                prev = Some((u, v));
            }
        }
        if let Some(a) = accum_opt {
            self.stroke_accum = a;
        }
        Some(out.unwrap_or((0, 0, 0, 0)))
    }

    /// Eyedropper: the flow strength under a UV point, on the active layer or
    /// on the composite, averaged over a 3x3 patch.
    ///
    /// Averaging matters because the field is 8-bit — a single pixel quantises
    /// to a jittery value, and the slider would land on something the user did
    /// not draw.
    ///
    /// A mask (wind / obstacle) has no flow strength to speak of, so sampling
    /// "the current layer" there falls back to the composite rather than
    /// reporting the mask's opaque white as a full-strength flow.
    pub fn sample_strength(&self, u: f32, v: f32, source: &str) -> f32 {
        let n = self.size;
        let layer_buf: Option<&Buf> = if source == "composite" {
            None
        } else {
            match self.layer(&self.active) {
                Some(l) if !matches!(l.p.kind, LayerKind::Wind | LayerKind::Obstacle) => Some(&l.buf),
                _ => None,
            }
        };
        let src: &Buf = layer_buf.unwrap_or(&self.composite);

        let cx = (u * n as f32).floor() as i32;
        let cy = (v * n as f32).floor() as i32;
        let mut sr = 0.0f32;
        let mut sg = 0.0f32;
        let mut count = 0usize;
        for dy in -1..=1i32 {
            let y = (cy + dy).clamp(0, n as i32 - 1) as usize;
            for dx in -1..=1i32 {
                let x = wrap_i((cx + dx) as isize, n);
                let i = (y * n + x) * 4;
                sr += src.data[i] as f32;
                sg += src.data[i + 1] as f32;
                count += 1;
            }
        }
        let vx = (128.0 - sr / count as f32) / 127.0;
        let vy = (sg / count as f32 - 128.0) / 127.0;
        (vx * vx + vy * vy).sqrt().clamp(0.0, 1.0)
    }

    pub fn flood_fill_active(&mut self, u: f32, v: f32, threshold: f32, target: &str) -> bool {
        let reference = match &self.reference {
            Some(r) => r.clone(),
            None => return false,
        };
        let active_id = self.active.clone();
        let layer = match self.layer(&active_id) {
            Some(l) => l,
            None => return false,
        };
        let is_adj = matches!(layer.p.kind, LayerKind::Wind | LayerKind::Obstacle);
        // Same rule as `stroke`: on an adjustment layer the wand edits the mask.
        let is_mask = is_adj;
        let _ = target;

        let n = self.size;
        let sx = (u * n as f32).clamp(0.0, n as f32 - 1.0) as usize;
        let sy = (v * n as f32).clamp(0.0, n as f32 - 1.0) as usize;
        let fill: [u8; 3] = if is_mask { [255, 255, 255] } else { [128, 128, 255] };
        let wrap = matches!(self.projection, Projection::Equirectangular | Projection::Polar);

        let layer = self.layer_mut(&active_id).unwrap();
        let dst: &mut Buf = if is_mask {
            if layer.mask.is_none() {
                layer.mask = Some(Buf::new(n, n));
                layer.p.has_mask = true;
            }
            layer.mask.as_mut().unwrap()
        } else {
            &mut layer.buf
        };
        flood_fill(dst, &reference, sx, sy, threshold, fill, wrap);
        self.invalidate_accum();
        true
    }

    pub fn clear_layer(&mut self, id: &str) {
        let n = self.size;
        if let Some(l) = self.layer_mut(id) {
            l.buf = Buf::new(n, n);
            if l.mask.is_some() {
                // Clearing a mask removes the obstacle, not adds it.
                l.mask = Some(Buf::new(n, n));
            }
            l.wind_dirty = true;
        }
        self.full_dirty = true;
        self.invalidate_accum();
    }

    // -- history -------------------------------------------------------------

    pub fn save_history(&mut self) {
        let id = self.active.clone();
        let snap = match self.layer(&id) {
            Some(l) => vec![LayerSnapshot {
                p: l.p.clone(),
                buf: compress(&l.buf.data),
                mask: l.mask.as_ref().map(|m| compress(&m.data)),
            }],
            None => return,
        };
        self.history.truncate(self.hist_idx);
        self.history.push(snap);
        self.hist_idx = self.history.len();
        if self.history.len() > 40 {
            self.history.remove(0);
            self.hist_idx -= 1;
        }
    }

    fn restore(&mut self, idx: usize) {
        self.invalidate_accum();
        let snap = match self.history.get(idx) {
            Some(s) => s.clone(),
            None => return,
        };
        let expect = self.size * self.size * 4;
        let n = self.size;
        for s in snap {
            if let Some(l) = self.layer_mut(&s.p.id) {
                l.p = s.p.clone();
                l.buf.data = decompress(&s.buf, expect);
                l.mask = s.mask.map(|m| Buf { w: n, h: n, data: decompress(&m, expect) });
                l.wind_dirty = true;
            }
        }
        self.full_dirty = true;
    }

    pub fn undo(&mut self) -> bool {
        if self.hist_idx > 1 {
            self.hist_idx -= 1;
            let i = self.hist_idx - 1;
            self.restore(i);
            true
        } else {
            false
        }
    }

    pub fn redo(&mut self) -> bool {
        if self.hist_idx < self.history.len() {
            self.hist_idx += 1;
            let i = self.hist_idx - 1;
            self.restore(i);
            true
        } else {
            false
        }
    }

    // -- compositing ---------------------------------------------------------

    pub fn composite(&mut self) {
        let n = self.size;
        self.prev_composite.data.copy_from_slice(&self.composite.data);
        // Reuse the scratch allocation so a composite never allocates.
        let mut acc = std::mem::replace(&mut self.scratch, Buf::new(0, 0));
        acc.w = n;
        acc.h = n;
        acc.data.resize(n * n * 4, 0);
        acc.data.par_chunks_mut(4).for_each(|c| c.copy_from_slice(&buf::NEUTRAL));
        let proj = self.projection;
        let polar = self.polar_angle;

        // Wind fields are deterministic; regenerate only when params changed.
        for l in self.layers.iter_mut() {
            if l.p.kind == LayerKind::Wind && l.wind_dirty {
                generate_wind(&mut l.buf, l.p.direction, l.p.strength, proj, polar);
                l.wind_dirty = false;
            }
        }

        // Layers composite in array order, so the last one sits on top — the
        // same reading as the layer list, whose first row is the top layer.
        for i in 0..self.layers.len() {
            let l = &self.layers[i];
            if !l.p.visible {
                continue;
            }
            let op = l.p.opacity;
            match l.p.kind {
                LayerKind::Paint => {
                    let src = if l.p.blur > 0.0 {
                        blur(&l.buf, l.p.blur)
                    } else {
                        l.buf.clone()
                    };
                    blend_over(&mut acc, &src, op);
                }
                LayerKind::Wind => {
                    let wind = l.buf.clone();
                    if let Some(mask) = &l.mask {
                        let mut helper = wind;
                        mask_in(&mut helper, mask);
                        blend_over(&mut acc, &helper, op);
                    } else {
                        blend_over(&mut acc, &wind, op);
                    }
                }
                LayerKind::Obstacle => {
                    if let Some(mask) = &l.mask {
                        if l.p.disturbance_enabled && l.p.disturbance > 0.0 {
                            let (plane, lw, lh, ss) = obstacle_alpha_plane(mask, l.p.disturbance);
                            apply_disturbance(&mut acc, &plane, lw, lh, ss);
                        }
                        let mut helper = Buf::filled(n, n, buf::NEUTRAL);
                        mask_in(&mut helper, mask);
                        blend_over(&mut acc, &helper, op);
                        // B channel: 255 - obstacle alpha.
                        //
                        // Written *here*, in stack order, rather than in a
                        // second pass after the loop. Doing it afterwards made
                        // the obstacle unconditional: however much flow you
                        // painted on layers above it, the pixel stayed flagged
                        // as an obstacle. Writing it in place means a layer
                        // stacked on top covers it again, exactly like any
                        // other channel.
                        acc.data.par_chunks_mut(4).zip(mask.data.par_chunks(4)).for_each(|(d, s)| {
                            let a = (s[3] as f32 * op) as i32;
                            if a > 0 {
                                d[2] = (255 - a.min(255)) as u8;
                            }
                        });
                    }
                }
            }
        }

        std::mem::swap(&mut acc, &mut self.composite);
        self.scratch = acc;
    }

    /// Compute the bounding box that changed between the last two composites.
    pub fn dirty_rect(&self) -> (usize, usize, usize, usize) {
        if self.full_dirty {
            return (0, 0, self.size, self.size);
        }
        let n = self.size;
        let a = &self.prev_composite.data;
        let b = &self.composite.data;
        let stride = n * 4;
        let rows: Vec<bool> = (0..n)
            .into_par_iter()
            .map(|y| a[y * stride..(y + 1) * stride] != b[y * stride..(y + 1) * stride])
            .collect();
        let y0 = match rows.iter().position(|&v| v) {
            Some(i) => i,
            None => return (0, 0, 0, 0),
        };
        let y1 = rows.iter().rposition(|&v| v).unwrap();
        let (x0, x1) = (0..n)
            .into_par_iter()
            .filter_map(|x| {
                let mut hit = false;
                for y in y0..=y1 {
                    let i = y * stride + x * 4;
                    if a[i..i + 4] != b[i..i + 4] {
                        hit = true;
                        break;
                    }
                }
                if hit { Some(x) } else { None }
            })
            .fold(|| (usize::MAX, 0usize), |acc, x| (acc.0.min(x), acc.1.max(x)))
            .reduce(|| (usize::MAX, 0usize), |p, q| (p.0.min(q.0), p.1.max(q.1)));
        if x0 == usize::MAX {
            return (0, 0, 0, 0);
        }
        (x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }

    pub fn clear_dirty(&mut self) {
        self.full_dirty = false;
        self.prev_composite.data.copy_from_slice(&self.composite.data);
    }
}

// ---------------------------------------------------------------------------

fn kind_name(k: &LayerKind) -> &'static str {
    match k {
        LayerKind::Paint => "paint",
        LayerKind::Wind => "wind",
        LayerKind::Obstacle => "obstacle",
    }
}

fn merge_rect(
    a: Option<(usize, usize, usize, usize)>,
    b: (usize, usize, usize, usize),
) -> Option<(usize, usize, usize, usize)> {
    if b.2 == 0 || b.3 == 0 {
        return a;
    }
    Some(match a {
        None => b,
        Some((ax, ay, aw, ah)) => {
            let x0 = ax.min(b.0);
            let y0 = ay.min(b.1);
            let x1 = (ax + aw).max(b.0 + b.2);
            let y1 = (ay + ah).max(b.1 + b.3);
            (x0, y0, x1 - x0, y1 - y0)
        }
    })
}

/// Stamp with horizontal wrap-around so equirect seams stay continuous.
fn stamp_wrap(
    dst: &mut Buf,
    x: f32, y: f32, lx: f32, ly: f32,
    size: f32, hardness: f32, style: &StampStyle,
    mut accum: Option<&mut [u8]>,
) -> (usize, usize, usize, usize) {
    let n = dst.w as f32;
    let dx = x - lx;
    if dx.abs() > n * 0.5 {
        if dx > 0.0 {
            let a = stamp(dst, x - n, y, lx, ly, size, hardness, style, accum.as_deref_mut());
            let b = stamp(dst, x, y, lx + n, ly, size, hardness, style, accum.as_deref_mut());
            merge_rect(Some(a), b).unwrap()
        } else {
            let a = stamp(dst, x + n, y, lx, ly, size, hardness, style, accum.as_deref_mut());
            let b = stamp(dst, x, y, lx - n, ly, size, hardness, style, accum.as_deref_mut());
            merge_rect(Some(a), b).unwrap()
        }
    } else {
        let r = stamp(dst, x, y, lx, ly, size, hardness, style, accum.as_deref_mut());
        let radius = size / 2.0;
        let mut out = r;
        if x < radius || lx < radius {
            let e = stamp(dst, x + n, y, lx + n, ly, size, hardness, style, accum.as_deref_mut());
            out = merge_rect(Some(out), e).unwrap_or(out);
        }
        if x > n - radius || lx > n - radius {
            let e = stamp(dst, x - n, y, lx - n, ly, size, hardness, style, accum.as_deref_mut());
            out = merge_rect(Some(out), e).unwrap_or(out);
        }
        out
    }
}

/// source-over with a global alpha multiplier
fn blend_over(dst: &mut Buf, src: &Buf, opacity: f32) {
    dst.data.par_chunks_mut(4).zip(src.data.par_chunks(4)).for_each(|(d, s)| {
        let sa = s[3] as f32 / 255.0 * opacity;
        if sa <= 0.0 {
            return;
        }
        let inv = 1.0 - sa;
        d[0] = (s[0] as f32 * sa + d[0] as f32 * inv) as u8;
        d[1] = (s[1] as f32 * sa + d[1] as f32 * inv) as u8;
        d[2] = (s[2] as f32 * sa + d[2] as f32 * inv) as u8;
        d[3] = (sa * 255.0 + d[3] as f32 * inv).min(255.0) as u8;
    });
}

/// destination-in: keep src RGB but multiply alpha by the mask
fn mask_in(dst: &mut Buf, mask: &Buf) {
    dst.data.par_chunks_mut(4).zip(mask.data.par_chunks(4)).for_each(|(d, m)| {
        d[3] = ((d[3] as f32) * (m[3] as f32 / 255.0)) as u8;
    });
}

fn compress(data: &[u8]) -> Vec<u8> {
    zstd::stream::encode_all(data, 1).unwrap_or_else(|_| data.to_vec())
}

fn decompress(data: &[u8], expect: usize) -> Vec<u8> {
    match zstd::stream::decode_all(data) {
        Ok(v) if v.len() == expect => v,
        _ => vec![0u8; expect],
    }
}
