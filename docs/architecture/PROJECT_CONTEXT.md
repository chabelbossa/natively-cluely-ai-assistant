# Project Context — Technical Brief

> Feature expérimentale — Sélection de contexte projet pour les réunions.

**Auteur** : chester-dev
**Statut** : Draft → Scaffolding
**Cible** : Natively v2.6.0 (Electron + React + TypeScript + SQLite)

---

## 1. Problème

L'utilisateur (`chester-dev`) gère ~25 projets actifs (PharmaOps, WaChap, Locapay, Kynthia, YesCars, PayForBet, Afriyo, Salsium, Lightpay, Iot-project, fast-eat, portfolio, etc.) et fait des réunions sur plusieurs d'entre eux chaque semaine.

Nativement possède déjà :
- Un système de **Modes** (persona) — 17 templates + customContext
- Des **reference files** par mode (PDF, DOCX, TXT)
- Un **MeetingBrief** avec un champ `projectContext` (déjà inutilisé)

**Mais** : aucun mécanisme pour associer **un projet versionné local** à une réunion, et aucun scan automatique de la machine de l'utilisateur.

**Objectif** : pendant une réunion, l'utilisateur choisit un projet (ex. *PharmaOps*) → Natively injecte dans le prompt système le contexte pertinent (stack, dernier commit, README, topics à aborder).

---

## 2. Cas d'usage cibles

| Cas | Description | Valeur |
|---|---|---|
| **Réunion PharmaOps** | L'utilisateur parle avec l'équipe DGI sur la refonte facturation e-MECeF. Il sélectionne "PharmaOps" + topic "Refonte DGI". L'IA connaît la stack, les contraintes fiscales béninoises, le dernier commit. | Suggestions contextuelles justes du premier coup |
| **Stand-up WaChap** | Topic "Migration OIDC Kynthia". L'IA sait que WaChap utilise Sentry + Drizzle + Neon, et que Kynthia est le nouveau SSO. | Pas besoin de ré-expliquer le contexte à chaque tour |
| **Démo client Locapay** | L'utilisateur prépare 3 topics : "Tours 360° Marzipano", "WhatsApp alerts", "OTP withdrawal flow". L'IA structure ses réponses autour de ces sujets. | Démo plus fluide, pas d'à-coup |

---

## 3. Architecture cible

### 3.1 Concepts

- **ProjectContext** : un projet versionné local (1 entrée en DB) — ≠ d'un Mode (persona)
- **ProjectTopic** : sujet à aborder pendant la réunion (1..N par projet, éditable)
- **ProjectIndexedFile** : fichier clé indexé (README, ARCHITECTURE, AGENTS.md…) — full-text pour injection

Un Mode et un ProjectContext sont **orthogonaux** : on peut être en mode "Sales" sur le projet "PharmaOps". Les deux blocs sont injectés dans le prompt.

### 3.2 Découverte automatique (ProjectDiscovery)

- **Racines scannées** (configurables, défaut ci-dessous) :
  ```
  ~/aws.bj
  ~/Desktop/Projects
  ~/locapay
  ~/ReactNative/Locapay
  ~/projects
  ```
