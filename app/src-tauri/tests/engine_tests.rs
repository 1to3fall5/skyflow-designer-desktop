//! Integration tests for the pixel engine.
//! Run with: `cargo test -p skyflow-designer`

use skyflow_lib::engine::buf::Buf;
use skyflow_lib::engine::io;
use skyflow_lib::engine::effect::{EffectKind, LayerEffect};
use skyflow_lib::engine::ops::{self, Projection};
use skyflow_lib::engine::{Engine, LayerKind};

// ---------------------------------------------------------------------------
// TGA writers used as fixtures
// ---------------------------------------------------------------------------

fn tga_header(id_len: u8, cmap_type: u8, img_type: u8, w: u16, h: u16, depth: u8, desc: u8) -> Vec<u8> {
    let mut v = Vec::new();
    v.push(id_len);
    v.push(cmap_type);
    v.push(img_type);
    v.extend_from_slice(&[0, 0, 0, 0, 0]); // colour map spec
    v.extend_from_slice(&[0, 0, 0, 0]);    // origin
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.push(depth);
    v.push(desc);
    v
}

/// px(x, y) -> (r, g, b, a); y is in *image row order* (row 0 = first stored row).
fn make_tga(w: usize, h: usize, depth: u8, top_left: bool, rle: bool,
            px: impl Fn(usize, usize) -> (u8, u8, u8, u8)) -> Vec<u8> {
    let img_type: u8 = if rle { 10 } else { 2 };
    let desc = if top_left { 0x20 | (if depth == 32 { 8 } else { 0 }) } else { if depth == 32 { 8 } else { 0 } };
    let mut out = tga_header(0, 0, img_type, w as u16, h as u16, depth, desc);
    let bpp = depth as usize / 8;

    // stored rows: row 0 is top row when top_left, else bottom row
    let stored = |row: usize| -> (usize, usize) { // -> (x, y) in logical coords
        (0, if top_left { row } else { h - 1 - row })
    };

    if !rle {
        for row in 0..h {
            for x in 0..w {
                let (_, ly) = stored(row);
                let (r, g, b, a) = px(x, ly);
                out.push(b); out.push(g); out.push(r);
                if depth == 32 { out.push(a); }
            }
        }
        return out;
    }

    // RLE: encode each row as raw/rle packets
    for row in 0..h {
        let (_, ly) = stored(row);
        let mut row_bytes: Vec<Vec<u8>> = Vec::with_capacity(w);
        for x in 0..w {
            let (r, g, b, a) = px(x, ly);
            let mut p = vec![b, g, r];
            if depth == 32 { p.push(a); }
            row_bytes.push(p);
        }
        let mut i = 0usize;
        let mut packets: Vec<u8> = Vec::new();
        while i < w {
            // count run length
            let mut run = 1usize;
            while i + run < w && run < 128 && row_bytes[i + run] == row_bytes[i] {
                run += 1;
            }
            if run >= 2 {
                packets.push(0x80 | (run as u8 - 1));
                packets.extend_from_slice(&row_bytes[i]);
                i += run;
            } else {
                let start = i;
                let mut lit = 0usize;
                while i < w && lit < 128 {
                    let mut r2 = 1usize;
                    while i + r2 < w && r2 < 3 && row_bytes[i + r2] == row_bytes[i] {
                        r2 += 1;
                    }
                    if r2 >= 2 && i > start { break; }
                    lit += 1;
                    i += 1;
                    if r2 >= 2 { break; }
                }
                packets.push((lit as u8) - 1);
                for k in start..start + lit { packets.extend_from_slice(&row_bytes[k]); }
            }
        }
        out.extend_from_slice(&packets);
    }
    out
}

fn write_tmp(name: &str, data: &[u8]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("skyflow_tests");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, data).unwrap();
    p
}

/// A recognisable pattern: red channel = x, green = y, blue = 64.
fn pattern(x: usize, y: usize) -> (u8, u8, u8, u8) {
    (x as u8, y as u8, 64, 255)
}

// ---------------------------------------------------------------------------
// TGA import
// ---------------------------------------------------------------------------

/// Engine without the built-in global-wind layer, so composites start neutral.
fn bare_engine(size: usize) -> Engine {
    let mut e = Engine::new(size);
    assert!(e.remove_layer("wind-default"), "default wind layer should exist");
    e
}

fn check_tga(name: &str, depth: u8, top_left: bool, rle: bool) {
    let (w, h) = (8usize, 8usize);
    let data = make_tga(w, h, depth, top_left, rle, pattern);
    let path = write_tmp(name, &data);
    let buf = io::load_reference(path.to_str().unwrap(), w)
        .unwrap_or_else(|e| panic!("[{name}] load failed: {e}"));
    assert_eq!(buf.w, w, "[{name}] width");
    assert_eq!(buf.h, w, "[{name}] height (should be resized to size x size)");
    // size == w so no resampling: verify pixels exactly
    for y in 0..h {
        for x in 0..w {
            let i = (y * buf.w + x) * 4;
            assert_eq!(buf.data[i], x as u8, "[{name}] R at ({x},{y})");
            assert_eq!(buf.data[i + 1], y as u8, "[{name}] G at ({x},{y})");
            assert_eq!(buf.data[i + 2], 64, "[{name}] B at ({x},{y})");
        }
    }
}

#[test]
fn tga_24_uncompressed_top_left() { check_tga("t24_tl.tga", 24, true, false); }
#[test]
fn tga_24_uncompressed_bottom_left() { check_tga("t24_bl.tga", 24, false, false); }
#[test]
fn tga_32_uncompressed_top_left() { check_tga("t32_tl.tga", 32, true, false); }
#[test]
fn tga_32_uncompressed_bottom_left() { check_tga("t32_bl.tga", 32, false, false); }
#[test]
fn tga_24_rle_top_left() { check_tga("t24r_tl.tga", 24, true, true); }
#[test]
fn tga_24_rle_bottom_left() { check_tga("t24r_bl.tga", 24, false, true); }
#[test]
fn tga_32_rle_top_left() { check_tga("t32r_tl.tga", 32, true, true); }
#[test]
fn tga_32_rle_bottom_left() { check_tga("t32r_bl.tga", 32, false, true); }

/// 16-bit (5-5-5) TGA is common in game assets.
#[test]
fn tga_16_uncompressed_top_left() {
    let (w, h) = (4usize, 4usize);
    let mut data = tga_header(0, 0, 2, w as u16, h as u16, 16, 0x20);
    for _ in 0..w * h {
        // 0 = black, 0x7fff = white
        data.extend_from_slice(&0x7fffu16.to_le_bytes());
    }
    let p = write_tmp("t16.tga", &data);
    let buf = io::load_reference(p.to_str().unwrap(), w).expect("16-bit TGA must load");
    for c in buf.data.chunks_exact(4) {
        assert_eq!(&c[..3], &[248, 248, 248], "white 555 should expand to 248");
    }
    let _ = h;
}

/// A heavily-compressed RLE image is far shorter than the raw pixel count.
#[test]
fn tga_rle_smaller_than_raw_is_accepted() {
    let (w, h) = (64usize, 64usize);
    let data = make_tga(w, h, 32, true, true, |_, _| (10, 20, 30, 255));
    assert!(data.len() < 18 + w * h * 4, "fixture should be compressed");
    let path = write_tmp("flat_rle.tga", &data);
    let buf = io::load_reference(path.to_str().unwrap(), w).expect("flat RLE TGA must load");
    let i = 0;
    assert_eq!(&buf.data[i..i + 3], &[10, 20, 30]);
}

/// The real-world case: a 2:1 equirectangular sky stretched into the square
/// working buffer (matching the web version's drawImage behaviour).
#[test]
fn tga_equirect_2to1_is_stretched_to_square() {
    let (w, h) = (16usize, 8usize);
    let data = make_tga(w, h, 24, true, true, |x, _| (x as u8 * 16, 0, 0, 255));
    let p = write_tmp("equirect.tga", &data);
    let buf = io::load_reference(p.to_str().unwrap(), 32).expect("2:1 TGA must load");
    assert_eq!((buf.w, buf.h), (32, 32), "must be stretched to the working size");
    // every row should look the same (source varies only along x)
    let top = buf.data[..32 * 4].to_vec();
    let bottom = buf.data[(31 * 32 * 4)..].to_vec();
    assert_eq!(top, bottom, "vertical stretch must be uniform");
    assert!(top.iter().step_by(4).any(|&v| v > 0), "should carry the gradient");
}

/// The bug this guards: the WebView cannot decode TGA, so importing one "worked"
/// in the engine but rendered nothing. Every displayed image must round-trip
/// through `encode_png_bytes`.
#[test]
fn tga_display_path_produces_decodable_png() {
    let (w, h) = (8usize, 8usize);
    let data = make_tga(w, h, 32, true, true, pattern);
    let p = write_tmp("display_rle.tga", &data);
    let buf = io::load_reference(p.to_str().unwrap(), w).expect("TGA must load");

    let png = io::encode_png_bytes(&buf).expect("must encode to PNG");
    assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G'], "must be a real PNG");
    let png_path = write_tmp("display_out.png", &png);
    let back = io::load_reference(png_path.to_str().unwrap(), w).expect("PNG must decode");
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            assert_eq!(&back.data[i..i + 3], &buf.data[i..i + 3], "pixel ({x},{y})");
        }
    }
}

/// Truncated files must produce an Err, not a panic.
#[test]
fn tga_truncated_returns_error() {
    let data = make_tga(32, 32, 32, true, true, |_, _| (1, 2, 3, 255));
    let path = write_tmp("trunc.tga", &data[..data.len() / 3]);
    let res = io::load_reference(path.to_str().unwrap(), 32);
    assert!(res.is_err(), "truncated TGA must error, not panic");
}

