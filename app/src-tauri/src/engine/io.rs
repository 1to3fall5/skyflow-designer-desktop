use std::io::Cursor;

use image::ImageFormat;
use serde::{Deserialize, Serialize};

use super::buf::Buf;
use super::effect::LayerEffect;
use super::ops::upscale;
use super::{Engine, LayerKind, LayerSnapshot};
use super::path::PathData;

const MAGIC: &[u8; 6] = b"SKYFLW";
/// v2 replaced a layer's bare `blur` radius with a list of effects.
/// v3 moved an obstacle layer's `disturbance` fields into that same list.
const FORMAT_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// Reference image
// ---------------------------------------------------------------------------

pub fn load_reference(path: &str, size: usize) -> Result<Buf, String> {
    decode_image(path, size)
}

/// Decode any image the app can open, resized to the canvas.
///
/// TGA is not covered by the `image` crate's default codecs; `load_tga` handles
/// the variants that matter.
fn decode_image(path: &str, size: usize) -> Result<Buf, String> {
    if path.to_lowercase().ends_with(".tga") {
        return load_tga(path, size);
    }
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("打开图片失败: {e}"))?
        .decode()
        .map_err(|e| format!("解码图片失败: {e}"))?;
    let rgba = img.resize_exact(size as u32, size as u32, image::imageops::FilterType::Triangle);
    Ok(Buf { w: size, h: size, data: rgba.into_rgba8().into_raw() })
}

/// Decode one TGA pixel at `pos`. Returns None on truncation or bad depth.
fn decode_tga_px(raw: &[u8], pos: usize, depth: u8) -> Option<[u8; 4]> {
    match depth {
        32 => {
            if pos + 4 > raw.len() { return None; }
            Some([raw[pos + 2], raw[pos + 1], raw[pos], raw[pos + 3]])
        }
        24 => {
            if pos + 3 > raw.len() { return None; }
            Some([raw[pos + 2], raw[pos + 1], raw[pos], 255])
        }
        15 | 16 => {
            // 5-5-5 (top bit is alpha or unused)
            if pos + 2 > raw.len() { return None; }
            let v = u16::from_le_bytes([raw[pos], raw[pos + 1]]);
            Some([
                (((v >> 10) & 0x1f) as u8) << 3,
                (((v >> 5) & 0x1f) as u8) << 3,
                ((v & 0x1f) as u8) << 3,
                255,
            ])
        }
        _ => None,
    }
}

