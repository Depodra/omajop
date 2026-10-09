import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import * as Model from "../Model.mjs"

// Run the widget's actual JavaScript handlers with controlled process results.
// No desktop session or user's Joplin profile is needed.
const qml = readFileSync(new URL("../BarWidget.qml", import.meta.url), "utf8")
const id = "a".repeat(32)
const otherId = "b".repeat(32)
function widget() {
  const state = vm.createContext({
    Model, bodyReadPending: false, bodyNoteId: id, bodyText: "Before sync",
    bodyError: "", bodyEncrypted: false, bodyTruncated: false,
    bodyMarkup: Model.MARKUP_MARKDOWN, ready: true, databasePath: "/test.sqlite",
    bodyProcess: { running: false }, bodyStdout: { text: "" },
    bodyStderr: { text: "" }, foldersStdout: { text: "[]" },
    notesStdout: { text: JSON.stringify([{ id }]) }, tagsStdout: { text: "[]" },
    dbState: "ready", loadError: "", tagIndex: {},
    setData() {}, failLoad(detail) { throw Error(detail) },
    passDatabasePath: "/test.sqlite", bodyDatabasePath: "", searchDatabasePath: "",
    queryTimedOut: false, schemaNotice: "", resourceMap: {}, bodyMatchIds: {},
    searchStdout: { text: "" }, searchDebounce: { stop() {} },
    // Qt.callLater is how a stale pass asks for a fresh one; record the asks.
    laterCalls: [], root: { refresh: "refresh" },
  })
  state.Qt = { callLater(fn) { state.laterCalls.push(fn) } }
  for (const name of ["loadBody", "startBodyRead", "finishBody", "finishTags",
    "abandonStalePass", "resetForProfile", "finishSearch"]) {
    const source = qml.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))
    if (!source && name === "startBodyRead") continue
    assert.ok(source, `widget handler ${name} exists`)
    vm.runInContext(source[0], state)
  }
  return state
}
function finish(state, body, exitCode = 0) {
  state.bodyProcess.running = false
  state.bodyStdout.text = JSON.stringify([{ body }])
  state.finishBody(exitCode)
}

test("successful refresh updates the selected note without changing selection", () => {
  const state = widget()
  state.finishTags(0)
  assert.equal(state.bodyProcess.running, true)
  assert.equal(state.bodyText, "Before sync")
  finish(state, "After sync")
  assert.equal(state.bodyText, "After sync")
  assert.equal(state.bodyNoteId, id)
})

test("reselecting the same note still uses the cache", () => {
  const state = widget()
  state.loadBody(id)
  assert.equal(state.bodyProcess.running, false)
})

test("refresh during a body read queues a fresh read and discards the old result", () => {
  const state = widget()
  state.loadBody(id, true)
  state.finishTags(0)
  finish(state, "Stale in-flight result")
  assert.equal(state.bodyText, "Before sync")
  assert.equal(state.bodyProcess.running, true)
  finish(state, "After sync")
  assert.equal(state.bodyText, "After sync")
})

test("selection changes during refresh cannot display the previous note's body", () => {
  const state = widget()
  state.finishTags(0)
  state.loadBody(otherId)
  finish(state, "Wrong note")
  assert.equal(state.bodyText, "")
  assert.equal(state.bodyProcess.running, true)
  assert.ok(state.bodyProcess.command.at(-1).includes(otherId))
  finish(state, "Selected note")
  assert.equal(state.bodyText, "Selected note")
})

test("clearing the selection discards an in-flight result", () => {
  const state = widget()
  state.finishTags(0)
  state.loadBody("")
  finish(state, "Wrong note")
  assert.equal(state.bodyText, "")
  assert.equal(state.bodyProcess.running, false)
})

test("a failed body read can be retried by refreshing the same note", () => {
  const state = widget()
  state.finishTags(0)
  finish(state, "", 1)
  assert.notEqual(state.bodyError, "")
  state.finishTags(0)
  finish(state, "Recovered")
  assert.equal(state.bodyError, "")
  assert.equal(state.bodyText, "Recovered")
})

// Switching profile changes databasePath while reads against the old one are
// still in flight. The widget's own reset runs first, as onProfileDirChanged does.
function switchProfile(state, path = "/other.sqlite") {
  state.databasePath = path
  state.resetForProfile()
}

test("a load pass that started on another profile is dropped and restarted", () => {
  const state = widget()
  let loaded = 0
  state.setData = () => { loaded++ }
  switchProfile(state)
  loaded = 0
  state.laterCalls.length = 0
  state.finishTags(0)
  assert.equal(loaded, 0)
  assert.deepEqual(state.laterCalls, ["refresh"])
})

test("a pass on the current profile is not abandoned", () => {
  const state = widget()
  state.finishTags(0)
  assert.deepEqual(state.laterCalls, [])
})

