[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [Türkçe](README.tr.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Italiano

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Orchestrazione multi-agente per Copilot CLI. Zero curva di apprendimento.**

_Non imparare Copilot CLI. Usa semplicemente OMP._

[Inizia](#avvio-rapido) • [Documentazione](https://docs/REFERENCE.md) • [Guida alla migrazione](docs/MIGRATION.md)

---

## Avvio rapido

**Passo 1: Installazione**

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Passo 2: Configurazione**

```bash
/oh-my-copilot:omg-setup
```

**Passo 3: Costruisci qualcosa**

```
autopilot: build a REST API for managing tasks
```

Tutto qui. Il resto è automatico.

## Team Mode (Consigliato)

A partire dalla **v4.1.7**, **Team** è la superficie di orchestrazione canonica in OMP. I punti di ingresso legacy come **swarm** e **ultrapilot** sono ancora supportati, ma ora **vengono instradati a Team dietro le quinte**.

```bash
/oh-my-copilot:team 3:executor "fix all TypeScript errors"
```

Team funziona come una pipeline a stadi:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Abilita i team nativi di Copilot CLI in `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Se i team sono disabilitati, OMP ti avviserà e passerà all'esecuzione senza Team quando possibile.

> **Nota: Nome del pacchetto** — Il progetto utilizza il brand **oh-my-copilot** (repo, plugin, comandi), ma il pacchetto npm è pubblicato come [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot). Se installi gli strumenti CLI tramite npm/bun, usa `npm install -g oh-my-copilot`.

### Aggiornamento

```bash
# 1. Aggiorna il plugin
/plugin install oh-my-copilot

# 2. Riesegui il setup per aggiornare la configurazione
/oh-my-copilot:omg-setup
```

Se riscontri problemi dopo l'aggiornamento, svuota la vecchia cache del plugin:

```bash
/oh-my-copilot:omg-doctor
```

<h1 align="center">Il tuo Copilot ha appena ricevuto dei superpoteri.</h1>

<p align="center">
  <img src="assets/omg-character.jpg" alt="oh-my-copilot" width="400" />
</p>

---

## Perché oh-my-copilot?

- **Nessuna configurazione richiesta** — Funziona immediatamente con impostazioni predefinite intelligenti
- **Orchestrazione team-first** — Team è la superficie multi-agente canonica (swarm/ultrapilot sono facciate di compatibilità)
- **Interfaccia in linguaggio naturale** — Nessun comando da memorizzare, descrivi semplicemente ciò che vuoi
- **Parallelizzazione automatica** — Le attività complesse vengono distribuite tra agenti specializzati
- **Esecuzione persistente** — Non si arrende finché il lavoro non è verificato e completato
- **Ottimizzazione dei costi** — Il routing intelligente dei modelli risparmia dal 30 al 50% sui token
- **Apprendimento dall'esperienza** — Estrae e riutilizza automaticamente i pattern di risoluzione dei problemi
- **Visibilità in tempo reale** — La HUD statusline mostra cosa succede dietro le quinte

---

## Funzionalità

### Modalità di orchestrazione

Strategie multiple per diversi casi d'uso — dall'orchestrazione basata su Team al refactoring efficiente in termini di token. [Scopri di più →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Modalità                        | Descrizione                                                                             | Utilizzo                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Team (consigliato)**          | Pipeline canonica a stadi (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agenti coordinati che lavorano su una lista di attività condivisa                        |
| **Autopilot**                   | Esecuzione autonoma (singolo agente leader)                                             | Sviluppo di funzionalità end-to-end con cerimonia minima                                 |
| **Ultrawork**                   | Parallelismo massimo (senza Team)                                                       | Correzioni/refactoring paralleli in burst quando Team non è necessario                   |
| **Ralph**                       | Modalità persistente con cicli verify/fix                                               | Attività che devono essere completate interamente (nessun risultato parziale silenzioso) |
| **Ecomode**                     | Routing efficiente in termini di token                                                  | Iterazione attenta al budget                                                             |
| **Pipeline**                    | Elaborazione sequenziale a stadi                                                        | Trasformazioni multi-step con ordine rigoroso                                            |
| **Swarm / Ultrapilot (legacy)** | Facciate di compatibilità che instradano a **Team**                                     | Workflow esistenti e documentazione precedente                                           |

### Orchestrazione intelligente

- **32 agenti specializzati** per architettura, ricerca, design, test, data science
- **Routing intelligente dei modelli** — Haiku per attività semplici, Opus per ragionamento complesso
- **Delega automatica** — L'agente giusto per il lavoro giusto, ogni volta

### Esperienza sviluppatore

- **Parole chiave magiche** — `ralph`, `ulw`, `eco`, `plan` per un controllo esplicito
- **HUD statusline** — Metriche di orchestrazione in tempo reale nella barra di stato
- **Apprendimento delle competenze** — Estrazione di pattern riutilizzabili dalle sessioni
- **Analisi e tracciamento dei costi** — Comprensione dell'utilizzo dei token su tutte le sessioni

[Lista completa delle funzionalità →](docs/REFERENCE.md)

---

## Parole chiave magiche

Scorciatoie opzionali per utenti avanzati. Il linguaggio naturale funziona bene anche senza di esse.

| Parola chiave | Effetto                                   | Esempio                                                         |
| ------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `team`        | Orchestrazione Team canonica              | `/oh-my-copilot:team 3:executor "fix all TypeScript errors"` |
| `autopilot`   | Esecuzione completamente autonoma         | `autopilot: build a todo app`                                   |
| `ralph`       | Modalità persistente                      | `ralph: refactor auth`                                          |
| `ulw`         | Parallelismo massimo                      | `ulw fix all errors`                                            |
| `eco`         | Esecuzione efficiente in termini di token | `eco: migrate database`                                         |
| `plan`        | Intervista di pianificazione              | `plan the API`                                                  |
| `ralplan`     | Consenso di pianificazione iterativo      | `ralplan this feature`                                          |
| `swarm`       | Parola chiave legacy (instrada a Team)    | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot`  | Parola chiave legacy (instrada a Team)    | `ultrapilot: build a fullstack app`                             |

**Note:**

- **ralph include ultrawork**: quando attivi la modalità ralph, include automaticamente l'esecuzione parallela di ultrawork.
- La sintassi `swarm N agents` è ancora riconosciuta per l'estrazione del numero di agenti, ma il runtime è basato su Team nella v4.1.7+.

## Utilità

### Attesa rate limit

Riprendi automaticamente le sessioni Copilot CLI quando i rate limit vengono ripristinati.

```bash
omc wait          # Controlla lo stato, ottieni indicazioni
omc wait --start  # Abilita il daemon di ripristino automatico
omc wait --stop   # Disabilita il daemon
```

**Requisiti:** tmux (per il rilevamento della sessione)

### Tag di notifica (Telegram/Discord)

Puoi configurare chi viene taggato quando i callback di stop inviano i riepiloghi della sessione.

```bash
# Imposta/sostituisci la lista dei tag
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Aggiornamenti incrementali
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Comportamento dei tag:

- Telegram: `alice` viene normalizzato in `@alice`
- Discord: supporta `@here`, `@everyone`, ID utente numerici e `role:<id>`
- I callback di tipo `file` ignorano le opzioni dei tag

---

## Documentazione

- **[Riferimento completo](docs/REFERENCE.md)** — Documentazione completa delle funzionalità
- **[Monitoraggio delle prestazioni](docs/PERFORMANCE-MONITORING.md)** — Tracciamento degli agenti, debugging e ottimizzazione
- **[Sito web](https://docs/REFERENCE.md)** — Guide interattive ed esempi
- **[Guida alla migrazione](docs/MIGRATION.md)** — Aggiornamento dalla v2.x
- **[Architettura](docs/ARCHITECTURE.md)** — Come funziona dietro le quinte

---

## Requisiti

- [Copilot CLI](https://docs.github.com/copilot-cli) CLI
- Abbonamento Copilot Max/Pro OPPURE chiave API Anthropic

### Opzionale: Orchestrazione Multi-AI

OMP può opzionalmente orchestrare provider AI esterni per la validazione incrociata e la coerenza del design. Non sono **richiesti** — OMP funziona completamente senza di essi.

| Provider                                                  | Installazione                       | Cosa abilita                                                         |
| --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisione del design, coerenza UI (contesto di 1M token)             |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Validazione dell'architettura, verifica incrociata della code review |

**Costo:** 3 piani Pro (Copilot + Gemini + ChatGPT) coprono tutto per circa $60/mese.

---

## Licenza

MIT

---

<div align="center">

**Ispirato da:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli)

**Zero curva di apprendimento. Potenza massima.**

</div>

