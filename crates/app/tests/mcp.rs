//! An MCP client, in this process, against the real tools (plan WP 3.1).
//!
//! What is real here: the files on disk, the history store, the write
//! path, the block alignment, and the whole of the protocol from
//! `initialize` to a tool result. What is a fixture is the one thing
//! that cannot be — the window, which in the app is a webview with a
//! parse tree in it.
//!
//! The fixture answers the way a window does and no better: it flattens
//! paragraphs rather than markdown, and it has a fixed set of
//! annotations. The mapping from an alignment to what an agent reads is
//! not duplicated here — that lives in the core and is tested there,
//! which is why the fixture hands back blocks rather than changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use markdown_app::mcp::{self, Desk};
use markdown_core::{
    AgentAnnotation, AgentAnswer, AgentDocument, AgentRequest, AnnotationKind, AnnotationMark,
    Block, Error, History, SnapshotAuthor, SnapshotInfo,
};
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, ReadResourceRequestParams};
use rmcp::service::{RoleClient, RunningService};
use serde_json::{Value, json};

// --- the fixture --------------------------------------------------------

struct Window {
    dir: tempfile::TempDir,
    history: Mutex<History>,
    /// Every document the fixture window has open: the buffer, and
    /// whether it is ahead of the file.
    open: Mutex<Vec<Open>>,
    annotations: Mutex<HashMap<PathBuf, Vec<AgentAnnotation>>>,
    /// Set to make the window stop answering, the way a window that has
    /// closed the tab does.
    mute: Mutex<bool>,
}

#[derive(Clone)]
struct Open {
    path: Option<PathBuf>,
    name: String,
    text: String,
    dirty: bool,
}

impl Window {
    fn new() -> Arc<Self> {
        let dir = tempfile::tempdir().expect("temp dir");
        let history = History::open(&dir.path().join("history")).expect("history");
        Arc::new(Self {
            dir,
            history: Mutex::new(history),
            open: Mutex::new(Vec::new()),
            annotations: Mutex::new(HashMap::new()),
            mute: Mutex::new(false),
        })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Put a document on disk and open a tab on it.
    fn open_file(&self, name: &str, text: &str) -> PathBuf {
        let path = self.path(name);
        std::fs::write(&path, text).expect("fixture");
        self.history
            .lock()
            .expect("history")
            .snapshot(&path, text, SnapshotAuthor::User)
            .expect("first version");
        self.open.lock().expect("open").push(Open {
            path: Some(path.clone()),
            name: name.to_owned(),
            text: text.to_owned(),
            dirty: false,
        });
        path
    }

    /// Type into the buffer without saving, which is what `dirty` means.
    fn edit(&self, path: &Path, text: &str) {
        let mut open = self.open.lock().expect("open");
        let found = open
            .iter_mut()
            .find(|doc| doc.path.as_deref() == Some(path))
            .expect("a tab on it");
        text.clone_into(&mut found.text);
        found.dirty = true;
    }

    fn buffer(&self, path: &Path) -> Option<String> {
        self.open
            .lock()
            .expect("open")
            .iter()
            .find(|doc| doc.path.as_deref() == Some(path))
            .map(|doc| doc.text.clone())
    }

    fn latest(&self, path: &Path) -> Option<SnapshotInfo> {
        self.history
            .lock()
            .expect("history")
            .list(path)
            .ok()?
            .into_iter()
            .next()
    }
}

/// Paragraphs, the way the frontend's flattener would give them but
/// without a markdown parser: one block per run of non-blank lines.
fn paragraphs(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut at = 0u32;
    for piece in text.split("\n\n") {
        let width = u32::try_from(piece.encode_utf16().count()).unwrap_or(0);
        if !piece.trim().is_empty() {
            blocks.push(Block {
                kind: if piece.starts_with('#') {
                    "heading".to_owned()
                } else {
                    "paragraph".to_owned()
                },
                text: piece.trim().to_owned(),
                from: at,
                to: at + width,
            });
        }
        at += width + 2;
    }
    blocks
}

impl Desk for Window {
    fn documents(&self) -> mcp::Ask<Vec<AgentDocument>> {
        let open = self.open.lock().expect("open").clone();
        Box::pin(async move {
            Ok(open
                .into_iter()
                .map(|doc| AgentDocument {
                    byte_len: doc.text.len() as u64,
                    modified_ms: doc
                        .path
                        .as_deref()
                        .and_then(|path| std::fs::metadata(path).ok())
                        .and_then(|meta| meta.modified().ok())
                        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|since| u64::try_from(since.as_millis()).unwrap_or(0)),
                    path: doc.path,
                    name: doc.name,
                    dirty: doc.dirty,
                })
                .collect())
        })
    }

