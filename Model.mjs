// omajop — pure model helpers shared by the QML widget and the Node test suite.
//
// Everything that builds SQL, parses sqlite3 output, or formats a value for
// display lives here, so the QML files stay presentational and the logic stays
// testable without a compositor. No QML imports in this file.

export const DEFAULT_PROFILE_DIR = ".config/joplin-desktop"
export const DB_FILENAME = "database.sqlite"

// Joplin ids are 32 lowercase hex characters. Ids are validated against this
// before they are interpolated into SQL, so a row from the database can never
// carry a statement with it.
export const ID_RE = /^[0-9a-f]{32}$/

// The preview body is capped in SQL rather than by truncating stdout, so the
// JSON we hand to JSON.parse is always a complete document.
export const MAX_BODY_CHARS = 20000

// The ceiling on one query's response. This has to hold on the producing side
// to mean anything: parseRows can only refuse a response after StdioCollector
// has already buffered every byte of it, so a check there prevents the parse
// and not the memory. The row limits below are therefore derived from this
// budget rather than chosen next to it, and a query cannot emit more than it.
export const MAX_STDOUT_CHARS = 8 * 1024 * 1024

// JSON escaping can turn one character into six: a control character in a title
// is written as a six-character escape. A bound on characters selected is only
// a sixth of a bound on characters emitted.
const JSON_ESCAPE_FACTOR = 6

// Per row, for column names, punctuation, the fixed-width ids and the integer
// columns. Deliberately generous: an over-estimate here makes the budget
// conservative, which is the direction an unsafe bound should not err in.
const ROW_OVERHEAD_CHARS = 256

// A profile is local, which is not the same as small or well formed: it syncs
// from somewhere. Every text column a query selects is cut to one of these.
export const MAX_TITLE_CHARS = 200
export const MAX_MIME_CHARS = 128
export const MAX_EXTENSION_CHARS = 16

// The worst case a response can reach, for a row count and the number of
// characters of bounded text each row carries. Exported so a test can hold the
// limits and the ceiling to each other rather than restating the arithmetic.
export function worstCaseResponseChars(rows, textChars) {
  return rows * (ROW_OVERHEAD_CHARS + textChars * JSON_ESCAPE_FACTOR)
}

function rowLimitFor(textChars) {
  return Math.max(1, Math.floor(
    MAX_STDOUT_CHARS / (ROW_OVERHEAD_CHARS + textChars * JSON_ESCAPE_FACTOR)))
}

export const MAX_FOLDERS = rowLimitFor(MAX_TITLE_CHARS)
export const MAX_NOTES = rowLimitFor(MAX_TITLE_CHARS)
export const MAX_RESOURCES = rowLimitFor(
  MAX_TITLE_CHARS + MAX_MIME_CHARS + MAX_EXTENSION_CHARS)
export const MAX_TAG_ROWS = rowLimitFor(MAX_TITLE_CHARS)
export const MAX_SEARCH_RESULTS = rowLimitFor(0)

// An attachment's bytes go to Qt's image decoder, which allocates whatever the
// file's header asks it to. `size` is the byte length Joplin recorded, so it is
// the one bound available before the decoder is handed anything at all.
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

// A decode bound, in pixels per side. For a raster image Qt loads at no more
// than sourceSize and does not stretch a smaller one up to it, so this caps
// what a crafted header can ask for without changing how anything looks.
export const MAX_IMAGE_PIXELS_PER_SIDE = 4096

// No query against a local file should take this long. One that does is not
// going to finish usefully, so the process is killed rather than left holding
// a lock and a pipe for the rest of the session.
export const QUERY_TIMEOUT_MS = 15000

// The desktop app writes with a rollback journal, not WAL, so a reader can
// meet a write lock. Wait rather than fail.
export const BUSY_TIMEOUT_MS = 3000

// Schema this widget was written against. Joplin owns it and is free to change
// it; a mismatch is surfaced in the panel rather than treated as fatal, because
// the columns we read have been stable for a long time.
export const KNOWN_SCHEMA_VERSION = 53

export const SORT_UPDATED = "updated"
export const SORT_TITLE = "title"

export const MARKUP_MARKDOWN = 1
export const MARKUP_HTML = 2

// --- settings normalization -------------------------------------------------
// shell.json is hand-editable and the manifest schema is only a hint, so every
// setting is clamped here on the way in.

export function normalizeSortBy(value) {
  return String(value) === SORT_TITLE ? SORT_TITLE : SORT_UPDATED
}

export function normalizeRefreshSeconds(value) {
  // A missing setting means "use the default", which Number(null) === 0 would
  // otherwise turn into the minimum.
  if (value === undefined || value === null || value === "") return 60
  const seconds = Math.round(Number(value))
  if (!isFinite(seconds)) return 60
  return Math.min(3600, Math.max(5, seconds))
}

