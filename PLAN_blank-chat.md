# Plan: Blanker Chat [Create with Chat] + Fragment-Vorschau-Overlay + Personal-Space-Write-Tools

## Ziel

1. **Blanker Chat [Create with Chat]** im Personal Space (Sidebar-Panel, wie heute, aber ohne
   Resource-Pflicht). Der Assistent ist ein allgemeiner Helfer und darf im
   Personal Space **Dateien anlegen** (write_file, mkdir, rmdir) —
   Sicherheitseinstufung: personal-space-only, injiziert vom Taki-Server nur
   wenn `context.write` gesetzt.
2. **Fragment-Vorschau**: Wenn der Assistent Code/Apps erzeugt (HTML-Codeblock in
   der Antwort), erscheint ein **`[ ]`-Symbol** neben dem Fragment. Klick →
   **Overlay im Mittelbereich** rendert den Code als Live-Vorschau (sandboxed iframe).
   Der Chat bleibt in der Sidebar, das Overlay schwebt über dem Dateibereich.

## Architektur-Entscheidung (verifiziert)

| Baustein | Entscheidung |
|---|---|
| Blanker Chat [Create with Chat] | Sidebar-Panel, `isVisible` ohne Selection-Pflicht im Personal Space. `ChatPanel` bekommt `mode: 'folder' \| 'file' \| 'blank'`. Kein `context.share`, optional `context.write`. |
| Fragment-Vorschau-Overlay | **Keine App, kein appCompact, keine Route.** ChatPanel (Sidebar) rendert HTML-Codeblöcke mit einem `[]`-Button. Klick → `PreviewOverlay.vue` wird als **fixed-Overlay** über dem Mittelbereich gezeichnet (`position: fixed; right: 0; top: 0; bottom: 0; width: calc(100% - 400px)` — Sidebar-Breite abziehen, oder `inset: 0` mit höherer z-index). Sandbox-iframe (`sandbox="allow-scripts"`, `srcdoc`). ESC/X schließt. |
| Write-Ausführung | **Taki serverseitig** über den bereits wiederhergestellten User-JWT (`userWebDav`, Base `http://127.0.0.1:9115`, Header `x-access-token`). Neue Methoden: `mkcol` (MKCOL), `put` (PUT), `delete` (HTTP DELETE — leere Verzeichnisse). |
| Personal-Space-Only | Client-Gate: `driveType === 'personal'` → `context.write: { root: "workspace/" }`. Taki: Write-Tools werden **nur** injiziert wenn `context.write` vorhanden; Pfad-Safety serverseitig (alles außerhalb `workspace/` blockiert). Kein Tool → kein Prompt → keine Eskalation. Die KI legt innerhalb von `workspace/` ein Projektverzeichnis an. |
| Ordner-Chat (bestehend) | Unverändert. `context.write` nicht gesetzt → kein Write-Tool. Read-Tools brauchen weiterhin `context.share` (view-Link). |

## Phasen

### Phase A — Blanker Chat „Create with Chat" (Extension, kein Taki-Build)

**A1. Entry Point: „Neu"-Menü** (`src/index.ts`)
- Extension registriert eine `createNewAction`-Extension auf
  `app.files.create-new-action`:
  ```ts
  {
    id: `${APP_ID}.create-new-chat`,
    extensionPointIds: ['app.files.create-new-action'],
    type: 'createNewAction',
    isActive: () => {
      // Nur im Personal Space (driveType === 'personal')
      const { currentSpace } = storeToRefs(useSpacesStore())
      return unref(currentSpace)?.driveType === 'personal'
    },
    mode: 'handler',
    label: () => $pgettext('New menu item label', 'Create with Chat'),
    icon: 'message',
    handler: () => {
      resourcesStore.clearSelection()
      sideBarStore.openSideBarPanel(APP_ID)
    }
  }
  ```
