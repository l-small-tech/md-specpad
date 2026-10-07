//! The whisper.cpp engine: one loaded model per session, and the command
//! that turns a capture's PCM into text.
//!
//! Loading a model is the slow part (hundreds of MB read and laid out), so
//! the context is cached and only replaced when the chosen file changes.
//! `whisper_prepare` lets the frontend warm it while the user is still
//! talking. Transcription runs on the blocking pool — the IPC thread and the
//! UI never wait on it.
//!
//! Input is little-endian f32 PCM, mono, in the request's raw body (no JSON,
//! no base64), with `sample-rate`, `model-id` and the optional `hint` (an
//! initial prompt biasing the decoder — Review mode sends the reviewed file's
//! identifiers) headers. Whisper wants
//! 16 kHz; anything else is linearly resampled here, which is enough for
//! speech captured at 44.1/48 kHz on the odd backend that refuses 16 kHz.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::models::{model_dir, model_path, spec};
use super::{WhisperError, WhisperResult};

/// What whisper.cpp expects.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// The loaded model, keyed by the file it came from and whether it was
/// laid out for the GPU (flipping the setting reloads).
struct Loaded {
    path: PathBuf,
    gpu: bool,
    ctx: WhisperContext,
}

/// Which accelerator this build can hand the model to: "vulkan" (Windows,
/// Linux), "metal" (macOS) or "none" (Android, or a Windows machine without
/// a Vulkan loader — see `vulkan_delayload.cpp`). Compile-time apart from
/// that one runtime check; whether the GPU is actually used is still
/// whisper.cpp's call at load (it falls back to the CPU on its own).
pub fn accelerator() -> &'static str {
    if cfg!(target_os = "macos") {
        "metal"
    } else if cfg!(any(target_os = "windows", target_os = "linux")) {
        if vulkan_loader_present() {
            "vulkan"
        } else {
            "none"
        }
    } else {
        "none"
    }
}

/// Windows links `vulkan-1.dll` delay-loaded (build.rs), so a machine
/// without a Vulkan driver still starts the app; this is the same question
/// asked up front, so the Settings dialog can say so.
#[cfg(target_os = "windows")]
fn vulkan_loader_present() -> bool {
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;
    // SAFETY: LoadLibraryW with a literal name; the handle is not freed on
    // purpose (the loader keeps it once ggml needs it anyway).
    unsafe { LoadLibraryW(w!("vulkan-1.dll")).is_ok() }
}

#[cfg(not(target_os = "windows"))]
fn vulkan_loader_present() -> bool {
    true
}

/// App-wide: the one loaded context. The lock is held for the whole of a
/// transcription, which serializes captures — there is only ever one.
#[derive(Default)]
pub struct EngineState(Mutex<Option<Loaded>>);

static LOG_HOOKS: Once = Once::new();

impl EngineState {
    /// Load `path` unless it is already the loaded model. `expected_bytes` is
    /// the manifest size: a file of any other length is corrupt (a download
    /// only ever renames a verified file into place, so this catches a file
    /// truncated or swapped afterwards), and says so instead of "load failed".
    fn load(&self, path: &Path, expected_bytes: Option<u64>, gpu: bool) -> WhisperResult<()> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|l| l.path == path && l.gpu == gpu)
        {
            return Ok(());
        }
        // A file that is not there is "not downloaded", not "failed to load".
        let Ok(meta) = std::fs::metadata(path) else {
            return Err(WhisperError::NoModel(path.to_string_lossy().into_owned()));
        };
        if let Some(expected) = expected_bytes {
            if meta.len() != expected {
                return Err(WhisperError::ModelCorrupt(format!(
                    "{} is {} bytes, expected {expected}",
                    path.display(),
                    meta.len()
                )));
            }
        }
        // whisper.cpp prints to stderr by default; route it into the app log.
        LOG_HOOKS.call_once(whisper_rs::install_logging_hooks);
        // Drop the old model before loading the next — two large models at
        // once is how a machine runs out of memory.
        *slot = None;
        let mut params = WhisperContextParameters::default();
        // whisper-rs defaults use_gpu to "was a GPU backend compiled in";
        // the setting can only turn it off. Flash attention is the faster
        // kernel on a GPU and a no-op for the CPU path.
        let gpu = gpu && params.use_gpu;
        params.use_gpu(gpu).flash_attn(gpu);
        let ctx = WhisperContext::new_with_params(path, params)
            .map_err(|e| WhisperError::LoadFailed(e.to_string()))?;
        *slot = Some(Loaded {
            path: path.to_path_buf(),
            gpu,
            ctx,
        });
        Ok(())
    }

    /// Forget the loaded model if it is this file (it is about to be deleted).
    pub fn unload_if(&self, path: &Path) {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|l| l.path == path) {
            *slot = None;
        }
    }

    /// Load (if needed) and transcribe under the one lock.
    fn transcribe(
        &self,
        path: &Path,
        expected_bytes: Option<u64>,
        gpu: bool,
        pcm: &[f32],
        language: Option<&str>,
        hint: Option<&str>,
    ) -> WhisperResult<String> {
        self.load(path, expected_bytes, gpu)?;
        let slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = slot
            .as_ref()
            .ok_or_else(|| WhisperError::LoadFailed("model vanished".into()))?;
        transcribe_with(&loaded.ctx, pcm, language, hint)
    }
}

