import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

// ── State ─────────────────────────────────────────────────────────

let godotProcess: ChildProcess | null = null;
let bridgeSocket: net.Socket | null = null;
const stdoutBuffer: string[] = [];
const STDOUT_MAX = 200;
const BRIDGE_PORT = 9876;

// Mutex: serialize all bridge commands
let commandLock: Promise<void> = Promise.resolve();

function pushStdout(line: string) {
  stdoutBuffer.push(line);
  while (stdoutBuffer.length > STDOUT_MAX) stdoutBuffer.shift();
}

// ── Bridge Communication ──────────────────────────────────────────

function sendBridgeCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Serialize: wait for any prior command to finish
  const prev = commandLock;
  let resolve: () => void;
  commandLock = new Promise<void>((r) => (resolve = r));

  return prev.then(
    () =>
      new Promise<Record<string, unknown>>((res, rej) => {
        if (!bridgeSocket || bridgeSocket.destroyed) {
          resolve!();
          return rej(new Error("Bridge not connected"));
        }

        let buffer = "";

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            cleanup();
            try {
              res(JSON.parse(line));
            } catch (e) {
              rej(new Error(`Invalid JSON from bridge: ${line}`));
            }
          }
        };

        const onError = (err: Error) => {
          cleanup();
          rej(err);
        };

        const onClose = () => {
          cleanup();
          rej(new Error("Bridge connection closed"));
        };

        const timeout = setTimeout(() => {
          cleanup();
          rej(new Error("Bridge command timed out (30s)"));
        }, 30000);

        function cleanup() {
          bridgeSocket?.removeListener("data", onData);
          bridgeSocket?.removeListener("error", onError);
          bridgeSocket?.removeListener("close", onClose);
          clearTimeout(timeout);
          resolve!();
        }

        bridgeSocket.on("data", onData);
        bridgeSocket.on("error", onError);
        bridgeSocket.on("close", onClose);

        bridgeSocket.write(JSON.stringify(cmd) + "\n");
      })
  );
}

async function connectBridge(timeoutMs = 30000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = new net.Socket();
        sock.connect(BRIDGE_PORT, "127.0.0.1", () => {
          sock.setTimeout(0); // Clear connection timeout — keep socket alive
          bridgeSocket = sock;
          resolve();
        });
        sock.on("error", () => {
          sock.destroy();
          reject();
        });
        sock.setTimeout(2000, () => {
          sock.destroy();
          reject();
        });
      });

      // Verify with ping
      const resp = await sendBridgeCommand({ cmd: "ping" });
      if (resp.ok && resp.pong) return;
    } catch {
      // Retry
    }
    await sleep(500);
  }

  throw new Error(`Bridge did not respond within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stopProcess(): Promise<void> {
  return new Promise((resolve) => {
    if (bridgeSocket) {
      bridgeSocket.destroy();
      bridgeSocket = null;
    }

    if (!godotProcess) {
      resolve();
      return;
    }

    const proc = godotProcess;
    godotProcess = null;

    // Reset the command lock since the socket is gone
    commandLock = Promise.resolve();

    proc.on("exit", () => resolve());

    // On Windows, SIGTERM doesn't work well; use kill
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }

    // Force kill after 5s
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch { /* already dead */ }
      resolve();
    }, 5000);
  });
}

async function startProcess(scenePath: string, projectPath: string, headlessParam?: boolean): Promise<string> {
  if (godotProcess) {
    throw new Error("Godot process is already running. Call godot_stop first.");
  }

  // Clear stdout buffer
  stdoutBuffer.length = 0;

  // Find godot executable
  const godotBin = process.env.GODOT_BIN || "godot";
  // headless priority: tool param > env var > default true
  const headless = headlessParam !== undefined
    ? headlessParam
    : (process.env.GODOT_HEADLESS ?? "true").toLowerCase() !== "false";

  const args: string[] = [];
  if (headless) args.push("--headless");
  args.push("--path", projectPath, scenePath);

  godotProcess = spawn(godotBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  godotProcess.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) pushStdout(line);
    }
  });

  godotProcess.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) pushStdout(`[stderr] ${line}`);
    }
  });

  godotProcess.on("exit", (code) => {
    pushStdout(`[process] Godot exited with code ${code}`);
    godotProcess = null;
  });

  // Wait for bridge
  try {
    await connectBridge(30000);
    return "Godot started and bridge connected.";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Godot started but bridge connection failed: ${msg}. Check godot_stdout for errors.`;
  }
}

