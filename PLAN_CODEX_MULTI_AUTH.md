# Plan : Intégration Codex CLI Multi-Auth dans Natively

## Contexte & Synthèse

L'objectif est d'intégrer dans Natively le support du **vrai Codex CLI** (backend OpenAI Responses API) avec un système **multi-comptes OAuth**, du **load balancing**, et du **switch automatique** quand une limite est atteinte. Ce plan s'inspire directement de l'architecture des deux dépôts de référence (`guard22/opencode-multi-auth-codex` et `ndycode/codex-multi-auth`), adaptés à l'architecture Electron + React de Natively.

### Différence fondamentale avec les dépôts de référence
- Les dépôts de référence sont des **wrappers CLI** (Node.js exécuté dans un terminal) qui spawne le binaire officiel `codex` et utilisent un proxy HTTP local pour intercepter le trafic.
- Natively est une **application Electron**. Les appels API peuvent être faits **directement** depuis le `main process` via Node.js (`fetch` / `axios`). Pas besoin de proxy HTTP loopback ni de shadow `CODEX_HOME`. Le router peut vivre en mémoire dans le processus principal.

### Approche retenue : **Option B — Intégration native via API Responses**
Au lieu de wrapper le CLI externe, Natively va :
1. Implémenter le **flux OAuth PKCE** pour obtenir des tokens d'accès Codex (comme le fait le CLI officiel).
2. Stocker les tokens OAuth de plusieurs comptes dans le `CredentialsManager` existant (chiffré via `safeStorage`).
3. Implémenter un **CodexAuthRouter** dans le `main process` qui sélectionne le compte, gère le refresh, et fait le load balancing.
4. Appeler directement l'**API OpenAI Responses** (`https://api.openai.com/v1/responses`) avec les tokens du compte sélectionné.
5. Fournir une **UI React** pour ajouter des comptes, les activer/désactiver, forcer un compte, et voir la santé du pool.

---

## Phase 1 : Recherche & Validation Technique (2-3 jours)

**Objectif** : Confirmer que l'on peut appeler l'API Responses avec des tokens OAuth obtenus via PKCE, et valider les endpoints/rate limits.

### Tâches
1. **Reverse-engineer le flux OAuth de Codex CLI**
   - Identifier le `client_id` utilisé par le CLI officiel (ou enregistrer un nouveau OAuth app si nécessaire).
   - Comprendre les scopes nécessaires (`codex`, `chat`, etc.).
   - Valider le flux : génération PKCE → ouverture navigateur → callback sur `http://localhost:1455` → échange code vs tokens.
   - Documenter la structure du token (access_token, refresh_token, id_token, expires_at).

2. **Valider l'API Responses avec token OAuth**
   - Faire un appel manuel à `POST https://api.openai.com/v1/responses` avec un token OAuth ChatGPT/Codex.
   - Vérifier que les modèles Codex (`gpt-5.4-codex`, etc.) sont accessibles.
   - Tester le streaming SSE.
   - Confirmer les headers requis (`Authorization: Bearer <token>`).

3. **Analyser les rate limits spécifiques à Codex**
   - Documenter les headers de rate limit (`x-ratelimit-remaining`, `x-ratelimit-reset`).
   - Comprendre les limites quotidiennes/hebdomadaires par compte.
   - Tester le comportement en cas de `429` (body, headers `Retry-After`).

### Livrables
- `docs/codex-oauth-research.md` : Document de recherche avec les endpoints, headers, et exemples de requêtes/réponses.
- `docs/codex-rate-limits.md` : Matrice des rate limits et comportements d'erreur.
- Preuve de concept (script Node.js isolé) : login OAuth + appel API Responses + streaming.

### Risques identifiés à cette phase
- **Risque CRITIQUE** : OpenAI pourrait bloquer le flux OAuth pour des clients tiers, ou les conditions d'utilisation pourraient interdire l'utilisation de comptes ChatGPT/Codex via une app tierce. Ce document de recherche doit inclure une analyse ToS.
- **Risque** : L'API Responses avec token OAuth pourrait avoir des restrictions différentes de l'API Platform (API key). Il faut valider que le streaming et les modèles sont bien accessibles.

---

## Phase 2 : Architecture & Data Model (2 jours)

**Objectif** : Définir les interfaces TypeScript, les extensions au storage, et le contrat entre le main process et le renderer.

### 2.1 Data Model — Compte Codex OAuth

