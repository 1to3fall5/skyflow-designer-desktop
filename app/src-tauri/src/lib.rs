pub mod commands;
pub mod engine;

use std::sync::Mutex;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            engine: Mutex::new(engine::Engine::new(1024)),
            project_path: Mutex::new(None),
            reference_path: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::refresh,
            commands::set_size,
            commands::load_reference,
            commands::get_reference_png,
            commands::clear_reference,
            commands::layer_thumbs,
            commands::stroke,
            commands::flood_fill,
            commands::sample_strength,
            commands::save_history,
            commands::undo,
            commands::redo,
            commands::update_layer,
            commands::add_layer,
            commands::set_paths,
            commands::set_effects,
            commands::remove_layer,
            commands::reorder,
            commands::merge_down,
            commands::set_active,
            commands::clear_layer,
            commands::set_projection,
            commands::export_flowmap,
            commands::import_flowmap,
            commands::save_project,
            commands::load_project,
            commands::new_project,
            commands::push_recent,
            commands::get_recent,
            commands::bench,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
