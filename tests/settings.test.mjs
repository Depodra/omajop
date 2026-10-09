import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Model from "../Model.mjs"

const HOME = "/home/x"
const ROOT = "/home/x/.config/joplin-desktop"
const WORK = { name: "Work", dir: ROOT }
const PERSONAL = { name: "Personal", dir: ROOT + "-alt1" }
const SPARE = { name: "Spare", dir: "/srv/notes" }

// --- editing the list ---------------------------------------------------------

test("profiles are added once, by directory, up to the cap", () => {
  const list = Model.addProfile([WORK], "/srv/notes/", "")
  assert.deepEqual(list, [WORK, { name: "notes", dir: "/srv/notes" }])
  assert.deepEqual(Model.addProfile(list, "/srv/notes", "Again"), list)
  assert.deepEqual(Model.addProfile(list, "  ", "Blank"), list)

  let full = []
  for (let i = 0; i < Model.MAX_PROFILES; i++) full = Model.addProfile(full, "/p" + i, "")
  assert.equal(Model.addProfile(full, "/one-more", "").length, Model.MAX_PROFILES)
})

test("removing a profile keeps the last one", () => {
  assert.deepEqual(Model.removeProfile([WORK, PERSONAL], 0), [PERSONAL])
  assert.deepEqual(Model.removeProfile([WORK], 0), [WORK])
  assert.deepEqual(Model.removeProfile([WORK, PERSONAL], 5), [WORK, PERSONAL])
})

test("renaming cleans the name, and a blank one falls back to the folder", () => {
  assert.deepEqual(Model.renameProfile([WORK, PERSONAL], 1, "  Home\n "),
    [WORK, { name: "Home", dir: PERSONAL.dir }])
  assert.deepEqual(Model.renameProfile([WORK], 0, ""), [{ name: "joplin-desktop", dir: ROOT }])
})

test("moving stops at either end", () => {
  assert.deepEqual(Model.moveProfile([WORK, PERSONAL, SPARE], 2, -1), [WORK, SPARE, PERSONAL])
  assert.deepEqual(Model.moveProfile([WORK, PERSONAL, SPARE], 0, 1), [PERSONAL, WORK, SPARE])
  assert.deepEqual(Model.moveProfile([WORK, PERSONAL], 0, -1), [WORK, PERSONAL])
  assert.deepEqual(Model.moveProfile([WORK, PERSONAL], 1, 1), [WORK, PERSONAL])
})

test("the edit helpers never change their input", () => {
  const list = [WORK, PERSONAL]
  Model.addProfile(list, "/srv/notes", "")
  Model.removeProfile(list, 0)
  Model.renameProfile(list, 0, "Changed")
  Model.moveProfile(list, 0, 1)
  assert.deepEqual(list, [WORK, PERSONAL])
})

test("indexOfProfile finds a profile by directory", () => {
  assert.equal(Model.indexOfProfile([WORK, PERSONAL], PERSONAL.dir), 1)
  assert.equal(Model.indexOfProfile([WORK, PERSONAL], "/gone"), -1)
  assert.equal(Model.indexOfProfile(null, ROOT), -1)
})

// --- saving -------------------------------------------------------------------

test("saved entries leave the default profile's path out and shorten the home", () => {
  assert.deepEqual(Model.profileEntries([WORK, PERSONAL, SPARE], HOME), [
    { name: "Work" },
    { name: "Personal", path: "~/.config/joplin-desktop-alt1" },
    { name: "Spare", path: "/srv/notes" }
  ])
  assert.equal(Model.contractHome("/home/xy/notes", HOME), "/home/xy/notes")
  assert.equal(Model.contractHome("/home/x", HOME), "~")
})

test("saved entries read back as the same profiles", () => {
  const list = [WORK, PERSONAL, SPARE, { name: "Odd", dir: "/home/x/My Notes" }]
  const saved = Model.profileEntries(list, HOME)
  assert.deepEqual(Model.normalizeProfiles(saved, "", HOME), list)
  // And through shell.json as text, which is how `omarchy bar set` stores it.
  assert.deepEqual(Model.normalizeProfiles(JSON.stringify(saved), "", HOME), list)
})

