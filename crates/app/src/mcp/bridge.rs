//! `--mcp-stdio`: the app's own binary as a client transport (plan WP 3.1).
//!
//! The server is streamable HTTP on a port the operating system chose,
//! and most MCP clients are configured with a command and a pipe. So the
//! binary has a second mode that is neither the app nor a server: it
//! reads the endpoint file, and forwards what arrives on stdin to that
//! port and what comes back to stdout.
//!
//! Reading the file every launch is the whole reason this exists rather
//! than a URL in somebody's configuration. The port changes on every
//! launch of the app and the token does not, so a configuration with
//! either in it would be either wrong tomorrow or a secret in a dotfile;
//! a configuration with neither is right forever.
//!
//! It forwards and does not interpret, with two exceptions, both of them
//! headers the transport needs and the client cannot know about: the
//! session id the server hands out at `initialize`, and the protocol
//! version the two of them settled on.
//!
//! One direction only. The streamable HTTP transport also has a GET
//! stream for messages a server starts — sampling, elicitation, roots —
//! and this server starts none, so there is none to carry.

use std::path::PathBuf;
use std::sync::Arc;

use http_body_util::BodyExt as _;
use hyper::body::Bytes;
use hyper::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use markdown_core::{Endpoint, agent};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::Mutex;

/// The header the server keys a session by.
const SESSION: &str = "mcp-session-id";
/// The header that says which version of the protocol is being spoken.
const VERSION: &str = "mcp-protocol-version";

/// What one launch of the bridge knows.
struct Bridge {
    endpoint: Endpoint,
    /// Handed out by the server at `initialize` and sent back on
    /// everything after it.
    session: Mutex<Option<HeaderValue>>,
    /// What the two of them settled on, echoed back the same way.
    version: Mutex<Option<HeaderValue>>,
    out: Out,
}

/// Where a message goes. Two variants so that the pipe half of this
/// file can be tested against a real server without a real pipe.
enum Out {
    /// One writer, because a line has to arrive whole.
    Pipe(Mutex<tokio::io::Stdout>),
    #[cfg(test)]
    Kept(Mutex<Vec<String>>),
}

impl Bridge {
    fn new(endpoint: Endpoint, out: Out) -> Self {
        Self {
            endpoint,
            session: Mutex::new(None),
            version: Mutex::new(None),
            out,
        }
    }
}

/// Run the bridge until stdin ends. The process exit code.
///
/// `identifier` is the app's bundle identifier, which is what names its
/// data directory; it is passed in rather than written here twice, so
/// the two can never disagree.
#[must_use]
pub fn run(identifier: &str) -> i32 {
    let Some(dir) = app_data_dir(identifier) else {
        eprintln!("markdown --mcp-stdio: this machine has no home directory to look in");
        return 2;
    };
    let Some(endpoint) = agent::read(&dir) else {
        eprintln!(
            "markdown --mcp-stdio: no server to reach. {} says where one is, and Markdown writes it when it starts. Is the app running?",
            agent::endpoint_path(&dir).display()
        );
        return 2;
    };
    if endpoint.port == 0 {
        eprintln!("markdown --mcp-stdio: the last run of Markdown had no agent server");
        return 2;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("markdown --mcp-stdio: {error}");
            return 2;
        }
    };
    runtime.block_on(pump(Arc::new(Bridge::new(
        endpoint,
        Out::Pipe(Mutex::new(tokio::io::stdout())),
    ))))
}

/// Every line of stdin, forwarded.
///
/// One task per line, so a tool call that takes a second does not hold
/// up the notification behind it. A client is required to wait for the
/// `initialize` response before it sends anything else, which is what
/// makes the session id below safe to set from a task.
async fn pump(bridge: Arc<Bridge>) -> i32 {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = Vec::new();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => {}
            Ok(Some(line)) => {
                let bridge = Arc::clone(&bridge);
                tasks.push(tokio::spawn(async move {
                    if let Err(error) = forward(&bridge, line).await {
                        eprintln!("markdown --mcp-stdio: {error}");
                    }
                }));
            }
            // The client has gone. Let what is in flight finish, so a
            // response already on its way still reaches the pipe.
            Ok(None) => break,
            Err(error) => {
                eprintln!("markdown --mcp-stdio: {error}");
                return 1;
            }
        }
    }
    for task in tasks {
        let _finished = task.await;
    }
    0
}

