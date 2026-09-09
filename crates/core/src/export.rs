//! A rendered document written out as a page of its own (plan WP 3.2).
//!
//! The page arrives already rendered: the markdown renderer is the
//! frontend's, and what it produces is what Read mode shows. What is
//! left is the images, and they are here rather than there because the
//! bytes are here. A page with a few of them carries them inside it, as
//! `data:` URLs, because a file somebody can send is the point of an
//! export; a page with more than a few gets a folder beside it instead,
//! because a photo album does not belong inside an HTML file.
//!
//! The frontend leaves a numbered sentinel in every `src` it could not
//! answer for, and this is what answers: it never parses the page, only
//! replaces those.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::atomic;
use crate::document::Error;

/// What stands in for a local image in the page as it arrives. The other
/// half of this literal is `SENTINEL` in `apps/desktop/src/lib/export.ts`.
const SENTINEL: &str = "mdr-export-image-";

/// How many bytes of images a page may carry before they are worth a
/// folder of their own.
///
/// Base64 is a third bigger again, so this is a page of about five and a
/// half megabytes -- large for something to mail, small for something to
/// open. Past it the images are still all there, just beside the file
/// rather than inside it.
const EMBED_LIMIT: u64 = 4 * 1024 * 1024;

/// What a folder of copied images is called, after the page it belongs to.
const SUFFIX: &str = "-images";

/// How many names to try before giving up on a collision.
const MAX_TRIES: u32 = 999;

/// The characters a relative URL may carry as themselves. Everything else
/// is percent-encoded, which is what makes a file called `my notes.png`
/// reachable from an `src`.
fn unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// What an export did, for the line the status bar shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ExportWrite {
    pub path: PathBuf,
    /// True when the images travel inside the page.
    pub embedded: bool,
    /// How many images the page carries or names.
    pub images: u32,
    /// How many of them are named but not there: unreadable, or bytes
    /// that are not an image this app recognises.
    pub missing: u32,
    /// Where the copies went, when they were copied.
    pub folder: Option<PathBuf>,
}

fn write_error(path: &Path, message: &str) -> Error {
    Error::Write {
        path: path.to_path_buf(),
        message: message.to_owned(),
    }
}