export function normalizeProfilePath(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

// --- paths ------------------------------------------------------------------

function expandHome(path, home) {
  const text = String(path || "")
  if (text === "~") return String(home || "")
  if (text.indexOf("~/") === 0) return String(home || "") + text.slice(1)
  return text
}

function stripTrailingSlash(path) {
  let text = String(path || "")
  while (text.length > 1 && text.charAt(text.length - 1) === "/") text = text.slice(0, -1)
  return text
}

// A configured profilePath points at the profile directory, not the file.
export function profileDirectory(home, profilePath) {
  const configured = normalizeProfilePath(profilePath)
  const dir = configured !== ""
    ? expandHome(configured, home)
    : String(home || "") + "/" + DEFAULT_PROFILE_DIR
  return stripTrailingSlash(dir)
}

export function databasePath(home, profilePath) {
  return profileDirectory(home, profilePath) + "/" + DB_FILENAME
}

// --- sqlite3 invocation -----------------------------------------------------

// `.timeout` is used rather than `PRAGMA busy_timeout`, because the pragma
// prints its result and would corrupt the JSON on stdout.
export function sqliteArgv(dbPath, sql) {
  return [
    "sqlite3",
    "-readonly",
    "-cmd", ".timeout " + BUSY_TIMEOUT_MS,
    "-json",
    String(dbPath || ""),
    String(sql || "")
  ]
}

// sqlite3 -json prints nothing at all for an empty result set, so an empty
// string is a valid "no rows" answer rather than a parse failure.
export function parseRows(text) {
  const raw = String(text === undefined || text === null ? "" : text)
  // A backstop, not the bound: by the time this runs the collector has already
  // buffered the whole response, so what it protects is the parse and what
  // follows it. The producing side is bounded by the derived row limits, which
  // is what keeps a response from reaching this size in the first place.
  if (raw.length > MAX_STDOUT_CHARS) {
    throw new Error("refusing to parse an oversized sqlite3 response")
  }
  const trimmed = raw.trim()
  if (trimmed === "") return []
  const rows = JSON.parse(trimmed)
  return Array.isArray(rows) ? rows : []
}

// --- queries ----------------------------------------------------------------

export function schemaSql() {
  return "SELECT version FROM version LIMIT 1;"
}

export function foldersSql() {
  return "SELECT id,"
    + " substr(title, 1, " + MAX_TITLE_CHARS + ") AS title,"
    + " parent_id FROM folders"
    + " WHERE deleted_time = 0"
    + " ORDER BY title COLLATE NOCASE ASC"
    + " LIMIT " + MAX_FOLDERS + ";"
}

// `deleted_time = 0` excludes the trash and `is_conflict = 0` the conflict
// copies; both live in the same table as ordinary notes.
export function notesSql(sortBy) {
  const order = normalizeSortBy(sortBy) === SORT_TITLE
    ? "title COLLATE NOCASE ASC"
    : "updated_time DESC"
  return "SELECT id, parent_id,"
    + " substr(title, 1, " + MAX_TITLE_CHARS + ") AS title,"
    + " is_todo, todo_completed, updated_time,"
    + " encryption_applied"
    + " FROM notes"
    + " WHERE deleted_time = 0 AND is_conflict = 0"
    + " ORDER BY " + order
    + " LIMIT " + MAX_NOTES + ";"
}

export function noteBodySql(id) {
  const noteId = String(id || "")
  if (!ID_RE.test(noteId)) throw new Error("refusing to query a malformed note id")
  return "SELECT substr(body, 1, " + MAX_BODY_CHARS + ") AS body,"
    + " length(body) AS body_length,"
    + " markup_language, encryption_applied"
    + " FROM notes WHERE id = '" + noteId + "';"
}

export function schemaWarning(version) {
  const found = Math.round(Number(version))
  if (!isFinite(found) || found <= 0) return ""
  if (found === KNOWN_SCHEMA_VERSION) return ""
  if (found < KNOWN_SCHEMA_VERSION) {
    return "Joplin database schema " + found + " is older than expected ("
      + KNOWN_SCHEMA_VERSION + ")."
  }
  return "Joplin database schema " + found + " is newer than expected ("
    + KNOWN_SCHEMA_VERSION + "); some fields may have moved."
}

// --- folder tree ------------------------------------------------------------

export const ALL_NOTES_ID = ""

function countNotesByFolder(notes) {
  const counts = {}
  const rows = Array.isArray(notes) ? notes : []
  for (let i = 0; i < rows.length; i++) {
    const parent = String(rows[i] && rows[i].parent_id || "")
    counts[parent] = (counts[parent] || 0) + 1
  }
  return counts
}

// Flattened, depth-annotated folder list. A ListView wants a flat model, and an
// indent reads the hierarchy just as well as a real tree in a panel this size.
//
// `noteCount` is notes directly in the folder; `totalCount` includes its
// descendants. A folder whose parent has been deleted still appears, at the
// root, rather than dropping out of the list with its notes.
export function buildFolderTree(folders, notes) {
  const rows = Array.isArray(folders) ? folders : []
  const direct = countNotesByFolder(notes)

  const byParent = {}
  for (let i = 0; i < rows.length; i++) {
    const parent = String(rows[i] && rows[i].parent_id || "")
    if (!byParent[parent]) byParent[parent] = []
    byParent[parent].push(rows[i])
  }

  const out = []
  const seen = {}

  function walk(parentId, depth) {
    const children = byParent[parentId] || []
    for (let i = 0; i < children.length; i++) {
      const id = String(children[i] && children[i].id || "")
      // A missing id is unusable, and `seen` also breaks a parent_id cycle.
      if (id === "" || seen[id]) continue
      seen[id] = true

      const entry = {
        id: id,
        title: String(children[i].title || "").trim() || "Untitled",
        depth: depth,
        noteCount: direct[id] || 0,
        totalCount: 0
      }
      out.push(entry)

      // walk() only ever appends this folder's own subtree, so everything
      // added after this point belongs to it.
      const subtreeStart = out.length
      walk(id, depth + 1)
      let total = entry.noteCount
      for (let j = subtreeStart; j < out.length; j++) total += out[j].noteCount
      entry.totalCount = total
    }
  }

  walk("", 0)

  // Anything not reachable from the root is an orphan; surface it at depth 0.
  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i] && rows[i].id || "")
    if (id === "" || seen[id]) continue
    seen[id] = true
    const entry = {
      id: id,
      title: String(rows[i].title || "").trim() || "Untitled",
      depth: 0,
      noteCount: direct[id] || 0,
      totalCount: 0
    }
    out.push(entry)
    const subtreeStart = out.length
    walk(id, 1)
    let total = entry.noteCount
    for (let j = subtreeStart; j < out.length; j++) total += out[j].noteCount
    entry.totalCount = total
  }

  return out
}

// --- note selection ---------------------------------------------------------

export function notesForFolder(notes, folderId) {
  const rows = Array.isArray(notes) ? notes : []
  const wanted = String(folderId || "")
  if (wanted === ALL_NOTES_ID) return rows.slice()
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i] && rows[i].parent_id || "") === wanted) out.push(rows[i])
  }
  return out
}

// Title matching is instant and local. `matchedIds`, when supplied, carries the
// ids that Joplin's full-text index matched on the body, and widens the result.
export function filterNotes(notes, query, matchedIds) {
  const rows = Array.isArray(notes) ? notes : []
  const needle = String(query || "").trim().toLowerCase()
  if (needle === "") return rows.slice()
  const matched = matchedIds || {}
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const title = String(rows[i] && rows[i].title || "").toLowerCase()
    if (title.indexOf(needle) !== -1 || matched[String(rows[i] && rows[i].id || "")]) {
      out.push(rows[i])
    }
  }
  return out
}

