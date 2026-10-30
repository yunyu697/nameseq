mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_paths,
            commands::plan_rename,
            commands::execute_plan,
            commands::retry_failed,
            commands::undo_batch,
            commands::list_batches,
            commands::interrupted_batches,
            commands::recover_batch,
            commands::copy_text,
            commands::export_chain,
            commands::import_chain,
            commands::read_text_file,
            commands::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
