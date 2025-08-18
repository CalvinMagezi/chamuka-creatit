# Chamuka Creatit

Chamuka Creatit is an AI-assisted full‑stack React (Next.js) code generation and iterative editing environment. It provisions an **ephemeral, network‑isolated sandbox (E2B)**, streams multi‑provider AI generated code (OpenAI, Anthropic, Groq / Moonshot Kimi, Google Gemini), applies surgical edits to existing files using semantic + heuristic search, auto‑installs missing npm packages, and lets you interactively refine your app via chat.

<img src="/logo.png" alt="Chamuka Creatit Demo" width="100%" />

---

## Key Capabilities

| Domain | Capability | Details |
| ------ | ---------- | ------- |
| Sandbox Orchestration | Ephemeral E2B sandbox creation | 15‑minute default lifetime (`appConfig.e2b.timeoutMinutes`) with Vite dev server inside sandbox |
| Code Generation | Streaming multi-model code output | SSE streaming from `/api/generate-ai-code-stream` with incremental file assembly |
| Surgical Editing | Intelligent target file + line localization | Hybrid approach: AI intent analysis (`/api/analyze-edit-intent`) + deterministic search + fallback keyword heuristics |
| File Context Selection | Minimal relevant context window | `selectFilesForEdit` & search plan trimming to reduce token waste |
| Package Management | Auto detect & install missing deps | `/api/detect-and-install-packages`, `/api/install-packages` with progress streaming |
| Web Intelligence | Enhanced URL scrape + screenshot | `/api/scrape-url-enhanced` (structured data) + `/api/scrape-screenshot` (for design mirroring) via Firecrawl |
| Apply Code | Multi-step streamed application | `/api/apply-ai-code-stream` emits steps, commands, file create/update, package progress |
| Conversation Memory | Lightweight rolling context | Trims message & edit history; preserves patterns & preferences |
| Truncation Awareness | Optional recovery | Configurable attempt logic (currently disabled to avoid false positives) |
| Status & Health | Sandbox lifecycle & logs | `/api/sandbox-status`, `/api/sandbox-logs`, `/api/kill-sandbox` |
| Export | One-click project download | `/api/create-zip` bundles current sandbox filesystem |

---

## High-Level Architecture

1. User enters a request (new feature or edit) in the web UI.
2. Frontend requests `/api/generate-ai-code-stream`:
	 - (Edit mode) Calls `/api/analyze-edit-intent` to create a structured search plan (search terms, edit type, reasoning).
	 - Executes code search against cached sandbox files → selects target file & line.
	 - Constructs a precision system prompt ("surgical edit" style) or falls back to broader context.
3. AI model streams structured plaintext containing code blocks. The client incrementally reconstructs file outputs.
4. User confirms application → client calls `/api/apply-ai-code-stream` (or non-stream variant) to write changes within sandbox.
5. Package detection triggers install if unresolved imports appear.
6. Sandbox Vite server rebuilds; iframe preview auto-refreshes after a configurable delay.
7. Conversation + edit summaries update internal memory state for future intent refinement.

```
Request → Intent Analysis → File / Line Localization → Context Packing → AI Streaming → File Assembly → Apply + Packages → Preview Refresh
```

---

## Streaming Protocols

### Code Generation (`/api/generate-ai-code-stream`)
Server-Sent Events (SSE) messages (selected examples):

| Field | Purpose |
| ----- | ------- |
| `type: status` | Human readable progress (Initializing, Searching, Found code…) |
| `type: debug` | Optional diagnostics (only when debug logging enabled) |
| `type: code` | (Client-side derived) incremental code chunks parsed into files |
| `type: done` | Completion sentinel (may include model usage stats) |

### Code Application (`/api/apply-ai-code-stream`)
Defined in `types/sandbox.ts`:

| Type | Interface | Notes |
| ---- | --------- | ----- |
| `start` | `ApplyCodeStreamStart` | Begin operation |
| `step` | `ApplyCodeStreamStep` | Human-readable step description; may list packages |
| `package-progress` | `ApplyCodeStreamPackageProgress` | Emitted during installs |
| `command` | `ApplyCodeStreamCommand` | Shell command executed inside sandbox |
| `success` | `ApplyCodeStreamSuccess` | Aggregated results (files created/updated, packages installed, explanation, warnings) |

