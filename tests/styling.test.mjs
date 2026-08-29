import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const OPTS = { linkColor: "#8bc9eb", fontSizePx: 11 }
const style = (md, o) => Model.styleMarkdown(md, o === undefined ? OPTS : o)

test("a markdown link becomes an anchor carrying the colour", () => {
  assert.equal(style("See [the docs](https://example.com) now."),
    'See <a href="https://example.com" style="color:#8bc9eb">the docs</a> now.')
})

test("a link at the very start of the body is rewritten too", () => {
  assert.ok(style("[first](https://a.b) then text").startsWith('<a href="https://a.b"'))
})

test("several links in one line are all rewritten", () => {
  assert.equal((style("[a](https://a) and [b](https://b)").match(/<a href=/g) || []).length, 2)
})

test("an image reference is left alone", () => {
  const body = "![alt](https://example.com/x.png)"
  assert.equal(style(body), body)
})

test("the label keeps its markdown so inline markup still renders", () => {
  assert.ok(style("[**bold** link](https://a)")
    .includes('<a href="https://a" style="color:#8bc9eb">**bold** link</a>'))
})

test("a url with quotes or angle brackets is escaped into the attribute", () => {
  const out = style('[x](https://a/"><script>)')
  assert.ok(!out.includes('"><script>'))
  assert.ok(out.includes("&quot;") && out.includes("&lt;"))
})

test("an inline code span is sized explicitly", () => {
  // Qt draws code with the system fixed font at its own size otherwise.
  assert.equal(style("use `npm test` now"),
    'use <code style="font-size:11px">npm test</code> now')
})

test("code content is escaped so it cannot become markup", () => {
  assert.equal(style("`a < b & c`"),
    '<code style="font-size:11px">a &lt; b &amp; c</code>')
})

test("a link inside code stays literal", () => {
  assert.equal(style("Use `[label](url)` verbatim."),
    'Use <code style="font-size:11px">[label](url)</code> verbatim.')
})

test("a fenced block becomes a blockquote of sized code lines", () => {
  const out = style("Run:\n\n```sh\ngit clone x\nmake\n```\n\nDone.")
  assert.ok(out.includes('> <code style="font-size:11px">git clone x</code>'))
  assert.ok(out.includes('> <code style="font-size:11px">make</code>'))
  assert.ok(out.includes("  \n"), "lines need markdown hard breaks")
  assert.ok(out.startsWith("Run:"))
  assert.ok(out.trimEnd().endsWith("Done."))
})

test("a link inside a fenced block is not rewritten", () => {
  const out = style("```\nsee [not a link](https://z)\n```")
  assert.ok(!out.includes("<a href="))
  assert.ok(out.includes("[not a link](https://z)"))
})

test("the fence markers themselves are dropped", () => {
  const out = style("```js\ncode\n```")
  assert.ok(!out.includes("```"))
})

test("only a literal colour and size reach the style attributes", () => {
  assert.equal(Model.sanitizeColor("#8bc9eb"), "#8bc9eb")
  assert.equal(Model.sanitizeColor("red"), "red")
  assert.equal(Model.sanitizeFontSize(11), "11px")
  for (const bad of ["red; content:url(x)", "#zzz", "", null]) {
    assert.equal(Model.sanitizeColor(bad), "")
  }
  for (const bad of [0, -3, 9999, "big", null]) {
    assert.equal(Model.sanitizeFontSize(bad), "")
  }
})

test("unusable options leave the markdown untouched", () => {
  const body = "[x](https://a) and `code`"
  assert.equal(style(body, { linkColor: "bad;", fontSizePx: 0 }), body)
  assert.equal(style(body, {}), body)
  assert.equal(Model.styleMarkdown(body, undefined), body)
  assert.equal(Model.styleMarkdown(body, null), body)
})

test("styleMarkdown is re-entrant despite the shared regexes", () => {
  const body = "[a](https://a) `code` and\n\n```\nfence\n```"
  const first = style(body)
  assert.equal(style(body), first)
  assert.equal(style(body), first)
})

