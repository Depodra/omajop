import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const id = n => n.toString(16).padStart(32, "0")
const NOTE_A = id(1), NOTE_B = id(2), TRASHED = id(3)
const TAG_WORK = id(0x91), TAG_IDEA = id(0x92)

// Only notes that are actually on screen; a trashed note never reaches here.
const NOTES = [{ id: NOTE_A, title: "Alpha" }, { id: NOTE_B, title: "Beta" }]

const ROWS = [
  { tag_id: TAG_WORK, title: "work", note_id: NOTE_A },
  { tag_id: TAG_WORK, title: "work", note_id: NOTE_B },
  { tag_id: TAG_IDEA, title: "idea", note_id: NOTE_A }
]

test("tagsSql joins so that a tag with no notes still appears", () => {
  const sql = Model.tagsSql()
  assert.ok(sql.includes("LEFT JOIN note_tags"))
  assert.ok(sql.includes("ORDER BY t.title COLLATE NOCASE ASC"))
})

test("buildTagIndex counts notes and keeps the query order", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  assert.deepEqual(index.tags.map(t => [t.title, t.count]), [["work", 2], ["idea", 1]])
})

test("a join row pointing at a note that is not on screen is not counted", () => {
  // note_tags has no deleted_time, so rows outlive trashed notes.
  const rows = ROWS.concat([{ tag_id: TAG_WORK, title: "work", note_id: TRASHED }])
  const index = Model.buildTagIndex(rows, NOTES)
  assert.equal(index.tags[0].count, 2)
  assert.ok(!index.notesByTag[TAG_WORK][TRASHED])
})

test("a duplicate pairing is counted once", () => {
  const rows = ROWS.concat([{ tag_id: TAG_WORK, title: "work", note_id: NOTE_A }])
  assert.equal(Model.buildTagIndex(rows, NOTES).tags[0].count, 2)
})

test("a tag with no notes is listed with a zero count", () => {
  const rows = [{ tag_id: TAG_IDEA, title: "idea", note_id: null }]
  const index = Model.buildTagIndex(rows, NOTES)
  assert.deepEqual(index.tags.map(t => [t.title, t.count]), [["idea", 0]])
  assert.deepEqual(Model.notesForSource(NOTES, "tag", TAG_IDEA, index), [])
})

test("a malformed tag id is skipped", () => {
  const index = Model.buildTagIndex([{ tag_id: "nope", title: "x", note_id: NOTE_A }], NOTES)
  assert.deepEqual(index.tags, [])
})

test("an untitled tag gets a placeholder rather than an empty row", () => {
  const index = Model.buildTagIndex([{ tag_id: TAG_WORK, title: "  ", note_id: NOTE_A }], NOTES)
  assert.equal(index.tags[0].title, "Untitled")
})

test("notesForSource scopes by tag, folder, or everything", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  assert.deepEqual(Model.notesForSource(NOTES, "tag", TAG_IDEA, index).map(n => n.title), ["Alpha"])
  assert.equal(Model.notesForSource(NOTES, "all", "", index).length, 2)

  const foldered = [{ id: NOTE_A, parent_id: "f1" }, { id: NOTE_B, parent_id: "f2" }]
  assert.equal(Model.notesForSource(foldered, "folder", "f1", index).length, 1)
})

test("notesForSource keeps the note list's own ordering", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  assert.deepEqual(Model.notesForSource(NOTES, "tag", TAG_WORK, index).map(n => n.title),
    ["Alpha", "Beta"])
})

test("an unknown tag selects nothing rather than everything", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  assert.deepEqual(Model.notesForSource(NOTES, "tag", id(0xdead), index), [])
  assert.deepEqual(Model.notesForSource(NOTES, "tag", "", index), [])
})

test("tagsForNote lists a note's tags, sorted", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  assert.deepEqual(Model.tagsForNote(index, NOTE_A), ["idea", "work"])
  assert.deepEqual(Model.tagsForNote(index, NOTE_B), ["work"])
  assert.deepEqual(Model.tagsForNote(index, TRASHED), [])
})

test("tagsForNote returns a copy, so a caller cannot corrupt the index", () => {
  const index = Model.buildTagIndex(ROWS, NOTES)
  Model.tagsForNote(index, NOTE_A).push("injected")
  assert.deepEqual(Model.tagsForNote(index, NOTE_A), ["idea", "work"])
})

test("an empty index is safe to query", () => {
  const empty = Model.emptyTagIndex()
  assert.deepEqual(empty.tags, [])
  assert.deepEqual(Model.tagsForNote(empty, NOTE_A), [])
  assert.deepEqual(Model.notesForSource(NOTES, "tag", TAG_WORK, empty), [])
  assert.deepEqual(Model.notesForSource(NOTES, "tag", TAG_WORK, null), [])
  assert.deepEqual(Model.buildTagIndex(null, null).tags, [])
})