export function idSet(rows) {
  const set = {}
  const list = Array.isArray(rows) ? rows : []
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] && list[i].id || "")
    if (ID_RE.test(id)) set[id] = true
  }
  return set
}

export function findNote(notes, id) {
  const rows = Array.isArray(notes) ? notes : []
  const wanted = String(id || "")
  if (wanted === "") return null
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i] && rows[i].id || "") === wanted) return rows[i]
  }
  return null
}

export function todoState(note) {
  if (!note || !Number(note.is_todo)) return "none"
  return Number(note.todo_completed) ? "done" : "open"
}

// A note that arrived from sync before its master key was available carries
// no usable title: Joplin serialises the whole item into encryption_cipher_text
// and leaves the columns at their defaults. Without this it renders as a blank
// row labelled "Untitled", which reads as a bug rather than a pending decrypt.
export function isEncryptedNote(note) {
  return !!(note && Number(note.encryption_applied))
}

export function noteTitle(note) {
  if (!note) return ""
  if (isEncryptedNote(note)) return "Encrypted note"
  return String(note.title || "").trim() || "Untitled"
}

export function countEncrypted(notes) {
  const rows = Array.isArray(notes) ? notes : []
  let total = 0
  for (let i = 0; i < rows.length; i++) {
    if (isEncryptedNote(rows[i])) total++
  }
  return total
}

// --- formatting -------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function toMillis(value) {
  if (value instanceof Date) return value.getTime()
  const n = Number(value)
  return isFinite(n) ? n : Date.now()
}

function formatAbsolute(ms, nowMs) {
  const date = new Date(ms)
  const stamp = date.getDate() + " " + MONTHS[date.getMonth()]
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
  return sameYear ? stamp : stamp + " " + date.getFullYear()
}

// Joplin stores updated_time as epoch milliseconds.
export function formatUpdated(ms, now) {
  const stamp = Number(ms)
  if (!isFinite(stamp) || stamp <= 0) return ""
  const nowMs = toMillis(now)
  const diff = nowMs - stamp
  if (diff < 0) return formatAbsolute(stamp, nowMs)

  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return minutes + "m ago"
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h ago"
  const days = Math.floor(hours / 24)
  if (days < 7) return days + "d ago"
  return formatAbsolute(stamp, nowMs)
}

// Collapse to a single line; tooltips and the bar label must not carry newlines.
export function plainLine(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .trim()
}

export function truncate(text, limit) {
  const value = String(text === undefined || text === null ? "" : text)
  const max = Math.max(1, Math.round(Number(limit) || 1))
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}

// The body is capped in SQL, so tell the reader when they are seeing a prefix.
export function bodyTruncated(row) {
  if (!row) return false
  const total = Number(row.body_length)
  return isFinite(total) && total > MAX_BODY_CHARS
}

export function isEncrypted(row) {
  return !!(row && Number(row.encryption_applied))
}

export function markupOf(row) {
  return Number(row && row.markup_language) === MARKUP_HTML ? MARKUP_HTML : MARKUP_MARKDOWN
}

// Joplin registers x-scheme-handler/joplin, so this both focuses a running
// desktop app and starts one that is not running.
export function noteUrl(id) {
  const noteId = String(id || "")
  if (!ID_RE.test(noteId)) return ""
  return "joplin://x-callback-url/openNote?id=" + noteId
}

// --- resources --------------------------------------------------------------
//
// Joplin keeps attachments in the `resources` table and the bytes on disk at
// <profile>/resources/<id>.<file_extension>. A note body refers to one as
// `![alt](:/<id>)` for an image, or `[label](:/<id>)` for any other file.
//
// Qt's Markdown renderer does not paint file:// images — it reserves the space
// and draws nothing — so image references are lifted out of the Markdown here
// and handed to the panel as separate segments it can render with real Image
// elements. That also lets the panel bound them to the pane width.

export const RESOURCE_DIR = "resources"

// The Markdown image/link forms and the HTML <img> form, in one pass, so the
// segments come out in document order. An HTML note (markup_language 2) embeds
// an attachment as <img src=":/<id>">, which Qt would not paint either.
const RESOURCE_REF_RE = new RegExp(
  "(!?)\\[([^\\]]*)\\]\\(:\\/([0-9a-f]{32})\\)"
  + "|<img\\b[^>]*?\\bsrc\\s*=\\s*[\"']:\\/([0-9a-f]{32})[\"'][^>]*>",
  "gi")

const ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i

export function resourcesSql() {
  return "SELECT id,"
    + " substr(mime, 1, " + MAX_MIME_CHARS + ") AS mime,"
    + " substr(file_extension, 1, " + MAX_EXTENSION_CHARS + ") AS file_extension,"
    + " substr(title, 1, " + MAX_TITLE_CHARS + ") AS title,"
    + " size, encryption_applied"
    + " FROM resources"
    + " LIMIT " + MAX_RESOURCES + ";"
}

export function buildResourceMap(rows) {
  const map = {}
  const list = Array.isArray(rows) ? rows : []
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] && list[i].id || "")
    if (!ID_RE.test(id)) continue
    map[id] = {
      id: id,
      mime: String(list[i].mime || ""),
      extension: String(list[i].file_extension || ""),
      title: String(list[i].title || ""),
      // Joplin's schema defaults this to -1, meaning it was never recorded.
      size: Number(list[i].size),
      encrypted: !!Number(list[i].encryption_applied)
    }
  }
  return map
}

export function isImageResource(resource) {
  return !!resource && resource.mime.indexOf("image/") === 0
}

// Whether an image may be handed to the decoder at all. This fails closed on a
// size Joplin never recorded: an unmeasured resource is not a small one, it is
// one nothing is known about, and the byte cap is the only bound that applies
// before the file is opened.
export function isRenderableImage(resource) {
  if (!isImageResource(resource)) return false
  const size = Number(resource.size)
  if (!isFinite(size) || size < 0) return false
  return size <= MAX_IMAGE_BYTES
}

// An extension comes out of the database and is appended to a path, so it is
// bounded to a short plain token. A separator, a traversal, a control character
// or anything else yields no extension rather than a rewritten path.
const SAFE_EXTENSION_RE = new RegExp("^[A-Za-z0-9]{1," + MAX_EXTENSION_CHARS + "}$")