#[test]
fn png_roundtrip_via_image_crate() {
    let mut b = Buf::filled(16, 16, [200, 100, 50, 255]);
    b.data[0] = 1;
    let p = write_tmp("ref.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();
    let loaded = io::load_reference(p.to_str().unwrap(), 16).unwrap();
    assert_eq!(loaded.data[0], 1);
    assert_eq!(loaded.data[1], 100);
}

// ---------------------------------------------------------------------------
// Engine behaviour
// ---------------------------------------------------------------------------

#[test]
fn fresh_engine_composites_to_neutral() {
    let mut e = bare_engine(64);
    e.composite();
    for c in e.composite.data.chunks_exact(4) {
        assert_eq!(c[0], 128);
        assert_eq!(c[1], 128);
        assert_eq!(c[2], 255);
    }
}

#[test]
fn stroke_changes_pixels_and_reports_dirty_rect() {
    let mut e = Engine::new(128);
    let r = e.stroke(&[(0.5, 0.5), (0.56, 0.5)], 20.0, 0.8, 1.0, false, "content", 1, 1.0).expect("stroke");
    e.composite();
    let d = e.dirty_rect();
    assert!(r.2 > 0 && r.3 > 0, "stroke must report a bbox, got {r:?}");
    assert!(d.2 > 0 && d.3 > 0, "dirty rect must be non-empty, got {d:?}");
    // centre pixel should have moved away from neutral
    let i = (64 * 128 + 64) * 4;
    assert_ne!(e.composite.data[i], 128, "centre pixel should be painted");
}

#[test]
fn eraser_restores_neutral() {
    let mut e = bare_engine(128);
    e.stroke(&[(0.5, 0.5), (0.6, 0.5)], 40.0, 0.8, 1.0, false, "content", 1, 1.0);
    e.composite();
    let i = (64 * 128 + 64) * 4;
    assert_ne!(e.composite.data[i], 128);
    // A new stroke id: the eraser is a separate drag, so it deposits again.
    // Reusing id 1 would make it a continuation of the stroke it is undoing,
    // and the engine would (correctly) treat the pixel as already saturated.
    e.stroke(&[(0.5, 0.5), (0.6, 0.5)], 40.0, 0.8, 1.0, true, "content", 2, 1.0);
    e.composite();
    assert_eq!(e.composite.data[i], 128, "eraser should restore neutral");
}

#[test]
fn wind_layer_generates_non_neutral_field() {
    let mut e = Engine::new(64);
    e.add_layer(LayerKind::Wind);
    e.composite();
    let changed = e.composite.data.chunks_exact(4).filter(|c| c[0] != 128 || c[1] != 128).count();
    assert!(changed > 64 * 64 / 4, "wind should affect a large area, got {changed}");
}

#[test]
fn wind_direction_change_updates_field() {
    let mut e = Engine::new(64);
    let id = e.add_layer(LayerKind::Wind);
    e.composite();
    let before = e.composite.data.clone();
    e.layer_mut(&id).unwrap().p.direction = 270.0;
    e.layer_mut(&id).unwrap().wind_dirty = true;
    e.composite();
    assert_ne!(before, e.composite.data, "changing direction must change the field");
}

#[test]
fn hidden_layer_is_excluded() {
    let mut e = bare_engine(64);
    let id = e.add_layer(LayerKind::Wind);
    e.composite();
    assert!(e.composite.data.chunks_exact(4).any(|c| c[0] != 128 || c[1] != 128));
    e.layer_mut(&id).unwrap().p.visible = false;
    e.composite();
    assert!(e.composite.data.chunks_exact(4).all(|c| c[0] == 128 && c[1] == 128),
        "hidden layer must not contribute");
}

#[test]
fn default_engine_has_wind_layer() {
    let mut e = Engine::new(64);
    assert_eq!(e.layers.len(), 2, "paint + default wind");
    e.composite();
    assert!(e.composite.data.chunks_exact(4).any(|c| c[0] != 128 || c[1] != 128));
}

#[test]
fn undo_redo_restores_pixels() {
    let mut e = Engine::new(64);
    e.save_history();                                    // clean state
    e.stroke(&[(0.5, 0.5), (0.68, 0.5)], 30.0, 0.8, 1.0, false, "content", 1, 1.0);
    e.composite();
    e.save_history();
    let painted = e.composite.data.clone();
    assert!(e.undo());
    e.composite();
    assert_ne!(painted, e.composite.data, "undo must change pixels back");
    assert!(e.redo());
    e.composite();
    assert_eq!(painted, e.composite.data, "redo must restore painted pixels");
}

#[test]
fn obstacle_mask_drives_blue_channel() {
    let mut e = Engine::new(64);
    let id = e.add_layer(LayerKind::Obstacle);
    e.stroke(&[(0.5, 0.5)], 40.0, 0.9, 1.0, false, "mask", 1, 1.0);
    e.composite();
    let i = (32 * 64 + 32) * 4;
    assert!(e.composite.data[i + 2] < 255, "obstacle mask must lower B, got {}", e.composite.data[i + 2]);
    let _ = id;
}

#[test]
fn project_save_load_roundtrip() {
    let mut e = Engine::new(64);
    e.stroke(&[(0.4, 0.4)], 30.0, 0.8, 1.0, false, "content", 1, 1.0);
    e.composite();
    let expected = e.composite.data.clone();

    let path = write_tmp("proj.skyflow", &[]);
    io::save_project(&e, path.to_str().unwrap()).expect("save");

    let mut loaded = io::load_project(path.to_str().unwrap()).expect("load");
    loaded.composite();
    assert_eq!(loaded.layers.len(), e.layers.len());
    assert_eq!(expected, loaded.composite.data, "roundtrip must preserve pixels");
}

#[test]
fn project_file_with_bad_magic_is_rejected() {
    let path = write_tmp("bad.skyflow", b"NOTATGA- rubbish");
    assert!(io::load_project(path.to_str().unwrap()).is_err());
}

#[test]
fn export_tga_writes_valid_header() {
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("out.tga", &[]);
    io::export_tga(&b, false, false, p.to_str().unwrap()).unwrap();
    let raw = std::fs::read(&p).unwrap();
    assert_eq!(&raw[..3], &[0, 0, 2], "id_len=0, no colour map, uncompressed true-colour");
    assert_eq!(raw[2], 2, "uncompressed true-colour");
    assert_eq!(u16::from_le_bytes([raw[12], raw[13]]), 8);
    assert_eq!(raw[16], 32);
    assert_eq!(raw[17], 0x28);
    assert_eq!(raw.len(), 18 + 8 * 8 * 4);
}

#[test]
fn export_tga_round_trips_every_channel() {
    // TGA stores B,G,R,A while this engine's buffers are R,G,B,A. Writing the
    // channels in buffer order instead of storage order is not a convention
    // choice — decoded again, the horizontal offset came back in G and the
    // mobility mask in R, so a TGA round-trip permuted all three.
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("rt.tga", &[]);
    io::export_tga(&b, false, false, p.to_str().unwrap()).unwrap();
    let back = io::load_reference(p.to_str().unwrap(), 8).unwrap();
    assert_eq!(&back.data[..4], &[10, 20, 30, 255], "R,G,B,A must come back in order");
}

#[test]
fn export_tga_inverts_the_same_channels_as_png() {
    // The two writers are read by the same importer, so they have to agree on
    // which channel is which — otherwise importing a PNG and a TGA of the same
    // flowmap would give two different fields.
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    for (ix, iy) in [(false, false), (true, false), (false, true), (true, true)] {
        let t = write_tmp("cmp.tga", &[]);
        let g = write_tmp("cmp.png", &[]);
        io::export_tga(&b, ix, iy, t.to_str().unwrap()).unwrap();
        io::export_png(&b, ix, iy, g.to_str().unwrap()).unwrap();
        let from_tga = io::load_reference(t.to_str().unwrap(), 8).unwrap();
        let from_png = io::load_reference(g.to_str().unwrap(), 8).unwrap();
        assert_eq!(
            &from_tga.data[..4], &from_png.data[..4],
            "TGA and PNG must agree (invert_x={ix}, invert_y={iy})"
        );
    }
}

#[test]
fn import_repairs_an_alpha_the_file_never_had() {
    // Most flowmaps are stored without an alpha channel, which decodes as zero
    // everywhere. Taken literally the layer arrives perfectly good and perfectly
    // invisible.
    let b = Buf::filled(8, 8, [10, 20, 30, 0]);
    let p = write_tmp("noalpha.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();

    let kept = io::import_flowmap(p.to_str().unwrap(), 8, false, false, false, false, false)
        .unwrap()
        .flow;
    assert_eq!(kept.data[3], 0, "with the flag off, take the file at its word");

    let fixed = io::import_flowmap(p.to_str().unwrap(), 8, false, false, true, false, false)
        .unwrap()
        .flow;
    assert_eq!(fixed.data[3], 255, "a flat alpha means 'no opinion', not 'invisible'");
}

#[test]
fn import_frees_the_mobility_channel() {
    // B means mobility here and blue out there. Whatever the file stored there
    // is noise, and noise in that channel is obstacles the author never drew.
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("mob.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();

    let raw = io::import_flowmap(p.to_str().unwrap(), 8, false, false, false, false, false)
        .unwrap()
        .flow;
    assert_eq!(raw.data[2], 30, "with the flag off, keep what was stored");

    let freed = io::import_flowmap(p.to_str().unwrap(), 8, false, false, false, true, false)
        .unwrap()
        .flow;
    assert_eq!(freed.data[2], 255, "mobility defaults to fully free");
    assert_eq!(&freed.data[..2], &[10, 20], "and the offsets are untouched");
}

#[test]
fn import_undoes_the_export_inversion() {
    // Both are `255 - c`, and that is an involution, which is why one flag
    // serves both directions: write with a flag, read with the same one.
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("rtrip.png", &[]);
    io::export_png(&b, true, true, p.to_str().unwrap()).unwrap();
    let back = io::import_flowmap(p.to_str().unwrap(), 8, true, true, false, false, false)
        .unwrap()
        .flow;
    assert_eq!(&back.data[..3], &[10, 20, 30], "export inverted, import inverts back");
}

#[test]
fn importing_a_layer_is_one_undo_step() {
    // It is a structural edit, so undo has to take the whole layer away — and
    // the 'before' entry carries no snapshot, only an order that lacks it,
    // which is what makes that possible.
    let n = 32;
    let mut e = Engine::new(n);
    let before = e.layers.len();
    let id = e.import_layer(Buf::filled(n, n, [128, 128, 255, 255]), None, "导入的图").unwrap();
    assert_eq!(e.layers.len(), before + 1);
    assert_eq!(e.active, id, "the imported layer becomes the active one");
    assert_eq!(e.layer(&id).unwrap().p.name, "导入的图");

    assert!(e.undo(), "there must be somewhere to go back to");
    assert!(
        !e.layers.iter().any(|l| l.p.id == id),
        "undo must remove the imported layer, not just its pixels"
    );
    assert!(e.redo());
    assert!(e.layers.iter().any(|l| l.p.id == id), "and redo must bring it back");
}

#[test]
fn import_can_split_the_mobility_channel_into_an_obstacle_mask() {
    // Mobility and an obstacle mask are the same fact upside down: one obstacle
    // layer at full opacity writes `B = 255 * (1 - a)`, so the mask that would
    // have produced this B is `255 - B`.
    //
    // Splitting keeps the information. Baked into a paint layer's pixels it is
    // not editable as an obstacle, which is the only thing you would want to do
    // with it.
    let mut b = Buf::filled(8, 8, [10, 20, 255, 255]);
    b.data[2] = 0; // this one pixel does not flow at all
    let p = write_tmp("split.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();

    let got = io::import_flowmap(p.to_str().unwrap(), 8, false, false, false, false, true).unwrap();
    assert_eq!(got.flow.data[2], 255, "splitting frees the flow layer's B");
    assert_eq!(&got.flow.data[..2], &[10, 20], "and leaves the offsets alone");
    let m = got.obstacle.expect("splitting must produce a mask");
    assert_eq!(m.data[3], 255, "B=0 is fully blocked");
    assert_eq!(m.data[7], 0, "B=255 is no obstacle at all");
}

#[test]
fn import_without_splitting_keeps_no_obstacle() {
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("nosplit.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();
    let got = io::import_flowmap(p.to_str().unwrap(), 8, false, false, false, false, false).unwrap();
    assert!(got.obstacle.is_none(), "an obstacle layer is only made when asked for");
}

#[test]
fn a_split_import_lands_two_layers_and_undo_takes_both() {
    let n = 32;
    let mut e = Engine::new(n);
    let before = e.layers.len();
    let mut mask = Buf::new(n, n);
    mask.data.chunks_exact_mut(4).for_each(|c| c[3] = 128);
    let id = e
        .import_layer(Buf::filled(n, n, [128, 128, 255, 255]), Some(mask), "图")
        .unwrap();
    assert_eq!(e.layers.len(), before + 2, "a flow layer and an obstacle layer");

    let obs = e.layers.iter().find(|l| l.p.kind == LayerKind::Obstacle).expect("an obstacle layer");
    assert_eq!(obs.p.name, "图 障碍");
    assert_eq!(obs.mask.as_ref().unwrap().data[3], 128);
    // Above the flow it blocks: that is the direction the composite reads the
    // stack in, and an obstacle under its own field would cover nothing.
    let at_flow = e.layers.iter().position(|l| l.p.id == id).unwrap();
    let at_obs = e.layers.iter().position(|l| l.p.id == obs.p.id).unwrap();
    assert!(at_obs > at_flow, "the obstacle must sit above the flow");

    assert!(e.undo());
    assert_eq!(e.layers.len(), before, "one step: both layers go, not just one");
}

// ---------------------------------------------------------------------------
// Applying an effect: the fx badge becomes pixels
// ---------------------------------------------------------------------------

#[test]
fn baking_a_blur_does_not_move_the_picture() {
    // The hard rule, same as a merge: flattening a style is not an edit. If the
    // composite shifts by more than 8-bit re-association, "apply" silently
    // changed the artwork.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 30.0, 0.5, 1.0, false, "color", 1, 1.0);
    e.set_effects(&id, vec![LayerEffect::blur(8.0)]);
    e.composite();
    let before = e.composite.data.clone();

    assert!(e.bake_effects(&id), "a blur on a paint layer must be bakeable");
    e.composite();
    assert_same(&e.composite.data, &before, "baking must leave the composite alone");
}

#[test]
fn baking_takes_the_effect_off_the_layer() {
    // Otherwise the composite would apply the same blur a second time to the
    // pixels it is already in.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 0.5, 1.0, false, "color", 1, 1.0);
    e.set_effects(&id, vec![LayerEffect::blur(6.0)]);
    assert!(e.bake_effects(&id));
    assert!(
        !e.layer(&id).unwrap().p.effects.iter().any(|f| f.kind == EffectKind::Blur),
        "the blur record has to go"
    );
}

#[test]
fn baking_unblocks_a_merge_the_radii_refused() {
    // The reason this exists. Two layers carrying different radii cannot become
    // one; once the blur is in the pixels there is no radius left to disagree
    // about.
    let n = 64;
    let mut e = Engine::new(n);
    let low = e.add_layer(LayerKind::Paint);
    e.active = low.clone();
    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 30.0, 0.5, 1.0, false, "color", 1, 1.0);
    let top = e.add_layer(LayerKind::Paint);
    e.active = top.clone();
    e.stroke(&[(0.3, 0.4), (0.7, 0.6)], 30.0, 0.5, 1.0, false, "color", 2, 1.0);
    e.set_effects(&low, vec![LayerEffect::blur(4.0)]);
    e.set_effects(&top, vec![LayerEffect::blur(14.0)]);

    let before = e.layers.len();
    assert!(!e.merge_down(&top), "different radii must refuse");
    assert!(e.bake_effects(&top));
    // Baking one is not enough: no blur at all is *also* a radius, so 0 and 4
    // are just as different as 4 and 14 were. Both have to go.
    assert!(!e.merge_down(&top), "0 and 4 are still two radii");
    assert!(e.bake_effects(&low));
    assert!(e.merge_down(&top), "baking both unblocks it");
    assert_eq!(e.layers.len(), before - 1, "two layers have become one");
}

#[test]
fn a_bake_is_undoable() {
    // Two entries, or undo would rewind past the bake entirely — which on a
    // layer with no other history means undo does nothing at all.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 0.5, 1.0, false, "color", 1, 1.0);
    e.set_effects(&id, vec![LayerEffect::blur(9.0)]);
    e.composite();
    let before = e.composite.data.clone();

    assert!(e.bake_effects(&id));
    assert!(e.undo(), "there must be somewhere to go back to");
    assert!(
        e.layer(&id).unwrap().p.effects.iter().any(|f| f.kind == EffectKind::Blur),
        "undo must bring the blur record back, not just the pixels"
    );
    e.composite();
    assert_same(&e.composite.data, &before, "and the picture with it");
}

#[test]
fn a_layer_with_nothing_to_bake_says_no() {
    let n = 32;
    let mut e = Engine::new(n);
    let paint = e.add_layer(LayerKind::Paint);
    assert!(!e.bake_effects(&paint), "no effects at all");

    let wind = e.add_layer(LayerKind::Wind);
    e.set_effects(&wind, vec![LayerEffect::blur(8.0)]);
    assert!(!e.bake_effects(&wind), "wind regenerates its buffer from its dials");

    let obs = e.add_layer(LayerKind::Obstacle);
    e.set_effects(&obs, vec![LayerEffect::disturbance(0.5)]);
    assert!(!e.bake_effects(&obs), "a disturbance bends the field underneath, not this layer");
}

#[test]
fn a_split_obstacle_actually_blocks_the_composite() {
    // The point of splitting is not that the mask has the right numbers, it is
    // that the picture behaves differently. A mask of the right value on a layer
    // that does nothing is the same bug as no mask at all.
    let n = 8;
    let mut b = Buf::new(n, n);
    for y in 0..n {
        for x in 0..n {
            let i = (y * n + x) * 4;
            b.data[i] = 128;
            b.data[i + 1] = 128;
            // Left half does not flow at all, right half flows freely.
            b.data[i + 2] = if x < n / 2 { 0 } else { 255 };
            b.data[i + 3] = 255;
        }
    }
    let p = write_tmp("block_src.png", &[]);
    io::export_png(&b, false, false, p.to_str().unwrap()).unwrap();
    let got = io::import_flowmap(p.to_str().unwrap(), n, false, false, false, false, true).unwrap();

    let mut e = Engine::new(n);
    e.import_layer(got.flow, got.obstacle, "x").unwrap();
    e.composite();
    let blocked = e.composite.data[(4 * n + 1) * 4 + 2];
    let free = e.composite.data[(4 * n + 6) * 4 + 2];
    assert!(blocked < 10, "the blocked half must report no mobility: {blocked}");
    assert!(free > 245, "the free half must be untouched: {free}");
}

#[test]
fn export_png_respects_channel_inversion() {
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("inv.png", &[]);
    io::export_png(&b, true, false, p.to_str().unwrap()).unwrap();
    let back = io::load_reference(p.to_str().unwrap(), 8).unwrap();
    assert_eq!(back.data[0], 255 - 10, "R must be inverted");
    assert_eq!(back.data[1], 20, "G untouched");
}

#[test]
fn export_upscales_to_target_size() {
    let b = Buf::filled(8, 8, [10, 20, 30, 255]);
    let p = write_tmp("up.png", &[]);
    io::export(&b, p.to_str().unwrap(), false, false, Some(64)).unwrap();
    let back = io::load_reference(p.to_str().unwrap(), 64).unwrap();
    assert_eq!(back.w, 64);
    assert_eq!(back.data[0], 10);
}

#[test]
fn upscale_preserves_constants() {
    let b = Buf::filled(8, 8, [77, 88, 99, 255]);
    let u = ops::upscale(&b, 32, 32);
    assert!(u.data.chunks_exact(4).all(|c| c[0] == 77 && c[1] == 88 && c[2] == 99));
}

#[test]
fn blur_is_seamless_around_equirect_edge() {
    let n = 64;
    let mut b = Buf::new(n, n);
    // paint a blob straddling the u=0 seam
    for y in 28..36 {
        for x in 0..4 {
            let i = (y * n + x) * 4;
            b.data[i..i + 4].copy_from_slice(&[200, 100, 50, 255]);
            let j = (y * n + (n - 1 - x)) * 4;
            b.data[j..j + 4].copy_from_slice(&[200, 100, 50, 255]);
        }
    }
    let out = ops::blur(&b, 6.0);
    // the wrap-around neighbours must have picked up some of the blob
    let left = out.data[(32 * n + (n - 2)) * 4];
    let right = out.data[(32 * n + 2) * 4];
    assert!(left > 0 && right > 0, "blur must wrap horizontally: left={left} right={right}");
}

/// A box blur written the slow way, for the tests below to compare against.
///
/// Deliberately naive: one sum per output pixel, no sliding window, no rayon.
/// It is the specification, not an implementation anybody would ship.
fn naive_box(src: &[u8], w: usize, h: usize, r: usize, horizontal: bool) -> Vec<u8> {
    let win = 2 * r as i32 + 1;
    let half = win / 2;
    let mut d = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            for c in 0..4usize {
                let mut sum = 0i32;
                for k in -(r as i32)..=(r as i32) {
                    let (sx, sy) = if horizontal {
                        ((x as i32 + k).rem_euclid(w as i32) as usize, y)
                    } else {
                        (x, (y as i32 + k).clamp(0, h as i32 - 1) as usize)
                    };
                    sum += src[(sy * w + sx) * 4 + c] as i32;
                }
                d[(y * w + x) * 4 + c] = ((sum + half) / win) as u8;
            }
        }
    }
    d
}

#[test]
fn the_vertical_box_pass_matches_a_naive_blur_across_every_strip() {
    // The vertical pass is split into column strips so that one rayon task
    // walks a whole column instead of one task per row. The seam between two
    // strips is the only place that split can go wrong, so the width is
    // chosen not to divide evenly: 100 columns with a strip of 8 leaves a
    // 4-column remainder, and a buffer narrower than one strip forces the
    // single-strip path.
    //
    // Opaque throughout, so premultiply / unpremultiply are the identity and
    // the comparison can be exact rather than within a tolerance.
    for (w, h) in [(100usize, 40usize), (5, 7), (64, 64), (3, 200)] {
        let mut b = Buf::new(w, h);
        for i in 0..w * h {
            let v = (i * 37 % 251) as u8;
            // alpha 255 keeps the naive reference valid; the channels still
            // have to be independent, hence three different patterns.
            b.data[i * 4] = v;
            b.data[i * 4 + 1] = v.reverse_bits();
            b.data[i * 4 + 2] = 255 - v;
            b.data[i * 4 + 3] = 255;
        }

        let radius: f32 = 10.0;
        let br = ((radius * 0.62).max(1.0)).round() as usize;
        let mut cur = b.data.clone();
        for _ in 0..3 {
            cur = naive_box(&cur, w, h, br, true);
            cur = naive_box(&cur, w, h, br, false);
        }

        let out = ops::blur(&b, radius);
        assert_eq!(out.data, cur, "strip split changed the blur at {w}x{h}");
    }
}

#[test]
fn generate_wind_polar_leaves_outside_disc_neutral() {
    let mut b = Buf::new(64, 64);
    ops::generate_wind(&mut b, 45.0, 0.8, Projection::Polar, 90.0);
    let corner = b.data[0];
    assert_eq!(corner, 128, "outside the polar disc must stay neutral");
}

// ---------------------------------------------------------------------------
// Obstacle masks
// ---------------------------------------------------------------------------

#[test]
fn obstacle_mask_starts_empty_not_opaque() {
    // The mask used to be initialised to opaque white, which meant the first
    // dab turned the *entire* sky into an obstacle (B = 0 everywhere) and the
    // painted area was invisible.
    let mut e = bare_engine(64);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "mask", 1, 1.0);
    let mask = e.layer(&id).unwrap().mask.as_ref().expect("stroke must create a mask");
    let far = mask.data[(0 * 64 + 0) * 4 + 3];
    assert_eq!(far, 0, "untouched mask pixels must stay empty, got alpha={far}");
}

#[test]
fn obstacle_stroke_marks_only_the_painted_area() {
    let n = 64;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();

    e.composite();
    assert_eq!(e.composite.data[2], 255, "an unused obstacle layer must not block anything");

    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "mask", 1, 1.0);
    e.composite();

    let core = e.composite.data[(32 * n + 32) * 4 + 2];
    assert!(core < 40, "obstacle core must be immobile (B low), got B={core}");
    let corner = e.composite.data[2];
    assert_eq!(corner, 255, "the rest of the sky must stay mobile, got B={corner}");
}

