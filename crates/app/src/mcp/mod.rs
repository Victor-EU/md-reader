//! The MCP server of design 9 (plan WP 3.1).
//!
//! Three channels give the reader's work back to an AI: the clipboard,
//! the file on disk, and this. What this one adds is the two things the
//! other two cannot have. A highlight becomes something an agent can
//! query, because a `==mark==` in a file is a string and an annotation
//! record is a fact. And a write becomes attributable, because an agent
//! that says its name over a socket is a name we can put on a version,
//! where a program that writes a file is anonymous by construction.
//!
//! ## Where the answers come from
//!
//! Four of the five tools ask about a buffer: what it holds now, what
//! the reader marked in it, what changed in it since a version. None of
//! those live in Rust. The buffer is the editor's, and the annotations
//! and the blocks come out of a `Lezer` parse tree that only the
//! frontend has. So the server asks the window that has the document
//! open and waits for it to answer; [`Desk`] is that conversation, with
//! the routing and the Tauri events on the other side of it.
//!
//! The alternative was a mirror — every window pushing its buffer, its
//! annotations and its blocks into Rust whenever they settle. That pays
//! on every keystroke for a question asked once a minute, and on a ten
//! megabyte document it is a quarter of a second of flattening per pause
//! in typing. Asking costs nothing until somebody asks.
//!
//! ## What it will not reach
//!
//! Every tool is scoped to what the app has open: a document with a tab
//! on it, or, for a `write_document` that makes a new file, a path
//! inside a folder some window has open. This is a socket on
//! `127.0.0.1` and a token in a file, which is the same reach as
//! anything else the reader runs; the scope is here because a markdown
//! app's MCP server has no business being a general file reader, and
//! because the smaller the surface the shorter the argument about it.

pub mod bridge;
pub mod serve;
mod tools;

use std::collections::HashMap;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use mdreader_core::{
    AgentAnnotation, AgentAnswer, AgentChange, AgentDocument, AgentRequest, Endpoint, Error,
    SnapshotInfo, agent,
};
use tokio::sync::oneshot;

pub use tools::Server;

/// How long a window is given to answer one question.
///
/// The slowest answer there is, measured: flattening a ten megabyte
/// document into blocks costs about a quarter of a second, and it
/// happens behind whatever else the window was in the middle of. Five
/// seconds is room for that with an order of magnitude to spare, and it
/// is short enough that an agent talking to a window that has stopped
/// answering hears about it rather than hanging.
pub const ANSWER: Duration = Duration::from_secs(5);

/// A question whose answer is somewhere else. Boxed because [`Desk`] is
/// used as a trait object: the app answers it out of Tauri, and the
/// tests answer it out of a fixture, and the tools cannot tell.
pub type Ask<T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send>>;

/// What the tools need from the rest of the app.
///
/// Everything the MCP server can do to this machine goes through here,
/// which is what makes the surface reviewable in one page and testable
/// without a window.
pub trait Desk: Send + Sync + 'static {
    /// Every document open in every window (design 9).
    fn documents(&self) -> Ask<Vec<AgentDocument>>;

    /// Put a question to the window that has the document open.
    ///
    /// `Err(Unavailable)` when no window has it, which is a different
    /// thing from a window that could not answer.
    fn ask(&self, request: AgentRequest) -> Ask<AgentAnswer>;

    /// The versions of a document the history holds, newest first.
    ///
    /// # Errors
    /// When there is no history to read.
    fn snapshots(&self, path: &Path) -> Result<Vec<SnapshotInfo>, Error>;

    /// One version's text.
    ///
    /// # Errors
    /// When the id is unknown or the store cannot be read.
    fn snapshot_text(&self, id: &str) -> Result<String, Error>;

    /// Write a document as `agent`, and tell the windows who did it.
    ///
    /// Asynchronous like the reads, and for the same reason: whether a
    /// path is one this server may write is the question of whether a
    /// window has it open, and the windows are what answer that.
    ///
    /// # Errors
    /// Anything a save can fail with, plus a path outside what is open.
    fn write(&self, path: PathBuf, content: String, agent: String) -> Ask<SnapshotInfo>;
}

