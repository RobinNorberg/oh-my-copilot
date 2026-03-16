[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [Türkçe](README.tr.md) | Deutsch | [Français](README.fr.md) | [Italiano](README.it.md)

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Multi-Agenten-Orchestrierung für Copilot CLI. Null Lernkurve.**

_Lernen Sie nicht Copilot CLI. Nutzen Sie einfach OMP._

[Loslegen](#schnellstart) • [Dokumentation](https://docs/REFERENCE.md) • [Migrationsleitfaden](docs/MIGRATION.md)

---

## Schnellstart

**Schritt 1: Installation**

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Schritt 2: Einrichtung**

```bash
/oh-my-copilot:omg-setup
```

**Schritt 3: Etwas bauen**

```
autopilot: build a REST API for managing tasks
```

Das war's. Alles andere passiert automatisch.

## Team Mode (Empfohlen)

Ab **v4.1.7** ist **Team** die kanonische Orchestrierungsoberfläche in OMP. Legacy-Einstiegspunkte wie **swarm** und **ultrapilot** werden weiterhin unterstützt, **leiten aber im Hintergrund an Team weiter**.

```bash
/oh-my-copilot:team 3:executor "fix all TypeScript errors"
```

Team läuft als gestufte Pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Aktivieren Sie Copilot CLI native Teams in `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Wenn Teams deaktiviert sind, warnt OMP Sie und fällt auf Ausführung ohne Team zurück, wenn möglich.

> **Hinweis: Paketbenennung** — Das Projekt nutzt die Marke **oh-my-copilot** (Repo, Plugin, Befehle), aber das npm-Paket wird als [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot) veröffentlicht. Wenn Sie die CLI-Tools über npm/bun installieren, verwenden Sie `npm install -g oh-my-copilot`.

### Aktualisierung

```bash
# 1. Plugin aktualisieren
/plugin install oh-my-copilot

# 2. Setup erneut ausführen, um Konfiguration zu aktualisieren
/oh-my-copilot:omg-setup
```

Bei Problemen nach der Aktualisierung leeren Sie den alten Plugin-Cache:

```bash
/oh-my-copilot:omg-doctor
```

<h1 align="center">Ihr Copilot hat gerade Superkräfte erhalten.</h1>

<p align="center">
  <img src="assets/omg-character.jpg" alt="oh-my-copilot" width="400" />
</p>

---

## Warum oh-my-copilot?

- **Keine Konfiguration nötig** — Funktioniert sofort mit intelligenten Standardwerten
- **Team-first-Orchestrierung** — Team ist die kanonische Multi-Agenten-Oberfläche (swarm/ultrapilot sind Kompatibilitätsfassaden)
- **Natürliche Sprachschnittstelle** — Keine Befehle auswendig lernen, beschreiben Sie einfach, was Sie wollen
- **Automatische Parallelisierung** — Komplexe Aufgaben werden auf spezialisierte Agenten verteilt
- **Beharrliche Ausführung** — Gibt nicht auf, bis die Arbeit verifiziert und abgeschlossen ist
- **Kostenoptimierung** — Intelligentes Model-Routing spart 30-50% an Tokens
- **Aus Erfahrung lernen** — Extrahiert und wiederverwendet automatisch Problemlösungsmuster
- **Echtzeit-Sichtbarkeit** — HUD statusline zeigt, was im Hintergrund passiert

---

## Funktionen

### Orchestrierungsmodi

Mehrere Strategien für verschiedene Anwendungsfälle — von Team-gestützter Orchestrierung bis token-effizientem Refactoring. [Mehr erfahren →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Modus                             | Beschreibung                                                                               | Verwendung                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Team (empfohlen)**              | Kanonische gestufte Pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Koordinierte Agenten mit gemeinsamer Aufgabenliste                                   |
| **Autopilot**                     | Autonome Ausführung (einzelner Leitagent)                                                  | End-to-End-Feature-Arbeit mit minimalem Aufwand                                      |
| **Ultrawork**                     | Maximale Parallelität (ohne Team)                                                          | Parallele Fixes/Refactorings, wenn Team nicht nötig ist                              |
| **Ralph**                         | Beharrlicher Modus mit Verify/Fix-Schleifen                                                | Aufgaben, die vollständig abgeschlossen werden müssen (keine stillen Teilergebnisse) |
| **Ecomode**                       | Token-effizientes Routing                                                                  | Budget-bewusste Iteration                                                            |
| **Pipeline**                      | Sequentielle, gestufte Verarbeitung                                                        | Mehrstufige Transformationen mit strikter Reihenfolge                                |
| **Swarm / Ultrapilot (veraltet)** | Kompatibilitätsfassaden, die an **Team** weiterleiten                                      | Bestehende Workflows und ältere Dokumentation                                        |

### Intelligente Orchestrierung

- **32 spezialisierte Agenten** für Architektur, Forschung, Design, Tests, Data Science
- **Intelligentes Model-Routing** — Haiku für einfache Aufgaben, Opus für komplexes Reasoning
- **Automatische Delegation** — Immer der richtige Agent für die richtige Aufgabe

### Entwicklererfahrung

- **Magische Schlüsselwörter** — `ralph`, `ulw`, `eco`, `plan` für explizite Steuerung
- **HUD statusline** — Echtzeit-Orchestrierungsmetriken in Ihrer Statusleiste
- **Skill-Lernen** — Wiederverwendbare Muster aus Ihren Sitzungen extrahieren
- **Analytik & Kostenverfolgung** — Token-Nutzung über alle Sitzungen verstehen

[Vollständige Feature-Liste →](docs/REFERENCE.md)

---

## Magische Schlüsselwörter

Optionale Abkürzungen für Power-User. Natürliche Sprache funktioniert auch ohne sie.

| Schlüsselwort | Effekt                                           | Beispiel                                                        |
| ------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `team`        | Kanonische Team-Orchestrierung                   | `/oh-my-copilot:team 3:executor "fix all TypeScript errors"` |
| `autopilot`   | Vollständig autonome Ausführung                  | `autopilot: build a todo app`                                   |
| `ralph`       | Beharrlichkeitsmodus                             | `ralph: refactor auth`                                          |
| `ulw`         | Maximale Parallelität                            | `ulw fix all errors`                                            |
| `eco`         | Token-effiziente Ausführung                      | `eco: migrate database`                                         |
| `plan`        | Planungsinterview                                | `plan the API`                                                  |
| `ralplan`     | Iterativer Planungskonsens                       | `ralplan this feature`                                          |
| `swarm`       | Veraltetes Schlüsselwort (leitet an Team weiter) | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot`  | Veraltetes Schlüsselwort (leitet an Team weiter) | `ultrapilot: build a fullstack app`                             |

**Hinweise:**

- **ralph beinhaltet ultrawork**: Wenn Sie den ralph-Modus aktivieren, beinhaltet er automatisch die parallele Ausführung von ultrawork.
- Die Syntax `swarm N agents` wird weiterhin für die Agentenanzahl-Extraktion erkannt, aber die Laufzeitumgebung basiert in v4.1.7+ auf Team.

## Hilfsprogramme

### Rate Limit Wartezeit

Automatische Wiederaufnahme von Copilot CLI Sitzungen, wenn Rate Limits zurückgesetzt werden.

```bash
omc wait          # Status prüfen, Anleitung erhalten
omc wait --start  # Auto-Resume-Daemon aktivieren
omc wait --stop   # Daemon deaktivieren
```

**Voraussetzung:** tmux (für Sitzungserkennung)

### Benachrichtigungs-Tags (Telegram/Discord)

Sie können konfigurieren, wer getaggt wird, wenn Stop-Callbacks Sitzungszusammenfassungen senden.

```bash
# Tag-Liste festlegen/ersetzen
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Inkrementelle Aktualisierungen
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Tag-Verhalten:

- Telegram: `alice` wird zu `@alice` normalisiert
- Discord: unterstützt `@here`, `@everyone`, numerische Benutzer-IDs und `role:<id>`
- `file`-Callbacks ignorieren Tag-Optionen

---

## Dokumentation

- **[Vollständige Referenz](docs/REFERENCE.md)** — Umfassende Feature-Dokumentation
- **[Performance-Monitoring](docs/PERFORMANCE-MONITORING.md)** — Agentenverfolgung, Debugging und Optimierung
- **[Website](https://docs/REFERENCE.md)** — Interaktive Anleitungen und Beispiele
- **[Migrationsleitfaden](docs/MIGRATION.md)** — Upgrade von v2.x
- **[Architektur](docs/ARCHITECTURE.md)** — Wie es unter der Haube funktioniert

---

## Voraussetzungen

- [Copilot CLI](https://docs.github.com/copilot-cli) CLI
- Copilot Max/Pro-Abonnement ODER Anthropic API-Schlüssel

### Optional: Multi-AI-Orchestrierung

OMP kann optional externe AI-Anbieter für Kreuzvalidierung und Design-Konsistenz orchestrieren. Diese sind **nicht erforderlich** — OMP funktioniert vollständig ohne sie.

| Anbieter                                                  | Installation                        | Was es ermöglicht                                |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Design-Review, UI-Konsistenz (1M Token Kontext)  |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Architekturvalidierung, Code-Review-Gegenprüfung |

**Kosten:** 3 Pro-Pläne (Copilot + Gemini + ChatGPT) decken alles für ca. $60/Monat ab.

---

## Lizenz

MIT

---

<div align="center">

**Inspiriert von:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli)

**Null Lernkurve. Maximale Leistung.**

</div>

