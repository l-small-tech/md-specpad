//! The pty engine: spawn a child on a pseudo-terminal and pump its output.
//!
//! Deliberately free of Tauri types so the whole thing is unit-testable with a
//! plain closure as the sink (see the tests at the bottom — they run a real
//! shell). `commands/pty.rs` is the thin Tauri skin over this.
//!
//! Threading, per session:
//!
//! ```text
//!   reader ──┐ bounded channel (backpressure)
//!            ├──▶ emitter ──▶ sink   (coalesces output, orders events)
//!   waiter ──┘
//!
//!   write() ──▶ bounded channel ──▶ writer ──▶ pty
//! ```
//!
//! The reader blocks once the channel is full, which stops draining the pty,
//! which blocks the child's `write` — backpressure all the way down, so a
//! runaway `yes` cannot balloon memory.
//!
//! Writes go the other way through their own thread: `write()` only enqueues,
//! so a child that has stopped reading its input (kernel buffer full) blocks
//! the writer thread, never the caller — `commands/pty.rs` calls `write()`
//! under a registry-wide lock on the main thread, where blocking would freeze
//! every terminal and the UI with them. When the queue itself fills, `write()`
//! fails with `Io` rather than wait.
//!
//! Desktop-only: Android has no pty. `commands/mod.rs` gates the module and
//! `Cargo.toml` keeps `portable-pty` out of the mobile dependency graph.

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// One read syscall's worth of bytes.
const READ_BUF: usize = 16 * 1024;
/// Upper bound on a coalesced chunk handed to the sink.
const MAX_COALESCED: usize = 64 * 1024;
/// How long the emitter waits for more bytes before flushing what it has.
/// Small enough to stay invisible to a person typing, long enough that a
/// screenful of output arrives as one message instead of forty.
const FLUSH: Duration = Duration::from_millis(4);
/// Chunks the reader may run ahead of the emitter before it blocks.
const BACKLOG: usize = 8;
/// How much recent output a session keeps so a pty handed to another window
/// can repaint the screen there (see `Relay`). Whole chunks are dropped from
/// the front once the total would exceed this.
const REPLAY_LIMIT: usize = 1024 * 1024;
/// Writes that may queue behind a child that has stopped reading before
/// `write()` starts failing instead. Each entry is one `pty_write` payload (a
/// keystroke or a paste), so this is depth, not bytes.
const WRITE_BACKLOG: usize = 256;

/// What `pty_spawn` accepts. Field names are camelCase over IPC.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub cols: u16,
    pub rows: u16,
    /// Defaults to the user's login shell.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Extra environment for the child. Applied after the terminal's own
    /// `TERM`/`COLORTERM`, so a profile can override them on purpose.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Everything a session tells the outside world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// A coalesced run of child output.
    Output(Vec<u8>),
    /// The child process finished. Output may still follow if a grandchild
    /// (say, a backgrounded process) is holding the pty open.
    Exit(u32),
    /// The pty reached EOF and every thread is done: no more events, and the
    /// session can be reaped.
    Closed,
    /// The replay a fresh listener was given is over; everything after this is
    /// live. Only [`PtySession::attach`] produces it, and the listener needs it
    /// for one reason: a terminal must not ANSWER the queries inside a replay.
    /// Recorded output is full of them — ConPTY opens with `ESC[6n` — and an
    /// answer sent now is a stale cursor report arriving as input, which
    /// re-syncs the shell's idea of the cursor to the wrong column (the caret
    /// lands mid-prompt and typing overwrites it). So the pane stays mute
    /// until this arrives.
    ReplayEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PtyErrorCode {
    /// The child could not be started (bad program, bad cwd).
    Spawn,
    /// No session with that id — already killed, or never existed.
    NotFound,
    /// The pty itself failed (write to a dead pty, resize, allocation).
    Io,
}