- **Marqueur projet** : `package.json` OU `pnpm-workspace.yaml` OU `.git` (à la racine d'un sous-dossier)
- **Profondeur** : 3 niveaux max
- **Exclusions** : `node_modules`, `dist`, `release`, `.next`, `.git`, `target`, `build`, `.expo`, `.turbo`, `coverage`
- **Déduplication par git remote** : Locapay (6 repos, certains avec remotes partagés ou pas) seront groupés ou séparés selon la stratégie

### 3.3 Extraction des métadonnées

Pour chaque projet détecté :

| Champ | Source |
|---|---|
| `name` | folder name OU `package.json#name` |
| `stack` | heuristique sur `dependencies` + extensions dominantes (`.tsx`→React, `.dart`→Flutter, etc.) |
| `gitRemote` | `git -C <path> config --get remote.origin.url` |
| `lastCommit` | `git -C <path> log -1 --format="%h %s"` |
| `description` | user-edited, vide par défaut |
| `autoSummary` | 1er paragraphe non-titre de `README.md`, fallback `package.json#description` |
| `indexedFiles` | `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/**/*.md` (max 20 fichiers, max 50 KB chacun) |

### 3.4 Modèle de données (migration v12)

```sql
CREATE TABLE project_contexts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,        -- chemin absolu
  stack TEXT,
  description TEXT DEFAULT '',          -- éditable
  auto_summary TEXT DEFAULT '',          -- généré
  git_remote TEXT,
  last_commit TEXT,
  last_scanned_at TEXT,
  is_active INTEGER DEFAULT 0,           -- singleton
  created_at TEXT NOT NULL
);

CREATE TABLE project_context_topics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE project_context_indexed_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,                -- relatif à rootPath
  file_name TEXT NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER,
  indexed_at TEXT NOT NULL
);

CREATE INDEX idx_project_topics ON project_context_topics(project_id, sort_order);
CREATE INDEX idx_project_files ON project_context_indexed_files(project_id);
```

### 3.5 Intégration au prompt (LLMHelper)

Ordre d'assemblage (dans `streamGeminiChat`) :

```
1. MODE_*_PROMPT                (existant)
2. Mode.customContext           (existant)
3. [MEETING BRIEF]…[/MEETING BRIEF]  (existant, MeetingBriefManager)
4. [ACTIVE PROJECT — <name>]    (NOUVEAU)
   - Stack, last commit
   - user description
   - autoSummary
   - [PROJECT TOPICS]
     - title: description
     - …
   [/PROJECT TOPICS]
   [/ACTIVE PROJECT]
5. RAG chunks                   (existant, désormais filtrables par project_id)
6. Rolling context              (existant, SessionTracker 120s)
```

Budget token cible pour le bloc projet : **3000 tokens** max (autoSummary tronqué, top 5 topics, pas de fichiers dans le system prompt — les fichiers passent par RAG).

### 3.6 UX

| Endroit | Composant | Action |
|---|---|---|
| **Settings** | `ProjectContextSettings.tsx` | Bouton "Rescan" → arbre de projets découverts, checkbox pour ajouter, édition nom/description/topics, suppression |
| **Launcher** | `ProjectBadge.tsx` | Badge cliquable à côté du badge Mode → ouvre dropdown de sélection rapide |
| **Command palette** | `ProjectPicker.tsx` | `Cmd+Shift+P` (configurable) → fuzzy search sur tous les projets |
| **Pendant réunion** | bouton "Add topic" | Crée un `ProjectTopic` à la volée pour la réunion en cours |

### 3.7 Flux de bout en bout

```
1. ONBOARDING
   User ouvre Settings → Project Context
   → clic "Rescan"
   → ProjectDiscovery scan les 5 racines
   → retourne ~25 DiscoveredProject (deduplicated)
   → UI affiche la liste : checkboxes cochées par défaut
   → user peut décocher / éditer / ajouter topics
   → ProjectContextManager.upsert() en DB

2. PRE-MEETING
   User clique ProjectBadge → dropdown
   → ProjectContextManager.setActive(id)
   → broadcast 'project-context:changed' (comme 'mode-changed')
   → badge updated

3. PENDANT LA RÉUNION
   Live transcript → SessionTracker
   User pose une question
   → LLMHelper.streamGeminiChat({
       activeProject,    // injecté
       activeTopics,     // injecté
       ragFilter,        // project_id
     })
   → réponse streamée

4. POST-MEETING
   Meeting sauvegardée avec project_id (extension future du schéma `meetings`)
   → RAG reindexable par projet pour cross-meeting recall
```

---

## 4. Implémentation

### 4.1 Fichiers

**Nouveaux (5 main + 3 UI + 1 doc)**
```
electron/types/projectContext.ts
electron/services/ProjectDiscovery.ts
electron/services/ProjectContextManager.ts
electron/db/migrations/012_project_context.sql
docs/architecture/PROJECT_CONTEXT.md            (ce fichier)
src/components/settings/ProjectContextSettings.tsx
src/components/ProjectBadge.tsx
src/components/ProjectPicker.tsx
```

**Modifiés (5 fichiers)**
```
electron/db/DatabaseManager.ts            (+ migration v12, +3 méthodes CRUD)
electron/preload.ts                       (+ window.electronAPI.projectContext*)
electron/ipcHandlers.ts                   (+ 7 channels project-context:*)
electron/LLMHelper.ts                     (injection [ACTIVE PROJECT]…[/ACTIVE PROJECT])
src/types/electron.d.ts                   (+ types preload)
src/components/NativelyInterface.tsx      (+ ProjectBadge, listener onProjectContextChanged)
electron/SettingsManager.ts               (+ scanRoots config)
```

### 4.2 IPC channels

```
project-context:scan                 (no args)                  → DiscoveredProject[]
project-context:get-all              ()                         → ProjectContext[]
project-context:get-active           ()                         → ProjectContext | null
project-context:upsert               (DiscoveredProject)        → ProjectContext
project-context:update               ({id, fields})             → ProjectContext
project-context:set-active           (id | null)                → void
project-context:delete               (id)                       → void
project-context:rescan               (id)                       → ProjectContext
project-context:add-topic            ({projectId, title, desc}) → ProjectTopic
project-context:update-topic         ({id, fields})             → ProjectTopic
project-context:delete-topic         (id)                       → void
project-context:get-topics           (projectId)                → ProjectTopic[]

(main→renderer events)
project-context:changed              ({id, name})               → payload
project-context:scan-progress        ({scanned, total, current}) → payload
```

### 4.3 Risques & trade-offs

| Risque | Mitigation |
|---|---|
| Scan initial lent sur gros dossiers (waChap = 6.1 GB) | Skip `node_modules`/`.git`/etc. ; scan en background avec progress events ; cancellable |
| `autoSummary` trop long | Troncature à 1500 chars ; prompt demande un *résumé* pas une copie |
| Trop de projets (~25) → UI chargée | Group by "workspace" (aws.bj, Desktop, etc.) ; fuzzy search dans le picker |
| Locapay éclaté en 6 repos | Déduplication par git remote ; sinon l'utilisateur peut merger manuellement dans Settings |
| RAG pollution cross-project | Filtrer `vec_chunks` par `project_id` quand un project est actif |
| Régression des modes existants | Aucune modification de `modes` / `mode_reference_files` — schema purely additive |
| Sécurité : user-edited description devient du prompt injection | Même politique que `Mode.customContext` : sanitisation, longueur max 4000 chars |

---

## 5. Plan d'exécution

| Étape | Livrable | Estimation |
|---|---|---|
| **0. Validation design** | Ce document relu + OK | maintenant |
| **1. Migration + types** | Migration v12, `ProjectContext` types, méthodes CRUD | 1-2h |
| **2. ProjectDiscovery** | Service de scan + tests sur les 5 racines réelles | 2-3h |
| **3. ProjectContextManager** | CRUD + dédup + IPC handlers | 1-2h |
| **4. UI Settings** | `ProjectContextSettings.tsx` + intégration Settings | 2h |
| **5. ProjectBadge + Picker** | Launcher + Cmd+Shift+P | 1-2h |
| **6. Injection prompt** | `LLMHelper.streamGeminiChat` patch | 1h |
| **7. Topics dynamiques** | Add topic pendant réunion | 1h |
| **8. Polish + tests** | Progress events, errors, empty states | 1-2h |
| **Total** | | ~2-3 jours |

---

## 6. Hors-scope (v1)

- Indexation RAG des fichiers projet (les fichiers passent par `autoSummary` dans le system prompt, pas par RAG dans v1)
- Scan automatique de tout le `~` (limité aux 5 racines configurées)
- Sync entre machines (les ProjectContext sont strictement locaux)
- Groupement avancé (tags, workspace folders dans le picker)
- Sync avec un repo Git distant (`.natively/projects.json`)

Évolutions futures (v2) si v1 validé :
- Indexation RAG par projet (table `vec_chunks` avec colonne `project_id`)
- Résolution d'URL GitHub (chaque `DiscoveredProject` peut fetch son README depuis `github.com/<remote>` pour enrichir `autoSummary`)
- MeetingBrief `projectId` (lier une réunion à un projet)
- Groupement par workspace (un workspace = une racine de scan)

---

## 7. Critères d'acceptation

- [ ] L'utilisateur peut lancer un scan et voir la liste de ses ~25 projets en moins de 30s
- [ ] Chaque projet découvert a un nom, une stack, un last commit corrects
- [ ] Locapay (multi-repos) est soit groupé par remote, soit clairement listé
- [ ] L'utilisateur peut sélectionner un projet et le voir dans le badge du launcher
- [ ] Pendant une réunion, l'IA cite des éléments réels du projet (nom de package, structure) sans que l'utilisateur ne les ait retappés
- [ ] Les topics s'affichent dans le prompt et l'IA s'y tient
- [ ] Aucune régression : les Modes fonctionnent comme avant
- [ ] Tout reste local (zéro appel réseau pour le scan)
