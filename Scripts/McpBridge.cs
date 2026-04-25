using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Devlooped;
using Godot;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;

/// <summary>
/// MCP Bridge autoload — listens on TCP 127.0.0.1:9876 and handles
/// newline-delimited JSON commands from the MCP server.
/// Register as an Autoload in project.godot.
/// </summary>
public partial class McpBridge : Node
{
    private const int Port = 9876;

    private TcpListener _listener = null!;
    private TcpClient? _client;
    private NetworkStream? _stream;
    private StreamWriter? _writer;
    private ScriptOptions _scriptOptions = null!;
    private bool _roslynReady;
    private readonly StringBuilder _lineBuffer = new();
    private bool _processingCommand;

    public override void _Ready()
    {
        string loc = typeof(McpBridge).Assembly.Location;
        string buildId = string.IsNullOrEmpty(loc) ? "dynamic" : System.IO.File.GetLastWriteTime(loc).ToString("HH:mm:ss");
        McpLog.Info($"McpBridge BUILD={buildId} starting on 127.0.0.1:{Port}");

        _listener = new TcpListener(IPAddress.Loopback, Port);
        _listener.Start();
        McpLog.Info("McpBridge TCP listener started");

        // Build Roslyn script options once
        // Collect all loaded assemblies for Roslyn
        var refs = new List<System.Reflection.Assembly>
        {
            typeof(Node).Assembly,
            typeof(Enumerable).Assembly,
            typeof(object).Assembly,
            typeof(Console).Assembly,
        };
        // Add all AppDomain assemblies so eval can access game types
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try { if (!asm.IsDynamic && !string.IsNullOrEmpty(asm.Location)) refs.Add(asm); }
            catch { /* skip */ }
        }
        _scriptOptions = ScriptOptions.Default
            .AddReferences(refs)
            .AddImports(
                "System",
                "System.Linq",
                "System.Collections.Generic",
                "Godot"
            );

        _roslynReady = false; // Eval disabled — Roslyn crashes on Godot 4.6 Windows
        McpLog.Info("Roslyn eval disabled (Godot 4.6 Windows incompatibility)");

        // Let the project-specific partial file wire in its command handler.
        InitializeProject();
    }

    public override void _Process(double delta)
    {
        // Accept a new client if we don't have one
        if (_client == null)
        {
            if (_listener.Pending())
            {
                _client?.Dispose();
                _client = _listener.AcceptTcpClient();
                _client.NoDelay = true;
                _stream = _client.GetStream();
                _writer = new StreamWriter(_stream, new UTF8Encoding(false)) { AutoFlush = true };
                _lineBuffer.Clear();
                _processingCommand = false;
                McpLog.Info("MCP client connected");
            }
            return;
        }

        // Don't read new commands while processing an async one
        if (_processingCommand) return;

        // Non-blocking read: accumulate bytes into _lineBuffer, dispatch complete lines
        try
        {
            if (_stream == null) return;
            while (_stream.DataAvailable)
            {
                int b = _stream.ReadByte();
                if (b < 0) { DisconnectClient(); return; }

                if ((char)b == '\n')
                {
                    string line = _lineBuffer.ToString().Trim();
                    _lineBuffer.Clear();
                    if (line.Length > 0)
                    {
                        _processingCommand = true;
                        _ = HandleCommandSafe(line);
                        return; // Process one command per frame
                    }
                }
                else
                {
                    _lineBuffer.Append((char)b);
                }
            }
        }
        catch (IOException)
        {
            // Connection lost
            DisconnectClient();
        }
        catch (ObjectDisposedException)
        {
            DisconnectClient();
        }
        catch (Exception ex)
        {
            McpLog.Error($"Read error: {ex.GetType().Name}: {ex.Message}");
            DisconnectClient();
        }
    }

    private async Task HandleCommandSafe(string json)
    {
        try
        {
            await HandleCommand(json);
        }
        catch (Exception ex)
        {
            McpLog.Error($"Unhandled command error: {ex.Message}");
            try { _writer?.WriteLine(JsonErr(ex.Message)); } catch { }
        }
        finally
        {
            _processingCommand = false;
        }
    }

    /// <summary>
    /// Project-specific command dispatch hook. Projects extend this partial class
    /// in a sibling file (e.g. McpBridge.Project.cs) and set <see cref="_projectCommandHandler"/>
    /// from <see cref="InitializeProject"/> to register project-specific commands
    /// without modifying this template. The handler should return a JSON response
    /// string to handle the command, or null/empty to fall through to the default
    /// dispatch.
    /// </summary>
