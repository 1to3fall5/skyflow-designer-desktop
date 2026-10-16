use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::engine::io;
use crate::engine::ops::Projection;
use crate::engine::effect::LayerEffect;
use crate::engine::path::PathData;
use crate::engine::{Engine, LayerKind};

pub struct AppState {
    pub engine: Mutex<Engine>,
    pub project_path: Mutex<Option<String>>,
    pub reference_path: Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct LayerInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub visible: bool,
    pub opacity: f32,
    /// What is applied to the layer after its pixels exist — the `fx` badge on
    /// the layer row. The frontend edits this list and sends it back whole.
    pub effects: Vec<LayerEffect>,
    pub direction: f32,
    pub strength: f32,
    pub disturbance_enabled: bool,
    pub disturbance: f32,
    pub has_mask: bool,
    /// The layer's pen paths. The frontend renders and edits these, so they
    /// have to travel with every snapshot — undo and redo move them too.
    pub paths: Vec<PathData>,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    /// base64 RGBA of the changed rectangle
    pub data: String,
    pub full: bool,
    /// composite wall time in milliseconds
    pub ms: f32,
    /// Fresh engine state bundled with the pixels.
    ///
    /// Every mutating command returns it so the UI can never hold a stale copy
    /// of `projection` / `polar_angle` / the layer list. Without it, callers
    /// that only pushed pixels left the React state on its initial value and
    /// the 3D preview never switched between sphere / polar / plane.
    pub state: StateResp,
}

#[derive(Serialize)]
pub struct StateResp {
    pub size: usize,
    pub active: String,
    pub projection: String,
    pub polar_angle: f32,
    pub layers: Vec<LayerInfo>,
    pub reference_path: Option<String>,
    pub project_path: Option<String>,
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct StrokeReq {
    /// UV points of the current frame's polyline (oldest first)
    pub points: Vec<(f32, f32)>,
    pub size: f32,
    pub hardness: f32,
    pub strength: f32,
    pub erase: bool,
    pub target: String,
    /// Pointer-stroke identity. Bumped by the frontend on pointer-down; the
    /// engine uses it to tell "more of the same drag" from "another pass over
    /// the same spot", which is what lets a low-strength brush build up.
    #[serde(default)]
    pub stroke_id: u64,
    /// How much of the remaining distance to `strength` one stroke covers.
    /// `strength` is the ceiling, this is the rate.
    #[serde(default = "one")]
    pub flow: f32,
}

fn one() -> f32 {
    1.0
}

#[derive(Deserialize)]
pub struct FillReq {
    pub u: f32,
    pub v: f32,
    pub threshold: f32,
    pub target: String,
}

#[derive(Deserialize)]
pub struct LayerPatch {
    pub id: String,
    pub name: Option<String>,
    pub visible: Option<bool>,
    pub opacity: Option<f32>,
    pub direction: Option<f32>,
    pub strength: Option<f32>,
    pub disturbance_enabled: Option<bool>,
    pub disturbance: Option<f32>,
}

#[derive(Deserialize)]
pub struct ExportReq {
    pub path: String,
    pub invert_x: bool,
    pub invert_y: bool,
    pub size: Option<usize>,
}

// ---------------------------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn layer_info(l: &crate::engine::LayerData) -> LayerInfo {
    LayerInfo {
        id: l.p.id.clone(),
        name: l.p.name.clone(),
        kind: match l.p.kind {
            LayerKind::Paint => "paint",
            LayerKind::Wind => "wind",
            LayerKind::Obstacle => "obstacle",
            LayerKind::Path => "path",
        }
        .into(),
        visible: l.p.visible,
        opacity: l.p.opacity,
        effects: l.p.effects.clone(),
        direction: l.p.direction,
        strength: l.p.strength,
        disturbance_enabled: l.p.disturbance_enabled,
        disturbance: l.p.disturbance,
        has_mask: l.p.has_mask,
        paths: l.paths.clone(),
    }
}