/// Serializes as `{ code, message }` — the same error shape every other
/// command in this app uses, so `src/ipc/commands.ts` switches on it uniformly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct PtyError {
    pub code: PtyErrorCode,
    pub message: String,
}

impl PtyError {
    pub fn new(code: PtyErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn spawn(message: impl std::fmt::Display) -> Self {
        Self::new(PtyErrorCode::Spawn, message.to_string())
    }

    fn io(message: impl std::fmt::Display) -> Self {
        Self::new(PtyErrorCode::Io, message.to_string())
    }
}

/// Where a session's events go *right now*, plus what a listener arriving
/// later would need to catch up.
///
/// The sink is swappable because a pty outlives the webview that spawned it:
/// dragging a terminal tab into another window moves the listener, not the
/// shell. Between the two ends (`detach` … `attach`) there is no sink at all
/// and output only accumulates here, so nothing the child prints mid-move is
/// lost. `attach` replays the buffer, which is what repaints the screen in
/// the new window.
///
/// Each listener holds the `epoch` its attachment was given, and `detach`
/// names it: the two windows of a handover race (the new one attaches before
/// the old one's pane has finished unmounting is the common order), and a
/// detach from the listener that has already been replaced must be a no-op
/// rather than silencing the window that took over.
#[derive(Default)]
struct Relay {
    sink: Option<Box<dyn FnMut(PtyEvent) + Send>>,
    /// Recent output, in the chunks the emitter produced. Whole chunks are
    /// dropped from the front: a partial chunk would truncate mid-escape as
    /// readily as a whole one, and this keeps the accounting honest.
    replay: VecDeque<Vec<u8>>,
    replay_bytes: usize,
    /// The child's exit code, if it exited while nobody was listening — a
    /// pane that attaches afterwards still has to learn the shell is gone.
    exit: Option<u32>,
    /// Which attachment the current sink is. `0` is the spawning window's.
    epoch: u64,
}

impl Relay {
    fn new<F: FnMut(PtyEvent) + Send + 'static>(sink: F) -> Self {
        Self {
            sink: Some(Box::new(sink)),
            ..Self::default()
        }
    }

    /// Record `event` for a future listener, then hand it to the current one.
    fn dispatch(&mut self, event: PtyEvent) {
        match &event {
            PtyEvent::Output(bytes) => self.remember(bytes),
            PtyEvent::Exit(code) => self.exit = Some(*code),
            // Closed reaps the session; there is nothing left to replay to.
            // ReplayEnd never travels this way — `attach` hands it straight to
            // the listener it belongs to, so it is never recorded or re-sent.
            PtyEvent::Closed | PtyEvent::ReplayEnd => {}
        }
        if let Some(sink) = self.sink.as_mut() {
            sink(event);
        }
    }

    fn remember(&mut self, bytes: &[u8]) {
        self.replay.push_back(bytes.to_vec());
        self.replay_bytes += bytes.len();
        while self.replay_bytes > REPLAY_LIMIT {
            match self.replay.pop_front() {
                Some(dropped) => self.replay_bytes -= dropped.len(),
                None => break,
            }
        }
    }

    /// Install `sink` and bring it up to date. Replays the buffered output in
    /// order, then the exit code if the child is already gone. Returns the
    /// epoch the new listener must quote to `detach`.
    fn attach(&mut self, sink: Box<dyn FnMut(PtyEvent) + Send>) -> u64 {
        self.epoch += 1;
        self.sink = Some(sink);
        let sink = self.sink.as_mut().expect("just installed");
        for chunk in &self.replay {
            sink(PtyEvent::Output(chunk.clone()));
        }
        if let Some(code) = self.exit {
            sink(PtyEvent::Exit(code));
        }
        // Everything from here is live, and the listener may speak again.
        sink(PtyEvent::ReplayEnd);
        self.epoch
    }

    /// Drop the sink, but only if `epoch` is still the current attachment.
    fn detach(&mut self, epoch: u64) {
        if self.epoch == epoch {
            self.sink = None;
        }
    }
}

