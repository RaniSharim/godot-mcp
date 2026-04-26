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

function findBuildTarget(projectPath: string): string | null {
  // Prefer .sln (handles multi-project setups), fall back to .csproj.
  // `dotnet build <dir>` errors when a directory contains both, so we
  // disambiguate by passing an explicit file.
  try {
    const entries = fs.readdirSync(projectPath);
    const sln = entries.find((f) => f.toLowerCase().endsWith(".sln"));
    if (sln) return path.join(projectPath, sln);
    const csproj = entries.find((f) => f.toLowerCase().endsWith(".csproj"));
    if (csproj) return path.join(projectPath, csproj);
  } catch { /* fall through */ }
  return null;
}

function runDotnetBuild(projectPath: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const target = findBuildTarget(projectPath);
    if (!target) {
      const msg = `[build][stderr] no .sln or .csproj found in ${projectPath}`;
      pushStdout(msg);
      resolve({ exitCode: -1, output: msg });
      return;
    }
    const proc = spawn("dotnet", ["build", "--nologo", "-v", "minimal", target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const onLine = (data: Buffer, prefix: string) => {
      for (const line of data.toString().split("\n")) {
        if (!line.trim()) continue;
        const tagged = prefix ? `${prefix} ${line}` : line;
        lines.push(tagged);
        pushStdout(tagged);
      }
    };
    proc.stdout?.on("data", (d: Buffer) => onLine(d, "[build]"));
    proc.stderr?.on("data", (d: Buffer) => onLine(d, "[build][stderr]"));
    proc.on("error", (err) => {
      const msg = `[build][stderr] failed to spawn dotnet: ${err.message}`;
      lines.push(msg);
      pushStdout(msg);
      resolve({ exitCode: -1, output: lines.join("\n") });
    });
    proc.on("exit", (code) => resolve({ exitCode: code ?? -1, output: lines.join("\n") }));
  });
}

