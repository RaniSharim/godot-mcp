# Godot MCP — Claude Code Instructions

This project has a running MCP server (`godot-mcp`) that gives you direct control over a Godot 4 instance. Use it to verify every change you make.

## The Iteration Loop

Follow this loop for **every** change:

1. **Batch all related file edits first** — never reload between individual file changes. C# recompilation takes 10–30 seconds.
2. **`godot_reload`** — triggers C# recompilation and restarts the scene.
3. **`godot_stdout`** immediately — if compilation failed, the error is here. The bridge will not be up. Fix the error and reload before calling any other tool.
4. **`godot_screenshot`** — verify the scene renders correctly. **Only works in windowed mode** (pass `headless: false` to `godot_start`/`godot_reload`).
5. **`godot_scene_tree`** — verify node structure matches expectations.
6. **`godot_logs`** — check for runtime errors or warnings from `_Ready()` and early frames.
7. Repeat from step 1.

## Headless vs Windowed Mode

Both `godot_start` and `godot_reload` accept an optional `headless` parameter:

- **`headless: true`** (default) — no window, no GPU needed, faster. Screenshots return an error. Use for logic-only changes.
- **`headless: false`** — opens a Godot window, screenshots work. Use when you need to verify visuals.

**Choose based on what you're doing:**
- Editing game logic, fixing bugs, changing data → `headless: true` (or omit, it's the default)
- Building/changing UI, rendering, visual effects → `headless: false`

The default can also be set via the `GODOT_HEADLESS` environment variable in `.mcp.json`.

## Compilation Failures

If `godot_reload` completes but `godot_screenshot` hangs or the bridge does not respond, **always check `godot_stdout` first**. C# compile errors only appear there. The bridge never starts if the build fails, so no other tools will work until the error is fixed and the scene is reloaded.

## Batching Edits

C# recompilation is slow. Always batch all related file changes before calling `godot_reload`. Never reload after each individual file edit.

## Scene Tree as Ground Truth

After every reload, call `godot_scene_tree` before making assumptions about what nodes exist. Scenes can fail to instantiate silently if a script throws in `_Ready()` — this won't appear as a compile error in stdout but will appear in `godot_logs`.

## Screenshot Interpretation

Windowed renders are accurate and contain no editor gizmos or selection highlights. What is in the screenshot is exactly what the player would see at runtime.

## Process Lifecycle

- Call `godot_start` once at the beginning of a session (with `headless: false` if you need screenshots).
- Use `godot_reload` for all subsequent restarts (this is the primary iteration tool).
- Call `godot_stop` when the session is done.
- **Never call `godot_start` when a process is already running** — it will error. Use `godot_reload` instead.
- You can switch between headless and windowed by passing a different `headless` value to `godot_reload`.

## Logging

The project uses `McpLog.Info()`, `McpLog.Warn()`, `McpLog.Error()` instead of bare `GD.Print`. Use these in any code you write so logs are captured by the MCP bridge.

## godot_eval — Currently Disabled

The `godot_eval` tool (Roslyn C# scripting) is disabled on Godot 4.6 Windows due to a native crash. Use `godot_scene_tree` and `godot_logs` to inspect live state instead.

## Extension Tools (game-specific)

The MCP server includes `godot_load_state`, `godot_save_state`, and `godot_tick` tools. These forward commands to the bridge but the **generic McpBridge.cs does not handle them**. To use them, extend your game's McpBridge to handle `load_state`, `save_state`, and `tick` commands. See the README for details.

## Project Structure

- `Scripts/McpBridge.cs` — TCP autoload that handles MCP commands (do not modify)
- `Scripts/McpLog.cs` — static logger (do not modify)
- `godot-mcp/` — Node.js MCP server
- `project.godot` — McpBridge is registered as an autoload