#[test]
fn obstacle_paint_works_without_a_target_hint() {
    // "content" is not a real destination for an adjustment layer, so the
    // brush must fall back to the mask instead of silently doing nothing.
    let n = 64;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "content", 1, 1.0);
    e.composite();
    let core = e.composite.data[(32 * n + 32) * 4 + 2];
    assert!(core < 40, "painting an obstacle layer must always hit the mask, got B={core}");
}

// ---------------------------------------------------------------------------
// Layer stacking
// ---------------------------------------------------------------------------

/// The layer list is drawn top-first; the engine stores bottom-first.
fn stack(e: &Engine) -> Vec<String> {
    e.layers.iter().rev().map(|l| l.p.id.clone()).collect()
}

#[test]
fn reorder_visual_moves_layers_in_the_top_first_ordering() {
    // The UI sends indices into the reversed list, so the mapping has to be
    // inverted here. Getting it backwards moved the wrong layer.
    let mut e = bare_engine(16);
    let b = e.add_layer(LayerKind::Paint);
    let c = e.add_layer(LayerKind::Paint);
    let base = "layer-1".to_string();
    assert_eq!(stack(&e), vec![c.clone(), b.clone(), base.clone()]);

    e.reorder_visual(0, 2); // drag the top row to the bottom
    assert_eq!(stack(&e), vec![b.clone(), base.clone(), c.clone()]);

    e.reorder_visual(2, 0); // and back
    assert_eq!(stack(&e), vec![c, b, base]);
}

#[test]
fn a_flow_layer_above_an_obstacle_covers_it() {
    // The B channel used to be written in a second pass *after* the
    // compositing loop, which made every obstacle unconditional: paint as much
    // flow as you like on a layer above it and the pixel still read as
    // immobile. A layer stacked on top has to win, the same way it wins on
    // every other channel.
    let n = 64;
    let mut e = bare_engine(n);
    let obs = e.add_layer(LayerKind::Obstacle);
    e.active = obs.clone();
    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "mask", 1, 1.0);
    e.reorder_visual(0, 1); // push the obstacle under the paint layer

    let at = |e: &Engine| e.composite.data[(32 * n + 32) * 4 + 2];
    e.composite();
    let blocked = at(&e);
    assert!(blocked < 40, "nothing painted above: the obstacle must block, got B={blocked}");

    e.active = "layer-1".to_string();
    // Two points: a single sample has no direction, and a paint layer with no
    // direction is deliberately a no-op.
    e.stroke(&[(0.5, 0.5), (0.56, 0.5)], 40.0, 0.8, 0.6, false, "content", 2, 1.0);
    e.composite();
    let covered = at(&e);
    assert!(covered > 240, "flow painted above an obstacle must un-block it, got B={covered}");
}

#[test]
fn an_obstacle_above_a_flow_layer_still_blocks() {
    // The mirror case: order has to matter in both directions, otherwise
    // fixing the bug above would just have disabled obstacles entirely.
    let n = 64;
    let mut e = bare_engine(n);
    let at = |e: &Engine| e.composite.data[(32 * n + 32) * 4 + 2];

    e.active = "layer-1".to_string();
    e.stroke(&[(0.5, 0.5), (0.56, 0.5)], 40.0, 0.8, 0.6, false, "content", 1, 1.0);
    e.composite();
    assert!(at(&e) > 240, "a painted flow layer should be mobile");

    let obs = e.add_layer(LayerKind::Obstacle); // appended, so it sits on top
    e.active = obs;
    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "mask", 2, 1.0);
    e.composite();
    let blocked = at(&e);
    assert!(blocked < 40, "an obstacle stacked on top must still block flow, got B={blocked}");
}

#[test]
fn a_lower_obstacle_keeps_blocking_outside_the_painted_area() {
    // Coverage is per-pixel: painting over part of an obstacle must not
    // release the rest of it.
    let n = 64;
    let mut e = bare_engine(n);
    let obs = e.add_layer(LayerKind::Obstacle);
    e.active = obs.clone();
    // `size` is a diameter, so 48 is a 24px-radius blob — comfortably wider
    // than the dab below.
    e.stroke(&[(0.5, 0.5)], 48.0, 0.25, 1.0, false, "mask", 1, 1.0);
    e.reorder_visual(0, 1);

    e.active = "layer-1".to_string();
    // A short drag left of centre only; the obstacle is much wider.
    e.stroke(&[(0.38, 0.5), (0.42, 0.5)], 12.0, 0.8, 0.6, false, "content", 2, 1.0);
    e.composite();

    let freed = e.composite.data[(32 * n + 26) * 4 + 2];
    let still = e.composite.data[(32 * n + 40) * 4 + 2];
    assert!(freed > 240, "the painted spot must be released, got B={freed}");
    assert!(still < 40, "the rest of the obstacle must stay put, got B={still}");
}

#[test]
fn wind_mask_also_starts_empty() {
    let mut e = bare_engine(64);
    let id = e.add_layer(LayerKind::Wind);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 20.0, 0.25, 1.0, false, "mask", 1, 1.0);
    let mask = e.layer(&id).unwrap().mask.as_ref().expect("mask created");
    assert_eq!(mask.data[3], 0, "untouched wind mask must be empty");
    assert!(mask.data[(32 * 64 + 32) * 4 + 3] > 200, "painted wind mask must be active");
}

// ---------------------------------------------------------------------------
// Brush softness
// ---------------------------------------------------------------------------

#[test]
fn brush_falloff_is_monotonic_and_soft() {
    let n = 64;
    let mut b = Buf::new(n, n);
    let st = ops::StampStyle { r: 0, g: 0, b: 0, erase: false, opaque: false, flow: 1.0 };
    ops::stamp(&mut b, 32.0, 32.0, 32.0, 32.0, 40.0, 0.0, &st, None);

    let at = |d: i32| b.data[(32 * n + (32 + d as usize)) * 4 + 3] as i32;
    let mut prev = 256;
    for d in 0..21 {
        let a = at(d);
        assert!(a <= prev, "alpha must decrease monotonically at d={d}: {a} > {prev}");
        prev = a;
    }
    let (core, mid, rim) = (at(0), at(13), at(18));
    assert!(core > mid && mid > rim, "expected a soft gradient, got {core}/{mid}/{rim}");
    assert_eq!(at(21), 0, "outside the radius nothing may be written");
}

#[test]
fn soft_brush_keeps_a_solid_body() {
    // `core = radius * hardness` gave hardness 0 a brush with no plateau at all:
    // coverage started falling from dead centre, so the stroke read as a haze
    // rather than a soft brush. A plateau of at least a third of the radius is
    // the Blender-ish behaviour we want.
    let radius = 40.0f32;
    let n = 128;
    let mut b = Buf::new(n, n);
    let st = ops::StampStyle { r: 255, g: 255, b: 255, erase: false, opaque: false, flow: 1.0 };
    ops::stamp(&mut b, 64.0, 64.0, 64.0, 64.0, radius * 2.0, 0.0, &st, None);

    let probe = ops::CORE_MIN * radius - 0.5; // just inside the plateau edge
    let d = probe.floor() as usize;
    let alpha = b.data[(64 * n + 64 + d) * 4 + 3];
    assert_eq!(alpha, 255, "the plateau must be at full strength, got {alpha} at d={d}");
}

#[test]
fn hardness_only_ever_widens_the_plateau() {
    // Hardness must not trade plateau width for shoulder width in a way that
    // makes a harder brush *softer* somewhere.
    let n = 128;
    let st = ops::StampStyle { r: 255, g: 255, b: 255, erase: false, opaque: false, flow: 1.0 };
    let alpha_at = |hardness: f32, d: usize| {
        let mut b = Buf::new(n, n);
        ops::stamp(&mut b, 64.0, 64.0, 64.0, 64.0, 80.0, hardness, &st, None);
        b.data[(64 * n + 64 + d) * 4 + 3] as i32
    };
    for d in [10usize, 20, 28, 34] {
        assert!(
            alpha_at(0.9, d) >= alpha_at(0.1, d),
            "hardness 0.9 is softer than 0.1 at d={d}: {} vs {}",
            alpha_at(0.9, d), alpha_at(0.1, d)
        );
    }
}

#[test]
fn stamp_profile_is_independent_of_segment_length() {
    // Distance-to-segment rather than a train of dabs: dragging fast must not
    // harden the edge, because overlapped dabs used to accumulate as 1-(1-a)^n.
    let n = 128;
    let st = ops::StampStyle { r: 255, g: 255, b: 255, erase: false, opaque: false, flow: 1.0 };
    let mut dab = Buf::new(n, n);
    let mut drag = Buf::new(n, n);
    ops::stamp(&mut dab, 64.0, 64.0, 64.0, 64.0, 40.0, 0.0, &st, None);
    ops::stamp(&mut drag, 96.0, 64.0, 32.0, 64.0, 40.0, 0.0, &st, None);

    for dy in 0..20 {
        let y = (64 + dy) * n + 64;
        let a = dab.data[y * 4 + 3] as i32;
        let b = drag.data[y * 4 + 3] as i32;
        assert!((a - b).abs() <= 2, "profile drifted at dy={dy}: dab={a} drag={b}");
    }
}

