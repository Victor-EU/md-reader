//! Putting the server on the port (plan WP 3.1).
//!
//! Streamable HTTP on `127.0.0.1`, behind two checks that run before the
//! body is read.
//!
//! **The token.** Anything on this machine can reach the loopback
//! address, and what is behind this port is the reader's documents and a
//! way to write to them. The token is in a file only the owner can read
//! (see [`mdreader_core::agent`]), and a request without it never
//! reaches a tool.
//!
//! **The origin.** A page in a browser cannot read the token, but it can
//! be made to send a request to `127.0.0.1` — the DNS rebinding attack
//! the MCP specification tells local servers to guard against. So a
//! request that carries an `Origin` is only served when the origin is
//! this port. A client that is not a browser sends no `Origin` at all
//! and is unaffected.

use std::convert::Infallible;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use mdreader_core::agent;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use super::{Desk, Server};

/// The path the transport is mounted at, and the only one served.
const PATH: &str = "/mcp";

/// How often the client count is looked at when nothing is happening.
///
/// A session begins and ends on a request, so the count is right the
/// moment a request has been served. The one thing that moves it without
/// a request is the transport's own reaper, which closes a session whose
/// client went away without saying so five minutes later — and the
/// status bar should not still be saying somebody is connected then.
const SETTLE: Duration = Duration::from_secs(60);

/// How many accepts in a row may fail before the port is called lost.
///
/// Counted rather than sorted by kind: the errors worth surviving are
/// the ones a machine hands out when it is short of something -- no
/// descriptors left, a client that hung up between the handshake and
/// here -- and their spellings differ by platform. What tells those
/// apart from a listener that has been taken away is not the error, it
/// is whether the next one succeeds. Fifty at fifty milliseconds is two
/// and a half seconds, long enough for whatever took the descriptors to
/// give some back and short enough that a dead port is not pretended
/// about.
const GIVE_UP: u32 = 50;

/// Whoever wants to know how many clients there are.
type Told = Box<dyn Fn(u32) + Send + Sync>;

/// What the server needs to keep for as long as it runs.
#[derive(Default)]
pub struct Running {
    pub sessions: Arc<LocalSessionManager>,
    /// Told when the number of connected clients changes.
    told: Mutex<Option<Told>>,
    /// What it was told last, so it is told once per change.
    last: AtomicU32,
}

impl Running {
    /// How many MCP sessions are open. What the status bar calls
    /// connected clients, because that is what one is.
    pub async fn clients(&self) -> u32 {
        u32::try_from(self.sessions.sessions.read().await.len()).unwrap_or(u32::MAX)
    }

    /// Say who to tell when that number moves.
    pub fn on_change(&self, told: impl Fn(u32) + Send + Sync + 'static) {
        *self.told.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(told));
    }

    /// Count again, now that a request has been served, and say so if it
    /// has moved.
    ///
    /// Counted after each request rather than watched, because a session
    /// begins and ends on one: `initialize` opens it and a `DELETE`
    /// closes it. The one case this is late for is a client that goes
    /// away without saying so, whose session is counted until the next
    /// request from anybody or until the server's own idle timeout has
    /// it.
    async fn settled(&self) {
        let now = self.clients().await;
        if self.last.swap(now, Ordering::Relaxed) == now {
            return;
        }
        if let Some(told) = self
            .told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            told(now);
        }
    }
}

/// The bearer token, shared with whoever is allowed to change it.
///
/// Behind a lock rather than taken by value, and read on each request
/// rather than once: the palette's "Rotate agent token" writes a new one
/// into the endpoint file for the reader who wants the old one to stop
/// working, and a rotation the running server never saw would leave the
/// old token good for the life of the process -- the exact opposite of
/// what they asked for, reported as done.
pub type Token = Arc<Mutex<String>>;

