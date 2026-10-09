import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// omajop — a Joplin notes browser in the bar.
//
// Notes are read straight out of the desktop app's SQLite profile, read-only,
// via the sqlite3 CLI. That is deliberate: the Joplin Data API would only
// answer while the desktop app is running, and a bar widget outlives it. The
// database is never written to — Joplin tracks changes across item_changes,
// sync_items, and deleted_items, so a direct write would desync the profile.
// "Open in Joplin" hands the note to the desktop app instead.
BarWidget {
  id: root
  moduleName: "io.github.renerocksai.omajop"

  // null lets the model own every default, so they are declared in one place.
  readonly property string profilePath: Model.normalizeProfilePath(setting("profilePath", null))
  readonly property string sortBy: Model.normalizeSortBy(setting("sortBy", null))
  readonly property int refreshSeconds: Model.normalizeRefreshSeconds(setting("refreshSeconds", null))
  readonly property string joplinCommand: Model.normalizeJoplinCommand(setting("joplinCommand", null))

  // [{name, dir}]. Without a `profiles` setting this is profilePath alone.
  readonly property var profiles: Model.normalizeProfiles(
    setting("profiles", null), profilePath, Quickshell.env("HOME"))
  readonly property bool multipleProfiles: profiles.length > 1
  // Which profile is browsed, by directory, so reordering or renaming the list
  // never changes what is on screen; one that is removed falls back to the
  // first. Not persisted: the first one is the default.
  property string activeProfileDir: ""
  readonly property int profileIndex: Math.max(0, Model.indexOfProfile(profiles, activeProfileDir))
  readonly property string profileName: profiles[profileIndex].name

  readonly property string profileDir: profiles[profileIndex].dir
  readonly property string databasePath: Model.databasePath(Quickshell.env("HOME"), profileDir)
  // Why "Open in Joplin" cannot reach this profile, or "" when it can.
  readonly property string openBlockedReason:
    Model.openTarget(Quickshell.env("HOME"), profileDir, joplinCommand).reason

  // The database the running load pass, body read, and search were started
  // against. Each step reads these rather than databasePath, so a profile
  // switch mid-pass cannot mix two databases; a stale pass is dropped when it
  // lands and a fresh one started.
  property string passDatabasePath: ""
  property string bodyDatabasePath: ""
  property string searchDatabasePath: ""

  // "checking" | "no-sqlite" | "no-database" | "ready"
  property string dbState: "checking"
  property string loadError: ""
  // Set by a watchdog when it stops a query, read once by failLoad.
  property bool queryTimedOut: false
  property string schemaNotice: ""
  property var folderRows: []
  property var noteRows: []
  property var folderTree: []
  // id -> {mime, extension, title}, used to resolve `:/<id>` refs in a body.
  property var resourceMap: ({})
  // { tags, notesByTag, tagsByNote } — see Model.buildTagIndex.
  property var tagIndex: Model.emptyTagIndex()

  // Ids whose *body* matched the current filter, from Joplin's FTS index.
  // Titles are matched locally and instantly; this widens that result.
  property string searchQuery: ""
  property var bodyMatchIds: ({})
  property date now: new Date()

  // Body of the currently previewed note, fetched on demand.
  property bool bodyReadPending: false
  property string bodyNoteId: ""
  property string bodyText: ""
  property int bodyMarkup: Model.MARKUP_MARKDOWN
  property bool bodyEncrypted: false
  property bool bodyTruncated: false
  property string bodyError: ""
  readonly property bool bodyLoading: bodyProcess.running

  // Qt's Markdown renderer will not paint file:// images, so image references
  // are lifted out of the body and handed to the panel as separate segments.
  readonly property var bodySegments: Model.splitBody(bodyText, resourceMap, profileDir)

  readonly property bool loading: foldersProcess.running || notesProcess.running
    || resourcesProcess.running || tagsProcess.running || schemaProcess.running
  readonly property int noteCount: noteRows ? noteRows.length : 0
  // Notes that synced in before their master key was available.
  readonly property int encryptedCount: Model.countEncrypted(noteRows)
  readonly property bool ready: dbState === "ready"

  // --- data loading ---------------------------------------------------------
  // sqlite3 is located once; refreshes reuse the cached result until a failure
  // sends us back through the check.

  function refresh() {
    if (loading) return
    // A fresh pass starts without the previous one's timeout.
    queryTimedOut = false
    passDatabasePath = databasePath
    if (dbState === "ready") {
      loadSchema()
      return
    }
    sqliteCheckProcess.running = true
  }

  // A pass that began on another profile is abandoned at its next step, and a
  // pass for the current one started in its place.
  function abandonStalePass() {
    if (passDatabasePath === databasePath) return false
    queryTimedOut = false
    Qt.callLater(root.refresh)
    return true
  }

  function finishSqliteCheck(exitCode) {
    if (abandonStalePass()) return
    if (exitCode !== 0 || String(sqliteCheckStdout.text || "").trim() === "") {
      dbState = "no-sqlite"
      loadError = "sqlite3 was not found on PATH."
      setData([], [])
      return
    }
    loadSchema()
  }

  function loadSchema() {
    schemaProcess.command = Model.sqliteArgv(passDatabasePath, Model.schemaSql())
    schemaProcess.running = true
  }

  function finishSchema(exitCode) {
    if (abandonStalePass()) return
    if (exitCode !== 0) {
      // The most common cause by far is that Joplin has never run here.
      dbState = "no-database"
      loadError = "No Joplin database at " + passDatabasePath
      schemaNotice = ""
      setData([], [])
      return
    }
    schemaNotice = ""
    try {
      var rows = Model.parseRows(schemaStdout.text || "")
      if (rows.length > 0) schemaNotice = Model.schemaWarning(rows[0].version)
    } catch (error) {
      // The schema probe is advisory; a failure here must not block the notes.
    }
    foldersProcess.command = Model.sqliteArgv(passDatabasePath, Model.foldersSql())
    foldersProcess.running = true
  }

  function finishFolders(exitCode) {
    if (abandonStalePass()) return
    if (exitCode !== 0) {
      failLoad(String(foldersStderr.text || "").trim(), "Could not read folders.")
      return
    }
    notesProcess.command = Model.sqliteArgv(passDatabasePath, Model.notesSql(sortBy))
    notesProcess.running = true
  }

  function finishNotes(exitCode) {
    if (abandonStalePass()) return
    if (exitCode !== 0) {
      failLoad(String(notesStderr.text || "").trim(), "Could not read notes.")
      return
    }
    resourcesProcess.command = Model.sqliteArgv(passDatabasePath, Model.resourcesSql())
    resourcesProcess.running = true
  }

  function finishResources(exitCode) {
    if (abandonStalePass()) return
    // Attachments are decorative: a failure here must not cost the notes.
    resourceMap = ({})
    if (exitCode === 0) {
      try {
        resourceMap = Model.buildResourceMap(Model.parseRows(resourcesStdout.text || ""))
      } catch (error) {
        // Leave the map empty; bodies still render, without their images.
      }
    }
    tagsProcess.command = Model.sqliteArgv(passDatabasePath, Model.tagsSql())
    tagsProcess.running = true
  }

  function finishTags(exitCode) {
    if (abandonStalePass()) return
    try {
      var folders = Model.parseRows(foldersStdout.text || "")
      var notes = Model.parseRows(notesStdout.text || "")
      // Tags are supplementary; without them the folder list still works.
      var tagRows = exitCode === 0 ? Model.parseRows(tagsStdout.text || "") : []
      dbState = "ready"
      loadError = ""
      tagIndex = Model.buildTagIndex(tagRows, notes)
      setData(folders, notes)
      // The selection can survive a sync, but its cached body cannot.
      if (bodyNoteId !== "") loadBody(bodyNoteId, true)
    } catch (error) {
      failLoad(String(error), "The database returned unusable output.")
    }
  }

  function failLoad(detail, fallback) {
    tagIndex = Model.emptyTagIndex()
    dbState = "ready"
    // A killed process exits non-zero with nothing on stderr, so without this
    // a timeout would surface as the generic "could not read" fallback.
    loadError = queryTimedOut
      ? "A database read took longer than "
        + Math.round(Model.QUERY_TIMEOUT_MS / 1000) + "s and was stopped."
      : (detail !== ""
        ? Model.truncate(Model.plainLine(detail), 320)
        : fallback)
    queryTimedOut = false
    setData([], [])
  }

  function setData(folders, notes) {
    folderRows = folders
    noteRows = notes
    folderTree = Model.buildFolderTree(folders, notes)
  }

  // --- note body ------------------------------------------------------------

  function loadBody(id, force) {
    var noteId = String(id || "")
    if (noteId === bodyNoteId && !force) return
    // Keep the preview visible during a refresh of the same note.
    if (noteId !== bodyNoteId) {
      bodyText = ""
      bodyEncrypted = false
      bodyTruncated = false
    }
    bodyNoteId = noteId
    bodyError = ""
    bodyReadPending = true
    // Serialize reads: a refresh or selection change during a query must not
    // let its old result overwrite the latest selection.
    if (!bodyProcess.running) startBodyRead()
  }

  function startBodyRead() {
    bodyReadPending = false
    var noteId = bodyNoteId
    if (noteId === "" || !ready) return

    var sql
    try {
      sql = Model.noteBodySql(noteId)
    } catch (error) {
      bodyError = "Refusing to load a note with a malformed id."
      return
    }
    bodyDatabasePath = databasePath
    bodyProcess.command = Model.sqliteArgv(bodyDatabasePath, sql)
    bodyProcess.running = true
  }

  function finishBody(exitCode) {
    if (bodyReadPending) {
      startBodyRead()
      return
    }
    // A read from the profile switched away from must not paint over this one.
    if (bodyDatabasePath !== databasePath) return
    if (exitCode !== 0) {
      bodyError = Model.truncate(Model.plainLine(String(bodyStderr.text || "").trim()), 200)
        || "Could not read this note."
      return
    }
    try {
      var rows = Model.parseRows(bodyStdout.text || "")
      if (rows.length === 0) {
        bodyError = "This note is no longer in the database."
        return
      }
      bodyEncrypted = Model.isEncrypted(rows[0])
      bodyTruncated = Model.bodyTruncated(rows[0])
      bodyMarkup = Model.markupOf(rows[0])
      bodyText = bodyEncrypted ? "" : String(rows[0].body || "")
    } catch (error) {
      bodyError = "This note's contents could not be parsed."
    }
  }

  // --- full-text search -----------------------------------------------------

  function setSearchQuery(text) {
    var next = String(text || "")
    if (next === searchQuery) return
    searchQuery = next
    if (Model.ftsMatchExpression(searchQuery) === "") {
      searchDebounce.stop()
      bodyMatchIds = ({})
      return
    }
    // Typing should not spawn a subprocess per keystroke.
    searchDebounce.restart()
  }

  function runSearch() {
    if (dbState !== "ready") return
    var expression = Model.ftsMatchExpression(searchQuery)
    if (expression === "") {
      bodyMatchIds = ({})
      return
    }
    // A query is already in flight; come back once it has landed.
    if (searchProcess.running) {
      searchDebounce.restart()
      return
    }
    searchDatabasePath = databasePath
    searchProcess.command = Model.sqliteArgv(searchDatabasePath, Model.searchSql(expression))
    searchProcess.running = true
  }

  function finishSearch(exitCode) {
    // Ids from another profile's index would match nothing here, or the wrong note.
    if (searchDatabasePath !== databasePath) return
    // A profile whose schema predates notes_fts, or any other failure, simply
    // leaves the filter matching titles only.
    if (exitCode !== 0) {
      bodyMatchIds = ({})
      return
    }
    try {
      bodyMatchIds = Model.idSet(Model.parseRows(searchStdout.text || ""))
    } catch (error) {
      bodyMatchIds = ({})
    }
  }

  // The note goes to the Joplin instance that owns this profile; see
  // Model.openTarget for how each kind of profile is reached.
  function openInJoplin(id) {
    var argv = Model.openArgv(Quickshell.env("HOME"), profileDir, id, joplinCommand)
    if (argv.length === 0) return
    Quickshell.execDetached(argv)
  }

  // --- profiles -------------------------------------------------------------

  function selectProfile(index) {
    activeProfileDir = profiles[Model.clampProfileIndex(index, profiles.length)].dir
  }

  function cycleProfile(delta) {
    if (profiles.length < 2) return
    selectProfile((profileIndex + delta + profiles.length) % profiles.length)
  }

  // Everything held here came from the previous profile's database. Also
  // reached when a settings edit moves the browsed profile.
  function resetForProfile() {
    searchDebounce.stop()
    bodyMatchIds = ({})
    bodyReadPending = false
    bodyNoteId = ""
    bodyText = ""
    bodyEncrypted = false
    bodyTruncated = false
    bodyError = ""
    resourceMap = ({})
    tagIndex = Model.emptyTagIndex()
    schemaNotice = ""
    loadError = ""
    // "No database" described the old profile; "ready" and "no-sqlite" do not.
    if (dbState === "no-database") dbState = "checking"
    setData([], [])
    Qt.callLater(root.refresh)
  }

  onProfileDirChanged: resetForProfile()

  // --- settings -------------------------------------------------------------
  // The settings view edits the profile list and joplinCommand. Saving copies
  // every existing key, applies it locally so the panel updates on the click,
  // and writes the widget's shell.json entry through the scoped facade the
  // shell hands a plugin for its own entry; the write comes back through the
  // bar as the same value.

  readonly property bool canSaveSettings: !!(bar && bar.shell
    && typeof bar.shell.updateEntryInline === "function")

  function saveSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) entry[key] = values[key]
    root.settings = entry
    if (canSaveSettings) bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function saveProfiles(list) {
    // Until a profile is picked the first one is browsed implicitly, and
    // moving or removing it would switch to another. Pin the one on screen.
    activeProfileDir = profileDir
    saveSettings({ profiles: Model.profileEntries(list, Quickshell.env("HOME")) })
  }

  function saveJoplinCommand(text) {
    var next = Model.normalizeJoplinCommand(text)
    if (next !== joplinCommand) saveSettings({ joplinCommand: next })
  }

  // Profiles found on disk and each listed one's account: {found, info}, from
  // Model.parseDiscovery. Only read while the settings view is open.
  property var discovery: ({ found: [], info: ({}) })
  property bool discoveryPending: false
  readonly property bool discovering: discoverProcess.running

  function discoverProfiles() {
    if (discoverProcess.running) {
      discoveryPending = true
      return
    }
    var dirs = []
    for (var i = 0; i < profiles.length; i++) dirs.push(profiles[i].dir)
    discoverProcess.command = Model.discoveryArgv(Quickshell.env("HOME"), dirs)
    discoverProcess.running = true
  }

  function finishDiscovery(exitCode) {
    // The raw output carries every settings.json it read, API token and all;
    // only the parsed summary is used.
    try {
      discovery = Model.parseDiscovery(exitCode === 0 ? discoverStdout.text || "" : "",
        Quickshell.env("HOME"))
    } catch (error) {
      discovery = ({ found: [], info: ({}) })
    }
    if (discoveryPending) {
      discoveryPending = false
      discoverProfiles()
    }
  }

  // --- panel plumbing -------------------------------------------------------
  // Shape the bar host and popout coordinator expect from a widget with a panel.

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() {
    refresh()
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (opened) close()
    else open()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  readonly property real openPanelIndicatorWidth: Math.max(
    icon.tightWidth, Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  onSettingsChanged: Qt.callLater(root.refresh)

  readonly property string statusLine: {
    if (dbState === "checking") return "Looking for sqlite3…"
    if (dbState === "no-sqlite") return Model.plainLine(loadError)
    if (dbState === "no-database") return "No Joplin notes found\n" + Model.plainLine(databasePath)
    if (loadError !== "") return Model.plainLine(loadError)
    if (noteCount === 0) return "No Joplin notes"
    return noteCount + (noteCount === 1 ? " note" : " notes") + " · click to browse"
  }

  // With several profiles, say which one the counts belong to.
  readonly property string tooltipLine: multipleProfiles
    ? Model.plainLine(profileName) + " · " + statusLine
    : statusLine

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    // Re-reading `now` keeps the relative timestamps in the list honest.
    onDateChanged: root.now = date
  }

  Timer {
    interval: root.refreshSeconds * 1000
    repeat: true
    running: root.dbState !== "no-sqlite"
    onTriggered: root.refresh()
  }

  // Every sqlite3 read gets a deadline. The collector has no byte limit to set
  // and the queries are bounded in SQL, but a process can still block on a lock
  // or a stalled filesystem, and one that has not finished by now is not going
  // to. Killing it releases the pipe and the read lock; the exit that follows
  // travels the ordinary failure path.
  component QueryWatchdog: Timer {
    required property var query
    interval: Model.QUERY_TIMEOUT_MS
    repeat: false
    running: query.running
    onTriggered: {
      if (!query.running) return
      root.queryTimedOut = true
      query.running = false
    }
  }

  Process {
    id: sqliteCheckProcess
    running: false
    command: ["which", "sqlite3"]
    stdout: StdioCollector { id: sqliteCheckStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishSqliteCheck(exitCode) }
  }

  QueryWatchdog { query: sqliteCheckProcess }

  Process {
    id: schemaProcess
    running: false
    stdout: StdioCollector { id: schemaStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishSchema(exitCode) }
  }

  QueryWatchdog { query: schemaProcess }

  Process {
    id: foldersProcess
    running: false
    stdout: StdioCollector { id: foldersStdout; waitForEnd: true }
    stderr: StdioCollector { id: foldersStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishFolders(exitCode) }
  }

  QueryWatchdog { query: foldersProcess }

  Process {
    id: notesProcess
    running: false
    stdout: StdioCollector { id: notesStdout; waitForEnd: true }
    stderr: StdioCollector { id: notesStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishNotes(exitCode) }
  }

  QueryWatchdog { query: notesProcess }

  Timer {
    id: searchDebounce
    interval: 180
    onTriggered: root.runSearch()
  }

  Process {
    id: searchProcess
    running: false
    stdout: StdioCollector { id: searchStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishSearch(exitCode) }
  }

  QueryWatchdog { query: searchProcess }

  Process {
    id: resourcesProcess
    running: false
    stdout: StdioCollector { id: resourcesStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishResources(exitCode) }
  }

  QueryWatchdog { query: resourcesProcess }

  Process {
    id: tagsProcess
    running: false
    stdout: StdioCollector { id: tagsStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishTags(exitCode) }
  }

  QueryWatchdog { query: tagsProcess }

  Process {
    id: bodyProcess
    running: false
    stdout: StdioCollector { id: bodyStdout; waitForEnd: true }
    stderr: StdioCollector { id: bodyStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishBody(exitCode) }
  }

  QueryWatchdog { query: bodyProcess }

  Process {
    id: discoverProcess
    running: false
    stdout: StdioCollector { id: discoverStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishDiscovery(exitCode) }
  }

  QueryWatchdog { query: discoverProcess }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      item.bar = Qt.binding(function() { return root.bar })
      item.settings = Qt.binding(function() { return root.settings })
      item.anchorItem = button
      item.hostWidget = root
    }
  }

  IpcHandler {
    target: "io.github.renerocksai.omajop"

    function refresh(): void { root.broadcast("refresh") }
    function toggle(): void { root.togglePanel() }
    function open(): void { root.open() }
    function close(): void { root.close() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    dimmed: root.dbState === "no-database" || root.noteCount === 0
    active: root.loadError !== ""
    useActiveColor: true
    fixedWidth: !vertical ? Style.bar.iconSlot : -1
    fixedHeight: vertical ? Style.bar.iconSlot : -1
    horizontalMargin: 8.75
    verticalPadding: 8.75
    tooltipText: root.tooltipLine

    OpticalGlyph {
      id: icon
      anchors.centerIn: parent
      width: Style.bar.iconCanvas
      height: Style.bar.iconCanvas
      text: "󰈙"
      fontFamily: button.fontFamily
      fontSize: Style.bar.iconFont
      color: button.foreground
    }

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }

  Component.onCompleted: {
    now = new Date()
    Qt.callLater(root.refresh)
  }
}
