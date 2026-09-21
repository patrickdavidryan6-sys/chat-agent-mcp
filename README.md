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

use anyhow::{Context, Result, bail};
use genai::Client;
use genai::chat::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, Tool as GenaiTool, ToolResponse,
};
use jsonschema::Validator;
use rmcp::model::{CallToolRequestParams, CallToolResult, Tool as McpTool};
use rmcp::service::{RoleClient, RunningService, ServiceExt};
use rmcp::transport::TokioChildProcess;
use serde_json::Value;
use std::collections::HashMap;
use tokio::io::{self, AsyncBufReadExt, BufReader};
use tokio::process::Command;

const MODEL_ANTHROPIC: &str = "claude-sonnet-5";

struct MCPClient {
    anthropic: Client,
    session: Option<RunningService<RoleClient, ()>>,
    tools: Vec<GenaiTool>,
    /// Compiled `outputSchema` per tool name. rmcp does not validate results,
    /// so this client does it with the `jsonschema` crate.
    output_schemas: HashMap<String, Validator>,
}

impl MCPClient {
    fn new() -> Result<Self> {
        Ok(MCPClient {
            anthropic: Client::default(),
            session: None,
            tools: Vec::new(),
            output_schemas: HashMap::new(),
        })
    }

    /// Check a result against its tool's declared `outputSchema`. Error results
    /// are exempt: they carry a message, not data.
    fn validate_tool_output(&self, name: &str, result: &CallToolResult) -> Result<()> {
        let Some(validator) = self.output_schemas.get(name) else {
            return Ok(());
        };
        if result.is_error.unwrap_or(false) {
            return Ok(());
        }
        let Some(structured) = &result.structured_content else {
            bail!("Tool {name} declares an output schema but returned no structured content");
        };
        if let Err(error) = validator.validate(structured) {
            bail!("Structured content from tool {name} does not match its output schema: {error}");
        }
        Ok(())
    }

    async fn connect_to_server(&mut self, server_args: &[String]) -> Result<()> {
        if self.session.is_some() {
            bail!("Client is already connected to a server");
        }

        let mut command = Command::new(&server_args[0]);
        command.args(&server_args[1..]);

        let process = TokioChildProcess::new(command)
            .with_context(|| format!("Failed to spawn server process for {:?}", server_args))?;

        let session = ().serve(process).await?;

        let rmcp_tools = session
            .list_all_tools()
            .await
            .context("Unable to list tools from server")?;

        let tool_names: Vec<String> = rmcp_tools
            .iter()
            .map(|tool| tool.name.to_string())
            .collect();

        println!("Connected to server with tools: {tool_names:?}");

        // An outputSchema root may be any JSON Schema, not just an object.
        for tool in &rmcp_tools {
            let Some(schema) = &tool.output_schema else {
                continue;
            };
            let schema = Value::Object(schema.as_ref().clone());
            let validator = Validator::new(&schema).with_context(|| {
                format!("Failed to compile output schema of tool {}", tool.name)
            })?;
            self.output_schemas.insert(tool.name.to_string(), validator);
        }

        self.tools = convert_tools(&rmcp_tools);
        self.session = Some(session);
        Ok(())
    }

