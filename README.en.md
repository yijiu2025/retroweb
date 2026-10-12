# RetroWeb · Retrosynthesis Workbench (Standalone Frontend)

[简体中文](README.md) | **English**

A target molecule → one (or several) retrosynthesis routes, plus a set of process analyses.
The frontend owns growing and interacting with the route tree; models and chemistry computation
are handled by the backend and by in-browser RDKit.

**Two entry points** (this is the most commonly confused part):

| Entry point        | What it calls                     | Semantics                                                                          |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------------- |
| **Step-by-step**   | `POST /api/jobs` with `kind=predict` | Unwraps **one step** at a time; you pick from candidates; accepted precursors each add a row |
| **Search to the end** | `POST /api/jobs` with `kind=search` | One **exhaustive search** (Retro\* spends its full call budget), returning several complete routes, then builds the tree |

Both grow into the same kind of tree — what differs is *who chooses*. The old README line saying
multi-step search is "deliberately **not** used" no longer holds: multi-step search is now a first-class entry point.

On top of the routes sit three more capabilities: **multiple route networks kept side by side and
switchable at any time** (not a tree deletion — switch back and it reattaches as-is) ·
**every analysis is archived, identical intermediates are auto-reused** (no model re-runs) ·
**per-step process flow + LLM process analysis** (charge order / equivalents / reaction outcome /
by-products / LCMS / NMR).

Login uses an **iframe embedding oauth21 `/mini-login`** (same SSO model as posecraft / firewall).
Registration, password recovery, email 2FA, and device limits are all provided by oauth21; this
application has no login page of its own.

> Stack: Vue 3.5 + TypeScript 6 + Vite 8 (Rolldown + Oxc) + Pinia + Vue Router + axios + Element Plus 2.14
> Port: **5177** (oauth21 takes 5174/5175, posecraft takes 5176)

## What this is

RetroWeb is a ready-to-run **retrosynthesis route workbench**: give it a target product, and the
model proposes precursor disconnections step by step. You can intervene, edit, and compare at every
step, and save the routes that work into multiple schemes for side-by-side review.

- **Repository**: <https://github.com/yijiu2025/retroweb>
- **In-app**: the "Run Settings" dialog and the bottom of the "Profile" page both show this same
  introduction and repository link.

**Capabilities at a glance**

| Capability | Notes |
| --- | --- |
| Interruptible stepwise retrosynthesis | One step per call; you choose from candidates; accepted precursors each add a row |
| Retro\* exhaustive search | Searches to the end in one call, with controllable budget (depth / calls / heavy atoms) |
| Multi-scheme comparison | Switch schemes any time without deleting trees; switching back reattaches as-is |
| Analysis reuse | Identical intermediates reuse prior results — no model re-runs |
| LLM process analysis | Charge order / equivalents / outcome / by-products / LCMS / NMR, plus free-form follow-up questions |
| Chemistry tooling | In-browser RDKit parsing (except CDXML), structure editor, one-click copy of CAS / formula / MW |
| Deployment shapes | Pure frontend with localStorage, or via a Node relay that persists per user |

> ⚠️ **AI analysis output is model speculation and has not been experimentally verified.** Whether a
> predicted structure is correct depends on the upstream model; the whole chain needs human review.
> This project is a research aid, not a basis for production decisions.

## Quick index

