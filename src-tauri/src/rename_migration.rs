//! One-time move of app data from before the rename to MD Specpad.
//!
//! The app was MD Notepad, identifier `tech.l-small.mdnotepad`. Tauri keys
//! every app folder by identifier (`<data dir>/<identifier>`), so the new
//! identifier `tech.l-small.mdspecpad` would start with no notes, sessions,
//! settings, themes or Whisper models. On first launch, each old folder that
//! has no new counterpart is moved across (renamed, or copied when the rename
//! fails), and absolute paths into the old folder saved in its JSON files are
//! rewritten — `settings.json` stores the notes folder as an absolute path,
//! and sessions store open files' paths.
//!
//! Runs from `run()` before the Tauri builder, so no plugin (window state,
//! store, log) and no webview has opened a folder yet. Desktop only: on
//! Android the new applicationId installs as a separate app with its own
//! sandbox, which this process cannot read. Once a new folder exists this is
//! a no-op, so it does its work exactly once per folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

const OLD_NAME: &str = "mdnotepad";
const NEW_NAME: &str = "mdspecpad";

/// Folders under these never hold app JSON worth rewriting, and some are
/// large: Whisper models, WebView2's browser profile, plugin logs.
const SKIP_DIRS: &[&str] = &["whisper", "EBWebView", "logs"];

/// Move pre-rename data for `identifier` (e.g. `tech.l-small.mdspecpad`, or
/// its `.dev` variant) from the matching `mdnotepad` folders.
pub fn migrate(identifier: &str) {
    let Some(old_id) = legacy_identifier(identifier) else {
        return;
    };
    let mut bases: Vec<PathBuf> = [dirs::data_dir(), dirs::config_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
        .collect();
    bases.sort();
    bases.dedup();

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for base in bases {
        let (old, new) = (base.join(&old_id), base.join(identifier));
        match move_dir(&old, &new) {
            Ok(true) => moved.push((old, new)),
            Ok(false) => {}
            // Logging is not up yet (the log plugin is part of the builder).
            Err(err) => eprintln!(
                "rename migration: could not move {} to {}: {err}",
                old.display(),
                new.display()
            ),
        }
    }
    for (_, new) in &moved {
        rewrite_json_files(new, &moved);
    }
}

/// The identifier the same build had before the rename, if it changed.
fn legacy_identifier(identifier: &str) -> Option<String> {
    identifier
        .contains(NEW_NAME)
        .then(|| identifier.replace(NEW_NAME, OLD_NAME))
}

/// Move `old` to `new` unless there is nothing to move or `new` already
/// exists. Ok(true) when the data is now at `new`.
///
/// A rename is instant and keeps everything (same parent, same volume). It
/// can fail while an old instance still holds files open; then the folder is
/// copied into a staging name and renamed into place, so a half-finished copy
/// never looks like a migrated folder (the next launch would skip it).
fn move_dir(old: &Path, new: &Path) -> io::Result<bool> {
    if !old.is_dir() || new.exists() {
        return Ok(false);
    }
    if fs::rename(old, new).is_ok() {
        return Ok(true);
    }
    let staging = new.with_extension("migrating");
    let _ = fs::remove_dir_all(&staging);
    let copied = copy_dir(old, &staging).and_then(|()| fs::rename(&staging, new));
    if copied.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    copied.map(|()| true)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Rewrite old-folder paths in every `.json` file under `root`. Best effort:
/// a file that will not parse or write is left exactly as it was.
fn rewrite_json_files(root: &Path, moved: &[(PathBuf, PathBuf)]) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !SKIP_DIRS.iter().any(|skip| entry.file_name() == *skip) {
                rewrite_json_files(&path, moved);
            }
        } else if path.extension().is_some_and(|ext| ext == "json") {
            rewrite_json_file(&path, moved);
        }
    }
}

fn rewrite_json_file(path: &Path, moved: &[(PathBuf, PathBuf)]) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let pairs: Vec<(String, String)> = moved
        .iter()
        .map(|(old, new)| {
            (
                old.to_string_lossy().into_owned(),
                new.to_string_lossy().into_owned(),
            )
        })
        .collect();
    if !rewrite_value(&mut value, &pairs) {
        return;
    }
    let Ok(out) = serde_json::to_string_pretty(&value) else {
        return;
    };
    let staging = path.with_extension("json.migrating");
    if fs::write(&staging, out).is_err() || fs::rename(&staging, path).is_err() {
        let _ = fs::remove_file(&staging);
    }
}

/// Rewrite every string (and object key) in `value` that is one of the old
/// folders or a path inside it. True when anything changed.
fn rewrite_value(value: &mut Value, pairs: &[(String, String)]) -> bool {
    match value {
        Value::String(s) => match rewrite_path(s, pairs) {
            Some(new) => {
                *s = new;
                true
            }
            None => false,
        },
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| rewrite_value(item, pairs) | changed),
        Value::Object(map) => {
            let mut changed = false;
            let entries = std::mem::take(map);
            for (key, mut item) in entries {
                changed |= rewrite_value(&mut item, pairs);
                let key = match rewrite_path(&key, pairs) {
                    Some(new) => {
                        changed = true;
                        new
                    }
                    None => key,
                };
                map.insert(key, item);
            }
            changed
        }
        _ => false,
    }
}