test("a body read from the previous profile cannot paint over the new one", () => {
  const state = widget()
  state.loadBody(id, true)
  assert.equal(state.bodyDatabasePath, "/test.sqlite")
  switchProfile(state)
  finish(state, "From the old profile")
  assert.equal(state.bodyText, "")
  assert.equal(state.bodyNoteId, "")
  assert.equal(state.bodyProcess.running, false)
})

test("a note picked in the new profile is read from the new database", () => {
  const state = widget()
  state.loadBody(id, true)
  switchProfile(state)
  state.loadBody(otherId)
  finish(state, "From the old profile")
  assert.equal(state.bodyText, "")
  assert.equal(state.bodyProcess.running, true)
  assert.equal(state.bodyProcess.command[5], "/other.sqlite")
  finish(state, "From the new profile")
  assert.equal(state.bodyText, "From the new profile")
})

test("body matches from the previous profile's index are ignored", () => {
  const state = widget()
  state.searchDatabasePath = "/test.sqlite"
  switchProfile(state)
  state.searchStdout.text = JSON.stringify([{ id }])
  state.finishSearch(0)
  // The vm context has its own Object, so compare contents, not prototypes.
  assert.deepEqual(Object.keys(state.bodyMatchIds), [])
})

test("a profile with no database does not leave its error on the next one", () => {
  const state = widget()
  state.dbState = "no-database"
  state.loadError = "No Joplin database at /test.sqlite"
  switchProfile(state)
  assert.equal(state.dbState, "checking")
  assert.equal(state.loadError, "")
})

// The settings view saves through the widget's own save functions.
function settingsWidget(profiles, browsed) {
  const saved = []
  const state = vm.createContext({
    Model, Quickshell: { env: () => "/home/x" },
    profileDir: browsed, activeProfileDir: "", canSaveSettings: true,
    root: { moduleName: "io.github.renerocksai.omajop", settings: { id: "x", sortBy: "title" } },
    bar: { shell: { updateEntryInline(id, entry) { saved.push(entry) } } },
  })
  for (const name of ["saveSettings", "saveProfiles"]) {
    const source = qml.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))
    assert.ok(source, `widget handler ${name} exists`)
    vm.runInContext(source[0], state)
  }
  return { state, saved }
}

test("editing the list pins the profile on screen", () => {
  // Nothing picked yet: the first profile is browsed only because it is first.
  const work = { name: "Work", dir: "/home/x/.config/joplin-desktop" }
  const home = { name: "Home", dir: "/home/x/.config/joplin-desktop-alt1" }
  const { state, saved } = settingsWidget([work, home], work.dir)
  state.saveProfiles([home, work])
  assert.equal(state.activeProfileDir, work.dir)
  assert.equal(saved.length, 1)
})

test("saving keeps every other setting and writes a real array", () => {
  const { state, saved } = settingsWidget([], "/home/x/.config/joplin-desktop")
  state.saveProfiles([{ name: "Work", dir: "/home/x/.config/joplin-desktop" },
    { name: "Home", dir: "/home/x/.config/joplin-desktop-alt1" }])
  const entry = JSON.parse(JSON.stringify(saved[0]))
  assert.deepEqual(entry, {
    id: "io.github.renerocksai.omajop",
    sortBy: "title",
    profiles: [{ name: "Work" }, { name: "Home", path: "~/.config/joplin-desktop-alt1" }]
  })
  assert.equal(state.root.settings, saved[0])
})

test("Joplin started from a profile's page skips the welcome notebook until it has a database", () => {
  const launched = []
  const state = vm.createContext({
    Model, joplinCommand: "",
    Quickshell: { env: () => "/home/x", execDetached(argv) { launched.push(argv) } },
    discovery: { info: {
      "/home/x/.config/joplin-desktop-alt1": { hasDatabase: false },
      "/home/x/.config/joplin-desktop": { hasDatabase: true }
    } },
  })
  vm.runInContext(qml.match(/  function launchJoplin\([^]*?\n  }/)[0], state)
  state.launchJoplin("/home/x/.config/joplin-desktop-alt1")
  state.launchJoplin("/home/x/.config/joplin-desktop")
  assert.deepEqual(JSON.parse(JSON.stringify(launched)), [
    ["joplin-desktop", "--alt-instance-id", "alt1", "--no-welcome"],
    ["joplin-desktop"]
  ])
})

const settingsQml = readFileSync(new URL("../ProfileSettings.qml", import.meta.url), "utf8")

test("leaving a profile's page with Back keeps a name that was typed", () => {
  const saved = []
  const work = { name: "Work", dir: "/w" }
  const state = vm.createContext({
    Model, mode: "edit", editIndex: 0, cursor: 0, profiles: [work], editing: work,
    nameField: { text: "Room40" },
    save(list) { saved.push(list) }, returnFocus() {},
  })
  for (const name of ["showList", "rename"]) {
    vm.runInContext(settingsQml.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0], state)
  }
  state.showList()
  assert.equal(state.mode, "list")
  assert.equal(saved.length, 1)
  assert.equal(saved[0][0].name, "Room40")
})
