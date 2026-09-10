//! The endpoint file, and the write an agent makes (design 9, plan WP 3.1).
//!
//! The MCP server listens on a random port, so a client cannot be
//! configured with an address that keeps working; the address is written
//! to a file in the app's own data directory instead, and a client is
//! configured with the one command that reads it. The token is the other
//! half of that file, and unlike the port it is kept: a token that
//! changed on every launch would break every client that had been
//! configured with it.
//!
//! The token is what makes the port safe to open. Anything on this
//! machine can reach `127.0.0.1`, and what is behind this port is the
//! reader's documents and a way to write to them, so a request without
//! the token is refused before it is parsed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::atomic::{self, Create};
use crate::document::{Error, FileFormat, SaveResult};
use crate::eol;

/// What the file is called, inside the app's data directory.
pub const FILE: &str = "mcp.json";

/// How many bytes of randomness the token carries. Thirty-two is what
/// every other bearer token is: enough that guessing it is not a thing
/// that happens, short enough to paste.
const TOKEN_BYTES: usize = 32;

/// The path an agent client is pointed at.
///
/// A file rather than a fixed port, because a fixed port is a port
/// something else on the machine may already have, and losing the race
/// for it would leave the app with no server at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    /// The port this launch is listening on. Zero means the server did
    /// not start, which is the difference between "not running" and "not
    /// reachable" for whoever reads this next.
    pub port: u16,
    pub token: String,
    /// The whole address, so a client that takes a URL needs no assembly
    /// and a person reading the file can see what it means.
    pub url: String,
}

impl Endpoint {
    #[must_use]
    pub fn new(port: u16, token: String) -> Self {
        Self {
            url: url_for(port),
            port,
            token,
        }
    }
}

/// Where the streamable HTTP transport is mounted. One path, because
/// there is one server and nothing else is served from this port.
#[must_use]
pub fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

#[must_use]
pub fn endpoint_path(app_data: &Path) -> PathBuf {
    app_data.join(FILE)
}

/// A fresh token: [`TOKEN_BYTES`] from the operating system, in hex.
///
/// Hex rather than base64 because this is pasted into JSON in somebody's
/// client configuration, and hex has no character that has to survive a
/// round trip through anything.
///
/// # Panics
/// If the operating system has no random source. A token of zeroes
/// would be worse than a panic, and there is nothing else to fall back
/// to that is a secret.
#[must_use]
pub fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    // The only way this fails is an OS with no entropy source, which is
    // not a machine this app runs on. A token of zeroes would be worse
    // than a panic here, so the fallback is the length itself: `fill`
    // either fills the whole buffer or fails.
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    let mut out = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// What is in the endpoint file now, if it parses.
///
/// Every failure is the same answer — nothing — because the three that
/// can happen (no file yet, a file from a build that wrote it
/// differently, a half-written file from a crash) all mean the same
/// thing to the caller: there is no endpoint to trust, make one.
#[must_use]
pub fn read(app_data: &Path) -> Option<Endpoint> {
    let text = fs::read_to_string(endpoint_path(app_data)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The token this app answers to, kept across launches.
///
/// The port in the file is last launch's and is ignored; the token is
/// the whole reason the file is read at startup rather than written over.
#[must_use]
pub fn kept_token(app_data: &Path) -> Option<String> {
    read(app_data)
        .map(|endpoint| endpoint.token)
        .filter(|token| !token.is_empty())
}

/// Write the endpoint, readable by nobody else.
///
/// The file holds a bearer token, so the bits matter as much as the
/// bytes. `Create::Private` is what a new file gets; an existing file
/// keeps its own bits through an atomic replace, so they are set again
/// afterwards for the file whose mode somebody widened.
///
/// # Errors
/// Any I/O failure from writing the file.
pub fn publish(app_data: &Path, endpoint: &Endpoint) -> Result<PathBuf, Error> {
    let path = endpoint_path(app_data);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| Error::Write {
            path: dir.to_path_buf(),
            message: error.to_string(),
        })?;
    }
    let mut body = serde_json::to_vec_pretty(endpoint).map_err(|error| Error::Write {
        path: path.clone(),
        message: error.to_string(),
    })?;
    body.push(b'\n');
    atomic::replace(&path, &body, Create::Private).map_err(|error| Error::Write {
        path: path.clone(),
        message: error.to_string(),
    })?;
    restrict(&path);
    Ok(path)
}