/// Greedy decode, no timestamps, segments joined with single spaces.
///
/// `hint` is whisper.cpp's initial prompt: words the decoder should expect
/// (the frontend sends the reviewed file's identifiers). It biases decoding
/// only — an empty or absent hint leaves the decode exactly as it was.
pub fn transcribe_with(
    ctx: &WhisperContext,
    pcm: &[f32],
    language: Option<&str>,
    hint: Option<&str>,
) -> WhisperResult<String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| WhisperError::LoadFailed(e.to_string()))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(thread_count());
    params.set_language(language);
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // An initial prompt biases the decoder toward the words in it. Interior
    // null bytes would panic inside whisper-rs, so they go first.
    let prompt = hint.map(|h| h.replace('\0', " "));
    if let Some(prompt) = prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        params.set_initial_prompt(prompt);
    }
    state
        .full(params, pcm)
        .map_err(|e| WhisperError::Failed(e.to_string()))?;
    let segments = state
        .as_iter()
        .map(|segment| segment.to_str_lossy().map(|s| s.into_owned()))
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| WhisperError::Failed(e.to_string()))?;
    Ok(join_segments(segments.iter().map(String::as_str)))
}

/// Up to 8 threads: whisper.cpp scales poorly past that, and the machine
/// still has a UI to draw.
fn thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4) as i32
}

/// Trimmed segments joined with single spaces; empty segments vanish.
pub fn join_segments<'a>(segments: impl Iterator<Item = &'a str>) -> String {
    segments
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Little-endian f32 samples out of the raw body.
pub fn pcm_from_le_bytes(bytes: &[u8]) -> WhisperResult<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return Err(WhisperError::InvalidData(format!(
            "pcm body of {} bytes is not whole f32 samples",
            bytes.len()
        )));
    }
    Ok(bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect())
}

