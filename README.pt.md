[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | Português

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> **Para usuários do Codex:** Confira [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — a mesma experiência de orquestração para o OpenAI Codex CLI.

**Orquestração multiagente para Copilot CLI. Curva de aprendizado zero.**

*Não aprenda Copilot CLI. Só use OMP.*

[Começar Rápido](#início-rápido) • [Documentação](https://docs/REFERENCE.md) • [Referência CLI](https://docs/REFERENCE.md/docs.html#cli-reference) • [Workflows](https://docs/REFERENCE.md/docs.html#workflows) • [Guia de Migração](docs/MIGRATION.md)

---

## Início Rápido

**Passo 1: Instale**
```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Passo 2: Configure**
```bash
/omg-setup
```

**Passo 3: Crie algo**
```
autopilot: build a REST API for managing tasks
```

É isso. Todo o resto é automático.

### Não sabe por onde começar?

Se você não tem certeza sobre os requisitos, tem uma ideia vaga, ou quer microgerenciar o design:

```
/deep-interview "I want to build a task management app"
```

A entrevista profunda usa questionamento socrático para esclarecer seu pensamento antes de escrever qualquer código. Ela expõe suposições ocultas e mede a clareza por dimensões ponderadas, garantindo que você saiba exatamente o que construir antes da execução começar.

## Modo Team (Recomendado)

A partir da **v4.1.7**, o **Team** é a superfície canônica de orquestração no OMP. Entrypoints legados como **swarm** e **ultrapilot** continuam com suporte, mas agora **roteiam para Team por baixo dos panos**.

```bash
/team 3:executor "fix all TypeScript errors"
```

O Team roda como um pipeline em estágios:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Ative os times nativos do Copilot CLI em `~/.copilot/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Se os times estiverem desativados, o OMP vai avisar você e fazer fallback para execução sem Team quando possível.

### Trabalhadores CLI tmux — Codex & Gemini (v4.4.0+)

**v4.4.0 remove os servidores MCP de Codex/Gemini** (provedores `x`, `g`). Use `/omg-teams` para lançar processos CLI reais em painéis divididos do tmux:

```bash
/omg-teams 2:codex   "review auth module for security issues"
/omg-teams 2:gemini  "redesign UI components for accessibility"
/omg-teams 1:copilot  "implement the payment flow"
```

Para trabalho misto de Codex + Gemini em um único comando, use a skill **`/ccg`**:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Skill | Trabalhadores | Melhor Para |
|-------|---------|----------|
| `/omg-teams N:codex` | N painéis Codex CLI | Revisão de código, análise de segurança, arquitetura |
| `/omg-teams N:gemini` | N painéis Gemini CLI | Design UI/UX, docs, tarefas de grande contexto |
| `/omg-teams N:copilot` | N painéis Copilot CLI | Tarefas gerais via Copilot CLI no tmux |
| `/ccg` | 1 Codex + 1 Gemini | Orquestração tri-modelo em paralelo |

Trabalhadores são iniciados sob demanda e encerrados quando a tarefa é concluída — sem uso ocioso de recursos. Requer as CLIs `codex` / `gemini` instaladas e uma sessão tmux ativa.

> **Observação: Nome do pacote** — O projeto usa a marca **oh-my-copilot** (repo, plugin, comandos), mas o pacote npm é publicado como [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot). Se você instalar as ferramentas de CLI via npm/bun, use `npm install -g oh-my-copilot`.

### Atualizando

```bash
# 1. Atualize o clone do marketplace
/plugin marketplace update omp

# 2. Execute o setup novamente para atualizar a configuração
/omg-setup
```

> **Observação:** Se a atualização automática do marketplace não estiver habilitada, você precisa executar manualmente `/plugin marketplace update omp` para sincronizar a versão mais recente antes de executar o setup.

Se você tiver problemas depois de atualizar, limpe o cache antigo do plugin:

```bash
/omg-doctor
```

<h1 align="center">Seu Copilot acabou de tomar esteroides.</h1>

<p align="center">
  <img src="assets/omg-character.jpg" alt="oh-my-copilot" width="400" />
</p>

---

## Por que oh-my-copilot?

- **Configuração zero** - Funciona de cara com padrões inteligentes
- **Orquestração team-first** - Team é a superfície canônica multiagente (swarm/ultrapilot são fachadas de compatibilidade)
- **Interface em linguagem natural** - Sem comandos para decorar, é só descrever o que você quer
- **Paralelização automática** - Tarefas complexas distribuídas entre agentes especializados
- **Execução persistente** - Não desiste até o trabalho ser verificado como concluído
- **Otimização de custo** - Roteamento inteligente de modelos economiza de 30% a 50% em tokens
- **Aprende com a experiência** - Extrai e reutiliza automaticamente padrões de resolução de problemas
- **Visibilidade em tempo real** - A HUD statusline mostra o que está acontecendo por baixo dos panos

---

## Recursos

### Modos de Orquestração
Múltiplas estratégias para diferentes casos de uso — da orquestração com Team até refatoração com eficiência de tokens. [Saiba mais →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Modo | O que é | Usar para |
|------|---------|-----------|
| **Team (recommended)** | Pipeline canônico em estágios (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agentes coordenados trabalhando em uma lista de tarefas compartilhada |
| **omg-teams** | Trabalhadores CLI tmux — processos reais `copilot`/`codex`/`gemini` em painéis divididos | Tarefas Codex/Gemini CLI; criados sob demanda, encerrados ao terminar |
| **ccg** | Tri-modelo: Codex (analítico) + Gemini (design) em paralelo, Copilot sintetiza | Trabalho misto de backend+UI que precisa de Codex e Gemini |
| **Autopilot** | Execução autônoma (um único agente líder) | Trabalho de feature ponta a ponta com cerimônia mínima |
| **Ultrawork** | Paralelismo máximo (sem Team) | Rajadas de correções/refatorações paralelas quando Team não é necessário |
| **Ralph** | Modo persistente com loops de verify/fix | Tarefas que precisam ser concluídas por completo (sem parciais silenciosos) |
| **Pipeline** | Processamento sequencial por estágios | Transformações em múltiplas etapas com ordenação rigorosa |
| **Swarm / Ultrapilot (legacy)** | Fachadas de compatibilidade que roteiam para **Team** | Workflows existentes e documentação antiga |

### Orquestração Inteligente

- **32 agentes especializados** para arquitetura, pesquisa, design, testes e ciência de dados
- **Roteamento inteligente de modelos** - Haiku para tarefas simples, Opus para raciocínio complexo
- **Delegação automática** - O agente certo para o trabalho, sempre

### Experiência do Desenvolvedor

- **Magic keywords** - `ralph`, `ulw`, `plan` para controle explícito
- **HUD statusline** - Métricas de orquestração em tempo real na sua barra de status
- **Aprendizado de skills** - Extraia padrões reutilizáveis das suas sessões
- **Analytics e rastreamento de custos** - Entenda o uso de tokens em todas as sessões

[Lista completa de recursos →](docs/REFERENCE.md)

---

## Magic Keywords

Atalhos opcionais para usuários avançados. Linguagem natural funciona bem sem eles.

| Palavra-chave | Efeito | Exemplo |
|---------------|--------|---------|
| `team` | Orquestração canônica com Team | `/team 3:executor "fix all TypeScript errors"` |
| `omg-teams` | Trabalhadores CLI tmux (codex/gemini/copilot) | `/omg-teams 2:codex "security review"` |
| `ccg` | Orquestação tri-modelo Codex+Gemini | `/ccg review this PR` |
| `autopilot` | Execução autônoma completa | `autopilot: build a todo app` |
| `ralph` | Modo persistente | `ralph: refactor auth` |
| `ulw` | Paralelismo máximo | `ulw fix all errors` |
| `plan` | Entrevista de planejamento | `plan the API` |
| `ralplan` | Consenso de planejamento iterativo | `ralplan this feature` |
| `deep-interview` | Esclarecimento socrático de requisitos | `deep-interview "vague idea"` |
| `swarm` | **Descontinuado** — use `team` em vez disso | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **Descontinuado** — use `team` em vez disso | `ultrapilot: build a fullstack app` |

**Notas:**
- **ralph inclui ultrawork**: quando você ativa o modo ralph, ele inclui automaticamente a execução paralela do ultrawork.
- A sintaxe `swarm N agents` ainda é reconhecida para extração da contagem de agentes, mas o runtime é baseado em Team na v4.1.7+.

## Utilitários

### Espera de Rate Limit

Retoma automaticamente sessões do Copilot CLI quando os rate limits são resetados.

```bash
omp wait          # Check status, get guidance
omp wait --start  # Enable auto-resume daemon
omp wait --stop   # Disable daemon
```

**Requer:** tmux (para detecção de sessão)

### Tags de Notificação (Telegram/Discord/Slack)

Você pode configurar quem recebe tag quando callbacks de parada enviam resumos de sessão.

```bash
# Set/replace tag list
omp config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omp config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omp config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Incremental updates
omp config-stop-callback telegram --add-tag charlie
omp config-stop-callback discord --remove-tag @here
omp config-stop-callback discord --clear-tags
```

Comportamento das tags:
- Telegram: `alice` vira `@alice`
- Discord: suporta `@here`, `@everyone`, IDs numéricos de usuário e `role:<id>`
- Slack: suporta `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- callbacks de `file` ignoram opções de tag

---

## Documentação

- **[Referência Completa](docs/REFERENCE.md)** - Documentação completa de recursos
- **[Referência CLI](https://docs/REFERENCE.md/docs.html#cli-reference)** - Todos os comandos, flags e ferramentas do `omp`
- **[Guia de Notificações](https://docs/REFERENCE.md/docs.html#notifications)** - Configuração de Discord, Telegram, Slack e webhooks
- **[Workflows Recomendados](https://docs/REFERENCE.md/docs.html#workflows)** - Cadeias de skills testadas em batalha para tarefas comuns
- **[Notas de Lançamento](https://docs/REFERENCE.md/docs.html#release-notes)** - Novidades em cada versão
- **[Website](https://docs/REFERENCE.md)** - Guias interativos e exemplos
- **[Guia de Migração](docs/MIGRATION.md)** - Upgrade a partir da v2.x
- **[Arquitetura](docs/ARCHITECTURE.md)** - Como funciona por baixo dos panos
- **[Monitoramento de Performance](docs/PERFORMANCE-MONITORING.md)** - Rastreamento de agentes, debugging e otimização

---

## Requisitos

- [Copilot CLI](https://docs.github.com/copilot-cli) CLI
- Assinatura Copilot Max/Pro OU chave de API da Anthropic

### Opcional: Orquestração Multi-AI

O OMP pode opcionalmente orquestrar provedores externos de IA para validação cruzada e consistência de design. Eles **não são obrigatórios** — o OMP funciona completamente sem eles.

| Provedor | Instalação | O que habilita |
|----------|------------|----------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisão de design, consistência de UI (contexto de 1M tokens) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Validação de arquitetura, checagem cruzada de code review |

**Custo:** 3 planos Pro (Copilot + Gemini + ChatGPT) cobrem tudo por cerca de US$60/mês.

---

## Licença

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli) • [Ouroboros](https://github.com/Q00/ouroboros)

**Curva de aprendizado zero. Poder máximo.**

</div>

