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

  readonly property string profileDir: Model.profileDirectory(Quickshell.env("HOME"), profilePath)
  readonly property string databasePath: Model.databasePath(Quickshell.env("HOME"), profilePath)

  // "checking" | "no-sqlite" | "no-database" | "ready"
  property string dbState: "checking"
  property string loadError: ""
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
    if (dbState === "ready") {
      loadSchema()
      return
    }
    sqliteCheckProcess.running = true
  }

  function finishSqliteCheck(exitCode) {
    if (exitCode !== 0 || String(sqliteCheckStdout.text || "").trim() === "") {
      dbState = "no-sqlite"
      loadError = "sqlite3 is not installed. Install it with: omarchy pkg add sqlite"
      setData([], [])
      return
    }
    loadSchema()
  }

  function loadSchema() {
    schemaProcess.command = Model.sqliteArgv(databasePath, Model.schemaSql())
    schemaProcess.running = true
  }

  function finishSchema(exitCode) {
    if (exitCode !== 0) {
      // The most common cause by far is that Joplin has never run here.
      dbState = "no-database"
      loadError = "No Joplin database at " + databasePath
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
    foldersProcess.command = Model.sqliteArgv(databasePath, Model.foldersSql())
    foldersProcess.running = true
  }

  function finishFolders(exitCode) {
    if (exitCode !== 0) {
      failLoad(String(foldersStderr.text || "").trim(), "Could not read folders.")
      return
    }
    notesProcess.command = Model.sqliteArgv(databasePath, Model.notesSql(sortBy))
    notesProcess.running = true
  }

  function finishNotes(exitCode) {
    if (exitCode !== 0) {
      failLoad(String(notesStderr.text || "").trim(), "Could not read notes.")
      return
    }
    resourcesProcess.command = Model.sqliteArgv(databasePath, Model.resourcesSql())
    resourcesProcess.running = true
  }

  function finishResources(exitCode) {
    // Attachments are decorative: a failure here must not cost the notes.
    resourceMap = ({})
    if (exitCode === 0) {
      try {
        resourceMap = Model.buildResourceMap(Model.parseRows(resourcesStdout.text || ""))
      } catch (error) {
        // Leave the map empty; bodies still render, without their images.
      }
    }
    tagsProcess.command = Model.sqliteArgv(databasePath, Model.tagsSql())
    tagsProcess.running = true
  }

  function finishTags(exitCode) {
    try {
      var folders = Model.parseRows(foldersStdout.text || "")
      var notes = Model.parseRows(notesStdout.text || "")
      // Tags are supplementary; without them the folder list still works.
      var tagRows = exitCode === 0 ? Model.parseRows(tagsStdout.text || "") : []
      dbState = "ready"
      loadError = ""
      tagIndex = Model.buildTagIndex(tagRows, notes)
      setData(folders, notes)
    } catch (error) {
      failLoad(String(error), "The database returned unusable output.")
    }
  }

  function failLoad(detail, fallback) {
    tagIndex = Model.emptyTagIndex()
    dbState = "ready"
    loadError = detail !== ""
      ? Model.truncate(Model.plainLine(detail), 320)
      : fallback
    setData([], [])
  }

  function setData(folders, notes) {
    folderRows = folders
    noteRows = notes
    folderTree = Model.buildFolderTree(folders, notes)
  }

  // --- note body ------------------------------------------------------------

  function loadBody(id) {
    var noteId = String(id || "")
    if (noteId === bodyNoteId) return
    bodyNoteId = noteId
    bodyText = ""
    bodyError = ""
    bodyEncrypted = false
    bodyTruncated = false
    if (noteId === "" || !ready) return

    var sql
    try {
      sql = Model.noteBodySql(noteId)
    } catch (error) {
      bodyError = "Refusing to load a note with a malformed id."
      return
    }
    bodyProcess.command = Model.sqliteArgv(databasePath, sql)
    bodyProcess.running = true
  }

  function finishBody(exitCode) {
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
    searchProcess.command = Model.sqliteArgv(databasePath, Model.searchSql(expression))
    searchProcess.running = true
  }

  function finishSearch(exitCode) {
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

  function openInJoplin(id) {
    var url = Model.noteUrl(id)
    if (url === "") return
    Quickshell.execDetached(["xdg-open", url])
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

  readonly property string tooltipLine: {
    if (dbState === "checking") return "Looking for sqlite3…"
    if (dbState === "no-sqlite") return Model.plainLine(loadError)
    if (dbState === "no-database") return "No Joplin notes found\n" + Model.plainLine(databasePath)
    if (loadError !== "") return Model.plainLine(loadError)
    if (noteCount === 0) return "No Joplin notes"
    return noteCount + (noteCount === 1 ? " note" : " notes") + " · click to browse"
  }

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

  Process {
    id: sqliteCheckProcess
    running: false
    command: ["which", "sqlite3"]
    stdout: StdioCollector { id: sqliteCheckStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishSqliteCheck(exitCode) }
  }

  Process {
    id: schemaProcess
    running: false
    stdout: StdioCollector { id: schemaStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishSchema(exitCode) }
  }

  Process {
    id: foldersProcess
    running: false
    stdout: StdioCollector { id: foldersStdout; waitForEnd: true }
    stderr: StdioCollector { id: foldersStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishFolders(exitCode) }
  }

  Process {
    id: notesProcess
    running: false
    stdout: StdioCollector { id: notesStdout; waitForEnd: true }
    stderr: StdioCollector { id: notesStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishNotes(exitCode) }
  }

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

  Process {
    id: resourcesProcess
    running: false
    stdout: StdioCollector { id: resourcesStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishResources(exitCode) }
  }

  Process {
    id: tagsProcess
    running: false
    stdout: StdioCollector { id: tagsStdout; waitForEnd: true }
    onExited: function(exitCode) { root.finishTags(exitCode) }
  }

  Process {
    id: bodyProcess
    running: false
    stdout: StdioCollector { id: bodyStdout; waitForEnd: true }
    stderr: StdioCollector { id: bodyStderr; waitForEnd: true }
    onExited: function(exitCode) { root.finishBody(exitCode) }
  }

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