- Zusätzlich: `registerFileExtension` mit `newFileMenu` für den
  `CreateOrUploadMenu`-Dropdown (wird von `useFileActionsCreateNewFile`
  gelesen, wenn `mode: 'drop'` aktiv ist):
  ```ts
  useAppsStore().registerFileExtension({
    appId: APP_ID,
    data: {
      app: APP_ID,
      extension: 'chat',
      label: () => $pgettext('New menu file type label', 'Create with Chat'),
      name: $pgettext('New menu file type name', 'Chat'),
      icon: 'message',
      mimeType: 'application/x-chat',
      newFileMenu: {
        menuTitle: () => $pgettext('New menu group title', 'Create with Chat')
      },
      createFileHandler: ({ space }) => {
        // Guard: nur personal
        if (space.driveType !== 'personal') {
          throw new Error('Create with Chat is only available in your personal space')
        }
        resourcesStore.clearSelection()
        sideBarStore.openSideBarPanel(APP_ID)
        // Dummy-Resource zurückgeben (wird nicht als Datei gespeichert)
        return {
          id: 'chat-blank',
          name: 'Create with Chat',
          path: '/',
          isFolder: false,
          extension: 'chat',
          mimeType: 'application/x-chat'
        } as unknown as Resource
      }
    }
  })
  ```
- **Wirkungslogik**:
  - `mode: 'handler'` → der „Neu"-Button in der Toolbar wird direkt zum
    „Create with Chat"-Handler (kein Dropdown). `isActive` nur im Personal Space.
  - `mode: 'drop'` (Default, wenn keine `createNewAction`-Extension mit
    `isActive: true` gefunden wird) → `CreateOrUploadMenu` rendert den
    `newFileMenu`-Eintrag als zusätzlichen Menüpunkt im Dropdown.
  - Beide Wege führen zu: Selection leeren + Sidebar-Panel öffnen.
- `ChatPanel`-Prop `mode: 'folder' | 'file' | 'blank'` (abgeleitet aus `resource`):
  - `resource === null` → `'blank'`
  - `resource.isFolder` → `'folder'`
  - else → `'file'`

**A2. Blank-Chat-Logik** (`src/composables/useChat.ts`)
- `sendBlankMessage()` (neben `sendFolderMessage()`):
  - **kein** `context.share` (kein Link-Share, kein Public-Link → kein Personal-Root-Problem)
  - `context.write: { root: "workspace/" }` **nur** wenn Personal Space aktiv
  - `context.folder_name: ""` (Taki nutzt Blank-Prompt, Phase B)
  - Model-Auswahl wie heute (localStorage `cwf.selectedModel`)
- Chat-Historie: in-memory wie heute (Sidebar-Panel-Lifecycle).

**A2a. Workspace-Verzeichnis**
- Beim ersten „Create with Chat" im Personal Space: `webdav.createFolder(personalSpace, { path: "workspace" })`
  (405/409 → schon vorhanden, ignorieren). Danach `context.write.root = "workspace/"`.