export function sanitizeExtension(value) {
  const ext = String(value === undefined || value === null ? "" : value)
    .replace(/^\.+/, "")
  return SAFE_EXTENSION_RE.test(ext) ? ext : ""
}

// Resolves `.` and `..` textually, so containment can be decided without
// touching the filesystem — the check has to hold for a path that does not
// exist yet, and must not follow a link to decide it.
export function normalizePath(path) {
  const raw = String(path === undefined || path === null ? "" : path)
  const absolute = raw.charAt(0) === "/"
  const parts = raw.split("/")
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(part)
  }
  return (absolute ? "/" : "") + out.join("/")
}

// True only for a path strictly below `directory`. The directory itself is not
// inside itself, and a sibling whose name merely starts the same way — a
// `resources.evil` beside `resources` — is not either.
export function isInsideDirectory(directory, path) {
  const dir = normalizePath(directory)
  const target = normalizePath(path)
  if (dir === "" || dir === "/" || target === "") return false
  return target.length > dir.length + 1
    && target.slice(0, dir.length + 1) === dir + "/"
}

export function resourcesDirectory(profileDir) {
  return stripTrailingSlash(profileDir) + "/" + RESOURCE_DIR
}

// Returns "" rather than a path whenever the result cannot be proven to sit
// inside the profile's resources directory. Both the id and the extension are
// database values, and what comes back is handed to an image decoder or to a
// desktop opener, so neither is trusted to be shaped the way Joplin writes it.
export function resourcePath(profileDir, id, extension) {
  const resourceId = String(id === undefined || id === null ? "" : id)
  if (!ID_RE.test(resourceId)) return ""
  const directory = resourcesDirectory(profileDir)
  const raw = String(extension === undefined || extension === null ? "" : extension)
    .replace(/^\.+/, "")
  const ext = sanitizeExtension(raw)
  // No extension at all is ordinary. One that is present but does not survive
  // validation means the row cannot be trusted to describe a file on disk, so
  // it gets no path rather than a path with the offending part quietly removed.
  if (raw !== "" && ext === "") return ""
  const path = directory + "/" + resourceId + (ext !== "" ? "." + ext : "")
  return isInsideDirectory(directory, path) ? path : ""
}

// A path can contain characters that are not legal in a URL (a profile under a
// directory with spaces, say), so the path component is encoded. An empty path
// yields an empty URL: "file://" on its own would resolve to the root.
export function fileUrl(path) {
  const value = String(path === undefined || path === null ? "" : path)
  if (value === "") return ""
  return "file://" + encodeURI(value)
}

// --- links out of a note ----------------------------------------------------
//
// A link in a rendered note is note-controlled: the body is data that arrived
// over sync, and activating one hands a string to xdg-open, which will dispatch
// on whatever scheme it names. So only schemes that mean something for a note
// are opened, and only after the URL survives inspection.

export const SAFE_LINK_SCHEMES = ["http", "https"]

// A control character can truncate or split what a handler sees, so a URL
// carrying one is not opened at all.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/

// Returns the URL to open, or "" to refuse. `profileDir` bounds file:// links
// to attachments in this profile; without it, no file:// link is opened.
export function externalLinkUrl(link, profileDir) {
  const url = String(link === undefined || link === null ? "" : link).trim()
  if (url === "" || CONTROL_CHAR_RE.test(url) || /\s/.test(url)) return ""

  const schemeMatch = SCHEME_RE.exec(url)
  // A relative or scheme-less link has no meaning outside the note it came
  // from, and guessing one for it is how a surprising handler gets invoked.
  if (!schemeMatch) return ""
  const scheme = schemeMatch[1].toLowerCase()

  if (scheme === "file") {
    if (url.slice(0, 7) !== "file://") return ""
    const rest = url.slice(7)
    // A query or fragment on a file URL is not part of the path, and would let
    // the containment check pass on a path the opener never sees.
    if (rest.indexOf("?") !== -1 || rest.indexOf("#") !== -1) return ""
    let path
    try {
      path = decodeURI(rest)
    } catch (error) {
      return ""
    }
    if (CONTROL_CHAR_RE.test(path)) return ""
    return isInsideDirectory(resourcesDirectory(profileDir), path) ? url : ""
  }

  if (SAFE_LINK_SCHEMES.indexOf(scheme) === -1) return ""
  if (url.slice(scheme.length, scheme.length + 3) !== "://") return ""

  // https://real.example@evil.example/ opens evil.example while reading as
  // real.example, so a URL carrying credentials is refused rather than opened.
  const authority = url.slice(scheme.length + 3).split(/[/?#]/)[0]
  if (authority === "" || authority.indexOf("@") !== -1) return ""

  return url
}

// Splits a note body into an ordered list of segments:
//   { kind: "text",  text }                  Markdown, rendered by a Text
//   { kind: "image", url, title, missing }   rendered by an Image
//
// Links to non-image resources stay inline in the Markdown, rewritten to a
// file:// URL so the panel's link handler can open them.
export function splitBody(body, resources, profileDir) {
  const source = String(body === undefined || body === null ? "" : body)
  const map = resources || {}
  const segments = []
  let buffer = ""

  function flush() {
    if (buffer.trim() !== "") segments.push({ kind: "text", text: buffer })
    buffer = ""
  }

  let lastIndex = 0
  RESOURCE_REF_RE.lastIndex = 0
  let match
  while ((match = RESOURCE_REF_RE.exec(source)) !== null) {
    const whole = match[0]
    buffer += source.slice(lastIndex, match.index)
    lastIndex = match.index + whole.length

    // Either the Markdown form (groups 1-3) or the HTML <img> form (group 4).
    const html = match[4] !== undefined && match[4] !== null
    const id = html ? match[4] : match[3]
    const altMatch = html ? ALT_RE.exec(whole) : null
    const label = html ? (altMatch ? altMatch[1] : "") : match[2]
    // An <img> is always an embed; the Markdown form needs its leading `!`.
    const wantsEmbed = html || match[1] === "!"

    const resource = map[id]

    if (!resource) {
      // The reference outlived its resource row; say so rather than leaving
      // a dangling `:/id` in the text.
      buffer += label !== "" ? label + " (missing attachment)" : "(missing attachment)"
      continue
    }

    // A rendered image and an opened attachment both need a path that is
    // provably inside the profile. Without one there is nothing safe to point
    // at, so the reference degrades to a label the same way a dangling one does.
    const path = resourcePath(profileDir, id, resource.extension)
    if (path === "") {
      buffer += label !== "" ? label + " (unavailable attachment)" : "(unavailable attachment)"
      continue
    }

    if (wantsEmbed && isImageResource(resource)) {
      if (!isRenderableImage(resource)) {
        // Past the byte cap, or a length that was never recorded. It is not
        // given to the decoder, but stays reachable as a link the reader can
        // open deliberately, in something that is not this process.
        const name = label !== ""
          ? label
          : (resource.title !== "" ? resource.title : "image")
        buffer += "[" + name + "](" + fileUrl(path) + ") (image not previewed)"
        continue
      }
      flush()
      segments.push({
        kind: "image",
        url: fileUrl(path),
        title: label !== "" ? label : resource.title,
        missing: false
      })
      continue
    }

    // A non-image attachment, or an image reference written as a plain link.
    const text = label !== "" ? label : (resource.title !== "" ? resource.title : "attachment")
    buffer += "[" + text + "](" + fileUrl(path) + ")"
  }

  buffer += source.slice(lastIndex)
  flush()

  return segments
}

// --- markdown styling -------------------------------------------------------
//
// Two things Qt's Markdown importer gets wrong for a themed panel:
//
//   Links     It bakes a near-black blue into the character format, and
//             QQuickText.linkColor does not override it (asking for red still
//             renders blue).
//   Code      Inline spans and fenced blocks are drawn with the system fixed
//             font at its own point size, ignoring the item's font, so they
//             tower over the surrounding text.
//
// Inline HTML does survive the importer, so both are rewritten as HTML that
// carries the colour and size explicitly.

// Only a literal colour may reach a style attribute.
export function sanitizeColor(value) {
  const text = String(value || "").trim()
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return text
  if (/^[a-zA-Z]{3,20}$/.test(text)) return text
  return ""
}

// Likewise a literal pixel size.
export function sanitizeFontSize(value) {
  const size = Math.round(Number(value))
  if (!isFinite(size) || size < 1 || size > 200) return ""
  return size + "px"
}

function escapeText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;")
}

// A link that is not an image reference. The label keeps its Markdown, because
// CommonMark still parses inline markup between raw HTML tags.
const LINK_RE = /(^|[^!])\[([^\]]*)\]\(([^)\s]+)\)/g

