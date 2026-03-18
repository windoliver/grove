/**
 * TUI Puppet Server — programmatic remote control for the Grove TUI.
 *
 * When GROVE_PUPPET_PORT is set, runs the TUI as a child process inside a
 * pseudo-terminal (via `script`), captures its output, and exposes HTTP
 * endpoints for key injection and screen capture.
 *
 * Endpoints:
 *   POST /key        — inject a key event: { name, ctrl?, shift?, meta? }
 *   GET  /screen     — current terminal content as plain text
 *   GET  /screen/raw — last raw ANSI output chunk
 *   GET  /ready      — returns 200 when TUI is rendering
 *   POST /type       — type a string: { text }
 *
 * Usage:
 *   GROVE_PUPPET_PORT=5100 grove up
 *   curl http://localhost:5100/screen
 *   curl -X POST http://localhost:5100/key -d '{"name":"3"}'
 */

import { spawn } from "node:child_process";

/** Special key name → raw escape sequence mapping. */
const KEY_MAP: Record<string, string> = {
  return: "\r",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
  space: " ",
};

/** Convert a key request to raw bytes for the pty. */
function keyToRaw(name: string, ctrl?: boolean): string {
  if (ctrl && name.length === 1) {
    // Ctrl+letter = char code 1-26
    const code = name.toLowerCase().charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) return String.fromCharCode(code);
  }
  return KEY_MAP[name.toLowerCase()] ?? name;
}

/**
 * Start the puppet server. Spawns the TUI inside a pty via `script`,
 * captures output, and serves an HTTP control API.
 *
 * @param tuiArgs - Command-line arguments to pass to the TUI process
 * @param port - HTTP port for the puppet API
 * @returns Promise that resolves when the TUI exits
 */
export async function startPuppetAndServe(tuiArgs: string[], port: number): Promise<void> {
  // Raw ANSI output buffer — ring buffer of recent chunks
  const outputChunks: string[] = [];
  const MAX_CHUNKS = 200;
  let ready = false;

  // Virtual screen buffer: parse ANSI into a 2D text grid
  const ROWS = Number(process.env.LINES) || 24;
  const COLS = Number(process.env.COLUMNS) || 80;
  const screen: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
  let curRow = 0;
  let curCol = 0;

  function processAnsi(data: string): void {
    // Simple ANSI parser: handles cursor positioning and plain text
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b" && data[i + 1] === "[") {
        // CSI sequence
        let j = i + 2;
        let params = "";
        while (j < data.length) {
          const ch = data[j] as string;
          if ((ch >= "0" && ch <= "9") || ch === ";" || ch === "?") {
            params += ch;
            j++;
          } else break;
        }
        const cmd = j < data.length ? data[j] : "";
        j++;
        if (cmd === "H" || cmd === "f") {
          // Cursor position: ESC[row;colH
          const parts = params.split(";");
          curRow = Math.max(0, Math.min(ROWS - 1, parseInt(parts[0] || "1", 10) - 1));
          curCol = Math.max(0, Math.min(COLS - 1, parseInt(parts[1] || "1", 10) - 1));
        } else if (cmd === "J") {
          // Clear screen
          if (params === "2" || params === "") {
            for (let r = 0; r < ROWS; r++) screen[r]?.fill(" ");
          }
        } else if (cmd === "K") {
          // Clear line
          const clearRow = screen[curRow];
          if (curRow < ROWS && clearRow) {
            for (let c = curCol; c < COLS; c++) clearRow[c] = " ";
          }
        } else if (cmd === "A") {
          curRow = Math.max(0, curRow - parseInt(params || "1", 10));
        } else if (cmd === "B") {
          curRow = Math.min(ROWS - 1, curRow + parseInt(params || "1", 10));
        } else if (cmd === "C") {
          curCol = Math.min(COLS - 1, curCol + parseInt(params || "1", 10));
        } else if (cmd === "D") {
          curCol = Math.max(0, curCol - parseInt(params || "1", 10));
        }
        // Skip color/style codes (m) and other CSI commands
        i = j;
      } else if (data[i] === "\x1b") {
        // Other escape sequences — skip to next non-escape
        i += 2;
      } else if (data[i] === "\r") {
        curCol = 0;
        i++;
      } else if (data[i] === "\n") {
        curRow = Math.min(ROWS - 1, curRow + 1);
        curCol = 0;
        i++;
      } else {
        // Regular character
        if (curRow < ROWS && curCol < COLS) {
          const row = screen[curRow];
          const ch = data[i];
          if (row && ch !== undefined) row[curCol] = ch;
          curCol++;
          if (curCol >= COLS) {
            curCol = 0;
            curRow = Math.min(ROWS - 1, curRow + 1);
          }
        }
        i++;
      }
    }
  }

  function getScreen(): string {
    return screen.map((row) => row.join("").trimEnd()).join("\n");
  }

  // Spawn TUI inside a pty. Use Python's pty module which works without
  // a real terminal on stdin (unlike `script` on macOS).
  const pyPtyScript = `
import pty, os, sys, json
cmd = json.loads(sys.argv[1])
os.environ.pop('GROVE_PUPPET_PORT', None)
os.environ['TERM'] = os.environ.get('TERM', 'xterm-256color')
os.environ['COLUMNS'] = '${COLS}'
os.environ['LINES'] = '${ROWS}'
pty.spawn(cmd)
`;
  const tuiProc = spawn("python3", ["-c", pyPtyScript, JSON.stringify(["bun", ...tuiArgs])], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLUMNS: String(COLS),
      LINES: String(ROWS),
    },
  });

  tuiProc.stdout?.on("data", (chunk: Buffer) => {
    const str = chunk.toString();
    outputChunks.push(str);
    if (outputChunks.length > MAX_CHUNKS) {
      outputChunks.splice(0, outputChunks.length - MAX_CHUNKS);
    }
    processAnsi(str);
    if (!ready && str.length > 100) ready = true;
  });

  tuiProc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // HTTP puppet server
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request: Request): Response | Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/ready") {
        return Response.json({ ready, pid: tuiProc.pid, rows: ROWS, cols: COLS });
      }

      if (request.method === "GET" && url.pathname === "/screen") {
        return new Response(getScreen(), { headers: { "content-type": "text/plain" } });
      }

      if (request.method === "GET" && url.pathname === "/screen/raw") {
        return new Response(outputChunks.slice(-20).join(""), {
          headers: { "content-type": "text/plain" },
        });
      }

      if (request.method === "POST" && url.pathname === "/key") {
        return (async () => {
          const body = (await request.json()) as { name: string; ctrl?: boolean };
          if (!body.name) return Response.json({ error: "missing 'name'" }, { status: 400 });
          const raw = keyToRaw(body.name, body.ctrl);
          tuiProc.stdin?.write(raw);
          await new Promise((r) => setTimeout(r, 100));
          return Response.json({ ok: true, key: body.name });
        })();
      }

      if (request.method === "POST" && url.pathname === "/type") {
        return (async () => {
          const body = (await request.json()) as { text: string };
          if (!body.text) return Response.json({ error: "missing 'text'" }, { status: 400 });
          for (const ch of body.text) {
            tuiProc.stdin?.write(ch);
            await new Promise((r) => setTimeout(r, 30));
          }
          return Response.json({ ok: true, typed: body.text });
        })();
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.error(`[puppet] server on http://127.0.0.1:${server.port} (TUI pid=${tuiProc.pid})`);

  // Wait for TUI to exit
  return new Promise<void>((resolve) => {
    tuiProc.on("exit", (code) => {
      console.error(`[puppet] TUI exited with code ${code}`);
      server.stop();
      resolve();
    });
  });
}