fn load_tga(path: &str, size: usize) -> Result<Buf, String> {
    let raw = std::fs::read(path).map_err(|e| format!("读取 TGA 失败: {e}"))?;
    if raw.len() < 18 {
        return Err("TGA 文件过短".into());
    }
    let id_len = raw[0] as usize;
    let img_type = raw[2];
    let w = u16::from_le_bytes([raw[12], raw[13]]) as usize;
    let h = u16::from_le_bytes([raw[14], raw[15]]) as usize;
    let depth = raw[16];
    let desc = raw[17];

    if w == 0 || h == 0 {
        return Err("TGA 尺寸无效".into());
    }
    if img_type != 2 && img_type != 10 {
        return Err(format!("不支持的 TGA 类型: {img_type}（仅支持无压缩/RLE 真彩色）"));
    }
    if !matches!(depth, 15 | 16 | 24 | 32) {
        return Err(format!("不支持的 TGA 位深: {depth}"));
    }

    let bpp = if depth == 32 { 4 } else if depth == 24 { 3 } else { 2 };
    let start = 18 + id_len;
    if start > raw.len() {
        return Err("TGA 数据不完整".into());
    }

    // RLE payload is (by design) often far shorter than w*h*bpp, so the
    // completeness check only applies to uncompressed images.
    let px_count = w * h;
    if img_type == 2 && raw.len() < start + px_count * bpp {
        return Err(format!("TGA 数据不完整（需要 {} 字节，实际 {}）", px_count * bpp, raw.len() - start));
    }

    let top_left = desc & 0x20 != 0;
    let mut src = vec![0u8; px_count * 4];

    let mut write_px = |idx: usize, px: [u8; 4]| {
        // idx is in stored-row order; flip to top-down logical order.
        let row = idx / w;
        let col = idx % w;
        let ly = if top_left { row } else { h - 1 - row };
        let di = (ly * w + col) * 4;
        src[di] = px[0];
        src[di + 1] = px[1];
        src[di + 2] = px[2];
        src[di + 3] = px[3];
    };

    if img_type == 2 {
        for i in 0..px_count {
            let px = decode_tga_px(&raw, start + i * bpp, depth)
                .ok_or_else(|| "TGA 数据截断".to_string())?;
            write_px(i, px);
        }
    } else {
        let mut pos = start;
        let mut idx = 0usize;
        while idx < px_count {
            if pos >= raw.len() {
                return Err("TGA RLE 数据截断".into());
            }
            let hdr = raw[pos];
            pos += 1;
            let count = (hdr & 0x7f) as usize + 1;
            if hdr & 0x80 != 0 {
                let px = decode_tga_px(&raw, pos, depth)
                    .ok_or_else(|| "TGA RLE 数据截断".to_string())?;
                pos += bpp;
                for _ in 0..count {
                    if idx >= px_count { break; }
                    write_px(idx, px);
                    idx += 1;
                }
            } else {
                for _ in 0..count {
                    if idx >= px_count { break; }
                    let px = decode_tga_px(&raw, pos, depth)
                        .ok_or_else(|| "TGA RLE 数据截断".to_string())?;
                    pos += bpp;
                    write_px(idx, px);
                    idx += 1;
                }
            }
        }
    }

    let src_buf = Buf { w, h, data: src };
    if w == size && h == size {
        Ok(src_buf)
    } else {
        Ok(upscale(&src_buf, size, size))
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Encode a buffer as PNG bytes.
///
/// This is the bridge between the engine and the WebView: the WebView has no
/// TGA decoder, so any image that has to be *displayed* is re-encoded here.
pub fn encode_png_bytes(buf: &Buf) -> Option<Vec<u8>> {
    // Cap the display copy: it is an overlay, so 4K source pixels are wasted
    // bytes over the IPC bridge.
    const MAX_DISPLAY: usize = 2048;
    let src = if buf.w > MAX_DISPLAY {
        upscale(buf, MAX_DISPLAY, MAX_DISPLAY)
    } else {
        buf.clone()
    };
    let img = image::RgbaImage::from_raw(src.w as u32, src.h as u32, src.data)?;
    let mut cur = Cursor::new(Vec::new());
    img.write_to(&mut cur, ImageFormat::Png).ok()?;
    Some(cur.into_inner())
}

pub fn export_png(buf: &Buf, invert_x: bool, invert_y: bool, path: &str) -> Result<(), String> {
    let mut data = buf.data.clone();
    if invert_x || invert_y {
        data.chunks_exact_mut(4).for_each(|c| {
            if invert_x { c[0] = 255 - c[0]; }
            if invert_y { c[1] = 255 - c[1]; }
            c[3] = 255;
        });
    }
    let img = image::RgbaImage::from_raw(buf.w as u32, buf.h as u32, data)
        .ok_or("无效图像数据")?;
    img.save_with_format(path, ImageFormat::Png)
        .map_err(|e| format!("PNG 保存失败: {e}"))
}

pub fn export_tga(buf: &Buf, invert_x: bool, invert_y: bool, path: &str) -> Result<(), String> {
    let (w, h) = (buf.w, buf.h);
    let mut out = Vec::with_capacity(18 + w * h * 4);
    out.push(0); // id length
    out.push(0); // colour map type
    out.push(2); // uncompressed true-colour
    out.extend_from_slice(&[0, 0, 0, 0, 0]); // colour map spec
    out.extend_from_slice(&[0, 0, 0, 0]); // origin
    out.extend_from_slice(&(w as u16).to_le_bytes());
    out.extend_from_slice(&(h as u16).to_le_bytes());
    out.push(32); // pixel depth
    out.push(0x28); // 8 alpha bits, top-left origin

    let mut row = vec![0u8; w * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            // TGA stores true-colour as **B,G,R,A** and `decode_tga_px` reads it
            // back in that order, so these bytes are blue, green, red.
            //
            // They used to be written green, red, blue. That is not an equally
            // valid convention: decoded again, the horizontal offset came back
            // in G, the vertical one in R and the mobility mask in B, so
            // exporting a TGA and reading it back permuted all three channels.
            row[x * 4] = buf.data[i + 2];
            row[x * 4 + 1] = if invert_y { 255 - buf.data[i + 1] } else { buf.data[i + 1] };
            row[x * 4 + 2] = if invert_x { 255 - buf.data[i] } else { buf.data[i] };
            row[x * 4 + 3] = 255;
        }
        out.extend_from_slice(&row);
    }
    std::fs::write(path, out).map_err(|e| format!("TGA 保存失败: {e}"))
}

pub fn export(
    buf: &Buf,
    path: &str,
    invert_x: bool,
    invert_y: bool,
    target_size: Option<usize>,
) -> Result<(), String> {
    let scaled = match target_size {
        Some(s) if s != buf.w => upscale(buf, s, s),
        _ => buf.clone(),
    };
    if path.to_lowercase().ends_with(".tga") {
        export_tga(&scaled, invert_x, invert_y, path)
    } else {
        export_png(&scaled, invert_x, invert_y, path)
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Read an image file as flowmap pixels: R/G are the offsets, B is mobility,
/// A is coverage.
///
/// The three flags exist because a file that came from somewhere else is not
/// the same shape as one this app wrote, and guessing wrong is silent:
///
/// * **`opaque_if_flat_alpha`** — most flowmaps are stored without an alpha
///   channel, which decodes as zero everywhere. Taken literally that imports a
///   perfectly good layer you cannot see.
/// * **`free_mobility`** — B means *mobility* here and *blue* out there. Leaving
///   whatever the file had in it would paint obstacles the author never drew.
/// * **`split_mobility`** — the one that keeps the information instead of
///   discarding it: the channel becomes a real obstacle layer on top, so it can
///   be erased and retuned. Implies `free_mobility`.
/// * **`invert_x` / `invert_y`** — the same `255 - c` the export applies, so a
///   file written with a flag set and read back with the same one is a round
///   trip. Both are involutions, which is why one flag serves both directions.
/// What one file turned into.
///
/// `obstacle` is `Some` only when the caller asked for the mobility channel to
/// be split out — it is a second layer, not a second field, because that is
/// what makes it editable.
pub struct ImportedPixels {
    /// R/G offsets, A coverage. B is 255 unless the caller asked to keep
    /// whatever the file had.
    pub flow: Buf,
    /// The mobility channel read as an obstacle mask.
    pub obstacle: Option<Buf>,
}

pub fn import_flowmap(
    path: &str,
    size: usize,
    invert_x: bool,
    invert_y: bool,
    opaque_if_flat_alpha: bool,
    free_mobility: bool,
    split_mobility: bool,
) -> Result<ImportedPixels, String> {
    let mut buf = decode_image(path, size)?;

    if opaque_if_flat_alpha {
        let max_a = buf.data.chunks_exact(4).map(|c| c[3]).max().unwrap_or(0);
        // 8 rather than 0: a resized image picks up a little alpha along the
        // edges even when the source had none, and that is not "has an alpha
        // channel".
        if max_a < 8 {
            buf.data.chunks_exact_mut(4).for_each(|c| c[3] = 255);
        }
    }

    // B is mobility, and an obstacle mask is the same fact upside down: the
    // composite writes `B = 255 * (1 - a)` for one obstacle layer at full
    // opacity, so the mask that would have produced this B is `255 - B`.
    //
    // Splitting it out is not just tidier than leaving it in the flow layer —
    // mobility baked into a paint layer's pixels is not editable as an
    // obstacle, which is the one thing you would want to do with it.
    let mut obstacle = None;
    if split_mobility {
        let mut m = Buf::new(buf.w, buf.h);
        for (o, i) in m.data.chunks_exact_mut(4).zip(buf.data.chunks_exact(4)) {
            o[3] = 255 - i[2];
        }
        obstacle = Some(m);
        // The flow layer's own B is free now — the obstacle has its own layer,
        // which is exactly what `free_mobility` means. So splitting implies it.
        buf.data.chunks_exact_mut(4).for_each(|c| c[2] = 255);
    } else if free_mobility {
        buf.data.chunks_exact_mut(4).for_each(|c| c[2] = 255);
    }

    if invert_x || invert_y {
        buf.data.chunks_exact_mut(4).for_each(|c| {
            if invert_x {
                c[0] = 255 - c[0];
            }
            if invert_y {
                c[1] = 255 - c[1];
            }
        });
    }
    Ok(ImportedPixels { flow: buf, obstacle })
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ProjectData {
    version: u32,
    size: usize,
    projection: u8,
    polar_angle: f32,
    active: String,
    layers: Vec<LayerSnapshot>,
    reference: Option<Vec<u8>>,
}

// -- v1 -------------------------------------------------------------------
//
// MessagePack encodes these structs as *arrays*, so a field added anywhere but
// the end shifts every one after it and an old file stops parsing. That is what
// forced the version bump: effects replaced `blur` in the middle of a layer.
//
// Keeping the old shape around costs twenty lines and buys back every project
// saved by 1.0.0 — including the blur radius, which becomes the effect it
// always meant.

#[derive(Deserialize)]
struct ProjectV1 {
    /// v1 wrote its version inside the body as well as in the header, so the
    /// field has to be read even though the header is what we branch on.
    _version: u32,
    size: usize,
    projection: u8,
    polar_angle: f32,
    active: String,
    layers: Vec<LayerSnapshotV1>,
    reference: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct LayerSnapshotV1 {
    p: LayerParamsV1,
    buf: Vec<u8>,
    mask: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct LayerParamsV1 {
    id: String,
    name: String,
    kind: LayerKind,
    visible: bool,
    opacity: f32,
    blur: f32,
    direction: f32,
    strength: f32,
    disturbance_enabled: bool,
    disturbance: f32,
    has_mask: bool,
}

impl ProjectV1 {
    /// v1 -> v2. The bare blur radius becomes the effect it always meant.
    /// The disturbance is still a pair of fields at this stage, so it rides
    /// along untouched for the next step to deal with.
    fn upgrade(self) -> ProjectV2 {
        ProjectV2 {
            _version: 2,
            size: self.size,
            projection: self.projection,
            polar_angle: self.polar_angle,
            active: self.active,
            reference: self.reference,
            layers: self
                .layers
                .into_iter()
                .map(|s| {
                    let p = s.p;
                    LayerSnapshotV2 {
                        p: LayerParamsV2 {
                            id: p.id,
                            name: p.name,
                            kind: p.kind,
                            visible: p.visible,
                            opacity: p.opacity,
                            effects: if p.blur > 0.0 { vec![LayerEffect::blur(p.blur)] } else { Vec::new() },
                            legacy_blur: 0.0,
                            direction: p.direction,
                            strength: p.strength,
                            disturbance_enabled: p.disturbance_enabled,
                            disturbance: p.disturbance,
                            has_mask: p.has_mask,
                        },
                        buf: s.buf,
                        mask: s.mask,
                        paths: Vec::new(),
                    }
                })
                .collect(),
        }
    }
}

// -- v2 -------------------------------------------------------------------
//
// v3 turned an obstacle layer's disturbance into an effect like any other,
// which is what it always was: something done *to* the layer's mask, not a
// property of the layer. The two fields are gone from `LayerParams`, so a v2
// file needs its switched-on disturbance turned into the effect it meant —
// otherwise opening one would silently stop the flow bending around your
// obstacles, with nothing on screen to say why.

#[derive(Deserialize)]
struct ProjectV2 {
    /// Same as v1: the version is in the header too, but the body has one and
    /// the array has to line up.
    _version: u32,
    size: usize,
    projection: u8,
    polar_angle: f32,
    active: String,
    layers: Vec<LayerSnapshotV2>,
    reference: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct LayerSnapshotV2 {
    p: LayerParamsV2,
    buf: Vec<u8>,
    mask: Option<Vec<u8>>,
    #[serde(default)]
    paths: Vec<PathData>,
}

#[derive(Deserialize)]
struct LayerParamsV2 {
    id: String,
    name: String,
    kind: LayerKind,
    visible: bool,
    opacity: f32,
    #[serde(default)]
    effects: Vec<LayerEffect>,
    #[serde(default)]
    legacy_blur: f32,
    direction: f32,
    strength: f32,
    disturbance_enabled: bool,
    disturbance: f32,
    has_mask: bool,
}

impl ProjectV2 {
    fn upgrade(self) -> ProjectData {
        ProjectData {
            version: FORMAT_VERSION,
            size: self.size,
            projection: self.projection,
            polar_angle: self.polar_angle,
            active: self.active,
            reference: self.reference,
            layers: self
                .layers
                .into_iter()
                .map(|s| {
                    let p = s.p;
                    let mut effects = p.effects;
                    // Only an obstacle ever read those two fields — on any
                    // other kind they were dead weight, so migrating them
                    // would add an effect that provably does nothing.
                    if p.kind == LayerKind::Obstacle
                        && p.disturbance_enabled
                        && p.disturbance > 0.0
                    {
                        effects.push(LayerEffect::disturbance(p.disturbance));
                    }
                    LayerSnapshot {
                        p: super::LayerParams {
                            id: p.id,
                            name: p.name,
                            kind: p.kind,
                            visible: p.visible,
                            opacity: p.opacity,
                            effects,
                            legacy_blur: p.legacy_blur,
                            direction: p.direction,
                            strength: p.strength,
                            has_mask: p.has_mask,
                        },
                        buf: s.buf,
                        mask: s.mask,
                        paths: s.paths,
                    }
                })
                .collect(),
        }
    }
}

pub fn save_project(engine: &Engine, path: &str) -> Result<(), String> {
    let reference = engine.reference.as_ref().and_then(|r| {
        let img = image::RgbaImage::from_raw(r.w as u32, r.h as u32, r.data.clone())?;
        let mut cur = Cursor::new(Vec::new());
        img.write_to(&mut cur, ImageFormat::Png).ok()?;
        Some(cur.into_inner())
    });

    let layers: Vec<LayerSnapshot> = engine
        .layers
        .iter()
        .map(|l| LayerSnapshot {
            p: l.p.clone(),
            buf: zstd::stream::encode_all(&l.buf.data[..], 3).unwrap_or_else(|_| l.buf.data.clone()),
            mask: l.mask.as_ref().map(|m| zstd::stream::encode_all(&m.data[..], 3).unwrap_or_else(|_| m.data.clone())),
            paths: l.paths.clone(),
        })
        .collect();

    let proj = ProjectData {
        version: FORMAT_VERSION,
        size: engine.size,
        projection: match engine.projection {
            super::ops::Projection::Equirectangular => 0,
            super::ops::Projection::Polar => 1,
            super::ops::Projection::Planar => 2,
        },
        polar_angle: engine.polar_angle,
        active: engine.active.clone(),
        layers,
        reference,
    };

    let body = rmp_serde::to_vec(&proj).map_err(|e| format!("序列化失败: {e}"))?;
    let packed = zstd::stream::encode_all(&body[..], 3).map_err(|e| format!("压缩失败: {e}"))?;

    let mut out = Vec::with_capacity(MAGIC.len() + 4 + packed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&packed);
    std::fs::write(path, out).map_err(|e| format!("写入工程文件失败: {e}"))
}

pub fn load_project(path: &str) -> Result<Engine, String> {
    let raw = std::fs::read(path).map_err(|e| format!("读取工程文件失败: {e}"))?;
    if raw.len() < 10 || &raw[..6] != MAGIC {
        return Err("不是有效的 SkyFlow 工程文件".into());
    }
    let version = u32::from_le_bytes([raw[6], raw[7], raw[8], raw[9]]);
    let body = zstd::stream::decode_all(&raw[10..]).map_err(|e| format!("解压失败: {e}"))?;
    let proj: ProjectData = if version == 1 {
        let v1: ProjectV1 = rmp_serde::from_slice(&body).map_err(|e| format!("解析失败: {e}"))?;
        v1.upgrade().upgrade()
    } else if version == 2 {
        let v2: ProjectV2 = rmp_serde::from_slice(&body).map_err(|e| format!("解析失败: {e}"))?;
        v2.upgrade()
    } else if version == FORMAT_VERSION {
        rmp_serde::from_slice(&body).map_err(|e| format!("解析失败: {e}"))?
    } else {
        return Err(format!("工程文件版本不匹配 (v{version})"));
    };

    let mut engine = Engine::new(proj.size);
    engine.layers.clear();
    let expect = proj.size * proj.size * 4;
    for s in proj.layers {
        let mut buf = Buf { w: proj.size, h: proj.size, data: decompress_or(&s.buf, expect) };
        if buf.data.len() != expect {
            buf.data.resize(expect, 0);
        }
        let mask = s.mask.map(|m| Buf {
            w: proj.size,
            h: proj.size,
            data: decompress_or(&m, expect),
        });
        let wind_dirty = s.p.kind == LayerKind::Wind;
        let mut p = s.p;
        // Effects used to be a bare `blur` radius on every layer. A project
        // saved then still has one, so turn it into the effect it always
        // meant — otherwise opening an old file would silently drop the
        // softness you had dialled in, with nothing on screen to say why.
        if p.effects.is_empty() && p.legacy_blur > 0.0 {
            p.effects.push(LayerEffect::blur(p.legacy_blur));
        }
        p.legacy_blur = 0.0;
        engine.layers.push(super::LayerData {
            p,
            buf,
            mask,
            paths: s.paths,
            wind_dirty,
            buf_dirty: true,
            mask_dirty: true,
            blur_cache: None,
            plane_cache: None,
        });
    }
    if engine.layers.is_empty() {
        return Err("工程文件不包含图层".into());
    }
    engine.active = if engine.layers.iter().any(|l| l.p.id == proj.active) {
        proj.active
    } else {
        engine.layers[engine.layers.len() - 1].p.id.clone()
    };
    // Ids are minted from a counter this file does not carry, so take it from
    // the ids that are here — and then make sure they are actually distinct.
    // A file saved before that was guaranteed can carry a collision, and
    // loading it has to come out with a stack that can be addressed at all.
    engine.sync_id_counter();
    engine.dedupe_ids();
    engine.projection = match proj.projection {
        1 => super::ops::Projection::Polar,
        2 => super::ops::Projection::Planar,
        _ => super::ops::Projection::Equirectangular,
    };
    engine.polar_angle = proj.polar_angle;
    engine.reference = proj.reference.and_then(|bytes| {
        let img = image::load_from_memory(&bytes).ok()?;
        let rgba = img.resize_exact(proj.size as u32, proj.size as u32, image::imageops::FilterType::Triangle);
        Some(Buf { w: proj.size, h: proj.size, data: rgba.into_rgba8().into_raw() })
    });
    engine.full_dirty = true;
    Ok(engine)
}

fn decompress_or(data: &[u8], expect: usize) -> Vec<u8> {
    match zstd::stream::decode_all(data) {
        Ok(v) => v,
        Err(_) => vec![0u8; expect],
    }
}