    fn ask(&self, request: AgentRequest) -> mcp::Ask<AgentAnswer> {
        if *self.mute.lock().expect("mute") {
            return Box::pin(async {
                Err(Error::Unavailable {
                    what: "the document".to_owned(),
                    message: "the window did not answer within 5s".to_owned(),
                })
            });
        }
        let path = request.path().map(Path::to_path_buf).unwrap_or_default();
        let Some(buffer) = self.buffer(&path) else {
            return Box::pin(async move {
                Err(Error::Unavailable {
                    what: path.display().to_string(),
                    message: "no window has it open; list_documents says what is".to_owned(),
                })
            });
        };
        let dirty = self
            .open
            .lock()
            .expect("open")
            .iter()
            .find(|doc| doc.path.as_deref() == Some(path.as_path()))
            .is_some_and(|doc| doc.dirty);
        let annotations = self
            .annotations
            .lock()
            .expect("annotations")
            .get(&path)
            .cloned()
            .unwrap_or_default();
        Box::pin(async move {
            Ok(match request {
                AgentRequest::Documents => unreachable!("documents has its own method"),
                AgentRequest::Open { .. } => unreachable!("open has its own method"),
                AgentRequest::Read { .. } => AgentAnswer::Text {
                    text: buffer,
                    dirty,
                },
                AgentRequest::Annotations { .. } => AgentAnswer::Annotations { annotations },
                AgentRequest::Changes { against, .. } => AgentAnswer::Changes {
                    old: paragraphs(&against),
                    new: paragraphs(&buffer),
                },
            })
        })
    }

    fn snapshots(&self, path: &Path) -> Result<Vec<SnapshotInfo>, Error> {
        self.history.lock().expect("history").list(path)
    }

    fn snapshot_text(&self, path: &Path, id: &str) -> Result<String, Error> {
        self.history.lock().expect("history").read_for(path, id)
    }

    fn write(&self, path: PathBuf, content: String, agent: String) -> mcp::Ask<SnapshotInfo> {
        // Everything the app does but the event: the file, then the
        // version under the agent's name, then the buffer catching up.
        let done = markdown_core::agent::write_document(&path, &content).and_then(|written| {
            let info = self.history.lock().expect("history").snapshot_by(
                &path,
                &written.content,
                SnapshotAuthor::Agent,
                Some(&agent),
            )?;
            let mut open = self.open.lock().expect("open");
            if let Some(doc) = open
                .iter_mut()
                .find(|doc| doc.path.as_deref() == Some(path.as_path()))
            {
                doc.text = written.content;
                doc.dirty = false;
            }
            Ok(info)
        });
        Box::pin(async move { done })
    }

    fn open(&self, path: PathBuf, window: Option<String>) -> mcp::Ask<mcp::Opened> {
        // The fixture is one window, called what the app's first one is.
        if let Some(label) = window.filter(|label| label != "main") {
            return Box::pin(async move {
                Err(Error::Unavailable {
                    what: format!("the window {label}"),
                    message: "no window has that label; the windows there are: main".to_owned(),
                })
            });
        }
        let done = std::fs::read_to_string(&path).map_or_else(
            |_| {
                Err(Error::Unavailable {
                    what: path.display().to_string(),
                    message: "there is no file there to open; write it first".to_owned(),
                })
            },
            |text| {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let mut open = self.open.lock().expect("open");
                if !open
                    .iter()
                    .any(|doc| doc.path.as_deref() == Some(path.as_path()))
                {
                    open.push(Open {
                        path: Some(path.clone()),
                        name: name.clone(),
                        text,
                        dirty: false,
                    });
                }
                Ok(mcp::Opened {
                    window: "main".to_owned(),
                    name,
                })
            },
        );
        Box::pin(async move { done })
    }
}

// --- the client ---------------------------------------------------------

