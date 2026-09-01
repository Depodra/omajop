import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

test("parseRows treats sqlite3's empty output as no rows", () => {
  // sqlite3 -json prints nothing at all for an empty result set.
  assert.deepEqual(Model.parseRows(""), [])
  assert.deepEqual(Model.parseRows("   \n"), [])
  assert.deepEqual(Model.parseRows(null), [])
  assert.deepEqual(Model.parseRows('[{"id":"a"}]'), [{ id: "a" }])
})

test("sqliteArgv sets the timeout as a dot-command, not a pragma", () => {
  const argv = Model.sqliteArgv("/db.sqlite", "SELECT 1;")
  // PRAGMA busy_timeout prints its result and would corrupt the JSON.
  assert.ok(!argv.join(" ").includes("PRAGMA"))
  assert.deepEqual(argv.slice(0, 5),
    ["sqlite3", "-readonly", "-cmd", ".timeout 3000", "-json"])
  assert.equal(argv[5], "/db.sqlite")
  assert.equal(argv[6], "SELECT 1;")
})

test("databasePath defaults to the desktop profile and honours an override", () => {
  assert.equal(Model.databasePath("/home/x", ""),
    "/home/x/.config/joplin-desktop/database.sqlite")
  assert.equal(Model.databasePath("/home/x", "~/alt/"),
    "/home/x/alt/database.sqlite")
  assert.equal(Model.databasePath("/home/x", "/srv/profile"),
    "/srv/profile/database.sqlite")
})

test("noteBodySql refuses anything that is not a Joplin id", () => {
  const id = "56ee5ca340d44a7d85bde04c8da781f5"
  assert.ok(Model.noteBodySql(id).includes("'" + id + "'"))
  for (const bad of ["", "x", "'; DROP TABLE notes;--", id.toUpperCase(), id + "0"]) {
    assert.throws(() => Model.noteBodySql(bad), /malformed note id/)
  }
})

test("note queries exclude the trash and conflict copies", () => {
  const sql = Model.notesSql("updated")
  assert.ok(sql.includes("deleted_time = 0"))
  assert.ok(sql.includes("is_conflict = 0"))
  assert.ok(Model.foldersSql().includes("deleted_time = 0"))
})

test("notesSql sorts by the normalized setting", () => {
  assert.ok(Model.notesSql("title").includes("title COLLATE NOCASE ASC"))
  assert.ok(Model.notesSql("updated").includes("updated_time DESC"))
  assert.ok(Model.notesSql("nonsense").includes("updated_time DESC"))
})

test("settings are clamped on the way in", () => {
  assert.equal(Model.normalizeRefreshSeconds(0), 5)
  assert.equal(Model.normalizeRefreshSeconds(99999), 3600)
  assert.equal(Model.normalizeRefreshSeconds("abc"), 60)
  assert.equal(Model.normalizeRefreshSeconds(null), 60)
  assert.equal(Model.normalizeSortBy("title"), "title")
  assert.equal(Model.normalizeSortBy(undefined), "updated")
})

test("every list query bounds its row count", () => {
  assert.match(Model.foldersSql(), /LIMIT \d+;$/)
  assert.match(Model.notesSql("updated"), /LIMIT \d+;$/)
  assert.match(Model.resourcesSql(), /LIMIT \d+;$/)
  assert.match(Model.tagsSql(), /LIMIT \d+;$/)
  assert.match(Model.searchSql("a*"), /LIMIT \d+;$/)
})

test("every list query bounds the text columns it selects", () => {
  // A title, a mime or an extension is unbounded in the schema; the response
  // has to be bounded before it becomes JSON in shell memory.
  assert.ok(Model.foldersSql().includes("substr(title, 1, " + Model.MAX_TITLE_CHARS + ")"))
  assert.ok(Model.notesSql("updated").includes("substr(title, 1, " + Model.MAX_TITLE_CHARS + ")"))
  assert.ok(Model.resourcesSql().includes("substr(mime, 1, " + Model.MAX_MIME_CHARS + ")"))
  assert.ok(Model.resourcesSql().includes(
    "substr(file_extension, 1, " + Model.MAX_EXTENSION_CHARS + ")"))
  assert.ok(Model.tagsSql().includes("substr(t.title, 1, " + Model.MAX_TITLE_CHARS + ")"))
})

test("bounded queries keep the column names the model reads", () => {
  // substr() without an alias would rename the column and silently empty it.
  for (const sql of [Model.foldersSql(), Model.notesSql("updated")]) {
    assert.ok(sql.includes("AS title"))
  }
  assert.ok(Model.resourcesSql().includes("AS mime"))
  assert.ok(Model.resourcesSql().includes("AS file_extension"))
  assert.ok(Model.tagsSql().includes("AS title"))
})