async function startProcess(
  scenePath: string,
  projectPath: string,
  headlessParam?: boolean,
  extraEnv?: Record<string, string>,
  rebuild: boolean = true,
): Promise<string> {
  if (godotProcess) {
    throw new Error("Godot process is already running. Call godot_stop first.");
  }

  // Clear stdout buffer
  stdoutBuffer.length = 0;

  // Compile C# before launching. Godot's standalone runtime loads the prebuilt
  // assembly from .godot/mono/temp/bin/<Config>/ — it does NOT invoke msbuild
  // itself. Without this step, source edits silently run against the stale dll.
  if (rebuild) {
    const { exitCode } = await runDotnetBuild(projectPath);
    if (exitCode !== 0) {
      return `dotnet build failed (exit ${exitCode}). See godot_stdout for details.`;
    }
  }

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
    env: { ...process.env, ...(extraEnv ?? {}) },
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
  "Start Godot with the given scene. Runs `dotnet build` first (default), then spawns the process and waits for the McpBridge TCP connection. Set headless=false when you need screenshots. Pass env to inject extra environment variables into the Godot process (e.g. DEBUG_EVENTBUS=1). Set rebuild=false to skip the build (e.g. when only assets changed).",
  {
    scene_path: z.string().describe("Path to the scene file relative to the project root, e.g. 'res://Scenes/Main.tscn'"),
    project_path: z.string().describe("Absolute path to the Godot project directory containing project.godot"),
    headless: z.boolean().optional().describe("Run headless (no window, no screenshots) or windowed (screenshots work). Defaults to GODOT_HEADLESS env or true."),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables merged onto process.env for the Godot child, e.g. {\"DEBUG_EVENTBUS\":\"1\",\"DEBUG_EVENTBUS_FILTER\":\"-SignatureChanged\"}"),
    rebuild: z.boolean().optional().default(true).describe("Run `dotnet build` before launching Godot. Default true. Set false when only .tscn/.tres/asset files changed to save 5–30s."),
  },
  async ({ scene_path, project_path, headless, env, rebuild }) => {
    try {
      const result = await startProcess(scene_path, project_path, headless, env, rebuild);
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
  "Stop and restart Godot with the given scene. Runs `dotnet build` first (default) so C# edits take effect — Godot's standalone runtime does NOT recompile on its own. Always call godot_stdout after this to check for compile errors. Set headless=false when you need screenshots. Pass env to inject extra environment variables into the Godot process (e.g. DEBUG_EVENTBUS=1); env is applied fresh each reload, so clear it by omitting or passing {}. Set rebuild=false to skip the build when only assets changed.",
  {
    scene_path: z.string().describe("Path to the scene file, e.g. 'res://Scenes/Main.tscn'"),
    project_path: z.string().describe("Absolute path to the Godot project directory"),
    headless: z.boolean().optional().describe("Run headless (no window) or windowed (screenshots work). Defaults to GODOT_HEADLESS env or true."),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables merged onto process.env for the Godot child, e.g. {\"DEBUG_EVENTBUS\":\"1\",\"DEBUG_EVENTBUS_FILTER\":\"-SignatureChanged\"}"),
    rebuild: z.boolean().optional().default(true).describe("Run `dotnet build` before launching Godot. Default true. Set false when only .tscn/.tres/asset files changed to save 5–30s."),
  },
  async ({ scene_path, project_path, headless, env, rebuild }) => {
    await stopProcess();
    await sleep(500); // Brief pause for port release
    try {
      const result = await startProcess(scene_path, project_path, headless, env, rebuild);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── Observation Tools ─────────────────────────────────────────────

server.tool(
  "godot_screenshot",
  "Capture a screenshot of the current Godot viewport. Returns the image as base64 PNG. Use wait_frames to let tweens/fades settle before capture.",
  {
    wait_frames: z.number().int().optional().default(1).describe("Number of frames to wait before capture (default 1). Bump to 3-10 to let fade-in tweens or post-processing settle."),
  },
  async ({ wait_frames }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "screenshot", waitFrames: wait_frames });
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
  "Get the scene tree with node types, paths, and optionally exported properties. The full tree can be multiple MB — always use from_path, include_properties=false, or a jq expression to narrow the result. Prefer jq for structured queries since it runs on the bridge (no 3.5MB round-trip to filter client-side).",
  {
    from_path: z.string().optional().describe("Absolute node path to start the walk from, e.g. '/root/Main'. Defaults to the SceneTree root."),
    include_properties: z.boolean().optional().default(true).describe("Include per-node exported properties. Set false for a compact skeleton (names/types/paths/children only) — dramatically smaller."),
    jq: z.string().optional().describe("Optional jq expression applied to the serialized tree on the bridge side. Examples: '[.. | objects | select(.name==\"Player\") | .path]' to find a node, '.children | map({name, type})' to list top-level children, '.. | objects | select(.type==\"Button\") | .path' to find all buttons. Returns the raw jq stdout as a string."),
  },
  async ({ from_path, include_properties, jq }) => {
    try {
      const cmd: Record<string, unknown> = { cmd: "tree", includeProperties: include_properties };
      if (from_path) cmd.fromPath = from_path;
      if (jq) cmd.jq = jq;
      const resp = await sendBridgeCommand(cmd);
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      if (typeof resp.jqResult === "string") {
        return { content: [{ type: "text", text: resp.jqResult || "(empty jq result)" }] };
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
  "Return the last N lines from the Godot process stdout/stderr. This is where C# compiler errors appear. Always check this after godot_reload. Use errors_only to drop normal stdout and keep just [stderr]-tagged lines (compile errors, stack traces).",
  {
    lines: z.number().optional().default(50).describe("Number of lines to return (default 50, max 200)"),
    errors_only: z.boolean().optional().default(false).describe("Keep only lines tagged [stderr] (stack traces, compile errors). Normal stdout (including McpLog info/warn) is dropped."),
  },
  async ({ lines, errors_only }) => {
    const n = Math.min(Math.max(1, lines), STDOUT_MAX);
    const source = errors_only
      ? stdoutBuffer.filter((l) => l.startsWith("[stderr]"))
      : stdoutBuffer;
    const output = source.slice(-n).join("\n");
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

server.tool(
  "godot_click",
  "Simulate a mouse click at viewport coordinates (x,y in pixels). Fires a press+release pair with one frame between them, dispatched via Input.ParseInputEvent so UI controls (Buttons, Controls) receive it normally. Works in headless and windowed mode. Modifiers (ctrl/shift/alt/meta) are set on both press and release events — use ctrl=true for multi-select UIs.",
  {
    x: z.number().describe("X coordinate in the viewport (pixels from top-left)"),
    y: z.number().describe("Y coordinate in the viewport (pixels from top-left)"),
    button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button to click"),
    double: z.boolean().optional().default(false).describe("Mark the press event as a double-click"),
    ctrl: z.boolean().optional().default(false).describe("Hold Ctrl while clicking"),
    shift: z.boolean().optional().default(false).describe("Hold Shift while clicking"),
    alt: z.boolean().optional().default(false).describe("Hold Alt while clicking"),
    meta: z.boolean().optional().default(false).describe("Hold Meta/Super/Cmd while clicking"),
  },
  async ({ x, y, button, double: doubleClick, ctrl, shift, alt, meta }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "click", x, y, button, double: doubleClick, ctrl, shift, alt, meta });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const mods = [ctrl && "ctrl", shift && "shift", alt && "alt", meta && "meta"].filter(Boolean).join("+");
      const label = doubleClick ? `double-${button}` : button;
      const prefix = mods ? `${mods}+` : "";
      return { content: [{ type: "text", text: `Clicked ${prefix}${label} at (${x}, ${y})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_key",
  "Simulate a keyboard key event via Input.ParseInputEvent. mode='tap' fires press+release with one frame between; 'press' or 'release' fire only that edge (for holding/releasing keys across calls). Modifiers (shift/ctrl/alt/meta) are set on the event. Unicode is auto-filled for A-Z, 0-9, space, and common punctuation so LineEdit-style inputs receive typed characters.",
  {
    key: z.string().describe("Godot Key enum name: letters 'A'-'Z', digits 'Key0'-'Key9', 'Enter', 'Space', 'Escape', 'Backspace', 'Tab', 'Left'/'Right'/'Up'/'Down', 'F1'-'F12', etc. Case-insensitive."),
    mode: z.enum(["tap", "press", "release"]).optional().default("tap").describe("'tap' = press+release, 'press' = press only, 'release' = release only"),
    shift: z.boolean().optional().default(false),
    ctrl: z.boolean().optional().default(false),
    alt: z.boolean().optional().default(false),
    meta: z.boolean().optional().default(false),
  },
  async ({ key, mode, shift, ctrl, alt, meta }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "key", key, mode, shift, ctrl, alt, meta });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const mods = [shift && "shift", ctrl && "ctrl", alt && "alt", meta && "meta"].filter(Boolean).join("+");
      const label = mods ? `${mods}+${key}` : key;
      return { content: [{ type: "text", text: `Key ${mode}: ${label}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

// ── Direct-Invoke Tools (bypass hit-testing) ─────────────────────
// These target a specific node by path and fire its handler directly, bypassing
// camera projection, occlusion, and mouse-filter propagation. Use them for
// gameplay-logic testing where you don't need to exercise the input pipeline.

server.tool(
  "godot_press_button",
  "Press a UI button directly by emitting its Pressed signal. Bypasses the mouse input pipeline entirely — the button's Pressed handler fires even if the button is disabled, offscreen, or occluded. Returns the button's disabled state in the response.",
  {
    node_path: z.string().describe("Absolute path to a BaseButton (Button, CheckBox, etc.), e.g. '/root/Main/UILayer/RightPanel/ScanButton'"),
  },
  async ({ node_path }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "press_button", node_path });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const suffix = resp.disabled ? " (was disabled)" : "";
      return { content: [{ type: "text", text: `Pressed ${node_path}${suffix}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_click_node",
  "Fire a click directly at a specific node, bypassing the hit-test. For Area3D/Area2D this emits the input_event signal; for Control nodes it emits gui_input. Supports left/right/middle buttons, double-click, and modifier keys (ctrl/shift/alt/meta). Use when coordinate-based godot_click is flaky due to camera position, occlusion, or tiny collision shapes.",
  {
    node_path: z.string().describe("Absolute path to an Area3D, Area2D, or Control node"),
    button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button to simulate"),
    double: z.boolean().optional().default(false).describe("Mark the press event's DoubleClick flag"),
    ctrl: z.boolean().optional().default(false).describe("Hold Ctrl while clicking"),
    shift: z.boolean().optional().default(false).describe("Hold Shift while clicking"),
    alt: z.boolean().optional().default(false).describe("Hold Alt while clicking"),
    meta: z.boolean().optional().default(false).describe("Hold Meta/Super/Cmd while clicking"),
  },
  async ({ node_path, button, double: doubleClick, ctrl, shift, alt, meta }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "click_node", node_path, button, double: doubleClick, ctrl, shift, alt, meta });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      const mods = [ctrl && "ctrl", shift && "shift", alt && "alt", meta && "meta"].filter(Boolean).join("+");
      const label = doubleClick ? `double-${button}` : button;
      const prefix = mods ? `${mods}+` : "";
      return { content: [{ type: "text", text: `Clicked ${prefix}${label} on ${node_path} (${resp.kind})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  }
);

server.tool(
  "godot_fire_signal",
  "Emit an arbitrary signal on any node. Generic escape hatch for direct invocation when press_button / click_node don't apply (custom signals, non-Button UI, etc.). Args are JSON values converted to Variants.",
  {
    node_path: z.string().describe("Absolute path to the node emitting the signal"),
    signal: z.string().describe("Signal name, e.g. 'pressed', 'toggled', 'my_custom_signal'"),
    args: z.array(z.any()).optional().default([]).describe("Signal arguments as a JSON array; each element becomes a Variant"),
  },
  async ({ node_path, signal, args }) => {
    try {
      const resp = await sendBridgeCommand({ cmd: "fire_signal", node_path, signal, args });
      if (!resp.ok) {
        return { content: [{ type: "text", text: `Error: ${resp.error}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Emitted ${signal}(${resp.argc} args) on ${node_path}` }] };
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
