using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using Godot;

/// <summary>
/// Static logger that buffers structured entries for the MCP bridge to drain.
/// Use McpLog.Info/Warn/Error instead of GD.Print for anything meaningful.
/// </summary>
public static class McpLog
{
    private const int MaxEntries = 500;
    private static readonly ConcurrentQueue<Dictionary<string, object>> _buffer = new();
    private static int _count;

    public static void Info(string message)  => Log("info", message);
    public static void Warn(string message)  => Log("warn", message);
    public static void Error(string message) => Log("error", message);

    private static void Log(string level, string message)
    {
        GD.Print($"[{level.ToUpper()}] {message}");

        var entry = new Dictionary<string, object>
        {
            ["level"] = level,
            ["message"] = message,
            ["timestamp_ms"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        _buffer.Enqueue(entry);
        _count++;

        // Trim oldest entries if over cap
        while (_count > MaxEntries && _buffer.TryDequeue(out _))
            _count--;
    }

    /// <summary>Drain all buffered entries and return them.</summary>
    public static List<Dictionary<string, object>> Drain()
    {
        var entries = new List<Dictionary<string, object>>();
        while (_buffer.TryDequeue(out var entry))
        {
            entries.Add(entry);
            _count--;
        }
        return entries;
    }
}