/// A live pty and the handles needed to talk to it. Dropping this closes the
/// master, which ends the reader thread.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Feeds the writer thread; dropping it (with the session) ends the thread.
    write_tx: SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Shared with the emitter thread — see [`Relay`].
    relay: Arc<Mutex<Relay>>,
}

impl PtySession {
    /// Starts the child and the four threads that service it.
    ///
    /// `sink` is called from the emitter thread, never concurrently with
    /// itself, and may be replaced later ([`attach`](Self::attach)).
    /// `on_closed` runs once, after the final `Closed` reached the sink — for
    /// a caller that reaps the session then. It holds no lock of this session,
    /// so it may take the registry's.
    pub fn spawn<F, C>(options: &SpawnOptions, sink: F, on_closed: C) -> Result<Self, PtyError>
    where
        F: FnMut(PtyEvent) + Send + 'static,
        C: FnOnce() + Send + 'static,
    {
        let pair = native_pty_system()
            .openpty(pty_size(options.cols, options.rows))
            .map_err(PtyError::spawn)?;

        let mut child = pair
            .slave
            .spawn_command(build_command(options))
            .map_err(PtyError::spawn)?;
        // The parent must not keep a slave handle open or the reader never
        // sees EOF after the child exits.
        drop(pair.slave);

        let master = pair.master;
        let reader = master.try_clone_reader().map_err(PtyError::io)?;
        let writer = master.take_writer().map_err(PtyError::io)?;
        let killer = child.clone_killer();

        let (tx, rx) = sync_channel::<PtyEvent>(BACKLOG);
        let exit_tx = tx.clone();
        let (write_tx, write_rx) = sync_channel::<Vec<u8>>(WRITE_BACKLOG);

        let relay = Arc::new(Mutex::new(Relay::new(sink)));
        let emitter_relay = relay.clone();
        let mut reap = Some(on_closed);
        // Every event goes through the relay so a later listener can catch up;
        // `on_closed` fires after the guard is released (lock order: registry
        // then relay, never the other way).
        let dispatch = move |event: PtyEvent| {
            let closed = matches!(event, PtyEvent::Closed);
            lock_relay(&emitter_relay).dispatch(event);
            if closed {
                if let Some(reap) = reap.take() {
                    reap();
                }
            }
        };

        spawn_thread("pty-reader", move || read_loop(reader, tx));
        spawn_thread("pty-emitter", move || emit_loop(rx, dispatch));
        spawn_thread("pty-writer", move || write_loop(writer, write_rx));
        spawn_thread("pty-waiter", move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            let _ = exit_tx.send(PtyEvent::Exit(code));
        });

        Ok(Self {
            master,
            write_tx,
            killer,
            relay,
        })
    }

    /// Point the session's events at `sink` instead, replaying the output it
    /// missed (see [`Relay`]) so a fresh terminal engine ends up showing the
    /// same screen. The previous sink is dropped. Returns the new listener's
    /// epoch, which is what it passes back to [`detach`](Self::detach).
    ///
    /// `cols`/`rows` are the grid the new listener is replaying INTO, and the
    /// resize happens FIRST, before the sink is swapped: a shell redraws when
    /// its pty changes size (ConPTY repaints the viewport, unix shells redraw
    /// the prompt line on SIGWINCH), so that redraw joins the replay buffer
    /// BEHIND the old screen. The replay therefore ends in a state drawn for
    /// the grid it is landing in, cursor included. Resize after attaching
    /// instead and the redraw paints on top of an already-restored old screen,
    /// which leaves the cursor in the column the old geometry put it.
    pub fn attach<F>(&self, cols: u16, rows: u16, sink: F) -> u64
    where
        F: FnMut(PtyEvent) + Send + 'static,
    {
        // A pty that refuses the resize (a child mid-exit) is still worth
        // attaching to: the alternative is spawning over a live shell.
        let _ = self.resize(cols, rows);
        lock_relay(&self.relay).attach(Box::new(sink))
    }

    /// Stop delivering events to the listener of `epoch`: they accumulate in
    /// the replay buffer until something attaches. The shell keeps running. A
    /// stale epoch (another window has attached since) does nothing.
    pub fn detach(&self, epoch: u64) {
        lock_relay(&self.relay).detach(epoch);
    }

    /// Queues `data` for the writer thread. Never blocks: a child that has
    /// stopped reading fills the kernel buffer, then the queue, and only then
    /// does this fail — with an error, not a stall (see the module docs).
    pub fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        use std::sync::mpsc::TrySendError;
        match self.write_tx.try_send(data.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(PtyError::io(
                "the pty is not accepting input (child not reading?)",
            )),
            Err(TrySendError::Disconnected(_)) => Err(PtyError::io("the pty is closed")),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(PtyError::io)
    }

    /// SIGKILL-equivalent. The reader then sees EOF and the session closes.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        self.killer.kill().map_err(PtyError::io)
    }
}

