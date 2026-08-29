import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as Model from "../Model.mjs"

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
const widget = manifest.barWidget

test("the manifest is a bar-widget plugin with a real entry point", () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.kinds, ["bar-widget"])
  assert.equal(manifest.entryPoints.barWidget, "BarWidget.qml")
  // The plugin directory must be named after the id for the shell to load it.
  assert.match(manifest.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/)
})

test("every declared setting has a default, and every default is declared", () => {
  const declared = widget.schema.map(entry => entry.key).sort()
  const defaults = Object.keys(widget.defaults).sort()
  assert.deepEqual(declared, defaults)
})

test("the manifest's defaults survive the model's own clamping", () => {
  // shell.json is hand-editable and the schema is only a hint, so the model
  // clamps everything on the way in. A default it would rewrite is a default
  // that lies about what the widget does.
  assert.equal(Model.normalizeSortBy(widget.defaults.sortBy), widget.defaults.sortBy)
  assert.equal(Model.normalizeRefreshSeconds(widget.defaults.refreshSeconds),
    widget.defaults.refreshSeconds)
  assert.equal(Model.normalizeProfilePath(widget.defaults.profilePath),
    widget.defaults.profilePath)
})

test("the sortBy options are exactly what the model accepts", () => {
  const entry = widget.schema.find(e => e.key === "sortBy")
  assert.deepEqual(entry.options.slice().sort(), [Model.SORT_TITLE, Model.SORT_UPDATED].sort())
  for (const option of entry.options) {
    assert.equal(Model.normalizeSortBy(option), option)
  }
})

test("the refreshSeconds bounds match the model's clamp", () => {
  const entry = widget.schema.find(e => e.key === "refreshSeconds")
  // A value at either bound must pass through unchanged.
  assert.equal(Model.normalizeRefreshSeconds(entry.min), entry.min)
  assert.equal(Model.normalizeRefreshSeconds(entry.max), entry.max)
  // And one step outside must be pulled back to it.
  assert.equal(Model.normalizeRefreshSeconds(entry.min - 1), entry.min)
  assert.equal(Model.normalizeRefreshSeconds(entry.max + 1), entry.max)
})

test("an empty profilePath default means the standard Joplin profile", () => {
  assert.equal(Model.databasePath("/home/x", widget.defaults.profilePath),
    "/home/x/.config/joplin-desktop/database.sqlite")
})
