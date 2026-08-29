import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const OPTS = { linkColor: "#8bc9eb", fontSizePx: 11, tableBorderColor: "#4d86b0" }
const style = (md, o) => Model.styleMarkdown(md, o === undefined ? OPTS : o)
const TABLE = "| Feature | Default |\n|---|---|\n| Auto-update | Enabled |"

test("a markdown table becomes an html table with a themed border", () => {
  // bordercolor is the only table styling Qt honours; CSS borders on cells are
  // dropped and the grid disappears entirely.
  const out = style(TABLE)
  assert.ok(out.includes('<table border="1" bordercolor="#4d86b0"'))
  assert.ok(out.includes("<th>Feature</th>"))
  assert.ok(out.includes("<td>Auto-update</td>"))
  assert.ok(!out.includes("|---|"))
})

test("alignment markers become align attributes", () => {
  const out = style("| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |")
  assert.ok(out.includes('<th align="left">a</th>'))
  assert.ok(out.includes('<th align="center">b</th>'))
  assert.ok(out.includes('<th align="right">c</th>'))
  assert.ok(out.includes('<td align="right">3</td>'))
})

test("cell markdown is rendered, because the importer stops parsing inside", () => {
  const out = style("| a | b |\n|---|---|\n| **bold** | *italic* |")
  assert.ok(out.includes("<b>bold</b>"))
  assert.ok(out.includes("<i>italic</i>"))
})

test("a link in a cell keeps the theme colour", () => {
  const out = style("| a |\n|---|\n| [docs](https://x) |")
  assert.ok(out.includes('<a href="https://x" style="color:#8bc9eb">docs</a>'))
})

test("a code span in a cell survives and is sized", () => {
  // The old walker split on inline code first and tore the row in half.
  const out = style("| setting | value |\n|---|---|\n| mode | `readonly` |")
  assert.ok(out.includes('<code style="font-size:11px">readonly</code>'))
  assert.ok(out.includes("<td>mode</td>"))
  assert.ok(out.split("<tr>").length === 3, out)
})

test("cell content is escaped so a note cannot inject markup", () => {
  const out = style("| a |\n|---|\n| <script>x</script> |")
  assert.ok(!out.includes("<script>"))
  assert.ok(out.includes("&lt;script&gt;"))
})

test("a table inside a fenced block stays literal", () => {
  const out = style("```\n| a | b |\n|---|---|\n```")
  assert.ok(!out.includes("<table"))
  assert.ok(out.includes("| a | b |"))
})

test("a line with a pipe but no delimiter row is not a table", () => {
  const out = style("costs 5 | 6 euros")
  assert.ok(!out.includes("<table"))
})

test("prose around a table is untouched and still spaced", () => {
  const out = style("Before.\n\n" + TABLE + "\n\nAfter.")
  assert.ok(out.startsWith("Before."))
  assert.ok(out.trimEnd().endsWith("After."))
  assert.ok(out.includes("&nbsp;"))
})

test("a table with ragged rows still renders every cell it has", () => {
  const out = style("| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |")
  assert.equal(out.split("<tr>").length - 1, 3)
})

test("without a border colour the table is left as markdown", () => {
  const out = style(TABLE, { linkColor: "#8bc9eb", fontSizePx: 11 })
  assert.ok(!out.includes("<table"))
  assert.ok(out.includes("|---|"))
})

test("two tables in one body are both converted", () => {
  const out = style(TABLE + "\n\nmiddle\n\n" + TABLE)
  assert.equal(out.split("<table").length - 1, 2)
})
