import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const IMG = "3fbdbec569df4a31ad62594ecaa3b93c"
const PDF = "b57b23c659a5475e8e121965ee8a4dbb"
const GONE = "0123456789abcdef0123456789abcdef"
const DIR = "/home/x/.config/joplin-desktop"

const RESOURCES = Model.buildResourceMap([
  { id: IMG, mime: "image/png", file_extension: "png", title: "WebClipper.png", encryption_applied: 0 },
  { id: PDF, mime: "application/pdf", file_extension: "pdf", title: "Spec.pdf", encryption_applied: 0 }
])

test("buildResourceMap keys by id and skips malformed rows", () => {
  assert.equal(Object.keys(RESOURCES).length, 2)
  assert.equal(RESOURCES[IMG].mime, "image/png")
  assert.deepEqual(Model.buildResourceMap([{ id: "nope", mime: "image/png" }]), {})
  assert.deepEqual(Model.buildResourceMap(null), {})
})

test("resourcePath follows Joplin's <profile>/resources/<id>.<ext> layout", () => {
  assert.equal(Model.resourcePath(DIR, IMG, "png"), DIR + "/resources/" + IMG + ".png")
  assert.equal(Model.resourcePath(DIR, IMG, ".png"), DIR + "/resources/" + IMG + ".png")
  assert.equal(Model.resourcePath(DIR, IMG, ""), DIR + "/resources/" + IMG)
})

test("fileUrl encodes characters that are illegal in a URL", () => {
  assert.equal(Model.fileUrl("/home/a b/c.png"), "file:///home/a%20b/c.png")
  assert.ok(!Model.fileUrl("/a/b/c.png").includes("%2F"))
})

test("an image reference becomes its own segment, splitting the text", () => {
  const segments = Model.splitBody(
    "Before.\n\n![](:/" + IMG + ")\n\nAfter.", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text", "image", "text"])
  assert.match(segments[0].text, /Before\./)
  assert.equal(segments[1].url, "file://" + DIR + "/resources/" + IMG + ".png")
  assert.equal(segments[1].title, "WebClipper.png")  // falls back to the resource title
  assert.match(segments[2].text, /After\./)
})

test("several images in one body each get a segment", () => {
  const segments = Model.splitBody(
    "![a](:/" + IMG + ")\ntext\n![b](:/" + IMG + ")", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["image", "text", "image"])
  assert.equal(segments[0].title, "a")
})

test("a non-image attachment stays inline as an openable link", () => {
  const segments = Model.splitBody("See [the spec](:/" + PDF + ") first.", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text"])
  assert.ok(segments[0].text.includes("[the spec](file://" + DIR + "/resources/" + PDF + ".pdf)"))
})

test("an image written as a plain link is not lifted out of the text", () => {
  // Without the leading `!` Joplin renders a link, not an embed.
  const segments = Model.splitBody("[pic](:/" + IMG + ")", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text"])
})

test("a reference whose resource row is gone degrades to a label", () => {
  const segments = Model.splitBody("![shot](:/" + GONE + ")", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text"])
  assert.ok(segments[0].text.includes("missing attachment"))
})

test("a body with no references is a single text segment", () => {
  const segments = Model.splitBody("# Title\n\nJust prose.", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text"])
  assert.equal(segments[0].text, "# Title\n\nJust prose.")
})

test("an empty or whitespace body yields no segments", () => {
  assert.deepEqual(Model.splitBody("", RESOURCES, DIR), [])
  assert.deepEqual(Model.splitBody("   \n\n ", RESOURCES, DIR), [])
  assert.deepEqual(Model.splitBody(null, RESOURCES, DIR), [])
})

test("splitBody is re-entrant despite the shared regex", () => {
  // A module-level regex with /g carries lastIndex between calls if not reset.
  const body = "![](:/" + IMG + ")"
  assert.equal(Model.splitBody(body, RESOURCES, DIR).length, 1)
  assert.equal(Model.splitBody(body, RESOURCES, DIR).length, 1)
  assert.equal(Model.splitBody(body, RESOURCES, DIR).length, 1)
})

test("an HTML <img> reference becomes an image segment too", () => {
  // markup_language 2 notes embed attachments this way.
  const segments = Model.splitBody(
    'before <img src=":/' + IMG + '" alt="Diagram"> after', RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text", "image", "text"])
  assert.equal(segments[1].url, "file://" + DIR + "/resources/" + IMG + ".png")
  assert.equal(segments[1].title, "Diagram")   // taken from alt=
})

test("an HTML <img> with single quotes and extra attributes is matched", () => {
  const segments = Model.splitBody(
    "<img width='40' src=':/" + IMG + "' class='x'>", RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["image"])
})

test("an HTML <img> with no alt falls back to the resource title", () => {
  const segments = Model.splitBody('<img src=":/' + IMG + '">', RESOURCES, DIR)
  assert.equal(segments[0].title, "WebClipper.png")
})

test("an HTML <img> pointing at a non-image resource is not embedded", () => {
  const segments = Model.splitBody('<img src=":/' + PDF + '">', RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text"])
})

test("markdown and HTML images in one body keep document order", () => {
  const segments = Model.splitBody(
    'a ![m](:/' + IMG + ') b <img src=":/' + IMG + '" alt="h"> c', RESOURCES, DIR)
  assert.deepEqual(segments.map(s => s.kind), ["text", "image", "text", "image", "text"])
  assert.equal(segments[1].title, "m")
  assert.equal(segments[3].title, "h")
})
