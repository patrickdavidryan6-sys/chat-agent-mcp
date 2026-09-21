#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Sandbox root: MCP_WORKSPACE env, or ./workspace relative to project root. */
function getSandboxRoot(): string {
  const fromEnv = process.env.MCP_WORKSPACE;
  if (fromEnv && fromEnv.trim()) {
    return path.resolve(fromEnv);
  }
  return path.resolve(PROJECT_ROOT, 'workspace');
}

/**
 * Resolve a user-supplied path under the sandbox root.
 * Rejects path traversal that would escape the sandbox.
 */
function resolveSandboxPath(userPath: string): string {
  const root = getSandboxRoot();
  const resolved = path.resolve(root, userPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes sandbox: ${userPath}`);
  }
  return resolved;
}

async function ensureSandboxExists(): Promise<void> {
  const root = getSandboxRoot();
  await fs.mkdir(root, { recursive: true });
}

const MAX_HTTP_BODY = 8 * 1024; // 8KB

function createServer(): McpServer {
  const server = new McpServer({
    name: 'chat-agent-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'echo',
    {
      description: 'Echo back a message (useful for smoke-testing the MCP connection)',
      inputSchema: z.object({
        message: z.string().describe('Text to echo back'),
      }),
    },
    async ({ message }) => ({
      content: [{ type: 'text' as const, text: message }],
    })
  );

  server.registerTool(
    'read_text_file',
    {
      description:
        'Read a UTF-8 text file under the MCP workspace sandbox (MCP_WORKSPACE or ./workspace)',
      inputSchema: z.object({
        path: z.string().describe('Path relative to the sandbox root'),
      }),
    },
    async ({ path: userPath }) => {
      try {
        const resolved = resolveSandboxPath(userPath);
        const text = await fs.readFile(resolved, 'utf8');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error reading file: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'write_text_file',
    {
      description:
        'Write UTF-8 text to a file under the MCP workspace sandbox (creates parent dirs)',
      inputSchema: z.object({
        path: z.string().describe('Path relative to the sandbox root'),
        content: z.string().describe('File contents to write'),
      }),
    },
    async ({ path: userPath, content }) => {
      try {
        const resolved = resolveSandboxPath(userPath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf8');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Wrote ${content.length} bytes to ${userPath}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error writing file: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_directory',
    {
      description:
        'List files and directories under the MCP workspace sandbox (default: sandbox root)',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Path relative to the sandbox root (default: ".")'),
      }),
    },
    async ({ path: userPath }) => {
      try {
        const resolved = resolveSandboxPath(userPath ?? '.');
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`);
        const listing =
          lines.length === 0
            ? '(empty)'
            : lines.join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Directory: ${userPath ?? '.'}\n${listing}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error listing directory: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'http_get',
    {
      description:
        'Perform an HTTP GET request and return status plus a truncated body (max 8KB)',
      inputSchema: z.object({
        url: z.string().url().describe('Absolute URL to fetch'),
      }),
    },
    async ({ url }) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'chat-agent-mcp/1.0' },
          redirect: 'follow',
        });
        const raw = await res.text();
        const truncated = raw.length > MAX_HTTP_BODY;
        const body = truncated ? raw.slice(0, MAX_HTTP_BODY) : raw;
        const header = [
          `HTTP ${res.status} ${res.statusText}`,
          `URL: ${res.url}`,
          truncated
            ? `Body (truncated to ${MAX_HTTP_BODY} bytes of ${raw.length}):`
            : `Body (${raw.length} bytes):`,
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text: `${header}\n${body}` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `HTTP GET failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function main(): Promise<void> {
  await ensureSandboxExists();
  console.error(
    `chat-agent-mcp running on stdio (sandbox: ${getSandboxRoot()})`
  );
  void serveStdio(createServer);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
