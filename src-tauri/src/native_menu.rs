//! Page-supplied items in WebView2's native context menu (Windows only).
//!
//! The heading right-click menu (a Mark heading submenu: Running, Focus, …)
//! used to be the app's own DOM menu, which meant cancelling the native one —
//! and with it the spell checker's suggestions, which only the native menu
//! has (no web API exposes them). On Windows the page now lets the native menu
//! open and this hook appends the page's items to it, so one menu carries
//! both.
//!
//! The page owns the items: its `contextmenu` handler stashes them on
//! `window.__mdSpecpadNativeMenu` (`src/editors/heading-mark-menu.ts`), and a
//! capture-phase listener clears the stash on every right-click, so a stale
//! heading never leaks into a later menu. Here, under a deferral, the hook
//! asks the page for the stash, builds the items, and on a pick calls back
//! into the page with the item's id. A page with no stash gets the native
//! menu untouched.
//!
//! No unit test: everything here needs a live WebView2; covered by the QA
//! checklist instead.

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
            let env = env.clone();
            let sender_for_pick = sender.clone();
            sender.ExecuteScript(
                &HSTRING::from(QUERY_SCRIPT),
                &ExecuteScriptCompletedHandler::create(Box::new(move |status, json| {
                    if status.is_ok() {
                        if let Ok(Some(items)) =
                            serde_json::from_str::<Option<Vec<PageItem>>>(&json)
                        {
                            if let Err(e) = append(&args, &env, &sender_for_pick, &items) {
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
) -> windows::core::Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let menu = args.MenuItems()?;
    let mut count = 0u32;
    menu.Count(&mut count)?;
    // A separator between the native items (spelling, cut/copy/paste) and
    // the page's own — unless the native menu came up empty.
    if count > 0 {
        let sep = env.CreateContextMenuItem(
            &HSTRING::new(),
            None,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        )?;
        menu.InsertValueAtIndex(count, &sep)?;
        count += 1;
    }
    for item in items {
        menu.InsertValueAtIndex(count, &build(env, core, item)?)?;
        count += 1;
    }
    Ok(())
}

/// One page item as a native menu entry; an item with `children` becomes a
/// submenu holding them (built the same way).
unsafe fn build(
    env: &ICoreWebView2Environment9,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    item: &PageItem,
) -> windows::core::Result<ICoreWebView2ContextMenuItem> {
    if item.separator {
        return env.CreateContextMenuItem(
            &HSTRING::new(),
            None,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        );
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
