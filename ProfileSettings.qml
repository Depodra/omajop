import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// Profile settings, shown in place of the notes. Lists the profiles the panel
// browses, with what each syncs to, and the Joplin profiles found on this
// machine that are not listed yet. Every change is saved as it is made. The
// host owns the discovery process and the shell.json write, as it owns every
// other process, so this file stays presentational.
Item {
  id: root

  property var hostWidget: null
  // Where the keyboard goes back to when an inline field is done.
  property var keyTarget: null
  property color contentForeground: Color.foreground
  property color mutedForeground: Qt.darker(contentForeground, 1.5)
  property string contentFontFamily: Style.font.family

  readonly property string home: Quickshell.env("HOME")
  readonly property var profiles: hostWidget && hostWidget.profiles ? hostWidget.profiles : []
  readonly property var discovery: hostWidget && hostWidget.discovery
    ? hostWidget.discovery : ({ found: [], info: ({}) })
  readonly property bool canSave: hostWidget ? hostWidget.canSaveSettings === true : false

  // Found on disk and not listed yet.
  readonly property var available: {
    var out = []
    var found = discovery.found || []
    for (var i = 0; i < found.length; i++) {
      if (Model.indexOfProfile(profiles, found[i].dir) < 0) out.push(found[i])
    }
    return out
  }

  // One keyboard cursor over both lists: the listed profiles, then the found.
  property int cursor: 0
  readonly property int rowCount: profiles.length + available.length
  property int renaming: -1
  readonly property bool editing: renaming >= 0 || pathField.activeFocus || commandField.activeFocus

  function clampCursor() {
    cursor = Math.max(0, Math.min(rowCount - 1, cursor))
  }

  function moveCursor(delta) {
    if (rowCount === 0) return
    cursor = Math.max(0, Math.min(rowCount - 1, cursor + delta))
    rowsColumn.reveal(cursor)
  }

  function save(list) {
    if (hostWidget) hostWidget.saveProfiles(list)
  }

  // Enter: rename a listed profile, or add a found one.
  function activate() {
    if (cursor < profiles.length) startRename(cursor)
    else addFound(cursor - profiles.length)
  }

  function removeAt(index) {
    save(Model.removeProfile(profiles, index))
    Qt.callLater(root.clampCursor)
  }

  function removeAtCursor() {
    if (cursor < profiles.length) removeAt(cursor)
  }

  function move(index, delta) {
    var next = Model.moveProfile(profiles, index, delta)
    if (next[index] === profiles[index]) return
    save(next)
    if (cursor === index) cursor = index + delta
  }

  // J / K carry the profile under the cursor down / up.
  function moveAtCursor(delta) {
    if (cursor < profiles.length) move(cursor, delta)
  }

  function addFound(index) {
    var found = available[index]
    if (!found) return
    save(Model.addProfile(profiles, found.dir, Model.suggestedProfileName(found)))
  }

  function addPath(text) {
    var path = Model.normalizeProfilePath(text)
    if (path === "") return
    var dir = Model.profileDirectory(home, path)
    if (Model.indexOfProfile(profiles, dir) < 0) save(Model.addProfile(profiles, dir, ""))
    pathField.text = ""
    returnFocus()
  }

  function startRename(index) {
    if (index < 0 || index >= profiles.length) return
    cursor = index
    renaming = index
  }

  function commitRename(text) {
    if (renaming >= 0) save(Model.renameProfile(profiles, renaming, text))
    renaming = -1
    returnFocus()
  }

  function cancelRename() {
    renaming = -1
    returnFocus()
  }

  function returnFocus() {
    if (keyTarget) keyTarget.forceActiveFocus()
  }

  // What a profile is and what it syncs to, on the line under its name.
  function describe(dir) {
    var kind = Model.profileKind(home, dir)
    var parts = [Model.profileKindLabel(kind, home, dir)]
    var info = discovery.info ? discovery.info[dir] : null
    if (info && !info.hasDatabase) parts.push("no Joplin database here yet")
    else if (info) parts.push(Model.accountLine(info.account))
    else if (hostWidget && hostWidget.discovering) parts.push("…")
    return parts.join("  ·  ")
  }

  function missingDatabase(dir) {
    var info = discovery.info ? discovery.info[dir] : null
    return !!info && !info.hasDatabase
  }

  onRowCountChanged: Qt.callLater(root.clampCursor)

  Flickable {
    id: scroller
    anchors.fill: parent
    contentWidth: width
    contentHeight: rowsColumn.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height

    Column {
      id: rowsColumn
      width: scroller.width
      spacing: Style.space(6)

      // Keep the keyboard cursor on screen.
      function reveal(index) {
        var row = index < root.profiles.length
          ? profileRepeater.itemAt(index)
          : foundRepeater.itemAt(index - root.profiles.length)
        if (!row) return
        var y = row.mapToItem(rowsColumn, 0, 0).y
        if (y < scroller.contentY) scroller.contentY = y
        else if (y + row.height > scroller.contentY + scroller.height)
          scroller.contentY = y + row.height - scroller.height
      }

      Text {
        width: parent.width
        visible: !root.canSave
        text: "This bar cannot save omajop's settings, so changes here last until "
          + "the shell restarts. Edit the widget's entry in ~/.config/omarchy/shell.json "
          + "to keep them."
        textFormat: Text.PlainText
        color: Color.urgent
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      PanelSectionHeader {
        text: "PROFILES"
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily
      }

      Repeater {
        id: profileRepeater
        model: root.profiles

        delegate: CursorSurface {
          id: profileRow
          required property var modelData
          required property int index

          readonly property bool isRenaming: root.renaming === profileRow.index
          readonly property bool isBrowsed: root.hostWidget
            && root.hostWidget.profileIndex === profileRow.index

          width: rowsColumn.width
          height: Style.space(44)
          hasCursor: root.cursor === profileRow.index && !root.editing
          foreground: root.contentForeground

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: if (!root.editing) root.cursor = profileRow.index
            onDoubleClicked: root.startRename(profileRow.index)
          }

          Text {
            id: profileGlyph
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: profileRow.isBrowsed ? "" : ""
            color: profileRow.isBrowsed ? Color.accent : root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            id: profileName
            anchors.left: profileGlyph.right
            anchors.leftMargin: Style.space(8)
            anchors.top: parent.top
            anchors.topMargin: Style.space(5)
            width: Math.min(implicitWidth, Style.space(200))
            visible: !profileRow.isRenaming
            text: profileRow.modelData.name
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
          }

          TextField {
            id: renameField
            anchors.left: profileGlyph.right
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: profileName.verticalCenter
            width: Style.space(200)
            visible: profileRow.isRenaming
            foreground: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            horizontalPadding: Style.space(6)
            verticalPadding: Style.space(2)
            placeholderText: "Profile name"
            onVisibleChanged: if (visible) {
              text = profileRow.modelData.name
              selectAll()
              forceActiveFocus()
            }
            onAccepted: root.commitRename(text)
            Keys.onEscapePressed: root.cancelRename()
            onActiveFocusChanged: if (!activeFocus && profileRow.isRenaming) root.cancelRename()
          }

          Text {
            anchors.left: profileName.right
            anchors.leftMargin: Style.space(10)
            anchors.right: profileActions.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: profileName.verticalCenter
            visible: !profileRow.isRenaming
            text: Model.contractHome(profileRow.modelData.dir, root.home)
            textFormat: Text.PlainText
            elide: Text.ElideMiddle
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            anchors.left: profileName.left
            anchors.right: profileActions.left
            anchors.rightMargin: Style.space(8)
            anchors.bottom: parent.bottom
            anchors.bottomMargin: Style.space(5)
            text: root.describe(profileRow.modelData.dir)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.missingDatabase(profileRow.modelData.dir) ? Color.urgent : root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            id: profileActions
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            PanelActionButton {
              iconText: ""
              tooltipText: "Move up  ·  K"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              enabled: profileRow.index > 0
              opacity: enabled ? 1.0 : 0.35
              onClicked: root.move(profileRow.index, -1)
            }

            PanelActionButton {
              iconText: ""
              tooltipText: "Move down  ·  J"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              enabled: profileRow.index < root.profiles.length - 1
              opacity: enabled ? 1.0 : 0.35
              onClicked: root.move(profileRow.index, 1)
            }

            PanelActionButton {
              iconText: ""
              tooltipText: "Rename  ·  Enter"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: root.startRename(profileRow.index)
            }

            PanelActionButton {
              iconText: ""
              tooltipText: "Remove from this list  ·  x"
              foreground: root.contentForeground
              hoverColor: Color.urgent
              fontFamily: root.contentFontFamily
              // The last profile stays; an empty list would mean the default one.
              enabled: root.profiles.length > 1
              opacity: enabled ? 1.0 : 0.35
              onClicked: root.removeAt(profileRow.index)
            }
          }
        }
      }

      Item {
        width: parent.width
        height: Style.space(4)
      }

      PanelSectionHeader {
        visible: root.available.length > 0 || (root.hostWidget && root.hostWidget.discovering)
        text: root.hostWidget && root.hostWidget.discovering && root.available.length === 0
          ? "LOOKING FOR JOPLIN PROFILES…" : "FOUND ON THIS COMPUTER"
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily
      }

      Repeater {
        id: foundRepeater
        model: root.available

        delegate: CursorSurface {
          id: foundRow
          required property var modelData
          required property int index

          readonly property int row: root.profiles.length + foundRow.index

          width: rowsColumn.width
          height: Style.space(44)
          hasCursor: root.cursor === foundRow.row && !root.editing
          foreground: root.contentForeground

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: if (!root.editing) root.cursor = foundRow.row
            onDoubleClicked: root.addFound(foundRow.index)
          }

          Text {
            id: foundGlyph
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: ""
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            id: foundName
            anchors.left: foundGlyph.right
            anchors.leftMargin: Style.space(8)
            anchors.top: parent.top
            anchors.topMargin: Style.space(5)
            width: Math.min(implicitWidth, Style.space(200))
            text: Model.suggestedProfileName(foundRow.modelData)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: Qt.darker(root.contentForeground, 1.2)
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            anchors.left: foundName.right
            anchors.leftMargin: Style.space(10)
            anchors.right: addButton.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: foundName.verticalCenter
            text: Model.contractHome(foundRow.modelData.dir, root.home)
            textFormat: Text.PlainText
            elide: Text.ElideMiddle
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            anchors.left: foundName.left
            anchors.right: addButton.left
            anchors.rightMargin: Style.space(8)
            anchors.bottom: parent.bottom
            anchors.bottomMargin: Style.space(5)
            text: root.describe(foundRow.modelData.dir)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.mutedForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          PanelActionButton {
            id: addButton
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            iconText: ""
            tooltipText: "Add  ·  Enter"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: root.profiles.length < Model.MAX_PROFILES
            opacity: enabled ? 1.0 : 0.35
            onClicked: root.addFound(foundRow.index)
          }
        }
      }

      Item {
        width: parent.width
        height: Style.space(4)
      }

      PanelSectionHeader {
        text: "ADD A PROFILE DIRECTORY"
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily
      }

      Text {
        width: parent.width
        text: "For a Joplin started with --profile. Secondary instances and "
          + "in-app profiles appear above once Joplin has created them."
        textFormat: Text.PlainText
        color: root.mutedForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Row {
        spacing: Style.space(8)

        TextField {
          id: pathField
          width: Style.space(320)
          foreground: root.contentForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          horizontalPadding: Style.space(6)
          verticalPadding: Style.space(3)
          placeholderText: "~/path/to/profile"
          onAccepted: root.addPath(text)
          Keys.onEscapePressed: {
            text = ""
            root.returnFocus()
          }
        }

        Button {
          text: "Add"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          fontSize: Style.font.caption
          bordered: true
          enabled: pathField.text.trim() !== "" && root.profiles.length < Model.MAX_PROFILES
          opacity: enabled ? 1.0 : 0.5
          onClicked: root.addPath(pathField.text)
        }
      }

      Item {
        width: parent.width
        height: Style.space(4)
      }

      PanelSectionHeader {
        text: "OPENING NOTES"
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily
      }

      Text {
        width: parent.width
        text: "Notes from the main instance open through the joplin:// link. Any "
          + "other profile is opened by starting Joplin with that profile's flags, "
          + "using this command. Change it if Joplin is installed under another "
          + "name, such as an AppImage."
        textFormat: Text.PlainText
        color: root.mutedForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      TextField {
        id: commandField
        width: Style.space(320)
        foreground: root.contentForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
        horizontalPadding: Style.space(6)
        verticalPadding: Style.space(3)
        placeholderText: Model.DEFAULT_JOPLIN_COMMAND
        text: root.hostWidget ? root.hostWidget.joplinCommand : ""
        onAccepted: {
          if (root.hostWidget) root.hostWidget.saveJoplinCommand(text)
          root.returnFocus()
        }
        onActiveFocusChanged: if (!activeFocus && root.hostWidget) root.hostWidget.saveJoplinCommand(text)
        Keys.onEscapePressed: {
          text = root.hostWidget ? root.hostWidget.joplinCommand : ""
          root.returnFocus()
        }
      }
    }
  }
}
