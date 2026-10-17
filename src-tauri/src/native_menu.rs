//! Page-supplied items in WebView2's native context menu (Windows only).
//!
//! The heading right-click menu (a Mark heading submenu: Running, Focus, …)
//! used to be the app's own DOM menu, which meant cancelling the native one —
//! and with it the spell checker's suggestions, which only the native menu
//! has (no web API exposes them). On Windows the page now lets the native menu
//! open and this hook adds the page's items to it, so one menu carries both.
//!
//! The items go on the cursor's side of the menu: at the top when it drops
//! down from the pointer, at the bottom when it flips up (a right-click near
//! the bottom of the screen). WebView2 does not say which way it will open,
//! so `opens_up` predicts it the way Chromium decides — does the menu fit
//! between the pointer and the bottom of the monitor's work area — from an
//! estimate of the menu's height.
//!
//! The page owns the items: its `contextmenu` handler stashes them on
//! `window.__mdSpecpadNativeMenu` (`src/editors/heading-mark-menu.ts`), and a
//! capture-phase listener clears the stash on every right-click, so a stale
//! heading never leaks into a later menu. Here, under a deferral, the hook
//! asks the page for the stash, builds the items, and on a pick calls back
//! into the page with the item's id. A page with no stash gets the native
//! menu untouched.
//!
//! Only `opens_up` is unit-tested: the rest needs a live WebView2 and is
//! covered by the QA checklist instead.

use serde::Deserialize;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuRequestedEventArgs,
    ICoreWebView2Environment9, ICoreWebView2_11, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX,
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
};
use webview2_com::{
    ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler, ExecuteScriptCompletedHandler,
};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// Rough heights of the native (Chromium-drawn) menu's rows at 100% scale,
/// in DIPs. An estimate only: a wrong guess just puts the page's items at
/// the far end of the menu for a right-click right on the flip line.
const ROW_HEIGHT: i32 = 32;
const SEPARATOR_HEIGHT: i32 = 9;
const MENU_PADDING: i32 = 8;

/// Will a menu `height` px tall, opened at `cursor_y`, flip up above the
/// pointer? Chromium drops it down when it fits below, else opens it on
/// the side with more room. All values in the same (physical) pixels.
fn opens_up(cursor_y: i32, work_top: i32, work_bottom: i32, height: i32) -> bool {
    let below = work_bottom - cursor_y;
    let above = cursor_y - work_top;
    height > below && above > below
}

/// What the page asks the menu to show (`null` → nothing; see module docs).
#[derive(Deserialize)]
struct PageItem {
    /// Handed back to the page on a pick. Absent on a separator.
    id: Option<String>,
    label: Option<String>,
    #[serde(default)]
    checked: bool,
    #[serde(default = "enabled_default")]
    enabled: bool,
    #[serde(default)]
    separator: bool,
    /// Makes this item a submenu of these items.
    #[serde(default)]
    children: Option<Vec<PageItem>>,
}

fn enabled_default() -> bool {
    true
}

const QUERY_SCRIPT: &str = "(() => { const m = window.__mdSpecpadNativeMenu; \
     return m && Array.isArray(m.items) ? m.items : null; })()";

/// Install the hook on a freshly created webview. Best-effort: a WebView2
/// runtime too old for custom menu items (pre-2022) just keeps the native
/// menu, and the failure is logged.
pub fn install(webview: &tauri::Webview) {
    let label = webview.label().to_string();
    let result = webview.with_webview(move |platform| {
        if let Err(e) = unsafe { register(&platform) } {
            log::warn!("native menu hook unavailable for {label}: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("native menu hook not installed: {e}");
    }
}

unsafe fn register(platform: &tauri::webview::PlatformWebview) -> windows::core::Result<()> {
    let core = platform.controller().CoreWebView2()?;
    let core11: ICoreWebView2_11 = core.cast()?;
    let env: ICoreWebView2Environment9 = platform.environment().cast()?;
    let mut token = 0i64;
    core11.add_ContextMenuRequested(
        &ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let deferral = args.GetDeferral()?;
            // Where the pointer is now — by the time the page answers it may
            // have moved. A failure (no cursor) reads as "drops down".
            let mut cursor = POINT::default();
            let cursor = GetCursorPos(&mut cursor).ok().map(|_| cursor);
            let env = env.clone();
            let sender_for_pick = sender.clone();
            sender.ExecuteScript(
                &HSTRING::from(QUERY_SCRIPT),
                &ExecuteScriptCompletedHandler::create(Box::new(move |status, json| {
                    if status.is_ok() {
                        if let Ok(Some(items)) =
                            serde_json::from_str::<Option<Vec<PageItem>>>(&json)
                        {
                            if let Err(e) = append(&args, &env, &sender_for_pick, &items, cursor) {
                                log::warn!("native menu items not added: {e}");
                            }
                        }
                    }
                    // Always release the menu, items or not.
                    deferral.Complete()
                })),
            )
        })),
        &mut token,
    )
}

