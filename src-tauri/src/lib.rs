//! Tray, window and native command wiring.
//!
//! The app is a background tray utility: it has no taskbar presence and no
//! visible window until a check-in is due. The webview owns *when* to prompt
//! (see `src/lib/schedule.ts`); this side owns the shell around it.

mod vault;

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, Runtime, WebviewWindow,
};

/// Holds the disabled status line at the top of the tray menu so the frontend
/// can keep it current with the day's progress.
struct StatusMenuItem(MenuItem<tauri::Wry>);

/// Update the tray's status line. Text is composed in the frontend; we apply it.
#[tauri::command]
fn set_tray_status(status: String, item: tauri::State<'_, StatusMenuItem>) -> Result<(), String> {
    item.0.set_text(status).map_err(|err| err.to_string())
}

/// Park the check-in card on the largest connected display, or the OS primary
/// ("main") monitor when enumeration fails.
#[tauri::command]
fn position_checkin(window: WebviewWindow) -> Result<(), String> {
    position_top_left(&window);
    Ok(())
}

/// Ask the OS to draw attention to the window.
///
/// Windows will not let an arbitrary background process take the foreground:
/// `SetForegroundWindow` is refused unless the process satisfies one of a short
/// list of conditions (it owns the foreground window, it received the last
/// input event, and so on). A timer firing at 14:00 satisfies none of them, so
/// `set_focus` may raise the window without giving it keyboard focus.
///
/// Flashing the taskbar entry is the documented fallback for exactly this case:
/// if we can't take focus, at least be impossible to miss.
#[tauri::command]
fn request_attention(window: WebviewWindow) -> Result<(), String> {
    window
        .request_user_attention(Some(tauri::UserAttentionType::Critical))
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            position_checkin,
            request_attention,
            vault::vault_dir,
            vault::vault_set_dir,
            vault::vault_read,
            vault::vault_write,
            vault::vault_list,
            vault::open_vault_dir,
            vault::settings_load,
            vault::settings_save,
        ])
        .setup(|app| {
            // On macOS this is a menu-bar-only utility: keep it out of the Dock
            // and the app switcher by running as an Accessory app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(vault::VaultState::new(vault::default_vault_dir(
                app.handle(),
            )));

            // --- System tray ---------------------------------------------------
            let status_item =
                MenuItem::with_id(app, "status", "No entries today", false, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let check_in_item =
                MenuItem::with_id(app, "check_in", "Check in now", true, None::<&str>)?;
            let standup_item =
                MenuItem::with_id(app, "standup", "Copy standup summary", true, None::<&str>)?;
            // Distinct from the standup: that one is for a human in a chat box,
            // this one carries its own schema key for an agent that will never
            // see the vault's CONTEXT.md.
            let week_item =
                MenuItem::with_id(app, "week", "Copy week for an agent", true, None::<&str>)?;
            // Always present, like every item above it — there's no roster to be
            // empty of, since a report's file is created the first time you log
            // something about them. The manager-mode setting only gates the
            // extra day-end prompt, not this panel.
            let team_item = MenuItem::with_id(app, "team", "Team…", true, None::<&str>)?;
            let team_week_item = MenuItem::with_id(
                app,
                "team_week",
                "Copy team week for an agent",
                true,
                None::<&str>,
            )?;
            let vault_item =
                MenuItem::with_id(app, "vault", "Open vault folder", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &status_item as &dyn IsMenuItem<tauri::Wry>,
                    &separator,
                    &check_in_item,
                    &standup_item,
                    &week_item,
                    &team_item,
                    &team_week_item,
                    &vault_item,
                    &settings_item,
                    &quit_item,
                ],
            )?;

            app.manage(StatusMenuItem(status_item.clone()));

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Task Tracker")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    // The webview owns the vault and the card, so every action
                    // is a signal rather than work done here.
                    "check_in" => {
                        let _ = app.emit("check-in-now", ());
                    }
                    "standup" => {
                        let _ = app.emit("copy-standup", ());
                    }
                    "week" => {
                        let _ = app.emit("copy-week", ());
                    }
                    "team" => {
                        let _ = app.emit("open-team", ());
                    }
                    "team_week" => {
                        let _ = app.emit("copy-team-week", ());
                    }
                    "vault" => {
                        let _ = app.emit("open-vault", ());
                    }
                    // The webview owns the panel and shows its own window, so
                    // this side does not touch window visibility here.
                    "settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    _ => {}
                });

            // `generate_context!` embeds the icon set at compile time, so it is
            // committed and always present here. Still handled as an Option
            // rather than unwrapped: a missing tray icon is a cosmetic problem,
            // and panicking in `setup` takes the whole app down with it.
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;

            // --- Check-in window -----------------------------------------------
            // Declared hidden in tauri.conf.json; parked in the top-left corner,
            // which is deliberately the opposite corner from the sibling
            // noticeable-calendar-alert overlay.
            if let Some(window) = app.get_webview_window("checkin") {
                position_top_left(&window);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Inset from the monitor edge, in physical pixels.
const MARGIN: i32 = 24;

/// Anchor the window against the top-left corner of the best available display.
fn position_top_left<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Some(monitor) = target_monitor(window) else {
        return;
    };

    // Offset by the monitor's own origin: displays left of or above the primary
    // sit at negative coordinates, and ignoring that puts the window off-screen.
    let origin = monitor.position();
    let _ = window.set_position(tauri::PhysicalPosition::new(
        origin.x + MARGIN,
        origin.y + MARGIN,
    ));
}

/// Largest display first (often the external monitor), then the OS primary
/// ("main" monitor), then whatever display currently owns the window.
fn target_monitor<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<tauri::Monitor> {
    largest_monitor(window)
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
}

/// Pick the connected monitor with the greatest pixel area (width × height).
///
/// On a tie (two identical monitors), `max_by_key` returns the *last* maximal
/// element, so which one wins depends on OS enumeration order and isn't
/// guaranteed stable across launches. Harmless in practice — "largest" is
/// ambiguous when sizes match — but worth knowing if the card ever seems to
/// swap displays.
fn largest_monitor<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok()?;
    monitors
        .into_iter()
        .max_by_key(|monitor| monitor_pixel_area(monitor.size()))
}

fn monitor_pixel_area(size: &tauri::PhysicalSize<u32>) -> u64 {
    u64::from(size.width) * u64::from(size.height)
}