```typescript
// electron/services/CredentialsManager.ts (extension)

export interface CodexAccount {
  alias: string;                    // nom humain (ex: "perso", "pro", "backup")
  email: string;                    // email du compte ChatGPT (normalisé lowercase)
  enabled: boolean;                 // actif dans la rotation ?
  disabledAt?: string;              // ISO timestamp
  disableReason?: string;

  // Tokens OAuth (chiffrés au repos par safeStorage, mais en clair en mémoire)
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: string;                // ISO timestamp
  obtainedAt: string;               // ISO timestamp

  // Quota / Health
  rateLimits?: {
    dailyRemaining?: number;
    dailyLimit?: number;
    weeklyRemaining?: number;
    weeklyLimit?: number;
  };
  lastLimitProbeAt?: string;
  limitStatus?: 'fresh' | 'stale' | 'error' | 'unknown';

  // Runtime state (non persisté — reset au restart)
  runtime?: {
    rateLimitedUntil?: string;      // ISO timestamp — cooldown après 429
    consecutiveErrors: number;
    lastErrorAt?: string;
    requestCount: number;
  };

  // Load balancing
  weight: number;                   // default 1.0 pour weighted-round-robin
}

export interface CodexMultiAuthSettings {
  rotationStrategy: 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin';
  forcedAlias?: string;             // Force mode : pin un compte
  forcedUntil?: string;             // TTL du force mode (ex: +24h)
  previousStrategy?: string;        // pour restore après force mode
  criticalThreshold: number;        // % quota restant avant exclusion (default 10)
  lowThreshold: number;             // % quota restant avant warning (default 25)
}
```

### 2.2 Storage Extension

- **Fichier** : `credentials.enc` (déjà utilisé par `CredentialsManager`) va stocker un nouveau champ `codexAccounts: CodexAccount[]` et `codexMultiAuthSettings: CodexMultiAuthSettings`.
- **Migration** : Le `CredentialsManager` doit supporter une migration de schema v1 → v2 si nécessaire.
- **Sécurité** : Les tokens OAuth (`accessToken`, `refreshToken`) doivent être chiffrés au repos via `safeStorage.encryptString` (déjà utilisé). Pas de fichiers JSON en clair.

### 2.3 IPC Contracts (Main ↔ Renderer)

```typescript
// electron/preload.ts (nouveaux handles)

// Gestion des comptes
ipcRenderer.invoke('codex-auth-start');                    // Démarre le flux OAuth PKCE (ouvre le navigateur)
ipcRenderer.invoke('codex-auth-callback', code, state);     // Réception du callback OAuth
ipcRenderer.invoke('codex-accounts-list');                  // Liste tous les comptes (sans tokens)
ipcRenderer.invoke('codex-account-set-enabled', alias, enabled);
ipcRenderer.invoke('codex-account-remove', alias);
ipcRenderer.invoke('codex-account-reauth', alias);          // Refresh forcé du token

// Switch & Stratégie
ipcRenderer.invoke('codex-switch-account', alias);          // Force mode manuel
ipcRenderer.invoke('codex-clear-force');                    // Désactive le force mode
ipcRenderer.invoke('codex-set-strategy', strategy);
ipcRenderer.invoke('codex-get-settings');

// Health & Observability
ipcRenderer.invoke('codex-health-report');                  // État du pool, quotas, cooldowns
ipcRenderer.invoke('codex-probe-limits', alias?);           // Probe les quotas d'un compte
```

### Livrables
- Fichiers de types TypeScript dans `electron/types/codex-multi-auth.ts`.
- Mise à jour du `StoredCredentials` interface dans `CredentialsManager.ts`.
- Document d'architecture `docs/codex-multi-auth-architecture.md`.

---

## Phase 3 : Module OAuth & Account Manager (4-5 jours)

**Objectif** : Implémenter le flux OAuth PKCE et la gestion du pool de comptes.

### 3.1 OAuth PKCE Flow

**Nouveau fichier** : `electron/services/CodexOAuthFlow.ts`

 Inspiré de `lib/auth/auth.ts` et `lib/auth/server.ts` de `ndycode/codex-multi-auth`.

```typescript
export class CodexOAuthFlow {
  // 1. Génère code_verifier + code_challenge (PKCE S256)
  // 2. Construit l'URL d'autorisation OpenAI/Codex
  // 3. Démarre un serveur HTTP temporaire sur localhost:1455 (ou port fallback)
  // 4. Ouvre le navigateur système via `shell.openExternal()`
  // 5. Attend le callback OAuth (code + state)
  // 6. Échange le code contre tokens (access_token, refresh_token) via POST /token
  // 7. Ferme le serveur temporaire
  // 8. Retourne un objet CodexAccount (sans alias — l'UI demandera le nom)
}
```

