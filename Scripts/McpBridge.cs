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

    private TcpListener _listener;
    private TcpClient _client;
    private NetworkStream _stream;
    private StreamWriter _writer;
    private ScriptOptions _scriptOptions;
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

    private async Task HandleCommand(string json)
    {
        string response;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            string cmd = root.GetProperty("cmd").GetString();
            McpLog.Info($"CMD: {cmd}");

            response = cmd switch
            {
                "ping"       => HandlePing(),
                "screenshot" => await HandleScreenshot(),
                "tree"       => HandleTree(),
                "logs"       => HandleLogs(),
                "eval"       => await HandleEval(root),
                "set"        => HandleSet(root),
                "nodes"      => HandleNodes(root),
                _            => JsonErr($"Unknown command: {cmd}")
            };
        }
        catch (Exception ex)
        {
            McpLog.Error($"Command handler error: {ex}");
            response = JsonErr(ex.Message);
        }

        try
        {
            McpLog.Info($"Sending response ({response.Length} chars)");
            _writer.WriteLine(response);
            _writer.Flush();
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

    private async Task<string> HandleScreenshot()
    {
        try
        {
            // Wait one frame for rendering to complete
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

    private string HandleTree()
    {
        var tree = WalkNode(GetTree().Root);
        return JsonOk(new { tree });
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
        string nodePath = root.GetProperty("node").GetString();
        string prop = root.GetProperty("prop").GetString();
        var valueElement = root.GetProperty("value");

        var node = GetTree().Root.GetNodeOrNull(nodePath);
        if (node == null)
            return JsonErr($"Node not found: {nodePath}");

        Variant value = JsonElementToVariant(valueElement);
        node.Set(prop, value);
        return JsonOk(new { });
    }

    private string HandleNodes(JsonElement root)
    {
        string typeName = root.GetProperty("type").GetString();
        var paths = new List<string>();
        FindNodesByType(GetTree().Root, typeName, paths);
        return JsonOk(new { paths });
    }

    // ── Helpers ───────────────────────────────────────────────────

    private Dictionary<string, object> WalkNode(Node node)
    {
        var result = new Dictionary<string, object>
        {
            ["name"] = node.Name.ToString(),
            ["type"] = node.GetClass(),
            ["path"] = node.GetPath().ToString()
        };

        // Exported properties
        var exported = new Dictionary<string, object>();
        foreach (var propDict in node.GetPropertyList())
        {
            var usage = (PropertyUsageFlags)(int)propDict["usage"];
            if (!usage.HasFlag(PropertyUsageFlags.Storage))
                continue;

            string name = (string)propDict["name"];
            // Skip internal/noisy properties
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

        // Children
        var children = new List<Dictionary<string, object>>();
        foreach (var child in node.GetChildren())
            children.Add(WalkNode(child));
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

    private static object VariantToObject(Variant v)
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
        var wrapper = new Dictionary<string, object>(
            data as IDictionary<string, object> ??
            data.GetType().GetProperties()
                .ToDictionary(p => ToCamelCase(p.Name), p => p.GetValue(data))
        );
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
    public Node Root { get; set; }
    public SceneTree Tree { get; set; }
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
