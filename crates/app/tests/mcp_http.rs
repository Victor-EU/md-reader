//! The port, and the two checks in front of it (plan WP 3.1).
//!
//! The in-process test next door speaks the protocol over a pipe, which
//! is the right shape for the tools and says nothing about the socket.
//! This one is the socket: a real port, real requests, and the four
//! answers a request can get before it reaches a tool.

use std::sync::Arc;

use http_body_util::BodyExt as _;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use mdreader_app::mcp::{self, Desk};
use mdreader_core::{AgentAnswer, AgentDocument, AgentRequest, Error, SnapshotInfo};

/// A desk with nothing on it. Nothing here gets past the gate.
struct Empty;

impl Desk for Empty {
    fn documents(&self) -> mcp::Ask<Vec<AgentDocument>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn ask(&self, _request: AgentRequest) -> mcp::Ask<AgentAnswer> {
        Box::pin(async {
            Err(Error::Unavailable {
                what: "the document".to_owned(),
                message: "nothing is open".to_owned(),
            })
        })
    }
    fn snapshots(&self, _path: &std::path::Path) -> Result<Vec<SnapshotInfo>, Error> {
        Ok(Vec::new())
    }
    fn snapshot_text(&self, _id: &str) -> Result<String, Error> {
        Ok(String::new())
    }
    fn write(
        &self,
        _path: std::path::PathBuf,
        _content: String,
        _agent: String,
    ) -> mcp::Ask<SnapshotInfo> {
        unreachable!("nothing here gets that far")
    }
}

struct Reached {
    port: u16,
    token: String,
}

fn listening() -> Reached {
    let (listener, port) = mcp::bind().expect("bind");
    let token = mdreader_core::new_token();
    let desk: Arc<dyn Desk> = Arc::new(Empty);
    let running = Arc::new(mcp::serve::Running::default());
    let served = token.clone();
    tokio::spawn(async move { mcp::serve::serve(listener, served, desk, running).await });
    Reached { port, token }
}

/// One request, with whatever headers the case is about.
async fn post(
    at: &Reached,
    path: &str,
    headers: &[(&str, String)],
    body: &str,
) -> (hyper::StatusCode, String) {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", at.port))
        .await
        .expect("connect");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .expect("handshake");
    tokio::spawn(async move {
        let _closed = connection.await;
    });
    let mut request = hyper::Request::builder()
        .method("POST")
        .uri(format!("http://127.0.0.1:{}{path}", at.port))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    for (name, value) in headers {
        request = request.header(*name, value.clone());
    }
    let response = sender
        .send_request(
            request
                .body(http_body_util::Full::new(Bytes::from(body.to_owned())))
                .expect("request"),
        )
        .await
        .expect("send");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn initialize() -> &'static str {
    r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#
}

fn bearer(token: &str) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {token}"))]
}

#[tokio::test]
async fn a_request_with_no_token_never_reaches_a_tool() {
    let at = listening();
    let (status, _body) = post(&at, "/mcp", &[], initialize()).await;
    assert_eq!(status, hyper::StatusCode::UNAUTHORIZED);

    let wrong = bearer(&mdreader_core::new_token());
    let (status, _body) = post(&at, "/mcp", &wrong, initialize()).await;
    assert_eq!(
        status,
        hyper::StatusCode::UNAUTHORIZED,
        "another token is not this one"
    );
}

#[tokio::test]
async fn the_token_gets_in() {
    let at = listening();
    let (status, body) = post(&at, "/mcp", &bearer(&at.token), initialize()).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        body.contains("md-reader"),
        "the server names itself: {body}"
    );
}

/// The DNS rebinding guard the MCP specification asks local servers for:
/// a page in a browser cannot read the token, but it can be pointed at
/// the loopback address, and an `Origin` is how that shows up.
#[tokio::test]
async fn a_page_somewhere_else_is_turned_away() {
    let at = listening();
    let mut headers = bearer(&at.token);
    headers.push(("origin", "https://example.test".to_owned()));
    let (status, _body) = post(&at, "/mcp", &headers, initialize()).await;
    assert_eq!(status, hyper::StatusCode::FORBIDDEN);

    // And this server's own origin is not somewhere else.
    let mut ours = bearer(&at.token);
    ours.push(("origin", format!("http://127.0.0.1:{}", at.port)));
    let (status, _body) = post(&at, "/mcp", &ours, initialize()).await;
    assert!(status.is_success());
}

#[tokio::test]
async fn nothing_else_is_served_from_this_port() {
    let at = listening();
    let (status, _body) = post(&at, "/", &bearer(&at.token), initialize()).await;
    assert_eq!(status, hyper::StatusCode::NOT_FOUND);
    let (status, _body) = post(&at, "/mcp/../etc", &bearer(&at.token), initialize()).await;
    assert_eq!(status, hyper::StatusCode::NOT_FOUND);
}
