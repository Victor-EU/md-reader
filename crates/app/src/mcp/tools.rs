//! The six tools and the resources of design 9 (and ADR 0039).
//!
//! Everything here is a thin adapter over [`Desk`]: the tools decide what
//! an agent may ask for and how the answer reads, and nothing else.
//!
//! Two kinds of failure, told apart the way MCP tells them apart. A tool
//! that ran and could not do the thing — a document nobody has open, a
//! version the history does not hold — comes back as a tool error, whose
//! message the model reads and can act on. A tool that could not run at
//! all — no history on this machine, a window that stopped answering —
//! comes back as a protocol error, which the client renders as its own
//! kind of nothing.

// `#[tool_handler]` writes the `ServerHandler` methods that route a call
// into the router, and the two that only look a tool up have nothing to
// await. They are still `async fn` because the trait says so.
#![allow(clippy::unused_async_trait_impl)]

use std::path::PathBuf;
use std::sync::Arc;

use markdown_core::{AgentAnnotation, AgentChange, AgentDocument, Error};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ListResourcesResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{Desk, annotations, changes, text};

/// The scheme design 9 names for an open document.
const SCHEME: &str = "doc://";

#[derive(Clone)]
pub struct Server {
    desk: Arc<dyn Desk>,
    tool_router: ToolRouter<Self>,
}

// --- what the tools take ------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
pub struct Which {
    /// Absolute path of an open document, as `list_documents` gives it.
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct Since {
    /// Absolute path of an open document.
    pub path: String,
    /// A version id from an earlier `read_document`.
    pub snapshot_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct Write {
    /// Absolute path. An open document, or a new file inside a folder
    /// the app has open.
    pub path: String,
    /// The whole document. This is a replacement and not a patch: send
    /// what the file should say, in full.
    pub content: String,
    /// What to call you in the reader's history and in the margin of the
    /// change. A short name, the way a person would say it.
    pub agent_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenWhere {
    /// Absolute path of a file on this machine. It need not be open yet;
    /// opening it is the point.
    pub path: String,
    /// The label of the window to open it in, as an earlier
    /// `open_document` gave it. Leave it out for the window that already
    /// has the file, or else the one in front.
    pub window: Option<String>,
}

// --- what they give back ------------------------------------------------

#[derive(Debug, Serialize, JsonSchema)]
pub struct Documents {
    pub documents: Vec<AgentDocument>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Text {
    pub path: String,
    /// The buffer, which may be ahead of the file on disk.
    pub content: String,
    /// The reader has typed something the file does not have yet.
    pub dirty: bool,
    /// The newest version the history holds. Give it to `changes_since`
    /// later to see what happened after this. When `dirty` is true the
    /// content above is already ahead of it.
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Annotations {
    pub path: String,
    pub annotations: Vec<AgentAnnotation>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Diff {
    pub path: String,
    /// The version this is measured from.
    pub snapshot_id: String,
    /// Blocks that changed, in document order. Blocks that did not are
    /// not here.
    pub changes: Vec<AgentChange>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Written {
    pub path: String,
    /// The version this write left in the reader's history, under your
    /// name.
    pub snapshot_id: String,
    #[schemars(description = "Size of the file after the write, in bytes")]
    pub byte_len: u64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct Opened {
    pub path: String,
    /// The window it is in. Pass it back to `open_document` to put the
    /// next file beside this one.
    pub window: String,
    /// What the tab calls it.
    pub name: String,
}

// --- the tools ----------------------------------------------------------

#[tool_router(router = tool_router)]
impl Server {
    #[must_use]
    pub fn new(desk: Arc<dyn Desk>) -> Self {
        Self {
            desk,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "list_documents",
        description = "Every markdown document the reader has open, with its path, whether the buffer is ahead of the file, and when the file was last written. Start here: every other tool takes one of these paths."
    )]
    async fn list_documents(&self) -> Result<Json<Documents>, ErrorData> {
        let documents = self.desk.documents().await.map_err(broken)?;
        Ok(Json(Documents { documents }))
    }

    #[tool(
        name = "read_document",
        description = "The current contents of an open document. This is the editor's buffer, so it can be ahead of what is on disk; `dirty` says when it is."
    )]
    async fn read_document(
        &self,
        Parameters(which): Parameters<Which>,
    ) -> Result<Result<Json<Text>, CallToolResult>, ErrorData> {
        let path = PathBuf::from(&which.path);
        let (content, dirty) = match text(self.desk.as_ref(), path.clone()).await {
            Ok(answer) => answer,
            Err(error) => return Ok(refuse(&error)),
        };
        let snapshot_id = self
            .desk
            .snapshots(&path)
            .ok()
            .and_then(|list| list.first().map(|info| info.id.clone()));
        Ok(Ok(Json(Text {
            path: which.path,
            content,
            dirty,
            snapshot_id,
        })))
    }

    #[tool(
        name = "list_annotations",
        description = "What the reader marked in an open document: highlights, coloured spans, strikethroughs, and the `<!-- kind: text -->` comments they wrote. The comment kinds are a closed set — note, attention, question, remove, keep, rewrite — and are the reader talking to you in words."
    )]
    async fn list_annotations(
        &self,
        Parameters(which): Parameters<Which>,
    ) -> Result<Result<Json<Annotations>, CallToolResult>, ErrorData> {
        let path = PathBuf::from(&which.path);
        match annotations(self.desk.as_ref(), path).await {
            Ok(annotations) => Ok(Ok(Json(Annotations {
                path: which.path,
                annotations,
            }))),
            Err(error) => Ok(refuse(&error)),
        }
    }

    #[tool(
        name = "changes_since",
        description = "What changed in an open document since a version you read earlier, block by block rather than line by line: a rewrapped paragraph that says the same thing is not a change, and a paragraph that was edited is one change and not five. Pass the `snapshot_id` a previous `read_document` gave you."
    )]
    async fn changes_since(
        &self,
        Parameters(since): Parameters<Since>,
    ) -> Result<Result<Json<Diff>, CallToolResult>, ErrorData> {
        let path = PathBuf::from(&since.path);
        let against = match self.desk.snapshot_text(&path, &since.snapshot_id) {
            Ok(text) => text,
            Err(Error::Unavailable { message, .. }) => {
                return Ok(Err(tool_error(&format!(
                    "{message}. Read the document again to get a version id you can measure from."
                ))));
            }
            Err(error) => return Err(broken(error)),
        };
        match changes(self.desk.as_ref(), path, against).await {
            Ok(changes) => Ok(Ok(Json(Diff {
                path: since.path,
                snapshot_id: since.snapshot_id,
                changes,
            }))),
            Err(error) => Ok(refuse(&error)),
        }
    }

    #[tool(
        name = "write_document",
        description = "Replace a document with a new version, under your name. The reader sees it arrive the way they see any other program write the file: markers in the margin of every block that moved, a version in their history attributed to you, and their own unsaved edits merged rather than lost. Send the whole document, not a patch."
    )]
    async fn write_document(
        &self,
        Parameters(write): Parameters<Write>,
    ) -> Result<Result<Json<Written>, CallToolResult>, ErrorData> {
        let name = write.agent_name.trim();
        if name.is_empty() {
            return Ok(Err(tool_error(
                "agent_name is what the reader will see beside this version; it cannot be empty.",
            )));
        }
        let path = PathBuf::from(&write.path);
        match self.desk.write(path, write.content, name.to_owned()).await {
            Ok(info) => Ok(Ok(Json(Written {
                path: write.path,
                snapshot_id: info.id,
                byte_len: info.byte_len,
            }))),
            Err(error) => Ok(refuse(&error)),
        }
    }

