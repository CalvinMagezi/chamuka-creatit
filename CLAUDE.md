# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Essential Commands
```bash
# Start development server with Turbopack
npm run dev

# Build for production
npm run build

# Start production server
npm run start

# Run linting
npm run lint

# Run all tests (integration, API, code execution)
npm run test:all

# Run specific test suites
npm run test:integration  # E2B integration tests
npm run test:api         # API endpoint tests
npm run test:code        # Code execution tests
```

### Environment Setup
Create `.env.local` with required API keys:
- `E2B_API_KEY` - Required for sandbox provisioning
- `FIRECRAWL_API_KEY` - Required for URL scraping
- At least one AI provider key:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`
  - `GROQ_API_KEY`

## High-Level Architecture

### Core Workflow
1. **User Request → Intent Analysis** - Determines if request is for new feature or edit via `/api/analyze-edit-intent`
2. **File/Context Selection** - Uses `lib/file-search-executor.ts` for surgical edit targeting
3. **AI Code Generation** - Streams structured code via `/api/generate-ai-code-stream`
4. **Code Application** - Applies changes to E2B sandbox via `/api/apply-ai-code-stream`
5. **Package Detection** - Auto-installs missing dependencies
6. **Preview Update** - Vite dev server rebuilds and iframe refreshes

### Key Components

#### Sandbox Management (E2B)
- **Ephemeral sandboxes** with 15-minute lifetime
- **Vite dev server** running on port 5173 inside sandbox
- **File caching** in `global.sandboxState.fileCache`
- **Lifecycle endpoints**: create, status, logs, kill

#### Surgical Edit System
- **Intent Analysis** (`lib/edit-intent-analyzer.ts`) - Classifies edit type and generates search plans
- **File Search** (`lib/file-search-executor.ts`) - Executes search plans for precise targeting
- **Context Selection** (`lib/context-selector.ts`) - Minimizes token usage with relevant context

#### Streaming Protocols
- **Code Generation**: SSE with status, debug, code chunks, completion
- **Code Application**: Step-by-step progress with package installs, commands, file updates

#### Configuration (`config/app.config.ts`)
- E2B settings: timeout, Vite delays
- AI models: defaults, available options, token limits
- UI: feature flags, animation timings
- Package management: install timeouts, auto-restart

### File Structure Patterns
- **API Routes**: `/app/api/*/route.ts` - Next.js App Router endpoints
- **Components**: `/components/` - React components with shadcn/ui
- **Types**: `/types/` - TypeScript type definitions
- **Library**: `/lib/` - Core business logic and utilities

### State Management
- **Sandbox state**: Global singleton for file cache and sandbox instance
- **Conversation memory**: Rolling window with edit history trimming
- **Vite error tracking**: Cached build/runtime errors

## Important Patterns

### When Making Changes
1. **Always check existing patterns** in neighboring files before implementing
2. **Use existing utilities** from `/lib/` directory
3. **Follow TypeScript strict mode** - all code must be properly typed
4. **Respect file exclusion patterns** in `config/app.config.ts`

### API Response Streaming
- Use Server-Sent Events (SSE) for real-time updates
- Follow established message types in `/types/sandbox.ts`
- Handle streaming errors gracefully with fallback responses

### Package Management
- Uses `--legacy-peer-deps` flag by default
- Auto-restart Vite after heavy installations
- 60-second timeout for package installations

### Error Handling
- Report Vite errors via `/api/report-vite-error`
- Check errors with `/api/check-vite-errors`
- Clear error cache when issues resolved

## Testing Approach
The project uses custom Node.js test scripts located in project root:
- Integration tests validate E2B sandbox functionality
- API tests verify endpoint behavior
- Code execution tests check runtime behavior

No traditional test framework is configured - tests are standalone Node.js scripts that should be run directly.