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
export function databasePath(home, profilePath) {
  const configured = normalizeProfilePath(profilePath)
  const dir = configured !== ""
    ? expandHome(configured, home)
    : String(home || "") + "/" + DEFAULT_PROFILE_DIR
  return stripTrailingSlash(dir) + "/" + DB_FILENAME
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

export function filterNotes(notes, query) {
  const rows = Array.isArray(notes) ? notes : []
  const needle = String(query || "").trim().toLowerCase()
  if (needle === "") return rows.slice()
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const title = String(rows[i] && rows[i].title || "").toLowerCase()
    if (title.indexOf(needle) !== -1) out.push(rows[i])
  }
  return out
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