/// A poisoned relay means a sink panicked. The buffer is still coherent, so
/// recover rather than take the whole terminal down with it.
fn lock_relay(relay: &Arc<Mutex<Relay>>) -> MutexGuard<'_, Relay> {
    relay.lock().unwrap_or_else(|e| e.into_inner())
}

/// Zero rows or columns is a valid ioctl but nonsense to every TUI, and some
/// shells divide by it. One is the floor everywhere.
fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn build_command(options: &SpawnOptions) -> CommandBuilder {
    let program = options
        .program
        .clone()
        .unwrap_or_else(crate::shell::default_shell);
    let mut cmd = CommandBuilder::new(program);
    for arg in &options.args {
        cmd.arg(arg);
    }
    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    }
    // Env hygiene: claim exactly what src/term actually implements.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // The inherited PATH plus what the process missed (an installer's registry
    // edit on Windows, the user-space bin dirs a desktop launch lacks on
    // unix) — so an agent installed from one tab launches from the next. See
    // `shell::search_path`; a profile's own `env.PATH` below still wins.
    cmd.env("PATH", crate::shell::search_path());
    for (key, value) in &options.env {
        cmd.env(key, value);
    }
    cmd
}

fn spawn_thread<F: FnOnce() + Send + 'static>(name: &str, body: F) {
    let _ = thread::Builder::new().name(name.to_string()).spawn(body);
}