| If you want to… | Read |
| --- | --- |
| Get it running | [1. Getting started](#1-getting-started) |
| Understand the login wiring (cross-project config) | [2. Login](#2-login-how-the-iframe-sso-is-wired) |
| Know where to start reading the code | [3. Directory layout](#3-directory-layout) |
| Learn to use the workbench | [4. Using the workbench](#4-using-the-workbench) |
| Draw structures | [5. Structure editor](#5-structure-editor--ketcher-314) |
| Configure an LLM / read the analysis API | [6. LLM process analysis](#6-llm-process-analysis-optional) |
| Avoid the known pitfalls | [7. Known constraints](#7-known-constraints) |
| Read commit history / see which lines changed in a file | [docs/how-to-read-diff.md](docs/how-to-read-diff.md) |

---

## 1. Getting started

```bash
cd retroweb
npm install
npm run dev          # http://localhost:5177
```

### Backend services it depends on (separate terminals)

| Service                     | Address           | Purpose                       | Required                     |
| --------------------------- | ----------------- | ----------------------------- | ---------------------------- |
| Retrosynthesis model (Flask)| `127.0.0.1:8000`  | See the endpoint list below   | ✅ Yes                        |
| Account service (Fastify)   | `localhost:3000`  | `userinfo` / `bind-session`   | Only for **real login**      |
| oauth21 login page          | `localhost:5174`  | iframe login UI               | Only for **real login**      |
| LLM API (OpenAI-compatible) | External          | `/api/llm/*` process analysis | Only for **AI analysis**     |

**Model service endpoints** (`F:\retrochimera\web\app.py`):

| Path                                                         | Purpose                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `GET /api/models`                                            | Model readiness matrix (retro / forward model load state and timing)     |
| `POST /api/jobs`                                             | **Main entry**: `kind=predict` (single step) / `kind=search` (multi-step) |
| `GET /api/jobs/<job_id>` · `POST /api/jobs/<job_id>/cancel`  | Job polling and cancellation                                             |
| `POST /api/parse`                                            | Structure parsing (**CDXML only**: browser RDKit cannot read CDXML)       |
| `POST /api/depict`                                           | RDKit-computed 2D coordinates, for loading an existing structure          |
| `POST /api/load` · `POST /api/forward/load`                  | Load retro model / **hot-attach** forward model (feasibility filter, no restart) |
| `POST /api/model-service/<action>`                           | Control the resident model process (start / stop / restart)              |
| `GET·POST /api/llm/*`                                        | LLM settings, endpoint profiles, model list, analysis and SSE streaming   |
| `POST /api/feedback` · `GET /api/feedback`                   | Error feedback for learning                                             |
| `GET /api/_threads`                                          | Thread diagnostics                                                      |
| `POST /api/predict` · `POST /api/search`                     | **Legacy endpoints, kept for compatibility**; new code uses `/api/jobs`   |

Start the backend (it lives in another repo → [**retro**](https://github.com/yijiu2025/retro);
local path `F:\retrochimera`):

```bash
cd F:\retrochimera
启动后端API.bat            # double-click; the script is in the **repo root**, not under web/
```

Or from the command line:

```bash
cd F:\retrochimera\web
python app.py                 # defaults to 8000; override with RETRO_PORT
```

> When deploying the backend on another machine, model weights (9GB) and dependencies must be
> prepared again — don't rely on this section alone; follow the
> [retro repository README](https://github.com/yijiu2025/retro).

### Environment variables: exactly three env files

| File                      | Purpose                                                                                              | Committed                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.env.example`            | Full field documentation (template, **not used at build time**)                                       | ✅                                |
| `.env.development`        | Dev profile. Defaults to "bypass login + direct Python"; the "real login + Node relay" switches are documented inline as **profile B** | ✅                                |
| `.env.production.example` | Production template → copy to `.env.production`                                                       | ✅ (template) / ❌ (`.env.production`) |

> 🔴 The `*.local` override mechanism is **deprecated** — it is applied last and will silently
> override the shared team profile, with the classic symptom being "I changed `.env.development`
> and nothing happened". To switch profiles, edit that file directly.
> After editing you **must restart the dev server** (Vite only reads env at startup).
> To change the backend host/port, use `DEV_API_TARGET` / `DEV_RETRO_TARGET` (no `VITE_` prefix —
> they are read only by the proxy).

### Bypassing login during development (on by default)

`VITE_AUTH_BYPASS=true` in `.env.development`:

- The router guard lets everything through, injects a `开发者` (developer) user, and the top bar
  shows an orange "开发模式 · 免登录" (dev mode · login bypassed) badge
- **No iframe is created, no userinfo call, no login request is sent**

To verify the real login loop: switch the five lines per "profile B" in `.env.development`, and make
sure both 3000 and 5174 are running.

### Three gates (all must be green before you commit)

```bash
npm run type-check   # vue-tsc -b (🔴 must be -b; bare vue-tsc always returns 0 — false green)
npm run lint         # eslint .
npm run build        # type-check, then vite build
```

> If `vite build` targets an existing `dist/`, the safe-delete shim blocks it — for a temporary
> verification pass use `--outDir <a brand-new directory>` instead of deleting `dist/`.

### Releasing (version decided automatically from commit types)

```bash
npm run release                          # preview, writes nothing (the default)
npm run release -- --apply               # execute: gates → align version → tag → push → create Release
npm run release -- --from v1.0.0         # explicit start point (retrospective / back-fill)
npm run release -- --apply --allow-dirty # allow a dirty tree (parallel work in flight)
npm run release -- --apply --skip-checks # skip the pre-release gates
npm run test:release                     # unit tests for the decision logic (node:test)
```

**Decision rules** (baseline = latest tag)

| Commit type                                        | Release? | Bump                        |
| -------------------------------------------------- | -------- | --------------------------- |
| Breaking (`!:` or a footer-form `BREAKING CHANGE`) | yes      | major: `1.0.2` → `2.0.0`    |
| Contains `feat`                                    | yes      | minor: `1.0.2` → `1.1.0`    |
| Only `fix` / `perf`                                | yes      | patch: `1.0.2` → `1.0.3`    |
| Only chore/docs/test/style/ci/refactor/build        | **no**   | —                           |

A few boundaries:

- **The version source is the git tag**; `package.json`'s `version` follows it one-way —
  the script aligns it before tagging and, if it differs, commits a separate
  `chore(release): x.y.z`. **Do not derive the version from `package.json`.**
- Breaking changes are recognised **only in footer form** (at line start, with a colon). This must not
  degrade into substring matching — merely *mentioning* the phrase in a commit body (for example while
  writing this very rule) would bump a minor to major.
- Before `--apply` the script runs type-check / lint / audit:jsdoc / verify:readme / build in order.
  The browser probes (`verify:ep-style` etc.) need a dev server and are **not** run by the script.
- Release notes are **publicly visible**; the script lists commits whose subject looks sensitive
  (vulnerability / secret / token …) so you can confirm before publishing.
- Tag pushes can be extremely slow or produce no output ⇒ always judge by `git ls-remote`,
  **never by the exit code**.
- **If a tag was pushed but its Release is missing, re-running the script back-fills it**
  (the two drift apart easily, and it is very hard to notice afterwards).

---

## 2. Login: how the iframe SSO is wired

```
Avatar "Log in" → SsoLoginModal
   ├─ has saved accounts → 'accounts' state (one-tap switch / forget / use another account)
   └─ otherwise          → 'login' state: <iframe src=oauth21/mini-login?appName=retroweb…>
        ├─ @load         → start only the 3s fallback timer (does not close loading)
        ├─ SSO_READY     → close loading + postMessage THEME_CHANGE
        ├─ LOGIN_SUCCESS → adoptDeviceId(deviceId) → POST /auth/v1/bind-session
        │                   ├─ success → write authStore + savedAccounts → close dialog
        │                   └─ failure → show error and **abort** (never close silently = fake login)
        ├─ MAX_SESSIONS → tell the user the device limit was reached
        └─ SSO_DENIED   → tell the user access was denied
```

Incoming messages are validated twice (drop either check and an attacker can forge a
`LOGIN_SUCCESS` to inject their own session):

```ts
if (event.origin !== ssoOrigin) return;
if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return;
```

### 🔴 Two cross-project settings (miss either and login simply won't work)

| File                       | Change                                                                        | Symptom if missing                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `oauth21/.env.development` | Append `http://localhost:5177,http://127.0.0.1:5177` to `VITE_ALLOWED_PARENT_ORIGINS` | The dialog sits at "正在加载安全登录" until the 3s fallback; oauth21 console logs `[SSO] 拒绝 postMessage：父 origin 未授权` |
| Backend production `CORS_ORIGINS` | Append the frontend production origin                                          | Production `bind-session` returns 403 "origin not allowed" (**an empty dev allow-list passes, so it feels fine locally and only breaks after release**) |

> The first is already configured in this repo; for the second, see the comments in the root
> `.env.production`.

---

## 3. Directory layout

```
retroweb/
├─ public/smiles-drawer.min.js      # pure-frontend SMILES→SVG (display only)
└─ src/
   ├─ config/services.ts            # SSO_URL / buildSsoLoginUrl / RETRO_BASE / AUTH_BYPASS
   ├─ config/about.ts               # project intro, repo URL, donation info (single source)
   ├─ api/{http,retro}/ + auth.ts   # http = envelope + 401; retro = model service; auth = session
   ├─ composables/
   │    ├─ useSsoMessage.ts         # ★ the only entry point for the iframe handshake + messaging
   │    └─ useMolIdents.ts          # ★ single source for molecule identifiers (CAS / SMILES / name)
   ├─ stores/{auth,workspace,settings}.ts
   ├─ types/{external,retro,sso}.ts # external = third-party globals on window; sso uses zod discriminated unions (no `any`)
   ├─ utils/
   │    ├─ rdkit.ts                 # ★ in-browser RDKit WASM (lazily loaded singleton)
   │    ├─ smiles-drawer.ts         # SMILES → SVG
   │    ├─ pubchem.ts               # ★ CAS lookup (POST form; 404 = not indexed)
   │    ├─ suppliers.ts             # ★ single source for supplier identifiers used in price quotes
   │    ├─ route-copy.ts            # single source for copy formats
   │    ├─ scheme-save.ts · probability.ts · smiles.ts · clipboard.ts · device.ts
   ├─ components/
   │    ├─ common/AboutProject.vue  # ★ project intro + repo link + donation block (shared by two pages)
   │    ├─ sso/SsoLoginModal.vue    # ★ dialog shell (accounts / login states)
   │    ├─ mol/
   │    │    ├─ StructureEditor.vue # ★ structure editor = Ketcher 3.14 (Vue↔React bridge, lazy)
   │    │    ├─ MolView.vue         #   read-only structure rendering
   │    │    ├─ MolPreviewDialog.vue · MolChip.vue · CasTag.vue
   │    ├─ layout/AppShell.vue      # sidebar (nav + recent jobs + target analysis) + top bar + content
   │    ├─ layout/{UserMenu,DevBypassBadge}.vue · AsidePanel.vue
   │    └─ workspace/
   │         ├─ TargetSetupPanel.vue  # ★ calibration state: one large centred card (input + params + single exit)
   │         ├─ TargetInput.vue       # ★ target input (one box for CDXML/MOL/SDF/SMILES + diagnostics)
   │         ├─ TargetBar.vue         #   target bar at the top in route state
   │         ├─ TargetOverview.vue    #   "Target analysis" tab
   │         ├─ RunParams.vue         # ★ run parameters (prediction settings / decomposition constraints / AI analysis + endpoint config)
   │         ├─ SessionPanel.vue      #   sidebar "Recent jobs"
   │         ├─ StepTree.vue · StepRow.vue      # "Retrosynthesis tree" tab
   │         ├─ RouteCanvas.vue · RouteStats.vue # "Route network" tab (canvas + stats)
   │         ├─ RouteFlow.vue · StepAnalysis.vue # "Step details" tab (flow + per-step AI analysis)
   │         ├─ SchemeBar.vue · SchemeCompare.vue # route network: save / switch / compare
   │         ├─ CandidatePanel.vue    # candidates + run history (every analysis is archived)
   │         ├─ StepEditDialog.vue    # manual route editing (specify the precursors of one step)
   │         ├─ SearchProgress.vue    # progress panel during a multi-step search
   │         └─ JobProgress.vue
   ├─ utils/time.ts               # relative/absolute time strings (shared by sidebar and job list)
   └─ views/{WorkspaceView,TasksView,HistoryView,ProfileView,NotFoundView}.vue
```

---

## 4. Using the workbench

> **Layout**: the workbench has two shapes, toggled by `store.targetSetupOpen`.
> **① Calibration state** — on first entry or after clicking "Change target": one large centred
> card that merges the three things you do at the start of a job — left column "structure canvas +
> paste box + parse diagnostics", right column "run parameters", and a single bottom exit
> "**Confirm target, start analysis**".
> **② Route state** — after pressing that button the card **disappears entirely**, switching to the
> route-first layout: a target molecule bar at the top (structure thumbnail + formula / MW / heavy
> atoms + "Change target"), **four tabs** in the middle, and a **collapsible** parameters panel on
> the right (when collapsed the main area takes the full width).
>
> 🔴 Two semantic conventions that are easy to get wrong:
>
> - **Parsing successfully ≠ starting the run.** A successful parse only means "the target is
>   filled in" — you may still want to change model parameters, so the card does not auto-dismiss.
>   Only explicitly clicking "Confirm target, start analysis" collapses the panel and takes step one.
> - **Changing target = starting a new job.** "Change target" clears the current tree and returns
>   to calibration state (rather than expanding in place), because that is exactly the "start of a
>   job" context. One target analysis = one job.
>
> Run parameters are grouped into three collapsible sections — prediction settings / decomposition
> constraints / AI process analysis (native `<details>`, no extra dependency, keyboard operable),
> and each group header shows the key value (model name, depth · budget, LLM status).
> Jobs have two entry points with different jobs to do:
>
> - **Sidebar "Recent jobs"** is pinned below the navigation and fills the remaining height — it is
>   the shortcut for "go back to what I was doing". It lists the first 6 entries (the rest go into a
>   collapsible "Earlier jobs"), each with a status dot + relative time + hover-to-delete; it hides
>   automatically when the sidebar is collapsed. Once you have more than 6 jobs, a
>   "View all N jobs →" link appears at the bottom.
> - **Top-level menu "Jobs" (`/tasks`)** sits alongside the workbench — it lists everything, with
>   search by keyword (name / SMILES / model), filtering by status, sorting by update time or name,
>   and node count / decided steps / depth / scheme count per row; you can open one to continue or
>   delete it.
>
> 🔴 Jobs (`store.sessions`) ≠ history (`store.history`): the former are tasks still in hand,
> carrying the full route tree and unfinished jobs, so opening one means **continuing**; the latter
> are manually "saved" snapshots, so opening one means **reviewing / loading**.

### The four tabs

| Tab             | Components                      | Shows                                            |
| --------------- | ------------------------------- | ------------------------------------------------ |
| **Target analysis** | `TargetOverview`            | Target molecule properties, CAS, purchasability, stat chips |
| **Retrosynthesis tree** | `StepTree` / `StepRow`  | One compound per row; expand / adopt / reuse     |
| **Route network** | `RouteCanvas` / `SchemeBar`  | Confirmed route networks, multiple schemes side by side |
| **Step details** | `RouteFlow` / `StepAnalysis`  | Per-step process flow + per-step AI analysis     |

1. **Target molecule** (left column of the calibration card): click **"Draw structure"** to open the
   Ketcher canvas and draw by hand (the structure is parsed as soon as you finish), or paste CDXML /
   MOL / SDF copied from ChemDraw, or pick a file, or type SMILES — **one input box handles four
   formats**, auto-detected (see `needsBackendParse()`). A failed parse yields a human-readable
   diagnosis plus one-click repair candidates (R groups, `[*]`, generic substituents). On success
   the card shows a structure thumbnail plus formula / MW / heavy atoms / kind, and
   "Confirm target, start analysis" becomes available.
2. **Run parameters** (three collapsible groups; in the right column of the calibration card, moved
   to the right-hand panel in route state, collapsible):
   - **Prediction settings** (expanded by default): model (Pistachio / USPTO-FULL / USPTO-50K) +
     warm-up, candidates per step
   - **Decomposition constraints** (collapsed by default): auto decomposition depth, purchasable
     heavy-atom threshold (default **≤6**), call budget, designated starting materials
   - **AI process analysis** (collapsed by default): endpoint config status + a "Verify" button
     (the status is also always visible on the group header)
   - The **"Search to the end"** button is **pinned outside the groups**, never hidden in a collapsed section
   - **Feasibility filter**: when checked, multi-step search filters infeasible steps with the
     forward model — the forward model can be **hot-attached** (`/api/forward/load`, no restart),
     and if it isn't ready you are **blocked before submitting**, so it never fails mid-run.

   > With a threshold of 10, one step of aspirin already hits the ceiling (precursors are commonly
   > ≤10 heavy atoms); lower it to decompose further (6 heavy atoms — the benzene-ring scale — is a
   > common choice).
   > ⚠️ "Candidates per step" applies to **single-step prediction only**: syntheseus sets
   > `DEFAULT_NUM_RESULTS=100`, and the multi-step main loop calls `reaction_model(mols)` without
   > `num_results`, so changing it has no effect on multi-step search.

3. **Retrosynthesis tree**: click "Expand" on a row to run one step of prediction → "Adopt" on a
   candidate card → each precursor adds a row.
   - Termination: mark a compound purchasable by hand / heavy atoms ≤ threshold / hits a designated starting material
   - Loop prevention: a SMILES already seen on the same branch is labelled "duplicate on this branch" and cannot be expanded again
   - Rows that already satisfy a termination condition have their "Expand" button **disabled**, with the tooltip explaining why and how to lift it
   - **Every analysis is archived**: repeatedly hitting "Re-analyze / Re-select" on the same row keeps each run in `runs`, and the in-row dropdown can **switch back to any previous run** (candidates, probability and timing roll back together) — results never overwrite each other
   - **Identical intermediates are auto-reused**: if a newly expanded molecule was already analyzed in the tree (same canonical SMILES), the old result is attached and labelled "reused"; **the model does not run again**. You can still manually "Re-analyze" to override
   - **Manual route editing**: `StepEditDialog` lets you specify the precursors of a step directly (a fallback when the model can't find a disconnection). A manual step's probability is **`null`** — do not coerce it to 0
4. **Route network / schemes (SchemeBar)**: **multiple routes for the same target are kept side by
   side** and can be switched at any time.
   - A route can have **branches** (one step yielding ≥2 precursors) ⇒ it is a **network**, not a chain
   - The confirmation entry point lives in the "Retrosynthesis tree": once satisfied, click
     "Confirm route network" on the tree (if the current scheme was modified, it **forks** a new
     record instead of overwriting the old one)
   - Switching schemes **rewrites the selection** rather than deleting trees: removed branches are
     marked `detached` (kept in memory, excluded from stats) and **reattach as-is** when you switch
     back — no re-runs, no loss of existing analyses
   - Changing the selection of a **saved** scheme auto-**forks** a new scheme; the old one is never overwritten
   - Scheme comparison table: steps, total probability, starting-material count, and marked terminal steps for each scheme, side by side
   - 🔴 Scheme-switching correctness is guarded by the **real store** (`applySearchRoutes` only lays out candidates; per-route adoption is forbidden — shared nodes would overwrite each other and leave only the root)
5. **Step details (RouteFlow)**: renders the selected route as a pipeline — one card per step,
   "precursors (raw materials) →〔conditions / reagents / equivalents〕→ product", with conditions
   taken from that step's AI analysis (empty if not analyzed yet). Cards can expand to show
   per-step analysis, can trigger AI analysis per step, and the top-level "Analyze the whole route"
   runs every step serially. Clicking "Process analysis" in the tree or route table switches to this
   view and **scrolls to** the matching step.
6. **History**: job snapshots are stored in localStorage (up to 30), and can be loaded or deleted.
   A snapshot contains the route schemes (`schemes` / `currentSchemeId`) and each step's analysis
   result. In addition, a **"Recent jobs"** list is pinned to the lower half of the sidebar (sorted
   by update time, up to 12 entries); clicking any entry loads it (restores the route tree, switches
   back to the workbench and reattaches polling for any still-running job). Hovering a row reveals a
   delete button with a confirmation step. Opening a job that already has a route enters **route state** directly.

⚠️ Model predictions may contain hallucinations, so a warning bar is always visible; exported files carry a disclaimer.

---

## 5. Structure editor = Ketcher 3.14

Click **"Draw structure"** to open it. The editor is **Ketcher** (open source by EPAM, Indigo WASM
core); `components/mol/StructureEditor.vue` provides the Vue↔React bridge:

```
Editor (Ketcher) ──getMolfile()──▶ frontend RDKit.js ──▶ canonical SMILES + formula + MW + diagnostics
frontend RDKit ──depictMolfile()──▶ editor loadFromMolfile(mol)   (loading an existing structure)
```

**The division of labour is unchanged**: the editor only handles editing, and **chemical
correctness is always adjudicated by RDKit** (valence / Markush all covered). An early version used
a hand-rolled SVG editor (`rings.ts` / `useStructureEditor.ts`, since deleted); it was replaced by
Ketcher because aromaticity, stereochemistry, template libraries and the periodic table all come
with Ketcher, and because **standalone mode compiles Indigo to WASM inlined into a worker** — fully
offline, with no Indigo backend service.

🔴 **Four measured facts** (read before changing anything):

1. **The WASM is not an external file — it is an inlined data URI.** `ketcher-standalone`'s
   `findWasmBinary()` returns `data:application/octet-stream;base64,…` (8.9MB of base64 embedded in
   the worker source). Consequences: you can pass an empty `staticResourcesUrl` and the WASM will
   never 404; the price is a **16MB** `ketcher-standalone/dist/main.js` ⇒ **it must be lazily
   loaded**. Here it is loaded via dynamic `import()`, strictly only when the dialog first opens.
2. **`ketcher-react` is an entire React tree** (2.4MB ESM, pulling in MUI / emotion / redux /
   draft-js…). Vue cannot use SFC templates for it ⇒ we mount it manually with `createRoot` +
   `createElement` (no JSX). It `import`s `'util'` (a browserify polyfill) containing bare `process`
   references ⇒ `index.html` shims `window.process`, otherwise you get "process is not defined".
3. **`Editor` has only three required props**: `staticResourcesUrl` / `structServiceProvider` /
   `errorHandler`; `ketcherId` is taken over internally. The instance is handed back via
   `onInit(ketcher)` — this arrives **one tick later** than `root.render()` (React 18 concurrent
   rendering), so a separate `whenReady()` must wait for it.
4. **All APIs are asynchronous** (they cross the WASM worker) ⇒ `isEmpty()` / `getMolfile()` must be
   awaited. When opening the editor you must seed it with the current structure (`resolveSeed()`) —
   opening an empty canvas would force the user to redraw what they just pasted.

> ⚠️ Ketcher 3.14 is **light theme only** (there's no dark switch in the build). It keeps a white
> canvas even in a dark-themed app — the "paper" look of a chemistry editor is an industry
> convention; don't fight it.
>
> ⚠️ Don't be alarmed by the bundle size: `main-*.js` at 16MB is **that** lazy chunk (Vite names
> chunks after the source file) and is **not on the first screen**. The actual first screen is
> ~1.3MB (≈350KB gzipped).

---

## 5.5. Two sizing modes for molecule rendering (MolView)

`MolView` renders SVG via smiles-drawer and has **two** sizing modes; picking the wrong one yields
either "the structure is cropped" or "it collapses to zero height":

| Mode               | How it works                                            | Suitable containers                                                                                       |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Fixed pixels (default) | `:bond-px :min-px :maxPx` produce explicit px written back into the SVG | **auto-sized** containers (candidate cards, route rows, preview dialogs) — the container grows with the image |
| `fit`              | width/height 100% + `viewBox` uniform scaling           | **fixed-size** containers (`.step-row__mol` 104×64, `.target__mol` 150×120, `.history-item__mol` 120×88) |

🔴 Fixed-size containers are all `overflow: hidden`, so without `fit` large molecules get cut in
half. Conversely, turning on `fit` for an auto-height container collapses the SVG to zero height —
**the two modes are not interchangeable**.

---

## 6. LLM process analysis (optional)

Adds one more layer on top of the **retrosynthesis route**: what it would actually take to run this
route. Per step — charge order, equivalents, reaction outcome with expected yield, likely
by-products, LCMS / NMR predictions, and safety notes.

### 6.1 Configuration: prefer "Endpoint profiles"; `.env` is only a fallback

**Recommended path**: manage it under "Run parameters → AI process analysis → Endpoint profiles".
There, an **endpoint URL + model + a set of API keys are bound together as one "profile"**, and you
can store several (DeepSeek official / a company gateway…) and switch at any time — changing provider
switches the whole profile, so you never end up with "changed the URL but forgot the model", a
combination that fails with 401/404 on the first call. Each profile can hold multiple keys; when a
request fails (invalid / rate-limited / out of quota) the next key is used automatically, and
**each profile keeps its own independent rotation state**. Saved to `web/llm_settings.json`, effective
immediately.

**Fallback path**: `RETRO_LLM_*` in `web/.env` (only takes effect when "there is not a single endpoint
profile", with **lower** priority than `llm_settings.json`):

```ini
RETRO_LLM_BASE_URL=https://api.deepseek.com/v1
RETRO_LLM_API_KEY=sk-xxxxxxxx          # leave empty = the feature degrades automatically (UI shows "not configured", no error)
RETRO_LLM_MODEL=deepseek-chat
RETRO_LLM_MAX_TOKENS=32768             # 🔴 must be explicit: reasoning tokens count toward the output budget
RETRO_LLM_TIMEOUT=300                  # seconds; leave generous headroom for reasoning models + long prompts
RETRO_LLM_JSON_MODE=1                  # request response_format=json_object
RETRO_LLM_TEMPERATURE=0.3              # chemistry needs stability; don't raise it
```

**Changes take effect immediately, no restart needed** (the backend hot-reloads by file mtime; empty
values count as "unset", and deleting a line genuinely disables it). Any OpenAI-compatible endpoint
works (self-hosted vLLM / Ollama / OneAPI alike).

🔴 **"Filled in" does not mean "working"** — this is where half an hour usually gets wasted. A
three-step self-check:

```bash
curl "http://127.0.0.1:8000/api/llm/status?probe=1"   # sends a real minimal request, verifies key + model
curl "http://127.0.0.1:8000/api/llm/models"           # lists the models visible to that key
curl -sI "https://<your-endpoint>/v1/models" -H "Authorization: Bearer <key>"   # cheapest: auth only, no tokens spent
```

The **"Verify" button** in "Run parameters" is exactly `probe=1`, and its label distinguishes four
states: grey = not configured / amber = filled in but unverified / green = verified working /
red = verification failed (the tooltip carries the raw error).

**Three pitfalls measured in practice**:

| Pitfall | Symptom | What to do |
| --- | --- | --- |
| `/v1/models` can lie | It lists 9 models, 3 of which immediately return `model is not available in the current token plan` / `model is not found` | **Trust `probe`, not the list** |
| Rate limits are **per model endpoint** | After one endpoint returns `429 RateLimitExceeded.EndpointTPMExceeded`, even `"hi"` cannot be sent — but switching to a different model works fine at that same moment | Switch model (a different model = a separate quota) |
| Omitting `max_tokens` causes truncation | For reasoning models, **thinking tokens count toward the output budget** ⇒ if it's too small the body produces nothing before `finish_reason=length`, and no JSON can be extracted | Always send it explicitly; when the backend sees `length` and cannot extract JSON it **reports "output was truncated"** rather than the vague "parse failed" |

> `max_tokens=0` means **unlimited** (the backend omits the field entirely) — don't read it as "output 0 tokens".

### 6.2 Endpoints

| Method   | Path                          | Notes                                                                              |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| GET      | `/api/llm/status`             | Whether it is configured (**never returns the api_key**, only a `has_key` boolean). `?probe=1` adds the real verification result |
| GET      | `/api/llm/models`             | Model ids visible to that key (**listed ≠ available on your plan**)              |
| GET·POST | `/api/llm/settings`           | Read/write endpoint profiles (multiple)                                            |
| POST     | `/api/llm/settings/active`    | Switch the active profile                                                          |
| POST     | `/api/llm/keys/reset`         | Reset a profile's key rotation state                                               |
| POST     | `/api/llm/analyze`            | One-shot full JSON                                                                 |
| POST     | `/api/llm/analyze/stream`     | **SSE streaming** (see below)                                                      |
| POST     | `/api/llm/conditions/stream`  | Streaming generation of candidate reaction conditions                             |
| POST     | `/api/llm/followup/stream`    | Follow-up questions (free text, **`response_format` must be off**)                 |

Request body: `{product_smiles, precursors[], conditions?, context?}`.
The server **computes exact masses with RDKit first** (`[M+H]+` / `[M-H]-` / `[M+Na]+`) and puts them
into the prompt; the model is only responsible for **interpreting** them and is never allowed to do
the arithmetic itself — a deliberate anti-hallucination measure.

Streaming event sequence:

```
meta         → {model, computed}     arrives first; the UI can draw the mass table immediately
thinking     → {text}                reasoning-model thinking delta (repeated; not sent by non-reasoning models)
thinking_end → {chars}               thinking finished, body starts
delta        → {text}                body delta (repeated)
done         → {data, computed, raw, model, reasoning, finish_reason}
error        → {error}
```

⚠️ The time distribution across reasoning models is wildly uneven — measured on one step of aspirin:

| Model               | meta  | first thinking | thinking ends | done  | thinking volume        |
| ------------------- | ----- | -------------- | ------------- | ----- | ---------------------- |
| `deepseek-v4-flash` | 0.7s  | 2.6s           | 27.8s         | 40.3s | 1984 events / 3139 chars |
| `glm-5.2`           | 0.01s | 6.2s           | 55.5s         | 57.8s | 427 events / 4646 chars |

**Nothing but thinking is emitted for the first 30–55 seconds**, which is why the `thinking` event
must not be dropped. SSE through the **Vite dev proxy is a true passthrough stream** — no extra dev
configuration needed.

### 6.3 Frontend behaviour (StepAnalysis.vue)

Charge-order table (index / method / reagent / equivalents / notes) · conditions list (solvent /
temperature / time / atmosphere / catalyst / workup) · reaction outcome (expected result / yield range
/ purity / risk) · by-product table (name / origin / m/z / control measure) · LCMS (**theoretical values
from RDKit, annotations from the model**) · NMR (¹H / ¹³C descriptions) · safety notes · confidence.
Text appears progressively as it streams, and it can be **cancelled** at any time (`AbortController`).
There is also a **TLC / chromatography polarity prediction** module (`tlc` / `workup`).

🔴 **Reasoning models must show "thinking"**: models like `glm-5.2` / `deepseek-v4-pro` / `kimi-k3`
emit **only `reasoning_content` for the first ten to fifty seconds** (measured: `glm-5.2` took 55s),
while `delta.content` stays an empty string. If you only read the body, the UI shows nothing at all
during the whole thinking phase — it looks frozen, users assume the service died and hit cancel.
Hence thinking travels on its own `thinking` event, is stored in `analysis.reasoning` (kept separate
from `raw`), is displayed live during streaming, and is collapsed-but-readable afterwards.

### 6.4 Implementation constraints (read before changing)

- **SSE goes over POST + `fetch` + `ReadableStream`, not `EventSource`** — because a request body is required.
- `reasoning_content` **must not be mixed into `raw`**, otherwise `extract_json` hits the thinking text first
  (which often contains brace examples).
- Models frequently wrap JSON in ```json fences or pad it with chatter ⇒ use a **brace-balancing
  scanner** (handling strings and escapes correctly); a one-shot regex truncates at the first `}`
  inside a string.
- **Free-text follow-ups must disable `response_format`** (`json_mode=False`), otherwise the model is
  forced to emit JSON and answers irrelevantly.
- Analysis results are **stored in localStorage per node**, with raw output truncated to 2000
  characters; when the quota is still exceeded all `raw` is dropped so the session survives.
- Route context (upstream products / downstream precursors) is spliced into the prompt so the model
  knows where this step sits in the whole route.
- `.env` hot reload relies on **mtime + baseline replay**: first reset the `RETRO_*` entries in
  `os.environ` that were injected from the file back to "a snapshot of the real environment before
  first load", then replay the file ⇒ lines **deleted** from the file genuinely take effect.
  `setdefault` alone is not enough: an empty value occupies the key, so later filled-in values never
  take effect.

---

## 7. Known constraints

- The first prediction has to load the model and spawn rule subprocesses, which **can take tens of
  seconds to minutes** (measured: pistachio's first frame had not returned after >13 minutes)
  ⇒ the frontend times out at 10 minutes, is cancellable, and offers a "Warm up" button. **Always
  warm up before real use.**
- **The search budget gets eaten by "historical calls"**: under a resident model service,
  `num_calls()` accumulates across searches, and once it passes `limit_reaction_model_calls` the run
  **stops immediately** (visible as finishing in 0 seconds with 0 routes). So the budget is computed
  as "`num_calls()` + this run", not "this run alone".
- If a precursor contains a wildcard atom `*` (R group), or kekulization of an aromatic ring fails,
  Flask returns **HTTP 400 with a structured diagnostic**; the row is marked "failed" and lists a
  human-readable reason (`reasons`) — this is not a frontend bug, the structure the model produced is
  itself unpredictable.
- Flask does **not** enable CORS by default: in dev, traffic goes through the Vite proxy
  (`/retro/*` → `8000/api/*`) on the same origin, so nothing is needed; in production, when frontend
  and backend are on different domains, you **must** set `RETRO_CORS_ORIGINS` on the backend or the
  page will spin forever. In production, putting a gateway in front for authentication is also
  recommended.
- Rule subprocesses are memory-hungry ⇒ auto decomposition is **serial**, with concurrency 1 by default.
- History is stored in localStorage (no backend table wired up yet).
- **AI process analysis results are model speculation** and have not been experimentally verified;
  although LCMS/NMR theoretical values are computed by RDKit, whether the structure itself is correct
  depends on the upstream retrosynthesis prediction — the whole chain needs human review.

---

## 8. Health check record

A full-repository health check was done on 2026-10-09 (cleaning up 1.5GB of temporary files plus
four verification gates); results are in `docs/healthcheck-2026-10-09.md`.

---

## 9. Support this project

This is **voluntary** and affects no feature — the project never limits functionality, slows down,
or shows extra prompts because you did not donate.

The project is used as a **local deployment** (models and inference run on your own machine), so it
incurs no server cost. If your institution has a relevant budget, going through institutional
procurement / a research grant is less trouble for both sides.

> With a modest effort, adding something real to the progress of human society — advancing China's
> organic-AI research ecosystem together with peers, and pushing the fundamentals of biochemistry
> one small step forward.

<table>
  <tr>
    <td align="center"><img src="public/donate/wechat.png" width="220" alt="WeChat donation code"></td>
    <td align="center"><img src="public/donate/alipay.png" width="220" alt="Alipay donation code"></td>
  </tr>
  <tr>
    <td align="center"><sub>WeChat</sub></td>
    <td align="center"><sub>Alipay</sub></td>
  </tr>
</table>

Payee: **世间無晚風(\*功)**

### WeChat Official Account

<p align="center">
  <img src="public/donate/mp-qrcode.jpg" width="150" alt="柒染靓月 WeChat Official Account QR code">
</p>

Search the WeChat Official Account **柒染靓月** (Qiran Liangyue) to follow it. Project progress,
usage tips, and release announcements are published there.

---

## 10. License and disclaimer

This project is released under the **[MIT License](LICENSE)** — you are free to use, copy, modify,
merge, publish, distribute (including commercially) and sublicense it; the only requirement is keeping
the copyright notice and the permission notice in all copies.

> ⚠️ MIT **carries no patent grant**. If you need explicit patent licensing (for example to ship
> inside a corporate product), use Apache-2.0 instead.

Third-party components keep their own licenses, which must be checked individually before commercial
use (the list below is read from the `license` field of `node_modules/*/package.json`, not from memory):

| Component | License |
| --- | --- |
| Ketcher (structure editor) | Apache-2.0 |
| RDKit (`@rdkit/rdkit`, WASM) | BSD-3-Clause |
| Element Plus / Vue / axios / Pinia / Vue Router / zod | MIT |
| Vite / ESLint / Sass / unplugin-vue-components | MIT |
| TypeScript | Apache-2.0 |
| Indigo, bundled inside Ketcher | see the Ketcher repository |

Retrosynthesis predictions and AI process analysis are **model speculation**, not experimentally
verified. Use them for research assistance; do not base production or safety decisions on them
directly.