Each SSE line follows: `data: {json}\n\n`

---

## API Surface (App Router Routes)

| Route | Method | Description |
| ----- | ------ | ----------- |
| `/api/create-ai-sandbox` | POST | Provision new E2B sandbox (Vite + Node environment) |
| `/api/sandbox-status` | GET | Active sandbox presence & health |
| `/api/sandbox-logs` | GET | Stream or fetch sandbox logs (runtime / build) |
| `/api/kill-sandbox` | POST | Terminate current sandbox early |
| `/api/get-sandbox-files` | GET | Return cached manifest & file snapshot |
| `/api/generate-ai-code-stream` | POST | Stream AI generated code (new feature or edit) |
| `/api/analyze-edit-intent` | POST | Produce structured search plan (terms, edit classification) |
| `/api/apply-ai-code` | POST | Apply code (non-stream) |
| `/api/apply-ai-code-stream` | POST | Apply code with streamed progress SSE |
| `/api/detect-and-install-packages` | POST | Heuristic scan & install missing packages |
| `/api/install-packages` | POST | Explicit list install; streams progress |
| `/api/run-command` | POST | Execute whitelisted shell command in sandbox |
| `/api/restart-vite` | POST | Restart dev server (after heavy installs) |
| `/api/report-vite-error` | POST | Forward captured Vite build errors |
| `/api/check-vite-errors` | GET | Current aggregated Vite issues (cached) |
| `/api/clear-vite-errors-cache` | POST | Clear error cache |
| `/api/scrape-url-enhanced` | POST | Firecrawl site scrape (structured sections) |
| `/api/scrape-screenshot` | POST | Headless screenshot capture of target URL |
| `/api/create-zip` | GET | Generate downloadable ZIP of sandbox project |
| `/api/conversation-state` | POST | Manage or reset conversation memory |

> Implementation details may evolve; consult route source for parameters & shape.

---

## Environment Variables (`.env.local`)

Required:
```
E2B_API_KEY=...            # https://e2b.dev
FIRECRAWL_API_KEY=...      # https://firecrawl.dev
```

At least one AI provider (you can set multiple to multi-switch):
```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
GROQ_API_KEY=...           # For Kimi K2 or other fast models
```

Optional / Advanced:
```
ANTHROPIC_BASE_URL=...     # Custom proxy
NEXT_PUBLIC_APP_URL=http://localhost:3000  # Used for internal server-to-server calls in dev
```

No secrets should be exposed to the browser beyond the bare minimum; only `NEXT_PUBLIC_` prefixed values are client-visible.

---

## Configuration (`config/app.config.ts`)

| Section | Purpose | Notable Keys |
| ------- | ------- | ------------ |
| `e2b` | Sandbox lifecycle | `timeoutMinutes`, `viteStartupDelay` |
| `ai` | Model selection & limits | `availableModels`, `modelDisplayNames`, `maxTokens` |
| `codeApplication` | Refresh / recovery timing | `defaultRefreshDelay`, `packageInstallRefreshDelay` |
| `ui` | Feature flags + UX | `showModelSelector`, `toastDuration` |
| `packages` | Install behavior | `installTimeout`, `autoRestartVite` |
| `files` | File scanning policy | `excludePatterns`, `maxFileSize` |
| `api` | Retry & timeout | `maxRetries`, `requestTimeout` |

Access helpers:
```ts
import { appConfig, getConfig, getConfigValue } from '@/config/app.config';
```

---

## Frontend UX Highlights (`app/page.tsx`)

| Feature | Description |
| ------- | ----------- |
| Chat-driven Workflow | Single unified chat for feature generation & edits |
| Automatic Sandbox Provisioning | First prompt triggers creation if absent |
| Streaming Code Assembly | Incremental file reconstruction with progress indicators |
| File Tree & Diff Feedback | Visual listing of created / updated files (stateful) |
| Package Install Feedback | Chat-log surfacing of command + output events |
| URL Scrape & Screenshot Overlay | Provide design or content inspiration (Firecrawl) |
| Model Selector | Switch models dynamically (if enabled in config) |
| Surgical Edit Mode | Narrow context changes; avoids collateral modifications |