test("parseRows refuses an oversized response instead of parsing it", () => {
  const huge = "x".repeat(Model.MAX_STDOUT_CHARS + 1)
  assert.throws(() => Model.parseRows(huge), /oversized/)
  // A response at the limit is still parsed normally.
  assert.deepEqual(Model.parseRows('[{"id":"a"}]'), [{ id: "a" }])
})

test("no query can emit more than the stdout ceiling", () => {
  // The point of the ceiling is that it holds on the producing side. parseRows
  // only sees a response after the collector has buffered all of it, so a limit
  // that lets sqlite3 emit more than this would be a check that never helps.
  const queries = [
    ["folders", Model.MAX_FOLDERS, Model.MAX_TITLE_CHARS],
    ["notes", Model.MAX_NOTES, Model.MAX_TITLE_CHARS],
    ["resources", Model.MAX_RESOURCES,
      Model.MAX_TITLE_CHARS + Model.MAX_MIME_CHARS + Model.MAX_EXTENSION_CHARS],
    ["tags", Model.MAX_TAG_ROWS, Model.MAX_TITLE_CHARS],
    ["search", Model.MAX_SEARCH_RESULTS, 0]
  ]
  for (const [name, rows, textChars] of queries) {
    const worst = Model.worstCaseResponseChars(rows, textChars)
    assert.ok(worst <= Model.MAX_STDOUT_CHARS,
      name + " can emit " + worst + " chars, over the " + Model.MAX_STDOUT_CHARS + " ceiling")
  }
})

test("the note body query is bounded too", () => {
  // One row, but its body column is the largest single value read anywhere.
  const worst = Model.worstCaseResponseChars(1, Model.MAX_BODY_CHARS)
  assert.ok(worst <= Model.MAX_STDOUT_CHARS)
})

test("every derived row limit is a usable number", () => {
  // A budget divided by an over-estimated row must still leave room to work in;
  // a limit that collapsed to single digits would be a bound nobody could use.
  for (const limit of [Model.MAX_FOLDERS, Model.MAX_NOTES, Model.MAX_RESOURCES,
                       Model.MAX_TAG_ROWS, Model.MAX_SEARCH_RESULTS]) {
    assert.ok(Number.isInteger(limit) && limit > 1000, "unusable limit: " + limit)
  }
})

test("the per-row estimate is not smaller than a real worst-case row", () => {
  // ROW_OVERHEAD_CHARS and the escape factor are the whole basis of the budget,
  // so they are measured here rather than asserted. A control character is the
  // worst case: JSON writes it as a six-character escape.
  const ctrl = String.fromCharCode(1)
  const hex = "a".repeat(32)

  const rows = [
    ["folders", { id: hex, title: ctrl.repeat(Model.MAX_TITLE_CHARS), parent_id: hex },
      Model.MAX_TITLE_CHARS],
    ["notes", { id: hex, parent_id: hex, title: ctrl.repeat(Model.MAX_TITLE_CHARS),
      is_todo: 0, todo_completed: 0, updated_time: 1758000000000, encryption_applied: 0 },
      Model.MAX_TITLE_CHARS],
    ["resources", { id: hex, mime: ctrl.repeat(Model.MAX_MIME_CHARS),
      file_extension: ctrl.repeat(Model.MAX_EXTENSION_CHARS),
      title: ctrl.repeat(Model.MAX_TITLE_CHARS), size: 9007199254740991, encryption_applied: 0 },
      Model.MAX_TITLE_CHARS + Model.MAX_MIME_CHARS + Model.MAX_EXTENSION_CHARS],
    ["tags", { tag_id: hex, title: ctrl.repeat(Model.MAX_TITLE_CHARS), note_id: hex },
      Model.MAX_TITLE_CHARS],
    ["search", { id: hex }, 0]
  ]

  for (const [name, row, textChars] of rows) {
    // One row's budget, plus a byte for the separator sqlite3 writes between them.
    const budgeted = Model.worstCaseResponseChars(1, textChars)
    const actual = JSON.stringify(row).length + 1
    assert.ok(actual <= budgeted,
      name + " row is " + actual + " chars, over its " + budgeted + " budget")
  }
})

test("a non-BMP character cannot outgrow its budget either", () => {
  // SQLite counts substr() in characters; JavaScript counts length in UTF-16
  // units, and an emoji is two of them. Two units is still far under the six a
  // control character costs, so the factor covers it — but not by assumption.
  const astral = String.fromCodePoint(0x1f600)
  const title = astral.repeat(Model.MAX_TITLE_CHARS)
  const actual = JSON.stringify({ id: "a".repeat(32), title: title, parent_id: "b".repeat(32) }).length + 1
  assert.ok(actual <= Model.worstCaseResponseChars(1, Model.MAX_TITLE_CHARS),
    "astral row is " + actual + " chars")
})