async fn connect(window: Arc<Window>) -> RunningService<RoleClient, ()> {
    let (server_side, client_side) = tokio::io::duplex(64 * 1024);
    let desk: Arc<dyn Desk> = window;
    tokio::spawn(async move {
        let server = mcp::server(desk).serve(server_side).await.expect("serve");
        let _ended = server.waiting().await;
    });
    ().serve(client_side).await.expect("connect")
}

/// Call a tool and take its structured result apart.
async fn call(client: &RunningService<RoleClient, ()>, name: &str, arguments: Value) -> Value {
    let result = client
        .call_tool(
            CallToolRequestParams::new(name.to_owned())
                .with_arguments(arguments.as_object().cloned().unwrap_or_default()),
        )
        .await
        .expect("the call itself");
    assert_ne!(
        result.is_error,
        Some(true),
        "{name} refused: {:?}",
        result.content
    );
    result
        .structured_content
        .unwrap_or_else(|| panic!("{name} answered with no structured content"))
}

/// The message a tool refused with.
async fn refusal(client: &RunningService<RoleClient, ()>, name: &str, arguments: Value) -> String {
    let result = client
        .call_tool(
            CallToolRequestParams::new(name.to_owned())
                .with_arguments(arguments.as_object().cloned().unwrap_or_default()),
        )
        .await
        .expect("the call itself");
    assert_eq!(result.is_error, Some(true), "{name} did not refuse");
    result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|text| text.text.clone()))
        .collect::<Vec<_>>()
        .join(" ")
}

// --- the tests ----------------------------------------------------------

