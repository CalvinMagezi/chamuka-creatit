# Chamuka Creatit - AI-Assisted React Code Generation

## Project Overview

Chamuka Creatit is an AI-assisted full-stack React (Next.js) code generation and iterative editing environment. It provisions an ephemeral, network-isolated sandbox (E2B), streams multi-provider AI generated code (OpenAI, Anthropic, Groq / Moonshot Kimi, Google Gemini), applies surgical edits to existing files using semantic + heuristic search, auto-installs missing npm packages, and lets users interactively refine their app via chat.

### Key Capabilities

1.  **Sandbox Orchestration:** Ephemeral E2B sandbox creation with a 15-minute default lifetime, running a Vite dev server.
2.  **Code Generation:** Streaming multi-model code output via Server-Sent Events (SSE) from `/api/generate-ai-code-stream`.
3.  **Surgical Editing:** Intelligent target file and line localization using a hybrid approach of AI intent analysis (`/api/analyze-edit-intent`), deterministic search, and fallback keyword heuristics.
4.  **File Context Selection:** Minimal relevant context window using `selectFilesForEdit` and search plan trimming to reduce token waste.
5.  **Package Management:** Auto-detection and installation of missing dependencies via `/api/detect-and-install-packages` and `/api/install-packages`.
6.  **Web Intelligence:** Enhanced URL scrape and screenshot capture via Firecrawl using `/api/scrape-url-enhanced` and `/api/scrape-screenshot`.
7.  **Apply Code:** Multi-step streamed application of code changes via `/api/apply-ai-code-stream`.
8.  **Conversation Memory:** Lightweight rolling context that trims message and edit history while preserving patterns and preferences.
9.  **Status & Health:** Sandbox lifecycle and log monitoring via `/api/sandbox-status`, `/api/sandbox-logs`, and `/api/kill-sandbox`.
10. **Export:** One-click project download as a ZIP file via `/api/create-zip`.

### Architecture

1.  The user enters a request (new feature or edit) in the web UI.
2.  The frontend calls `/api/generate-ai-code-stream`.
    *   (Edit mode) Calls `/api/analyze-edit-intent` to create a structured search plan.
    *   Executes code search against cached sandbox files to select the target file and line.
    *   Constructs a precision system prompt ("surgical edit" style) or falls back to broader context.
3.  An AI model streams structured plaintext containing code blocks. The client incrementally reconstructs file outputs.
4.  The user confirms the application; the client calls `/api/apply-ai-code-stream` to write changes within the sandbox.
5.  Package detection triggers installation if unresolved imports appear.
6.  The sandbox Vite server rebuilds; the iframe preview auto-refreshes after a configurable delay.
7.  Conversation and edit summaries update the internal memory state for future intent refinement.

### Technologies Used

*   **Framework:** Next.js 15 (App Router)
*   **Language:** TypeScript
*   **Styling:** Tailwind CSS
*   **Sandboxing:** E2B (Code Interpreter)
*   **AI Models:** OpenAI, Anthropic, Groq (Moonshot Kimi), Google Gemini (via `ai-sdk`)
*   **Streaming:** Server-Sent Events (SSE)
*   **UI Components:** Radix UI, Framer Motion, Lucide React
*   **Code Display:** React Syntax Highlighter

## Development Conventions

### Code Style

*   The project uses TypeScript for type safety.
*   Tailwind CSS is used for all styling; custom CSS files are generally discouraged.
*   Functional components with React Hooks are the preferred component pattern.
*   Code is organized into directories like `app/`, `components/`, `lib/`, `types/`, and `config/`.

### AI Interaction & Code Generation

*   **Surgical Edits:** The system aims to make minimal, precise changes to existing code during edits. The AI is instructed to preserve nearly all existing code and only modify the requested part.
*   **File Output Format:** Generated code is expected to be wrapped in `<file path="...">...</file>` tags.
*   **Package Detection:** The system parses generated code for `import` statements to detect required packages, which are then auto-installed.
*   **Context Management:** The system maintains conversation history and previous edits to provide context for subsequent requests, enabling incremental development.
*   **Edit Intent Analysis:** For edits, an agentic workflow analyzes the user's intent to determine the files and lines to modify, using search plans and heuristics.

### File Structure

*   `app/`: Next.js App Router pages and API routes.
*   `components/`: Reusable React components.
*   `config/`: Application configuration (`app.config.ts`).
*   `lib/`: Utility functions and core logic (e.g., E2B interaction, context selection, file search).
*   `types/`: TypeScript type definitions.
*   `public/`: Static assets.

### API Routes

*   `/api/create-ai-sandbox`: Provisions a new E2B sandbox.
*   `/api/generate-ai-code-stream`: Streams AI-generated code based on a prompt and context.
*   `/api/analyze-edit-intent`: Analyzes an edit request to create a search plan.
*   `/api/apply-ai-code-stream`: Applies generated code to the sandbox with streamed progress.
*   `/api/get-sandbox-files`: Returns the current file structure and content from the sandbox.
*   `/api/install-packages`: Installs specified npm packages in the sandbox.
*   `/api/scrape-url-enhanced`: Scrapes structured content from a URL using Firecrawl.
*   `/api/create-zip`: Creates a downloadable ZIP of the current sandbox project.
*   Various other routes for sandbox management, logs, and conversation state.

## Building and Running

### Prerequisites

*   Node.js (version specified in `package.json`)
*   pnpm (recommended package manager)
*   API keys for E2B, Firecrawl, and at least one AI provider (OpenAI, Anthropic, Groq, Google) set in `.env.local`.

### Installation

1.  Clone the repository.
2.  Run `pnpm install` to install dependencies.

### Configuration

1.  Create a `.env.local` file based on `.env.example`.
2.  Fill in the required API keys:
    *   `E2B_API_KEY`
    *   `FIRECRAWL_API_KEY`
    *   At least one of:
        *   `OPENAI_API_KEY`
        *   `ANTHROPIC_API_KEY`
        *   `GEMINI_API_KEY`
        *   `GROQ_API_KEY`

### Development

1.  Run `pnpm dev` to start the development server.
2.  Access the application at `http://localhost:3000`.
3.  The first prompt will automatically create an E2B sandbox.

### Testing

*   The project includes integration tests for E2B, API endpoints, and code execution.
*   Run all tests with `pnpm test:all`.
*   Run integration tests with `pnpm test:integration`.
*   Run API endpoint tests with `pnpm test:api`.
*   Run code execution tests with `pnpm test:code`.

### Linting and Type Checking

*   Run the linter with `pnpm lint`.
*   Run type checking with `pnpm typecheck`.

### Production Build

1.  Run `pnpm build` to create an optimized production build.
2.  Run `pnpm start` to start the production server.

## Troubleshooting

*   **Sandbox Issues:** Ensure the `E2B_API_KEY` is correct and network connectivity is available.
*   **Streaming Errors:** Check for rate limits from the AI provider or network disconnections.
*   **Package Installation Failures:** Adjust `packages.installTimeout` in `app.config.ts` or retry manually.
*   **Incorrect Edits:** Improve prompt specificity or verify target file name references if the search plan fails.
*   **Performance:** Enable debug logging in `app.config.ts` for diagnostics.