/// The questions that are out with the windows, waiting.
///
/// A question is a number, an event, and somewhere to put the answer.
/// The number is what comes back, because an event is one way and a
/// window may be answering two things at once.
#[derive(Default)]
pub struct Agents {
    next: AtomicU32,
    /// By id: which window was asked, and where its answer goes.
    pending: Mutex<HashMap<u32, (String, oneshot::Sender<AgentAnswer>)>>,
}

fn locked<T>(what: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    what.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Agents {
    /// Open a question for `label`. The id goes to the window; the
    /// receiver stays here.
    #[must_use]
    pub fn open(&self, label: &str) -> (u32, oneshot::Receiver<AgentAnswer>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        locked(&self.pending).insert(id, (label.to_owned(), send));
        (id, receive)
    }

    /// A window has answered. An id nobody is waiting for is dropped:
    /// it is an answer that arrived after its question timed out, and
    /// there is nothing left to give it to.
    pub fn answer(&self, id: u32, answer: AgentAnswer) {
        if let Some((_, send)) = locked(&self.pending).remove(&id) {
            let _late = send.send(answer);
        }
    }

    /// Give up on one, whatever became of it.
    pub fn close(&self, id: u32) {
        locked(&self.pending).remove(&id);
    }

    /// A window has gone. Everything it was going to answer, it is not.
    ///
    /// Dropping the sender is what the waiting side hears: without this
    /// every question out with a closed window would sit out its whole
    /// timeout before anyone found out.
    pub fn forget(&self, label: &str) {
        locked(&self.pending).retain(|_, (asked, _)| asked != label);
    }
}

/// Wait for one answer, or say why there is none.
///
/// # Errors
/// `Unavailable` when the window closed the question or never answered.
pub async fn wait(
    receive: oneshot::Receiver<AgentAnswer>,
    what: &str,
) -> Result<AgentAnswer, Error> {
    match tokio::time::timeout(ANSWER, receive).await {
        Ok(Ok(AgentAnswer::Failed { message })) => Err(Error::Unavailable {
            what: what.to_owned(),
            message,
        }),
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(_gone)) => Err(Error::Unavailable {
            what: what.to_owned(),
            message: "the window it was open in has closed".to_owned(),
        }),
        Err(_slow) => Err(Error::Unavailable {
            what: what.to_owned(),
            message: format!("the window did not answer within {}s", ANSWER.as_secs()),
        }),
    }
}

/// Take a port from the operating system and hold it.
///
/// The listener is bound here rather than inside the server so that the
/// port is known before anything is written to the endpoint file: a
/// client reading that file must never find a port nothing is listening
/// on yet.
///
/// # Errors
/// When `127.0.0.1` cannot be bound at all, which is a machine with no
/// loopback and not a port that was taken — the port is the OS's choice.
pub fn bind() -> Result<(TcpListener, u16), Error> {
    let listener =
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).map_err(|error| {
            Error::Unavailable {
                what: "the agent server".to_owned(),
                message: format!("cannot listen on 127.0.0.1: {error}"),
            }
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| Error::Unavailable {
            what: "the agent server".to_owned(),
            message: format!("cannot read the port it was given: {error}"),
        })?
        .port();
    Ok((listener, port))
}

/// The token this app answers to, and the file that says so.
///
/// The token is last launch's if there was one, because a token that
/// changed on every launch would break every client configured with it.
/// The port never is.
///
/// # Errors
/// When the endpoint file cannot be written, which leaves the server
/// running and unreachable, so the caller reports it rather than the
/// reader finding out from a client.
pub fn publish(app_data: &Path, port: u16) -> Result<Endpoint, Error> {
    let token = agent::kept_token(app_data).unwrap_or_else(agent::new_token);
    let endpoint = Endpoint::new(port, token);
    agent::publish(app_data, &endpoint)?;
    Ok(endpoint)
}

/// A fresh token, published, for the palette command that rotates one.
///
/// # Errors
/// As [`publish`].
pub fn rotate(app_data: &Path, port: u16) -> Result<Endpoint, Error> {
    let endpoint = Endpoint::new(port, agent::new_token());
    agent::publish(app_data, &endpoint)?;
    Ok(endpoint)
}