test("profileKind tells the four places a profile can live apart", () => {
  assert.equal(Model.profileKind(HOME, ROOT), Model.PROFILE_DEFAULT)
  assert.equal(Model.profileKind(HOME, ROOT + "/"), Model.PROFILE_DEFAULT)
  assert.equal(Model.profileKind(HOME, ROOT + "-alt1"), Model.PROFILE_INSTANCE)
  assert.equal(Model.profileKind(HOME, ROOT + "/profile-a1b2"), Model.PROFILE_IN_APP)
  assert.equal(Model.profileKind(HOME, ROOT + "-alt1/profile-a1b2"), Model.PROFILE_IN_APP)
  assert.equal(Model.profileKind(HOME, "/srv/notes"), Model.PROFILE_CUSTOM)
})

test("profileKindLabel says where a profile lives", () => {
  const label = dir => Model.profileKindLabel(Model.profileKind(HOME, dir), HOME, dir)
  assert.equal(label(ROOT), "Main instance")
  assert.equal(label(ROOT + "-alt1"), "Secondary instance alt1")
  assert.equal(label(ROOT + "/profile-a1b2"), "In-app profile")
  assert.equal(label("/srv/notes"), "Profile directory")
})

// --- accounts -----------------------------------------------------------------

test("accountSummary names the server and user a profile syncs to", () => {
  assert.deepEqual(Model.accountSummary({
    "sync.target": 9,
    "sync.9.path": "https://notes.example.com/",
    "sync.9.username": "me@example.com"
  }), { target: 9, label: "Joplin Server", location: "notes.example.com", user: "me@example.com" })

  // Joplin Cloud's path is its API endpoint, the same for everyone.
  assert.deepEqual(Model.accountSummary({
    "sync.target": 10,
    "sync.10.path": "https://api.joplincloud.com",
    "sync.10.username": "me@example.org"
  }), { target: 10, label: "Joplin Cloud", location: "", user: "me@example.org" })

  assert.equal(Model.accountSummary({ "sync.target": 2, "sync.2.path": "/mnt/sync" }).location, "/mnt/sync")
  assert.equal(Model.accountSummary({ "sync.target": 6, "sync.6.path": "https://u:p@dav.example.net/x" })
    .location, "dav.example.net")
  assert.equal(Model.accountSummary({ "sync.target": 42 }).label, "Sync target 42")
  for (const nothing of [{}, null, { "sync.target": 0 }, { "sync.target": "x" }]) {
    assert.equal(Model.accountSummary(nothing).label, "Not syncing")
  }
})

test("accountLine joins only what is known", () => {
  assert.equal(Model.accountLine({ label: "Joplin Server", location: "notes.example.com", user: "me" }),
    "Joplin Server  ·  notes.example.com  ·  me")
  assert.equal(Model.accountLine({ label: "Not syncing", location: "", user: "" }), "Not syncing")
})

// --- discovery ----------------------------------------------------------------

const SECRET = "tok_0123456789abcdef"

function settingsJson(target, path, user) {
  const values = { "sync.target": target, "api.token": SECRET, "sync.9.password": SECRET }
  if (path) values["sync." + target + ".path"] = path
  if (user) values["sync." + target + ".username"] = user
  return JSON.stringify(values)
}

test("parseDiscovery reads only the account fields, never secrets", () => {
  const text = "\x1eD\x1f" + ROOT + "\x1f1\x1f" + settingsJson(9, "https://notes.example.com", "me")
  const result = Model.parseDiscovery(text, HOME)
  assert.equal(result.found.length, 1)
  assert.ok(!JSON.stringify(result).includes(SECRET))
  assert.deepEqual(result.found[0].account,
    { target: 9, label: "Joplin Server", location: "notes.example.com", user: "me" })
})

test("parseDiscovery survives garbage", () => {
  for (const junk of ["", null, "\x1e", "\x1eD\x1f\x1f1\x1f{", "\x1eZ\x1f/a\x1f1\x1f{}", "\x1eD\x1f/a\x1f1\x1fnot json"]) {
    const result = Model.parseDiscovery(junk, HOME)
    assert.ok(Array.isArray(result.found))
  }
  const broken = Model.parseDiscovery("\x1eD\x1f/a\x1f1\x1fnot json", HOME)
  assert.equal(broken.found[0].account.label, "Not syncing")
})

