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

test("sanitizeExtension keeps a plain extension and drops everything else", () => {
  assert.equal(Model.sanitizeExtension("png"), "png")
  assert.equal(Model.sanitizeExtension(".png"), "png")
  assert.equal(Model.sanitizeExtension("PNG"), "PNG")
  // A separator, a traversal, a control character or an over-long token is not
  // an extension, and must not reach a path.
  assert.equal(Model.sanitizeExtension("png/../../etc/passwd"), "")
  assert.equal(Model.sanitizeExtension("../../etc/passwd"), "")
  assert.equal(Model.sanitizeExtension("p g"), "")
  assert.equal(Model.sanitizeExtension("p\u0000g"), "")
  assert.equal(Model.sanitizeExtension("x".repeat(17)), "")
  assert.equal(Model.sanitizeExtension(null), "")
})

test("normalizePath resolves . and .. without touching the filesystem", () => {
  assert.equal(Model.normalizePath("/a/b/../c"), "/a/c")
  assert.equal(Model.normalizePath("/a/./b/"), "/a/b")
  assert.equal(Model.normalizePath("/a/b/../../../.."), "/")
  assert.equal(Model.normalizePath("a/../b"), "b")
})

test("isInsideDirectory rejects the directory itself and a same-prefix sibling", () => {
  assert.ok(Model.isInsideDirectory("/a/res", "/a/res/f.png"))
  assert.ok(!Model.isInsideDirectory("/a/res", "/a/res"))
  // The classic prefix bug: /a/resources.evil starts with /a/resources.
  assert.ok(!Model.isInsideDirectory("/a/res", "/a/res.evil/f.png"))
  assert.ok(!Model.isInsideDirectory("/a/res", "/a/res/../../etc/passwd"))
  assert.ok(!Model.isInsideDirectory("/", "/etc/passwd"))
})

test("resourcePath refuses to leave the profile's resources directory", () => {
  // A crafted file_extension is the escape route: it is appended to the path.
  assert.equal(Model.resourcePath(DIR, IMG, "png/../../../../etc/passwd"), "")
  assert.equal(Model.resourcePath(DIR, IMG, "../../../.bashrc"), "")
  // A malformed id never reaches the filesystem either.
  assert.equal(Model.resourcePath(DIR, "../../etc/passwd", "png"), "")
  assert.equal(Model.resourcePath(DIR, "", "png"), "")
  // Everything returned is inside the resources directory, by construction.
  assert.ok(Model.isInsideDirectory(
    Model.resourcesDirectory(DIR), Model.resourcePath(DIR, IMG, "png")))
})

test("an attachment with no usable path degrades to a label", () => {
  const resources = Model.buildResourceMap([
    { id: IMG, mime: "image/png", file_extension: "png/../../../etc/passwd",
      title: "Bad.png", encryption_applied: 0 }
  ])
  const segments = Model.splitBody("![alt](:/" + IMG + ")", resources, DIR)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, "text")
  assert.ok(segments[0].text.includes("unavailable attachment"))
  assert.ok(!segments[0].text.includes("passwd"))
})

test("fileUrl encodes characters that are illegal in a URL", () => {
  assert.equal(Model.fileUrl("/home/a b/c.png"), "file:///home/a%20b/c.png")
  assert.ok(!Model.fileUrl("/a/b/c.png").includes("%2F"))
  // An empty path must not become "file://", which resolves to the root.
  assert.equal(Model.fileUrl(""), "")
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

// --- links out of a note ----------------------------------------------------

const PROFILE = "/home/x/.config/joplin-desktop"
const RESOURCES_DIR = PROFILE + "/resources"

test("externalLinkUrl opens http and https, and nothing else", () => {
  assert.equal(Model.externalLinkUrl("https://example.com/a?b=1#c", PROFILE),
    "https://example.com/a?b=1#c")
  assert.equal(Model.externalLinkUrl("http://example.com", PROFILE), "http://example.com")
  // The scheme is matched case-insensitively, the URL is handed on untouched.
  assert.equal(Model.externalLinkUrl("HTTPS://Example.com", PROFILE), "HTTPS://Example.com")
})

test("externalLinkUrl refuses schemes that dispatch to a handler", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "smb://host/share",
    "ssh://host",
    "joplin://x-callback-url/openNote?id=x"
  ]) {
    assert.equal(Model.externalLinkUrl(url, PROFILE), "", url + " must not be opened")
  }
})

test("externalLinkUrl refuses a URL carrying credentials", () => {
  // Reads as real.example, opens evil.example.
  assert.equal(Model.externalLinkUrl("https://real.example@evil.example/", PROFILE), "")
  assert.equal(Model.externalLinkUrl("https://user:pw@evil.example/", PROFILE), "")
  assert.equal(Model.externalLinkUrl("https://", PROFILE), "")
})

test("externalLinkUrl refuses control characters and whitespace", () => {
  const withNewline = "https://example.com/" + String.fromCharCode(10) + "evil"
  assert.equal(Model.externalLinkUrl(withNewline, PROFILE), "")
  const withNul = "https://example.com/" + String.fromCharCode(0)
  assert.equal(Model.externalLinkUrl(withNul, PROFILE), "")
  assert.equal(Model.externalLinkUrl("https://ex ample.com", PROFILE), "")
})

test("externalLinkUrl opens a file link only inside this profile's resources", () => {
  const inside = "file://" + RESOURCES_DIR + "/a.png"
  assert.equal(Model.externalLinkUrl(inside, PROFILE), inside)
  assert.equal(Model.externalLinkUrl("file:///etc/passwd", PROFILE), "")
  assert.equal(Model.externalLinkUrl("file://" + RESOURCES_DIR + "/../../.bashrc", PROFILE), "")
  // A query or fragment is not part of the path the opener would resolve.
  assert.equal(Model.externalLinkUrl("file://" + RESOURCES_DIR + "/a.png?x=1", PROFILE), "")
  // With no profile there is nothing to bound a file link against.
  assert.equal(Model.externalLinkUrl(inside, ""), "")
})

test("externalLinkUrl refuses a link with no scheme at all", () => {
  assert.equal(Model.externalLinkUrl("relative/path.html", PROFILE), "")
  assert.equal(Model.externalLinkUrl("#anchor", PROFILE), "")
  assert.equal(Model.externalLinkUrl("", PROFILE), "")
  assert.equal(Model.externalLinkUrl(null, PROFILE), "")
})