/// The media type for the bytes of an image, by what the bytes say they
/// are rather than by what the file is called (design 8, `assets.rs`).
fn media_type(bytes: &[u8]) -> Option<&'static str> {
    Some(match crate::assets::image_type(bytes)? {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// One image, inside the page.
fn embed(source: &Path) -> Option<String> {
    let bytes = std::fs::read(source).ok()?;
    let mime = media_type(&bytes)?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{data}"))
}

/// A path with everything a URL objects to percent-encoded, and the
/// separators left alone.
fn encode_url(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if unreserved(byte) || byte == b'/' {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    out
}

/// What to call a copy of `source` in a folder that already holds `taken`.
fn free_name(source: &Path, taken: &mut HashSet<String>) -> String {
    let name = source
        .file_name()
        .map_or_else(|| "image".to_owned(), |n| n.to_string_lossy().into_owned());
    if taken.insert(name.clone()) {
        return name;
    }
    let stem = Path::new(&name)
        .file_stem()
        .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
    let ext = Path::new(&name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()));
    for n in 1..MAX_TRIES {
        let candidate = format!("{stem}-{n}{}", ext.as_deref().unwrap_or(""));
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name
}

/// Where a page's images go when they do not go inside it.
fn folder_for(target: &Path) -> PathBuf {
    let stem = target
        .file_stem()
        .map_or_else(|| "page".to_owned(), |s| s.to_string_lossy().into_owned());
    let dir = target.parent().unwrap_or(Path::new("."));
    dir.join(format!("{stem}{SUFFIX}"))
}

/// An attribute value, escaped. The sentinel is only ever the whole of an
/// `src`, so this is the only place a substituted URL can land.
fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Put the answers into the page.
///
/// A sentinel with no answer is left standing rather than blanked: it
/// means the two sides disagree about how many images there are, and a
/// page that says so is easier to explain than one with an empty `src`.
fn substitute(html: &str, urls: &[String]) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find(SENTINEL) {
        out.push_str(&rest[..at]);
        let after = &rest[at + SENTINEL.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        match digits.parse::<usize>().ok().and_then(|n| urls.get(n)) {
            Some(url) => out.push_str(&escape_attr(url)),
            None => out.push_str(&rest[at..at + SENTINEL.len() + digits.len()]),
        }
        rest = &after[digits.len()..];
    }
    out.push_str(rest);
    out
}

/// Write `html` to `target`, with the images it names either inside it or
/// in a folder beside it.
///
/// The page is written before a single image is copied. A failure then
/// leaves a page whose images are missing, which is a thing the reader
/// can see and fix; the other order leaves a folder of images beside a
/// file that was never written, which is litter.
///
/// # Errors
/// Fails when the page itself cannot be written, or when the folder its
/// images need cannot be made. A single image that cannot be read or
/// copied is counted, not raised: one bad file does not cost the export.
pub fn write_export(target: &Path, html: &str, images: &[PathBuf]) -> Result<ExportWrite, Error> {
    let total: u64 = images
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum();
    let embedded = total <= EMBED_LIMIT;
    let mut missing = 0;
    let mut urls: Vec<String> = Vec::with_capacity(images.len());
    // A page that names the same image twice carries it once.
    let mut seen: HashMap<&Path, String> = HashMap::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut copies: Vec<(&Path, PathBuf)> = Vec::new();
    let folder = if embedded {
        None
    } else {
        Some(folder_for(target))
    };

    for source in images {
        if let Some(url) = seen.get(source.as_path()) {
            urls.push(url.clone());
            continue;
        }
        // Every image an export is asked for is an absolute path: the
        // frontend resolves each one against the document's own folder
        // before naming it. Anything else is a name and not a file --
        // what the app hands over in place of an image outside the
        // folders design 8 lets it reach -- and the page names it
        // without carrying it.
        if !source.is_absolute() {
            missing += 1;
            let url = relative_name(source);
            seen.insert(source.as_path(), url.clone());
            urls.push(url);
            continue;
        }
        let url = match &folder {
            // Inside the page: the bytes have to be read and named now,
            // and bytes that are not an image cannot be given a media
            // type, so they are not carried at all.
            None => embed(source).unwrap_or_else(|| {
                missing += 1;
                relative_name(source)
            }),
            // Beside it: the file is copied as it is, under the name it
            // already has. Nothing sniffs it, because nothing has to --
            // this is a copy of a file the document already points at,
            // and the browser will make of it what it makes of it.
            Some(dir) => {
                let name = free_name(source, &mut taken);
                copies.push((source, dir.join(&name)));
                encode_url(&format!(
                    "{}/{name}",
                    dir.file_name()
                        .map_or(String::new(), |n| n.to_string_lossy().into_owned())
                ))
            }
        };
        seen.insert(source.as_path(), url.clone());
        urls.push(url);
    }

    if let Some(dir) = &folder {
        std::fs::create_dir_all(dir).map_err(|error| write_error(dir, &error.to_string()))?;
    }
    let page = substitute(html, &urls);
    atomic::replace(target, page.as_bytes(), atomic::Create::AsUser)
        .map_err(|error| write_error(target, &error.to_string()))?;
    for (source, destination) in copies {
        if std::fs::copy(source, &destination).is_err() {
            missing += 1;
        }
    }

    Ok(ExportWrite {
        path: target.to_path_buf(),
        embedded,
        images: u32::try_from(seen.len()).unwrap_or(u32::MAX),
        missing,
        folder,
    })
}

/// What an image that could not be carried is left pointing at: its own
/// name, which is what a missing image looks like everywhere else.
fn relative_name(source: &Path) -> String {
    encode_url(
        &source
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
    )
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
    const GIF: &[u8] = b"GIF89a\x00\x00\x00\x00";

    /// A page the way the frontend hands one over: sentinels in the `src`
    /// attributes and nothing else for this side to know about.
    fn page_with(count: usize) -> String {
        let mut images = String::new();
        for n in 0..count {
            // Infallible: the target is a `String`.
            let _unused = write!(images, "<img src=\"{SENTINEL}{n}\" alt=\"one\">");
        }
        format!("<!doctype html>\n<body><article>{images}</article></body>\n")
    }

    fn image(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_page_with_a_few_images_carries_them_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[image(dir.path(), "shot.png", PNG)],
        )
        .unwrap();

        assert!(write.embedded);
        assert_eq!(write.images, 1);
        assert_eq!(write.missing, 0);
        assert_eq!(write.folder, None);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("data:image/png;base64,"), "{html}");
        assert!(!html.contains(SENTINEL), "no sentinel is left: {html}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    /// The media type is the bytes', not the name's -- the same rule the
    /// assets folder is kept honest by.
    #[test]
    fn what_an_image_is_comes_from_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[image(dir.path(), "shot.png", GIF)],
        )
        .unwrap();
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("data:image/gif;base64,"), "{html}");
    }

    #[test]
    fn more_images_than_a_page_can_carry_go_in_a_folder_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut big = PNG.to_vec();
        big.resize(usize::try_from(EMBED_LIMIT).unwrap() + 1, 0);
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[image(dir.path(), "shot.png", &big)],
        )
        .unwrap();

        assert!(!write.embedded);
        assert_eq!(write.folder, Some(dir.path().join("brief-images")));
        assert_eq!(write.missing, 0);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("src=\"brief-images/shot.png\""), "{html}");
        assert_eq!(
            std::fs::read(dir.path().join("brief-images/shot.png")).unwrap(),
            big
        );
    }

    #[test]
    fn a_name_a_url_cannot_hold_is_encoded_for_the_page_and_kept_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut big = PNG.to_vec();
        big.resize(usize::try_from(EMBED_LIMIT).unwrap() + 1, 0);
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[image(dir.path(), "my notes.png", &big)],
        )
        .unwrap();

        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(
            html.contains("src=\"brief-images/my%20notes.png\""),
            "{html}"
        );
        assert!(dir.path().join("brief-images/my notes.png").exists());
    }

    #[test]
    fn two_images_with_one_name_are_two_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut big = PNG.to_vec();
        big.resize(usize::try_from(EMBED_LIMIT).unwrap() + 1, 0);
        let one = image(dir.path(), "shot.png", &big);
        std::fs::create_dir(dir.path().join("deeper")).unwrap();
        let two = image(&dir.path().join("deeper"), "shot.png", PNG);
        let write =
            write_export(&dir.path().join("brief.html"), &page_with(2), &[one, two]).unwrap();

        assert_eq!(write.images, 2);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("src=\"brief-images/shot.png\""), "{html}");
        assert!(html.contains("src=\"brief-images/shot-1.png\""), "{html}");
    }

    #[test]
    fn a_page_that_names_one_image_twice_carries_it_once() {
        let dir = tempfile::tempdir().unwrap();
        let shot = image(dir.path(), "shot.png", PNG);
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(2),
            &[shot.clone(), shot],
        )
        .unwrap();

        assert_eq!(write.images, 1);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert_eq!(html.matches("data:image/png;base64,").count(), 2);
    }

    /// One unreadable file is a line in the status bar, not a failed export.
    #[test]
    fn an_image_that_is_not_there_is_counted_and_the_page_is_still_written() {
        let dir = tempfile::tempdir().unwrap();
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(2),
            &[
                image(dir.path(), "shot.png", PNG),
                dir.path().join("gone.png"),
            ],
        )
        .unwrap();

        assert_eq!(write.missing, 1);
        assert_eq!(write.images, 2);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("data:image/png;base64,"), "{html}");
        assert!(html.contains("src=\"gone.png\""), "{html}");
    }

    /// Bytes that are not an image cannot be given a media type, so they
    /// are not carried -- the same refusal `store_asset` makes.
    #[test]
    fn bytes_that_are_not_an_image_are_not_carried() {
        let dir = tempfile::tempdir().unwrap();
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[image(dir.path(), "shot.png", b"this is not a picture")],
        )
        .unwrap();
        assert_eq!(write.missing, 1);
        assert!(
            !std::fs::read_to_string(&write.path)
                .unwrap()
                .contains("base64")
        );
    }

    /// What the app hands over in place of an image outside the folders
    /// design 8 lets it reach: a name, which the page names and does not
    /// carry. Nothing on disk is read to find that out.
    #[test]
    fn an_image_that_is_only_a_name_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        image(dir.path(), "secret.png", PNG);
        let write = write_export(
            &dir.path().join("brief.html"),
            &page_with(1),
            &[PathBuf::from("secret.png")],
        )
        .unwrap();

        assert_eq!(write.missing, 1);
        let html = std::fs::read_to_string(&write.path).unwrap();
        assert!(html.contains("src=\"secret.png\""), "{html}");
        assert!(!html.contains("base64"), "{html}");
    }

    #[test]
    fn nothing_but_a_sentinel_is_touched() {
        let html = "<p>mdr-export-image is a word here</p><img src=\"mdr-export-image-0\">";
        assert_eq!(
            substitute(html, &["shot.png".to_owned()]),
            "<p>mdr-export-image is a word here</p><img src=\"shot.png\">"
        );
    }

    /// Ten is not one with a nought after it: the number is read, not
    /// matched a prefix at a time.
    #[test]
    fn a_number_with_two_digits_is_one_number() {
        let urls: Vec<String> = (0..=10).map(|n| format!("{n}.png")).collect();
        let html = format!("<img src=\"{SENTINEL}10\"><img src=\"{SENTINEL}1\">");
        assert_eq!(
            substitute(&html, &urls),
            "<img src=\"10.png\"><img src=\"1.png\">"
        );
    }

    #[test]
    fn a_url_goes_into_the_page_as_an_attribute_value() {
        let urls = vec!["brief-images/a&b.png".to_owned()];
        let html = format!("<img src=\"{SENTINEL}0\">");
        assert_eq!(
            substitute(&html, &urls),
            "<img src=\"brief-images/a&amp;b.png\">"
        );
    }

    /// A sentinel nobody answered for stays a sentinel: the two sides
    /// disagree about how many images there are, and a page that says so
    /// is easier to explain than one with an empty `src`.
    #[test]
    fn a_sentinel_with_no_answer_is_left_standing() {
        let html = format!("<img src=\"{SENTINEL}7\">");
        assert_eq!(substitute(&html, &[]), html);
    }
}