// ── MCP Server Setup ──────────────────────────────────────────────

const server = new McpServer({
  name: "godot-mcp",
  version: "1.0.0",
});

// ── Process Management Tools ──────────────────────────────────────

server.tool(
  "godot_start",
  "Start Godot with the given scene. Spawns the process and waits for the McpBridge TCP connection. Set headless=false when you need screenshots.",
  {
    scene_path: z.string().describe("Path to the scene file relative to the project root, e.g. 'res://Scenes/Main.tscn'"),
    project_path: z.string().describe("Absolute path to the Godot project directory containing project.godot"),
    headless: z.boolean().optional().describe("Run headless (no window, no screenshots) or windowed (screenshots work). Defaults to GODOT_HEADLESS env or true."),
  },
  async ({ scene_path, project_path, headless }) => {
    try {
      const result = await startProcess(scene_path, project_path, headless);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_stop",
  "Stop the running Godot process and disconnect from the bridge.",
  {},
  async () => {
    await stopProcess();
    return { content: [{ type: "text", text: "Godot stopped." }] };
  }
);

server.tool(
  "godot_reload",
  "Stop and restart Godot with the given scene. This triggers C# recompilation. Always call godot_stdout after this to check for compile errors. Set headless=false when you need screenshots.",
  {
    scene_path: z.string().describe("Path to the scene file, e.g. 'res://Scenes/Main.tscn'"),
    project_path: z.string().describe("Absolute path to the Godot project directory"),
    headless: z.boolean().optional().describe("Run headless (no window) or windowed (screenshots work). Defaults to GODOT_HEADLESS env or true."),
  },
  async ({ scene_path, project_path, headless }) => {
    await stopProcess();
    await sleep(500); // Brief pause for port release
    try {
      const result = await startProcess(scene_path, project_path, headless);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── Observation Tools ─────────────────────────────────────────────

server.tool(
  "godot_screenshot",
  "Capture a screenshot of the current Godot viewport. Returns the image as base64 PNG.",
  {},
  async () => {
    try {
      const resp = await sendBridgeCommand({ cmd: "screenshot" });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }

      const imgPath = resp.path as string;
      const imgData = fs.readFileSync(imgPath);
      const b64 = imgData.toString("base64");

      return {
        content: [
          { type: "image", data: b64, mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_scene_tree",
  "Get the full scene tree with node types, paths, and exported properties. Use this after every reload to verify node structure.",
  {},
  async () => {
    try {
      const resp = await sendBridgeCommand({ cmd: "tree" });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(resp.tree, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_logs",
  "Drain buffered McpLog entries (info/warn/error) from the running Godot instance. Check this after reload for runtime errors in _Ready().",
  {},
  async () => {
    try {
      const resp = await sendBridgeCommand({ cmd: "logs" });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const entries = resp.entries as Array<Record<string, unknown>>;
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No log entries." }] };
      }
      const formatted = entries
        .map((e) => `[${e.level}] ${e.message}`)
        .join("\n");
      return { content: [{ type: "text", text: formatted }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_stdout",
  "Return the last N lines from the Godot process stdout/stderr. This is where C# compiler errors appear. Always check this after godot_reload.",
  {
    lines: z.number().optional().default(50).describe("Number of lines to return (default 50, max 200)"),
  },
  async ({ lines }) => {
    const n = Math.min(Math.max(1, lines), STDOUT_MAX);
    const output = stdoutBuffer.slice(-n).join("\n");
    return { content: [{ type: "text", text: output || "(no output)" }] };
  }
);

// ── Interaction Tools ─────────────────────────────────────────────

server.tool(
  "godot_eval",
  "Evaluate arbitrary C# code in the running Godot instance via Roslyn. Globals: Root (root Node), Tree (SceneTree). Full C# and LINQ available. Return a string from your expression for best results.",
  {
    code: z.string().describe("C# code to evaluate. Globals: Root (Node), Tree (SceneTree). Use 'return' for expressions."),
  },
  async ({ code }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "eval", code });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: String(resp.result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_set_property",
  "Set a property on a node by path. Value is JSON-typed (number, string, bool).",
  {
    node_path: z.string().describe("Absolute node path, e.g. '/root/World/Player'"),
    property: z.string().describe("Property name, e.g. 'Speed'"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value for the property"),
  },
  async ({ node_path, property, value }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "set", node: node_path, prop: property, value });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Set ${node_path}.${property} = ${value}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_find_nodes",
  "Find all nodes of a given Godot type in the scene tree. Returns their paths.",
  {
    type: z.string().describe("Godot class name, e.g. 'CharacterBody3D', 'MeshInstance3D'"),
  },
  async ({ type }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "nodes", type });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const paths = resp.paths as string[];
      return { content: [{ type: "text", text: paths.length ? paths.join("\n") : "No nodes found." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── Tick Control ──────────────────────────────────────────────────

server.tool(
  "godot_tick",
  "Manually fire game ticks for deterministic testing. Fires fast ticks (0.1s intervals for movement/combat) and/or slow ticks (1.0s intervals for economy/growth). Game must have state loaded. Does NOT require the game to be unpaused.",
  {
    fast: z.number().optional().default(0).describe("Number of fast ticks to fire (0.1s each, for movement/combat)"),
    slow: z.number().optional().default(0).describe("Number of slow ticks to fire (1.0s each, for economy/growth/research)"),
  },
  async ({ fast, slow }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "tick", fast, slow });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Ticked: ${resp.fastFired} fast, ${resp.slowFired} slow. Game time: ${resp.gameTime}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── State Management Tools ────────────────────────────────────────

server.tool(
  "godot_load_state",
  "Load a game save file (JSON) into the running Godot instance. Provide either a file path or inline JSON. This replaces the current game state and rebuilds the scene.",
  {
    path: z.string().optional().describe("Absolute path to a JSON save file"),
    json: z.string().optional().describe("Inline JSON game state (alternative to path)"),
  },
  async ({ path: filePath, json }) => {
    try {
      const cmd: Record<string, unknown> = { cmd: "load_state" };
      if (filePath) {
        cmd.path = filePath;
      } else if (json) {
        cmd.json = JSON.parse(json); // Validate and pass as object
      } else {
        return { content: [{ type: "text", text: "Error: provide either 'path' or 'json'" }], isError: true };
      }

      const resp = await sendBridgeCommand(cmd);
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: `State loaded: ${resp.empires} empires, ${resp.fleets} fleets, ${resp.systems} systems` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_save_state",
  "Save the current game state to a JSON file. If no path is given, returns the JSON inline.",
  {
    path: z.string().optional().describe("Absolute path to save the JSON file. If omitted, returns JSON inline."),
  },
  async ({ path: filePath }) => {
    try {
      const cmd: Record<string, unknown> = { cmd: "save_state" };
      if (filePath) cmd.path = filePath;

      const resp = await sendBridgeCommand(cmd);
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      if (filePath) {
        return { content: [{ type: "text", text: `State saved to ${resp.path}` }] };
      } else {
        return { content: [{ type: "text", text: resp.json as string }] };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
