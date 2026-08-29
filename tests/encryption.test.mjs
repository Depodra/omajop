import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

// A note that synced in before its master key was available carries no usable
// title: Joplin serialises the whole item into encryption_cipher_text and
// leaves the other columns at their defaults.
const ENCRYPTED = { id: "c".repeat(32), title: "", body: "", encryption_applied: 1 }
const PLAIN = { id: "b".repeat(32), title: "Readable note", encryption_applied: 0 }
const UNTITLED = { id: "a".repeat(32), title: "   ", encryption_applied: 0 }

test("the note list query can see encryption state", () => {
  // Without this column an encrypted note is indistinguishable from a blank one.
  assert.ok(Model.notesSql("updated").includes("encryption_applied"))
})

test("isEncryptedNote reads the flag, not the empty title", () => {
  assert.equal(Model.isEncryptedNote(ENCRYPTED), true)
  assert.equal(Model.isEncryptedNote(PLAIN), false)
  assert.equal(Model.isEncryptedNote(UNTITLED), false)
  assert.equal(Model.isEncryptedNote(null), false)
  assert.equal(Model.isEncryptedNote({}), false)
})

test("an encrypted note is labelled, not shown as Untitled", () => {
  assert.equal(Model.noteTitle(ENCRYPTED), "Encrypted note")
  // A genuinely untitled but readable note keeps the ordinary placeholder.
  assert.equal(Model.noteTitle(UNTITLED), "Untitled")
  assert.equal(Model.noteTitle(PLAIN), "Readable note")
})

test("countEncrypted reports how many are still waiting on a key", () => {
  assert.equal(Model.countEncrypted([PLAIN, ENCRYPTED, UNTITLED, ENCRYPTED]), 2)
  assert.equal(Model.countEncrypted([PLAIN, UNTITLED]), 0)
  assert.equal(Model.countEncrypted([]), 0)
  assert.equal(Model.countEncrypted(null), 0)
})

test("the body query reports encryption alongside the body", () => {
  const sql = Model.noteBodySql("c".repeat(32))
  assert.ok(sql.includes("encryption_applied"))
})

test("isEncrypted reads a body row, which is a different shape", () => {
  assert.equal(Model.isEncrypted({ encryption_applied: 1 }), true)
  assert.equal(Model.isEncrypted({ encryption_applied: 0 }), false)
  assert.equal(Model.isEncrypted(null), false)
})

test("an encrypted note still sorts and filters like any other", () => {
  // Its updated_time is set even though its title is not.
  const notes = [PLAIN, ENCRYPTED]
  assert.equal(Model.filterNotes(notes, "readable").length, 1)
  // It cannot match by title, and FTS will not index it either.
  assert.equal(Model.filterNotes(notes, "secret").length, 0)
})