// --- html notes (markup_language 2) -----------------------------------------

const htmlOf = h => Model.styleHtml(h, OPTS)

test("an html anchor gains the theme colour", () => {
  assert.equal(htmlOf('<a href="x">t</a>'),
    '<a href="x" style="color:#8bc9eb">t</a>')
})

test("an existing style attribute is appended to, not replaced", () => {
  assert.equal(htmlOf('<a href="x" style="font-weight:bold">t</a>'),
    '<a href="x" style="font-weight:bold;color:#8bc9eb">t</a>')
})

test("the panel colour wins over one the note carries", () => {
  // A clipped page's link colour is picked for a white background.
  const out = htmlOf("<a href='x' style='color:red;'>t</a>")
  assert.ok(out.endsWith("color:#8bc9eb'>t</a>"), out)
})

test("single-quoted attributes keep their quoting", () => {
  assert.ok(htmlOf("<a href='x'>t</a>").includes('style="color:#8bc9eb"'))
})

test("html code and pre are sized like the body text", () => {
  assert.equal(htmlOf("<code>x</code>"), '<code style="font-size:11px">x</code>')
  assert.equal(htmlOf('<pre class="c">y</pre>'), '<pre class="c" style="font-size:11px">y</pre>')
})

test("html with nothing to restyle is untouched", () => {
  assert.equal(htmlOf("<p>plain <b>text</b></p>"), "<p>plain <b>text</b></p>")
  assert.equal(Model.styleHtml("<a href='x'>t</a>", {}), "<a href='x'>t</a>")
  assert.equal(Model.styleHtml(null, OPTS), "")
})

test("an anchor closing tag is not mistaken for an opening one", () => {
  const out = htmlOf('<a href="x">t</a> and </a>')
  assert.equal((out.match(/style="color/g) || []).length, 1)
})

// --- block spacing ----------------------------------------------------------
// Qt gives every block the same gap as a line break, so a note's structure is
// invisible without an explicit spacer.

test("a blank line between two blocks becomes a visible spacer", () => {
  assert.equal(style("A paragraph.\n\nAnother one."),
    "A paragraph.\n\n&nbsp;\n\nAnother one.")
})

test("a blank line between list items is left alone", () => {
  // Splitting there would end the list and restart an ordered one at 1.
  assert.equal(style("- one\n\n- two"), "- one\n\n- two")
  assert.equal(style("1. one\n\n2. two"), "1. one\n\n2. two")
  assert.equal(style("* one\n\n* two"), "* one\n\n* two")
})

test("a list is still separated from the prose around it", () => {
  const out = style("Before.\n\n- one\n- two\n\nAfter.")
  assert.equal(out, "Before.\n\n&nbsp;\n\n- one\n- two\n\n&nbsp;\n\nAfter.")
})

test("whitespace-only lines count as blank", () => {
  // Joplin's editor writes these between list items.
  assert.equal(style("- one\n    \n- two"), "- one\n\n- two")
  assert.equal(style("Para.\n   \nOther."), "Para.\n\n&nbsp;\n\nOther.")
})

test("a run of blank lines collapses to a single spacer", () => {
  assert.equal(style("A.\n\n\n\nB."), "A.\n\n&nbsp;\n\nB.")
})

test("leading and trailing blank lines do not gain a spacer", () => {
  assert.equal(style("\n\nA paragraph.\n\n"), "\n\nA paragraph.\n\n")
})

test("a heading is separated from the paragraph under it", () => {
  assert.equal(style("## Heading\n\nText."), "## Heading\n\n&nbsp;\n\nText.")
})

test("blank lines inside a fenced block are not touched", () => {
  const out = style("```\nfirst\n\nsecond\n```")
  assert.ok(!out.includes("&nbsp;"), out)
})

test("spacing does not disturb an inline code span", () => {
  assert.equal(style("Use `a b` here."),
    'Use <code style="font-size:11px">a b</code> here.')
})
