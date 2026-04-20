// Built-in tools — things Codex used to give for free (bash, file I/O,
// search) that Claude needs to be told about explicitly via tool_use.
//
// Each tool exposes:
//   - definition: Anthropic-shape { name, description, input_schema }
//   - execute(input): Promise<string>   — returns a string the model can read
//
// Tools run in-process (Node backend). They are NOT executed on Cloudflare;
// the proxy only carries the LLM traffic.

import { spawn, execFileSync } from 'child_process';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

const WORKING_DIR = process.cwd();
const MAX_OUTPUT_BYTES = 64 * 1024; // trim long outputs so we don't blow context

function truncate(s) {
  if (typeof s !== 'string') s = String(s);
  if (Buffer.byteLength(s, 'utf-8') <= MAX_OUTPUT_BYTES) return s;
  const head = s.slice(0, MAX_OUTPUT_BYTES / 2);
  const tail = s.slice(-MAX_OUTPUT_BYTES / 2);
  return `${head}\n\n... [truncated ${s.length - MAX_OUTPUT_BYTES} chars] ...\n\n${tail}`;
}

// ── bash ────────────────────────────────────────────────────────────────────

const bash = {
  definition: {
    name: 'bash',
    description:
      'Run a shell command. On Windows uses cmd.exe, on macOS/Linux uses sh. ' +
      'Use this for file operations, git, running scripts, etc. Output is combined stdout+stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Optional working directory (defaults to the app cwd).' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 120000).' },
      },
      required: ['command'],
    },
  },
  async execute({ command, cwd, timeout_ms }) {
    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'cmd.exe' : 'sh';
    const shellArgs = isWin ? ['/c', command] : ['-c', command];

    return new Promise((resolveP) => {
      let out = '';
      let err = '';
      const proc = spawn(shellCmd, shellArgs, {
        cwd: cwd ? resolve(cwd) : WORKING_DIR,
        windowsHide: true,
      });
      const to = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, Math.min(timeout_ms || 120000, 300000));

      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', (code) => {
        clearTimeout(to);
        const combined = out + (err ? `\n[stderr]\n${err}` : '');
        resolveP(truncate(`exit=${code}\n${combined}`));
      });
      proc.on('error', (e) => {
        clearTimeout(to);
        resolveP(`spawn error: ${e.message}`);
      });
    });
  },
};

// ── read_file ────────────────────────────────────────────────────────────────

const read_file = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a text file. Returns the file text. Use absolute paths when possible.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  async execute({ path }) {
    try {
      const content = await readFile(resolve(path), 'utf-8');
      return truncate(content);
    } catch (err) {
      return `read_file error: ${err.message}`;
    }
  },
};

// ── write_file ──────────────────────────────────────────────────────────────

const write_file = {
  definition: {
    name: 'write_file',
    description: 'Create or overwrite a text file. Creates parent directories if needed. Returns "ok" or an error.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  async execute({ path, content }) {
    try {
      const abs = resolve(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return `ok (${Buffer.byteLength(content, 'utf-8')} bytes written to ${abs})`;
    } catch (err) {
      return `write_file error: ${err.message}`;
    }
  },
};

// ── edit_file ───────────────────────────────────────────────────────────────

const edit_file = {
  definition: {
    name: 'edit_file',
    description:
      'Edit a file by replacing exactly one occurrence of old_string with new_string. ' +
      'The old_string must appear exactly once; otherwise the edit fails. ' +
      'Use this instead of write_file when making targeted changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  async execute({ path, old_string, new_string }) {
    try {
      const abs = resolve(path);
      const current = await readFile(abs, 'utf-8');
      const first = current.indexOf(old_string);
      if (first === -1) return 'edit_file error: old_string not found';
      if (current.indexOf(old_string, first + 1) !== -1) {
        return 'edit_file error: old_string appears multiple times; make it unique or use write_file';
      }
      const updated = current.slice(0, first) + new_string + current.slice(first + old_string.length);
      await writeFile(abs, updated, 'utf-8');
      return `ok (replaced 1 occurrence in ${abs})`;
    } catch (err) {
      return `edit_file error: ${err.message}`;
    }
  },
};

// ── glob ────────────────────────────────────────────────────────────────────

const glob = {
  definition: {
    name: 'glob',
    description:
      'List files matching a glob pattern (e.g. "src/**/*.ts"). ' +
      'Returns one path per line. Uses Node fs recursion — no external deps.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  async execute({ pattern, cwd }) {
    try {
      // Use PowerShell on Windows for built-in glob; shell on *nix.
      const isWin = process.platform === 'win32';
      const cmd = isWin
        ? `powershell -NoProfile -Command "Get-ChildItem -Path '${(cwd || WORKING_DIR).replace(/'/g, "''")}' -Recurse -Filter '${pattern.replace(/'/g, "''")}' | Select-Object -ExpandProperty FullName"`
        : `cd "${cwd || WORKING_DIR}" && ls -1 ${pattern}`;
      const out = execFileSync(isWin ? 'cmd.exe' : 'sh', [isWin ? '/c' : '-c', cmd], {
        encoding: 'utf-8', timeout: 30000, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES,
      });
      return truncate(out.trim());
    } catch (err) {
      return `glob error: ${err.message}`;
    }
  },
};

// ── grep ────────────────────────────────────────────────────────────────────

const grep = {
  definition: {
    name: 'grep',
    description:
      'Search file contents for a regex pattern using ripgrep if available, else findstr/grep. ' +
      'Returns matching lines with file:line: prefixes.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory or file to search (default: current directory).' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g. "*.js").' },
      },
      required: ['pattern'],
    },
  },
  async execute({ pattern, path, glob: g }) {
    const searchPath = path || WORKING_DIR;
    const globArg = g ? ` --glob "${g}"` : '';
    const cmd = `rg -n --no-heading --color never "${pattern.replace(/"/g, '\\"')}" "${searchPath}"${globArg}`;
    try {
      const out = execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh',
        [process.platform === 'win32' ? '/c' : '-c', cmd], {
        encoding: 'utf-8', timeout: 60000, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES,
      });
      return truncate(out.trim() || '(no matches)');
    } catch (err) {
      // rg returns exit 1 when there are no matches — not a real error
      if (err.status === 1) return '(no matches)';
      return `grep error: ${err.message}`;
    }
  },
};

// ── web_fetch ───────────────────────────────────────────────────────────────

const web_fetch = {
  definition: {
    name: 'web_fetch',
    description: 'Fetch a URL and return the raw response body as text. Use for API calls or page scraping. Follows redirects.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object' },
        body: { type: 'string' },
      },
      required: ['url'],
    },
  },
  async execute({ url, method, headers, body }) {
    try {
      const res = await fetch(url, {
        method: method || 'GET',
        headers: headers || {},
        body: body || undefined,
      });
      const text = await res.text();
      return truncate(`status=${res.status}\n${text}`);
    } catch (err) {
      return `web_fetch error: ${err.message}`;
    }
  },
};

// ── exports ─────────────────────────────────────────────────────────────────

export const BUILTIN_TOOLS = {
  bash,
  read_file,
  write_file,
  edit_file,
  glob,
  grep,
  web_fetch,
};

export function getBuiltinDefinitions() {
  return Object.values(BUILTIN_TOOLS).map(t => t.definition);
}

export async function callBuiltinTool(name, input) {
  const tool = BUILTIN_TOOLS[name];
  if (!tool) throw new Error(`Unknown builtin tool: ${name}`);
  return tool.execute(input || {});
}

export function isBuiltinTool(name) {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TOOLS, name);
}