/// Drains the write queue into the pty. Ends when the session is dropped
/// (sender gone) or the pty stops taking input for good — a blocked `write_all`
/// returns with an error once the child dies and the master is dropped.
fn write_loop(mut writer: Box<dyn Write + Send>, rx: Receiver<Vec<u8>>) {
    while let Ok(data) = rx.recv() {
        if writer
            .write_all(&data)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: SyncSender<PtyEvent>) {
    let mut buf = vec![0u8; READ_BUF];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(PtyEvent::Output(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            // A closed pty reports EIO on Linux rather than EOF; either way
            // there is nothing left to read.
            Err(_) => break,
        }
    }
}

/// Drains the channel, merging small reads into one message. Ends when every
/// sender is gone (reader at EOF, child reaped), then reports `Closed`.
fn emit_loop<F: FnMut(PtyEvent)>(rx: Receiver<PtyEvent>, mut sink: F) {
    while let Ok(event) = rx.recv() {
        let PtyEvent::Output(mut buf) = event else {
            sink(event);
            continue;
        };

        let deadline = Instant::now() + FLUSH;
        let mut trailing = None;
        while buf.len() < MAX_COALESCED {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(PtyEvent::Output(next)) => buf.extend_from_slice(&next),
                // Never reorder an exit past the output that preceded it.
                Ok(control) => {
                    trailing = Some(control);
                    break;
                }
                Err(_) => break,
            }
        }

        sink(PtyEvent::Output(buf));
        if let Some(control) = trailing {
            sink(control);
        }
    }
    sink(PtyEvent::Closed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Collects everything a session emits so tests can assert on it.
    #[derive(Clone, Default)]
    struct Sink {
        output: Arc<Mutex<Vec<u8>>>,
        events: Arc<Mutex<Vec<PtyEvent>>>,
    }

    impl Sink {
        fn sink(&self) -> impl FnMut(PtyEvent) + Send + 'static {
            let output = self.output.clone();
            let events = self.events.clone();
            move |event| {
                if let PtyEvent::Output(bytes) = &event {
                    output.lock().unwrap().extend_from_slice(bytes);
                    events.lock().unwrap().push(PtyEvent::Output(Vec::new()));
                } else {
                    events.lock().unwrap().push(event);
                }
            }
        }

        fn text(&self) -> String {
            String::from_utf8_lossy(&self.output.lock().unwrap()).to_string()
        }

        fn events(&self) -> Vec<PtyEvent> {
            self.events.lock().unwrap().clone()
        }

        /// Polls until `predicate` holds, so tests never sleep a fixed amount.
        fn wait_for(&self, what: &str, predicate: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if predicate(self) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!(
                "timed out waiting for {what}; output so far: {:?}",
                self.text()
            );
        }
    }

    #[cfg(unix)]
    fn sh(script: &str) -> SpawnOptions {
        SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            ..SpawnOptions::default()
        }
    }

    #[cfg(windows)]
    fn interactive_shell() -> SpawnOptions {
        // A PATH of just System32 for the test shell. Cargo prepends every
        // `rustc-link-search` directory of every build script to the PATH a
        // test binary runs with — whisper-rs-sys's CMake build alone adds
        // ~115 of them (18 k characters) — and cmd.exe caps a variable at
        // 8 191 characters, so the inherited PATH loses System32 and
        // `mode con` below becomes "not recognized". The app never sees
        // that PATH; only cargo-run test binaries do.
        let system32 = std::env::var("SystemRoot")
            .map(|root| format!("{root}\\System32"))
            .unwrap_or_else(|_| "C:\\Windows\\System32".into());
        SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("cmd.exe".into()),
            // /Q: no command echo, so the output holds results and not the
            // lines the test typed. /K: stay open and keep reading.
            args: vec!["/Q".into(), "/K".into()],
            env: HashMap::from([("PATH".to_string(), system32)]),
            ..SpawnOptions::default()
        }
    }

    #[cfg(unix)]
    fn interactive_shell() -> SpawnOptions {
        SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("/bin/sh".into()),
            args: vec!["-i".into()],
            ..SpawnOptions::default()
        }
    }

    /// The handover a terminal tab dragged into another window performs, with
    /// a real shell on every platform: detach (the old webview's channel goes
    /// away), keep typing at it, then attach somewhere else. The shell must
    /// survive, and the new listener must see both the replay and what
    /// happened while nobody was listening.
    #[test]
    fn a_shell_survives_a_detach_and_replays_to_the_window_that_attaches() {
        let first = Sink::default();
        let mut session =
            PtySession::spawn(&interactive_shell(), first.sink(), || {}).expect("spawn");
        // ConPTY asks the terminal where the cursor is (DSR 6) and waits for
        // the answer before it runs anything; `src/term` replies to that, a
        // bare test sink has to do it by hand.
        session.write(b"\x1b[1;1R").unwrap();
        session.write(b"echo first-line\r\n").unwrap();
        first.wait_for("the first command's output", |s| {
            s.text().contains("first-line")
        });

        session.detach(SPAWN_EPOCH);
        session.write(b"echo second-line\r\n").unwrap();

        let second = Sink::default();
        // A different grid — the window the tab was dropped into is its own
        // size — so this also covers the resize attach performs first.
        let epoch = session.attach(100, 30, second.sink());
        second.wait_for("replay + output from while it was detached", |s| {
            s.text().contains("first-line") && s.text().contains("second-line")
        });
        // The marker told the new window the replay was over, so it may answer
        // the shell's queries again.
        assert!(
            second.events().contains(&PtyEvent::ReplayEnd),
            "the attach never marked the end of its replay"
        );
        // The shell is still the same live process, not a replay of a dead one.
        assert!(
            !second.events().contains(&PtyEvent::Closed),
            "the shell died during the handover"
        );
        // The detached listener heard nothing more — the sink really was swapped.
        assert!(
            !first.text().contains("second-line"),
            "the detached sink kept receiving: {:?}",
            first.text()
        );

        // The shell is living in the new window's grid: the resize was part
        // of attaching, so its redraw is inside the replay rather than
        // painted over it.
        session.write(size_command()).unwrap();
        second.wait_for("the shell reporting the new window's width", |s| {
            reports_width_100(&s.text())
        });

        // A detach quoting the epoch that has been replaced is ignored — the
        // releasing window's pane unmounting after the new one attached.
        session.detach(SPAWN_EPOCH);
        session.write(b"echo third-line\r\n").unwrap();
        second.wait_for("output after a stale detach", |s| {
            s.text().contains("third-line")
        });
        session.detach(epoch);

        // Don't leave an interactive shell behind. Whether the kill reports
        // success is the platform's business (Windows' ConPTY killer answers
        // "the operation completed successfully" as an error); dropping the
        // session closes the pty regardless.
        let _ = session.kill();
    }

    /// The epoch the spawning window's listener holds.
    const SPAWN_EPOCH: u64 = 0;

    /// Asks the shell how wide its pty is, so a test can check the resize
    /// reached the child and not just the ioctl.
    #[cfg(windows)]
    fn size_command() -> &'static [u8] {
        // `mode con` prints "Columns:        100" among its lines.
        b"mode con\r\n"
    }

    #[cfg(unix)]
    fn size_command() -> &'static [u8] {
        // `stty size` prints "<rows> <cols>".
        b"stty size\n"
    }

    /// Did the shell just say it is 100 columns wide? Matched on the reporting
    /// LINE, not on the whole stream: a 100-column terminal emits escapes that
    /// contain "100" (`ESC[100X`) all by itself, which would pass vacuously.
    #[cfg(windows)]
    fn reports_width_100(text: &str) -> bool {
        text.lines()
            .any(|line| line.contains("Columns") && line.contains("100"))
    }

    #[cfg(unix)]
    fn reports_width_100(text: &str) -> bool {
        text.lines().any(|line| line.trim() == "30 100")
    }

    #[test]
    #[cfg(unix)]
    fn runs_a_command_and_reports_its_exit_code() {
        let sink = Sink::default();
        let _session = PtySession::spawn(&sh("echo hello; exit 3"), sink.sink(), || {}).unwrap();

        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
        assert!(sink.text().contains("hello"), "got {:?}", sink.text());
        assert!(sink.events().contains(&PtyEvent::Exit(3)));
    }

    #[test]
    #[cfg(unix)]
    fn exports_a_terminal_environment() {
        let sink = Sink::default();
        let _session = PtySession::spawn(
            &sh("printf '%s/%s\\n' \"$TERM\" \"$COLORTERM\""),
            sink.sink(),
            || {},
        )
        .unwrap();

        sink.wait_for("output", |s| s.text().contains('/'));
        assert!(
            sink.text().contains("xterm-256color/truecolor"),
            "got {:?}",
            sink.text()
        );
    }

    #[test]
    #[cfg(unix)]
    fn writes_reach_the_child() {
        let sink = Sink::default();
        let session =
            PtySession::spawn(&sh("read line; echo \"got:$line\""), sink.sink(), || {}).unwrap();

        session.write(b"ping\n").unwrap();
        sink.wait_for("echoed line", |s| s.text().contains("got:ping"));
    }

    #[test]
    #[cfg(unix)]
    fn resize_is_visible_to_the_child() {
        let sink = Sink::default();
        // `read` holds the child until after the resize, so this cannot race.
        let session = PtySession::spawn(&sh("read _; stty size"), sink.sink(), || {}).unwrap();

        session.resize(100, 30).unwrap();
        session.write(b"\n").unwrap();
        sink.wait_for("stty output", |s| s.text().contains("30 100"));
    }

    #[test]
    #[cfg(unix)]
    fn kill_stops_a_child_that_would_never_exit() {
        let sink = Sink::default();
        let mut session =
            PtySession::spawn(&sh("while :; do sleep 1; done"), sink.sink(), || {}).unwrap();

        session.kill().unwrap();
        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
    }

    #[test]
    #[cfg(unix)]
    fn write_fails_fast_instead_of_blocking_when_the_child_stops_reading() {
        let sink = Sink::default();
        // Raw mode, or the line discipline discards over-long lines instead of
        // back-pressuring; -echo so the flood doesn't also come back as output.
        let mut session = PtySession::spawn(
            &sh("stty raw -echo; echo READY; sleep 30"),
            sink.sink(),
            || {},
        )
        .unwrap();
        sink.wait_for("raw mode", |s| s.text().contains("READY"));

        // Fill the kernel's pty input buffer, then the write queue. The old
        // code blocked here forever (holding the app-wide registry lock).
        let chunk = vec![b'x'; 4 * 1024];
        let started = Instant::now();
        let failed = (0..2000).any(|_| session.write(&chunk).is_err());
        assert!(failed, "every write to a non-reading child succeeded");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "write blocked instead of failing fast"
        );

        session.kill().unwrap();
        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
    }

    #[test]
    fn rejects_a_program_that_does_not_exist() {
        let options = SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("definitely-not-a-real-program".into()),
            ..SpawnOptions::default()
        };
        // `PtySession` holds trait objects and so isn't Debug; match rather
        // than unwrap_err.
        match PtySession::spawn(&options, |_| {}, || {}) {
            Err(error) => assert_eq!(error.code, PtyErrorCode::Spawn),
            Ok(_) => panic!("spawning a nonexistent program should fail"),
        }
    }

    /// Throughput baseline for the pty read path. Ignored by default so CI
    /// stays fast and deterministic; run it with
    /// `cargo test --lib -- --ignored --nocapture`.
    ///
    /// This measures the pty read path and the coalescer only — everything up
    /// to the sink. The IPC leg is not covered here.
    #[test]
    #[ignore = "benchmark; run with `cargo test --lib -- --ignored --nocapture`"]
    #[cfg(unix)]
    fn benchmark_throughput() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let path = std::env::temp_dir().join("md-specpad-pty-bench.txt");
        let line = format!("{}\n", "x".repeat(79));
        let mut data = String::with_capacity(10 << 20);
        while data.len() < (10 << 20) {
            data.push_str(&line);
        }
        std::fs::write(&path, &data).expect("write bench file");

        let bytes = Arc::new(AtomicUsize::new(0));
        let chunks = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));

        let (b, c, d) = (bytes.clone(), chunks.clone(), done.clone());
        let started = Instant::now();
        let _session = PtySession::spawn(
            &sh(&format!("cat {}", path.display())),
            move |event| match event {
                PtyEvent::Output(buf) => {
                    b.fetch_add(buf.len(), Ordering::Relaxed);
                    c.fetch_add(1, Ordering::Relaxed);
                }
                PtyEvent::Closed => {
                    d.store(1, Ordering::Release);
                }
                PtyEvent::Exit(_) | PtyEvent::ReplayEnd => {}
            },
            || {},
        )
        .expect("spawn cat");

        while done.load(Ordering::Acquire) == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "cat never finished"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let elapsed = started.elapsed();
        let total = bytes.load(Ordering::Relaxed);
        let _ = std::fs::remove_file(&path);

        println!(
            "cat 10MB: {:.1} MB/s ({} bytes in {} chunks, {:.0} KB/chunk, {:.2}s)",
            total as f64 / elapsed.as_secs_f64() / 1e6,
            total,
            chunks.load(Ordering::Relaxed),
            total as f64 / chunks.load(Ordering::Relaxed).max(1) as f64 / 1024.0,
            elapsed.as_secs_f64(),
        );
        // The pty adds \r to every \n, so the child writes more than the file.
        assert!(total >= 10 << 20);
    }

    /// A child that exits while detached still has to tell the next listener.
    #[test]
    #[cfg(unix)]
    fn attaching_after_the_child_exited_replays_the_exit_code() {
        let first = Sink::default();
        let session =
            PtySession::spawn(&sh("echo bye; exit 7"), first.sink(), || {}).expect("spawn");
        first.wait_for("exit", |s| s.events().contains(&PtyEvent::Exit(7)));
        session.detach(SPAWN_EPOCH);

        let second = Sink::default();
        session.attach(80, 24, second.sink());
        second.wait_for("replayed exit", |s| s.events().contains(&PtyEvent::Exit(7)));
        assert!(second.text().contains("bye"), "got {:?}", second.text());
    }

    /// The marker is the listener's cue that it may answer queries again; it
    /// has to come AFTER everything replayed, or the pane unmutes too early
    /// and answers a query out of the past.
    #[test]
    fn a_replay_ends_with_the_marker_that_tells_the_terminal_to_speak_again() {
        let mut relay = Relay::default();
        relay.dispatch(PtyEvent::Output(b"hello".to_vec()));
        relay.dispatch(PtyEvent::Exit(3));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        relay.attach(Box::new(move |event| log.lock().unwrap().push(event)));

        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                PtyEvent::Output(b"hello".to_vec()),
                PtyEvent::Exit(3),
                PtyEvent::ReplayEnd,
            ]
        );
    }

    /// …and it is per-attach, never recorded: a second window attaching must
    /// not be handed the first one's marker in the middle of its own replay.
    #[test]
    fn the_marker_is_not_part_of_what_a_later_listener_replays() {
        let mut relay = Relay::default();
        relay.dispatch(PtyEvent::Output(b"one".to_vec()));
        relay.attach(Box::new(|_| {}));
        relay.dispatch(PtyEvent::Output(b"two".to_vec()));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        relay.attach(Box::new(move |event| log.lock().unwrap().push(event)));

        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                PtyEvent::Output(b"one".to_vec()),
                PtyEvent::Output(b"two".to_vec()),
                PtyEvent::ReplayEnd,
            ]
        );
    }

    #[test]
    fn the_replay_buffer_drops_its_oldest_chunks_rather_than_growing() {
        let mut relay = Relay::default();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..40 {
            relay.dispatch(PtyEvent::Output(chunk.clone()));
        }
        assert!(
            relay.replay_bytes <= REPLAY_LIMIT,
            "buffer grew to {}",
            relay.replay_bytes
        );
        assert_eq!(
            relay.replay_bytes,
            relay.replay.iter().map(Vec::len).sum::<usize>(),
            "byte count drifted from the chunks"
        );

        // Everything it still holds is replayed, in order, to a new listener.
        let seen = Arc::new(Mutex::new(0usize));
        let counter = seen.clone();
        relay.attach(Box::new(move |event| {
            if let PtyEvent::Output(bytes) = event {
                *counter.lock().unwrap() += bytes.len();
            }
        }));
        assert_eq!(*seen.lock().unwrap(), relay.replay_bytes);
    }

    #[test]
    fn a_collapsed_window_never_asks_for_a_zero_sized_pty() {
        assert_eq!(pty_size(0, 0).cols, 1);
        assert_eq!(pty_size(0, 0).rows, 1);
        assert_eq!(pty_size(80, 24).cols, 80);
    }
}