/// Serve `desk` over `listener` until the process ends.
pub async fn serve(
    listener: std::net::TcpListener,
    token: Token,
    desk: Arc<dyn Desk>,
    running: Arc<Running>,
) {
    if listener.set_nonblocking(true).is_err() {
        eprintln!("the agent server could not take its port");
        return;
    }
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        eprintln!("the agent server could not take its port");
        return;
    };
    let port = listener.local_addr().map_or(0, |addr| addr.port());
    tokio::spawn({
        let running = Arc::clone(&running);
        async move {
            loop {
                tokio::time::sleep(SETTLE).await;
                running.settled().await;
            }
        }
    });
    let service = StreamableHttpService::new(
        {
            let desk = Arc::clone(&desk);
            move || Ok(Server::new(Arc::clone(&desk)))
        },
        Arc::clone(&running.sessions),
        StreamableHttpServerConfig::default(),
    );
    let mut refused = 0u32;
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => {
                refused = 0;
                stream
            }
            // One failed accept is one connection's problem, not the
            // server's. Returning on it ended the server for the rest of
            // the session while the port stayed written down, so every
            // later client was told there was a server and found nothing
            // listening. Breathe and take the next one.
            Err(_) if refused < GIVE_UP => {
                refused += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            // Nothing has got through in two and a half seconds. This is
            // the listener being taken away, which happens at shutdown,
            // and nothing here can put it back.
            Err(_) => return,
        };
        let service = service.clone();
        let token = Arc::clone(&token);
        let running = Arc::clone(&running);
        tokio::spawn(async move {
            let guarded = service_fn(move |request: Request<Incoming>| {
                let mut service = service.clone();
                let token = Arc::clone(&token);
                let running = Arc::clone(&running);
                async move {
                    let served = gate(&mut service, request, &token, port).await;
                    running.settled().await;
                    Ok::<_, Infallible>(served)
                }
            });
            let _served = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), guarded)
                .await;
        });
    }
}

/// What the transport answers with: a boxed body, because an SSE stream
/// and a JSON document are not the same shape and both come out of here.
type Served = Response<http_body_util::combinators::BoxBody<hyper::body::Bytes, Infallible>>;

/// The two checks and the path, before anything is parsed.
async fn gate<S>(service: &mut S, request: Request<Incoming>, token: &Token, port: u16) -> Served
where
    S: tower_service::Service<Request<Incoming>, Response = Served, Error = Infallible>,
{
    if request.uri().path() != PATH {
        return refuse(StatusCode::NOT_FOUND, "there is nothing here");
    }
    let headers = request.headers();
    // Read and compared inside the block, so the lock is not held across
    // the call below: this is the one place a synchronous lock meets an
    // async server.
    let allowed = {
        let current = token.lock().unwrap_or_else(PoisonError::into_inner);
        agent::authorized(
            headers
                .get(hyper::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            &current,
        )
    };
    if !allowed {
        return unauthorized();
    }
    if let Some(origin) = headers.get(hyper::header::ORIGIN)
        && !is_ours(origin.to_str().unwrap_or(""), port)
    {
        return refuse(
            StatusCode::FORBIDDEN,
            "this server answers its own machine only",
        );
    }
    service
        .call(request)
        .await
        .unwrap_or_else(|never| match never {})
}

/// Whether an `Origin` is this very server. Both spellings of the
/// loopback address, because a browser will use whichever it was given.
fn is_ours(origin: &str, port: u16) -> bool {
    origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}")
}

fn unauthorized() -> Served {
    let mut response = refuse(StatusCode::UNAUTHORIZED, "a bearer token is required");
    response.headers_mut().insert(
        hyper::header::WWW_AUTHENTICATE,
        hyper::header::HeaderValue::from_static("Bearer"),
    );
    response
}

fn refuse(status: StatusCode, message: &str) -> Served {
    let mut response = Response::new(
        http_body_util::Full::new(hyper::body::Bytes::from(message.to_owned()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_server_s_own_origin_is_ours() {
        assert!(is_ours("http://127.0.0.1:51234", 51_234));
        assert!(is_ours("http://localhost:51234", 51_234));
        assert!(!is_ours("http://127.0.0.1:51235", 51_234), "another port");
        assert!(!is_ours("https://example.com", 51_234));
        assert!(
            !is_ours("http://127.0.0.1.evil.test:51234", 51_234),
            "a hostname that only starts like the loopback address"
        );
    }
}
