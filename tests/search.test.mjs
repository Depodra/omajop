import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

// FTS4 fails the whole query on a malformed MATCH expression, so every one of
// these must come back as plain terms rather than an operator or a stray quote.
test("operators are neutralised by lowercasing", () => {
  // FTS4 only honours AND/OR/NOT/NEAR in uppercase.
  assert.equal(Model.ftsMatchExpression("AND"), "and*")
  assert.equal(Model.ftsMatchExpression("a AND b"), "a* and* b*")
  assert.equal(Model.ftsMatchExpression("NEAR"), "near*")
})

test("quotes, stars and hyphens are stripped", () => {
  assert.equal(Model.ftsMatchExpression('"foo'), "foo*")
  assert.equal(Model.ftsMatchExpression("o'brien"), "o* brien*")
  assert.equal(Model.ftsMatchExpression("e-mail"), "e* mail*")
  assert.equal(Model.ftsMatchExpression("^x(y):z"), "x* y* z*")
})

test("terms are prefix matched so a half-typed word still hits", () => {
  assert.equal(Model.ftsMatchExpression("clip"), "clip*")
  assert.equal(Model.ftsMatchExpression("  ASPIRIN   wasser "), "aspirin* wasser*")
})

test("input with no usable terms yields no expression", () => {
  for (const empty of ["", "   ", "*", '"', "---", null, undefined]) {
    assert.equal(Model.ftsMatchExpression(empty), "")
  }
})

test("the number of terms is capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => "t" + i).join(" ")
  assert.equal(Model.ftsMatchExpression(many).split(" ").length, Model.MAX_SEARCH_TERMS)
})

test("searchSql refuses an empty expression rather than matching everything", () => {
  assert.throws(() => Model.searchSql(""), /no terms/)
  assert.throws(() => Model.searchSql(null), /no terms/)
})

test("searchSql queries the FTS table and bounds the result", () => {
  const sql = Model.searchSql("clip*")
  assert.ok(sql.includes("FROM notes_fts WHERE notes_fts MATCH 'clip*'"))
  assert.ok(sql.includes("LIMIT " + Model.MAX_SEARCH_RESULTS))
})

test("a stray quote in an expression cannot break out of the SQL literal", () => {
  assert.ok(Model.searchSql("a'b").includes("'a''b'"))
})

test("filterNotes widens a title match with body matches", () => {
  const notes = [
    { id: "a".repeat(32), title: "Shopping" },
    { id: "b".repeat(32), title: "Standup" }
  ]
  // "kqueue" is in no title at all.
  assert.equal(Model.filterNotes(notes, "kqueue").length, 0)
  const matched = Model.idSet([{ id: "b".repeat(32) }])
  assert.deepEqual(Model.filterNotes(notes, "kqueue", matched).map(n => n.title), ["Standup"])
})

test("a body match does not duplicate a note that already matched by title", () => {
  const notes = [{ id: "a".repeat(32), title: "Shopping" }]
  const matched = Model.idSet([{ id: "a".repeat(32) }])
  assert.equal(Model.filterNotes(notes, "shop", matched).length, 1)
})

test("an empty query ignores body matches entirely", () => {
  const notes = [{ id: "a".repeat(32), title: "x" }, { id: "b".repeat(32), title: "y" }]
  assert.equal(Model.filterNotes(notes, "", Model.idSet([{ id: "a".repeat(32) }])).length, 2)
})

test("idSet keeps only well-formed ids", () => {
  assert.deepEqual(Model.idSet([{ id: "nope" }, { id: "" }, null]), {})
  assert.deepEqual(Model.idSet(null), {})
})