/// Owner-only, best effort. A file whose mode cannot be set is still an
/// endpoint file; the token is what it is either way, and refusing to
/// serve over it would be the larger failure.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

/// Windows has no mode to set. The file lands in the user's own
/// `AppData`, which is where every other per-user secret on the machine
/// lives; an ACL of its own is Windows platform work and is not written
/// here, and no claim is made that it has one.
#[cfg(not(unix))]
fn restrict(_path: &Path) {}

/// Whether a request's `Authorization` header carries the token.
///
/// Compared in constant time. The compare is over a string that arrived
/// from the network against one that did not, which is exactly the shape
/// that leaks a token one byte at a time to a caller who can time it.
#[must_use]
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    // A server with no token answers to nobody, rather than to everybody
    // who sends an empty one. Nothing reaches this in one piece today --
    // the token is generated before the listener is spawned -- but the
    // door being shut when there is no lock on it is not a thing to
    // leave to the order two other functions happen to run in.
    if token.is_empty() {
        return false;
    }
    let Some(header) = header else { return false };
    let Some(offered) = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
    else {
        return false;
    };
    equal(offered.as_bytes(), token.as_bytes())
}

fn equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut same = 0u8;
    for (x, y) in a.iter().zip(b) {
        same |= x ^ y;
    }
    same == 0
}

/// What an agent's write left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Write {
    pub saved: SaveResult,
    /// The file as it was before, normalized to LF. Empty for a file
    /// that was not there. This is the base the change is measured
    /// against, and reading it here is what keeps the app from reading
    /// the file twice to find it out.
    pub before: String,
    /// What the file now says, normalized to LF: what the windows are
    /// told arrived.
    pub content: String,
}