**Sécurité PKCE** :
- `code_verifier` : 128 octets aléatoires base64url.
- `state` : nonce aléatoire pour prévenir CSRF.
- Le serveur de callback ne répond qu'à `127.0.0.1` et rejette les hosts non-loopback.

### 3.2 CodexAccountManager

**Nouveau fichier** : `electron/services/CodexAccountManager.ts`

Responsabilités :
- CRUD des comptes (wrapper autour de `CredentialsManager`).
- Refresh token proactif (avant expiration).
- Re-auth d'un compte (relance le flux OAuth pour un alias existant).
- Persistance atomique (tmp → write → rename).

```typescript
export class CodexAccountManager {
  addAccount(alias: string, account: CodexAccount): void;
  removeAccount(alias: string): void;
  getAccount(alias: string): CodexAccount | undefined;
  getAllAccounts(): CodexAccount[];
  getEnabledAccounts(): CodexAccount[];
  updateAccount(alias: string, patch: Partial<CodexAccount>): void;
  refreshTokenIfNeeded(alias: string): Promise<void>;
}
```

### Livrables
- `electron/services/CodexOAuthFlow.ts` (PKCE flow complet).
- `electron/services/CodexAccountManager.ts` (gestion du pool).
- Tests unitaires : PKCE generation, callback parsing, token exchange (mocké).

---

## Phase 4 : Rotation Engine & Load Balancing (4-5 jours)

**Objectif** : Implémenter le cœur du routage multi-comptes avec les stratégies de rotation et la gestion des erreurs.

### 4.1 CodexAuthRouter

**Nouveau fichier** : `electron/services/CodexAuthRouter.ts`

```typescript
export class CodexAuthRouter {
  private accountManager: CodexAccountManager;
  private settings: CodexMultiAuthSettings;
  private currentRoundRobinIndex: number = 0;

  // Sélection du compte pour la prochaine requête
  selectAccount(): CodexAccount | null;

  // Stratégies implémentées (inspirées de guard22/opencode-multi-auth-codex)
  private selectRoundRobin(): CodexAccount | null;
  private selectLeastUsed(): CodexAccount | null;
  private selectRandom(): CodexAccount | null;
  private selectWeightedRoundRobin(): CodexAccount | null;

  // Post-request update
  recordSuccess(alias: string): void;
  recordRateLimit(alias: string, retryAfterMs?: number): void;
  recordAuthFailure(alias: string): void;
  recordServerError(alias: string): void;

  // Health evaluation
  private isAccountEligible(account: CodexAccount): boolean;
  private computeCooldown(account: CodexAccount): number;
}
```

### 4.2 Stratégies de rotation

| Stratégie | Description |
|---|---|
| `round-robin` | Cycle simple sur les comptes healthy enabled. |
| `least-used` | Choisit le compte avec le plus petit `requestCount`. |
| `random` | Aléatoire uniforme parmi les comptes healthy enabled. |
| `weighted-round-robin` | Distribution proportionnelle au poids configuré par compte. |

### 4.3 Gestion des erreurs et cooldown (inspiré de `ndycode/codex-multi-auth`)

**Règles de cooldown** :
- Sur `429 Too Many Requests` : parser `Retry-After` (header) ou `x-ratelimit-reset`. Mettre le compte en cooldown jusqu'à ce timestamp.
- Sur `401 Unauthorized` / `403 Forbidden` : marquer le compte comme `flagged` (nécessite re-auth). Ne pas le retry automatiquement.
- Sur `5xx` : backoff exponentiel court (1s, 2s, 4s, max 30s) puis retry sur un autre compte.
- Sur erreur réseau : retry sur un autre compte immédiatement.

**Règles de force mode** (inspiré de guard22) :
- Quand `forcedAlias` est défini et que le compte est eligible : **toujours** utiliser ce compte.
- Si le compte forcé devient ineligible (rate limit, auth failure) : **ne pas fallback** silencieusement. Échouer avec une erreur explicite.
- Le force mode a un TTL (`forcedUntil`). Après expiration, restaure automatiquement la stratégie précédente.

### 4.4 Quota Probing (inspiré de guard22)

