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
