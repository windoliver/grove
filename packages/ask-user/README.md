# `@grove/ask-user`

`@grove/ask-user` is a standalone MCP package that exposes an `ask_user` tool
and routes agent questions to a configurable answering strategy.

It is designed for two modes:

- Standalone MCP server via the `grove-ask-user` binary
- Programmatic embedding into another MCP server via `registerAskUserTools`

In the Grove repo, this package is used by both:

- `grove ask` on the CLI
- `grove-mcp`, which registers `ask_user` alongside the Grove-native tools

## What It Does

The package solves a narrow but important problem: when an agent needs a
clarification, approval, or tie-breaker, it needs a predictable place to ask.

`@grove/ask-user` provides that place with interchangeable strategies:

| Strategy | Use it when |
| --- | --- |
| `interactive` | A human is present on a TTY and you want to answer manually |
| `rules` | You want deterministic, safe default behavior with no external dependencies |
| `llm` | You want a cheap model to answer in headless mode |
| `agent` | You want to delegate the answer to another local agent process |

## Repo-Local Usage

Build or test just this package:

```bash
bun run --cwd packages/ask-user build
bun run --cwd packages/ask-user typecheck
bun run --cwd packages/ask-user test
```

Run the standalone MCP server from source:

```bash
bun run --cwd packages/ask-user src/server.ts
```

After build, the compiled entrypoint is:

```bash
packages/ask-user/dist/server.js
```

If the package is installed with its bin links, that entrypoint is exposed as
`grove-ask-user`.

## Configuration

Configuration is loaded from the JSON file pointed at by
`GROVE_ASK_USER_CONFIG`. If the variable is unset, the package falls back to an
internal default config.

Example config:

```json
{
  "strategy": "llm",
  "fallback": "rules",
  "llm": {
    "model": "claude-haiku-4-5-20251001",
    "systemPrompt": "You are answering questions on behalf of a developer. Be decisive. Pick the simpler option. One sentence max.",
    "timeoutMs": 30000,
    "maxTokens": 256
  },
  "rules": {
    "prefer": "simpler",
    "defaultResponse": "Proceed with the simpler, more conventional approach."
  },
  "agent": {
    "command": "acpx",
    "args": ["--approve-all", "claude"],
    "timeoutMs": 60000
  }
}
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `GROVE_ASK_USER_CONFIG` | Path to the JSON config file |
| `ANTHROPIC_API_KEY` | Required when the `llm` strategy creates a real Anthropic client |

Behavioral notes:

- Primary strategy failures fall through to the configured fallback strategy
- If both strategies fail, the package returns a conservative safe default
- The `rules` strategy never tries to infer yes/no intent from free-form
  prompts without options
- The `agent` strategy checks that its command exists unless it is being built
  lazily as a fallback

## Standalone MCP Server

The standalone server registers exactly one MCP tool: `ask_user`.

Tool contract:

- Input:
  - `question: string`
  - `options?: string[]`
  - `context?: string`
- Output:
  - one text response containing the selected or generated answer

Start it with a config file:

```bash
export GROVE_ASK_USER_CONFIG=$PWD/ask-user.json
bun run --cwd packages/ask-user src/server.ts
```

## Programmatic Embedding

Embed `ask_user` into any MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAskUserTools } from "@grove/ask-user";

const server = new McpServer({
  name: "my-server",
  version: "0.1.0",
});

await registerAskUserTools(server);
```

You can also inject a resolved config explicitly:

```ts
import type { AskUserConfig } from "@grove/ask-user";
import { registerAskUserTools } from "@grove/ask-user";

const config: AskUserConfig = {
  strategy: "rules",
  fallback: "interactive",
  llm: {
    model: "claude-haiku-4-5-20251001",
    systemPrompt: "Be decisive and brief.",
    timeoutMs: 30_000,
    maxTokens: 256,
  },
  rules: {
    prefer: "simpler",
    defaultResponse: "Proceed with the simpler, more conventional approach.",
  },
  agent: {
    command: "acpx",
    args: ["--approve-all", "claude"],
    timeoutMs: 60_000,
  },
};

await registerAskUserTools(server, config);
```

## Public API

The package exports the following public surface from `src/index.ts`.

| Export | Purpose |
| --- | --- |
| `loadConfig` | Load config from `GROVE_ASK_USER_CONFIG` or defaults |
| `parseConfig` | Validate raw config input |
| `registerAskUserTools` | Register the `ask_user` MCP tool on an existing server |
| `buildStrategyFromConfig` | Build the primary-plus-fallback strategy chain |
| `createStrategyChain` | Compose a primary strategy with an optional fallback |
| `resolveStrategy` | Resolve a strategy name to its concrete implementation |
| `createRulesStrategy` | Deterministic option selection and safe defaults |
| `createInteractiveStrategy` | Prompt a human on a TTY |
| `createLlmStrategy` | Answer via the Anthropic messages API |
| `createAgentStrategy` | Spawn another local agent process to answer |

Public types:

- `AskUserConfig`
- `StrategyNameType`
- `RulesConfigType`
- `LlmConfigType`
- `AgentConfigType`
- `AnswerStrategy`
- `AskUserInput`
- `AnthropicMessagesClient`
- `SpawnFn`
- `ReadlineFn`

## Strategy Details

### `rules`

Deterministic and dependency-free. It can:

- choose the shortest option when configured to prefer simpler answers
- choose existing-pattern options when configured to prefer conventions
- fall back to a conservative default response when no options are present

### `interactive`

Prompts on `stdin`/`stderr` using `readline`. It resolves numeric option
selection such as `2` back to the option text when choices were supplied.

### `llm`

Builds a concise prompt from the question, options, and context, then calls the
Anthropic messages API. The concrete client is lazily created unless you inject
one for tests.

### `agent`

Formats the question into a short decisive prompt and passes it to another
local command, defaulting to `acpx --approve-all claude`. This is useful when
you already have a preferred local agent runtime for approvals.

## Relationship To Grove

You can use this package independently, but inside the Grove repo it plugs into
two user-facing surfaces:

- `grove ask`, which defaults to `interactive` for CLI usage unless config/env
  overrides that behavior
- `grove-mcp`, which registers `ask_user` alongside Grove-native contribution,
  claim, frontier, workspace, outcome, and bounty tools