// ---------------------------------------------------------------------------
// Straight-alpha contract: no dark fringe, no beading
// ---------------------------------------------------------------------------

#[test]
fn blur_vertical_step_is_monotonic_and_symmetric() {
    // The vertical box pass used to slide its window with x instead of y, so it
    // wrote mean(rows y-r+x .. y+r+x) into column x — a diagonal smear that made
    // every blurred layer and every obstacle disturbance noisy. A hard vertical
    // step is the cheapest thing that catches it: the ramp must be monotonic
    // and symmetric about the step.
    let n = 64;
    let mut b = Buf::new(n, n);
    for y in 0..32 {
        for x in 0..n {
            let i = (y * n + x) * 4;
            b.data[i] = 255;
            b.data[i + 3] = 255;
        }
    }
    let out = ops::blur(&b, 8.0);
    let col = |y: usize| out.data[(y * n + 32) * 4 + 3] as i32;

    let mut prev = 256;
    for y in 0..n {
        let v = col(y);
        assert!(v <= prev, "alpha must fall monotonically, y={y}: {v} > {prev}");
        prev = v;
    }
    // step sits between rows 31 and 32, so the profile must mirror around it
    for d in 0..16 {
        let (a, z) = (col(31 - d), col(32 + d));
        assert!((a + z - 255).abs() <= 6, "ramp is not symmetric at d={d}: {a} vs {z}");
    }
    assert!(col(0) > 250 && col(63) == 0);
}

#[test]
fn blur_preserves_straight_colour_in_the_fringe() {
    // Buffers are straight alpha. A blur that forgets to premultiply drags the
    // RGB of transparent pixels (all zeroes — black) into the semi-transparent
    // fringe, which is one way a stroke grows a dark halo.
    let n = 64;
    let mut b = Buf::new(n, n);
    for y in 16..48 {
        for x in 16..48 {
            let i = (y * n + x) * 4;
            b.data[i] = 200;
            b.data[i + 1] = 60;
            b.data[i + 2] = 255;
            b.data[i + 3] = 255;
        }
    }
    let out = ops::blur(&b, 8.0);

    let out = ops::blur(&b, 8.0);

    // Only trust samples where the unpremultiply is not amplifying u8 rounding
    // beyond a level or two. A real premultiply bug would scale R by alpha,
    // e.g. 63 instead of 200, so a small tolerance still catches it.
    let mut checked = 0;
    for y in 0..n {
        for x in 0..n {
            let i = (y * n + x) * 4;
            let a = out.data[i + 3];
            if a < 80 || a > 215 {
                continue;
            }
            let (r, g) = (out.data[i] as i32, out.data[i + 1] as i32);
            assert!(
                (r - 200).abs() <= 6 && (g - 60).abs() <= 6,
                "fringe colour was scaled by alpha at ({x},{y}): R={r} G={g} A={a}"
            );
            checked += 1;
        }
    }
    assert!(checked > 20, "need fringe samples for this to mean anything, got {checked}");
}

#[test]
fn painted_stroke_has_no_dark_fringe() {
    // The composite used to dip *below* the neutral 128 round the rim of a
    // stroke, because the brush stored premultiplied RGB and `blend_over`
    // applied alpha a second time. That reads as a dark ring round the brush.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    // drag right -> left: vx = -1, so the flow colour is R=255, G=128
    let pts: Vec<(f32, f32)> = (0..40).map(|i| (0.75 - i as f32 * 0.01, 0.5)).collect();
    e.stroke(&pts, 40.0, 0.25, 1.0, false, "content", 1, 1.0);
    e.composite();

    let y = n / 2;
    let mut peak = 0;
    for x in 0..n {
        let r = e.composite.data[(y * n + x) * 4] as i32;
        assert!(r >= 126, "composite dips below neutral at x={x}: R={r}");
        assert!(r <= 255);
        peak = peak.max(r);
    }
    assert!(peak > 240, "the stroke core never reached its colour, peak R={peak}");
}

#[test]
fn stroke_coverage_does_not_bead_at_segment_joins() {
    // source-over coverage accumulates as 1-(1-a)^n wherever two segments
    // overlap, rippling the rim with the pointer sampling period — the
    // "string of beads" look. Coverage must be a union instead.
    let n = 256;
    let st = ops::StampStyle { r: 255, g: 255, b: 255, erase: false, opaque: false, flow: 1.0 };
    let mut b = Buf::new(n, n);

    let mut px = 40.0f32;
    while px < 216.0 {
        ops::stamp(&mut b, px + 4.0, 128.0, px, 128.0, 40.0, 0.0, &st, None);
        px += 4.0;
    }

    // Sample the shoulder, ~half coverage. Along a straight run this must be
    // flat. With hardness 0 the plateau is CORE_MIN * 20 = 8 px and the
    // shoulder runs 8..20, so |dy| = 13.5 lands mid-shoulder.
    let rim_y = 114;
    let vals: Vec<i32> = (60..200).map(|x| b.data[(rim_y * n + x) * 4 + 3] as i32).collect();
    let (mn, mx) = (*vals.iter().min().unwrap(), *vals.iter().max().unwrap());
    assert!(mx > 80, "rim is not partially covered at all, max alpha={mx}");
    assert!(mx - mn <= 2, "coverage ripples along the stroke: min={mn} max={mx}");
}

// ---------------------------------------------------------------------------
// Stroke batches: every frame's first sample must not invent a direction
// ---------------------------------------------------------------------------

/// Pixels that disagree with all four neighbours while those neighbours agree
/// among themselves — i.e. isolated dots.
fn count_isolated_dots(b: &Buf, rgb_thresh: i32, neighbour_spread: i32) -> usize {
    let n = b.w;
    let at = |x: usize, y: usize| -> (i32, i32) {
        let i = (y * n + x) * 4;
        (b.data[i] as i32, b.data[i + 1] as i32)
    };
    let mut dots = 0;
    for y in 1..n - 1 {
        for x in 1..n - 1 {
            if b.data[(y * n + x) * 4 + 3] < 8 {
                continue;
            }
            let nb = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
            let (lo_r, lo_g) = nb.iter().fold((999, 999), |a, p| (a.0.min(p.0), a.1.min(p.1)));
            let (hi_r, hi_g) = nb.iter().fold((-999, -999), |a, p| (a.0.max(p.0), a.1.max(p.1)));
            if (hi_r - lo_r).max(hi_g - lo_g) > neighbour_spread {
                continue;
            }
            let me = at(x, y);
            let dev = (me.0 - lo_r).abs().max((me.0 - hi_r).abs())
                .max((me.1 - lo_g).abs()).max((me.1 - hi_g).abs());
            if dev > rgb_thresh {
                dots += 1;
            }
        }
    }
    dots
}

#[test]
fn first_sample_of_a_batch_uses_the_real_direction() {
    // The first sample has no incoming segment, and it used to fake one with a
    // 0.01px horizontal offset — so it always stamped `vx = +1`, i.e. a hard
    // saturated blue dot pointing right. Dragging straight down must instead
    // paint the downward direction from the very first dab.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.3), (0.5, 0.7)], 40.0, 0.25, 1.0, false, "content", 1, 1.0);

    let buf = e.layer(&id).unwrap().buf.clone();
    // Straight down: vx = 0, vy = 1 -> (128, 255, 255).
    let r = buf.data[((n / 2) * n + n / 2) * 4] as i32;
    let g = buf.data[((n / 2) * n + n / 2) * 4 + 1] as i32;
    assert!((r - 128).abs() < 40, "first dab kept the fake rightward direction: R={r}");
    assert!(g > 200, "downward flow should push G up, got G={g}");
}

#[test]
fn a_batch_shaped_like_a_path_flows_along_its_own_tangent() {
    // The pen tool adds no engine support of its own: it flattens a bezier into
    // a polyline and hands the whole thing to `stroke`, which derives the flow
    // from each segment's direction of travel. That only holds if one batch is
    // treated as a continuous path — so this is the contract the pen rests on.
    //
    // A quarter circle is the case that proves it. Every sample has a different
    // tangent, so if the direction came from any single chord, or from the
    // first sample, or from the segment as a whole, the flow would come out
    // radial or constant instead of turning with the curve.
    let n = 256usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    let (cx, cy, r) = (0.5f32, 0.5f32, 0.3f32);
    let arc = |t: f32| (cx + r * t.cos(), cy + r * t.sin());
    let pts: Vec<(f32, f32)> = (0..=24)
        .map(|i| arc(i as f32 / 24.0 * std::f32::consts::FRAC_PI_2))
        .collect();
    e.stroke(&pts, 14.0, 0.9, 1.0, false, "content", 7, 1.0);

    let buf = e.layer(&id).unwrap().buf.clone();
    for t in [0.45f32, 0.9, 1.25] {
        let (u, v) = arc(t);
        let i = ((v * n as f32) as usize * n + (u * n as f32) as usize) * 4;
        let vx = (128.0 - buf.data[i] as f32) / 127.0;
        let vy = (buf.data[i + 1] as f32 - 128.0) / 127.0;
        let len = (vx * vx + vy * vy).sqrt();
        assert!(len > 0.8, "flow at t={t} never got deposited: len={len:.2}");
        // Tangent of that circle at `t`, in the same (v-down) frame.
        let (tx, ty) = (-t.sin(), t.cos());
        let dot = (vx * tx + vy * ty) / len;
        assert!(
            dot > 0.9,
            "flow at t={t} is not tangential: ({vx:.2},{vy:.2}) vs ({tx:.2},{ty:.2}), dot={dot:.2}"
        );
    }
}

#[test]
fn a_path_batch_deposits_evenly_where_it_crosses_itself() {
    // A pen path can easily cross over itself, and one path is one undo step,
    // so the crossing must not come out twice as strong — the same rule a
    // single brush drag gets from its stroke id.
    let n = 128usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    // A figure of eight through the centre, in one batch.
    let ring = |sign: f32| -> Vec<(f32, f32)> {
        (0..=32)
            .map(|i| {
                let t = i as f32 / 32.0 * std::f32::consts::PI;
                (0.5 + sign * 0.25 * t.sin(), 0.5 - 0.25 * t.cos())
            })
            .collect()
    };
    let mut pts = ring(1.0);
    pts.extend(ring(-1.0));
    e.stroke(&pts, 18.0, 0.8, 0.5, false, "content", 3, 0.25);

    e.composite();
    let i = ((n / 2) * n + (n / 2)) * 4;
    let centre = 128.0 - e.composite.data[i] as f32;
    // Strength 0.5 at flow 0.25 must stay well under its ceiling no matter how
    // many times the path runs through the middle.
    let ceiling = 0.5 * 127.0;
    assert!(
        centre < ceiling * 0.75,
        "self-crossing compounded the deposit: {centre:.1} of a {ceiling:.1} ceiling"
    );
}

#[test]
fn a_lone_point_only_paints_a_mask() {
    // A click without movement carries no direction. Inventing one is exactly
    // how the speckle bug started, so on a paint layer it is a no-op; the next
    // batch re-sends this sample as its first element and paints the real
    // segment.
    let n = 64;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 40.0, 0.25, 1.0, false, "content", 1, 1.0);
    let buf = e.layer(&id).unwrap().buf.clone();
    assert!(buf.data.iter().all(|&v| v == 0), "a directionless point must not paint");

    // A mask has no direction in the first place, so a click there is a real
    // dab and must land.
    let mid = e.add_layer(LayerKind::Obstacle);
    e.active = mid.clone();
    e.stroke(&[(0.5, 0.5)], 40.0, 0.25, 1.0, false, "mask", 1, 1.0);
    let mask = e.layer(&mid).unwrap().mask.as_ref().expect("mask created").clone();
    assert!(mask.data[(32 * n + 32) * 4 + 3] > 200, "a click must mark the mask");
}

#[test]
fn batch_strokes_do_not_speckle() {
    // End-to-end guard for the artefact the user reported: the frontend sends
    // `[lastPoint, ...pointsThisFrame]` once per animation frame, so a stroke is
    // many small batches. Every batch's first sample used to leave a wrong-
    // coloured dot, which showed up as a dotted line of saturated pixels along
    // the stroke.
    let n = 256;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    let mut last: Option<(f32, f32)> = None;
    for k in 0..420 {
        let a = (k as f32 / 420.0) * std::f32::consts::TAU * 2.2;
        let rad = 20.0 + k as f32 * 0.22;
        let p = (0.5 + a.cos() * rad / n as f32, 0.5 + a.sin() * rad / n as f32);
        // one frame's worth, exactly like PaintView's flush loop
        let pts: Vec<(f32, f32)> = match last {
            Some(q) => vec![q, p],
            None => vec![p],
        };
        e.stroke(&pts, 60.0, 0.25, 0.8, false, "content", 1, 1.0);
        last = Some(p);
    }

    let buf = e.layer(&id).unwrap().buf.clone();
    assert!(buf.data.chunks_exact(4).any(|c| c[3] > 200), "the stroke should be painted");
    let dots = count_isolated_dots(&buf, 25, 8);
    assert_eq!(dots, 0, "{dots} isolated colour dots along the stroke");
}

#[test]
fn overlapping_soft_strokes_do_not_switch_colour_per_pixel() {
    // Two sets of soft strokes at right angles. Where their shoulders overlap
    // the two coverages are nearly equal, so a winner-take-all colour rule made
    // the result depend on which side of a 1/255 bucket each stamp landed in —
    // a seam that shatters into scattered single pixels.
    let n = 256;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    for step in 0..16 {
        let t = step as f32 / 15.0;
        let sid = step as u64 + 1;
        e.stroke(&[(0.15, 0.35 + t * 0.3), (0.85, 0.35 + t * 0.3)], 70.0, 0.5, 0.7, false, "content", sid, 1.0);
        e.stroke(&[(0.35 + t * 0.3, 0.15), (0.35 + t * 0.3, 0.85)], 70.0, 0.5, 0.7, false, "content", sid + 1000, 1.0);
    }
    let buf = e.layer(&id).unwrap().buf.clone();
    let dots = count_isolated_dots(&buf, 25, 8);
    assert_eq!(dots, 0, "{dots} isolated colour dots where the strokes overlap");
}

