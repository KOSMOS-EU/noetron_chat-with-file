# noetron chat-with-file

OpenCloud Web Extension: Chat/Edit von Dateien per LLM.

## Herkunft

Basiert auf [owncloud/web-extensions/packages/web-app-chat-with-file](https://github.com/owncloud/web-extensions/tree/main/packages/web-app-chat-with-file) (Apache-2.0).

### Aenderungen gegenueber Upstream

| Datei | Aenderung |
|-------|-----------|
| package.json | `@ownclouders/*` → `@opencloud-eu/*`, standalone deps |
| vite.config.ts | `@ownclouders/extension-sdk` → `@opencloud-eu/extension-sdk`, rollupOptions entfernt (SDK defaults) |
| tsconfig.json | standalone (kein extends auf Workspace-Root) |
| src/index.ts | `@ownclouders/web-pkg` → `@opencloud-eu/web-pkg`, `@ownclouders/web-client` → `@opencloud-eu/web-client` |
| src/composables/useChat.ts | `@ownclouders/web-pkg` → `@opencloud-eu/web-pkg` |
| public/manifest.json | entfernt (SDK generiert es) |

Keine funktionalen Aenderungen am Code.

## Features

- **Chat**: Q&A ueber Dateiinhalte (PDF, TXT, MD)
- **Edit**: LLM-basiertes Rewriting mit Diff-Preview + Apply/Discard
- **Modellwahl**: oc-Select im Chat-Panel (nur sichtbar ab 2 Modellen), Auswahl in localStorage persistiert
- **Thinking-Toggle**: Chain-of-Thought pro Session ein/aus, in localStorage persistiert
- PDF-Text-Extraktion client-seitig (PDF.js)
- Session-Cache fuer Chat-History
- ETag-basierte Concurrency-Kontrolle beim Schreiben

## Config

In der OpenCloud Web-App-Config (`web.yaml` oder `apps.yaml`):

```yaml
chat-with-file:
  config:
    llm:
      endpoint: "https://cloud.example.com/ai-chat/v1"
      models:
        - id: local-ocr
          label: "Qwen 3.5 (122B)"
          model: local-ocr
        - id: local-ocr2
          label: "Qwen 3.8 (27B)"
          model: local-ocr2
```

- `model` ist der Name, der an den Endpoint geschickt wird (typischerweise eine
  microllm-Alias-Gruppe, z.B. `local-ocr` — das Loadbalancing uebernommt microllm).
- `id` ist der stabile Key fuer die Auswahl-Persistenz (Default: `model`).
- `label` ist der Anzeigename im Modell-Selektor (Default: `model`).
- Ab 2 Modellen erscheint ein oc-Select im Chat-Panel; die Auswahl wird pro
  Browser in localStorage gemerkt (`cwf.selectedModel`).
- **Backward-Compat**: ein nacktes `model: "local-ocr"` (ohne `models:`) wird
  intern in eine 1-Element-Liste normalisiert — alte Configs laufen unveraendert.
- Ohne `endpoint` oder ohne mindestens ein gueltiges Modell bleibt die Extension
  im "unconfigured"-Zustand.

Endpoint muss same-origin sein (Browser schickt Bearer-Token mit).

### Thinking (Chain of Thought)

Der "Think"-Schalter im Chat-Panel toggelt das Modell-Reasoning. Er wirkt
ab der naechsten Nachricht und wird pro Browser in localStorage gemerkt
(`cwf.thinking`, Default: aus).

Jeder Request sendet das Ergebnis **explizit** — nie wird auf den
Server-Default verlassen:

```json
{ "chat_template_kwargs": { "enable_thinking": true } }
```

- `enable_thinking` wird pro Request gesetzt (true/false).
- `max_tokens` ist bei Thinking an auf 16384 erhoht (Thinking-Tokens brauchen
  Ausgabebudget), sonst 4096.
- `reasoning_effort` wird NICHT gesendet — die Denktiefe bleibt beim
  nativen Default des Modells (unterschiedlich je Modell).
- Voraussetzungen: das Modell-Template muss `enable_thinking` unterstuetzen
  (Qwen3.5/3.8: ja) und vLLM laeuft mit `--reasoning-parser`, damit die
  CoT-Tokens nicht in `content` landen.

## Build

```bash
pnpm install
pnpm build
# -> dist/ mit manifest.json + js/ + assets/
```

## Deploy

```bash
../kosmos-nuhost-deploy/job.py build-web
../kosmos-nuhost-deploy/deploy_zip.sh
```