#pragma warning disable CS0649 // Assigned in sibling partial (McpBridge.Project.cs) when present
    private System.Func<string, JsonElement, Task<string>>? _projectCommandHandler;
#pragma warning restore CS0649

    /// <summary>
    /// Partial hook called at the end of <see cref="_Ready"/>. A sibling partial
    /// class may implement this to wire <see cref="_projectCommandHandler"/>.
    /// Omitting the sibling is fine — the compiler elides the call.
    /// </summary>
    partial void InitializeProject();

    private async Task HandleCommand(string json)
    {
        string response;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            string cmd = root.GetProperty("cmd").GetString() ?? "";
            McpLog.Info($"CMD: {cmd}");

            // Give the project a chance to handle the command first.
            string? projectResponse = _projectCommandHandler != null
                ? await _projectCommandHandler(cmd, root)
                : null;
            if (!string.IsNullOrEmpty(projectResponse))
            {
                response = projectResponse;
            }
            else
            {
                response = cmd switch
                {
                    "ping"       => HandlePing(),
                    "screenshot" => await HandleScreenshot(root),
                    "tree"       => await HandleTree(root),
                    "logs"       => HandleLogs(),
                    "eval"       => await HandleEval(root),
                    "set"        => HandleSet(root),
                    "nodes"      => HandleNodes(root),
                    "click"      => await HandleClick(root),
                    "key"        => await HandleKey(root),
                    "press_button" => HandlePressButton(root),
                    "click_node" => HandleClickNode(root),
                    "fire_signal" => HandleFireSignal(root),
                    _            => JsonErr($"Unknown command: {cmd}")
                };
            }
        }
        catch (Exception ex)
        {
            McpLog.Error($"Command handler error: {ex}");
            response = JsonErr(ex.Message);
        }

        try
        {
            McpLog.Info($"Sending response ({response.Length} chars)");
            _writer?.WriteLine(response);
            _writer?.Flush();
        }
        catch (Exception ex)
        {
            McpLog.Error($"Write error: {ex.Message}");
            DisconnectClient();
        }
    }

    // ── Command Handlers ──────────────────────────────────────────

    private string HandlePing()
    {
        return JsonOk(new { pong = true });
    }

    private async Task<string> HandleScreenshot(JsonElement root)
    {
        try
        {
            int waitFrames = root.TryGetProperty("waitFrames", out var wf) ? Math.Max(1, wf.GetInt32()) : 1;

            for (int i = 0; i < waitFrames; i++)
                await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

            var viewport = GetViewport();
            if (viewport == null)
                return JsonErr("No viewport available");

            var texture = viewport.GetTexture();
            if (texture == null)
                return JsonErr("No viewport texture (headless mode?)");

            var image = texture.GetImage();
            if (image == null)
                return JsonErr("Failed to get image from viewport");

            string path = Path.Combine(Path.GetTempPath(), "godot_mcp_frame.png");
            var err = image.SavePng(path);
            if (err != Error.Ok)
                return JsonErr($"Failed to save screenshot: {err}");

            return JsonOk(new { path });
        }
        catch (Exception ex)
        {
            return JsonErr($"Screenshot error: {ex.Message}");
        }
    }

    private async Task<string> HandleTree(JsonElement root)
    {
        string? fromPath = root.TryGetProperty("fromPath", out var fp) ? fp.GetString() : null;
        bool includeProperties = !root.TryGetProperty("includeProperties", out var ip) || ip.GetBoolean();
        string? jqExpr = root.TryGetProperty("jq", out var jq) ? jq.GetString() : null;

        Node startNode = string.IsNullOrEmpty(fromPath) ? GetTree().Root : GetTree().Root.GetNodeOrNull(fromPath);
        if (startNode == null)
            return JsonErr($"Node not found: {fromPath}");

        var tree = WalkNode(startNode, includeProperties);

        if (string.IsNullOrEmpty(jqExpr))
            return JsonOk(new { tree });

        try
        {
            string treeJson = JsonSerializer.Serialize(tree, JsonCtx.Options);
            string jqOut = await JQ.ExecuteAsync(treeJson, jqExpr);
            return JsonOk(new { jqResult = jqOut });
        }
        catch (Exception ex)
        {
            return JsonErr($"jq error: {ex.Message}");
        }
    }

    private string HandleLogs()
    {
        var entries = McpLog.Drain();
        return JsonOk(new { entries });
    }

    private Task<string> HandleEval(JsonElement root)
    {
        // Roslyn eval crashes Godot 4.6 on Windows — disabled for now.
        return Task.FromResult(JsonErr("eval is disabled: Roslyn incompatible with Godot 4.6 Windows. Use scene_tree/logs instead."));
    }

    private string HandleSet(JsonElement root)
    {
        string? nodePath = root.GetProperty("node").GetString();
        string? prop = root.GetProperty("prop").GetString();
        var valueElement = root.GetProperty("value");

        if (string.IsNullOrEmpty(nodePath))
            return JsonErr("Missing 'node' field");
        if (string.IsNullOrEmpty(prop))
            return JsonErr("Missing 'prop' field");

        var node = GetTree().Root.GetNodeOrNull(nodePath);
        if (node == null)
            return JsonErr($"Node not found: {nodePath}");

        Variant value = JsonElementToVariant(valueElement);
        node.Set(prop, value);
        return JsonOk(new { });
    }

    private string HandleNodes(JsonElement root)
    {
        string? typeName = root.GetProperty("type").GetString();
        if (string.IsNullOrEmpty(typeName))
            return JsonErr("Missing 'type' field");
        var paths = new List<string>();
        FindNodesByType(GetTree().Root, typeName, paths);
        return JsonOk(new { paths });
    }

    private async Task<string> HandleKey(JsonElement root)
    {
        try
        {
            string? keyName = root.GetProperty("key").GetString();
            string mode = root.TryGetProperty("mode", out var m) ? (m.GetString() ?? "tap") : "tap";
            if (string.IsNullOrEmpty(keyName))
                return JsonErr("Missing 'key' field");
            bool shift = root.TryGetProperty("shift", out var s) && s.GetBoolean();
            bool ctrl = root.TryGetProperty("ctrl", out var c) && c.GetBoolean();
            bool alt = root.TryGetProperty("alt", out var a) && a.GetBoolean();
            bool meta = root.TryGetProperty("meta", out var me) && me.GetBoolean();

            if (mode != "tap" && mode != "press" && mode != "release")
                return JsonErr($"Unknown mode: {mode} (use tap/press/release)");

            if (!Enum.TryParse<Key>(keyName, true, out var keycode))
                return JsonErr($"Unknown key: {keyName}. Use Godot Key enum names (A, Enter, Space, Key1, F1, Left, ...).");

            long unicode = ComputeUnicode(keycode, shift);

            InputEventKey MakeEvent(bool pressed) => new InputEventKey
            {
                Keycode = keycode,
                PhysicalKeycode = keycode,
                Unicode = unicode,
                Pressed = pressed,
                ShiftPressed = shift,
                CtrlPressed = ctrl,
                AltPressed = alt,
                MetaPressed = meta,
            };

            if (mode == "press" || mode == "tap")
            {
                Input.ParseInputEvent(MakeEvent(true));
                await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
            }
            if (mode == "release" || mode == "tap")
            {
                Input.ParseInputEvent(MakeEvent(false));
                await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
            }

            return JsonOk(new { key = keyName, mode });
        }
        catch (Exception ex)
        {
            return JsonErr($"Key error: {ex.Message}");
        }
    }

    private string HandlePressButton(JsonElement root)
    {
        string nodePath = root.GetProperty("node_path").GetString() ?? "";
        var node = GetTree().Root.GetNodeOrNull(nodePath);
        if (node == null)
            return JsonErr($"Node not found: {nodePath}");
        if (node is not BaseButton btn)
            return JsonErr($"Node {nodePath} is {node.GetType().Name}, not a BaseButton");

        bool wasDisabled = btn.Disabled;
        btn.EmitSignal(BaseButton.SignalName.Pressed);
        return JsonOk(new { path = nodePath, disabled = wasDisabled });
    }

    private string HandleClickNode(JsonElement root)
    {
        string nodePath = root.GetProperty("node_path").GetString() ?? "";
        string buttonStr = root.TryGetProperty("button", out var b) ? (b.GetString() ?? "left") : "left";
        bool doubleClick = root.TryGetProperty("double", out var d) && d.GetBoolean();
        bool ctrl = root.TryGetProperty("ctrl", out var cc) && cc.GetBoolean();
        bool shift = root.TryGetProperty("shift", out var ss) && ss.GetBoolean();
        bool alt = root.TryGetProperty("alt", out var aa) && aa.GetBoolean();
        bool meta = root.TryGetProperty("meta", out var mm) && mm.GetBoolean();
        var node = GetTree().Root.GetNodeOrNull(nodePath);
        if (node == null)
            return JsonErr($"Node not found: {nodePath}");

        MouseButton button = buttonStr switch
        {
            "right"  => MouseButton.Right,
            "middle" => MouseButton.Middle,
            _        => MouseButton.Left
        };
        MouseButtonMask mask = button switch
        {
            MouseButton.Right  => MouseButtonMask.Right,
            MouseButton.Middle => MouseButtonMask.Middle,
            _                  => MouseButtonMask.Left,
        };

        var press = new InputEventMouseButton
        {
            ButtonIndex = button,
            Pressed = true,
            ButtonMask = mask,
            DoubleClick = doubleClick,
            CtrlPressed = ctrl,
            ShiftPressed = shift,
            AltPressed = alt,
            MetaPressed = meta,
        };
        var release = new InputEventMouseButton
        {
            ButtonIndex = button,
            Pressed = false,
            CtrlPressed = ctrl,
            ShiftPressed = shift,
            AltPressed = alt,
            MetaPressed = meta,
        };

        if (node is Area3D area3d)
        {
            var cam = GetViewport().GetCamera3D();
            var pos = area3d.GlobalPosition;
            press.Position = new Vector2(pos.X, pos.Z);
            area3d.EmitSignal(Area3D.SignalName.InputEvent, cam, press, pos, Vector3.Up, 0);
            area3d.EmitSignal(Area3D.SignalName.InputEvent, cam, release, pos, Vector3.Up, 0);
            return JsonOk(new { path = nodePath, kind = "area3d", button = buttonStr, doubleClick });
        }
        if (node is Area2D area2d)
        {
            var pos = area2d.GlobalPosition;
            press.Position = pos;
            area2d.EmitSignal(Area2D.SignalName.InputEvent, GetViewport(), press, 0);
            area2d.EmitSignal(Area2D.SignalName.InputEvent, GetViewport(), release, 0);
            return JsonOk(new { path = nodePath, kind = "area2d", button = buttonStr, doubleClick });
        }
        if (node is Control ctrlNode)
        {
            press.Position = ctrlNode.GlobalPosition + ctrlNode.Size * 0.5f;
            ctrlNode.EmitSignal(Control.SignalName.GuiInput, press);
            ctrlNode.EmitSignal(Control.SignalName.GuiInput, release);
            return JsonOk(new { path = nodePath, kind = "control", button = buttonStr, doubleClick });
        }
        return JsonErr($"Node {nodePath} is {node.GetType().Name}; expected Area3D, Area2D, or Control");
    }

    private string HandleFireSignal(JsonElement root)
    {
        string nodePath = root.GetProperty("node_path").GetString() ?? "";
        string signalName = root.GetProperty("signal").GetString() ?? "";
        var node = GetTree().Root.GetNodeOrNull(nodePath);
        if (node == null)
            return JsonErr($"Node not found: {nodePath}");

        Variant[] args;
        if (root.TryGetProperty("args", out var argsElement) && argsElement.ValueKind == JsonValueKind.Array)
        {
            var list = new List<Variant>();
            foreach (var el in argsElement.EnumerateArray())
                list.Add(JsonElementToVariant(el));
            args = list.ToArray();
        }
        else
        {
            args = Array.Empty<Variant>();
        }

        var err = node.EmitSignal(signalName, args);
        if (err != Error.Ok)
            return JsonErr($"EmitSignal returned {err}");
        return JsonOk(new { path = nodePath, signal = signalName, argc = args.Length });
    }

    private static long ComputeUnicode(Key keycode, bool shift)
    {
        uint kc = (uint)keycode;
        if (kc >= (uint)Key.A && kc <= (uint)Key.Z)
            return shift ? kc : kc + 32;
        if (kc >= (uint)Key.Key0 && kc <= (uint)Key.Key9 && !shift)
            return kc;
        if (keycode == Key.Space)  return 0x20;
        if (keycode == Key.Minus)  return shift ? '_' : '-';
        if (keycode == Key.Equal)  return shift ? '+' : '=';
        if (keycode == Key.Period) return shift ? '>' : '.';
        if (keycode == Key.Comma)  return shift ? '<' : ',';
        if (keycode == Key.Slash)  return shift ? '?' : '/';
        return 0;
    }

    private async Task<string> HandleClick(JsonElement root)
    {
        try
        {
            float x = (float)root.GetProperty("x").GetDouble();
            float y = (float)root.GetProperty("y").GetDouble();
            string buttonStr = root.TryGetProperty("button", out var b) ? (b.GetString() ?? "left") : "left";
            bool doubleClick = root.TryGetProperty("double", out var d) && d.GetBoolean();
            bool ctrl = root.TryGetProperty("ctrl", out var cc) && cc.GetBoolean();
            bool shift = root.TryGetProperty("shift", out var ss) && ss.GetBoolean();
            bool alt = root.TryGetProperty("alt", out var aa) && aa.GetBoolean();
            bool meta = root.TryGetProperty("meta", out var mm) && mm.GetBoolean();

            MouseButton button = buttonStr switch
            {
                "left"   => MouseButton.Left,
                "right"  => MouseButton.Right,
                "middle" => MouseButton.Middle,
                _        => MouseButton.Left
            };
            MouseButtonMask mask = buttonStr switch
            {
                "left"   => MouseButtonMask.Left,
                "right"  => MouseButtonMask.Right,
                "middle" => MouseButtonMask.Middle,
                _        => MouseButtonMask.Left
            };

            var pos = new Vector2(x, y);

            // Warp the real OS cursor to the target so polling code (e.g. camera edge-pan
            // reading GetMousePosition()) sees the intended position rather than the user's
            // physical cursor. Without this, edge-pan drifts the camera between clicks and
            // pre-computed coordinates miss their targets.
            Input.WarpMouse(pos);

            bool parkCursor = !root.TryGetProperty("park", out var pk) || pk.GetBoolean();

            var press = new InputEventMouseButton
            {
                Position = pos,
                GlobalPosition = pos,
                ButtonIndex = button,
                ButtonMask = mask,
                Pressed = true,
                DoubleClick = doubleClick,
                CtrlPressed = ctrl,
                ShiftPressed = shift,
                AltPressed = alt,
                MetaPressed = meta,
            };
            Input.ParseInputEvent(press);

            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

            var release = new InputEventMouseButton
            {
                Position = pos,
                GlobalPosition = pos,
                ButtonIndex = button,
                ButtonMask = 0,
                Pressed = false,
                CtrlPressed = ctrl,
                ShiftPressed = shift,
                AltPressed = alt,
                MetaPressed = meta,
            };
            Input.ParseInputEvent(release);

            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

            // Park the cursor at viewport center so polling-based edge-pan logic doesn't
            // drift the camera between MCP commands. Pass "park": false to skip.
            if (parkCursor)
            {
                try
                {
                    var size = GetViewport().GetVisibleRect().Size;
                    Input.WarpMouse(new Vector2(size.X / 2f, size.Y / 2f));
                }
                catch { /* best effort */ }
            }

            return JsonOk(new { x, y, button = buttonStr, doubleClick });
        }
        catch (Exception ex)
        {
            return JsonErr($"Click error: {ex.Message}");
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    private Dictionary<string, object?> WalkNode(Node node, bool includeProperties)
    {
        var result = new Dictionary<string, object?>
        {
            ["name"] = node.Name.ToString(),
            ["type"] = node.GetClass(),
            ["path"] = node.GetPath().ToString()
        };

        if (includeProperties)
        {
            var exported = new Dictionary<string, object?>();
            foreach (var propDict in node.GetPropertyList())
            {
                var usage = (PropertyUsageFlags)(int)propDict["usage"];
                if (!usage.HasFlag(PropertyUsageFlags.Storage))
                    continue;

                string name = (string)propDict["name"];
                if (name.StartsWith("metadata/") || name == "script")
                    continue;

                try
                {
                    var val = node.Get(name);
                    exported[name] = VariantToObject(val);
                }
                catch { /* skip unreadable properties */ }
            }
            result["properties"] = exported;
        }

        var children = new List<Dictionary<string, object?>>();
        foreach (var child in node.GetChildren())
            children.Add(WalkNode(child, includeProperties));
        result["children"] = children;

        return result;
    }

    private void FindNodesByType(Node node, string typeName, List<string> paths)
    {
        if (node.GetClass() == typeName || node.IsClass(typeName))
            paths.Add(node.GetPath().ToString());

        foreach (var child in node.GetChildren())
            FindNodesByType(child, typeName, paths);
    }

    private static object? VariantToObject(Variant v)
    {
        return v.VariantType switch
        {
            Variant.Type.Bool   => v.AsBool(),
            Variant.Type.Int    => v.AsInt64(),
            Variant.Type.Float  => v.AsDouble(),
            Variant.Type.String => v.AsString(),
            Variant.Type.Vector2 => v.AsVector2().ToString(),
            Variant.Type.Vector3 => v.AsVector3().ToString(),
            Variant.Type.Color  => v.AsColor().ToString(),
            Variant.Type.Nil    => null,
            _                   => v.ToString()
        };
    }

    private static Variant JsonElementToVariant(JsonElement el)
    {
        return el.ValueKind switch
        {
            JsonValueKind.Number when el.TryGetInt64(out long l) => Variant.From(l),
            JsonValueKind.Number   => Variant.From(el.GetDouble()),
            JsonValueKind.String   => Variant.From(el.GetString()),
            JsonValueKind.True     => Variant.From(true),
            JsonValueKind.False    => Variant.From(false),
            _                      => Variant.From(el.GetRawText())
        };
    }

    private static string JsonOk(object data)
    {
        var wrapper = new Dictionary<string, object?>();
        if (data is IDictionary<string, object?> dictNullable)
        {
            foreach (var kv in dictNullable) wrapper[kv.Key] = kv.Value;
        }
        else if (data is IDictionary<string, object> dict)
        {
            foreach (var kv in dict) wrapper[kv.Key] = kv.Value;
        }
        else
        {
            foreach (var p in data.GetType().GetProperties())
                wrapper[ToCamelCase(p.Name)] = p.GetValue(data);
        }
        wrapper["ok"] = true;
        return JsonSerializer.Serialize(wrapper, JsonCtx.Options);
    }

    private static string JsonErr(string error)
    {
        return JsonSerializer.Serialize(new { ok = false, error }, JsonCtx.Options);
    }

    private static string ToCamelCase(string s) =>
        string.IsNullOrEmpty(s) ? s : char.ToLowerInvariant(s[0]) + s[1..];

    private void DisconnectClient()
    {
        _stream = null;
        _writer = null;
        _client?.Dispose();
        _client = null;
        _processingCommand = false;
    }

    public override void _ExitTree()
    {
        DisconnectClient();
        _listener?.Stop();
        McpLog.Info("McpBridge shut down");
    }
}

/// <summary>Globals exposed to Roslyn eval scripts.</summary>
public class EvalGlobals
{
    public Node? Root { get; set; }
    public SceneTree? Tree { get; set; }
}

/// <summary>JSON serializer context for consistent output.</summary>
[JsonSerializable(typeof(Dictionary<string, object>))]
internal partial class JsonCtx : JsonSerializerContext
{
    private static readonly JsonSerializerOptions _opts = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static new JsonSerializerOptions Options => _opts;
}