/// Composite + emit only the pixels that actually changed, plus fresh state.
///
/// Takes the Tauri state rather than a `&mut Engine` so that the same lock can
/// be released before `build_state` re-acquires it (`std::sync::Mutex` is not
/// reentrant).
fn emit(state: &State<AppState>) -> Snapshot {
    let t0 = std::time::Instant::now();
    let (x, y, w, h, data, full, ms) = {
        let mut e = state.engine.lock().unwrap();
        e.composite();
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        let (x, y, w, h) = e.dirty_rect();
        let full = e.full_dirty;
        if w == 0 || h == 0 {
            e.clear_dirty();
            (0, 0, 0, 0, String::new(), full, ms)
        } else {
            let stride = e.size * 4;
            let mut out = Vec::with_capacity(w * h * 4);
            for row in y..y + h {
                let s = row * stride + x * 4;
                out.extend_from_slice(&e.composite.data[s..s + w * 4]);
            }
            e.clear_dirty();
            (x, y, w, h, b64(&out), full, ms)
        }
    };
    Snapshot { x, y, w, h, data, full, ms, state: build_state(state) }
}

/// Warm-up + timed benchmark of a **full-canvas** composite.
///
/// Deliberately forces the whole canvas each round: the point is to measure the
/// engine, not the dirty-rect shortcut, and after an idle frame a plain
/// `composite()` has nothing to rebuild and would report ~0 ms.
#[tauri::command]
pub fn bench(state: State<AppState>) -> Vec<f32> {
    let mut e = state.engine.lock().unwrap();
    e.full_dirty = true;
    e.composite();
    let mut out = Vec::with_capacity(20);
    for _ in 0..20 {
        e.full_dirty = true;
        let t0 = std::time::Instant::now();
        e.composite();
        out.push(t0.elapsed().as_secs_f32() * 1000.0);
    }
    // Leave the engine dirty so the next frame redraws the lot.
    e.full_dirty = true;
    out
}

// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_state(state: State<AppState>) -> StateResp {
    let e = state.engine.lock().unwrap();
    StateResp {
        size: e.size,
        active: e.active.clone(),
        projection: match e.projection {
            Projection::Equirectangular => "equirectangular",
            Projection::Polar => "polar",
            Projection::Planar => "planar",
        }
        .into(),
        polar_angle: e.polar_angle,
        layers: e.layers.iter().map(layer_info).collect(),
        reference_path: state.reference_path.lock().unwrap().clone(),
        project_path: state.project_path.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn refresh(state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().full_dirty = true;
    emit(&state)
}

#[tauri::command]
pub fn set_size(size: usize, state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().resize(size);
    emit(&state)
}

#[tauri::command]
pub fn load_reference(path: String, state: State<AppState>, app: tauri::AppHandle) -> Result<StateResp, String> {
    let mut e = state.engine.lock().unwrap();
    let buf = io::load_reference(&path, e.size)?;
    e.reference = Some(buf);
    drop(e);
    let mut rp = state.reference_path.lock().unwrap();
    *rp = Some(path.clone());

    // The frontend renders the sky image through the asset protocol, so the
    // folder has to be allow-listed.
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
    drop(rp);
    Ok(build_state(&state))
}

/// The reference image re-encoded as PNG.
///
/// The WebView cannot decode TGA (or anything outside the browser's codec set),
/// so the on-screen copy is always handed over as PNG data rather than as the
/// original file path.
#[tauri::command]
pub fn get_reference_png(state: State<AppState>) -> Option<String> {
    let e = state.engine.lock().unwrap();
    let r = e.reference.as_ref()?;
    Some(b64(&io::encode_png_bytes(r)?))
}

#[tauri::command]
pub fn clear_reference(state: State<AppState>) -> StateResp {
    state.engine.lock().unwrap().reference = None;
    *state.reference_path.lock().unwrap() = None;
    build_state(&state)
}

#[derive(Serialize)]
pub struct LayerThumb {
    pub id: String,
    /// base64 PNG. Small enough (a few hundred bytes) that a data URL is
    /// cheaper than an asset-protocol round trip.
    pub png: String,
}

/// One small PNG per layer, for the 图层 panel's thumbnail column.
///
/// Batched into a single call on purpose: five layers would otherwise be five
/// IPC round trips plus five lock acquisitions for a couple of kilobytes total.
///
/// Called on pixel changes only — end of a stroke, end of a fill, clear, undo,
/// and any structural edit. Not on parameter changes: Photoshop's thumbnails do
/// not move when you drag 不透明度 either, because they show content, not
/// appearance.
#[tauri::command]
pub fn layer_thumbs(size: usize, state: State<AppState>) -> Vec<LayerThumb> {
    let e = state.engine.lock().unwrap();
    let n = size.clamp(8, 96);
    e.layers
        .iter()
        .filter_map(|l| {
            let t = e.layer_thumb(l, n, n);
            let png = io::encode_png_bytes(&t)?;
            Some(LayerThumb { id: l.p.id.clone(), png: b64(&png) })
        })
        .collect()
}

#[tauri::command]
pub fn stroke(req: StrokeReq, state: State<AppState>) -> Snapshot {
    {
        let mut e = state.engine.lock().unwrap();
        e.stroke(
            &req.points, req.size, req.hardness, req.strength, req.erase, &req.target,
            req.stroke_id, req.flow,
        );
    }
    emit(&state)
}

#[tauri::command]
pub fn flood_fill(req: FillReq, state: State<AppState>) -> Snapshot {
    {
        let mut e = state.engine.lock().unwrap();
        e.flood_fill_active(req.u, req.v, req.threshold, &req.target);
    }
    emit(&state)
}

#[derive(Deserialize)]
pub struct SampleReq {
    pub u: f32,
    pub v: f32,
    /// "layer" (the active layer's own field) or "composite" (everything stacked).
    #[serde(default)]
    pub source: String,
}

/// Eyedropper for the brush: alt-click reads the flow strength under the
/// cursor. Returns 0..1.
#[tauri::command]
pub fn sample_strength(req: SampleReq, state: State<AppState>) -> f32 {
    state.engine.lock().unwrap().sample_strength(req.u, req.v, &req.source)
}

#[tauri::command]
pub fn save_history(state: State<AppState>) {
    state.engine.lock().unwrap().save_history();
}

#[tauri::command]
pub fn undo(state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().undo();
    emit(&state)
}

#[tauri::command]
pub fn redo(state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().redo();
    emit(&state)
}

#[tauri::command]
pub fn update_layer(patch: LayerPatch, state: State<AppState>) -> Snapshot {
    // Read before `patch.name` is moved out below.
    let renames_only = patch.name.is_some();
    {
        let mut e = state.engine.lock().unwrap();
        if let Some(l) = e.layer_mut(&patch.id) {
            if let Some(v) = patch.name { l.p.name = v; }
            if let Some(v) = patch.visible { l.p.visible = v; }
            if let Some(v) = patch.opacity { l.p.opacity = v; }
            if let Some(v) = patch.direction { l.p.direction = v; l.wind_dirty = true; }
            if let Some(v) = patch.strength { l.p.strength = v; l.wind_dirty = true; }
            if let Some(v) = patch.disturbance_enabled { l.p.disturbance_enabled = v; }
            if let Some(v) = patch.disturbance { l.p.disturbance = v; }
        }
        // Every field here but `name` moves pixels everywhere: opacity and
        // visibility re-scale the whole stack, direction and disturbance
        // re-derive a whole-canvas field. Region-scoped compositing has to be
        // told so. (Effects are not in this patch — they go through
        // `set_effects`, which is whole-canvas by definition.)
        if !renames_only {
            e.full_dirty = true;
        }
    }
    emit(&state)
}

#[tauri::command]
pub fn add_layer(kind: String, state: State<AppState>) -> Snapshot {
    let k = match kind.as_str() {
        "wind" => LayerKind::Wind,
        "obstacle" => LayerKind::Obstacle,
        "path" => LayerKind::Path,
        _ => LayerKind::Paint,
    };
    state.engine.lock().unwrap().add_layer(k);
    emit(&state)
}

/// Replace a path layer's paths.
///
/// The whole list goes over every time because it *is* the layer's content and
/// it is small: a handful of anchors, not pixels. The engine diffs it against
/// what it had and re-renders only the paths that moved.
///
/// The caller is responsible for `save_history` — one edit is one undo step,
/// and the frontend knows where an edit begins and ends (a drag does not want
/// forty history entries).
#[tauri::command]
pub fn set_paths(id: String, paths: Vec<PathData>, state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().set_paths(&id, paths);
    emit(&state)
}

/// Replace a layer's effects.
///
/// The whole list goes over, like `set_paths`: it is a handful of small
/// records, and the caller has the only copy that knows about the gesture
/// being made. One round trip per drag frame, `save_history` at the end.
#[tauri::command]
pub fn set_effects(id: String, effects: Vec<LayerEffect>, state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().set_effects(&id, effects);
    emit(&state)
}

#[tauri::command]
pub fn remove_layer(id: String, state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().remove_layer(&id);
    emit(&state)
}

#[tauri::command]
pub fn reorder(from: usize, to: usize, state: State<AppState>) -> Snapshot {
    state.engine.lock().unwrap().reorder_visual(from, to);
    emit(&state)
}

#[tauri::command]
pub fn set_active(id: String, state: State<AppState>) -> StateResp {
    state.engine.lock().unwrap().active = id;
    build_state(&state)
}

#[tauri::command]
pub fn clear_layer(id: String, state: State<AppState>) -> Snapshot {
    {
        let mut e = state.engine.lock().unwrap();
        e.clear_layer(&id);
        e.save_history();
    }
    emit(&state)
}

#[tauri::command]
pub fn set_projection(projection: String, polar_angle: f32, state: State<AppState>) -> Snapshot {
    {
        let mut e = state.engine.lock().unwrap();
        e.projection = match projection.as_str() {
            "polar" => Projection::Polar,
            "planar" => Projection::Planar,
            _ => Projection::Equirectangular,
        };
        e.polar_angle = polar_angle;
        for l in e.layers.iter_mut() {
            l.wind_dirty = true;
        }
        e.full_dirty = true;
    }
    emit(&state)
}

#[tauri::command]
pub fn export_flowmap(req: ExportReq, state: State<AppState>) -> Result<(), String> {
    let mut e = state.engine.lock().unwrap();
    e.composite();
    let buf = e.composite.clone();
    drop(e);
    io::export(&buf, &req.path, req.invert_x, req.invert_y, req.size)
}

#[tauri::command]
pub fn save_project(path: String, state: State<AppState>) -> Result<(), String> {
    let mut e = state.engine.lock().unwrap();
    // Make sure the on-disk copy reflects the latest edits.
    e.composite();
    io::save_project(&e, &path)?;
    drop(e);
    *state.project_path.lock().unwrap() = Some(path);
    Ok(())
}

#[tauri::command]
pub fn load_project(path: String, state: State<AppState>) -> Result<Snapshot, String> {
    let engine = io::load_project(&path)?;
    {
        let mut e = state.engine.lock().unwrap();
        *e = engine;
        e.composite();
    }
    *state.project_path.lock().unwrap() = Some(path);
    Ok(emit(&state))
}

#[tauri::command]
pub fn new_project(size: usize, state: State<AppState>) -> Snapshot {
    *state.engine.lock().unwrap() = Engine::new(size);
    *state.project_path.lock().unwrap() = None;
    *state.reference_path.lock().unwrap() = None;
    emit(&state)
}

// -- recent files ------------------------------------------------------------

const RECENT_MAX: usize = 12;

fn recent_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recent.json"))
}

#[tauri::command]
pub fn push_recent(path: String, app: tauri::AppHandle) {
    let Some(p) = recent_path(&app) else { return };
    let mut list: Vec<String> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|x| x != &path);
    list.insert(0, path);
    list.truncate(RECENT_MAX);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(&list) {
        let _ = std::fs::write(p, s);
    }
}

#[tauri::command]
pub fn get_recent(app: tauri::AppHandle) -> Vec<String> {
    let Some(p) = recent_path(&app) else { return vec![] };
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn build_state(state: &State<AppState>) -> StateResp {
    let e = state.engine.lock().unwrap();
    StateResp {
        size: e.size,
        active: e.active.clone(),
        projection: match e.projection {
            Projection::Equirectangular => "equirectangular",
            Projection::Polar => "polar",
            Projection::Planar => "planar",
        }
        .into(),
        polar_angle: e.polar_angle,
        layers: e.layers.iter().map(layer_info).collect(),
        reference_path: state.reference_path.lock().unwrap().clone(),
        project_path: state.project_path.lock().unwrap().clone(),
    }
}
