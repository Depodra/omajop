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
export const MAX_NOTES = 5000

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
  const trimmed = String(text === undefined || text === null ? "" : text).trim()
  if (trimmed === "") return []
  const rows = JSON.parse(trimmed)
  return Array.isArray(rows) ? rows : []
}

// --- queries ----------------------------------------------------------------

export function schemaSql() {
  return "SELECT version FROM version LIMIT 1;"
}

export function foldersSql() {
  return "SELECT id, title, parent_id FROM folders"
    + " WHERE deleted_time = 0"
    + " ORDER BY title COLLATE NOCASE ASC;"
}

// `deleted_time = 0` excludes the trash and `is_conflict = 0` the conflict
// copies; both live in the same table as ordinary notes.
export function notesSql(sortBy) {
  const order = normalizeSortBy(sortBy) === SORT_TITLE
    ? "title COLLATE NOCASE ASC"
    : "updated_time DESC"
  return "SELECT id, parent_id, title, is_todo, todo_completed, updated_time"
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

export function noteTitle(note) {
  if (!note) return ""
  return String(note.title || "").trim() || "Untitled"
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
  return "SELECT id, mime, file_extension, title, encryption_applied"
    + " FROM resources;"
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
      encrypted: !!Number(list[i].encryption_applied)
    }
  }
  return map
}

export function isImageResource(resource) {
  return !!resource && resource.mime.indexOf("image/") === 0
}

export function resourcePath(profileDir, id, extension) {
  const ext = String(extension || "").replace(/^\./, "")
  return stripTrailingSlash(profileDir) + "/" + RESOURCE_DIR + "/" + id
    + (ext !== "" ? "." + ext : "")
}

// A path can contain characters that are not legal in a URL (a profile under a
// directory with spaces, say), so the path component is encoded.
export function fileUrl(path) {
  return "file://" + encodeURI(String(path || ""))
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

    if (wantsEmbed && isImageResource(resource)) {
      flush()
      segments.push({
        kind: "image",
        url: fileUrl(resourcePath(profileDir, id, resource.extension)),
        title: label !== "" ? label : resource.title,
        missing: false
      })
      continue
    }

    if (!resource) {
      // The reference outlived its resource row; say so rather than leaving
      // a dangling `:/id` in the text.
      buffer += label !== "" ? label + " (missing attachment)" : "(missing attachment)"
      continue
    }

    // A non-image attachment, or an image reference written as a plain link.
    const url = fileUrl(resourcePath(profileDir, id, resource.extension))
    const text = label !== "" ? label : (resource.title !== "" ? resource.title : "attachment")
    buffer += "[" + text + "](" + url + ")"
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

function styleProse(chunk, color) {
  if (color === "") return chunk
  return chunk.replace(LINK_RE, function (whole, prefix, label, url) {
    return prefix + '<a href="' + escapeAttribute(url) + '" style="color:' + color + '">'
      + label + "</a>"
  })
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

// Fenced blocks and inline spans are code: a link inside one is literal text
// and must never become an anchor.
const CODE_RE = /(```[^\n]*\n[\s\S]*?^```|~~~[^\n]*\n[\s\S]*?^~~~|`[^`\n]+`)/gm

export function styleMarkdown(markdown, options) {
  const text = String(markdown === undefined || markdown === null ? "" : markdown)
  const settings = options || {}
  const color = sanitizeColor(settings.linkColor)
  const size = sanitizeFontSize(settings.fontSizePx)

  const out = []
  let last = 0
  let match
  CODE_RE.lastIndex = 0
  while ((match = CODE_RE.exec(text)) !== null) {
    out.push(styleProse(text.slice(last, match.index), color))
    const block = match[0]
    const fenced = block.indexOf("```") === 0 || block.indexOf("~~~") === 0
    if (size === "") {
      out.push(block)
    } else if (fenced) {
      out.push(styleFence(block, size))
    } else {
      out.push(codeSpan(block.slice(1, -1), size))
    }
    last = match.index + block.length
  }
  out.push(styleProse(text.slice(last), color))
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

export const MAX_SEARCH_RESULTS = 5000
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
  let text = String(html === undefined || html === null ? "" : html)
  const settings = options || {}
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
  return "SELECT t.id AS tag_id, t.title AS title, nt.note_id AS note_id"
    + " FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id"
    + " ORDER BY t.title COLLATE NOCASE ASC;"
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