test("suggestedProfileName prefers Joplin's name, then the server, then the folder", () => {
  const account = host => ({ target: 9, label: "Joplin Server", location: host, user: "" })
  assert.equal(Model.suggestedProfileName({ kind: Model.PROFILE_IN_APP, joplinName: "Travel",
    dir: ROOT + "/profile-a", account: account("notes.example.com") }), "Travel")
  assert.equal(Model.suggestedProfileName({ kind: Model.PROFILE_INSTANCE, joplinName: "Default",
    dir: ROOT + "-alt1", account: account("notes.mcewan.cloud") }), "mcewan.cloud")
  assert.equal(Model.suggestedProfileName({ kind: Model.PROFILE_CUSTOM, joplinName: "",
    dir: "/srv/notes", account: Model.accountSummary({}) }), "notes")
})

// The real script, run by sh against a throwaway home directory.
test("the discovery script finds instances, in-app profiles and configured directories", () => {
  const home = mkdtempSync(join(tmpdir(), "omajop-discover-"))
  try {
    const profile = (dir, settings) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "database.sqlite"), "")
      if (settings) writeFileSync(join(dir, "settings.json"), settings)
    }
    const root = join(home, ".config/joplin-desktop")
    profile(root, settingsJson(9, "https://work.example.com", "me@work"))
    writeFileSync(join(root, "profiles.json"), JSON.stringify({
      version: 1, currentProfileId: "default",
      profiles: [{ id: "default", name: "Default" }, { id: "trip1", name: "Travel" }]
    }))
    profile(join(root, "profile-trip1"), settingsJson(0))
    profile(join(home, ".config/joplin-desktop-alt1"), settingsJson(9, "https://home.example.org", "me@home"))
    // Not profiles: no database, or not a Joplin directory at all.
    mkdirSync(join(home, ".config/joplin-desktop-alt2"), { recursive: true })
    mkdirSync(join(home, ".config/joplin-desktop-cache"), { recursive: true })
    writeFileSync(join(home, ".config/joplin-desktop-notes.txt"), "")
    const custom = join(home, "elsewhere/notes")
    profile(custom, settingsJson(10, "", "me@cloud"))
    const missing = join(home, "gone")

    const argv = Model.discoveryArgv(home, [custom, missing])
    const output = execFileSync(argv[0], argv.slice(1), { encoding: "utf8" })
    assert.ok(output.includes(SECRET), "the raw output does carry the file")
    const result = Model.parseDiscovery(output, home)

    assert.ok(!JSON.stringify(result).includes(SECRET))
    assert.deepEqual(result.found.map(f => [f.dir.slice(home.length), f.kind]), [
      ["/.config/joplin-desktop", Model.PROFILE_DEFAULT],
      ["/.config/joplin-desktop/profile-trip1", Model.PROFILE_IN_APP],
      ["/.config/joplin-desktop-alt1", Model.PROFILE_INSTANCE],
      ["/elsewhere/notes", Model.PROFILE_CUSTOM]
    ])
    assert.equal(result.info[root].joplinName, "Default")
    assert.equal(result.info[join(root, "profile-trip1")].joplinName, "Travel")
    assert.equal(result.info[join(home, ".config/joplin-desktop-alt1")].account.location, "home.example.org")
    assert.equal(result.info[custom].account.label, "Joplin Cloud")
    // A configured directory without a database is reported, not found.
    assert.equal(result.info[missing].hasDatabase, false)
    assert.equal(result.found.some(f => f.dir === missing), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the discovery script never interpolates its arguments", () => {
  // Every value reaches the script as a positional argument.
  const argv = Model.discoveryArgv("/home/$(touch pwned)", ["/a b", "/c;d"])
  assert.equal(argv[2], Model.DISCOVERY_SCRIPT)
  assert.deepEqual(argv.slice(4), ["/home/$(touch pwned)", "/a b", "/c;d"])
  assert.ok(!Model.DISCOVERY_SCRIPT.includes("pwned"))
})