    async fn process_query(&mut self, query: &str) -> Result<String> {
        let session = self
            .session
            .as_ref()
            .context("Client is not connected to any server")?;

        let mut messages = vec![ChatMessage::user(query)];
        let mut final_text = Vec::new();

        // Initial Claude API call with tools
        let mut chat_req = ChatRequest::new(messages.clone()).with_tools(self.tools.clone());
        let mut chat_rsp = self.request_model(&chat_req).await?;

        // Process response content - collect text and handle tool calls
        for text in chat_rsp.texts() {
            final_text.push(text.to_string());
        }

        let tool_calls = chat_rsp.tool_calls();
        if !tool_calls.is_empty() {
            // Append assistant's response to message history
            messages.push(ChatMessage::assistant(chat_rsp.content.clone()));

            // Execute each tool call and collect responses
            let mut tool_results = Vec::new();
            for tool_call in tool_calls {
                // Add information about the tool call to final text
                let tool_args_str = serde_json::to_string(&tool_call.fn_arguments)
                    .unwrap_or_else(|_| "{}".to_string());

                final_text.push(format!(
                    "[Calling tool {} with args {}]",
                    tool_call.fn_name, tool_args_str
                ));

                // Query the MCP server
                let mut params = CallToolRequestParams::new(tool_call.fn_name.clone());
                if let Some(arguments) = tool_call.fn_arguments.as_object().cloned() {
                    params = params.with_arguments(arguments);
                }
                let tool_result = session
                    .call_tool(params)
                    .await
                    .with_context(|| format!("Tool call {} failed", tool_call.fn_name))?;

                self.validate_tool_output(&tool_call.fn_name, &tool_result)?;

                // structured_content is data the application can use directly.
                if let Some(Value::Array(items)) = &tool_result.structured_content {
                    final_text.push(format!(
                        "[{} returned {} items]",
                        tool_call.fn_name,
                        items.len()
                    ));
                }

                // content is a list of block types; forward only the text ones.
                let payload = tool_result
                    .content
                    .iter()
                    .filter_map(|block| block.as_text().map(|text| text.text.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");

                tool_results.push(ContentPart::ToolResponse(ToolResponse::new(
                    tool_call.call_id.clone(),
                    payload,
                )));
            }

            // Append tool responses to message history
            messages.push(ChatMessage::user(tool_results));

            // Build the next request and query model
            chat_req = ChatRequest::new(messages.clone());
            chat_rsp = self.request_model(&chat_req).await?;

            // Collect text from response
            for text in chat_rsp.texts() {
                final_text.push(text.to_string());
            }
        }

        Ok(final_text.join("\n"))
    }

    async fn request_model(&self, chat_req: &ChatRequest) -> Result<ChatResponse> {
        let response = self
            .anthropic
            .exec_chat(MODEL_ANTHROPIC, chat_req.clone(), None)
            .await
            .context("Anthropic chat request failed")?;

        Ok(response)
    }

    async fn chat_loop(&mut self) -> Result<()> {
        println!("\nMCP Client Started!");
        println!("Type your queries or 'quit' to exit.");

        let mut stdin = BufReader::new(io::stdin());
        let mut input = String::new();

        loop {
            print!("\nQuery: ");
            std::io::Write::flush(&mut std::io::stdout())?;

            input.clear();
            if stdin.read_line(&mut input).await? == 0 {
                break; // EOF
            }

            let query = input.trim();
            if query.eq_ignore_ascii_case("quit") {
                break;
            }
            if query.is_empty() {
                continue;
            }

            match self.process_query(query).await {
                Ok(response) => println!("\n{}", response),
                Err(err) => println!("\nError: {}", err),
            }
        }

        Ok(())
    }

    async fn cleanup(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            let _ = session.cancel().await;
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // .env is optional; the key may come from the environment instead.
    let _ = dotenvy::dotenv();

    let mut args = std::env::args();
    let _ = args.next();
    let server_args: Vec<String> = args.collect();

    if server_args.is_empty() {
        eprintln!("Usage: cargo run -- <server_script_or_binary> [args...]");
        std::process::exit(1);
    }

    let mut client = MCPClient::new()?;

    let result = async {
        client.connect_to_server(&server_args).await?;

        // Connecting and listing tools needs no credentials; querying them
        // does. Matching the Python and TypeScript clients, report and exit
        // rather than failing, so the connection itself can be exercised
        // without a key.
        // Empty counts as unset, as it does in the other clients: `KEY= cmd`
        // is how the smoke test forces this path.
        if std::env::var("ANTHROPIC_API_KEY").map_or(true, |key| key.is_empty()) {
            println!("\nNo ANTHROPIC_API_KEY found. To query these tools with Claude, set your API key:");
            println!("  export ANTHROPIC_API_KEY=your-api-key-here");
            return Ok(());
        }

        client.chat_loop().await
    }
    .await;

    let cleanup_result = client.cleanup().await;

    result?;
    cleanup_result?;

    Ok(())
}

fn convert_tools(tools: &[McpTool]) -> Vec<GenaiTool> {
    tools
        .iter()
        .map(|tool| GenaiTool {
            name: tool.name.to_string(),
            description: tool.description.as_deref().map(str::to_string),
            schema: Some(Value::Object(tool.input_schema.as_ref().clone())),
            config: None,
        })
        .collect()

}
# MCP Quickstart Resources

Example servers and clients for the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), in five languages. These are companion examples for two official tutorials:

- [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server) – a simple MCP weather server exposing two tools backed by the US National Weather Service API
- [Build an MCP client](https://modelcontextprotocol.io/docs/develop/build-client) – an LLM-powered chatbot MCP client that connects to any stdio server and lets Claude call its tools

## What's in this repository

Each example lives in its own directory with its own README covering prerequisites, setup, and how to run it:

| Language   | Weather server (MCP server)                                | Chatbot (MCP client)                               |
|------------|------------------------------------------------------------|----------------------------------------------------|
| Python     | [`weather-server-python`](./weather-server-python)         | [`mcp-client-python`](./mcp-client-python)         |
| TypeScript | [`weather-server-typescript`](./weather-server-typescript) | [`mcp-client-typescript`](./mcp-client-typescript) |
| Go         | [`weather-server-go`](./weather-server-go)                 | [`mcp-client-go`](./mcp-client-go)                 |
| Rust       | [`weather-server-rust`](./weather-server-rust)             | [`mcp-client-rust`](./mcp-client-rust)             |
| Ruby       | [`weather-server-ruby`](./weather-server-ruby)             | [`mcp-client-ruby`](./mcp-client-ruby)             |

All servers communicate over stdio and expose the same two tools: `get_forecast` and `get_alerts` (or `get-forecast` and `get-alerts` in TypeScript).

All clients launch a server, list its tools, and start an interactive chat loop in which Claude can call those tools. The Python, TypeScript, and Ruby clients take a path to a server script; the Go and Rust clients take the command to run, plus any arguments.

Note: These example clients need an `ANTHROPIC_API_KEY` to operate. Without a key, each client still connects and lists the server's tools before exiting, so you can verify the MCP wiring without credentials.

You can mix and match across languages: for example, the Python client can drive the TypeScript server. Each client's README lists which server launch forms it supports.

The [`tests`](./tests) directory contains the smoke tests that run in CI against these examples. See [`tests/README.md`](./tests/README.md) for how they work.

## Prerequisites

Each example only needs its own language toolchain. To work across the whole repository (for example, to run the smoke tests) you need:

- **Node.js** 24+ and **npm**
- **Python** 3.10+ and **uv**
- **Go** 1.25+
- **Rust** 1.88+ and **Cargo**
- **Ruby** 3.4+ and **Bundler**

## Running the tests

```bash
./tests/smoke-test.sh
```

The smoke tests verify that every server starts and answers MCP requests (including validating structured tool results against the schemas each tool advertises), and that every client can connect to a mock server and list tools. They run automatically on every pull request via GitHub Actions.

## Contributing

Contributions are welcome. To submit a change:

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep the examples minimal - they exist to teach the protocol, not to be production services.
3. If you change an example's behavior, setup, or dependencies, update that example's README to match.
4. Run `./tests/smoke-test.sh` and make sure it passes.
5. Open a pull request against `main` describing what changed and why.

A few conventions to follow, in line with the broader [Model Context Protocol contributing guidelines](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/CONTRIBUTING.md):

- **Keep documentation clear, concise, and technically accurate.** Include code examples where appropriate, and test the commands and links you add.
- **Disclose AI assistance.** If you used any kind of AI assistance to prepare your contribution, say so in the pull request or issue. See [AI_POLICY.md](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/AI_POLICY.md) for what the disclosure should cover.
- **Be respectful.** This project follows the MCP community's [Code of Conduct](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/CODE_OF_CONDUCT.md). Concerns can be reported to mcp-coc@anthropic.com.

## Security note

These examples are intentionally minimal. If you expose an MCP server over a network (HTTP/SSE/WebSocket), add authentication and basic hardening (CORS allowlist, request size limits, timeouts, rate limits, and log redaction). See [`SECURITY.md`](./SECURITY.md).

## License

The MCP project is transitioning from the MIT License to Apache-2.0. New code contributions are licensed under Apache-2.0, and documentation (excluding specifications) under CC-BY-4.0. Earlier contributions whose authors have not consented to relicensing remain under the MIT License. See [`LICENSE`](./LICENSE) for the full terms.