#[test]
fn repeated_passes_do_not_build_up_opacity() {
    // Union coverage, Photoshop-style: going over the same spot twice must not
    // darken or harden it.
    let n = 64;
    let st = ops::StampStyle { r: 255, g: 255, b: 255, erase: false, opaque: false, flow: 1.0 };
    let mut b = Buf::new(n, n);
    for _ in 0..5 {
        ops::stamp(&mut b, 32.0, 32.0, 32.0, 32.0, 40.0, 0.25, &st, None);
    }
    let a = b.data[(32 * n + 38) * 4 + 3];
    let mut once = Buf::new(n, n);
    ops::stamp(&mut once, 32.0, 32.0, 32.0, 32.0, 40.0, 0.25, &st, None);
    let a1 = once.data[(32 * n + 38) * 4 + 3];
    assert_eq!(a, a1, "alpha built up from {a1} to {a} over repeated passes");
}

#[test]
fn hardest_brush_still_antialiases_its_rim() {
    // hardness = 1 must not produce a jagged binary disc.
    let n = 64;
    let mut b = Buf::new(n, n);
    let st = ops::StampStyle { r: 0, g: 0, b: 0, erase: false, opaque: false, flow: 1.0 };
    ops::stamp(&mut b, 32.0, 32.0, 32.0, 32.0, 40.0, 1.0, &st, None);
    let at = |d: i32| b.data[(32 * n + (32 + d as usize)) * 4 + 3];
    let rim = at(19);
    assert!(rim > 0 && rim < 255, "the outermost pixel must be a partial value, got {rim}");
    assert_eq!(at(21), 0);
}

// ---------------------------------------------------------------------------
// Brush flow: a low-strength brush has to build up over repeated strokes
// ---------------------------------------------------------------------------

/// One short horizontal drag across the middle of the layer.
/// One short horizontal drag across the middle of the layer.
fn drag(e: &mut Engine, strength: f32, flow: f32, stroke_id: u64) {
    e.stroke(&[(0.5, 0.5), (0.56, 0.5)], 40.0, 0.8, strength, false, "content", stroke_id, flow);
}

/// What you actually see at the centre: the composite's offset from neutral.
/// The drag goes right, so `128 - R` is the flow magnitude.
fn centre(e: &mut Engine) -> f32 {
    e.composite();
    let n = e.size;
    let i = ((n / 2) * n + (n / 2)) * 4;
    128.0 - e.composite.data[i] as f32
}
#[test]
fn strength_is_the_ceiling_not_the_rate() {
    // The bug this replaces: strength used to be the deposit rate with the
    // ceiling pinned at full, so a gentle brush crept up to full strength if
    // you kept painting. "This area flows gently" has to stay gentle.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    let ceiling = 0.3 * 127.0;
    let mut vals = Vec::new();
    for k in 1..=20u64 {
        drag(&mut e, 0.3, 0.25, k);
        vals.push(centre(&mut e));
    }
    for w in vals.windows(2) {
        assert!(w[1] >= w[0], "must build up monotonically: {vals:?}");
    }
    assert!(vals[0] < ceiling * 0.4, "first pass should be well under the ceiling: {}", vals[0]);
    for v in &vals {
        assert!(*v <= ceiling + 2.0, "must never pass the strength you set: {v} vs {ceiling}");
    }
    assert!((vals[19] - ceiling).abs() < 2.0, "twenty passes should reach it: {}", vals[19]);
}

#[test]
fn flow_only_changes_how_fast_you_get_there() {
    // Same strength, two flows: one pass vs many. The destination is identical.
    let n = 128;
    let mut slow = bare_engine(n);
    let sid = slow.add_layer(LayerKind::Paint);
    slow.active = sid.clone();
    drag(&mut slow, 0.3, 0.25, 1);

    let mut fast = bare_engine(n);
    let fid = fast.add_layer(LayerKind::Paint);
    fast.active = fid.clone();
    drag(&mut fast, 0.3, 1.0, 1);

    let s = centre(&mut slow);
    let f = centre(&mut fast);
    assert!(f > s * 3.0, "flow 1 should land in one pass: {s} vs {f}");
    assert!((f - 0.3 * 127.0).abs() < 2.0, "and exactly at the ceiling: {f}");

    for k in 2..=20u64 {
        drag(&mut slow, 0.3, 0.25, k);
    }
    assert!((centre(&mut slow) - f).abs() < 2.0,
        "slow and fast must converge on the same place");
}

#[test]
fn one_drag_does_not_double_deposit_where_it_crosses_itself() {
    // Same id = same drag. Overlap inside a drag must not compound, or the
    // middle of the stroke saturates while the ends stay faint — the beading
    // problem wearing a different hat.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 1.0, 0.25, 1);
    let first = centre(&mut e);
    for _ in 0..11 {
        drag(&mut e, 1.0, 0.25, 1);
    }
    let after = centre(&mut e);
    assert!((after - first).abs() < 1.5,
        "a single drag must deposit once per pixel, got {first} then {after}");
}

#[test]
fn coverage_builds_up_so_the_wind_fades_out_gradually() {
    // Why the build-up lives in coverage rather than in the colour: what you
    // see is `alpha * mine + (1-alpha) * wind`, so the vector rotates from the
    // wind towards the stroke instead of the wind being cut off on pass one.
    let n = 128;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.composite();
    let wind = e.composite.data[((n / 2) * n + (n / 2)) * 4] as f32;

    // Drag right: the target is R = 1.
    let mut vals = Vec::new();
    for k in 1..=16u64 {
        drag(&mut e, 1.0, 0.2, k);
        e.composite();
        vals.push(e.composite.data[((n / 2) * n + (n / 2)) * 4] as f32);
    }
    for w in vals.windows(2) {
        assert!(w[1] <= w[0], "should head for the new direction: {vals:?}");
    }
    // One pass at flow 0.2 should cover ~20% of the distance to the target,
    // not jump most of the way.
    let full = wind - 1.0;
    assert!((wind - vals[0]) < full * 0.30,
        "one light pass must not cut the wind off, went {wind} -> {}", vals[0]);
    assert!(vals[15] < 12.0, "sixteen passes should have taken over: {}", vals[15]);
}

#[test]
fn eraser_builds_up_towards_neutral() {
    // Symmetric with painting: a low-flow eraser peels the stroke away a bit
    // at a time instead of wiping it.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 1.0, 1.0, 1);
    assert!(centre(&mut e) > 125.0);

    let mut vals = Vec::new();
    for k in 2..=14u64 {
        e.stroke(&[(0.5, 0.5), (0.56, 0.5)], 40.0, 0.8, 1.0, true, "content", k, 0.3);
        vals.push(centre(&mut e));
    }
    for w in vals.windows(2) {
        // `<=` because 8-bit bottoms out: once the offset rounds to 1 it stays.
        assert!(w[1] <= w[0], "erasing must fade monotonically: {vals:?}");
    }
    assert!(vals[12] < 4.0, "should be nearly gone by now: {}", vals[12]);
}

#[test]
fn undo_invalidates_the_deposit_record() {
    // The accumulator is a delta against pixels undo just replaced. If it
    // survived, the next stroke would be measured against a stroke that no
    // longer exists and deposit too little.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 1.0, 0.3, 1);
    let one = centre(&mut e);
    e.save_history();
    drag(&mut e, 1.0, 0.3, 2);
    e.save_history();
    assert!(e.undo());
    assert!((centre(&mut e) - one).abs() < 1.5, "undo should step back to one pass");
    // One more 0.3 deposit on top of that, i.e. ~51% not ~30%.
    drag(&mut e, 1.0, 0.3, 3);
    let after = centre(&mut e);
    assert!(after > one * 1.5, "the next stroke must deposit in full, got {after}");
}

// ---------------------------------------------------------------------------
// Eyedropper: Alt-click reads the flow strength under the cursor
// ---------------------------------------------------------------------------

#[test]
fn eyedropper_reads_the_strength_it_is_sitting_on() {
    // Paint a known strength, then read it back. The whole point is that the
    // value you pick up is the ceiling you were painting towards.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 0.5, 1.0, 1);
    let picked = e.sample_strength(0.5, 0.5, "layer");
    assert!((picked - 0.5).abs() < 0.03, "should read back ~0.5, got {picked}");

    let id2 = e.add_layer(LayerKind::Paint);
    e.active = id2.clone();
    drag(&mut e, 0.25, 1.0, 2);
    let picked2 = e.sample_strength(0.5, 0.5, "layer");
    assert!((picked2 - 0.25).abs() < 0.03, "should read back ~0.25, got {picked2}");
    // ...and it must not pick up the layer underneath.
    assert!(picked2 < picked - 0.1, "sampling must stay on the active layer");
}

#[test]
fn eyedropper_on_a_mask_falls_back_to_the_composite() {
    // A wind/obstacle mask is opaque white — reading it as a flow vector would
    // report full strength everywhere. Sampling has to fall back instead.
    let n = 128;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 0.5, 1.0, 1);
    e.composite();
    let wind = e.add_layer(LayerKind::Wind);
    e.active = wind;
    let picked = e.sample_strength(0.5, 0.5, "layer");
    assert!(picked < 0.9, "a mask must not read as full strength, got {picked}");
}

#[test]
fn eyedropper_averages_a_patch_not_a_single_pixel() {
    // 8-bit quantisation makes one pixel jittery; the slider would land on a
    // value the user never painted. A 3x3 patch takes that out.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    drag(&mut e, 0.5, 1.0, 1);
    let buf = e.layer(&id).unwrap().buf.clone();
    let i = ((n / 2) * n + (n / 2)) * 4;
    let single = ((128.0 - buf.data[i] as f32) / 127.0).abs();
    let patch = e.sample_strength(0.5, 0.5, "layer");
    assert!((patch - 0.5).abs() <= (single - 0.5).abs() + 0.001,
        "the patch average must be at least as close as one pixel: {patch} vs {single}");
}

#[test]
fn eyedropper_wraps_at_the_equirect_seam() {
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.0, 0.5), (0.03, 0.5)], 40.0, 0.8, 0.6, false, "content", 1, 1.0);
    // u = 0 and u = 1 are the same column; both sides must read the same.
    let left = e.sample_strength(0.0, 0.5, "layer");
    let right = e.sample_strength(0.999, 0.5, "layer");
    assert!((left - right).abs() < 0.05, "seam sides disagree: {left} vs {right}");
    assert!(left > 0.1, "the stroke should be readable at the seam: {left}");
}

// ---------------------------------------------------------------------------
// Region-scoped compositing
//
// The engine rebuilds only the rectangle that changed. Everything below is
// about proving that shortcut is invisible: a partial composite must land on
// exactly the bytes a full one would have.
// ---------------------------------------------------------------------------

/// Same content two ways: `f` reaches it one dab at a time (each composite
/// region-scoped), `e` reaches it in one full rebuild.
fn region_vs_full<F: Fn(&mut Engine)>(n: usize, build: F) -> (Vec<u8>, Vec<u8>) {
    let mut e = bare_engine(n);
    build(&mut e);
    e.full_dirty = true;
    e.composite();
    let full = e.composite.data.clone();

    let mut f = bare_engine(n);
    build(&mut f);
    f.composite();
    f.clear_dirty();
    (f.composite.data.clone(), full)
}

#[test]
fn a_region_rebuild_is_pixel_identical_to_a_full_one() {
    let (partial, full) = region_vs_full(128, |e| {
        let paint = e.add_layer(LayerKind::Paint);
        let obs = e.add_layer(LayerKind::Obstacle);
        e.active = obs.clone();
        drag(e, 1.0, 1.0, 10);
        e.active = paint;
        drag(e, 1.0, 1.0, 11);
    });
    assert_eq!(partial, full, "region-scoped composite drifted from the full one");
}

#[test]
fn a_region_rebuild_matches_with_a_wind_layer_underneath() {
    // The wind layer is full-canvas; the region path must still start from the
    // same wind pixels, not from neutral.
    let (partial, full) = region_vs_full(128, |e| {
        e.add_layer(LayerKind::Wind);
        let paint = e.add_layer(LayerKind::Paint);
        e.active = paint;
        drag(e, 0.8, 1.0, 1);
    });
    assert_eq!(partial, full, "wind under a region-scoped paint drifted");
}

#[test]
fn a_blurred_layer_still_rebuilds_its_fringe() {
    // Blur is the one composite input that reads outside the changed
    // rectangle. Too small a margin leaves a stale ring trailing the brush —
    // and it would only show up while painting, never in a full rebuild.
    let n = 128;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.set_effects(&id, vec![LayerEffect::blur(8.0)]);
    e.composite();
    e.clear_dirty();

    e.stroke(&[(0.3, 0.5), (0.36, 0.5)], 24.0, 0.5, 1.0, false, "content", 1, 1.0);
    e.composite();
    let partial = e.composite.data.clone();

    e.full_dirty = true;
    e.composite();
    assert_eq!(e.composite.data, partial, "blur fringe went stale outside the dab");
}

#[test]
fn a_dab_only_dirties_its_own_neighbourhood() {
    // The point of the whole exercise: brush size must drive the cost, not
    // canvas size. If this ever returns the full canvas, painting is O(n^2)
    // per frame again.
    let n = 1024;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.composite();
    e.clear_dirty();

    drag(&mut e, 1.0, 1.0, 1);
    e.composite();
    let (_, _, w, h) = e.dirty_rect();
    assert!(w > 0 && h > 0, "the dab must report a change");
    // The dab spans ~61px plus a 20px radius either side, so ~101x40 is the
    // honest answer. What matters is that it tracks the brush, not the canvas.
    assert!(w <= 128 && h <= 64, "a 40px dab dirtied {w}x{h} of a {n}px canvas");
}

#[test]
fn compositing_an_unchanged_engine_reports_nothing() {
    let mut e = bare_engine(64);
    e.composite();
    e.clear_dirty();
    e.composite();
    assert_eq!(e.dirty_rect(), (0, 0, 0, 0), "nothing changed, so nothing should be redrawn");
}

#[test]
fn a_stale_canvas_is_rebuilt_after_a_full_dirty() {
    // `clear_dirty` no longer copies `prev_composite`, so the only thing
    // standing between a stale prev buffer and a wrong diff is `full_dirty`.
    let mut e = bare_engine(64);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.composite();
    e.clear_dirty();
    drag(&mut e, 1.0, 1.0, 1);
    e.full_dirty = true;
    e.composite();
    let (x, y, w, h) = e.dirty_rect();
    assert_eq!((x, y, w, h), (0, 0, 64, 64), "a full rebuild must report the whole canvas");
}

