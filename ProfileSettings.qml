import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// Profile settings, shown in place of the notes. The list view shows the
// profiles the panel browses, with what each syncs to, and the Joplin profiles
// found on this machine that are not listed yet; choosing a profile opens its
// own page. Every change is saved as it is made. The host owns the processes
// and the shell.json write, as it owns every other, so this file stays
// presentational.
Item {
  id: root

  property var hostWidget: null
  // Where the keyboard goes back to when a field is done.
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

  // "list", "edit" for the profile at editIndex, or "add" for a new account.
  property string mode: "list"
  property int editIndex: -1
  readonly property var editing: mode === "edit" && editIndex >= 0 && editIndex < profiles.length
    ? profiles[editIndex] : null

  // One keyboard cursor over both lists: the listed profiles, then the found.
  property int cursor: 0
  readonly property int rowCount: profiles.length + available.length
  readonly property bool typing: pathField.activeFocus || commandField.activeFocus
    || nameField.activeFocus || accountNameField.activeFocus
    || serverField.activeFocus || emailField.activeFocus

  // Where Add account creates the instance, and whether something is there.
  readonly property string accountDir: Model.newAccountDir(home)
  readonly property var accountDirInfo: infoFor(accountDir)
  readonly property bool accountDirTaken: !!accountDirInfo && accountDirInfo.exists

  // A listed profile Joplin has not created its database in yet: an account
  // just added, typically. Its notes appear once Joplin has started on it.
  readonly property bool waitingForJoplin: {
    for (var i = 0; i < profiles.length; i++) {
      var info = infoFor(profiles[i].dir)
      if (info && info.exists && !info.hasDatabase) return true
    }
    return false
  }

  function clampCursor() {
    cursor = Math.max(0, Math.min(rowCount - 1, cursor))
  }

  function moveCursor(delta) {
    if (mode !== "list" || rowCount === 0) return
    cursor = Math.max(0, Math.min(rowCount - 1, cursor + delta))
    listColumn.reveal(cursor)
  }

  function save(list) {
    if (hostWidget) hostWidget.saveProfiles(list)
  }

  // Enter: open a listed profile's page, or add a found one.
  function activate() {
    if (mode !== "list") return
    if (cursor < profiles.length) openEdit(cursor)
    else addFound(cursor - profiles.length)
  }

  // Escape: back to the list. False when already there, so the panel can
  // leave the settings instead.
  function back() {
    if (mode === "list") return false
    showList()
    return true
  }

  function showList() {
    if (mode === "edit" && editIndex >= 0) cursor = editIndex
    mode = "list"
    editIndex = -1
    returnFocus()
  }

  function openAdd() {
    mode = "add"
    editIndex = -1
    if (hostWidget) {
      hostWidget.accountMessage = ""
      hostWidget.accountFailed = false
    }
    accountNameField.text = ""
    serverField.text = ""
    emailField.text = ""
    if (!accountDirTaken) accountNameField.forceActiveFocus()
    else returnFocus()
  }

  function submitAccount() {
    if (!hostWidget || accountDirTaken) return
    hostWidget.createAccount(Model.plainLine(accountNameField.text), serverField.text, emailField.text)
    returnFocus()
  }

  function openEdit(index) {
    if (index < 0 || index >= profiles.length) return
    cursor = index
    editIndex = index
    mode = "edit"
    nameField.text = profiles[index].name
    returnFocus()
  }

  function removeAt(index) {
    save(Model.removeProfile(profiles, index))
    Qt.callLater(root.clampCursor)
  }

  function removeAtCursor() {
    if (mode === "list" && cursor < profiles.length) removeAt(cursor)
  }

  function move(index, delta) {
    var next = Model.moveProfile(profiles, index, delta)
    if (next[index] === profiles[index]) return
    save(next)
    if (cursor === index) cursor = index + delta
  }

  // J / K carry the profile under the cursor down / up.
  function moveAtCursor(delta) {
    if (mode === "list" && cursor < profiles.length) move(cursor, delta)
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

  function rename(text) {
    if (!editing) return
    if (Model.plainLine(text) !== editing.name) save(Model.renameProfile(profiles, editIndex, text))
  }

  function returnFocus() {
    if (keyTarget) keyTarget.forceActiveFocus()
  }

  function infoFor(dir) {
    return discovery.info ? discovery.info[dir] || null : null
  }

  // Set up for a server, but Joplin has not started on it yet.
  function notStarted(info) {
    return !!info && !info.hasDatabase && info.exists && info.account.target > 0
  }

  // What a profile syncs to, or why its notes cannot be read.
  function accountText(dir) {
    var info = infoFor(dir)
    if (!info) return hostWidget && hostWidget.discovering ? "…" : ""
    if (notStarted(info)) return "Not started yet  ·  " + Model.accountLine(info.account)
    if (!info.exists) return "Folder not found"
    if (!info.hasDatabase) return "No Joplin database here yet"
    return Model.accountLine(info.account)
  }

  function problem(dir) {
    var info = infoFor(dir)
    return !!info && !info.hasDatabase && !notStarted(info)
  }

  // The listed profile's page follows it if the list is edited elsewhere.
  onProfilesChanged: {
    Qt.callLater(root.clampCursor)
    if (mode === "edit" && !editing) showList()
  }

  Timer {
    interval: 4000
    repeat: true
    running: root.visible && root.waitingForJoplin && !!root.hostWidget && root.hostWidget.opened
    onTriggered: root.hostWidget.discoverProfiles()
  }

  component Caption: Text {
    width: parent ? parent.width : 0
    textFormat: Text.PlainText
    color: root.mutedForeground
    font.family: root.contentFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
  }

  component Header: PanelSectionHeader {
    foreground: root.contentForeground
    fontFamily: root.contentFontFamily
  }

  component Spacer: Item {
    width: 1
    height: Style.space(4)
  }

  component SmallField: TextField {
    width: Style.space(320)
    foreground: root.contentForeground
    font.family: root.contentFontFamily
    font.pixelSize: Style.font.caption
    horizontalPadding: Style.space(6)
    verticalPadding: Style.space(3)
  }

  component SmallButton: Button {
    foreground: root.contentForeground
    fontFamily: root.contentFontFamily
    fontSize: Style.font.caption
    bordered: true
    opacity: enabled ? 1.0 : 0.5
  }

  // --- list -------------------------------------------------------------------

  Flickable {
    id: listScroller
    anchors.fill: parent
    visible: root.mode === "list"
    contentWidth: width
    contentHeight: listColumn.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height

    Column {
      id: listColumn
      width: listScroller.width
      spacing: Style.space(6)

      // Keep the keyboard cursor on screen.
      function reveal(index) {
        var row = index < root.profiles.length
          ? profileRepeater.itemAt(index)
          : foundRepeater.itemAt(index - root.profiles.length)
        if (!row) return
        var y = row.mapToItem(listColumn, 0, 0).y
        if (y < listScroller.contentY) listScroller.contentY = y
        else if (y + row.height > listScroller.contentY + listScroller.height)
          listScroller.contentY = y + row.height - listScroller.height
      }

      Caption {
        visible: !root.canSave
        text: "This bar cannot save omajop's settings, so changes here last until "
          + "the shell restarts. Edit the widget's entry in ~/.config/omarchy/shell.json "
          + "to keep them."
        color: Color.urgent
      }

      Header { text: "PROFILES" }

      Repeater {
        id: profileRepeater
        model: root.profiles

        delegate: CursorSurface {
          id: profileRow
          required property var modelData
          required property int index

          width: listColumn.width
          height: Style.space(44)
          hasCursor: root.cursor === profileRow.index && !root.typing
          foreground: root.contentForeground

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: if (!root.typing) root.cursor = profileRow.index
            onClicked: root.openEdit(profileRow.index)
          }

          Text {
            id: profileGlyph
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: ""
            color: root.mutedForeground
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
            text: profileRow.modelData.name
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
          }

          Text {
            anchors.left: profileName.right
            anchors.leftMargin: Style.space(10)
            anchors.right: profileActions.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: profileName.verticalCenter
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
            text: root.accountText(profileRow.modelData.dir)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.problem(profileRow.modelData.dir) ? Color.urgent : root.mutedForeground
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
              tooltipText: "Edit  ·  Enter"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: root.openEdit(profileRow.index)
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

      SmallButton {
        text: "Add a Joplin Server account…"
        enabled: root.profiles.length < Model.MAX_PROFILES
        onClicked: root.openAdd()
      }

      Spacer {}

      Header {
        visible: root.available.length > 0 || (root.hostWidget && root.hostWidget.discovering)
        text: root.hostWidget && root.hostWidget.discovering && root.available.length === 0
          ? "LOOKING FOR JOPLIN PROFILES…" : "FOUND ON THIS COMPUTER"
      }

      Repeater {
        id: foundRepeater
        model: root.available

        delegate: CursorSurface {
          id: foundRow
          required property var modelData
          required property int index

          readonly property int row: root.profiles.length + foundRow.index

          width: listColumn.width
          height: Style.space(44)
          hasCursor: root.cursor === foundRow.row && !root.typing
          foreground: root.contentForeground

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: if (!root.typing) root.cursor = foundRow.row
            onClicked: root.addFound(foundRow.index)
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
            text: Model.profileKindLabel(foundRow.modelData.kind, root.home, foundRow.modelData.dir)
              + "  ·  " + Model.accountLine(foundRow.modelData.account)
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

      Spacer {}

      Header { text: "ADD A PROFILE DIRECTORY" }

      Caption {
        text: "For a Joplin started with --profile. Secondary instances and "
          + "in-app profiles appear above once Joplin has created them."
      }

      Row {
        spacing: Style.space(8)

        SmallField {
          id: pathField
          placeholderText: "~/path/to/profile"
          onAccepted: root.addPath(text)
          Keys.onEscapePressed: {
            text = ""
            root.returnFocus()
          }
        }

        SmallButton {
          text: "Add"
          enabled: pathField.text.trim() !== "" && root.profiles.length < Model.MAX_PROFILES
          onClicked: root.addPath(pathField.text)
        }
      }

      Spacer {}

      Header { text: "OPENING NOTES" }

      Caption {
        text: "Notes from the main instance open through the joplin:// link. Any "
          + "other profile is opened by starting Joplin with that profile's flags, "
          + "using this command. Change it if Joplin is installed under another "
          + "name, such as an AppImage."
      }

      SmallField {
        id: commandField
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

  // --- one profile ------------------------------------------------------------

  Flickable {
    id: editScroller
    anchors.fill: parent
    visible: root.mode === "edit"
    contentWidth: width
    contentHeight: editColumn.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height

    Column {
      id: editColumn
      width: editScroller.width
      spacing: Style.space(6)

      readonly property string dir: root.editing ? root.editing.dir : ""
      readonly property var info: root.infoFor(dir)
      readonly property string kind: Model.profileKind(root.home, dir)
      readonly property string launchReason: Model.openTarget(root.home, dir,
        root.hostWidget ? root.hostWidget.joplinCommand : "").reason

      Row {
        spacing: Style.space(8)

        PanelActionButton {
          iconText: ""
          tooltipText: "Back  ·  Esc"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          onClicked: root.showList()
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.editing ? root.editing.name : ""
          textFormat: Text.PlainText
          color: root.contentForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
        }
      }

      Spacer {}

      Header { text: "NAME" }

      SmallField {
        id: nameField
        placeholderText: "Shown in the panel header"
        onAccepted: {
          root.rename(text)
          root.returnFocus()
        }
        onActiveFocusChanged: if (!activeFocus) root.rename(text)
        Keys.onEscapePressed: {
          text = root.editing ? root.editing.name : ""
          root.returnFocus()
        }
      }

      Spacer {}

      Header { text: "SYNCS TO" }

      Text {
        width: parent.width
        text: {
          var info = editColumn.info
          if (!info) return root.hostWidget && root.hostWidget.discovering ? "…" : ""
          if (info.account.target > 0) return info.account.label
          if (!info.exists) return "Folder not found"
          return info.hasDatabase ? "Not syncing" : "No Joplin database here yet"
        }
        textFormat: Text.PlainText
        color: root.problem(editColumn.dir) ? Color.urgent : root.contentForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Caption {
        visible: text !== ""
        text: {
          var info = editColumn.info
          if (!info) return ""
          var lines = []
          if (info.account.location) lines.push("Server: " + info.account.location)
          if (info.account.user) lines.push("Email: " + info.account.user)
          if (root.notStarted(info)) {
            lines.push("Joplin has not started on this profile yet. Open it in Joplin "
              + "and enter the password under Tools → Options → Synchronisation.")
          }
          return lines.join("\n")
        }
      }

      Spacer {}

      Caption {
        text: editColumn.launchReason !== ""
          ? editColumn.launchReason
          : "The server, email and password belong to Joplin. To change them, open "
            + "this profile in Joplin and go to Tools → Options → Synchronisation."
      }

      SmallButton {
        text: "Open in Joplin"
        enabled: editColumn.launchReason === ""
        onClicked: if (root.hostWidget) root.hostWidget.launchJoplin(editColumn.dir)
      }

      Spacer {}

      Header { text: "LOCATION" }

      Caption {
        text: Model.profileKindLabel(editColumn.kind, root.home, editColumn.dir)
          + "\n" + Model.contractHome(editColumn.dir, root.home)
      }
    }
  }

  // --- a new account ----------------------------------------------------------

  Flickable {
    id: addScroller
    anchors.fill: parent
    visible: root.mode === "add"
    contentWidth: width
    contentHeight: addColumn.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height

    Column {
      id: addColumn
      width: addScroller.width
      spacing: Style.space(6)

      readonly property bool busy: !!root.hostWidget && root.hostWidget.creatingAccount
      readonly property string problem: Model.accountFormProblem(serverField.text, emailField.text)
      readonly property bool succeeded: !!root.hostWidget && root.hostWidget.accountMessage !== ""
        && !root.hostWidget.accountFailed

      Row {
        spacing: Style.space(8)

        PanelActionButton {
          iconText: "\uf060"
          tooltipText: "Back  ·  Esc"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          onClicked: root.showList()
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: "Add a Joplin Server account"
          textFormat: Text.PlainText
          color: root.contentForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
        }
      }

      Caption {
        text: "Each Joplin profile syncs to one server, so another server gets its own "
          + "Joplin: the secondary instance, in " + Model.contractHome(root.accountDir, root.home)
          + ". This sets it up for the server below and starts it. Joplin asks for "
          + "your password and keeps it; omajop never sees it."
      }

      Caption {
        visible: root.accountDirTaken && !addColumn.succeeded
        color: Color.urgent
        text: {
          var info = root.accountDirInfo
          var where = Model.contractHome(root.accountDir, root.home)
          var syncing = info && info.account.target > 0
            ? ", set up for " + Model.accountLine(info.account) : ""
          var listed = Model.indexOfProfile(root.profiles, root.accountDir) >= 0
          return "Joplin's secondary instance already exists in " + where + syncing + ". "
            + (listed ? "It is in your list; " : "Add it from Found on this computer, and ")
            + "change its server from its page, in Joplin. Another account needs its "
            + "own directory: start Joplin with --profile <directory>, then add that "
            + "directory to the list."
        }
      }

      Spacer {}

      Header { text: "NAME" }

      SmallField {
        id: accountNameField
        enabled: !root.accountDirTaken && !addColumn.busy
        placeholderText: "Personal"
        KeyNavigation.tab: serverField
        onAccepted: serverField.forceActiveFocus()
        Keys.onEscapePressed: root.showList()
      }

      Header { text: "SERVER" }

      SmallField {
        id: serverField
        enabled: !root.accountDirTaken && !addColumn.busy
        placeholderText: "notes.example.com"
        KeyNavigation.tab: emailField
        KeyNavigation.backtab: accountNameField
        onAccepted: emailField.forceActiveFocus()
        Keys.onEscapePressed: root.showList()
      }

      Header { text: "EMAIL" }

      SmallField {
        id: emailField
        enabled: !root.accountDirTaken && !addColumn.busy
        placeholderText: "you@example.com"
        KeyNavigation.backtab: serverField
        onAccepted: if (addColumn.problem === "") root.submitAccount()
        Keys.onEscapePressed: root.showList()
      }

      Spacer {}

      Row {
        spacing: Style.space(10)

        SmallButton {
          text: addColumn.busy ? "Creating…" : "Create and open Joplin"
          enabled: !root.accountDirTaken && !addColumn.busy && addColumn.problem === ""
          onClicked: root.submitAccount()
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          visible: (serverField.text !== "" || emailField.text !== "") && addColumn.problem !== ""
            && !root.accountDirTaken
          text: addColumn.problem
          textFormat: Text.PlainText
          color: root.mutedForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Caption {
        visible: !!root.hostWidget && root.hostWidget.accountMessage !== ""
        text: root.hostWidget ? root.hostWidget.accountMessage : ""
        color: root.hostWidget && root.hostWidget.accountFailed ? Color.urgent : root.contentForeground
      }
    }
  }
}