/// Linear resampling — plenty for speech, and dependency-free.
pub fn resample(pcm: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || pcm.is_empty() || from == 0 || to == 0 {
        return pcm.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((pcm.len() as f64) / ratio).floor().max(1.0) as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            let a = pcm[idx.min(pcm.len() - 1)];
            let b = pcm[(idx + 1).min(pcm.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// Which accelerator this build and machine offer (see `accelerator`).
#[tauri::command]
pub fn whisper_accelerator() -> &'static str {
    accelerator()
}

/// Load the chosen model now (the frontend calls this as the capture starts,
/// so the load overlaps the talking). Also the cheap way to learn that the
/// model is missing BEFORE the user has dictated a note into the void.
/// `use_gpu` mirrors the setting; it is ignored by a build with no GPU backend.
#[tauri::command]
pub async fn whisper_prepare(app: AppHandle, model_id: String, use_gpu: bool) -> WhisperResult<()> {
    let model = spec(&model_id)?;
    let path = model_path(&model_dir(&app)?, model);
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<EngineState>()
            .load(&path, Some(model.bytes), use_gpu)
    })
    .await
    .map_err(|e| WhisperError::Failed(e.to_string()))?
}

/// Raw body: little-endian f32 mono PCM. Headers: `sample-rate` (Hz),
/// `model-id` (manifest id), `use-gpu` ("true"/"false", the setting; absent
/// means true), and the optional `hint` — whisper.cpp's initial
/// prompt, the words to expect (Review mode sends the file's identifiers).
/// Resolves with the transcript ("" for silence).
#[tauri::command]
pub async fn whisper_transcribe(app: AppHandle, request: Request<'_>) -> WhisperResult<String> {
    let header = |name: &str| -> WhisperResult<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| WhisperError::InvalidData(format!("missing {name} header")))
    };
    let sample_rate: u32 = header("sample-rate")?
        .parse()
        .map_err(|_| WhisperError::InvalidData("bad sample-rate header".into()))?;
    let model = spec(&header("model-id")?)?;
    let use_gpu = header("use-gpu").map_or(true, |v| v != "false");
    // Optional: a missing hint is not an error, it is the ordinary case.
    let hint: Option<String> = request
        .headers()
        .get("hint")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(WhisperError::InvalidData("expected a raw pcm body".into()));
        }
    };
    let path = model_path(&model_dir(&app)?, model);

    tauri::async_runtime::spawn_blocking(move || {
        let pcm = pcm_from_le_bytes(&bytes)?;
        drop(bytes);
        let pcm = resample(&pcm, sample_rate, WHISPER_SAMPLE_RATE);
        let engine: State<'_, EngineState> = app.state();
        engine.transcribe(
            &path,
            Some(model.bytes),
            use_gpu,
            &pcm,
            model.language(),
            hint.as_deref(),
        )
    })
    .await
    .map_err(|e| WhisperError::Failed(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_bytes_round_trip_and_reject_ragged_lengths() {
        let samples = [0.5f32, -0.25, 1.0];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(pcm_from_le_bytes(&bytes).unwrap(), samples);
        assert!(matches!(
            pcm_from_le_bytes(&bytes[..5]),
            Err(WhisperError::InvalidData(_))
        ));
        assert!(pcm_from_le_bytes(&[]).unwrap().is_empty());
    }

    #[test]
    fn resample_keeps_duration_and_is_identity_at_equal_rates() {
        let pcm: Vec<f32> = (0..48_000).map(|i| (i as f32 / 100.0).sin()).collect();
        assert_eq!(resample(&pcm, 16_000, 16_000), pcm);
        let down = resample(&pcm, 48_000, 16_000);
        assert_eq!(down.len(), 16_000);
        // A linear interpolation of a smooth signal stays close to it.
        for (i, v) in down.iter().enumerate().step_by(997) {
            let expected = ((i * 3) as f32 / 100.0).sin();
            assert!((v - expected).abs() < 0.02, "sample {i}: {v} vs {expected}");
        }
        assert_eq!(
            resample(&[1.0, 2.0], 8_000, 16_000),
            vec![1.0, 1.5, 2.0, 2.0]
        );
        assert!(resample(&[], 48_000, 16_000).is_empty());
        assert_eq!(resample(&[0.5], 48_000, 16_000), vec![0.5]);
    }

    #[test]
    fn segments_join_trimmed_with_single_spaces() {
        assert_eq!(
            join_segments([" Hello,", "  world. ", "", "   "].into_iter()),
            "Hello, world."
        );
        assert_eq!(join_segments(std::iter::empty()), "");
    }

    #[test]
    fn a_missing_model_is_not_downloaded_rather_than_broken() {
        let engine = EngineState::default();
        let err = engine
            .transcribe(
                Path::new("Z:/nowhere/ggml-small.en.bin"),
                None,
                true,
                &[0.0; 16_000],
                Some("en"),
                None,
            )
            .unwrap_err();
        assert!(matches!(err, WhisperError::NoModel(_)), "{err:?}");
    }

    #[test]
    fn a_garbage_file_fails_to_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ggml-tiny.en.bin");
        std::fs::write(&path, b"this is not a ggml file").unwrap();
        let engine = EngineState::default();
        let err = engine
            .transcribe(&path, None, true, &[0.0; 16_000], Some("en"), None)
            .unwrap_err();
        assert!(matches!(err, WhisperError::LoadFailed(_)), "{err:?}");
        // With the manifest size known, a wrong length is reported as corrupt
        // before whisper.cpp ever opens it.
        let err = engine
            .transcribe(
                &path,
                Some(77_704_715),
                true,
                &[0.0; 16_000],
                Some("en"),
                None,
            )
            .unwrap_err();
        assert!(matches!(err, WhisperError::ModelCorrupt(_)), "{err:?}");
    }

    #[test]
    fn accelerator_is_one_of_the_known_names() {
        assert!(["vulkan", "metal", "none"].contains(&accelerator()));
    }

    #[test]
    fn unload_if_only_forgets_that_file() {
        let engine = EngineState::default();
        engine.unload_if(Path::new("nothing-loaded.bin")); // no panic on empty
        assert!(engine.0.lock().unwrap().is_none());
    }

    /// whisper.cpp's own log lines (which backend it picked, the device
    /// name) on stderr, for the real-model test below: `--nocapture` shows
    /// "using Vulkan backend" / "no GPU found".
    struct StderrLogger;

    impl log::Log for StderrLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
        fn flush(&self) {}
    }

    /// Needs a real model: `MD_SPECPAD_WHISPER_MODEL=<path to ggml-*.bin>
    /// cargo test -- --ignored --nocapture real_model`. A second of silence
    /// must come back as text without an error (usually empty). With
    /// `MD_SPECPAD_NO_VULKAN=1` as well (Windows) it exercises the
    /// delay-load failure path: the log must say no GPU, and nothing crashes.
    #[test]
    #[ignore]
    fn real_model_transcribes_silence() {
        let path = std::env::var("MD_SPECPAD_WHISPER_MODEL").expect("MD_SPECPAD_WHISPER_MODEL");
        let _ = log::set_logger(&StderrLogger).map(|()| log::set_max_level(log::LevelFilter::Info));
        eprintln!("accelerator() = {}", accelerator());
        let engine = EngineState::default();
        let text = engine
            .transcribe(
                Path::new(&path),
                None,
                true,
                &[0.0; 16_000],
                Some("en"),
                Some("show all files state, is markdown path"),
            )
            .unwrap();
        assert!(
            text.len() < 64,
            "unexpected transcript for silence: {text:?}"
        );
        // The second call reuses the loaded context; the CPU-forced third
        // reloads it without the GPU.
        engine
            .transcribe(
                Path::new(&path),
                None,
                true,
                &[0.0; 16_000],
                Some("en"),
                None,
            )
            .unwrap();
        engine
            .transcribe(
                Path::new(&path),
                None,
                false,
                &[0.0; 16_000],
                Some("en"),
                None,
            )
            .unwrap();
        assert!(!engine.0.lock().unwrap().as_ref().unwrap().gpu);
    }
}