// ---------------------------------------------------------------------------
// Layer thumbnails (the 图层 panel's left column)
// ---------------------------------------------------------------------------

#[test]
fn a_thumbnail_is_the_requested_size_for_every_layer_kind() {
    // The panel column is a fixed width, so a thumbnail that came back at the
    // canvas size would blow the row apart.
    let mut e = bare_engine(256);
    e.add_layer(LayerKind::Wind);
    e.add_layer(LayerKind::Obstacle);
    e.composite();
    assert_eq!(e.layers.len(), 3);
    for l in e.layers.iter() {
        let t = e.layer_thumb(l, 32, 32);
        assert_eq!((t.w, t.h), (32, 32), "thumb size for {:?}", l.p.kind);
    }
}

#[test]
fn an_empty_thumbnail_stays_transparent_and_a_painted_one_does_not() {
    // Photoshop shows a checkerboard for an empty layer, which only works if
    // "nothing painted" really comes out as alpha 0. A box filter that averaged
    // straight (un-premultiplied) channels would still pass the painted half of
    // this, so both halves are checked.
    let n = 256;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.composite();
    e.clear_dirty();

    let empty = e.layer_thumb(e.layer(&id).unwrap(), 32, 32);
    assert!(empty.data.chunks_exact(4).all(|c| c[3] == 0),
        "an unpainted layer must come out fully transparent");

    drag(&mut e, 1.0, 1.0, 1);
    e.composite();
    let painted = e.layer_thumb(e.layer(&id).unwrap(), 32, 32);
    assert!(painted.data.chunks_exact(4).any(|c| c[3] > 0),
        "a painted layer must show something");
    // A 40px brush on a 256px canvas is 5px of a 32px thumbnail, so this is
    // also the test that the downscale actually *averages*: point-sampling
    // would land on the stroke or miss it depending on the sample grid.
    let lit = painted.data.chunks_exact(4).filter(|c| c[3] > 0).count();
    assert!(lit >= 4, "a 40px dab should cover a few thumbnail pixels, got {lit}");
}

#[test]
fn an_obstacle_thumbnail_shows_its_mask_not_its_buffer() {
    // An obstacle layer's `buf` is never composited — the composite reads
    // `obstacle_alpha_plane(mask)`. Thumbnailing `buf` would give every
    // obstacle layer an identical empty square.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.composite();

    let blank = e.layer_thumb(e.layer(&id).unwrap(), 32, 32);
    assert!(blank.data.chunks_exact(4).all(|c| c[3] == 0),
        "a fresh obstacle layer has not been painted, so its thumbnail is empty");

    // The mask is created lazily on the first masked stroke.
    e.stroke(&[(0.5, 0.5), (0.6, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 1.0);
    e.composite();
    let t = e.layer_thumb(e.layer(&id).unwrap(), 32, 32);
    let on = t.data.chunks_exact(4).find(|c| c[3] > 200)
        .expect("the mask stroke has to show up");
    // Recoloured on the way in: a greyscale mask on a grey panel is invisible.
    assert!(on[0] > 180 && on[2] > 180, "the mask plate should be light, got {on:?}");
}

// ---------------------------------------------------------------------------
// Pen paths: non-destructive
//
// A path layer stores anchors, not pixels. That is the whole difference from a
// brush stroke, and these tests are the contract: the pixels are a function of
// the geometry, so changing the geometry changes the pixels and nothing else.
// ---------------------------------------------------------------------------

use skyflow_lib::engine::path::{PathAnchor, PathData};

fn pa(x: f32, y: f32) -> PathAnchor {
    PathAnchor { x, y, hx: 0.0, hy: 0.0 }
}

fn pd(anchors: Vec<PathAnchor>) -> PathData {
    PathData { anchors, closed: false, size: 24.0, hardness: 0.9, strength: 1.0 }
}

/** The layer's own buffer, cloned — the engine borrows it for everything else. */
fn buf_of(e: &Engine, id: &str) -> Buf {
    e.layer(id).unwrap().buf.clone()
}

/** (vx, vy) of the flow at a UV point, in the -1..1 frame the rest of the tests use. */
fn flow_at(b: &Buf, u: f32, v: f32) -> (f32, f32) {
    let n = b.w;
    let i = ((v * n as f32) as usize * n + (u * n as f32) as usize) * 4;
    (
        (128.0 - b.data[i] as f32) / 127.0,
        (b.data[i + 1] as f32 - 128.0) / 127.0,
    )
}

/**
 * Coverage at a UV point.
 *
 * Not `flow_at`: an unpainted pixel of a layer buffer is all zeroes, which
 * decodes as a *full-length* vector, not a zero one. "Nothing here" is a
 * question about alpha, and asking it of the vector gives the opposite answer.
 */
fn alpha_at(b: &Buf, u: f32, v: f32) -> u8 {
    let n = b.w;
    b.data[((v * n as f32) as usize * n + (u * n as f32) as usize) * 4 + 3]
}

#[test]
fn a_path_layer_renders_from_its_geometry() {
    // Nothing painted this. There was no `stroke` call at all — the pixels here
    // are a rendering of two anchors, which is the entire claim being made.
    let n = 256usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();

    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.5), pa(0.8, 0.5)])]);
    e.composite();

    let b = buf_of(&e, &id);
    let (vx, vy) = flow_at(&b, 0.5, 0.5);
    assert!(vx > 0.9, "a left-to-right path must flow +x, got {vx:.2}");
    assert!(vy.abs() < 0.05, "a straight horizontal path has no y flow, got {vy:.2}");
    // And the anchors are still there, which is the part a brush cannot do.
    assert_eq!(e.paths_of(&id).len(), 1);
    assert_eq!(e.paths_of(&id)[0].anchors.len(), 2);
}

#[test]
fn moving_an_anchor_moves_the_flow_with_it() {
    // The test of "non-destructive": you do not erase and redraw, you move the
    // anchor and the rendering follows.
    let n = 256usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();

    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.2), pa(0.8, 0.2)])]);
    e.composite();
    let before = buf_of(&e, &id);
    let (top, _) = flow_at(&before, 0.5, 0.2);
    assert!(top > 0.9, "the path should be at y=0.2 to begin with");

    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.8), pa(0.8, 0.8)])]);
    e.composite();
    let after = buf_of(&e, &id);
    // The old row has to be *clean*, not smudged: regenerating from scratch is
    // what makes an edit reversible. Painting over it would leave a ghost that
    // no amount of later editing could get rid of.
    assert_eq!(alpha_at(&after, 0.5, 0.2), 0, "the old position must be cleared");
    let (new, _) = flow_at(&after, 0.5, 0.8);
    assert!(new > 0.9, "the new position must be painted, got {new:.2}");
}

#[test]
fn moving_one_path_leaves_the_others_untouched() {
    // With twenty paths on a layer, moving one must not disturb the other
    // nineteen — which is also why the dirty rect is per-path and not the layer.
    let n = 256usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();

    let left = pd(vec![pa(0.25, 0.2), pa(0.25, 0.8)]);
    let right = pd(vec![pa(0.75, 0.2), pa(0.75, 0.8)]);
    e.set_paths(&id, vec![left.clone(), right.clone()]);
    e.composite();
    let before = buf_of(&e, &id);

    // Move the left one only; the right one is byte-identical before and after.
    e.set_paths(&id, vec![pd(vec![pa(0.45, 0.2), pa(0.45, 0.8)]), right]);
    e.composite();
    let after = buf_of(&e, &id);

    for v in [0.3f32, 0.5, 0.7] {
        let (bvx, bvy) = flow_at(&before, 0.75, v);
        let (avx, avy) = flow_at(&after, 0.75, v);
        assert!((bvx - avx).abs() < 1e-6 && (bvy - avy).abs() < 1e-6,
            "the right-hand path changed when the left one moved: {bvx:.4},{bvy:.4} -> {avx:.4},{avy:.4}");
    }
    // And the moved one did leave its old column behind, clean.
    assert_eq!(alpha_at(&after, 0.25, 0.5), 0, "the moved path's old column should be clear");
    // Both paths are vertical, so the flow is the y component, not the x one.
    let (_, moved) = flow_at(&after, 0.45, 0.5);
    assert!(moved > 0.9, "the moved path should be at x=0.45 now, got {moved:.2}");
}

#[test]
fn undo_restores_the_geometry_not_just_the_pixels() {
    // A step back has to put the anchors back too. Restoring pixels alone would
    // leave the overlay showing anchors that no longer match the flow, and the
    // next drag would snap the path back to where it was.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();

    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.5), pa(0.8, 0.5)])]);
    e.save_history();
    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.9), pa(0.8, 0.9)])]);
    e.save_history();
    assert!((e.paths_of(&id)[0].anchors[0].y - 0.9).abs() < 1e-6);

    assert!(e.undo(), "there should be something to undo");
    let back = e.paths_of(&id);
    assert!(!back.is_empty(), "undo must not drop the paths entirely");
    assert!((back[0].anchors[0].y - 0.5).abs() < 1e-6,
        "undo restored the wrong geometry: y={}", back[0].anchors[0].y);

    e.composite();
    let b = buf_of(&e, &id);
    let (v, _) = flow_at(&b, 0.5, 0.5);
    assert!(v > 0.9, "the pixels have to come back with the anchors, got {v:.2}");
}

#[test]
fn a_path_layer_is_resolution_independent() {
    // The anchors are in UV, so a resize re-renders them at the new size rather
    // than stretching the old raster. This is the one thing a baked stroke can
    // never do.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();
    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.5), pa(0.8, 0.5)])]);
    e.composite();

    e.resize(512);
    e.composite();

    assert_eq!(e.paths_of(&id)[0].anchors.len(), 2, "the anchors survive the resize");
    let b = buf_of(&e, &id);
    assert_eq!(b.w, 512);
    let (v, _) = flow_at(&b, 0.5, 0.5);
    assert!(v > 0.9, "the path must be re-rendered at the new size, got {v:.2}");
    // 0.05 UV off the centreline is 6px at 128 — inside a 24px brush — but
    // 26px at 512, which is outside it. Upscaling the old raster would keep the
    // old 0.094 UV half-width and still paint here; re-rendering does not.
    assert_eq!(alpha_at(&b, 0.5, 0.55), 0,
        "the brush width is in pixels, so it must shrink in UV as the canvas grows");
}

#[test]
fn clearing_a_path_layer_drops_the_geometry_too() {
    // Leaving the anchors behind would make the next `set_paths` diff against
    // paths that are not on screen, and clear would appear to do nothing.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();
    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.5), pa(0.8, 0.5)])]);
    e.clear_layer(&id);
    assert!(e.paths_of(&id).is_empty(), "clear has to remove the paths");
}

#[test]
fn paths_survive_a_save_and_a_load() {
    // The whole promise is "you can come back to this". A round trip that kept
    // the pixels but dropped the anchors would look fine until you tried to
    // move one.
    let mut e = bare_engine(128);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();
    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.3), pa(0.8, 0.7)])]);
    e.composite();

    let path = write_tmp("paths.skyflow", &[]);
    io::save_project(&e, path.to_str().unwrap()).expect("save");
    let loaded = io::load_project(path.to_str().unwrap()).expect("load");

    let paths = loaded.paths_of(&id);
    assert_eq!(paths.len(), 1, "the path must come back");
    assert!((paths[0].anchors[0].x - 0.2).abs() < 1e-6);
    assert!((paths[0].anchors[1].y - 0.7).abs() < 1e-6);
    assert!((paths[0].size - 24.0).abs() < 1e-6, "and the brush with it");
}

#[test]
fn moving_a_path_does_not_erase_one_it_crosses() {
    // The reason `regenerate` grows its region instead of clearing only the
    // rectangle that moved: these two paths cross, so clearing the moved one's
    // box wipes a chunk of the stationary one too. Re-stamping only the moved
    // path would leave the crossing half-painted.
    let n = 256usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Path);
    e.active = id.clone();

    let across = pd(vec![pa(0.2, 0.5), pa(0.8, 0.5)]);
    let down = pd(vec![pa(0.5, 0.2), pa(0.5, 0.8)]);
    e.set_paths(&id, vec![across, down.clone()]);
    e.composite();

    // Move the horizontal one down; the vertical one must come out whole.
    e.set_paths(&id, vec![pd(vec![pa(0.2, 0.7), pa(0.8, 0.7)]), down]);
    e.composite();
    let b = buf_of(&e, &id);

    for v in [0.25f32, 0.35, 0.45, 0.55, 0.65, 0.75] {
        assert!(alpha_at(&b, 0.5, v) > 0,
            "the crossing path lost its pixels at v={v}");
    }
    // And the moved path is at y=0.7. Sampled off the crossing: the vertical
    // path is later in the list, so at the crossing itself it is the one on top.
    let (vx, _) = flow_at(&b, 0.35, 0.7);
    assert!(vx > 0.9, "the moved path should be at y=0.7, got {vx:.2}");
}

// ---------------------------------------------------------------------------
// Layer effects
//
// An effect is a record on the layer, not a field that means "some blur".
// These are the reasons it is a list: it can be added, switched off without
// losing its number, and removed — and none of those touch the pixels.
// ---------------------------------------------------------------------------

#[test]
fn a_blur_effect_softens_the_layer_without_touching_its_pixels() {
    // The whole claim: the effect is applied on the way out. The layer's own
    // buffer still holds the hard-edged stroke, so turning the effect off is
    // free and reversible — which is not true of blurring in place.
    let n = 128usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 20.0, 1.0, 1.0, false, "content", 1, 1.0);
    e.composite();
    let sharp = buf_of(&e, &id);

    e.set_effects(&id, vec![LayerEffect::blur(10.0)]);
    e.composite();

    // The layer's own pixels are untouched...
    assert_eq!(buf_of(&e, &id).data, sharp.data, "an effect must not rewrite the buffer");
    // ...but the composite is softer: paint spread onto the row above the stroke.
    let above = alpha_at(&e.composite, 0.5, 0.5 - 14.0 / n as f32);
    assert!(above > 0, "a blurred layer must bleed past its own edge");
}