/// One message there and back.
async fn forward(bridge: &Bridge, message: String) -> Result<(), String> {
    let mut request = Request::builder()
        .method("POST")
        .uri(&bridge.endpoint.url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json, text/event-stream")
        .header(AUTHORIZATION, format!("Bearer {}", bridge.endpoint.token));
    if let Some(session) = bridge.session.lock().await.clone() {
        request = request.header(SESSION, session);
    }
    if let Some(version) = bridge.version.lock().await.clone() {
        request = request.header(VERSION, version);
    }
    let request = request
        .body(http_body_util::Full::new(Bytes::from(message)))
        .map_err(|error| error.to_string())?;

    let stream = tokio::net::TcpStream::connect(("127.0.0.1", bridge.endpoint.port))
        .await
        .map_err(|error| {
            format!(
                "nothing is listening on port {}. Is Markdown still running? ({error})",
                bridge.endpoint.port
            )
        })?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| error.to_string())?;
    // The connection drives itself; it ends when the body does.
    tokio::spawn(async move {
        let _closed = connection.await;
    });
    let response = sender
        .send_request(request)
        .await
        .map_err(|error| error.to_string())?;

    // Before anything reaches stdout: a client that reads the
    // `initialize` response may send the next message immediately, and
    // that message needs these.
    if let Some(session) = response.headers().get(SESSION) {
        *bridge.session.lock().await = Some(session.clone());
    }
    if let Some(version) = response.headers().get(VERSION) {
        *bridge.version.lock().await = Some(version.clone());
    }

    let status = response.status();
    let sse = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut body = response.into_body();

    if !status.is_success() {
        let whole = collect(&mut body).await;
        return Err(refused(status, &whole));
    }
    if sse {
        return stream_events(bridge, body).await;
    }
    let whole = collect(&mut body).await;
    // 202 Accepted with nothing in it is the answer to a notification:
    // there is no reply to write.
    if whole.trim().is_empty() {
        return Ok(());
    }
    say(bridge, &whole).await;
    Ok(())
}

fn refused(status: StatusCode, body: &str) -> String {
    let body = body.trim();
    match status {
        StatusCode::UNAUTHORIZED => format!(
            "the server would not take the token in the endpoint file ({status}). It may have been rotated since; try again."
        ),
        _ if body.is_empty() => format!("the server answered {status}"),
        _ => format!("the server answered {status}: {body}"),
    }
}

/// An SSE stream, as far as it goes: every `data:` payload becomes one
/// line of stdout, which is what the stdio transport is.
async fn stream_events(bridge: &Bridge, mut body: hyper::body::Incoming) -> Result<(), String> {
    let mut buffer = String::new();
    let mut data = String::new();
    loop {
        let frame = match body.frame().await {
            Some(Ok(frame)) => frame,
            Some(Err(error)) => return Err(error.to_string()),
            None => break,
        };
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find('\n') {
            let line = buffer[..end].trim_end_matches('\r').to_owned();
            buffer.drain(..=end);
            if line.is_empty() {
                // A blank line ends one event.
                if !data.is_empty() {
                    say(bridge, &data).await;
                    data.clear();
                }
            } else if let Some(payload) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(payload.strip_prefix(' ').unwrap_or(payload));
            }
            // Every other field -- `event:`, `id:`, a comment -- is the
            // transport's own and is not a message.
        }
    }
    if !data.is_empty() {
        say(bridge, &data).await;
    }
    Ok(())
}

/// One message to the client, as one line.
async fn say(bridge: &Bridge, message: &str) {
    let message = message.trim_end();
    match &bridge.out {
        Out::Pipe(pipe) => {
            let mut out = pipe.lock().await;
            let _written = out.write_all(message.as_bytes()).await;
            let _written = out.write_all(b"\n").await;
            let _flushed = out.flush().await;
        }
        #[cfg(test)]
        Out::Kept(kept) => kept.lock().await.push(message.to_owned()),
    }
}

