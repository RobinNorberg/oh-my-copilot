[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | Español | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> **Para usuarios de Codex:** Consulta [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — la misma experiencia de orquestación para OpenAI Codex CLI.

**Orquestación multi-agente para Copilot CLI. Curva de aprendizaje cero.**

*No aprendas Copilot CLI. Solo usa OMP.*

[Comenzar](#inicio-rápido) • [Documentación](https://docs/REFERENCE.md) • [Referencia CLI](https://docs/REFERENCE.md/docs.html#cli-reference) • [Flujos de Trabajo](https://docs/REFERENCE.md/docs.html#workflows) • [Guía de Migración](docs/MIGRATION.md)

---

## Inicio Rápido

**Paso 1: Instalar**
```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Paso 2: Configurar**
```bash
/omg-setup
```

**Paso 3: Construye algo**
```
autopilot: build a REST API for managing tasks
```

Eso es todo. Todo lo demás es automático.

### ¿No sabes por dónde empezar?

Si no tienes claros los requisitos, tienes una idea vaga, o quieres microgestionar el diseño:

```
/deep-interview "I want to build a task management app"
```

La entrevista profunda usa preguntas socráticas para clarificar tu pensamiento antes de escribir cualquier código. Expone suposiciones ocultas y mide la claridad a través de dimensiones ponderadas, asegurando que sepas exactamente qué construir antes de que comience la ejecución.

## Modo Team (Recomendado)

A partir de **v4.1.7**, **Team** es la superficie canónica de orquestación en OMP. Los puntos de entrada legados como **swarm** y **ultrapilot** siguen siendo compatibles, pero ahora **enrutan a Team internamente**.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team se ejecuta como un pipeline por etapas:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Habilita los equipos nativos de Copilot CLI en `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Si los equipos están desactivados, OMP te avisará y hará fallback a ejecución sin Team cuando sea posible.

### Trabajadores CLI tmux — Codex & Gemini (v4.4.0+)

**v4.4.0 elimina los servidores MCP de Codex/Gemini** (proveedores `x`, `g`). Usa `/omg-teams` para lanzar procesos CLI reales en paneles divididos de tmux:

```bash
/omg-teams 2:codex   "review auth module for security issues"
/omg-teams 2:gemini  "redesign UI components for accessibility"
/omg-teams 1:copilot  "implement the payment flow"
```

Para trabajo mixto de Codex + Gemini en un solo comando, usa la habilidad **`/ccg`**:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Habilidad | Trabajadores | Mejor Para |
|-------|---------|----------|
| `/omg-teams N:codex` | N paneles Codex CLI | Revisión de código, análisis de seguridad, arquitectura |
| `/omg-teams N:gemini` | N paneles Gemini CLI | Diseño UI/UX, docs, tareas de gran contexto |
| `/omg-teams N:copilot` | N paneles Copilot CLI | Tareas generales via Copilot CLI en tmux |
| `/ccg` | 1 Codex + 1 Gemini | Orquestación tri-modelo en paralelo |

Los trabajadores se inician bajo demanda y terminan cuando su tarea se completa — sin uso de recursos en espera. Requiere las CLIs `codex` / `gemini` instaladas y una sesión tmux activa.

> **Nota: Nombre del paquete** — El proyecto usa la marca **oh-my-copilot** (repositorio, plugin, comandos), pero el paquete npm se publica como [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot). Si instalas las herramientas CLI via npm/bun, usa `npm install -g oh-my-copilot`.

### Actualizar

```bash
# 1. Actualizar el clon del marketplace
/plugin marketplace update omc

# 2. Volver a ejecutar el setup para actualizar la configuracion
/omg-setup
```

> **Nota:** Si la actualizacion automatica del marketplace no esta activada, debes ejecutar manualmente `/plugin marketplace update omc` para sincronizar la ultima version antes de ejecutar el setup.

Si experimentas problemas despues de actualizar, limpia la cache antigua del plugin:

```bash
/omg-doctor
```

<h1 align="center">Tu Copilot acaba de recibir esteroides.</h1>

<p align="center">
  <img src="assets/omg-character.jpg" alt="oh-my-copilot" width="400" />
</p>

---

## ¿Por qué oh-my-copilot?

- **Cero configuración requerida** - Funciona inmediatamente con valores predeterminados inteligentes
- **Orquestación Team-first** - Team es la superficie canónica multiagente (swarm/ultrapilot son fachadas de compatibilidad)
- **Interfaz de lenguaje natural** - Sin comandos que memorizar, solo describe lo que quieres
- **Paralelización automática** - Tareas complejas distribuidas entre agentes especializados
- **Ejecución persistente** - No se rendirá hasta que el trabajo esté verificado y completo
- **Optimización de costos** - Enrutamiento inteligente de modelos ahorra 30-50% en tokens
- **Aprende de la experiencia** - Extrae y reutiliza automáticamente patrones de resolución de problemas
- **Visibilidad en tiempo real** - Barra de estado HUD muestra lo que está sucediendo internamente

---

## Características

### Modos de Ejecución
Múltiples estrategias para diferentes casos de uso - desde construcciones completamente autónomas hasta refactorización eficiente en tokens. [Aprende más →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Modo | Característica | Usar Para |
|------|---------|---------|
| **Team (recomendado)** | Pipeline por etapas | Agentes Copilot coordinados en una lista de tareas compartida |
| **omg-teams** | Trabajadores CLI tmux | Tareas Codex/Gemini CLI; se inician bajo demanda, terminan al completar |
| **ccg** | Tri-modelo en paralelo | Codex (analítico) + Gemini (diseño), Copilot sintetiza |
| **Autopilot** | Ejecución autónoma | Trabajo de feature end-to-end con mínima ceremonia |
| **Ultrawork** | Máximo paralelismo | Correcciones/refactorizaciones en ráfaga cuando Team no es necesario |
| **Ralph** | Modo persistente | Tareas que deben completarse totalmente |
| **Pipeline** | Procesamiento secuencial | Transformaciones multi-etapa con ordenación estricta |
| **Swarm / Ultrapilot (legado)** | Enrutan a Team | Flujos de trabajo existentes y documentación antigua |

### Orquestación Inteligente

- **32 agentes especializados** para arquitectura, investigación, diseño, pruebas, ciencia de datos
- **Enrutamiento inteligente de modelos** - Haiku para tareas simples, Opus para razonamiento complejo
- **Delegación automática** - El agente correcto para el trabajo, siempre

### Experiencia de Desarrollo

- **Palabras clave mágicas** - `ralph`, `ulw`, `plan` para control explícito
- **Barra de estado HUD** - Métricas de orquestación en tiempo real en tu barra de estado
- **Aprendizaje de habilidades** - Extrae patrones reutilizables de tus sesiones
- **Análisis y seguimiento de costos** - Comprende el uso de tokens en todas las sesiones

[Lista completa de características →](docs/REFERENCE.md)

---

## Palabras Clave Mágicas

Atajos opcionales para usuarios avanzados. El lenguaje natural funciona bien sin ellas.

| Palabra Clave | Efecto | Ejemplo |
|---------|--------|---------|
| `team` | Orquestación canónica con Team | `/team 3:executor "fix all TypeScript errors"` |
| `omg-teams` | Trabajadores CLI tmux (codex/gemini/copilot) | `/omg-teams 2:codex "security review"` |
| `ccg` | Orquestación tri-modelo Codex+Gemini | `/ccg review this PR` |
| `autopilot` | Ejecución completamente autónoma | `autopilot: build a todo app` |
| `ralph` | Modo persistencia | `ralph: refactor auth` |
| `ulw` | Máximo paralelismo | `ulw fix all errors` |
| `plan` | Entrevista de planificación | `plan the API` |
| `ralplan` | Consenso de planificación iterativa | `ralplan this feature` |
| `deep-interview` | Clarificación socrática de requisitos | `deep-interview "vague idea"` |
| `swarm` | **Obsoleto** — usa `team` en su lugar | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **Obsoleto** — usa `team` en su lugar | `ultrapilot: build a fullstack app` |

**Notas:**
- **ralph incluye ultrawork:** Cuando activas el modo ralph, automáticamente incluye la ejecución paralela de ultrawork. No es necesario combinar palabras clave.
- La sintaxis `swarm N agents` aún se reconoce para extraer el recuento de agentes, pero el runtime está respaldado por Team en v4.1.7+.

---

## Utilidades

### Espera de Límite de Tasa

Reanuda automáticamente sesiones de Copilot CLI cuando se reinician los límites de tasa.

```bash
omc wait          # Verificar estado, obtener orientación
omc wait --start  # Habilitar demonio de reanudación automática
omc wait --stop   # Deshabilitar demonio
```

**Requiere:** tmux (para detección de sesión)

### Etiquetas de notificación (Telegram/Discord/Slack)

Puedes configurar a quién etiquetar cuando los callbacks de stop envían el resumen de sesión.

```bash
# Definir/reemplazar lista de etiquetas
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Actualizaciones incrementales
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Comportamiento de etiquetas:
- Telegram: `alice` se normaliza a `@alice`
- Discord: soporta `@here`, `@everyone`, IDs numéricos de usuario y `role:<id>`
- Slack: soporta `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- El callback `file` ignora las opciones de etiquetas

---

## Documentación

- **[Referencia Completa](docs/REFERENCE.md)** - Documentación completa de características
- **[Referencia CLI](https://docs/REFERENCE.md/docs.html#cli-reference)** - Todos los comandos, flags y herramientas de `omc`
- **[Guía de Notificaciones](https://docs/REFERENCE.md/docs.html#notifications)** - Configuración de Discord, Telegram, Slack y webhooks
- **[Flujos de Trabajo Recomendados](https://docs/REFERENCE.md/docs.html#workflows)** - Cadenas de habilidades probadas para tareas comunes
- **[Notas de Versión](https://docs/REFERENCE.md/docs.html#release-notes)** - Novedades en cada versión
- **[Sitio Web](https://docs/REFERENCE.md)** - Guías interactivas y ejemplos
- **[Guía de Migración](docs/MIGRATION.md)** - Actualización desde v2.x
- **[Arquitectura](docs/ARCHITECTURE.md)** - Cómo funciona internamente
- **[Monitoreo de Rendimiento](docs/PERFORMANCE-MONITORING.md)** - Seguimiento de agentes, depuración y optimización

---

## Requisitos

- CLI de [Copilot CLI](https://docs.github.com/copilot-cli)
- Suscripción Copilot Max/Pro O clave API de Anthropic

### Opcional: Orquestación Multi-IA

OMP puede opcionalmente orquestar proveedores de IA externos para validación cruzada y consistencia de diseño. **No son necesarios** — OMP funciona completamente sin ellos.

| Proveedor | Instalación | Qué habilita |
|-----------|-------------|--------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisión de diseño, consistencia UI (contexto de 1M tokens) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Validación de arquitectura, verificación cruzada de código |

**Costo:** 3 planes Pro (Copilot + Gemini + ChatGPT) cubren todo por ~$60/mes.

---

## Licencia

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli) • [Ouroboros](https://github.com/Q00/ouroboros)

**Curva de aprendizaje cero. Poder máximo.**

</div>

