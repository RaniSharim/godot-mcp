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
<PackageReference Include="Devlooped.JQ" Version="1.8.1.1" />
```

**Note:** On Godot 4.4+, `CSharpScript` is ambiguous between Godot and Roslyn. The bridge uses fully-qualified `Microsoft.CodeAnalysis.CSharp.Scripting.CSharpScript` to avoid this.

`Devlooped.JQ` powers the `jq` filter on `godot_scene_tree`. It bundles the real `jq` binary and shells out via `Process`, so there's no native-load risk in coreclr and no user install step.

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

### Core Tools (handled by the included McpBridge.cs)

| Tool | Description |
|---|---|
| `godot_start` | Start Godot with a scene |
| `godot_stop` | Stop the Godot process |
| `godot_reload` | Restart Godot (triggers C# recompilation) |
| `godot_screenshot` | Capture viewport as PNG (windowed mode only). Supports `wait_frames` to let tweens settle. |
| `godot_scene_tree` | Scene tree with node types, paths, and optional properties. Supports `from_path`, `include_properties`, and server-side `jq` filtering. |
| `godot_logs` | Drain McpLog buffer |
| `godot_stdout` | Get Godot process stdout/stderr (compiler errors). Supports `errors_only` to drop non-stderr lines. |
| `godot_eval` | Evaluate C# code via Roslyn (currently disabled) |
| `godot_set_property` | Set a node property by path |
| `godot_find_nodes` | Find nodes by Godot type |
| `godot_click` | Simulate a mouse click at viewport (x, y) |
| `godot_key` | Simulate a keyboard key event |
| `godot_press_button` | Press a UI button directly by path (bypasses hit-test) |
| `godot_click_node` | Fire a click directly on an Area3D/Area2D/Control by path |
| `godot_fire_signal` | Emit an arbitrary signal on any node |

#### `godot_click`

Injects a paired `InputEventMouseButton` press+release via `Input.ParseInputEvent`, with one frame between them so UI controls (Button, Control, etc.) see it as a real click. Works in both headless and windowed mode.

| Param | Type | Default | Description |
|---|---|---|---|
| `x` | number | required | Viewport X coordinate in pixels (from top-left) |
| `y` | number | required | Viewport Y coordinate in pixels (from top-left) |
| `button` | `"left" \| "right" \| "middle"` | `"left"` | Mouse button |
| `double` | boolean | `false` | Sets the press event's `DoubleClick` flag |

Example — right-click at (400, 300):

```json
{ "x": 400, "y": 300, "button": "right" }
```

Example — double-click a button:

```json
{ "x": 120, "y": 80, "double": true }
```

**Finding coordinates:** use `godot_scene_tree` to read a Control's `position` + `size`, or take a `godot_screenshot` in windowed mode and click a pixel.

#### `godot_key`

Injects an `InputEventKey` via `Input.ParseInputEvent`. Use `mode: "tap"` for most cases; `"press"` and `"release"` let you hold a key across multiple calls (e.g., hold W for N frames of movement, then release). The `Unicode` field is auto-filled for A–Z, 0–9, space, and common punctuation so `LineEdit` actually receives typed characters.

| Param | Type | Default | Description |
|---|---|---|---|
| `key` | string | required | Godot `Key` enum name (case-insensitive). Letters `"A"`–`"Z"`, digits `"Key0"`–`"Key9"`, `"Enter"`, `"Space"`, `"Escape"`, `"Backspace"`, `"Tab"`, `"Left"`/`"Right"`/`"Up"`/`"Down"`, `"F1"`–`"F12"`, etc. |
| `mode` | `"tap" \| "press" \| "release"` | `"tap"` | `tap` = press+release with one frame between; `press` / `release` fire a single edge |
| `shift` | boolean | `false` | Modifier |
| `ctrl` | boolean | `false` | Modifier |
| `alt` | boolean | `false` | Modifier |
| `meta` | boolean | `false` | Modifier (Windows/Command key) |

Examples:

```json
{ "key": "Enter" }                       // tap Enter
{ "key": "A", "shift": true }            // tap Shift+A (Unicode 'A')
{ "key": "S", "ctrl": true }             // Ctrl+S
{ "key": "W", "mode": "press" }          // hold W
{ "key": "W", "mode": "release" }        // release W later
{ "key": "Escape" }                      // tap Escape
```

To type a string into a `LineEdit`, first click it to give it focus, then tap each character in sequence.

#### Direct-Invoke Tools (bypass hit-testing)

Coordinate-based `godot_click` exercises the full input pipeline — camera projection, hit-test, click priority, MouseFilter propagation. That's essential for integration testing but painful for gameplay-logic work when the cursor position, camera drift, or overlapping nodes make clicks flaky.

The three direct-invoke tools below target a node by path and fire its handler directly. They're the Godot equivalent of "call the function in a unit test" as opposed to "click the button in a Selenium test."

**Trade-off:** they bypass bugs in the input pipeline itself. If `godot_click` works but `godot_press_button` doesn't, the handler has a bug. If `godot_press_button` works but `godot_click` doesn't, the hit-test has a bug.

##### `godot_press_button`

Emits `BaseButton.Pressed` directly. The fastest way to test any `Button`, `CheckBox`, `LinkButton`, etc.

| Param | Type | Default | Description |
|---|---|---|---|
| `node_path` | string | required | Absolute path to a `BaseButton` subclass |

Response includes the button's `Disabled` state at the time of the call, so you can assert whether a disabled button's handler still fired.

```json
{ "node_path": "/root/Main/UILayer/RightPanel/ActionRow/ScanButton" }
```

##### `godot_click_node`

Fires a `press + release` pair of `InputEventMouseButton` directly on a node, bypassing the hit-test. Routing depends on node type:

- **`Area3D`**: emits `input_event(camera, event, pos, normal, shape_idx)` with the node's `GlobalPosition` and the viewport's active Camera3D
- **`Area2D`**: emits `input_event(viewport, event, shape_idx)` with the node's `GlobalPosition`
- **`Control`**: emits `gui_input(event)` with a position at the Control's center

| Param | Type | Default | Description |
|---|---|---|---|
| `node_path` | string | required | Absolute path to an `Area3D`, `Area2D`, or `Control` node |
| `button` | `"left" \| "right" \| "middle"` | `"left"` | Mouse button to simulate |
| `double` | boolean | `false` | Sets the press event's `DoubleClick` flag |

Examples:

```json
{ "node_path": "/root/Main/GalaxyMap/StarSystems/System_7", "button": "right" }
{ "node_path": "/root/Main/UILayer/FleetCard_0", "double": true }
```

Use when the click target is tiny, offscreen, occluded, or positioned by a drifting camera — i.e., whenever `godot_click` at coordinates is fragile.

##### `godot_fire_signal`

Generic escape hatch. Emits any signal with any args. Use when `press_button` / `click_node` don't apply (custom signals, Toggle signals with args, etc.).

| Param | Type | Default | Description |
|---|---|---|---|
| `node_path` | string | required | Path to the node emitting |
| `signal` | string | required | Signal name (Godot convention is snake_case: `"pressed"`, `"toggled"`, `"value_changed"`) |
| `args` | JSON array | `[]` | Each element is converted to a Variant in the order declared by the signal |

Examples:

```json
{ "node_path": "/root/Main/Settings/MusicSlider", "signal": "value_changed", "args": [0.75] }
{ "node_path": "/root/Main/UI/MuteToggle", "signal": "toggled", "args": [true] }
```

#### `godot_scene_tree`

The full tree for a real scene is commonly multiple MB. Three ways to narrow it, layered from cheapest to most expressive:

| Param | Type | Default | Description |
|---|---|---|---|
| `from_path` | string | root | Start the walk at this node path. Combined with `max_depth=1` in a jq pipe, this is the fastest way to list a node's immediate children. |
| `include_properties` | boolean | `true` | When `false`, skip all exported properties on every node. Shrinks the payload dramatically — use this whenever you just need the node graph. |
| `jq` | string | none | A jq expression applied to the serialized tree **on the bridge side** (via the bundled `jq` binary from `Devlooped.JQ`). Returns the raw jq stdout as a string. |

Recommended workflow: scope with `from_path` + `include_properties: false`, then query with `jq`.

Examples:

```json
// Does a node named "Player" exist anywhere?
{ "include_properties": false, "jq": "[.. | objects | select(.name==\"Player\") | .path]" }

