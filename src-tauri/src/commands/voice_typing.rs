//! Windows only: start and stop Windows voice typing for voice notes by
//! pressing Win+H on the user's behalf.
//!
//! Why not `Windows.Media.SpeechRecognition`: md-specpad installs without
//! package identity, and for such an app Windows opens the microphone for the
//! speech runtime but hands the recognizer silence — with both the online and
//! the offline engine — so every note came back empty. Voice typing is the
//! shell's own dictation: it types what the user says into the focused text
//! field (the voice-note sheet focuses its draft box first), uses Microsoft's
//! online recognizer, and needs no package identity. md-specpad never touches
//! the audio.
//!
//! Win+H is a toggle: the first press opens the voice-typing bar and starts
//! listening, the second closes it.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
};

const VK_H: VIRTUAL_KEY = VIRTUAL_KEY(b'H' as u16);

fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// The four key events of one Win+H press.
fn win_h() -> [INPUT; 4] {
    let down = KEYBD_EVENT_FLAGS(0);
    [
        key(VK_LWIN, KEYEVENTF_EXTENDEDKEY),
        key(VK_H, down),
        key(VK_H, KEYEVENTF_KEYUP),
        key(VK_LWIN, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
    ]
}

/// Press Win+H: toggles Windows voice typing in the focused text field.
#[tauri::command]
pub fn voice_typing_toggle() -> Result<(), String> {
    let inputs = win_h();
    // SAFETY: a plain array of fully initialised keyboard INPUTs, and the
    // size passed is that of one INPUT, as SendInput requires.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(format!(
            "VOICE_TYPING_FAILED:{}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_h_presses_win_then_h_and_releases_in_reverse() {
        let keys: Vec<(u16, u32)> = win_h()
            .iter()
            // SAFETY: every INPUT built by `win_h` is a keyboard input.
            .map(|i| unsafe { (i.Anonymous.ki.wVk.0, i.Anonymous.ki.dwFlags.0) })
            .collect();
        let up = KEYEVENTF_KEYUP.0;
        let ext = KEYEVENTF_EXTENDEDKEY.0;
        assert_eq!(
            keys,
            vec![
                (VK_LWIN.0, ext),
                (b'H' as u16, 0),
                (b'H' as u16, up),
                (VK_LWIN.0, ext | up),
            ]
        );
    }
}