function styleLinksInProse(chunk, color) {
  if (color === "") return chunk
  return chunk.replace(LINK_RE, function (whole, prefix, label, url) {
    return prefix + '<a href="' + escapeAttribute(url) + '" style="color:' + color + '">'
      + label + "</a>"
  })
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/

// Qt gives every block the same gap as a line break: paragraph to paragraph,
// heading to paragraph, list to paragraph all render at one rhythm, so the
// structure of a note is invisible. An empty paragraph restores the
// distinction — the only spacer that survives, since <br> destroys a following
// list and a margin style merges the lines around it.
//
// A blank line *between two list items* is left alone. Splitting there would
// end the list and restart an ordered one at 1, and a checklist reads better
// tight anyway.
function addBlockSpacing(chunk) {
  const lines = chunk.split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() !== "") {
      out.push(lines[i])
      i++
      continue
    }
    // Collapse a run of blank or whitespace-only lines to one boundary.
    let end = i
    while (end < lines.length && lines[end].trim() === "") end++

    const before = out.length > 0 ? out[out.length - 1] : ""
    const after = end < lines.length ? lines[end] : ""
    const atEdge = before === "" || after === ""
    const withinList = LIST_ITEM_RE.test(before) && LIST_ITEM_RE.test(after)

    if (atEdge) {
      // Nothing to separate: leave the run exactly as the note had it.
      for (let k = i; k < end; k++) out.push(lines[k])
    } else if (withinList) {
      // One blank line, normalised: a whitespace-only line is still blank.
      out.push("")
    } else {
      out.push("", "&nbsp;", "")
    }
    i = end
  }
  return out.join("\n")
}

// --- tables -----------------------------------------------------------------
//
// Qt draws a Markdown table's grid in its own colour, ignoring the theme. The
// only styling it honours is the `bordercolor` attribute on an HTML <table>;
// CSS borders on cells are dropped and the table loses its grid entirely. So a
// table is converted to HTML — and because the importer treats that as a raw
// HTML block, the Markdown *inside* each cell stops being parsed and has to be
// rendered here too.