unsafe fn append(
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
    env: &ICoreWebView2Environment9,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    items: &[PageItem],
    cursor: Option<POINT>,
) -> windows::core::Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let menu = args.MenuItems()?;
    let mut count = 0u32;
    menu.Count(&mut count)?;
    let native_height = (0..count)
        .map(|i| {
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND;
            let separator = menu
                .GetValueAtIndex(i)
                .and_then(|item| item.Kind(&mut kind))
                .is_ok()
                && kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
            if separator {
                SEPARATOR_HEIGHT
            } else {
                ROW_HEIGHT
            }
        })
        .sum::<i32>();
    let page_height = items
        .iter()
        .map(|item| {
            if item.separator {
                SEPARATOR_HEIGHT
            } else {
                ROW_HEIGHT
            }
        })
        .sum::<i32>();
    let separator = if count > 0 { SEPARATOR_HEIGHT } else { 0 };
    let height = MENU_PADDING + native_height + separator + page_height;
    let at_bottom = cursor.is_some_and(|cursor| flips_up(cursor, height));

    // The page's items on the pointer's side, then a separator between them
    // and the native items (spelling, cut/copy/paste) — unless the native
    // menu came up empty.
    let mut index = if at_bottom { count } else { 0 };
    if at_bottom && count > 0 {
        menu.InsertValueAtIndex(index, &separator_item(env)?)?;
        index += 1;
    }
    for item in items {
        menu.InsertValueAtIndex(index, &build(env, core, item)?)?;
        index += 1;
    }
    if !at_bottom && count > 0 {
        menu.InsertValueAtIndex(index, &separator_item(env)?)?;
    }
    Ok(())
}

/// `opens_up` for a menu `height` DIPs tall at `cursor` (screen pixels), on
/// whichever monitor the pointer is on.
unsafe fn flips_up(cursor: POINT, height: i32) -> bool {
    let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return false;
    }
    let (mut dpi, mut dpi_y) = (96u32, 96u32);
    let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y);
    let height = height * dpi as i32 / 96;
    opens_up(cursor.y, info.rcWork.top, info.rcWork.bottom, height)
}

unsafe fn separator_item(
    env: &ICoreWebView2Environment9,
) -> windows::core::Result<ICoreWebView2ContextMenuItem> {
    env.CreateContextMenuItem(
        &HSTRING::new(),
        None,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    )
}

/// One page item as a native menu entry; an item with `children` becomes a
/// submenu holding them (built the same way).
unsafe fn build(
    env: &ICoreWebView2Environment9,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    item: &PageItem,
) -> windows::core::Result<ICoreWebView2ContextMenuItem> {
    if item.separator {
        return separator_item(env);
    }
    let kind = if item.children.is_some() {
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU
    } else if item.checked {
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX
    } else {
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND
    };
    let entry = env.CreateContextMenuItem(
        &HSTRING::from(item.label.as_deref().unwrap_or("")),
        None,
        kind,
    )?;
    if let Some(children) = &item.children {
        let sub = entry.Children()?;
        for (i, child) in children.iter().enumerate() {
            sub.InsertValueAtIndex(i as u32, &build(env, core, child)?)?;
        }
        entry.SetIsEnabled(item.enabled)?;
        return Ok(entry);
    }
    if item.checked {
        entry.SetIsChecked(true)?;
    }
    entry.SetIsEnabled(item.enabled)?;
    if let Some(id) = item.id.clone() {
        let core = core.clone();
        let mut token = 0i64;
        entry.add_CustomItemSelected(
            &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                let id = serde_json::to_string(&id).unwrap_or_else(|_| "null".into());
                let script = format!(
                    "window.__mdSpecpadNativeMenu && window.__mdSpecpadNativeMenu.select({id})"
                );
                core.ExecuteScript(
                    &HSTRING::from(script),
                    &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                )
            })),
            &mut token,
        )?;
    }
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::opens_up;

    #[test]
    fn drops_down_when_it_fits_below() {
        assert!(!opens_up(100, 0, 1040, 300));
        assert!(!opens_up(740, 0, 1040, 300));
    }

    #[test]
    fn flips_up_near_the_bottom() {
        assert!(opens_up(900, 0, 1040, 300));
    }

    #[test]
    fn stays_down_when_there_is_less_room_above() {
        // Fits neither way: Chromium keeps the roomier side.
        assert!(!opens_up(200, 0, 500, 400));
        assert!(opens_up(300, 0, 500, 400));
    }

    #[test]
    fn work_area_offset_on_a_second_monitor() {
        assert!(!opens_up(1180, 1080, 2120, 300));
        assert!(opens_up(2000, 1080, 2120, 300));
    }
}