/// The configuration to paste into a client, for the palette command
/// that copies one (plan WP 3.1).
///
/// The stdio form rather than the URL form, because most clients are
/// configured with a command and because the command reads the endpoint
/// file itself: a configuration with the port in it would be wrong on
/// the next launch, and one with the token in it would be a secret in
/// somebody's dotfiles.
#[must_use]
pub fn client_config(binary: &Path) -> String {
    format!(
        "{{\n  \"mcpServers\": {{\n    \"md-reader\": {{\n      \"command\": {},\n      \"args\": [\"--mcp-stdio\"]\n    }}\n  }}\n}}\n",
        serde_json::Value::String(binary.to_string_lossy().into_owned())
    )
}

/// Unwrap the answer a window gave, or say what it gave instead.
///
/// A window answering the wrong question is a bug in this file or in
/// the window, never something an agent did, so it reads as one.
fn expected<T>(
    what: &str,
    answer: AgentAnswer,
    take: impl FnOnce(AgentAnswer) -> Option<T>,
) -> Result<T, Error> {
    match take(answer) {
        Some(value) => Ok(value),
        None => Err(Error::Unavailable {
            what: what.to_owned(),
            message: "the window answered a different question".to_owned(),
        }),
    }
}

/// The buffer of an open document.
///
/// # Errors
/// When no window has it open, or the window could not answer.
pub async fn text(desk: &dyn Desk, path: PathBuf) -> Result<(String, bool), Error> {
    let answer = desk.ask(AgentRequest::Read { path }).await?;
    expected("the document", answer, |answer| match answer {
        AgentAnswer::Text { text, dirty } => Some((text, dirty)),
        _ => None,
    })
}

/// The annotations in an open document.
///
/// # Errors
/// As [`text`].
pub async fn annotations(desk: &dyn Desk, path: PathBuf) -> Result<Vec<AgentAnnotation>, Error> {
    let answer = desk.ask(AgentRequest::Annotations { path }).await?;
    expected("the annotations", answer, |answer| match answer {
        AgentAnswer::Annotations { annotations } => Some(annotations),
        _ => None,
    })
}

/// The semantic diff from `against` to the buffer.
///
/// # Errors
/// As [`text`].
pub async fn changes(
    desk: &dyn Desk,
    path: PathBuf,
    against: String,
) -> Result<Vec<AgentChange>, Error> {
    let answer = desk.ask(AgentRequest::Changes { path, against }).await?;
    let (old, new) = expected("the changes", answer, |answer| match answer {
        AgentAnswer::Changes { old, new } => Some((old, new)),
        _ => None,
    })?;
    Ok(mdreader_core::agent_changes(&old, &new))
}

/// A server over `desk`, ready to be mounted on a transport.
#[must_use]
pub fn server(desk: Arc<dyn Desk>) -> Server {
    Server::new(desk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_configuration_is_the_command_and_the_flag() {
        let config = client_config(Path::new(
            "/Applications/MD Reader.app/Contents/MacOS/mdreader-desktop",
        ));
        assert!(
            config.contains(
                "\"command\": \"/Applications/MD Reader.app/Contents/MacOS/mdreader-desktop\""
            ),
            "got {config}"
        );
        assert!(config.contains("\"args\": [\"--mcp-stdio\"]"));
        assert!(
            !config.contains("token"),
            "the token stays in the endpoint file and out of anybody's dotfiles"
        );
        serde_json::from_str::<serde_json::Value>(&config)
            .expect("it has to parse where it is pasted");
    }

    #[test]
    fn a_path_with_a_quote_in_it_is_still_json() {
        let config = client_config(Path::new(r#"/tmp/od"d/mdreader"#));
        serde_json::from_str::<serde_json::Value>(&config).expect("parses");
    }

    #[test]
    fn the_port_comes_from_the_operating_system() {
        let (listener, port) = bind().expect("bind");
        assert_ne!(port, 0, "a port nothing is listening on is not an endpoint");
        assert_eq!(
            listener.local_addr().expect("addr").ip().to_string(),
            "127.0.0.1",
            "the machine and nowhere else"
        );
    }
}