async fn collect(body: &mut hyper::body::Incoming) -> String {
    let mut whole = Vec::new();
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(chunk) = frame.into_data() {
            whole.extend_from_slice(&chunk);
        }
    }
    String::from_utf8_lossy(&whole).into_owned()
}

/// Where Tauri keeps an app's data, worked out without a Tauri app.
///
/// This process is not the app: it has no configuration and no handle to
/// ask. The three rules below are the ones `app_data_dir` follows, and
/// the by-hand pass checks that both halves land in the same folder.
#[must_use]
pub fn app_data_dir(identifier: &str) -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    {
        Some(home()?.join("Library/Application Support").join(identifier))
    }
    #[cfg(target_os = "windows")]
    {
        let _unused = home;
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join(identifier))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| home().map(|home| home.join(".local/share")))?;
        Some(data.join(identifier))
    }
}

/// Whether this launch is the bridge rather than the app.
#[must_use]
pub fn wanted(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--mcp-stdio")
}

/// The path of the endpoint file for an identifier, for the message the
/// palette shows when there is no server.
#[must_use]
pub fn endpoint_for(identifier: &str) -> Option<PathBuf> {
    app_data_dir(identifier).map(|dir| agent::endpoint_path(&dir))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use markdown_core::{AgentAnswer, AgentDocument, AgentRequest, Error, SnapshotInfo};

    use super::*;
    use crate::mcp::{self, Desk};

    /// A desk with one document on it, enough to answer `list_documents`
    /// and to prove the protocol went all the way through.
    struct One;

    impl Desk for One {
        fn documents(&self) -> mcp::Ask<Vec<AgentDocument>> {
            Box::pin(async {
                Ok(vec![AgentDocument {
                    path: Some(PathBuf::from("/notes/brief.md")),
                    name: "brief.md".to_owned(),
                    dirty: false,
                    byte_len: 7,
                    modified_ms: None,
                }])
            })
        }
        fn ask(&self, _request: AgentRequest) -> mcp::Ask<AgentAnswer> {
            Box::pin(async {
                Err(Error::Unavailable {
                    what: "the document".to_owned(),
                    message: "not in this test".to_owned(),
                })
            })
        }
        fn snapshots(&self, _path: &std::path::Path) -> Result<Vec<SnapshotInfo>, Error> {
            Ok(Vec::new())
        }
        fn snapshot_text(&self, _path: &std::path::Path, _id: &str) -> Result<String, Error> {
            Ok(String::new())
        }
        fn write(
            &self,
            _path: PathBuf,
            _content: String,
            _agent: String,
        ) -> mcp::Ask<SnapshotInfo> {
            unreachable!("not in this test")
        }
    }

    /// Everything the bridge has written so far.
    async fn kept(bridge: &Bridge) -> Vec<String> {
        match &bridge.out {
            Out::Kept(kept) => kept.lock().await.clone(),
            Out::Pipe(_) => unreachable!("these tests write to a vector"),
        }
    }

    /// The whole of the bridge's job, against a real server on a real
    /// port: initialize, keep the session, then use it.
    #[tokio::test]
    async fn a_message_in_is_a_message_out_and_the_session_sticks() {
        let (listener, port) = mcp::bind().expect("bind");
        let token = markdown_core::new_token();
        let desk: Arc<dyn Desk> = Arc::new(One);
        let running = Arc::new(mcp::serve::Running::default());
        let served = Arc::new(std::sync::Mutex::new(token.clone()));
        tokio::spawn(async move { mcp::serve::serve(listener, served, desk, running).await });

        let bridge = Bridge::new(
            Endpoint::new(port, token),
            Out::Kept(Mutex::new(Vec::new())),
        );
        forward(
            &bridge,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#
                .to_owned(),
        )
        .await
        .expect("initialize");
        assert!(
            bridge.session.lock().await.is_some(),
            "the session id has to be kept, or nothing after this works"
        );

        // A notification: accepted, and nothing to write back.
        forward(
            &bridge,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_owned(),
        )
        .await
        .expect("initialized");

        forward(
            &bridge,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_documents","arguments":{}}}"#
                .to_owned(),
        )
        .await
        .expect("call");

        let lines = kept(&bridge).await;
        assert_eq!(
            lines.len(),
            2,
            "one answer each for the two requests, and none for the notification: {lines:#?}"
        );
        for line in &lines {
            assert!(!line.contains('\n'), "a message is one line: {line:?}");
            serde_json::from_str::<serde_json::Value>(line).expect("each line is a message");
        }
        assert!(lines[0].contains("markdown-app"), "{}", lines[0]);
        assert!(lines[1].contains("brief.md"), "{}", lines[1]);
    }

    /// Rotating the token has to reach the server that is already
    /// running. It did not: `serve` was handed the token by value, so
    /// the palette command wrote a new one into the endpoint file, told
    /// the reader the old one had stopped working, and the old one went
    /// on working until the app was quit.
    #[tokio::test]
    async fn rotating_the_token_reaches_the_running_server() {
        let (listener, port) = mcp::bind().expect("bind");
        let first = markdown_core::new_token();
        let desk: Arc<dyn Desk> = Arc::new(One);
        let running = Arc::new(mcp::serve::Running::default());
        let served = Arc::new(std::sync::Mutex::new(first.clone()));
        let held = Arc::clone(&served);
        tokio::spawn(async move { mcp::serve::serve(listener, held, desk, running).await });

        let hello = || {
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#
                .to_owned()
        };
        let bridge = |token: String| {
            Bridge::new(
                Endpoint::new(port, token),
                Out::Kept(Mutex::new(Vec::new())),
            )
        };

        let old = bridge(first);
        forward(&old, hello()).await.expect("the first token works");

        let second = markdown_core::new_token();
        *served
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = second.clone();

        let error = forward(&bridge(old.endpoint.token.clone()), hello())
            .await
            .expect_err("the rotated-away token is refused");
        assert!(error.contains("rotated"), "got {error}");
        forward(&bridge(second), hello())
            .await
            .expect("the new token works");
    }

    #[tokio::test]
    async fn a_token_the_server_will_not_take_says_so_in_a_sentence() {
        let (listener, port) = mcp::bind().expect("bind");
        let desk: Arc<dyn Desk> = Arc::new(One);
        let running = Arc::new(mcp::serve::Running::default());
        let served = Arc::new(std::sync::Mutex::new(markdown_core::new_token()));
        tokio::spawn(async move { mcp::serve::serve(listener, served, desk, running).await });

        let bridge = Bridge::new(
            Endpoint::new(port, markdown_core::new_token()),
            Out::Kept(Mutex::new(Vec::new())),
        );
        let error = forward(
            &bridge,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_owned(),
        )
        .await
        .expect_err("refused");
        assert!(error.contains("rotated"), "got {error}");
    }

    #[tokio::test]
    async fn nothing_listening_names_the_port_and_the_app() {
        let (listener, port) = mcp::bind().expect("bind");
        drop(listener);
        let bridge = Bridge::new(
            Endpoint::new(port, markdown_core::new_token()),
            Out::Kept(Mutex::new(Vec::new())),
        );
        let error = forward(
            &bridge,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_owned(),
        )
        .await
        .expect_err("nothing there");
        assert!(error.contains(&port.to_string()), "got {error}");
        assert!(error.contains("Markdown"), "got {error}");
    }

    #[test]
    fn only_the_flag_asks_for_the_bridge() {
        let args = |rest: &[&str]| -> Vec<String> {
            std::iter::once("markdown-desktop")
                .chain(rest.iter().copied())
                .map(str::to_owned)
                .collect()
        };
        assert!(wanted(&args(&["--mcp-stdio"])));
        assert!(!wanted(&args(&[])));
        assert!(!wanted(&args(&["note.md"])));
        assert!(
            !wanted(&args(&["--mcp-stdio-ish"])),
            "a flag that only starts the same way is another flag"
        );
    }

    #[test]
    fn the_data_directory_is_the_one_tauri_would_have_used() {
        let dir = app_data_dir("io.github.example.app").expect("a machine with a home");
        assert!(
            dir.ends_with("io.github.example.app"),
            "got {}",
            dir.display()
        );
        assert!(dir.is_absolute());
    }

    #[test]
    fn the_endpoint_is_the_file_the_app_writes() {
        let path = endpoint_for("io.github.example.app").expect("a machine with a home");
        assert!(path.ends_with(agent::FILE), "got {}", path.display());
    }
}