- Die KI legt innerhalb von `workspace/` ihr eigenes Projektverzeichnis an:
  `workspace/<projektname>/`. Projektname wird vom Modell aus dem Kontext abgeleitet
  (z.B. „Raketenstart-Calculator" → `workspace/raketenstart-calculator/`).
- Taki-Prompt (Phase B): „Lege zuerst ein Projektverzeichnis unter deinem Arbeitsbereich
  an (mkdir), dann erstelle die Dateien darin. Der Verzeichnisname soll kurz und
  beschreibend sein (klein, Bindestriche, keine Leerzeichen)."
- `context.write.root = "workspace/"` → Taki `safeWritePath` verbietet alles außerhalb
  von `workspace/`. Die KI kann `workspace/` selbst nicht löschen oder überschreiben,
  aber darin beliebig `mkdir`/`write_file`/`rmdir` (innerhalb des depth-Limits).

**A3. ChatPanel-Anpassung** (`src/components/ChatPanel.vue`)
- `mode === 'blank'`:
  - Platzhalter: „Frag mich was oder sag mir, was ich für dich erstellen soll."
  - Kein Save-Button (saveAnswer bleibt für File-Chat)
- Fragment-Vorschau-Button: siehe Phase C

**A4. Build + Deploy**
- `job.py build-web` → `deploy_zip.sh` → `nu packages pull` + `nu compose --auto-apply`
- Test: Personal Space → „Neu"-Button → „Create with Chat" → Panel ohne Resource,
  Frage stellen. Team/Project Space: Eintrag nicht sichtbar.

### Phase B — Taki Write-Tools (Server, Personal-Space-Only)

**B1. Config** (`chat.go` ChatConfig)
```go
type ChatWriteConfig struct {
    MaxFileBytes int `yaml:"max_file_bytes"` // default 1_048_576 (1 MB)
    MaxDepth     int `yaml:"max_depth"`      // default 3
}
```
- `ChatConfig.Write ChatWriteConfig` (yaml: `chat.write:`)

**B2. Request-Extension** (`chatAskRequest`)
```go
Context struct {
    ...
    Write struct {
        Root string `json:"root"` // z.B. "/", "AI/"
    } `json:"write"`
}
```
- `context.write` vorhanden → Write-Modus. `Root` normalisiert (leading/trailing
  Slash, kein `..`).

**B3. `userWebDav`-Write-Methoden** (`chat.go`)
- `mkcol(path string) error`
- `putFile(path string, content []byte) error`
- `deletePath(path string) error` (409 → „Ordner nicht leer")
- Pfad-Safety: `safeWritePath(root, relPath)` — verbietet `..`, absolute Pfade,
  Tiefen-Limit

**B4. Tool-Definitionen** (`chatTools()` — nur wenn `context.write` gesetzt)
- `write_file(path, content)` — max `max_file_bytes`
- `mkdir(path)`
- `rmdir(path)` — nur leere Verzeichnisse
- `runChatTool`: neue Cases; `u == nil` → „Schreiben nicht verfügbar"
- tool_trace: `tool`, `path`, `chars`

**B5. System-Prompt** (`chat_system_blank.txt` im `taki-prompts`-Paket)
- Platzhalter: `{{root}}` (z.B. `workspace/`), `{{tools_write}}`
- Inhalt:
  - „Du bist ein Assistent im persönlichen Cloud-Bereich des Users."
  - „Dein Arbeitsbereich ist `{{root}}`. Lege zuerst ein Projektverzeichnis an
     (mkdir), dann erstelle die Dateien darin."
  - „Der Projekt-Verzeichnisname soll kurz und beschreibend sein
     (klein, Bindestriche, keine Leerzeichen), abgeleitet aus dem Auftrag."
  - „Erstelle maximal eine Datei pro Antwort, es sei der User fragt nach mehr."
  - „Für Apps/Websites: eine einzelne HTML-Datei (HTML+CSS+JS inline)."
  - „Nach write_file: gib den vollen Pfad in der Antwort an
     (z.B. workspace/raketenstart-calculator/index.html)."
  - „Rückfragen vor write_file (present_options), nicht danach."
- `loadChatSystemPrompt` lädt `chat_system_blank.txt` (optional)
- `renderChatSystemPrompt` bekommt `blank bool` → wählt Template

**B6. Loop-Integration** (`handleChatAsk`)
- `context.write` vorhanden:
  - Write-Tools injizieren, Blank-Prompt
  - `context.share` NICHT required → `d *shareWebDav = nil` erlaubt
  - Read-Tools bei `d == nil`: „Ordnerfreigabe nicht vorhanden"
- `context.write` NICHT vorhanden: exakt wie heute

**B7. Build + Deploy**
- `job.py build-pod` (open_taki) → Pin → `nu compose --auto-apply`
- `push_prompts.sh` → `nu packages pull`
- Test: `curl /chat-direct/ask` mit `context.write` → „Erstelle hello.md"

### Phase C — Fragment-Vorschau-Overlay

**C1. HTML-Codeblock-Erkennung** (`src/utils/markdown.ts`)
- markdown-it Custom Renderer für `fence`-Blocks:
  - Language `html`/`htm`/`html5` → rendert `<div class="chat-fragment">` mit:
    - Header: `[]`-Button (Preview) + Codeblock (einklappbar, `<details>`)
    - `data-fragment`-Attribut mit dem rohen HTML-Content (base64-encodiert,
      um Attribute-Quoting-Probleme zu vermeiden)
  - Andere Languages → wie heute (normaler Codeblock)

**C2. PreviewOverlay** (neue Komponente `PreviewOverlay.vue`)
- Wird von `ChatPanel` vorgehalten (nicht teleportiert, sondern direkt im
  Panel-DOM, aber `position: fixed`):
  ```css
  .preview-overlay {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    /* Sidebar-Breite: 400px (Host-Standard), abziehen damit das Overlay
       den Mittelbereich füllt, die Sidebar weiterhin sichtbar bleibt */
    left: 400px;
    z-index: calc(var(--oc-z-index-modal, 1000) + 100);
    background: var(--oc-color-surface-container, #fff);
    display: flex; flex-direction: column;
  }
  ```
  - Auf Mobile (`max-width: 767px`): `left: 0` (Sidebar ist dann eh weg)
- Inhalt:
  - Header: Titel (aus `<title>`-Tag parsen, Fallback „Vorschau"),
    Download-Button (Blob), Close (X + ESC)
  - `iframe` mit `sandbox="allow-scripts"` (keine `allow-same-origin`),
    `srcdoc` = Fragment-Content
  - Footer: Dateinamen-Hinweis + „In Cloud speichern"-Button (optional, Phase D)

**C3. Interaktion** (`ChatPanel.vue`)
- Click auf `[]`-Button → `previewOverlay.visible = true`,
  `previewOverlay.content = <base64-decoded HTML>`
- ESC / X → `previewOverlay.visible = false`
- Nur **ein** Overlay gleichzeitig (neuer Klick ersetzt den Inhalt)

**C4. Download + Save**
- Download: `new Blob([html], {type: 'text/html'})` → `URL.createObjectURL` →
  `<a download="vorschau.html">`
- „In Cloud speichern" (optional, Phase D): `webdav.putFileContents` in den
  Personal Space (Pfad: `AI/<timestamp>_<name>.html` oder aus dem Chat-Kontext)

## Reihenfolge + Dependencies

```
Phase A (Blanker Chat)             ──→  Extension-Deploy, Test ohne Write
Phase B (Taki Write-Tools)         ──→  Taki-Build + prompts, Test per curl
Phase A+B (Blank-Chat + Write)     ──→  Extension-Deploy, E2E
Phase C (Fragment-Vorschau)        ──→  Extension-Deploy, E2E
```

Phasen A, B, C sind alle unabhängig und parallelisierbar.
C funktioniert auch ohne A/B (im bestehenden Ordner-/Datei-Chat).

## Offene Punkte / Risiken

1. **`isVisible` ohne Selection**: Die Sidebar-Panel-API prüft `isVisible` mit
   `items`. Ohne Selection ist `items` leer → Panel unsichtbar. Lösung:
   Context-Action „Create with Chat" auf der Space-Root (Ordner mit `path === '/'`),
   der die Selection leert und das Panel öffnet. `ChatPanel` rendert dann
   im blank-Modus (`resource === null`).
2. **Overlay-Linke Grenze**: Die Sidebar-Breite ist im Host `400px`
   (FileSideBar). Das Overlay muss diese Breite respektieren. Fallback:
   `inset: 0` + Sidebar weiterhin darüber (z-index der Sidebar > Overlay).
   Testen im Kosmos-Host.
3. **`context.share` optional in Taki** (chat.go:1497): Bei `context.write`
   darf der fehlende Share kein Fehler sein. Read-Tools melden dann
   „Ordnerfreigabe nicht vorhanden".
4. **iframe-Sandbox**: `sandbox="allow-scripts"` ohne `allow-same-origin` →
   das gerenderte HTML hat keinen Zugriff auf Cookies, localStorage, parent-DOM.
   Google-Fonts-Requests (extern) funktionieren weiterhin (CORS-frei für CSS).
   APIs/fetch vom gerenderten Code aus: blockiert (kein Same-Origin).
5. **Write-Tool + present_options**: Rückfragen VOR write_file (im Prompt
   verankert), nicht danach.

## Dateien (Betroffen)

**Extension** (`noetron_chat-with-file`):
- `src/index.ts` — Context-Action „Create with Chat", `mode`-Ableitung
- `src/components/ChatPanel.vue` — `mode`-Prop, blank-UI, `[]`-Button,
  `PreviewOverlay`-Integration
- `src/composables/useChat.ts` — `sendBlankMessage()`, `context.write`
- `src/utils/markdown.ts` — Custom fence-Renderer für HTML-Codeblöcke
- `src/components/PreviewOverlay.vue` — **neu**
- `src/l10n/translations.json` — neue Strings

**Taki** (`open_taki`):
- `chat.go` — `ChatWriteConfig`, `context.write`, `userWebDav` Write-Methoden,
  `chatTools()` Write-Tools, `runChatTool` Write-Cases, `handleChatAsk`
  share-optional, `renderChatSystemPrompt` blank-Variante
- `chat_system_blank.txt` — **neu** (im Repo + `push_prompts.sh` PROMPT_FILES)
- `config.yaml` — `chat.write:` Block (Dokumentation)