```typescript
// Probe les quotas d'un compte avec une requête légère
async probeLimits(alias: string): Promise<void>;
```
- Envoie une requête de test (ex: "hello") au compte.
- Parse les headers de rate limit de la réponse.
- Met à jour `rateLimits`, `lastLimitProbeAt`, `limitStatus`.
- **Règle critique** : si le probe échoue, ne **jamais** écraser les anciennes limites avec des données d'erreur. Mettre à jour uniquement `limitStatus = 'error'`.

### Livrables
- `electron/services/CodexAuthRouter.ts`.
- Tests unitaires exhaustifs pour chaque stratégie.
- Tests de simulation : 429 → cooldown → re-éligibilité.

---

## Phase 5 : Client API Responses & Intégration LLMHelper (5-6 jours)

**Objectif** : Brancher le CodexAuthRouter dans le pipeline LLM existant de Natively.

### 5.1 CodexResponsesClient

**Nouveau fichier** : `electron/services/CodexResponsesClient.ts`

Ce client appelle directement l'**API OpenAI Responses** (pas Chat Completions), car c'est ce que le backend Codex utilise.

```typescript
export class CodexResponsesClient {
  private router: CodexAuthRouter;

  // Appel non-streaming
  async generateResponse(params: ResponsesRequestParams): Promise<string>;

  // Appel streaming (SSE)
  async *streamResponse(params: ResponsesRequestParams): AsyncGenerator<string>;

  // Retry avec rotation
  private async executeWithRotation<T>(
    fn: (account: CodexAccount) => Promise<T>
  ): Promise<T>;
}
```

**Format de requête Responses API** :
```json
{
  "model": "gpt-5.4-codex",
  "input": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "store": false,
  "reasoning": { "effort": "medium" }
}
```

**Headers** :
- `Authorization: Bearer <access_token du compte sélectionné>`
- `Content-Type: application/json`

### 5.2 Intégration dans LLMHelper

**Fichier à modifier** : `electron/LLMHelper.ts`

- Ajouter `private codexClient: CodexResponsesClient | null = null`.
- Dans `constructor` et `loadStoredCredentials`, initialiser le `CodexAccountManager` et le `CodexAuthRouter` si des comptes Codex existent.
- Ajouter une méthode `isCodexModel(modelId: string): boolean` (similaire à `isOpenCodeGoModel`).
- Dans `generate()` et `stream*()`, ajouter une branche pour les modèles Codex :
  ```typescript
  if (this.isCodexModel(this.currentModelId)) {
    providers.push({
      name: `Codex (${this.currentModelId})`,
      execute: () => this.codexClient!.generateResponse(...)
    });
  }
  ```

### 5.3 Gestion des erreurs de rotation dans le pipeline existant

- Le `CodexResponsesClient` doit lever des erreurs typées (`CodexRotationError`) si tous les comptes sont épuisés.
- Le `ProcessingHelper` doit catcher ces erreurs et les afficher proprement dans l'UI (overlay "All Codex accounts rate-limited").

### Livrables
- `electron/services/CodexResponsesClient.ts`.
- Modifications dans `electron/LLMHelper.ts` et `electron/ProcessingHelper.ts`.
- Tests d'intégration : appel API mocké avec rotation simulée.

---

## Phase 6 : UI React — Gestion des Comptes & Dashboard (5-6 jours)

**Objectif** : Permettre à l'utilisateur de gérer ses comptes Codex, switcher manuellement, et voir l'état du pool.

### 6.1 Nouvel écran : Codex Accounts Manager

**Nouveau composant** : `src/components/CodexAccountsManager.tsx`

Accessible depuis les Settings (nouvelle section "Codex Multi-Auth").

**Features** :
- **Liste des comptes** : alias, email, statut (✅ Active, ⏳ Cooldown, ❌ Auth Error, ⚠️ Low Quota).
- **Bouton "Add Account"** : déclenche `codex-auth-start` (ouvre le navigateur, lance le serveur de callback).
- **Toggle Enabled** : iOS-like switch pour activer/désactiver un compte de la rotation (comme guard22).
- **Bouton "Re-auth"** : relance le flux OAuth pour rafraîchir les tokens.
- **Bouton "Remove"** : supprime le compte (avec confirmation).
- **Indicateur de quota** : barre de progression ou badge (daily/weekly) avec fraîcheur (`fresh`, `stale`, `unknown`).
- **Bouton "Probe Limits"** : force un refresh des quotas pour un compte.

### 6.2 Widget de switch rapide