#[tokio::test]
async fn every_tool_is_offered_with_a_description() {
    let client = connect(Window::new()).await;
    let tools = client.list_all_tools().await.expect("list");
    let mut names: Vec<_> = tools.iter().map(|tool| tool.name.to_string()).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "changes_since",
            "list_annotations",
            "list_documents",
            "open_document",
            "read_document",
            "write_document",
        ],
        "design 9 names five tools and ADR 0039 a sixth"
    );
    for tool in &tools {
        let description = tool.description.as_deref().unwrap_or("");
        assert!(
            description.len() > 40,
            "{} has nothing for a model to go on: {description:?}",
            tool.name
        );
    }
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn the_open_documents_and_what_is_in_them() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "# Brief\n\nThe first draft.\n");
    window.open_file("notes.md", "Notes.\n");
    window.edit(&brief, "# Brief\n\nThe first draft, revised.\n");
    let client = connect(Arc::clone(&window)).await;

    let listed = call(&client, "list_documents", json!({})).await;
    let documents = listed["documents"].as_array().expect("documents");
    assert_eq!(documents.len(), 2);
    assert_eq!(documents[0]["name"], "brief.md");
    assert_eq!(documents[0]["dirty"], true, "the reader has typed");
    assert_eq!(documents[1]["dirty"], false);

    let read = call(&client, "read_document", json!({ "path": brief })).await;
    assert_eq!(
        read["content"], "# Brief\n\nThe first draft, revised.\n",
        "the buffer and not the file"
    );
    assert_eq!(read["dirty"], true);
    assert!(
        read["snapshot_id"].is_string(),
        "an id to measure the next change from"
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_document_nobody_has_open_is_a_refusal_and_not_a_failure() {
    let window = Window::new();
    let client = connect(Arc::clone(&window)).await;
    let message = refusal(
        &client,
        "read_document",
        json!({ "path": window.path("elsewhere.md") }),
    )
    .await;
    assert!(
        message.contains("no window has it open"),
        "the model has to be able to act on it: {message}"
    );
    assert!(
        message.contains("list_documents"),
        "and be told what to do instead: {message}"
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn the_marks_the_reader_made() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "The migration can be done in one sprint.\n");
    window.annotations.lock().expect("annotations").insert(
        brief.clone(),
        vec![AgentAnnotation {
            mark: AnnotationMark::Highlight,
            meaning: None,
            anchor: "The migration can be done in one sprint".to_owned(),
            from: 0,
            to: 38,
            comment: Some(markdown_core::AgentComment {
                kind: AnnotationKind::Note,
                text: "too ambitious, cut to two weeks".to_owned(),
            }),
        }],
    );
    let client = connect(Arc::clone(&window)).await;

    let listed = call(&client, "list_annotations", json!({ "path": brief })).await;
    let annotations = listed["annotations"].as_array().expect("annotations");
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations[0]["mark"], "highlight");
    assert_eq!(annotations[0]["comment"]["kind"], "note");
    assert_eq!(
        annotations[0]["comment"]["text"], "too ambitious, cut to two weeks",
        "the reader talking, in words"
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn what_changed_since_a_version_is_blocks_and_not_lines() {
    let window = Window::new();
    let brief = window.open_file(
        "brief.md",
        "# Brief\n\nTwo reviewers have signed off.\n\nCosts are unchanged.",
    );
    let first = window.latest(&brief).expect("a version").id;
    window.edit(
        &brief,
        "# Brief\n\nThree reviewers have signed off.\n\nCosts are unchanged.",
    );
    let client = connect(Arc::clone(&window)).await;

    let diff = call(
        &client,
        "changes_since",
        json!({ "path": brief, "snapshot_id": first }),
    )
    .await;
    let changes = diff["changes"].as_array().expect("changes");
    assert_eq!(
        changes.len(),
        1,
        "the heading and the last paragraph did not move: {changes:#?}"
    );
    assert_eq!(changes[0]["op"], "changed");
    assert_eq!(changes[0]["old"], "Two reviewers have signed off.");
    assert_eq!(changes[0]["new"], "Three reviewers have signed off.");
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_version_id_nobody_knows_says_how_to_get_one() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "One.\n");
    let client = connect(Arc::clone(&window)).await;
    let message = refusal(
        &client,
        "changes_since",
        json!({ "path": brief, "snapshot_id": "0000000000000-000000" }),
    )
    .await;
    assert!(
        message.contains("read the document again") || message.contains("Read the document again"),
        "got {message}"
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_write_lands_on_disk_under_the_agent_s_name() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "# Brief\n\nThe first draft.\n");
    let client = connect(Arc::clone(&window)).await;

    let written = call(
        &client,
        "write_document",
        json!({
            "path": brief,
            "content": "# Brief\n\nThe second draft.\n",
            "agent_name": "claude",
        }),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(&brief).expect("read back"),
        "# Brief\n\nThe second draft.\n",
        "the file itself, because the file is the channel"
    );
    let version = window.latest(&brief).expect("a version");
    assert_eq!(version.id, written["snapshot_id"]);
    assert_eq!(version.author, SnapshotAuthor::Agent);
    assert_eq!(
        version.agent.as_deref(),
        Some("claude"),
        "by name, which is what file watching cannot give"
    );
    assert_eq!(
        window.buffer(&brief).as_deref(),
        Some("# Brief\n\nThe second draft.\n"),
        "and the window has it"
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_write_with_no_name_on_it_is_refused() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "One.\n");
    let client = connect(Arc::clone(&window)).await;
    let message = refusal(
        &client,
        "write_document",
        json!({ "path": brief, "content": "Two.\n", "agent_name": "   " }),
    )
    .await;
    assert!(message.contains("cannot be empty"), "got {message}");
    assert_eq!(
        std::fs::read_to_string(&brief).expect("read back"),
        "One.\n",
        "and nothing was written"
    );
    client.cancel().await.expect("close");
}

/// The whole round trip design 9 is for: the agent reads what the reader
/// marked, acts on it in words, and writes a version they can see.
#[tokio::test]
async fn an_agent_reads_the_annotations_and_leaves_a_version() {
    let window = Window::new();
    let brief = window.open_file(
        "brief.md",
        "# Brief\n\nThe migration can be done in one sprint.\n",
    );
    window.annotations.lock().expect("annotations").insert(
        brief.clone(),
        vec![AgentAnnotation {
            mark: AnnotationMark::Color,
            meaning: Some(AnnotationKind::Rewrite),
            anchor: "The migration can be done in one sprint".to_owned(),
            from: 10,
            to: 48,
            comment: Some(markdown_core::AgentComment {
                kind: AnnotationKind::Rewrite,
                text: "too ambitious, say two weeks".to_owned(),
            }),
        }],
    );
    let client = connect(Arc::clone(&window)).await;

    let listed = call(&client, "list_documents", json!({})).await;
    let path = listed["documents"][0]["path"].as_str().expect("a path");
    let read = call(&client, "read_document", json!({ "path": path })).await;
    let before = read["snapshot_id"].as_str().expect("a version").to_owned();

    let notes = call(&client, "list_annotations", json!({ "path": path })).await;
    let asked = notes["annotations"][0]["comment"]["kind"]
        .as_str()
        .expect("a kind");
    assert_eq!(asked, "rewrite", "the reader asked for a rewrite");

    call(
        &client,
        "write_document",
        json!({
            "path": path,
            "content": "# Brief\n\nThe migration takes two weeks.\n",
            "agent_name": "claude",
        }),
    )
    .await;

    // And the reader can see what it did, measured from where it began.
    let diff = call(
        &client,
        "changes_since",
        json!({ "path": path, "snapshot_id": before }),
    )
    .await;
    let changes = diff["changes"].as_array().expect("changes");
    assert_eq!(changes.len(), 1, "{changes:#?}");
    assert_eq!(changes[0]["op"], "changed");
    assert_eq!(changes[0]["new"], "The migration takes two weeks.");
    assert_eq!(
        window.latest(&brief).expect("a version").agent.as_deref(),
        Some("claude")
    );
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_file_nobody_had_open_is_opened_and_then_read() {
    let window = Window::new();
    let path = window.path("later.md");
    std::fs::write(&path, "# Later\n\nNot open yet.\n").expect("fixture");
    let client = connect(Arc::clone(&window)).await;

    let before = refusal(&client, "read_document", json!({ "path": path })).await;
    assert!(before.contains("no window has it open"), "{before}");

    let opened = call(&client, "open_document", json!({ "path": path })).await;
    assert_eq!(opened["window"], "main");
    assert_eq!(opened["name"], "later.md");

    let text = call(&client, "read_document", json!({ "path": path })).await;
    assert_eq!(text["content"], "# Later\n\nNot open yet.\n");
    assert_eq!(text["dirty"], false);

    // Opening it again in the window it is in is not a second tab.
    let again = call(
        &client,
        "open_document",
        json!({ "path": path, "window": "main" }),
    )
    .await;
    assert_eq!(again["window"], "main");
    assert_eq!(window.open.lock().expect("open").len(), 1);
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn what_open_document_refuses_says_what_to_do_instead() {
    let window = Window::new();
    let missing = window.path("missing.md");
    let there = window.open_file("there.md", "Here.\n");
    let client = connect(window).await;

    let relative = refusal(
        &client,
        "open_document",
        json!({ "path": "notes/brief.md" }),
    )
    .await;
    assert!(relative.contains("not an absolute path"), "{relative}");

    let gone = refusal(&client, "open_document", json!({ "path": missing })).await;
    assert!(gone.contains("write it first"), "{gone}");

    let nowhere = refusal(
        &client,
        "open_document",
        json!({ "path": there, "window": "window-9" }),
    )
    .await;
    assert!(nowhere.contains("the windows there are: main"), "{nowhere}");
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn the_open_documents_are_resources_too() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "# Brief\n\nOne.\n");
    let client = connect(Arc::clone(&window)).await;

    let listed = client.list_all_resources().await.expect("list");
    assert_eq!(listed.len(), 1);
    let uri = format!("doc://{}", brief.display());
    assert_eq!(listed[0].uri, uri);
    assert_eq!(listed[0].mime_type.as_deref(), Some("text/markdown"));

    let read = client
        .read_resource(ReadResourceRequestParams::new(uri.clone()))
        .await
        .expect("read");
    let text = read
        .contents
        .iter()
        .find_map(|content| match content {
            rmcp::model::ResourceContents::TextResourceContents { text, .. } => Some(text.clone()),
            _other => None,
        })
        .expect("text");
    assert_eq!(text, "# Brief\n\nOne.\n");
    client.cancel().await.expect("close");
}

#[tokio::test]
async fn a_window_that_stops_answering_is_a_failure_and_not_a_hang() {
    let window = Window::new();
    let brief = window.open_file("brief.md", "One.\n");
    *window.mute.lock().expect("mute") = true;
    let client = connect(Arc::clone(&window)).await;
    let message = refusal(&client, "read_document", json!({ "path": brief })).await;
    assert!(message.contains("did not answer"), "got {message}");
    client.cancel().await.expect("close");
}