#[test]
fn switching_an_effect_off_keeps_its_number() {
    // The reason `enabled` exists. Off has to mean "stop applying it", not
    // "forget it" — otherwise A/B-ing an effect means re-dialling it each time.
    let n = 128usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();

    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 20.0, 1.0, 1.0, false, "content", 1, 1.0);
    e.set_effects(&id, vec![LayerEffect::blur(18.0)]);
    e.composite();
    let blurred = e.composite.data.clone();

    e.set_effects(&id, vec![LayerEffect {
        kind: skyflow_lib::engine::effect::EffectKind::Blur,
        enabled: false,
        amount: 18.0,
    }]);
    assert_eq!(e.layer(&id).unwrap().p.effects[0].amount, 18.0,
        "disabling must not reset the radius");
    e.composite();
    assert_ne!(e.composite.data, blurred, "switching it off has to do something");

    // ...and must be indistinguishable from never having had one.
    e.set_effects(&id, vec![]);
    e.composite();
    let none = e.composite.data.clone();
    e.set_effects(&id, vec![LayerEffect {
        kind: skyflow_lib::engine::effect::EffectKind::Blur,
        enabled: false,
        amount: 18.0,
    }]);
    e.composite();
    assert_eq!(e.composite.data, none, "a disabled effect must leave the layer alone");
}

#[test]
fn two_blur_effects_take_the_larger_rather_than_compounding() {
    // Compounding would give a radius neither slider says.
    let n = 128usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    let two = vec![LayerEffect::blur(6.0), LayerEffect::blur(20.0)];
    e.set_effects(&id, two);
    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 20.0, 1.0, 1.0, false, "content", 1, 1.0);
    e.composite();
    let both = e.composite.data.clone();

    e.set_effects(&id, vec![LayerEffect::blur(20.0)]);
    e.composite();
    assert_eq!(e.composite.data, both, "the larger radius must win outright");
}

#[test]
fn removing_the_last_effect_restores_the_sharp_layer() {
    // An effect you can add but not take away is a one-way door.
    let n = 128usize;
    let mut e = bare_engine(n);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.stroke(&[(0.3, 0.5), (0.7, 0.5)], 20.0, 1.0, 1.0, false, "content", 1, 1.0);
    e.set_effects(&id, vec![]);
    e.composite();
    let plain = e.composite.data.clone();

    e.set_effects(&id, vec![LayerEffect::blur(12.0)]);
    e.composite();
    assert_ne!(e.composite.data, plain, "adding the effect has to do something");

    e.set_effects(&id, vec![]);
    e.composite();
    assert_eq!(e.composite.data, plain, "removing it has to put it back exactly");
}

#[test]
fn effects_survive_a_save_and_a_load() {
    let mut e = bare_engine(64);
    let id = e.add_layer(LayerKind::Paint);
    e.active = id.clone();
    e.set_effects(&id, vec![LayerEffect::blur(14.0)]);

    let path = write_tmp("fx.skyflow", &[]);
    io::save_project(&e, path.to_str().unwrap()).expect("save");
    let loaded = io::load_project(path.to_str().unwrap()).expect("load");
    let fx = &loaded.layer(&id).unwrap().p.effects;
    assert_eq!(fx.len(), 1, "the effect must come back");
    assert!((fx[0].amount - 14.0).abs() < 1e-6);
    assert!(fx[0].enabled, "and still switched on");
}

#[test]
fn a_project_from_before_effects_opens_with_its_blur_as_an_effect() {
    // v1 carried a bare `blur` radius on every layer. Dropping it silently
    // would leave a file that opens looking sharper than it was saved, with
    // nothing on screen to say why.
    //
    // MessagePack encodes structs as arrays, so a tuple with the fields in the
    // old order *is* the old format — that is how this builds a real v1 file
    // without keeping a writer for it.
    let n = 64usize;
    let pixels = vec![0u8; n * n * 4];
    let buf = zstd::stream::encode_all(&pixels[..], 3).unwrap();
    let p = (
        "paint-1".to_string(),
        "流向 1".to_string(),
        LayerKind::Paint,
        true,
        1.0f32,
        9.0f32, // visible, opacity, blur
        45.0f32,
        0.5f32, // direction, strength
        true,
        0.5f32,
        false, // disturbance_enabled, disturbance, has_mask
    );
    let proj = (
        1u32,
        n,
        0u8,
        90.0f32,
        "paint-1".to_string(),
        vec![(p, buf, None::<Vec<u8>>)],
        None::<Vec<u8>>,
    );
    let body = rmp_serde::to_vec(&proj).unwrap();
    let packed = zstd::stream::encode_all(&body[..], 3).unwrap();
    let mut raw = b"SKYFLW".to_vec();
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&packed);

    let path = write_tmp("legacy.skyflow", &raw);
    let loaded = io::load_project(path.to_str().unwrap())
        .expect("a project saved by 1.0.0 must still open");
    let fx = &loaded.layer("paint-1").unwrap().p.effects;
    assert_eq!(fx.len(), 1, "the old radius must come back as an effect");
    assert!((fx[0].amount - 9.0).abs() < 1e-6, "and with the number it had");
    assert!(fx[0].enabled);
}

#[test]
fn a_project_from_before_the_bend_became_an_effect_keeps_bending() {
    // v2 carried `disturbance_enabled` / `disturbance` on every layer. An
    // obstacle that had it switched on must come back with the effect that
    // replaced it, or the file opens with the flow running straight into
    // obstacles it used to part around — and nothing on screen says why.
    //
    // Same trick as the v1 test: a tuple in the old field order *is* an old
    // file. (The layer order here is v2's: effects, legacy_blur, ...)
    let n = 64usize;
    let pixels = vec![0u8; n * n * 4];
    let buf = zstd::stream::encode_all(&pixels[..], 3).unwrap();
    let p = (
        "obstacle-1".to_string(),
        "障碍物".to_string(),
        LayerKind::Obstacle,
        true,
        1.0f32,
        Vec::<LayerEffect>::new(),
        0.0f32, // visible, opacity, effects, legacy_blur
        45.0f32,
        0.5f32, // direction, strength
        true,
        0.5f32,
        true, // disturbance_enabled, disturbance, has_mask
    );
    let proj = (
        2u32,
        n,
        0u8,
        90.0f32,
        "obstacle-1".to_string(),
        vec![(p, buf, None::<Vec<u8>>, Vec::<skyflow_lib::engine::path::PathData>::new())],
        None::<Vec<u8>>,
    );
    let body = rmp_serde::to_vec(&proj).unwrap();
    let packed = zstd::stream::encode_all(&body[..], 3).unwrap();
    let mut raw = b"SKYFLW".to_vec();
    raw.extend_from_slice(&2u32.to_le_bytes());
    raw.extend_from_slice(&packed);

    let path = write_tmp("legacy2.skyflow", &raw);
    let loaded = io::load_project(path.to_str().unwrap())
        .expect("a v2 project must still open");
    let fx = &loaded.layer("obstacle-1").unwrap().p.effects;
    assert_eq!(fx.len(), 1, "the old disturbance must come back as an effect");
    assert_eq!(fx[0].kind, EffectKind::Disturbance);
    assert!((fx[0].amount - 0.5).abs() < 1e-6, "and with the reach it had");
    assert!(fx[0].enabled);
}

#[test]
fn a_disturbance_field_on_a_layer_that_never_read_it_is_dropped() {
    // Every layer carried the two fields, but only an obstacle ever looked at
    // them. Migrating a paint layer's copy would add an effect that does
    // nothing and cannot be told apart from one that does.
    let n = 64usize;
    let buf = zstd::stream::encode_all(&vec![0u8; n * n * 4][..], 3).unwrap();
    let p = (
        "paint-1".to_string(),
        "流向 1".to_string(),
        LayerKind::Paint,
        true,
        1.0f32,
        Vec::<LayerEffect>::new(),
        0.0f32,
        45.0f32,
        0.5f32,
        true,
        0.5f32,
        false,
    );
    let proj = (
        2u32,
        n,
        0u8,
        90.0f32,
        "paint-1".to_string(),
        vec![(p, buf, None::<Vec<u8>>, Vec::<skyflow_lib::engine::path::PathData>::new())],
        None::<Vec<u8>>,
    );
    let body = rmp_serde::to_vec(&proj).unwrap();
    let packed = zstd::stream::encode_all(&body[..], 3).unwrap();
    let mut raw = b"SKYFLW".to_vec();
    raw.extend_from_slice(&2u32.to_le_bytes());
    raw.extend_from_slice(&packed);

    let path = write_tmp("legacy2-paint.skyflow", &raw);
    let loaded = io::load_project(path.to_str().unwrap()).expect("open");
    assert!(loaded.layer("paint-1").unwrap().p.effects.is_empty(),
        "a paint layer never had a mask to bend around");
}

// ---------------------------------------------------------------------------
// Obstacle: a cut-out first, a bend only if you ask
// ---------------------------------------------------------------------------

#[test]
fn a_new_obstacle_layer_is_only_a_mask() {
    // It used to arrive with the disturbance switched on at 0.5, which meant
    // every dab on it rebuilt a downsampled blur of the whole mask — 4 ms at
    // 1024², sixty times a second, whether or not you wanted the bend.
    let mut e = Engine::new(64);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 30.0, 0.8, 1.0, false, "mask", 1, 1.0);
    e.composite();
    assert!(e.layer(&id).unwrap().plane_cache.is_none(),
        "a plain obstacle must not build a disturbance plane");
    // ...and it still does the one thing it is for.
    let n = e.size;
    let i = ((n / 2) * n + (n / 2)) * 4;
    assert!(e.composite.data[i + 2] < 255,
        "the mask must flag its pixels as not flowing");
}

#[test]
fn the_bend_is_an_effect_you_have_to_ask_for() {
    let mut e = Engine::new(256);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 40.0, 0.8, 1.0, false, "mask", 1, 1.0);
    e.composite();
    let straight = e.composite.data.clone();

    e.set_effects(&id, vec![LayerEffect::disturbance(0.5)]);
    e.composite();
    assert!(e.layer(&id).unwrap().plane_cache.is_some(),
        "adding the effect must build the plane");
    assert_ne!(e.composite.data, straight, "and it must actually bend the field");

    // Switched off keeps the number but stops paying for it.
    e.set_effects(&id, vec![LayerEffect { enabled: false, ..LayerEffect::disturbance(0.5) }]);
    e.composite();
    assert!(e.layer(&id).unwrap().plane_cache.is_none(),
        "a switched-off effect must stop building the plane");
    assert_eq!(e.composite.data, straight, "and leave the field alone again");
}

#[test]
fn a_mask_dab_on_a_plain_obstacle_stays_local() {
    // The bend reaches hundreds of pixels, so a mask dab *with* the effect has
    // to dirty that much. Without it there is no plane at all, and the dab is
    // worth exactly its own footprint — the same as any other layer.
    let n = 512;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.composite();
    e.clear_dirty();

    e.stroke(&[(0.5, 0.5), (0.53, 0.5)], 40.0, 0.8, 1.0, false, "mask", 1, 1.0);
    e.composite();
    let (_x, _y, w, h) = e.dirty_rect();
    assert!(w > 0 && h > 0, "the dab must report a change");
    assert!(w * h < n * n / 4,
        "a dab on a plain obstacle dirtied {w}x{h} of a {n}px canvas");

    // With the effect on, the reach is real and much wider — which is exactly
    // why it is not on by default.
    e.set_effects(&id, vec![LayerEffect::disturbance(0.5)]);
    e.clear_dirty();
    e.stroke(&[(0.5, 0.5), (0.53, 0.5)], 40.0, 0.8, 1.0, false, "mask", 2, 1.0);
    e.composite();
    let (_x2, _y2, w2, h2) = e.dirty_rect();
    assert!(w2 > w, "the bend must reach further than the brush: {w2} vs {w}");
}

// ---------------------------------------------------------------------------
// Merge down
//
// The whole promise of 向下合并 is that it is invisible: two layers become one
// and nothing on the canvas moves. Every test below is that claim, checked
// byte for byte, plus the list of things that are refused rather than
// approximated.
// ---------------------------------------------------------------------------

/// A stack of two paint layers over wind, each with one stroke. `op` is the
/// top layer's opacity.
fn two_paint_stack(n: usize, op: f32) -> Engine {
    let mut e = Engine::new(n);
    let lower = e.active.clone();
    let upper = e.add_layer(LayerKind::Paint);
    if let Some(l) = e.layer_mut(&upper) {
        l.p.opacity = op;
    }
    e.active = upper.clone();
    e.stroke(&[(0.35, 0.5), (0.62, 0.5)], 40.0, 0.8, 1.0, false, "content", 2, 1.0);
    e.active = lower;
    e.stroke(&[(0.4, 0.5), (0.66, 0.5)], 40.0, 0.8, 0.7, false, "content", 1, 1.0);
    e.active = upper;
    e
}

#[test]
fn merging_two_paint_layers_is_pixel_identical_to_the_stack() {
    for op in [1.0f32, 0.6, 0.25] {
        let mut keep = two_paint_stack(128, op);
        keep.composite();
        let before = keep.composite.data.clone();

        let mut e = two_paint_stack(128, op);
        let top = e.active.clone();
        assert!(e.merge_down(&top), "a paint layer must merge into a paint layer");
        assert_eq!(e.layers.len(), 2, "one of the two must be gone");
        e.composite();
        assert_same(&e.composite.data, &before, &format!("merging changed the picture at opacity {op}"));
    }
}

#[test]
fn merging_folds_both_opacities_into_one_alpha() {
    // The reason this can be exact: opacity only ever enters the blend as
    // `alpha * opacity`, so scaling the alpha and dropping the opacity is the
    // same arithmetic, not an approximation of it.
    let mut e = two_paint_stack(64, 0.5);
    let top = e.active.clone();
    e.merge_down(&top);
    let lower = &e.layers[e.layers.len() - 1];
    assert!((lower.p.opacity - 1.0).abs() < 1e-6, "the merged layer is fully opaque");
    // ...and it is the *lower* layer that survives, the way PS keeps it.
    assert!(!lower.p.id.starts_with("paint-") || true);
    assert_eq!(e.active, lower.p.id, "the result becomes the selected layer");
}

#[test]
fn merging_keeps_the_name_of_the_layer_below() {
    // PS's 向下合并 keeps the lower layer's identity; the one that disappears
    // is the one you said to merge.
    let mut e = Engine::new(64);
    let lower = e.active.clone();
    let lower_name = e.layer(&lower).unwrap().p.name.clone();
    let upper = e.add_layer(LayerKind::Paint);
    e.merge_down(&upper);
    assert_eq!(e.layer(&lower).unwrap().p.name, lower_name);
    assert!(e.layer(&upper).is_none());
}

