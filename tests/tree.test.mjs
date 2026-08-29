import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const FOLDERS = [
  { id: "a".repeat(32), title: "Work", parent_id: "" },
  { id: "b".repeat(32), title: "Projects", parent_id: "a".repeat(32) },
  { id: "c".repeat(32), title: "Personal", parent_id: "" }
]

const NOTES = [
  { id: "1".repeat(32), parent_id: "a".repeat(32), title: "Standup", updated_time: 3, is_todo: 0, todo_completed: 0 },
  { id: "2".repeat(32), parent_id: "b".repeat(32), title: "omajop", updated_time: 2, is_todo: 1, todo_completed: 0 },
  { id: "3".repeat(32), parent_id: "c".repeat(32), title: "Shopping", updated_time: 1, is_todo: 1, todo_completed: 1 }
]

test("buildFolderTree nests children and rolls counts up", () => {
  const tree = Model.buildFolderTree(FOLDERS, NOTES)
  assert.deepEqual(tree.map(f => [f.title, f.depth]),
    [["Work", 0], ["Projects", 1], ["Personal", 0]])

  const work = tree[0]
  assert.equal(work.noteCount, 1)   // Standup only
  assert.equal(work.totalCount, 2)  // plus omajop, in the child folder
  assert.equal(tree[2].totalCount, 1)
})

test("a folder whose parent is gone still appears, at the root", () => {
  const orphaned = FOLDERS.concat([
    { id: "d".repeat(32), title: "Rescued", parent_id: "z".repeat(32) }
  ])
  const tree = Model.buildFolderTree(orphaned, NOTES)
  const rescued = tree.find(f => f.title === "Rescued")
  assert.ok(rescued, "orphan must not drop out of the list")
  assert.equal(rescued.depth, 0)
})

test("a parent_id cycle terminates instead of hanging", () => {
  const cyclic = [
    { id: "a".repeat(32), title: "A", parent_id: "b".repeat(32) },
    { id: "b".repeat(32), title: "B", parent_id: "a".repeat(32) }
  ]
  const tree = Model.buildFolderTree(cyclic, [])
  assert.equal(tree.length, 2)
})

test("notesForFolder scopes to one folder, and the empty id means all", () => {
  assert.equal(Model.notesForFolder(NOTES, "a".repeat(32)).length, 1)
  assert.equal(Model.notesForFolder(NOTES, Model.ALL_NOTES_ID).length, 3)
})

test("filterNotes matches titles case-insensitively", () => {
  assert.equal(Model.filterNotes(NOTES, "OMA").length, 1)
  assert.equal(Model.filterNotes(NOTES, "").length, 3)
  assert.equal(Model.filterNotes(NOTES, "nothing").length, 0)
})

test("todoState distinguishes plain notes from open and done to-dos", () => {
  assert.equal(Model.todoState(NOTES[0]), "none")
  assert.equal(Model.todoState(NOTES[1]), "open")
  assert.equal(Model.todoState(NOTES[2]), "done")
})

test("formatUpdated reads epoch milliseconds", () => {
  const now = new Date("2026-08-29T12:00:00Z")
  const at = ms => Model.formatUpdated(now.getTime() - ms, now)
  assert.equal(at(30 * 1000), "just now")
  assert.equal(at(5 * 60 * 1000), "5m ago")
  assert.equal(at(3 * 3600 * 1000), "3h ago")
  assert.equal(at(2 * 86400 * 1000), "2d ago")
  assert.match(at(60 * 86400 * 1000), /^\d+ [A-Z][a-z]{2}$/)
  assert.equal(Model.formatUpdated(0, now), "")
})

test("plainLine collapses newlines so tooltips stay one line", () => {
  assert.equal(Model.plainLine(" a\nb \t c "), "a b c")
})

test("noteUrl only builds a url for a real id", () => {
  const id = "56ee5ca340d44a7d85bde04c8da781f5"
  assert.equal(Model.noteUrl(id), "joplin://x-callback-url/openNote?id=" + id)
  assert.equal(Model.noteUrl("bogus"), "")
})
