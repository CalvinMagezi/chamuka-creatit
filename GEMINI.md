# Project: Chamuka Creatit

## Project Overview

This is a Next.js project that provides an AI-assisted full-stack React code generation and iterative editing environment. It uses an ephemeral, network-isolated sandbox (E2B) to stream multi-provider AI-generated code, apply surgical edits to existing files, auto-install missing npm packages, and allows users to interactively refine their app via chat.

The application is architected with a Next.js frontend that communicates with a set of backend APIs (in the `app/api` directory) to manage the sandbox, generate code, and handle file operations. The frontend is built with React, TypeScript, and Tailwind CSS, and uses Radix UI for some components. The backend uses various AI SDKs (OpenAI, Anthropic, Google, Groq) and E2B for sandbox orchestration.

## Building and Running

### Prerequisites

- Node.js and pnpm
- E2B API Key
- Firecrawl API Key
- At least one AI provider API key (OpenAI, Anthropic, Google, or Groq)

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/CalvinMagezi/chamuka-creatit.git
    ```
2.  Navigate to the project directory:
    ```bash
    cd chamuka-creatit
    ```
3.  Install the dependencies:
    ```bash
    pnpm install
    ```

### Running the Application

1.  Create a `.env.local` file in the root of the project and add the required environment variables (see the `.env.example` file).
2.  Start the development server:
    ```bash
    pnpm dev
    ```
3.  Open your browser and navigate to `http://localhost:3000`.

### Building for Production

To create a production build, run the following command:

```bash
pnpm build
```

### Testing

The project includes integration, API, and code execution tests. To run all tests, use the following command:

```bash
pnpm test:all
```

You can also run individual test suites:

-   Integration tests: `pnpm test:integration`
-   API tests: `pnpm test:api`
-   Code execution tests: `pnpm test:code`

## Development Conventions

-   **Code Style:** The project uses ESLint to enforce a consistent code style. Before committing any changes, make sure to run `pnpm lint` to check for any linting errors.
-   **Type Checking:** The project is written in TypeScript. Run `pnpm typecheck` to check for any type errors.
-   **Commits:** Commit messages should be clear and concise, and should describe the changes made.
-   **Branching:** Create a new branch for each new feature or bug fix.
-   **Pull Requests:** When you are ready to merge your changes, open a pull request with a clear description of the changes you have made.
