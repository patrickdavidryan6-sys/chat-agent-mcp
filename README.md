# chat-agent-mcp

TypeScript [MCP](https://modelcontextprotocol.io/) server starter built with the v2 SDK (`@modelcontextprotocol/server`). Exposes example tools for echoing, sandboxed file I/O, directory listing, and HTTP GET.

## Requirements

- Node.js **20+**

## Install & build

```bash
npm install
npm run build
```

## Run

| Mode | Command |
|------|---------|
| Dev (tsx) | `npm run dev` |
| Production | `npm start` (after `npm run build`) |
| Inspector | `npm run inspector` or see below |

Logs go to **stderr** only — stdout is reserved for JSON-RPC.

## Cursor MCP config

Add an entry to your Cursor `mcp.json` (absolute path to this project):

```json
{
  "mcpServers": {
    "chat-agent-mcp": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/chat-agent-mcp/src/index.ts"],
      "env": {
        "MCP_WORKSPACE": "/ABSOLUTE/PATH/TO/chat-agent-mcp/workspace"
      }
    }
  }
}
```

Built JS alternative:

```json
{
  "mcpServers": {
    "chat-agent-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chat-agent-mcp/dist/index.js"],
      "env": {
        "MCP_WORKSPACE": "/ABSOLUTE/PATH/TO/chat-agent-mcp/workspace"
      }
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/chat-agent-mcp` with the real path on your machine.

## Tools

| Tool | Args | Description |
|------|------|-------------|
| `echo` | `message: string` | Echo text back |
| `read_text_file` | `path: string` | Read UTF-8 file under sandbox |
| `write_text_file` | `path: string`, `content: string` | Write UTF-8 file under sandbox |
| `list_directory` | `path?: string` | List sandbox directory (default `.`) |
| `http_get` | `url: string` | HTTP GET; returns status + body (max 8KB) |

### Sandbox

File tools resolve paths under `MCP_WORKSPACE` (if set) or `./workspace` relative to the project root. Path traversal outside the sandbox is rejected. The sandbox directory is created on startup if missing.

## Inspector

Exercise tools without a host:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## Adding a tool

In `src/index.ts`, inside `createServer()`:

```ts
server.registerTool(
  'my_tool',
  {
    description: 'What this tool does',
    inputSchema: z.object({
      name: z.string().describe('Example argument'),
    }),
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}` }],
  })
);
```

Rebuild (`npm run build`) or use `npm run dev` / tsx for iteration.

## License

MIT