const TABLE_DELIMITER_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/
const CELL_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g
const CELL_CODE_RE = /`[^`\n]+`/g

function splitRow(line) {
  let text = line.trim()
  if (text.charAt(0) === "|") text = text.slice(1)
  if (text.charAt(text.length - 1) === "|") text = text.slice(0, -1)
  const cells = text.split("|")
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim()
  return cells
}

function alignmentOf(spec) {
  const text = String(spec || "").trim()
  const left = text.charAt(0) === ":"
  const right = text.charAt(text.length - 1) === ":"
  if (left && right) return "center"
  if (right) return "right"
  if (left) return "left"
  return ""
}

// The inline subset that actually turns up in table cells. Escaping happens
// first, so anything not matched here stays literal text.
function renderCellProse(text, color) {
  let out = escapeText(text)
  if (color !== "") {
    out = out.replace(CELL_LINK_RE, function (whole, label, url) {
      return '<a href="' + url + '" style="color:' + color + '">' + label + "</a>"
    })
  }
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  out = out.replace(/__([^_]+)__/g, "<b>$1</b>")
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>")
  return out
}

function renderCell(text, color, size) {
  const parts = []
  let last = 0
  let match
  CELL_CODE_RE.lastIndex = 0
  while ((match = CELL_CODE_RE.exec(text)) !== null) {
    parts.push(renderCellProse(text.slice(last, match.index), color))
    const code = match[0].slice(1, -1)
    parts.push(size !== "" ? codeSpan(code, size) : escapeText(code))
    last = match.index + match[0].length
  }
  parts.push(renderCellProse(text.slice(last), color))
  return parts.join("")
}

function renderTable(header, alignments, rows, options) {
  const border = options.border
  const color = options.color
  const size = options.size
  const parts = ['<table border="1" bordercolor="' + border
    + '" cellpadding="4" cellspacing="0">']

  function cells(values, tag) {
    let row = "<tr>"
    for (let i = 0; i < values.length; i++) {
      const align = alignments[i] || ""
      row += "<" + tag + (align !== "" ? ' align="' + align + '"' : "") + ">"
        + renderCell(values[i], color, size) + "</" + tag + ">"
    }
    return row + "</tr>"
  }

  parts.push(cells(header, "th"))
  for (let i = 0; i < rows.length; i++) parts.push(cells(rows[i], "td"))
  parts.push("</table>")
  return parts.join("")
}

function convertTables(chunk, options) {
  if (options.border === "") return chunk
  const lines = chunk.split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    const isTableStart = i + 1 < lines.length
      && lines[i].indexOf("|") !== -1
      && TABLE_DELIMITER_RE.test(lines[i + 1])
    if (!isTableStart) {
      out.push(lines[i])
      i++
      continue
    }
    const header = splitRow(lines[i])
    const alignments = splitRow(lines[i + 1]).map(alignmentOf)
    const rows = []
    let end = i + 2
    while (end < lines.length && lines[end].trim() !== "" && lines[end].indexOf("|") !== -1) {
      rows.push(splitRow(lines[end]))
      end++
    }
    out.push(renderTable(header, alignments, rows, options))
    i = end
  }
  return out.join("\n")
}

// Inline code and links have to be resolved in one pass: styling the code
// first would leave `[label](url)` sitting inside a <code> tag for the link
// pass to find and turn into an anchor.
function styleInline(chunk, options) {
  const parts = []
  let last = 0
  let match
  INLINE_CODE_RE.lastIndex = 0
  while ((match = INLINE_CODE_RE.exec(chunk)) !== null) {
    parts.push(styleLinksInProse(
      neutralizeEmbeds(chunk.slice(last, match.index)), options.color))
    // A code span is displayed, not interpreted: whatever it holds is escaped
    // by codeSpan and never becomes an element, so it is left as written.
    parts.push(options.size !== ""
      ? codeSpan(match[0].slice(1, -1), options.size)
      : match[0])
    last = match.index + match[0].length
  }
  parts.push(styleLinksInProse(neutralizeEmbeds(chunk.slice(last)), options.color))
  return parts.join("")
}

function styleProse(chunk, options) {
  // Tables first: their cells own their inline markdown, and once rendered they
  // hold no backticks or link syntax for the later passes to find.
  return addBlockSpacing(styleInline(convertTables(chunk, options), options))
}

function codeSpan(text, size) {
  return '<code style="font-size:' + size + '">' + escapeText(text) + "</code>"
}

// A fenced block becomes a blockquote of per-line code spans joined by Markdown
// hard breaks. `<pre>` would be the obvious choice but the importer treats it as
// inline and collapses the block onto the preceding paragraph; the blockquote
// keeps the grouping indent and the line breaks.
function styleFence(block, size) {
  const lines = block.split("\n")
  lines.shift()
  if (lines.length > 0 && /^\s*(```|~~~)\s*$/.test(lines[lines.length - 1])) lines.pop()
  if (lines.length === 0) return ""
  const rendered = []
  for (let i = 0; i < lines.length; i++) {
    rendered.push(lines[i].trim() === "" ? ">" : "> " + codeSpan(lines[i], size))
  }
  return "\n\n" + rendered.join("  \n") + "\n\n"
}

// Only fenced blocks split the document. An inline code span is inline — it can
// appear inside a table cell — so it is handled per prose chunk, after tables
// have been recognised. Splitting on it here would tear a table row in half.
const FENCE_RE = /(```[^\n]*\n[\s\S]*?^```|~~~[^\n]*\n[\s\S]*?^~~~)/gm
const INLINE_CODE_RE = /`[^`\n]+`/g

export function styleMarkdown(markdown, options) {
  const text = String(markdown === undefined || markdown === null ? "" : markdown)
  const settings = options || {}
  const color = sanitizeColor(settings.linkColor)
  const size = sanitizeFontSize(settings.fontSizePx)
  const styling = {
    color: color,
    size: size,
    border: sanitizeColor(settings.tableBorderColor)
  }

  const out = []
  let last = 0
  let match
  FENCE_RE.lastIndex = 0
  while ((match = FENCE_RE.exec(text)) !== null) {
    out.push(styleProse(text.slice(last, match.index), styling))
    out.push(size === "" ? match[0] : styleFence(match[0], size))
    last = match.index + match[0].length
  }
  out.push(styleProse(text.slice(last), styling))
  return out.join("")
}

// --- full-text search -------------------------------------------------------
//
// Joplin maintains an FTS4 index (`notes_fts`) over note titles and bodies, so
// searching bodies costs one more query rather than reading every note.
//
// FTS4 fails the *whole* query on a malformed MATCH expression — a bare `AND`,
// an unbalanced quote, a stray `*` — so user input is reduced to plain terms.
// Lowercasing is what makes that safe: FTS4 only treats AND/OR/NOT/NEAR as
// operators in uppercase, so a lowercase term can never become one.

export const MAX_SEARCH_TERMS = 16

// Quote and operator characters, removed rather than escaped.
const FTS_STRIP_RE = /["'^*():\-]+/g

export function ftsMatchExpression(text) {
  const cleaned = String(text === undefined || text === null ? "" : text)
    .replace(FTS_STRIP_RE, " ")
  const tokens = cleaned.split(/\s+/)
  const terms = []
  for (let i = 0; i < tokens.length && terms.length < MAX_SEARCH_TERMS; i++) {
    const term = tokens[i].toLowerCase()
    // A trailing `*` prefix-matches, so a half-typed word still finds notes.
    if (term !== "") terms.push(term + "*")
  }
  // Adjacent terms are an implicit AND in FTS4.
  return terms.join(" ")
}

export function searchSql(expression) {
  const expr = String(expression || "")
  if (expr === "") throw new Error("refusing to run a search with no terms")
  return "SELECT id FROM notes_fts WHERE notes_fts MATCH '"
    + expr.replace(/'/g, "''") + "'"
    + " LIMIT " + MAX_SEARCH_RESULTS + ";"
}

// --- html notes -------------------------------------------------------------
//
// A markup_language 2 note is handed to Text as RichText, which skips the
// Markdown rewriting above — but Qt renders its anchors and code in exactly the
// same untheme-aware way, so the same treatment is applied to the HTML directly.
// The panel's colour wins over one the note carries: a clipped page's link
// colour is chosen for a white background and is routinely illegible on a dark
// one, and consistency between note types matters more here than honouring it.

// A stored HTML note is rendered as RichText, and Qt will fetch what that HTML
// references while laying it out — an <img> pointing at a URL is loaded without
// anyone clicking anything. A note body arrives over sync, so before any of it
// reaches a Text it is reduced to a subset that cannot reach outside itself.
//
// Joplin's own attachments never get here: splitBody has already lifted
// `:/<id>` references out into image segments the panel renders itself. An
// <img> that survives to this point is therefore pointing somewhere else.

// Elements whose content is not text. Dropped whole, closed or not.
const HTML_DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "embed", "video", "audio", "canvas",
  "svg", "math", "template", "noscript", "applet", "frame", "frameset", "head",
  "form", "map", "portal"
]

const ALLOWED_HTML_TAGS = [
  "a", "abbr", "b", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt",
  "u", "ul", "var"
]

// No src, no srcset, no background, no formaction: nothing that names another
// resource. `on*` handlers are absent by omission rather than by a rule.
const ALLOWED_HTML_ATTRIBUTES = [
  "href", "title", "align", "valign", "colspan", "rowspan", "span", "start",
  "width", "height", "border", "cellpadding", "cellspacing", "bordercolor",
  "color", "face", "size", "dir", "style"
]

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_DECLARATION_RE = /<![^>]*>/g
const HTML_IMG_RE = /<img\b([^>]*)>/gi
const HTML_TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g
const HTML_ATTRIBUTE_RE =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>=`]+))/g