**Nouveau composant** : `src/components/CodexAccountSwitcher.tsx`

Widget compact (dans la barre d'état ou l'overlay) permettant :
- Voir le compte actuellement actif.
- Switcher manuellement vers un autre compte (Force Mode).
- Voir un indicateur visuel si le compte actuel est proche de sa limite.

### 6.3 Paramètres de rotation

**Nouveau composant** : `src/components/CodexRotationSettings.tsx`

Dans les Settings :
- **Stratégie** : Radio buttons (Round-robin, Least-used, Random, Weighted-round-robin).
- **Force Mode** : Dropdown pour pinner un compte spécifique + affichage du TTL restant.
- **Seuils** : Sliders pour `criticalThreshold` et `lowThreshold`.
- **Poids par compte** : Inputs numériques (visible uniquement si Weighted est sélectionné).

### 6.4 Notifications & Toasts

- Toast de succès quand un nouveau compte est ajouté.
- Toast d'avertissement quand un compte atteint le `lowThreshold`.
- Toast d'erreur quand tous les comptes sont épuisés.

### Livrables
- Composants React dans `src/components/codex-multi-auth/`.
- IPC handlers correspondants dans `electron/ipcHandlers.ts`.
- Storybook ou screenshots de l'UI pour validation.

---

## Phase 7 : Observability & Diagnostics (2-3 jours)

**Objectif** : Avoir de la visibilité sur ce que fait le router en production.

### 7.1 Runtime Observability

**Nouveau fichier** : `electron/services/CodexRuntimeObservability.ts`

Inspiré de `lib/runtime/runtime-observability.ts` de ndycode.

```typescript
export interface CodexRuntimeMetrics {
  totalRequests: number;
  successCount: number;
  rotationCount: number;        // combien de fois on a switché de compte mid-request
  rateLimitHits: number;
  authFailures: number;
  serverErrors: number;
  averageLatencyMs: number;
  perAccountMetrics: Record<string, {
    requestCount: number;
    successCount: number;
    lastUsedAt?: string;
  }>;
}
```

- Persistance dans un fichier JSON léger (ex: `userData/codex-runtime-metrics.json`).
- Reset possible via l'UI.

### 7.2 Decision Logs

Chaque sélection de compte et chaque rotation doivent être logguées :
```
[2026-05-01T10:00:00Z] requestId=abc123 strategy=round-robin selectedAlias=perso forced=false
[2026-05-01T10:00:01Z] requestId=abc123 rotation=true from=perso to=pro reason=429_retry_after=30s
```

- Pas de logs contenant les tokens (redaction stricte).
- Niveau `debug` uniquement (activable via `CODEX_MULTI_AUTH_DEBUG=1`).

### Livrables
- `electron/services/CodexRuntimeObservability.ts`.
- Panneau "Diagnostics" dans l'UI affichant les métriques en temps réel.

---

## Phase 8 : Tests & Hardening (5-7 jours)

**Objectif** : Valider la fiabilité, la sécurité, et la robustesse du système.

### 8.1 Tests Unitaires (Jest/Vitest)

| Module | Tests |
|---|---|
| `CodexOAuthFlow` | PKCE generation, URL construction, callback parsing, token exchange mock. |
| `CodexAccountManager` | CRUD, refresh token, persistence, migration. |
| `CodexAuthRouter` | Round-robin, weighted, least-used, random, force mode, TTL expiry, cooldown. |
| `CodexResponsesClient` | Retry logic, rotation on 429, rotation on 5xx, no-rotation on 401. |
| `CredentialsManager` | Migration v1→v2, chiffrement des tokens OAuth. |

### 8.2 Tests d'Intégration

- **Sandbox** : Environnement isolé (`HOME=/tmp/natively-sandbox`) avec des comptes de test.
- **Rotation end-to-end** : Simuler 100 requêtes avec 3 comptes mockés et vérifier la distribution.
- **Failover** : Compte 1 retourne 429, vérifier que la requête est re-tentée sur le compte 2.
- **Force mode** : Forcer le compte 1, vérifier que 100% des requêtes vont sur le compte 1.
- **Cooldown recovery** : Simuler un cooldown, vérifier que le compte redevient éligible après.

### 8.3 Tests de Sécurité

- Le serveur OAuth callback rejette les requêtes non-`127.0.0.1`.
- Les tokens OAuth n'apparaissent jamais dans les logs.
- Les tokens sont chiffrés au repos.
- Scrub memory on quit (déjà fait dans `CredentialsManager.scrubMemory()`).