    #[tool(
        name = "open_document",
        description = "Open a file in front of the reader: a tab on it, in a window that comes forward. Returns once the tab is there, so `read_document` and the rest reach it from then on. The path must be absolute and the file must exist; write it first if it does not. This is the one tool that is not limited to what is already open."
    )]
    async fn open_document(
        &self,
        Parameters(open): Parameters<OpenWhere>,
    ) -> Result<Result<Json<Opened>, CallToolResult>, ErrorData> {
        let path = PathBuf::from(&open.path);
        if !path.is_absolute() {
            return Ok(Err(tool_error(&format!(
                "{} is not an absolute path; there is no directory to take it from",
                open.path
            ))));
        }
        let window = open.window.map(|label| label.trim().to_owned());
        match self
            .desk
            .open(path, window.filter(|label| !label.is_empty()))
            .await
        {
            Ok(opened) => Ok(Ok(Json(Opened {
                path: open.path,
                window: opened.window,
                name: opened.name,
            }))),
            Err(error) => Ok(refuse(&error)),
        }
    }
}

// --- the resources ------------------------------------------------------

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Server {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        );
        info.server_info =
            Implementation::new("markdown-app", env!("CARGO_PKG_VERSION")).with_title("Markdown");
        info.with_instructions(
            "The markdown documents a person has open in front of them, and a way to write to \
             one. `list_documents` first. The reader marks up what they are reading — \
             highlights, colours, and short comments in a closed vocabulary — and \
             `list_annotations` is those marks as records rather than as syntax; a comment is \
             the reader speaking to you. `write_document` puts a version in their history under \
             your name and shows them what moved. `open_document` puts a file in front of them \
             that was not open before.",
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let documents = self.desk.documents().await.map_err(broken)?;
        let resources = documents
            .into_iter()
            .filter_map(|document| {
                let path = document.path?;
                Some(
                    Resource::new(format!("{SCHEME}{}", path.to_string_lossy()), document.name)
                        .with_description(if document.dirty {
                            "Open, with edits the file does not have yet"
                        } else {
                            "Open"
                        })
                        .with_mime_type("text/markdown")
                        .with_size(document.byte_len),
                )
            })
            .collect();
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let Some(path) = request.uri.strip_prefix(SCHEME) else {
            return Err(ErrorData::invalid_params(
                format!("{} is not a doc:// URI", request.uri),
                None,
            ));
        };
        let (content, _dirty) = text(self.desk.as_ref(), PathBuf::from(path))
            .await
            .map_err(|error| ErrorData::resource_not_found(error.to_string(), None))?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(content, request.uri)]).into())
    }
}

/// A tool that ran and could not do the thing. The message reaches the
/// model, which is the point: an agent that named a document nobody has
/// open should be told that, not handed an opaque failure.
fn tool_error(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.to_owned())])
}

fn refuse<T>(error: &Error) -> Result<T, CallToolResult> {
    Err(tool_error(&error.to_string()))
}

/// A tool that could not run: no history on this machine, a window that
/// stopped answering. Not the agent's doing and not its to recover from.
fn broken(error: Error) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}