// url() is how a style attribute fetches something; expression() is how an old
// one ran script. A declaration carrying either is dropped, not rewritten.
function sanitizeStyleDeclarations(value) {
  const parts = String(value === undefined || value === null ? "" : value).split(";")
  const kept = []
  for (let i = 0; i < parts.length; i++) {
    const declaration = parts[i].trim()
    if (declaration === "") continue
    if (/url\s*\(/i.test(declaration)) continue
    if (/expression\s*\(/i.test(declaration)) continue
    if (/[<>"']/.test(declaration)) continue
    kept.push(declaration)
  }
  return kept.join(";")
}

function sanitizeHtmlAttributes(tag, rawAttributes, profileDir) {
  let out = ""
  HTML_ATTRIBUTE_RE.lastIndex = 0
  let match
  while ((match = HTML_ATTRIBUTE_RE.exec(rawAttributes)) !== null) {
    const name = match[1].toLowerCase()
    if (ALLOWED_HTML_ATTRIBUTES.indexOf(name) === -1) continue
    let value = match[3] !== undefined
      ? match[3]
      : (match[4] !== undefined ? match[4] : (match[5] || ""))

    if (name === "href") {
      // Only an anchor may carry one, and only to somewhere it may go.
      if (tag !== "a") continue
      value = externalLinkUrl(value, profileDir)
      if (value === "") continue
    }
    if (name === "style") {
      value = sanitizeStyleDeclarations(value)
      if (value === "") continue
    }
    out += " " + name + '="' + escapeAttribute(value) + '"'
  }
  return out
}

// Attributes that name another resource or run code. The tag they sit on may be
// ordinary formatting, so these are removed and the element is kept.
const LOADING_ATTRIBUTE_RE =
  /\s(?:on[a-z]+|src|srcset|data|poster|background|formaction|xlink:href|lowsrc|dynsrc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const STYLE_ATTRIBUTE_RE = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi

function stripLoadingAttributes(rawAttributes) {
  let out = String(rawAttributes === undefined || rawAttributes === null ? "" : rawAttributes)
  out = out.replace(LOADING_ATTRIBUTE_RE, "")
  out = out.replace(STYLE_ATTRIBUTE_RE, function (whole, lead, quoted, double, single) {
    const value = double !== undefined ? double : (single !== undefined ? single : "")
    const cleaned = sanitizeStyleDeclarations(value)
    return cleaned === "" ? "" : lead + '"' + escapeAttribute(cleaned) + '"'
  })
  return out
}

// Qt's Markdown importer honours inline HTML — that is the whole premise of the
// anchor and code rewriting above — so a Markdown note can carry an embed just
// as a stored HTML one can, and the same implicit load follows from it.
//
// Only the constructs that reach outside the note are taken out here, and the
// element that carries them is otherwise left alone: a note's own <b> is not
// this function's business. It runs on prose slices only, never on a code span
// or a fence, so a note that *displays* <img src=...> as code still shows it.
export function neutralizeEmbeds(text) {
  let out = String(text === undefined || text === null ? "" : text)

  for (let i = 0; i < HTML_DROP_WITH_CONTENT.length; i++) {
    const tag = HTML_DROP_WITH_CONTENT[i]
    out = out.replace(
      new RegExp("<" + tag + "\\b[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), "")
    out = out.replace(new RegExp("<\\/?" + tag + "\\b[^>]*>", "gi"), "")
  }

  out = out.replace(HTML_IMG_RE, function (whole, attributes) {
    const alt = ALT_RE.exec(attributes)
    return alt && alt[1] ? escapeText(alt[1]) : ""
  })

  out = out.replace(HTML_TAG_RE, function (whole, closing, rawName, rawAttributes) {
    if (closing === "/") return whole
    return "<" + rawName + stripLoadingAttributes(rawAttributes) + ">"
  })

  return out
}

export function sanitizeHtml(html, profileDir) {
  let text = String(html === undefined || html === null ? "" : html)

  // A comment can hold a tag that a later pass would then see; remove both
  // comments and declarations before anything looks for elements.
  text = text.replace(HTML_COMMENT_RE, "")
  text = text.replace(HTML_DECLARATION_RE, "")

  for (let i = 0; i < HTML_DROP_WITH_CONTENT.length; i++) {
    const tag = HTML_DROP_WITH_CONTENT[i]
    text = text.replace(
      new RegExp("<" + tag + "\\b[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), "")
    // An unclosed one would otherwise leave its opening tag behind.
    text = text.replace(new RegExp("<\\/?" + tag + "\\b[^>]*>", "gi"), "")
  }

  // Any <img> still here names something outside the note. Its alt text is
  // kept, since that is the part the reader was meant to get.
  text = text.replace(HTML_IMG_RE, function (whole, attributes) {
    const alt = ALT_RE.exec(attributes)
    return alt && alt[1] ? escapeText(alt[1]) : ""
  })

  text = text.replace(HTML_TAG_RE, function (whole, closing, rawName, rawAttributes) {
    const name = rawName.toLowerCase()
    if (ALLOWED_HTML_TAGS.indexOf(name) === -1) return ""
    if (closing === "/") return "</" + name + ">"
    const selfClosing = /\/\s*$/.test(rawAttributes) ? " /" : ""
    return "<" + name + sanitizeHtmlAttributes(name, rawAttributes, profileDir) + selfClosing + ">"
  })

  return text
}

const ANCHOR_RE = /<a\b([^>]*?)(\/?)>/gi
const CODE_OPEN_RE = /<(code|pre)\b([^>]*?)(\/?)>/gi

function withStyle(attributes, declaration) {
  const doubleQuoted = /(\bstyle\s*=\s*")([^"]*)(")/i
  if (doubleQuoted.test(attributes)) {
    return attributes.replace(doubleQuoted, function (whole, open, value, close) {
      return open + value.replace(/;\s*$/, "") + ";" + declaration + close
    })
  }
  const singleQuoted = /(\bstyle\s*=\s*')([^']*)(')/i
  if (singleQuoted.test(attributes)) {
    return attributes.replace(singleQuoted, function (whole, open, value, close) {
      return open + value.replace(/;\s*$/, "") + ";" + declaration + close
    })
  }
  return attributes + ' style="' + declaration + '"'
}

export function styleHtml(html, options) {
  const settings = options || {}
  // Sanitising here rather than at the call site means there is one way for an
  // HTML note to reach a Text, and it goes through this.
  let text = sanitizeHtml(html, settings.profileDir)
  const color = sanitizeColor(settings.linkColor)
  const size = sanitizeFontSize(settings.fontSizePx)

  if (color !== "") {
    text = text.replace(ANCHOR_RE, function (whole, attributes, selfClosing) {
      return "<a" + withStyle(attributes, "color:" + color) + selfClosing + ">"
    })
  }
  if (size !== "") {
    text = text.replace(CODE_OPEN_RE, function (whole, tag, attributes, selfClosing) {
      return "<" + tag + withStyle(attributes, "font-size:" + size) + selfClosing + ">"
    })
  }
  return text
}

// --- tags -------------------------------------------------------------------
//
// Tags live in `tags`, and `note_tags` joins them to notes. Neither table has a
// deleted_time column, and a note_tags row outlives the note it points at, so
// counts are taken against the notes actually on screen rather than the join
// table's own size.

export const SOURCE_ALL = "all"
export const SOURCE_FOLDER = "folder"
export const SOURCE_TAG = "tag"

// One query rather than two: the LEFT JOIN also yields a row for a tag that has
// no notes, so an empty tag still appears in the list.
export function tagsSql() {
  return "SELECT t.id AS tag_id,"
    + " substr(t.title, 1, " + MAX_TITLE_CHARS + ") AS title,"
    + " nt.note_id AS note_id"
    + " FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id"
    + " ORDER BY t.title COLLATE NOCASE ASC"
    + " LIMIT " + MAX_TAG_ROWS + ";"
}

// Returns { tags, notesByTag, tagsByNote } where `tags` keeps the query's
// ordering, `notesByTag` drives filtering, and `tagsByNote` labels a note.
export function buildTagIndex(rows, notes) {
  const joined = Array.isArray(rows) ? rows : []
  const noteList = Array.isArray(notes) ? notes : []

  const live = {}
  for (let i = 0; i < noteList.length; i++) {
    const id = String(noteList[i] && noteList[i].id || "")
    if (id !== "") live[id] = true
  }

  const byId = {}
  const notesByTag = {}
  const tagsByNote = {}
  const tags = []

  for (let i = 0; i < joined.length; i++) {
    const tagId = String(joined[i] && joined[i].tag_id || "")
    if (!ID_RE.test(tagId)) continue

    if (!byId[tagId]) {
      byId[tagId] = { id: tagId, title: String(joined[i].title || "").trim() || "Untitled", count: 0 }
      notesByTag[tagId] = {}
      tags.push(byId[tagId])
    }

    const noteId = String(joined[i].note_id || "")
    // Skip the LEFT JOIN's null row, a note in the trash, and any duplicate
    // pairing the join table happens to hold.
    if (noteId === "" || !live[noteId] || notesByTag[tagId][noteId]) continue

    notesByTag[tagId][noteId] = true
    byId[tagId].count++
    if (!tagsByNote[noteId]) tagsByNote[noteId] = []
    tagsByNote[noteId].push(byId[tagId].title)
  }

  const noteIds = Object.keys(tagsByNote)
  for (let i = 0; i < noteIds.length; i++) {
    tagsByNote[noteIds[i]].sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : (a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    })
  }

  return { tags: tags, notesByTag: notesByTag, tagsByNote: tagsByNote }
}

export function emptyTagIndex() {
  return { tags: [], notesByTag: {}, tagsByNote: {} }
}

// Replaces notesForFolder as the single entry point for "what is in view".
export function notesForSource(notes, kind, id, tagIndex) {
  const rows = Array.isArray(notes) ? notes : []
  if (kind === SOURCE_TAG) {
    const index = tagIndex || emptyTagIndex()
    const members = index.notesByTag ? index.notesByTag[String(id || "")] : null
    if (!members) return []
    const out = []
    for (let i = 0; i < rows.length; i++) {
      if (members[String(rows[i] && rows[i].id || "")]) out.push(rows[i])
    }
    return out
  }
  if (kind === SOURCE_FOLDER) return notesForFolder(rows, id)
  return rows.slice()
}

export function tagsForNote(tagIndex, noteId) {
  const index = tagIndex || emptyTagIndex()
  const found = index.tagsByNote ? index.tagsByNote[String(noteId || "")] : null
  return found ? found.slice() : []
}