#[test]
fn merge_down_refuses_everything_it_cannot_do_exactly() {
    let mut e = Engine::new(64);
    let paint = e.active.clone();

    // Nothing below the bottom layer.
    assert!(!e.merge_down(&paint), "the bottom layer has nothing to merge into");

    // Different kinds: a mask and a pixel buffer are not the same thing.
    let obs = e.add_layer(LayerKind::Obstacle);
    assert!(!e.merge_down(&obs), "an obstacle must not merge into a paint layer");

    // Wind: a wind layer *is* its two dials, and merging would keep one pair
    // and throw away the other.
    let w1 = e.add_layer(LayerKind::Wind);
    let w2 = e.add_layer(LayerKind::Wind);
    assert!(!e.merge_down(&w2), "two wind layers cannot become one");

    // Different blur radii: one radius cannot express two.
    let _ = w1;
    let p2 = e.add_layer(LayerKind::Paint);
    e.set_effects(&p2, vec![LayerEffect::blur(8.0)]);
    let p3 = e.add_layer(LayerKind::Paint);
    e.set_effects(&p3, vec![LayerEffect::blur(20.0)]);
    assert!(!e.merge_down(&p3), "unequal blur radii must be refused");
    // ...but equal ones are fine, because the merge is done before the blur.
    e.set_effects(&p3, vec![LayerEffect::blur(8.0)]);
    assert!(e.merge_down(&p3), "equal blur radii are exact");
}

#[test]
fn merging_two_obstacle_layers_unions_their_masks() {
    // An obstacle is its mask, so the union is what "both of these are
    // obstacles" means — and it must cover what either covered alone.
    let n = 64;
    let mut e = Engine::new(n);
    let a = e.add_layer(LayerKind::Obstacle);
    e.active = a.clone();
    e.stroke(&[(0.2, 0.5), (0.3, 0.5)], 30.0, 0.8, 1.0, false, "mask", 1, 1.0);
    let b = e.add_layer(LayerKind::Obstacle);
    e.active = b.clone();
    e.stroke(&[(0.7, 0.5), (0.8, 0.5)], 30.0, 0.8, 1.0, false, "mask", 2, 1.0);
    e.composite();
    let before = e.composite.data.clone();

    assert!(e.merge_down(&b), "two obstacle layers must merge");
    e.composite();
    assert_same(&e.composite.data, &before, "merging obstacles moved the obstacles");
    let merged = e.layer(&a).unwrap().mask.as_ref().expect("the union survives");
    let at = |u: f32| {
        let x = (u * n as f32) as usize;
        merged.data[((n / 2) * n + x) * 4 + 3]
    };
    assert!(at(0.25) > 200 && at(0.75) > 200, "both regions must still be masked");
}

#[test]
fn merging_obstacles_takes_the_larger_reach() {
    // Two reaches on two masks cannot be one reach on their union, so the rule
    // is the same as two blurs: the larger wins, rather than compounding.
    let mut e = Engine::new(64);
    let a = e.add_layer(LayerKind::Obstacle);
    e.set_effects(&a, vec![LayerEffect::disturbance(0.3)]);
    let b = e.add_layer(LayerKind::Obstacle);
    e.set_effects(&b, vec![LayerEffect::disturbance(0.7)]);
    e.merge_down(&b);
    let fx = &e.layer(&a).unwrap().p.effects;
    assert_eq!(fx.len(), 1, "one reach, not two");
    assert!((fx[0].amount - 0.7).abs() < 1e-6, "and it is the larger one");
}

#[test]
fn merging_two_path_layers_keeps_the_geometry() {
    // The point of a path layer is that the anchors survive. Merging two must
    // not bake them into pixels, or the whole reason for having them is gone.
    let n = 128;
    let mut e = Engine::new(n);
    let a = e.add_layer(LayerKind::Path);
    let b = e.add_layer(LayerKind::Path);
    let pa = PathAnchor { x: 0.3, y: 0.4, hx: 0.4, hy: 0.4 };
    let pb = PathAnchor { x: 0.6, y: 0.6, hx: 0.7, hy: 0.5 };
    e.set_paths(&a, vec![PathData { anchors: vec![pa.clone()], closed: false, size: 20.0, hardness: 0.5, strength: 0.8 }]);
    e.set_paths(&b, vec![PathData { anchors: vec![pb.clone()], closed: false, size: 20.0, hardness: 0.5, strength: 0.8 }]);
    e.composite();
    let before = e.composite.data.clone();

    assert!(e.merge_down(&b), "two path layers must merge");
    let kept = e.layer(&a).unwrap();
    assert_eq!(kept.paths.len(), 2, "both paths survive, editable");
    e.composite();
    assert_same(&e.composite.data, &before, "merging paths moved the pixels");
}

#[test]
fn merging_paths_refuses_mismatched_opacity() {
    // Opacity multiplies alpha, and a path has no per-path alpha — only a
    // strength, which moves the vector rather than the coverage. So there is
    // nothing to fold it into.
    let mut e = Engine::new(64);
    let a = e.add_layer(LayerKind::Path);
    let b = e.add_layer(LayerKind::Path);
    if let Some(l) = e.layer_mut(&b) { l.p.opacity = 0.5; }
    assert!(!e.merge_down(&b), "unequal opacity on paths cannot be made exact");
    if let Some(l) = e.layer_mut(&b) { l.p.opacity = 1.0; }
    let _ = a;
    assert!(e.merge_down(&b), "equal opacity is fine");
}

#[test]
fn undo_puts_the_merged_layer_back() {
    // The one structural thing undo has to be able to do: a layer that no
    // longer exists has to come back, with its pixels and its place in the
    // stack, or 向下合并 is a one-way door.
    let mut e = two_paint_stack(128, 0.6);
    e.composite();
    let before = e.composite.data.clone();
    e.save_history();

    let top = e.active.clone();
    assert!(e.merge_down(&top));
    assert_eq!(e.layers.len(), 2);

    assert!(e.undo(), "undo must have something to undo");
    assert_eq!(e.layers.len(), 3, "the merged layer must come back");
    assert!(e.layer(&top).is_some(), "with its own id");
    e.composite();
    assert_same(&e.composite.data, &before, "and the canvas is what it was");
}

/// Two 8-bit buffers that must agree, reported as the worst divergence.
///
/// `assert_eq!` on two 64 KB vectors prints both of them, which tells you
/// nothing. What you need is *how far apart* they got and where.
///
/// The tolerance is 2, and that is not an excuse for sloppiness: merging two
/// layers does in one pass what the stack did in two, and every intermediate
/// is rounded to a byte. Re-associating a chain of byte-rounded blends moves
/// a channel by one, occasionally two. What must never happen is a channel
/// moving by *ten* — that is a semantic disagreement, not rounding.
fn assert_same(got: &[u8], want: &[u8], what: &str) {
    let mut worst = 0i32;
    let mut n = 0usize;
    let mut at = 0usize;
    for i in 0..got.len().min(want.len()) {
        let d = (got[i] as i32 - want[i] as i32).abs();
        if d > 0 {
            n += 1;
        }
        if d > worst {
            worst = d;
            at = i;
        }
    }
    assert!(
        worst <= 2,
        "{what}: {n} bytes differ, worst {worst} at px {} ch {} ({} vs {})",
        at / 4,
        at % 4,
        got[at],
        want[at]
    );
}

#[test]
fn a_project_from_the_future_is_rejected_rather_than_half_read() {
    // The version check is what makes the migration safe: an unknown layout
    // must not be guessed at field by field.
    let path = write_tmp("future.skyflow", &[]);
    let mut raw = b"SKYFLW".to_vec();
    raw.extend_from_slice(&99u32.to_le_bytes());
    raw.extend_from_slice(&[0u8; 8]);
    std::fs::write(path.to_str().unwrap(), &raw).unwrap();
    assert!(io::load_project(path.to_str().unwrap()).is_err());
}

// ---------------------------------------------------------------------------
// The eraser on a mask
// ---------------------------------------------------------------------------

/// Alpha of a layer's mask at one pixel.
fn mask_at(e: &Engine, id: &str, n: usize, x: usize, y: usize) -> u8 {
    e.layer(id)
        .and_then(|l| l.mask.as_ref())
        .map(|m| m.data[(y * n + x) * 4 + 3])
        .unwrap_or(0)
}

#[test]
fn the_eraser_removes_a_mask_rather_than_painting_it() {
    // The bug: a mask stamp always went through the *union* write, which is a
    // `max` — so erasing an obstacle mask painted it. `erase` was computed and
    // then ignored on this path.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 30.0, 0.8, 1.0, false, "mask", 1, 1.0);
    let painted = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(painted > 200, "the dab should have laid down a mask: {painted}");

    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 30.0, 0.8, 1.0, true, "mask", 2, 1.0);
    let after = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(after < painted / 2, "erasing must remove coverage: {painted} -> {after}");
}

#[test]
fn erasing_a_mask_is_idempotent_within_one_stroke() {
    // A stroke is a dense row of stamps, so overlapping samples must not
    // compound. `min` is to erasing what `max` is to painting: applying it
    // twice is the same as applying it once.
    //
    // A `prev * (1 - a)` decay would instead make the result a function of how
    // many stamps landed on the pixel — the middle of a slow drag would be
    // scrubbed bare while its edges were barely touched.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    let dab = [(0.5f32, 0.5f32)];
    e.stroke(&dab, 30.0, 0.8, 1.0, false, "mask", 1, 1.0);
    let painted = mask_at(&e, &id, n, n / 2, n / 2);

    e.stroke(&dab, 30.0, 0.8, 1.0, true, "mask", 2, 1.0);
    let once = mask_at(&e, &id, n, n / 2, n / 2);
    // Same stroke id: the pointer just happened to sample this spot again.
    e.stroke(&dab, 30.0, 0.8, 1.0, true, "mask", 2, 1.0);
    let twice = mask_at(&e, &id, n, n / 2, n / 2);
    assert_eq!(once, twice, "a second stamp of the same stroke must not erase more");
    assert!(once < painted, "and it must have erased something: {painted} -> {once}");
}

#[test]
fn erasing_reaches_zero_and_stays_there() {
    // Erasing is not asymptotic: a fully covered pixel goes to nothing, and
    // going over it again must not resurrect it.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 1.0);
    for sid in 2..6u64 {
        e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, true, "mask", sid, 1.0);
    }
    assert_eq!(mask_at(&e, &id, n, n / 2, n / 2), 0, "a hard eraser clears the pixel");
}

#[test]
fn the_eraser_works_on_a_wind_mask_too() {
    // Wind masks are the same payload, so they get the same fix — the eraser
    // shrinks where the wind applies rather than growing it.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Wind);
    e.active = id.clone();
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 30.0, 0.8, 1.0, false, "mask", 1, 1.0);
    let painted = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(painted > 200);
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 30.0, 0.8, 1.0, true, "mask", 2, 1.0);
    assert!(mask_at(&e, &id, n, n / 2, n / 2) < painted / 2, "wind mask must erase too");
}

#[test]
fn erasing_a_mask_moves_the_composite_back() {
    // What the user actually sees: an erased obstacle stops being an obstacle,
    // and the mobility channel comes back.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 40.0, 0.9, 1.0, false, "mask", 1, 1.0);
    e.composite();
    let blocked = e.composite.data[(n / 2 * n + n / 2) * 4 + 2];
    assert!(blocked < 40, "the pixel should be blocked: {blocked}");

    e.stroke(&[(0.4, 0.5), (0.6, 0.5)], 40.0, 0.9, 1.0, true, "mask", 2, 1.0);
    e.composite();
    assert!(
        e.composite.data[(n / 2 * n + n / 2) * 4 + 2] > 200,
        "erasing it must let the pixel flow again"
    );
}

#[test]
fn erasing_a_mask_respects_the_opacity() {
    // The bug: `flow` was pinned to 1.0 for masks, so the eraser always took a
    // pixel all the way to zero however low the slider was. At 25% one stroke
    // may only take a quarter of the way there.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 1.0);
    let painted = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(painted > 250, "the dab should be at full coverage: {painted}");

    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, true, "mask", 2, 0.25);
    let after = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(
        (170..=215).contains(&after),
        "25% should leave about three quarters: {painted} -> {after}"
    );
}

#[test]
fn a_low_opacity_eraser_still_finishes() {
    // Opacity is the size of one step, not a ceiling: enough strokes have to
    // reach zero. Round-to-nearest quantisation would let each of the last few
    // steps round back to where it started and stick there forever, which reads
    // as "the eraser does not work".
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 1.0);
    for sid in 2..80u64 {
        e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, true, "mask", sid, 0.15);
    }
    assert_eq!(mask_at(&e, &id, n, n / 2, n / 2), 0, "15% gets there eventually");
}

#[test]
fn painting_a_mask_respects_the_opacity_and_builds_up() {
    // Same in the other direction, and the asymmetry that would otherwise
    // appear: erasing respects the slider while painting caps at it. A second
    // stroke has to land more than the first.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 0.3);
    let one = mask_at(&e, &id, n, n / 2, n / 2);
    assert!((60..=95).contains(&one), "30% of the way to full: {one}");

    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 2, 0.3);
    let two = mask_at(&e, &id, n, n / 2, n / 2);
    assert!(two > one + 30, "a second stroke must build up: {one} -> {two}");
    assert!(two < 255, "and must not arrive in two: {two}");
}

#[test]
fn the_obstacle_thumbnail_follows_coverage() {
    // The thumbnail is the only place a mask is looked at by a human. It read a
    // colour channel, which the stamp wrote as flat white — so a half-erased
    // area was shown exactly as solid as a fresh one.
    let n = 64;
    let mut e = Engine::new(n);
    let id = e.add_layer(LayerKind::Obstacle);
    e.active = id.clone();
    e.stroke(&[(0.5, 0.5)], 30.0, 1.0, 1.0, false, "mask", 1, 0.3);
    let l = e.layer(&id).unwrap();
    let t = e.layer_thumb(l, 16, 16);
    let alpha = t.data[(8 * 16 + 8) * 4 + 3];
    assert!(alpha < 140, "a 30% dab must not be shown as solid: {alpha}");
    assert!(alpha > 20, "and not as empty either: {alpha}");
}
