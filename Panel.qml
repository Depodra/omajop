import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// omajop popup: folders on the left, that folder's notes in the middle, the
// selected note rendered on the right. The host owns all data and every
// process, so this file stays presentational.
Panel {
  id: root
  moduleName: "org.renerocksai.omajop"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property var folderTree: hostWidget && hostWidget.folderTree ? hostWidget.folderTree : []
  readonly property var noteRows: hostWidget && hostWidget.noteRows ? hostWidget.noteRows : []
  readonly property string hostState: hostWidget ? hostWidget.dbState : "checking"
  readonly property string loadError: hostWidget ? hostWidget.loadError : ""
  readonly property string schemaNotice: hostWidget ? hostWidget.schemaNotice : ""
  readonly property bool loading: hostWidget ? hostWidget.loading : false
  readonly property string databasePath: hostWidget ? hostWidget.databasePath : ""
  property date now: hostWidget ? hostWidget.now : new Date()

  readonly property string bodyText: hostWidget ? hostWidget.bodyText : ""
  readonly property var bodySegments: hostWidget && hostWidget.bodySegments ? hostWidget.bodySegments : []
  readonly property var bodyMatchIds: hostWidget && hostWidget.bodyMatchIds ? hostWidget.bodyMatchIds : ({})
  readonly property var tagIndex: hostWidget && hostWidget.tagIndex ? hostWidget.tagIndex : Model.emptyTagIndex()
  readonly property int encryptedCount: hostWidget ? hostWidget.encryptedCount : 0
  readonly property var selectedNoteTags: Model.tagsForNote(root.tagIndex, root.selectedNoteId)
  readonly property int bodyMarkup: hostWidget ? hostWidget.bodyMarkup : Model.MARKUP_MARKDOWN
  readonly property bool bodyEncrypted: hostWidget ? hostWidget.bodyEncrypted : false
  readonly property bool bodyTruncated: hostWidget ? hostWidget.bodyTruncated : false
  readonly property bool bodyLoading: hostWidget ? hostWidget.bodyLoading : false
  readonly property string bodyError: hostWidget ? hostWidget.bodyError : ""

  // The sidebar selects a "source": everything, one folder, or one tag.
  property string selectedKind: Model.SOURCE_ALL
  property string selectedId: ""
  property string selectedNoteId: ""
  property string query: ""
  // 0 = folders, 1 = notes. Left/right moves between them.
  property int activePane: 1

  // bar.foreground, not bar.barForeground: the latter adapts to the wallpaper
  // behind the bar when the bar is transparent, which is right for something
  // drawn *on* the bar and wrong for panel content sitting on the popup's own
  // background. A bright wallpaper turns it dark, and the panel goes unreadable
  // — and because it is computed per monitor, only on the screen whose
  // wallpaper is bright there.
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color mutedForeground: Qt.darker(contentForeground, 1.5)

  // Links are styled through inline HTML, so the accent has to reach the CSS as
  // a literal. A QML color stringifies to #aarrggbb, which CSS would read as
  // #rrggbbaa, so the channels are written out explicitly.
  function hexOf(colour) {
    function channel(value) { return ("0" + Math.round(value * 255).toString(16)).slice(-2) }
    return "#" + channel(colour.r) + channel(colour.g) + channel(colour.b)
  }

  readonly property string linkColorHex: root.hexOf(Color.accent)
  // Table borders sit behind the text, so they take a dimmed foreground rather
  // than the accent, which reads as a loud grid at full strength.
  readonly property string tableBorderHex: root.hexOf(Qt.darker(root.contentForeground, 2.2))

  // Folders and tags share one navigable list. "All notes" is a row like any
  // other, carrying the empty id the model already reads as "no filter".
  readonly property var sourceItems: {
    var items = [{
      kind: Model.SOURCE_ALL,
      id: "",
      title: "All notes",
      depth: 0,
      count: root.noteRows.length
    }]
    for (var i = 0; i < root.folderTree.length; i++) {
      var folder = root.folderTree[i]
      items.push({
        kind: Model.SOURCE_FOLDER,
        id: folder.id,
        title: folder.title,
        depth: folder.depth,
        count: folder.totalCount
      })
    }
    var tags = root.tagIndex.tags || []
    if (tags.length > 0) {
      // A caption row, skipped by the keyboard and by the mouse.
      items.push({ kind: "header", id: "", title: "TAGS", depth: 0, count: -1 })
      for (var j = 0; j < tags.length; j++) {
        items.push({
          kind: Model.SOURCE_TAG,
          id: tags[j].id,
          title: tags[j].title,
          depth: 0,
          count: tags[j].count
        })
      }
    }
    return items
  }

  readonly property var visibleNotes:
    Model.filterNotes(
      Model.notesForSource(root.noteRows, root.selectedKind, root.selectedId, root.tagIndex),
      root.query, root.bodyMatchIds)
  readonly property var selectedNote: Model.findNote(root.visibleNotes, root.selectedNoteId)
  readonly property bool searching: root.query.trim() !== ""

  // --- selection ------------------------------------------------------------

  function indexOfSource(kind, id) {
    for (var i = 0; i < sourceItems.length; i++) {
      if (sourceItems[i].kind === kind && sourceItems[i].id === id) return i
    }
    return 0
  }

  function indexOfNote(id) {
    for (var i = 0; i < visibleNotes.length; i++) {
      if (String(visibleNotes[i].id) === id) return i
    }
    return -1
  }

  function selectSource(item) {
    if (!item || item.kind === "header") return
    selectedKind = item.kind
    selectedId = String(item.id || "")
    // The previous note is unlikely to be in the new source; land on its first.
    selectFirstNote()
  }

  function selectFirstNote() {
    selectNote(visibleNotes.length > 0 ? String(visibleNotes[0].id) : "")
  }

  function selectNote(id) {
    selectedNoteId = String(id || "")
    if (hostWidget) hostWidget.loadBody(selectedNoteId)
  }

  function moveSourceSelection(delta) {
    if (sourceItems.length === 0 || delta === 0) return
    var step = delta > 0 ? 1 : -1
    var index = indexOfSource(selectedKind, selectedId)
    var remaining = Math.abs(delta)
    while (remaining > 0) {
      var next = index + step
      // Step over the TAGS caption rather than landing on it.
      while (next >= 0 && next < sourceItems.length && sourceItems[next].kind === "header") {
        next += step
      }
      if (next < 0 || next >= sourceItems.length) break
      index = next
      remaining--
    }
    selectSource(sourceItems[index])
  }

  function moveNoteSelection(delta) {
    if (visibleNotes.length === 0) return
    var current = indexOfNote(selectedNoteId)
    var next = current < 0 ? 0 : current + delta
    next = Math.max(0, Math.min(visibleNotes.length - 1, next))
    selectNote(String(visibleNotes[next].id))
  }

  function movePane(delta) {
    activePane = Math.max(0, Math.min(1, activePane + delta))
  }

  function moveSelection(delta) {
    if (activePane === 0) moveSourceSelection(delta)
    else moveNoteSelection(delta)
  }

  function openSelected() {
    if (!hostWidget || selectedNoteId === "") return
    hostWidget.openInJoplin(selectedNoteId)
    root.close()
  }

  function refreshNow() {
    if (hostWidget) hostWidget.refresh()
  }

  // j/k move the selection, so without this the keyboard cannot reach the
  // bottom of a long note. Half a pane at a time, so the step follows the
  // panel's height rather than a hardcoded distance.
  function scrollPreview(panes) {
    if (!previewScroll) return
    var limit = Math.max(0, previewScroll.contentHeight - previewScroll.height)
    if (limit <= 0) return
    var target = previewScroll.contentY + previewScroll.height * panes
    previewScroll.contentY = Math.max(0, Math.min(limit, target))
  }

  // g and G jump to the ends. A single g rather than vim's gg, because no
  // other command here is g-prefixed for it to be ambiguous with.
  function scrollPreviewToEnd(bottom) {
    if (!previewScroll) return
    var limit = Math.max(0, previewScroll.contentHeight - previewScroll.height)
    previewScroll.contentY = bottom ? limit : 0
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // The note list changes shape when the folder, filter, or data changes; keep
  // the selection on a row that still exists.
  function reconcileSelection() {
    if (visibleNotes.length === 0) {
      if (selectedNoteId !== "") selectNote("")
      return
    }
    if (indexOfNote(selectedNoteId) < 0) selectFirstNote()
  }

  onVisibleNotesChanged: Qt.callLater(root.reconcileSelection)

  onOpenedChanged: if (opened) {
    // Clear the field, not `query`: its onTextChanged is what keeps the two in
    // step and tells the host to drop its body matches.
    searchField.text = ""
    activePane = 1
    reconcileSelection()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(940))
    contentHeight: panel.fittedContentHeight(Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.movePane(dx)
        if (dy !== 0) root.moveSelection(dy)
      }
      onActivateRequested: root.openSelected()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // hjkl needs no handling here: PanelKeyCatcher already maps it onto
      // moveRequested, and accepts those keys before textKey is emitted.
      onTextKey: function(text) {
        if (text === "d") root.scrollPreview(0.5)
        else if (text === "u") root.scrollPreview(-0.5)
        else if (text === "g") root.scrollPreviewToEnd(false)
        else if (text === "G") root.scrollPreviewToEnd(true)
        else if (text === "q") root.close()
        else if (text === "r" || text === "R") root.refreshNow()
        else if (text === "/") searchField.forceActiveFocus()
      }

      // --- header -----------------------------------------------------------

      Item {
        id: header
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Math.max(headingLabel.height, searchField.height, refreshButton.height)

        Text {
          id: headingLabel
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "JOPLIN"
          color: root.mutedForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1.2
          font.bold: true
        }

        Text {
          id: countLabel
          anchors.left: headingLabel.right
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          text: {
            if (root.hostState === "checking") return "Loading…"
            if (root.hostState === "no-sqlite") return "sqlite3 missing"
            if (root.hostState === "no-database") return "No profile"
            if (root.loading) return "Reading…"
            var total = root.noteRows.length
            var label = total + (total === 1 ? " note" : " notes")
            if (root.encryptedCount > 0) label += "  ·  " + root.encryptedCount + " encrypted"
            return label
          }
          color: root.mutedForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }

        TextField {
          id: searchField
          anchors.right: refreshButton.left
          anchors.rightMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(150)
          visible: root.hostState === "ready"
          foreground: root.contentForeground
          // Sized to sit inside the caption-height header rather than set it.
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          horizontalPadding: Style.space(6)
          verticalPadding: Style.space(2)
          placeholderText: "Search…  /"
          onTextChanged: {
            root.query = text
            // Titles filter instantly; bodies come back from the FTS index.
            if (root.hostWidget) root.hostWidget.setSearchQuery(text)
          }
          // Escape hands the keyboard back to the panel rather than closing it.
          Keys.onEscapePressed: {
            text = ""
            keyCatcher.forceActiveFocus()
          }
        }

        PanelActionButton {
          id: refreshButton
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          iconText: ""
          tooltipText: root.loading ? "Reading notes…" : "Refresh  ·  r"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          enabled: !root.loading
          opacity: root.loading ? 0.6 : 1.0
          onClicked: root.refreshNow()

          Text {
            anchors.centerIn: parent
            text: ""
            color: refreshButton.foreground
            font.family: refreshButton.fontFamily
            font.pixelSize: refreshButton.fontSize

            RotationAnimation on rotation {
              from: 0
              to: 360
              duration: 900
              loops: Animation.Infinite
              running: root.loading
            }

            onRotationChanged: if (!root.loading && rotation !== 0) rotation = 0
          }
        }
      }

      // --- notices ----------------------------------------------------------

      Column {
        id: notices
        anchors.top: header.bottom
        anchors.topMargin: visibleNotice ? Style.space(10) : 0
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(6)

        readonly property bool visibleNotice: problemText !== "" || root.schemaNotice !== ""
        readonly property string problemText: {
          if (root.hostState === "no-sqlite" || root.hostState === "no-database") return root.loadError
          return root.loadError
        }

        BorderSurface {
          width: parent.width
          visible: notices.problemText !== ""
          height: visible ? problemLabel.implicitHeight + Style.space(16) : 0
          radius: Style.cornerRadius
          color: Style.normalFillFor(root.contentForeground, Color.urgent)
          borderSpec: Border.controlSpec("normal", root.contentForeground, Color.urgent)

          Text {
            id: problemLabel
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.margins: Style.space(8)
            text: notices.problemText
            textFormat: Text.PlainText
            color: Color.urgent
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        Text {
          width: parent.width
          visible: root.schemaNotice !== ""
          text: root.schemaNotice
          textFormat: Text.PlainText
          color: root.mutedForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      // --- panes ------------------------------------------------------------

      Item {
        id: panes
        anchors.top: notices.bottom
        anchors.topMargin: Style.space(10)
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        visible: root.hostState === "ready"

        readonly property int folderWidth: Style.space(190)
        readonly property int noteWidth: Style.space(250)

        // Sources: everything, the folder tree, then tags
        ListView {
          id: folderList
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          width: panes.folderWidth
          clip: true
          model: root.sourceItems
          spacing: Style.space(1)
          boundsBehavior: Flickable.StopAtBounds
          currentIndex: root.indexOfSource(root.selectedKind, root.selectedId)
          onCurrentIndexChanged: positionViewAtIndex(currentIndex, ListView.Contain)

          delegate: Rectangle {
            id: sourceRow
            required property var modelData
            required property int index

            readonly property bool isHeader: sourceRow.modelData.kind === "header"
            readonly property bool isTag: sourceRow.modelData.kind === Model.SOURCE_TAG
            readonly property bool isAll: sourceRow.modelData.kind === Model.SOURCE_ALL
            readonly property bool selected: !sourceRow.isHeader
              && sourceRow.modelData.kind === root.selectedKind
              && sourceRow.modelData.id === root.selectedId

            width: folderList.width
            height: sourceRow.isHeader ? Style.space(22) : Style.space(26)
            radius: Style.cornerRadius
            color: {
              if (sourceRow.selected)
                return Style.selectedFillFor(root.contentForeground, Color.accent)
              if (sourceMouse.containsMouse && !sourceRow.isHeader)
                return Style.hoverFillFor(root.contentForeground, Color.accent)
              return "transparent"
            }

            // Caption for the tag section.
            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(6)
              anchors.bottom: parent.bottom
              anchors.bottomMargin: Style.space(4)
              visible: sourceRow.isHeader
              text: sourceRow.modelData.title
              textFormat: Text.PlainText
              color: root.mutedForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1.2
              font.bold: true
            }

            Text {
              id: sourceGlyph
              anchors.left: parent.left
              anchors.leftMargin: Style.space(6) + sourceRow.modelData.depth * Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              visible: !sourceRow.isHeader
              text: {
                if (sourceRow.isAll) return ""
                if (sourceRow.isTag) return ""
                return sourceRow.selected ? "" : ""
              }
              color: sourceRow.selected ? root.contentForeground : root.mutedForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              anchors.left: sourceGlyph.right
              anchors.leftMargin: Style.space(6)
              anchors.right: sourceCount.left
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              visible: !sourceRow.isHeader
              text: sourceRow.modelData.title
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: sourceRow.selected
                ? root.contentForeground : Qt.darker(root.contentForeground, 1.2)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: sourceCount
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              // A tag with no notes still shows its zero, so an empty tag does
              // not look like a folder that failed to load.
              visible: !sourceRow.isHeader
              text: {
                if (sourceRow.modelData.count < 0) return ""
                if (sourceRow.modelData.count === 0 && !sourceRow.isTag) return ""
                return String(sourceRow.modelData.count)
              }
              color: root.mutedForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            MouseArea {
              id: sourceMouse
              anchors.fill: parent
              hoverEnabled: !sourceRow.isHeader
              enabled: !sourceRow.isHeader
              onClicked: {
                root.activePane = 0
                root.selectSource(sourceRow.modelData)
              }
            }
          }
        }

        PanelSeparator {
          id: firstSeparator
          anchors.left: folderList.right
          anchors.leftMargin: Style.space(8)
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: 1
          foreground: root.contentForeground
        }

        // Notes in the selected folder
        ListView {
          id: noteList
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.left: firstSeparator.right
          anchors.leftMargin: Style.space(8)
          width: panes.noteWidth
          clip: true
          model: root.visibleNotes
          spacing: Style.space(1)
          boundsBehavior: Flickable.StopAtBounds
          currentIndex: root.indexOfNote(root.selectedNoteId)
          onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)

          delegate: Rectangle {
            id: noteRow
            required property var modelData
            required property int index

            readonly property string noteId: String(noteRow.modelData.id)
            readonly property string todo: Model.todoState(noteRow.modelData)

            width: noteList.width
            height: Style.space(38)
            radius: Style.cornerRadius
            color: {
              if (noteRow.noteId === root.selectedNoteId)
                return Style.selectedFillFor(root.contentForeground, Color.accent)
              if (noteMouse.containsMouse)
                return Style.hoverFillFor(root.contentForeground, Color.accent)
              return "transparent"
            }

            Text {
              id: noteGlyph
              anchors.left: parent.left
              anchors.leftMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              text: {
                if (Model.isEncryptedNote(noteRow.modelData)) return ""
                if (noteRow.todo === "done") return ""
                return noteRow.todo === "open" ? "" : ""
              }
              color: noteRow.todo === "done" ? root.mutedForeground : root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: noteTitleLabel
              anchors.left: noteGlyph.right
              anchors.leftMargin: Style.space(6)
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.top: parent.top
              anchors.topMargin: Style.space(5)
              text: Model.noteTitle(noteRow.modelData)
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: noteRow.todo === "done" ? root.mutedForeground : root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              font.strikeout: noteRow.todo === "done"
            }

            Text {
              anchors.left: noteTitleLabel.left
              anchors.right: noteTitleLabel.right
              anchors.top: noteTitleLabel.bottom
              anchors.topMargin: Style.space(2)
              text: Model.formatUpdated(noteRow.modelData.updated_time, root.now)
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: root.mutedForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            MouseArea {
              id: noteMouse
              anchors.fill: parent
              hoverEnabled: true
              acceptedButtons: Qt.LeftButton
              onClicked: {
                root.activePane = 1
                root.selectNote(noteRow.noteId)
              }
              onDoubleClicked: {
                root.selectNote(noteRow.noteId)
                root.openSelected()
              }
            }
          }

          Text {
            anchors.centerIn: parent
            visible: noteList.count === 0
            text: root.searching ? "No match" : "No notes here"
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        PanelSeparator {
          id: secondSeparator
          anchors.left: noteList.right
          anchors.leftMargin: Style.space(8)
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: 1
          foreground: root.contentForeground
        }

        // Preview of the selected note
        Item {
          id: preview
          anchors.left: secondSeparator.right
          anchors.leftMargin: Style.space(10)
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom

          Text {
            id: previewTitle
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: openButton.left
            anchors.rightMargin: Style.space(8)
            text: root.selectedNote ? Model.noteTitle(root.selectedNote) : ""
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            id: previewMeta
            anchors.top: previewTitle.bottom
            anchors.topMargin: Style.space(2)
            anchors.left: parent.left
            anchors.right: openButton.left
            anchors.rightMargin: Style.space(8)
            visible: root.selectedNote !== null
            text: {
              if (!root.selectedNote) return ""
              var parts = [Model.formatUpdated(root.selectedNote.updated_time, root.now)]
              if (root.selectedNoteTags.length > 0) {
                parts.push(" " + root.selectedNoteTags.join(", "))
              }
              if (root.bodyTruncated) parts.push("preview truncated")
              return parts.join("  ·  ")
            }
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          PanelActionButton {
            id: openButton
            anchors.top: parent.top
            anchors.right: parent.right
            iconText: ""
            tooltipText: "Open in Joplin  ·  Enter"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            visible: root.selectedNote !== null
            onClicked: root.openSelected()
          }

          PanelSeparator {
            id: previewRule
            anchors.top: previewMeta.visible ? previewMeta.bottom : previewTitle.bottom
            anchors.topMargin: Style.space(8)
            anchors.left: parent.left
            anchors.right: parent.right
            height: 1
            visible: root.selectedNote !== null
            foreground: root.contentForeground
          }

          Flickable {
            id: previewScroll
            anchors.top: previewRule.bottom
            anchors.topMargin: Style.space(8)
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            contentWidth: width
            contentHeight: previewColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height

            // Reading a new note should start at the top of it.
            onContentHeightChanged: contentY = 0

            Column {
              id: previewColumn
              width: previewScroll.width
              spacing: Style.space(8)

              // Anything that replaces the body outright: an error, an
              // encrypted note, or the gap before the first read returns.
              Text {
                width: parent.width
                visible: text !== ""
                text: {
                  if (root.bodyError !== "") return root.bodyError
                  if (root.bodyEncrypted) {
                    return "This note has not been decrypted yet.\n\n"
                      + "It synced in before its master key was available. Open "
                      + "Joplin and enter the master password, and it will "
                      + "decrypt in the background."
                  }
                  if (root.bodyLoading && root.bodyText === "") return "Loading…"
                  return ""
                }
                textFormat: Text.PlainText
                color: root.bodyError !== "" ? Color.urgent : root.mutedForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }

              // The body arrives pre-split: prose in text segments, each image
              // in its own, because Qt's Markdown renderer reserves space for a
              // file:// image and then paints nothing.
              Repeater {
                model: root.bodySegments

                delegate: Item {
                  id: segment
                  required property var modelData

                  readonly property bool isImage: segment.modelData.kind === "image"

                  width: previewColumn.width
                  implicitHeight: segment.isImage
                    ? Math.max(segmentImage.height, segmentImageNotice.visible ? segmentImageNotice.implicitHeight : 0)
                    : segmentText.implicitHeight
                  height: implicitHeight

                  Text {
                    id: segmentText
                    visible: !segment.isImage
                    width: parent.width
                    text: {
                      if (segment.isImage) return ""
                      var styling = {
                        linkColor: root.linkColorHex,
                        fontSizePx: Style.font.bodySmall,
                        tableBorderColor: root.tableBorderHex
                      }
                      // Qt renders anchors and code the same untheme-aware way
                      // in both formats; only the rewriting differs.
                      return root.bodyMarkup === Model.MARKUP_HTML
                        ? Model.styleHtml(segment.modelData.text, styling)
                        : Model.styleMarkdown(segment.modelData.text, styling)
                    }
                    // Joplin stores Markdown (markup_language 1) or HTML (2).
                    textFormat: root.bodyMarkup === Model.MARKUP_HTML
                      ? Text.RichText : Text.MarkdownText
                    color: root.contentForeground
                    // Honoured for HTML notes. Markdown ignores it entirely —
                    // the importer bakes its own blue into the character format,
                    // which is why links are rewritten as styled anchors above.
                    linkColor: Color.accent
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.Wrap
                    // Rendered note bodies are data, not navigation.
                    onLinkActivated: function(link) { Quickshell.execDetached(["xdg-open", link]) }
                  }

                  Image {
                    id: segmentImage
                    visible: segment.isImage && status === Image.Ready
                    source: segment.isImage ? segment.modelData.url : ""
                    asynchronous: true
                    fillMode: Image.PreserveAspectFit
                    // Fit the pane, but never blow a small image up to fill it.
                    width: implicitWidth > 0
                      ? Math.min(implicitWidth, parent.width)
                      : 0
                    height: implicitWidth > 0
                      ? Math.round(implicitHeight * (width / implicitWidth))
                      : 0
                    // No sourceSize: it is a decode target, not a cap, so Qt
                    // would scale a small image UP to it and render it blurred.
                    // Natural size drives implicitWidth instead, and mipmap
                    // keeps a large image sharp once bound to the pane.
                    mipmap: true
                    smooth: true
                  }

                  Text {
                    id: segmentImageNotice
                    visible: segment.isImage && segmentImage.status === Image.Error
                    width: parent.width
                    text: {
                      var title = segment.isImage ? Model.plainLine(segment.modelData.title) : ""
                      return title !== ""
                        ? "Missing image file: " + title
                        : "Missing image file"
                    }
                    textFormat: Text.PlainText
                    color: root.mutedForeground
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                  }
                }
              }
            }
          }

          Text {
            anchors.centerIn: parent
            visible: root.selectedNote === null
            text: root.noteRows.length === 0 ? "No notes in this profile" : "Select a note"
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }
      }

      // --- empty states -----------------------------------------------------

      Column {
        anchors.centerIn: parent
        width: Math.min(parent.width, Style.space(420))
        spacing: Style.space(8)
        visible: root.hostState !== "ready"

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: {
            if (root.hostState === "checking") return "Looking for sqlite3…"
            if (root.hostState === "no-sqlite") return "sqlite3 is required"
            return "No Joplin profile found"
          }
          color: root.contentForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
        }

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          visible: root.hostState === "no-sqlite" || root.hostState === "no-database"
          text: root.hostState === "no-sqlite"
            ? "omajop reads your notes with the sqlite3 CLI.\nInstall it with:  omarchy pkg add sqlite"
            : "Expected a Joplin desktop profile at:\n" + root.databasePath
          textFormat: Text.PlainText
          color: root.mutedForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
