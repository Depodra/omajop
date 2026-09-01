import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const PROFILE = "/home/x/.config/joplin-desktop"
const OPTS = { linkColor: "#8bc9eb", fontSizePx: 11, profileDir: PROFILE }
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
  const out = style('[x](https://a/"><b>)')
  assert.ok(!out.includes('"><b>'))
  assert.ok(out.includes("&quot;") && out.includes("&lt;"))
})

test("a url that carries an embed loses it outright, not merely escaped", () => {
  // Escaping alone would leave the text in the document; the element is gone.
  const out = style('[x](https://a/"><script>)')
  assert.ok(!out.includes("script"), out)
  assert.ok(out.includes("&quot;"), out)
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
  assert.equal(htmlOf('<a href="https://example.com/x">t</a>'),
    '<a href="https://example.com/x" style="color:#8bc9eb">t</a>')
})

test("an existing style attribute is appended to, not replaced", () => {
  assert.equal(htmlOf('<a href="https://example.com/x" style="font-weight:bold">t</a>'),
    '<a href="https://example.com/x" style="font-weight:bold;color:#8bc9eb">t</a>')
})

test("the panel colour wins over one the note carries", () => {
  // A clipped page's link colour is picked for a white background.
  const out = htmlOf("<a href='https://example.com/x' style='color:red;'>t</a>")
  assert.ok(out.endsWith('color:#8bc9eb">t</a>'), out)
})

test("attribute values are re-emitted double-quoted", () => {
  // Sanitising rewrites every attribute it keeps, so quoting is normalised.
  assert.ok(htmlOf("<a href='https://example.com/x'>t</a>").includes('style="color:#8bc9eb"'))
})

test("html code and pre are sized like the body text", () => {
  assert.equal(htmlOf("<code>x</code>"), '<code style="font-size:11px">x</code>')
  // class is dropped: it only means something with a stylesheet, and <style>
  // does not survive sanitising, so it cannot affect rendering either way.
  assert.equal(htmlOf('<pre class="c">y</pre>'), '<pre style="font-size:11px">y</pre>')
})

test("html with nothing to restyle keeps its markup", () => {
  assert.equal(htmlOf("<p>plain <b>text</b></p>"), "<p>plain <b>text</b></p>")
  // With no options there is no colour to add, but a scheme-less href is still
  // not something the panel will open, so it does not survive.
  assert.equal(Model.styleHtml("<a href='x'>t</a>", {}), "<a>t</a>")
  assert.equal(Model.styleHtml(null, OPTS), "")
})

