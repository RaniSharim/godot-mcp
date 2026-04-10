# Godot 4 MCP Server

An MCP (Model Context Protocol) server that lets Claude Code control, inspect, and observe a running Godot 4 C# project — headless or windowed.

## Components

| Component | Description |
|---|---|
| `Scripts/McpBridge.cs` | Godot autoload — TCP server on `127.0.0.1:9876` that handles commands |
| `Scripts/McpLog.cs` | Static logger with buffered drain for MCP |
| `godot-mcp/` | Node.js MCP server that manages the Godot process and proxies commands |
| `CLAUDE.md` | Claude Code instructions (copy to your game project) |

## Setup

### 1. Copy bridge files into your Godot project

Copy `Scripts/McpBridge.cs` and `Scripts/McpLog.cs` into your Godot 4 C# project.

### 2. Add the NuGet dependency

Add to your `.csproj`:

```xml
<PackageReference Include="Microsoft.CodeAnalysis.CSharp.Scripting" Version="4.12.0" />
```

**Note:** On Godot 4.4+, `CSharpScript` is ambiguous between Godot and Roslyn. The bridge uses fully-qualified `Microsoft.CodeAnalysis.CSharp.Scripting.CSharpScript` to avoid this.

### 3. Register the autoload

In `project.godot`, add:

```ini
[autoload]
McpBridge="*res://Scripts/McpBridge.cs"
```

Or register it via the Godot editor: Project > Project Settings > Autoload.

### 4. Build the MCP server

```bash
cd godot-mcp
npm install
npm run build
```

### 5. Configure Claude Code

Add a `.mcp.json` file to your game project root:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"],
      "env": {
        "GODOT_BIN": "/path/to/godot",
        "GODOT_HEADLESS": "true"
      }
    }
  }
}
```

### 6. Copy CLAUDE.md

Copy `CLAUDE.md` to the root of your game project so Claude Code picks it up automatically.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GODOT_BIN` | `"godot"` | Path to the Godot executable. Required if Godot isn't on PATH. |
| `GODOT_HEADLESS` | `"true"` | Set to `"false"` to launch Godot with a visible window. Windowed mode enables screenshots; headless mode is faster and doesn't require a GPU. |

## Headless vs Windowed

| Feature | Headless (`true`) | Windowed (`false`) |
|---|---|---|
| `godot_screenshot` | Returns error (no renderer) | Full viewport capture |
| `godot_scene_tree` | Works | Works |
| `godot_logs` | Works | Works |
| `godot_stdout` | Works | Works |
| `godot_eval` | Disabled (see below) | Disabled (see below) |
| GPU required | No | Yes |
| Visible window | No | Yes |

**Recommendation:** Use `GODOT_HEADLESS=false` during UI development (need screenshots), `GODOT_HEADLESS=true` for CI or logic-only work.

## Known Limitations

- **godot_eval is experimental on all platforms.** Roslyn scripting crashes (access violation) when the globals type is defined in Godot's in-memory assembly — a known Roslyn limitation, not a Godot 4.6-specific bug. Additionally, each eval call leaks a loaded assembly and is never freed. If eval is unstable, fall back to godot_scene_tree and godot_logs. A safer alternative is writing a temp .cs file and hot-reloading it.
- **`CSharpScript` ambiguity on Godot 4.4+:** Godot 4.4 introduced its own `CSharpScript` class which conflicts with Roslyn's. The bridge uses fully-qualified names to resolve this.

## Platform Notes

| Platform | Status | Notes |
|---|---|---|
| **Windows** | Works | Tested with Godot 4.6.2. Set `GODOT_HEADLESS=false` for screenshots. |
| **Linux** | Best support | EGL surfaceless works out of the box for headless rendering |
| **macOS** | Limited | Metal requires a display; headless rendering may not work without a virtual framebuffer |

## Available MCP Tools

| Tool | Description |
|---|---|
| `godot_start` | Start Godot with a scene |
| `godot_stop` | Stop the Godot process |
| `godot_reload` | Restart Godot (triggers C# recompilation) |
| `godot_screenshot` | Capture viewport as PNG (windowed mode only) |
| `godot_scene_tree` | Get full scene tree with properties |
| `godot_logs` | Drain McpLog buffer |
| `godot_stdout` | Get Godot process stdout/stderr (compiler errors) |
| `godot_eval` | Evaluate C# code via Roslyn (currently disabled) |
| `godot_set_property` | Set a node property by path |
| `godot_find_nodes` | Find nodes by Godot type |
| `godot_load_state` | Load a JSON game save file into the running instance |
| `godot_save_state` | Save the current game state to JSON (file or inline) |

## How It Works

```
Claude Code <--stdio--> godot-mcp (Node.js) <--TCP 9876--> McpBridge (Godot autoload)
```

The MCP server spawns Godot (headless or windowed based on `GODOT_HEADLESS`), then connects to the `McpBridge` autoload over TCP. Commands are newline-delimited JSON. The bridge uses non-blocking byte-level reads in `_Process()` to avoid stalling the game loop.