/// Write a document on an agent's behalf, in the file's stored form.
///
/// This is [`crate::save_document`] with no hash to present, which is
/// deliberate: an agent writing a document is the same event as any
/// other program writing it, and the app's answer to that is the merge
/// of design 6.4 rather than a refusal. What makes it different from a
/// stray `echo >` is that the app knows who did it, which is what the
/// snapshot and the gutter are told.
///
/// A file that does not exist yet is created. An agent that names a path
/// under a folder that does not exist is not, because a tool call that
/// makes directories is a bigger thing than a tool call that writes a
/// file, and design 9 asks for the file.
///
/// # Errors
/// `ReadOnlyEncoding` for a document that is not UTF-8, `Write` for I/O
/// failures, `Read` when the file is there but cannot be read.
pub fn write_document(path: &Path, content: &str) -> Result<Write, Error> {
    let mut before = String::new();
    let format = match crate::read_document(path) {
        Ok(document) => {
            before = eol::normalize_lf(&document.content);
            document.meta.format
        }
        // Nothing there yet: the agent is making the file, and it gets
        // the platform's own defaults rather than another file's habits.
        Err(Error::Read { .. }) if !path.exists() => FileFormat {
            // LF, because a file with no lines yet has no habit to keep
            // and the app normalizes to LF anyway (design 6.3).
            eol: crate::Eol::Lf,
            mixed_eol: false,
            bom: false,
            trailing_newline: true,
            encoding: "utf-8".to_owned(),
        },
        Err(error) => return Err(error),
    };
    let saved = crate::save_document(path, content, None, &format)?;
    Ok(Write {
        saved,
        before,
        content: eol::normalize_lf(content),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mdreader-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_token_is_thirty_two_bytes_of_hex_and_never_the_same_one() {
        let one = new_token();
        assert_eq!(one.len(), TOKEN_BYTES * 2);
        assert!(one.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(one, new_token(), "two launches are two tokens");
    }

    #[test]
    fn the_port_changes_and_the_token_is_kept() {
        let dir = dir("kept");
        assert_eq!(kept_token(&dir), None, "nothing to keep on a first launch");
        let token = new_token();
        publish(&dir, &Endpoint::new(51_000, token.clone())).expect("publish");
        assert_eq!(kept_token(&dir).as_deref(), Some(token.as_str()));

        // The next launch: a different port, the same token, because a
        // client configured yesterday still has to work today.
        publish(&dir, &Endpoint::new(52_000, token.clone())).expect("publish again");
        let endpoint = read(&dir).expect("read back");
        assert_eq!(endpoint.port, 52_000);
        assert_eq!(endpoint.token, token);
        assert_eq!(endpoint.url, "http://127.0.0.1:52000/mcp");
    }

    #[cfg(unix)]
    #[test]
    fn the_endpoint_file_is_the_owner_s_alone() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = dir("mode");
        let path = publish(&dir, &Endpoint::new(1, new_token().clone())).expect("publish");
        let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a bearer token is nobody else's business");

        // And a file somebody widened is narrowed again on the next
        // launch, rather than keeping the bits an atomic replace copies.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("widen");
        publish(&dir, &Endpoint::new(2, new_token())).expect("publish again");
        let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn an_unreadable_endpoint_is_no_endpoint() {
        let dir = dir("junk");
        assert_eq!(read(&dir), None, "no file at all");
        fs::write(endpoint_path(&dir), b"{ half a fil").expect("write junk");
        assert_eq!(read(&dir), None, "a file a crash left half written");
    }

    #[test]
    fn only_the_token_is_authorized() {
        let token = new_token();
        assert!(authorized(Some(&format!("Bearer {token}")), &token));
        assert!(
            authorized(Some(&format!("bearer {token}")), &token),
            "the scheme is case-insensitive in the HTTP spec, so it is here"
        );
        assert!(!authorized(None, &token), "no header at all");
        assert!(!authorized(Some(&token), &token), "no scheme");
        assert!(!authorized(Some("Bearer "), &token), "empty");
        assert!(!authorized(Some(&format!("Bearer {token}x")), &token));
        assert!(!authorized(Some("Basic abc"), &token));
        // A server that has no token yet answers to nobody. `Bearer `
        // with nothing after it is a constant-time match for an empty
        // token, which is the one input that would otherwise let a
        // request in through a lock that has not been fitted.
        assert!(!authorized(Some("Bearer "), ""), "no token configured");
        assert!(!authorized(Some("Bearer anything"), ""));
    }

    #[test]
    fn an_agent_write_keeps_the_form_the_file_was_stored_in() {
        let dir = dir("write");
        let path = dir.join("crlf.md");
        fs::write(&path, b"# One\r\n\r\nTwo\r\n").expect("fixture");
        let write = write_document(&path, "# One\n\nTwo three\n").expect("write");
        assert_eq!(write.before, "# One\n\nTwo\n", "and it says what it said");
        assert_eq!(
            fs::read(&path).expect("read back"),
            b"# One\r\n\r\nTwo three\r\n",
            "the agent sends LF and the file keeps its CRLF"
        );
    }

    #[test]
    fn an_agent_write_can_make_a_file_that_was_not_there() {
        let dir = dir("new");
        let path = dir.join("fresh.md");
        write_document(&path, "# Fresh\n").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read back"), "# Fresh\n");
    }

    #[test]
    fn an_agent_cannot_write_a_document_that_is_not_utf8() {
        let dir = dir("latin");
        let path = dir.join("latin.md");
        fs::write(&path, b"# caf\xe9\n").expect("fixture");
        let error = write_document(&path, "# cafe\n").expect_err("refused");
        assert!(
            matches!(error, Error::ReadOnlyEncoding { .. }),
            "got {error:?}"
        );
    }
}