// List every Button in the UI subtree, name + path.
{ "from_path": "/root/Main/UILayer", "include_properties": false,
  "jq": "[.. | objects | select(.type==\"Button\") | {name, path}]" }

// Immediate children of /root/Main (name + type only).
{ "from_path": "/root/Main", "include_properties": false,
  "jq": ".children | map({name, type})" }

// Parent + siblings of a node: walk from the parent, one level deep.
{ "from_path": "/root/Main/UILayer/RightPanel", "include_properties": false,
  "jq": "{self: .name, children: (.children | map(.name))}" }
```

When `jq` is set the response is the raw jq output (string). When it's not set the response is a JSON-stringified tree object.

#### `godot_screenshot`

| Param | Type | Default | Description |
|---|---|---|---|
| `wait_frames` | int | `1` | Frames to wait before capture. Bump to `3`–`10` to let fade-in tweens, post-processing, or newly instantiated scenes settle. |

Only works in windowed mode (`headless: false`).

#### `godot_stdout`

| Param | Type | Default | Description |
|---|---|---|---|
| `lines` | int | `50` | Number of lines to return (max 200). |
| `errors_only` | boolean | `false` | Keep only lines tagged `[stderr]` (stack traces, compile errors). Normal stdout (including `McpLog` info/warn output) is dropped. |

Use `errors_only: true` when a stack trace is drowning out other output; use the default when you need to see the `[INFO]` logs alongside any errors.

### Extension Tools (require game-specific bridge commands)

These tools forward commands to the bridge. They work if your game's McpBridge handles `load_state`, `save_state`, and `tick` commands. The generic `McpBridge.cs` included here does **not** handle them — you must extend it.

| Tool | Description |
|---|---|
| `godot_load_state` | Load a JSON game save file into the running instance |
| `godot_save_state` | Save the current game state to JSON (file or inline) |
| `godot_tick` | Fire fast/slow ticks manually for deterministic testing |

## How It Works

```
Claude Code <--stdio--> godot-mcp (Node.js) <--TCP 9876--> McpBridge (Godot autoload)
```

The MCP server spawns Godot (headless or windowed based on `GODOT_HEADLESS`), then connects to the `McpBridge` autoload over TCP. Commands are newline-delimited JSON. The bridge uses non-blocking byte-level reads in `_Process()` to avoid stalling the game loop.
