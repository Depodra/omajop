import test from "node:test"
import assert from "node:assert/strict"
import * as Model from "../Model.mjs"

const HOME = "/home/x"
const ROOT = "/home/x/.config/joplin-desktop"
const ID = "56ee5ca340d44a7d85bde04c8da781f5"
const URL = "joplin://x-callback-url/openNote?id=" + ID

test("without a profiles list, profilePath names the only profile", () => {
  for (const missing of [undefined, null, "", [], "not json", {}, 42]) {
    assert.deepEqual(Model.normalizeProfiles(missing, "", HOME),
      [{ name: "joplin-desktop", dir: ROOT }])
  }
  assert.deepEqual(Model.normalizeProfiles(null, "~/alt/", HOME),
    [{ name: "alt", dir: "/home/x/alt" }])
})

test("a profiles list replaces profilePath", () => {
  const profiles = Model.normalizeProfiles([
    { name: "Work" },
    { name: "Personal", path: "~/.config/joplin-desktop-alt1" }
  ], "/ignored", HOME)
  assert.deepEqual(profiles, [
    { name: "Work", dir: ROOT },
    { name: "Personal", dir: "/home/x/.config/joplin-desktop-alt1" }
  ])
})

test("profile entries are cleaned up on the way in", () => {
  const profiles = Model.normalizeProfiles([
    "/srv/notes/",                                   // a bare path
    { name: "  Two\n lines  ", path: " ~/b " },
    { name: "Same dir again", path: "/srv/notes" },  // a duplicate directory
    { name: "x".repeat(80), path: "/c" },
    null,
    7,
    ["/d"]
  ], "", HOME)
  assert.deepEqual(profiles.map(p => p.dir), ["/srv/notes", "/home/x/b", "/c"])
  assert.deepEqual(profiles.map(p => p.name).slice(0, 2), ["notes", "Two lines"])
  assert.ok(profiles[2].name.length <= 40)
})

test("the profiles list may arrive as a JSON string", () => {
  // `omarchy bar set ... profiles '[...]'` without --json stores the text.
  assert.deepEqual(Model.normalizeProfiles('[{"name":"Work"},{"path":"/p"}]', "", HOME),
    [{ name: "Work", dir: ROOT }, { name: "p", dir: "/p" }])
})

test("the profile count is capped at what the digit keys can reach", () => {
  const many = []
  for (let i = 0; i < 20; i++) many.push("/p" + i)
  assert.equal(Model.normalizeProfiles(many, "", HOME).length, Model.MAX_PROFILES)
  assert.equal(Model.MAX_PROFILES, 9)
})

test("clampProfileIndex keeps the selection on a profile that exists", () => {
  assert.equal(Model.clampProfileIndex(0, 2), 0)
  assert.equal(Model.clampProfileIndex(1, 2), 1)
  assert.equal(Model.clampProfileIndex(5, 2), 1)
  assert.equal(Model.clampProfileIndex(-1, 2), 0)
  assert.equal(Model.clampProfileIndex(NaN, 2), 0)
  assert.equal(Model.clampProfileIndex(3, 0), 0)
})

test("a note in the default profile is opened through the registered URL scheme", () => {
  assert.deepEqual(Model.openArgv(HOME, ROOT, ID, ""), ["xdg-open", URL])
  assert.deepEqual(Model.openArgv(HOME, ROOT + "/", ID, ""), ["xdg-open", URL])
})

test("a secondary app instance is reached by its instance id", () => {
  // Joplin derives that instance's directory from the id, so passing the id
  // makes both sides compute the same profile path string.
  assert.deepEqual(Model.openArgv(HOME, ROOT + "-alt1", ID, ""),
    ["joplin-desktop", "--alt-instance-id", "alt1", URL])
  assert.deepEqual(Model.openArgv(HOME, ROOT + "-alt1", ID, "/opt/Joplin.AppImage"),
    ["/opt/Joplin.AppImage", "--alt-instance-id", "alt1", URL])
})

test("any other directory is reached with --profile, spelled as normalised", () => {
  assert.deepEqual(Model.openArgv(HOME, "/srv/notes", ID, ""),
    ["joplin-desktop", "--profile", "/srv/notes", URL])
  // Not an instance id: it would name a directory below the default root's sibling.
  assert.deepEqual(Model.openArgv(HOME, ROOT + "-alt1/nested", ID, ""),
    ["joplin-desktop", "--profile", ROOT + "-alt1/nested", URL])
  assert.deepEqual(Model.openArgv(HOME, ROOT + "-", ID, ""),
    ["joplin-desktop", "--profile", ROOT + "-", URL])
})

test("a profile switched to inside the app cannot be targeted", () => {
  const dir = ROOT + "/profile-a1b2c3"
  assert.deepEqual(Model.openArgv(HOME, dir, ID, ""), [])
  assert.match(Model.openTarget(HOME, dir, "").reason, /Switch profile/)
  assert.equal(Model.openTarget(HOME, ROOT, "").reason, "")
})

test("openArgv refuses a malformed note id", () => {
  assert.deepEqual(Model.openArgv(HOME, ROOT, "nope", ""), [])
  assert.deepEqual(Model.openArgv(HOME, "/srv/notes", "", ""), [])
})

test("joplinExecutable falls back to joplin-desktop", () => {
  assert.equal(Model.joplinExecutable(""), "joplin-desktop")
  assert.equal(Model.joplinExecutable("  "), "joplin-desktop")
  assert.equal(Model.joplinExecutable(null), "joplin-desktop")
  assert.equal(Model.joplinExecutable(" /opt/joplin "), "/opt/joplin")
})

test("launchArgv starts or focuses a profile's Joplin without a note", () => {
  assert.deepEqual(Model.launchArgv(HOME, ROOT, ""), ["joplin-desktop"])
  assert.deepEqual(Model.launchArgv(HOME, ROOT + "-alt1", "/opt/joplin"),
    ["/opt/joplin", "--alt-instance-id", "alt1"])
  assert.deepEqual(Model.launchArgv(HOME, "/srv/notes", ""), ["joplin-desktop", "--profile", "/srv/notes"])
  assert.deepEqual(Model.launchArgv(HOME, ROOT + "/profile-a1", ""), [])
})