### 8.4 Tests de Charge

- Burst de 50 requêtes concurrentes, vérifier :
  - Pas de race condition dans le store.
  - Pas de double-refresh du même token.
  - Le rate limiter par compte fonctionne.

### Livrables
- Suite de tests dans `tests/unit/codex-multi-auth/` et `tests/integration/codex-multi-auth/`.
- Rapport de couverture > 80% sur les nouveaux fichiers.

---

## Phase 9 : Documentation & Release Readiness (2 jours)

### 9.1 Documentation utilisateur
- `docs/codex-multi-auth-setup.md` : Comment ajouter ses premiers comptes Codex.
- `docs/codex-multi-auth-troubleshooting.md` : "Mon compte est flagged", "Tous mes comptes sont en cooldown", etc.
- Mise à jour du `README.md` principal pour mentionner le support Codex multi-auth.

### 9.2 Documentation technique
- `docs/codex-multi-auth-architecture.md` : Architecture complète (mainteneur).
- `AGENTS.md` : Mise à jour avec les nouvelles conventions.

### 9.3 Checklist de release
- [ ] `tsc --noEmit` passe sans erreur.
- [ ] Tous les tests passent.
- [ ] Pas de tokens en dur dans le code.
- [ ] Pas de régression sur les providers existants (Gemini, Groq, etc.).
- [ ] Feature flag possible : `CODEX_MULTI_AUTH_ENABLED=1` pour activer progressivement.

---

## Calendrier Estimé

| Phase | Durée | Cumul |
|---|---|---|
| 1. Recherche & Validation | 2-3 jours | 2-3 jours |
| 2. Architecture & Data Model | 2 jours | 4-5 jours |
| 3. OAuth & Account Manager | 4-5 jours | 8-10 jours |
| 4. Rotation Engine | 4-5 jours | 12-15 jours |
| 5. API Client & LLM Integration | 5-6 jours | 17-21 jours |
| 6. UI React | 5-6 jours | 22-27 jours |
| 7. Observability | 2-3 jours | 24-30 jours |
| 8. Tests & Hardening | 5-7 jours | 29-37 jours |
| 9. Docs & Release | 2 jours | 31-39 jours |

**Total estimé : 5 à 8 semaines** (1 développeur full-time).

---

## Risques & Mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| OpenAI bloque/modifie le flux OAuth | **CRITIQUE** | Phase 1 de recherche obligatoire. Si le flux est instable, fallback sur l'amélioration du provider `opencode_go` existant (API keys). |
| Violation des ToS OpenAI | **CRITIQUE** | Analyse juridique en Phase 1. Feature flag `CODEX_MULTI_AUTH_ENABLED` pour désactiver rapidement. |
| Tokens OAuth expirant trop vite | Moyen | Proactive refresh + re-auth facile depuis l'UI. |
| Race conditions sur le store | Moyen | Write lock + atomic writes (tmp → rename). Tests de charge en Phase 8. |
| Régression sur providers existants | Moyen | Isolation stricte : le router Codex ne touche que au provider `codex`. Tests de non-régression. |
| Complexité UI trop élevée | Faible | MVP de l'UI : liste + switch + strategy. Dashboard avancé en V2. |

---

## Fichiers à créer / modifier (Summary)

### Nouveaux fichiers
```
electron/services/CodexOAuthFlow.ts
electron/services/CodexAccountManager.ts
electron/services/CodexAuthRouter.ts
electron/services/CodexResponsesClient.ts
electron/services/CodexRuntimeObservability.ts
electron/types/codex-multi-auth.ts
src/components/CodexAccountsManager.tsx
src/components/CodexAccountSwitcher.tsx
src/components/CodexRotationSettings.tsx
tests/unit/codex-multi-auth/
tests/integration/codex-multi-auth/
docs/codex-oauth-research.md
docs/codex-multi-auth-architecture.md
```

### Fichiers à modifier
```
electron/services/CredentialsManager.ts        (+ champs codexAccounts, migration)
electron/LLMHelper.ts                          (+ branche codex)
electron/ProcessingHelper.ts                   (+ init codex)
electron/ipcHandlers.ts                        (+ handlers codex-*)
electron/preload.ts                            (+ API renderer)
AGENTS.md                                      (+ conventions)
```

---

*Plan rédigé le 2026-05-01. Sujet à révision après la Phase 1 (Recherche) si le flux OAuth s'avère non viable.*