test("an anchor closing tag is not mistaken for an opening one", () => {
  const out = htmlOf('<a href="https://example.com/x">t</a> and </a>')
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

// --- html sanitising --------------------------------------------------------
// A stored HTML note is rendered as RichText, and Qt fetches what that HTML
// references while laying it out. Nothing below is about how a note looks; it
// is about what a note body can reach.

const clean = h => Model.styleHtml(h, OPTS)

test("an image pointing outside the note is not loaded", () => {
  // The load is implicit: nobody has to click for Qt to fetch this.
  assert.equal(clean('<p>a<img src="https://evil.example/t.png">b</p>'), "<p>ab</p>")
  assert.equal(clean('<img src="file:///etc/passwd">'), "")
  assert.equal(clean('<img srcset="https://evil.example/1x.png 1x">'), "")
  // Joplin's own attachments never reach here: splitBody lifted them out into
  // image segments before any of this ran.
})

test("an image keeps its alt text, which is what the reader was meant to get", () => {
  assert.equal(clean('<img src="https://evil.example/t.png" alt="A diagram">'), "A diagram")
})

test("elements whose content is not text are dropped whole", () => {
  assert.equal(clean('<p>a</p><script>fetch("https://evil.example")</script><p>b</p>'),
    "<p>a</p><p>b</p>")
  assert.equal(clean('<style>body{background:url(https://evil.example/x)}</style><p>a</p>'),
    "<p>a</p>")
  for (const html of [
    '<iframe src="https://evil.example"></iframe>',
    '<object data="https://evil.example"></object>',
    '<embed src="https://evil.example">',
    '<video src="https://evil.example/v.mp4"></video>',
    '<audio src="https://evil.example/a.mp3"></audio>',
    '<svg><image href="https://evil.example/x"/></svg>'
  ]) {
    assert.equal(clean(html), "", html + " must not survive")
  }
})

test("an unclosed embed does not leave its opening tag behind", () => {
  // The text inside is inert once the element is gone: it renders as text.
  const out = clean('<p>a</p><script>fetch("x")')
  assert.ok(!out.includes("<script"))
  assert.ok(out.includes("<p>a</p>"))
})

test("event handler attributes do not survive", () => {
  assert.equal(clean('<b onerror="fetch(1)" onclick="x()">bold</b>'), "<b>bold</b>")
})

test("a style declaration that fetches or evaluates is dropped", () => {
  // url() is the implicit-load vector inside a style attribute.
  assert.equal(clean('<div style="background:url(https://evil.example/x);color:red">d</div>'),
    '<div style="color:red">d</div>')
  assert.equal(clean('<div style="width:expression(alert(1))">d</div>'), "<div>d</div>")
})

test("an anchor keeps only an href the panel would open", () => {
  assert.ok(!clean('<a href="javascript:alert(1)">c</a>').includes("javascript"))
  assert.ok(!clean('<a href="https://real.example@evil.example/">c</a>').includes("evil"))
  assert.ok(clean('<a href="https://example.com/a">c</a>').includes('href="https://example.com/a"'))
  // The text stays either way; only the destination goes.
  assert.ok(clean('<a href="javascript:alert(1)">c</a>').includes("c"))
})

test("href is only honoured on an anchor", () => {
  assert.ok(!clean('<div href="https://example.com/a">d</div>').includes("href"))
})

test("a tag hidden in a comment does not come back", () => {
  assert.equal(clean('<!-- <img src="https://evil.example/x"> --><p>a</p>'), "<p>a</p>")
})

test("a tag smuggled inside an attribute value does not survive", () => {
  const out = clean('<a title="x><img src=https://evil.example/y">t</a>')
  assert.ok(!out.includes("evil.example"), out)
  assert.ok(!out.includes("<img"), out)
})

test("ordinary formatting and tables are left intact", () => {
  assert.equal(clean("<p>plain <b>text</b></p>"), "<p>plain <b>text</b></p>")
  assert.equal(clean('<table><tr><td align="left">c</td></tr></table>'),
    '<table><tr><td align="left">c</td></tr></table>')
  assert.equal(clean("<ul><li>one</li><li>two</li></ul>"), "<ul><li>one</li><li>two</li></ul>")
  assert.equal(clean("<h2>Heading</h2><blockquote>q</blockquote>"),
    "<h2>Heading</h2><blockquote>q</blockquote>")
})

test("sanitizeHtml is reached through styleHtml, not only on its own", () => {
  // styleHtml is the single way an HTML note becomes a Text, so the sanitising
  // cannot be skipped by calling the styling entry point instead.
  assert.ok(!Model.styleHtml('<img src="https://evil.example/x">', OPTS).includes("evil"))
  assert.ok(!Model.styleHtml('<script>x</script>', {}).includes("script"))
})

// --- embeds in a markdown note ----------------------------------------------
// Qt's Markdown importer honours inline HTML — the anchor and code rewriting
// above depends on that — so a Markdown note can carry an embed exactly as a
// stored HTML note can.

test("a raw img in markdown prose is not loaded", () => {
  assert.equal(style('text <img src="https://evil.example/x"> more'), "text  more")
  assert.ok(!style('<img src="file:///etc/passwd">').includes("passwd"))
})

test("an embed element in markdown prose is dropped whole", () => {
  assert.ok(!style('a<script>fetch("https://evil.example")</script>b').includes("evil"))
  assert.ok(!style('<iframe src="https://evil.example"></iframe>').includes("iframe"))
})

test("a loading or handler attribute is stripped, the element is kept", () => {
  // The tag itself is ordinary formatting and the note meant it.
  assert.equal(style('<b onclick="x()">bold</b>'), "<b>bold</b>")
  assert.equal(style('<span style="background:url(https://evil.example/x)">s</span>'),
    "<span>s</span>")
})

test("html shown as code is displayed, not neutralised", () => {
  // This is the case that separates displaying markup from interpreting it: a
  // note about HTML must still be able to show an img tag.
  const inline = style("code: `<img src=https://evil.example/x>` shown")
  assert.ok(inline.includes("&lt;img src=https://evil.example/x&gt;"), inline)

  const fenced = style("```\n<img src=https://evil.example/x>\n```")
  assert.ok(fenced.includes("&lt;img src=https://evil.example/x&gt;"), fenced)
})

test("neutralizeEmbeds leaves ordinary prose and autolinks alone", () => {
  assert.equal(Model.neutralizeEmbeds("5 < 10 and 20 > 3"), "5 < 10 and 20 > 3")
  assert.equal(Model.neutralizeEmbeds("<https://example.com>"), "<https://example.com>")
  assert.equal(Model.neutralizeEmbeds("<b>bold</b>"), "<b>bold</b>")
  assert.equal(Model.neutralizeEmbeds(null), "")
})
