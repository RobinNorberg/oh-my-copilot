[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [Türkçe](README.tr.md) | [Deutsch](README.de.md) | Français | [Italiano](README.it.md)

# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/oh-my-copilot?color=cb3837)](https://www.npmjs.com/package/oh-my-copilot)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-copilot?color=blue)](https://www.npmjs.com/package/oh-my-copilot)
[![GitHub stars](https://img.shields.io/github/stars/RobinNorberg/oh-my-copilot?style=flat&color=yellow)](https://github.com/RobinNorberg/oh-my-copilot/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Orchestration multi-agents pour Copilot CLI. Aucune courbe d'apprentissage.**

_N'apprenez pas Copilot CLI. Utilisez simplement OMP._

[Démarrer](#démarrage-rapide) • [Documentation](https://docs/REFERENCE.md) • [Guide de migration](docs/MIGRATION.md)

---

## Démarrage rapide

**Étape 1 : Installation**

```bash
/plugin marketplace add https://github.com/RobinNorberg/oh-my-copilot
/plugin install oh-my-copilot
```

**Étape 2 : Configuration**

```bash
/oh-my-copilot:omg-setup
```

**Étape 3 : Construisez quelque chose**

```
autopilot: build a REST API for managing tasks
```

C'est tout. Le reste est automatique.

## Team Mode (Recommandé)

À partir de la **v4.1.7**, **Team** est la surface d'orchestration canonique dans OMP. Les anciens points d'entrée comme **swarm** et **ultrapilot** sont toujours supportés, mais **redirigent désormais vers Team en coulisses**.

```bash
/oh-my-copilot:team 3:executor "fix all TypeScript errors"
```

Team fonctionne comme un pipeline par étapes :

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Activez les teams natifs de Copilot CLI dans `~/.copilot/settings.json` :

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Si les teams sont désactivés, OMP vous avertira et basculera vers une exécution sans Team lorsque possible.

> **Note : Nom du package** — Le projet utilise la marque **oh-my-copilot** (repo, plugin, commandes), mais le package npm est publié sous le nom [`oh-my-copilot`](https://www.npmjs.com/package/oh-my-copilot). Si vous installez les outils CLI via npm/bun, utilisez `npm install -g oh-my-copilot`.

### Mise à jour

```bash
# 1. Mettre à jour le plugin
/plugin install oh-my-copilot

# 2. Relancer le setup pour actualiser la configuration
/oh-my-copilot:omg-setup
```

Si vous rencontrez des problèmes après la mise à jour, videz l'ancien cache du plugin :

```bash
/oh-my-copilot:omg-doctor
```

<h1 align="center">Votre Copilot vient de recevoir des super-pouvoirs.</h1>

<p align="center">
  <img src="assets/omg-character.jpg" alt="oh-my-copilot" width="400" />
</p>

---

## Pourquoi oh-my-copilot ?

- **Aucune configuration requise** — Fonctionne directement avec des valeurs par défaut intelligentes
- **Orchestration team-first** — Team est la surface multi-agents canonique (swarm/ultrapilot sont des façades de compatibilité)
- **Interface en langage naturel** — Aucune commande à mémoriser, décrivez simplement ce que vous voulez
- **Parallélisation automatique** — Les tâches complexes sont distribuées entre des agents spécialisés
- **Exécution persistante** — N'abandonne pas tant que le travail n'est pas vérifié et terminé
- **Optimisation des coûts** — Le routage intelligent des modèles économise 30 à 50 % sur les tokens
- **Apprentissage par l'expérience** — Extrait et réutilise automatiquement les patterns de résolution de problèmes
- **Visibilité en temps réel** — La HUD statusline montre ce qui se passe en coulisses

---

## Fonctionnalités

### Modes d'orchestration

Plusieurs stratégies pour différents cas d'utilisation — de l'orchestration Team au refactoring économe en tokens. [En savoir plus →](https://docs/REFERENCE.md/docs.html#execution-modes)

| Mode                            | Description                                                                                 | Utilisation                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Team (recommandé)**           | Pipeline canonique par étapes (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agents coordonnés travaillant sur une liste de tâches partagée                   |
| **Autopilot**                   | Exécution autonome (un seul agent leader)                                                   | Développement de fonctionnalités de bout en bout avec un minimum de cérémonie    |
| **Ultrawork**                   | Parallélisme maximal (sans Team)                                                            | Corrections/refactorings parallèles en rafale quand Team n'est pas nécessaire    |
| **Ralph**                       | Mode persistant avec boucles verify/fix                                                     | Tâches devant être entièrement complétées (pas de résultats partiels silencieux) |
| **Ecomode**                     | Routage économe en tokens                                                                   | Itération soucieuse du budget                                                    |
| **Pipeline**                    | Traitement séquentiel par étapes                                                            | Transformations multi-étapes avec un ordre strict                                |
| **Swarm / Ultrapilot (ancien)** | Façades de compatibilité redirigeant vers **Team**                                          | Workflows existants et ancienne documentation                                    |

### Orchestration intelligente

- **32 agents spécialisés** pour l'architecture, la recherche, le design, les tests, la data science
- **Routage intelligent des modèles** — Haiku pour les tâches simples, Opus pour le raisonnement complexe
- **Délégation automatique** — Le bon agent pour le bon travail, à chaque fois

### Expérience développeur

- **Mots-clés magiques** — `ralph`, `ulw`, `eco`, `plan` pour un contrôle explicite
- **HUD statusline** — Métriques d'orchestration en temps réel dans votre barre d'état
- **Apprentissage de compétences** — Extraction de patterns réutilisables depuis vos sessions
- **Analytique et suivi des coûts** — Compréhension de l'utilisation des tokens sur toutes les sessions

[Liste complète des fonctionnalités →](docs/REFERENCE.md)

---

## Mots-clés magiques

Raccourcis optionnels pour les utilisateurs avancés. Le langage naturel fonctionne très bien sans eux.

| Mot-clé      | Effet                               | Exemple                                                         |
| ------------ | ----------------------------------- | --------------------------------------------------------------- |
| `team`       | Orchestration Team canonique        | `/oh-my-copilot:team 3:executor "fix all TypeScript errors"` |
| `autopilot`  | Exécution entièrement autonome      | `autopilot: build a todo app`                                   |
| `ralph`      | Mode persistant                     | `ralph: refactor auth`                                          |
| `ulw`        | Parallélisme maximal                | `ulw fix all errors`                                            |
| `eco`        | Exécution économe en tokens         | `eco: migrate database`                                         |
| `plan`       | Entretien de planification          | `plan the API`                                                  |
| `ralplan`    | Consensus de planification itératif | `ralplan this feature`                                          |
| `swarm`      | Ancien mot-clé (redirige vers Team) | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot` | Ancien mot-clé (redirige vers Team) | `ultrapilot: build a fullstack app`                             |

**Notes :**

- **ralph inclut ultrawork** : lorsque vous activez le mode ralph, il inclut automatiquement l'exécution parallèle d'ultrawork.
- La syntaxe `swarm N agents` est toujours reconnue pour l'extraction du nombre d'agents, mais le runtime est basé sur Team dans v4.1.7+.

## Utilitaires

### Attente de rate limit

Reprise automatique des sessions Copilot CLI lorsque les rate limits sont réinitialisés.

```bash
omp wait          # Vérifier le statut, obtenir des conseils
omp wait --start  # Activer le daemon de reprise automatique
omp wait --stop   # Désactiver le daemon
```

**Prérequis :** tmux (pour la détection de session)

### Tags de notification (Telegram/Discord)

Vous pouvez configurer qui est mentionné lorsque les callbacks d'arrêt envoient des résumés de session.

```bash
# Définir/remplacer la liste des tags
omp config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omp config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Mises à jour incrémentales
omp config-stop-callback telegram --add-tag charlie
omp config-stop-callback discord --remove-tag @here
omp config-stop-callback discord --clear-tags
```

Comportement des tags :

- Telegram : `alice` est normalisé en `@alice`
- Discord : supporte `@here`, `@everyone`, les IDs utilisateur numériques et `role:<id>`
- Les callbacks de type `file` ignorent les options de tags

---

## Documentation

- **[Référence complète](docs/REFERENCE.md)** — Documentation complète des fonctionnalités
- **[Monitoring de performance](docs/PERFORMANCE-MONITORING.md)** — Suivi des agents, débogage et optimisation
- **[Site web](https://docs/REFERENCE.md)** — Guides interactifs et exemples
- **[Guide de migration](docs/MIGRATION.md)** — Mise à jour depuis v2.x
- **[Architecture](docs/ARCHITECTURE.md)** — Comment ça fonctionne en coulisses

---

## Prérequis

- [Copilot CLI](https://docs.github.com/copilot-cli) CLI
- Abonnement Copilot Max/Pro OU clé API Anthropic

### Optionnel : Orchestration Multi-AI

OMP peut optionnellement orchestrer des fournisseurs d'IA externes pour la validation croisée et la cohérence du design. Ils ne sont **pas requis** — OMP fonctionne pleinement sans eux.

| Fournisseur                                               | Installation                        | Ce que ça apporte                                              |
| --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revue de design, cohérence UI (contexte de 1M tokens)          |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Validation d'architecture, vérification croisée de code review |

**Coût :** 3 plans Pro (Copilot + Gemini + ChatGPT) couvrent tout pour environ 60 $/mois.

---

## Licence

MIT

---

<div align="center">

**Inspiré par :** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [copilot-hud](https://github.com/ryanjoachim/copilot-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-copilot-cli](https://github.com/affaan-m/everything-copilot-cli)

**Aucune courbe d'apprentissage. Puissance maximale.**

</div>