---

## Quick Start

1. Clone & Install
```
git clone https://github.com/CalvinMagezi/chamuka-creatit.git
cd chamuka-creatit
pnpm install
```
2. Create `.env.local` (see above variables) and start:
```
pnpm dev
```
3. Open `http://localhost:3000` and type a request, e.g.:
```
Create a landing page with a responsive hero section and a features grid.
```
4. After generation, request an edit:
```
Update the hero CTA button color to indigo and add subtle entrance animation.
```

---

## Programmatic Example (cURL)

Generate code (stream):
```
curl -N -X POST http://localhost:3000/api/generate-ai-code-stream \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"Add a pricing section with three plans","model":"openai/gpt-5","isEdit":false,"context":{}}'
```

Apply code (non-stream minimal example – body shape depends on prior parse):
```
curl -X POST http://localhost:3000/api/apply-ai-code \
	-H 'Content-Type: application/json' \
	-d '{"files":[{"path":"app/components/Pricing.tsx","content":"// ..."}]}'
```

---

## Editing Flow Details

1. Intent classification & search term extraction.
2. Ranked file / region selection (line localization where possible).
3. Enhanced surgical system prompt built with: search results + reasoning + guardrails.
4. AI constrained to minimal diff mindset; large rewrites discouraged.
5. Safety fallback: if search fails → broader context with keyword heuristics.

This minimizes hallucinated file creation and preserves unrelated code.

---

## Package Resolution Strategy

1. Post-generation scan for `import` statements referencing missing modules.
2. Batched installation through `/api/install-packages` (progress streamed).
3. Optional Vite restart after installs (configurable).
4. Extended iframe refresh delay when packages were added.

---

## File Manifest & Caching

In-sandbox file system is cached (`global.sandboxState.fileCache`) with:
```
{ files: { [path]: { content, lastModified } }, manifest, lastSync, sandboxId }
```
Used for:
* Search planning
* Context packaging
* Edit consolidation & diff reasoning

---

## Conversation Memory

Maintains limited rolling window of recent user + AI messages and prior edits (trimmed to prevent token inflation). Tracks user preference signals (e.g., repeated styling adjustments) to bias future suggestions.

---

## Troubleshooting

| Symptom | Possible Cause | Action |
| ------- | -------------- | ------ |
| Sandbox never activates | Missing `E2B_API_KEY` or network issue | Recheck env; restart dev server |
| Streaming stalls mid-way | Provider rate limit or network disconnect | Retry; switch model; check console logs |
| Packages not installing | Timeout or incompatible peer deps | Adjust `packages.installTimeout`; retry manually via chat `npm install <pkg>` |
| Edits overwrite unrelated code | Search plan failed; fallback broad edit | Improve prompt specificity; verify target file name references |
| Image not optimized warnings | Raw `<img>` elements | Migrate to `next/image` (future enhancement) |

Enable debug logging in `app.config.ts` to surface additional diagnostics.

---

## Security & Limitations

* Ephemeral sandbox; do **not** store secrets inside generated code.
* No guarantee against prompt injection from scraped external pages—sanitize untrusted content.
* Model outputs are non-deterministic; review before deploying.
* Current truncation recovery is disabled (config flag) due to false positives; re-enable cautiously.

---

## Roadmap (Indicative)

| Item | Status |
| ---- | ------ |
| Structured diff visualization | Planned |
| Integrated unit test generation | Planned |
| Refined semantic search (AST + embeddings) | Planned |
| Image-to-code layout matching | Exploration |
| Multi-file transactional apply (rollback on fail) | Planned |

---

## Contributing

1. Fork & clone.
2. Create feature branch.
3. Ensure type check & build pass:
```
pnpm typecheck
pnpm build
```
4. Open PR with concise description & before/after notes.

---

## License

MIT

---

## Disclaimer

Generated code should be reviewed. You are responsible for validating security, licensing of dependencies, and production readiness before deployment.