/// `s` with its old-folder prefix swapped for the new folder, when `s` is
/// that folder or a path inside it. The frontend may store either separator,
/// so `\` and `/` match each other, and the new prefix takes the separator
/// style `s` already uses. ASCII case is ignored on Windows, where paths are
/// case-insensitive (and the drive letter's case varies by API).
fn rewrite_path(s: &str, pairs: &[(String, String)]) -> Option<String> {
    for (old, new) in pairs {
        let (sb, ob) = (s.as_bytes(), old.as_bytes());
        if sb.len() < ob.len() || !sb.iter().zip(ob).all(|(&a, &b)| same_path_byte(a, b)) {
            continue;
        }
        let rest = &s[ob.len()..];
        if !(rest.is_empty() || rest.starts_with(['/', '\\'])) {
            continue;
        }
        let new = if s.contains('/') && !s.contains('\\') {
            new.replace('\\', "/")
        } else {
            new.clone()
        };
        return Some(format!("{new}{rest}"));
    }
    None
}

fn same_path_byte(a: u8, b: u8) -> bool {
    let sep = |c: u8| c == b'/' || c == b'\\';
    if sep(a) && sep(b) {
        return true;
    }
    if cfg!(windows) {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_identifier_maps_release_and_dev() {
        assert_eq!(
            legacy_identifier("tech.l-small.mdspecpad").as_deref(),
            Some("tech.l-small.mdnotepad")
        );
        assert_eq!(
            legacy_identifier("tech.l-small.mdspecpad.dev").as_deref(),
            Some("tech.l-small.mdnotepad.dev")
        );
        assert_eq!(legacy_identifier("com.example.other"), None);
    }

    fn pairs() -> Vec<(String, String)> {
        vec![(
            r"C:\Users\me\AppData\Roaming\tech.l-small.mdnotepad".to_string(),
            r"C:\Users\me\AppData\Roaming\tech.l-small.mdspecpad".to_string(),
        )]
    }

    #[test]
    fn rewrites_the_folder_and_paths_inside_it() {
        let p = pairs();
        assert_eq!(
            rewrite_path(
                r"C:\Users\me\AppData\Roaming\tech.l-small.mdnotepad\notes",
                &p
            )
            .as_deref(),
            Some(r"C:\Users\me\AppData\Roaming\tech.l-small.mdspecpad\notes")
        );
        assert_eq!(
            rewrite_path(r"C:\Users\me\AppData\Roaming\tech.l-small.mdnotepad", &p).as_deref(),
            Some(r"C:\Users\me\AppData\Roaming\tech.l-small.mdspecpad")
        );
    }

    #[test]
    fn keeps_forward_slashes_when_the_value_uses_them() {
        assert_eq!(
            rewrite_path(
                "C:/Users/me/AppData/Roaming/tech.l-small.mdnotepad/notes/a.md",
                &pairs()
            )
            .as_deref(),
            Some("C:/Users/me/AppData/Roaming/tech.l-small.mdspecpad/notes/a.md")
        );
    }

    #[test]
    fn leaves_lookalikes_and_other_paths_alone() {
        let p = pairs();
        // The old folder's name is only a prefix of this sibling's name.
        assert_eq!(
            rewrite_path(
                r"C:\Users\me\AppData\Roaming\tech.l-small.mdnotepad.dev\notes",
                &p
            ),
            None
        );
        assert_eq!(rewrite_path(r"D:\work\notes\a.md", &p), None);
        assert_eq!(rewrite_path("dark", &p), None);
    }

    #[cfg(windows)]
    #[test]
    fn ignores_case_on_windows() {
        assert!(rewrite_path(
            r"c:\users\me\appdata\roaming\tech.l-small.mdnotepad\notes",
            &pairs()
        )
        .is_some());
    }

    #[test]
    fn rewrites_nested_values_and_keys() {
        let old = r"C:\Users\me\AppData\Roaming\tech.l-small.mdnotepad";
        let mut value = json!({
            "notesDir": format!(r"{old}\notes"),
            "tabs": [{ "path": format!(r"{old}\notes\a.md") }, { "path": r"D:\x.md" }],
            "scroll": { format!(r"{old}\notes\a.md"): 12 },
            "theme": "dark",
        });
        assert!(rewrite_value(&mut value, &pairs()));
        let text = value.to_string();
        assert!(!text.contains("mdnotepad"), "{text}");
        assert_eq!(value["tabs"][1]["path"], r"D:\x.md");
        assert_eq!(value["theme"], "dark");
    }

    #[test]
    fn moves_the_folder_once_and_rewrites_its_json() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("tech.l-small.mdnotepad");
        let new = base.path().join("tech.l-small.mdspecpad");
        fs::create_dir_all(old.join("session")).unwrap();
        fs::create_dir_all(old.join("whisper")).unwrap();
        let notes = old.join("notes");
        fs::write(
            old.join("settings.json"),
            json!({ "notesDir": notes.to_string_lossy() }).to_string(),
        )
        .unwrap();
        fs::write(old.join("whisper").join("model.json"), r#"{"x":1}"#).unwrap();

        assert!(move_dir(&old, &new).unwrap());
        assert!(!old.exists());
        rewrite_json_files(&new, &[(old.clone(), new.clone())]);
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(new.join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            settings["notesDir"],
            new.join("notes").to_string_lossy().as_ref()
        );

        // A second launch finds the new folder and leaves everything alone.
        fs::create_dir_all(&old).unwrap();
        assert!(!move_dir(&old, &new).unwrap());
    }
}
