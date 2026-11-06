using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using Newtonsoft.Json.Linq;

/// <summary>
/// Verification host for <c>Assets/Airi/Core</c>. It needs no Unity install.
///
/// Call stack:
///
/// Main
///   -> TestHostMessages (protocol-fixtures.json)
///   -> TestSidecarMessages (protocol-fixtures.json)
///   -> TestRotations (protocol-fixtures.json)
///   -> TestSocket (a local WebSocket server)
/// </summary>
public static class Program
{
    private static int _checks;
    private static int _failures;

    public static async Task<int> Main()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "protocol-fixtures.json");
        JObject fixtures = JObject.Parse(File.ReadAllText(path));

        TestHostMessages(fixtures);
        TestInvalidHostMessages(fixtures);
        TestDateLikeText();
        TestSidecarMessages(fixtures);
        TestRotations(fixtures);
        await TestSocketExchangesMessages();
        await TestSocketReportsHostClose();
        await TestSocketDropsSendsAfterDispose();

        Console.WriteLine($"{_checks} checks, {_failures} failures");
        return _failures == 0 ? 0 : 1;
    }

    private static void Check(bool condition, string description)
    {
        _checks++;
        if (!condition)
        {
            _failures++;
            Console.WriteLine($"FAIL: {description}");
        }
    }

    private static void CheckClose(float actual, double expected, string description)
    {
        Check(Math.Abs(actual - expected) < 1e-5, $"{description}: {actual} != {expected}");
    }

    private static void TestHostMessages(JObject fixtures)
    {
        var seen = new HashSet<string>();

        foreach (JToken fixture in (JArray)fixtures["hostMessages"])
        {
            seen.Add((string)fixture["type"]);
            HostMessage message = StageProtocol.ParseHostMessage(fixture.ToString());
            CheckFields(message, fixture["payload"]);
        }

        // The TypeScript test checks that the fixtures cover every type of the schema.
        Check(seen.Count == 6, $"host message types in the fixtures: {seen.Count}");
    }

    /// <summary>Compares each parsed field with the fixture, so no field gets lost on the way.</summary>
    private static void CheckFields(HostMessage message, JToken payload)
    {
        switch (message)
        {
            case SceneApplyMessage scene:
                Check(scene.Format == (string)payload["format"], "scene format");
                Check(scene.ModelId == (string)payload["modelId"], "scene modelId");
                Check(scene.Name == (string)payload["name"], "scene name");
                Check(scene.Path == (string)payload["path"], "scene path");
                break;
            case CharacterIdleMessage idle:
                Check(idle.Path == (string)payload["path"], "idle path");
                break;
            case CharacterExpressionMessage expression:
                Check(expression.Name == (string)payload["name"], "expression name");
                CheckClose(expression.Intensity, (double)payload["intensity"], "intensity");
                Check(
                    expression.HoldMs == (float?)payload["holdMs"],
                    $"expression hold: {expression.HoldMs}");
                break;
            case CharacterGestureKeysMessage keys:
                Check(keys.Id == (string)payload["id"], "keys id");
                CheckClose(keys.Duration, (double)payload["duration"], "keys duration");
                CheckTracks(keys, (JArray)payload["tracks"]);
                break;
            case CharacterGestureVrmaMessage vrma:
                Check(vrma.Id == (string)payload["id"], "vrma id");
                Check(vrma.Part == (string)payload["part"], "vrma part");
                Check(vrma.Path == (string)payload["path"], "vrma path");
                break;
            case CharacterFrameMessage frame:
                CheckFrame(frame, payload);
                break;
            case ShutdownMessage:
                Check(payload == null, "shutdown has no payload");
                break;
            default:
                Check(false, $"no check for {message.GetType().Name}");
                break;
        }
    }

    private static void CheckTracks(CharacterGestureKeysMessage keys, JArray tracks)
    {
        Check(keys.Tracks.Count == tracks.Count, "track count");

        for (int index = 0; index < tracks.Count; index++)
        {
            RotationTrack track = keys.Tracks[index];
            Check(track.Bone == (string)tracks[index]["bone"], "track bone");
            Check(
                track.Times.SequenceEqual(tracks[index]["times"].Values<float>()),
                "track times");
            Check(
                track.Values.SequenceEqual(tracks[index]["values"].Values<float>()),
                "track values");
        }
    }

    private static void CheckFrame(CharacterFrameMessage frame, JToken payload)
    {
        JToken mouth = payload["mouth"];
        CheckClose(frame.Mouth.A, (double)mouth["A"], "mouth A");
        CheckClose(frame.Mouth.E, (double)mouth["E"], "mouth E");
        CheckClose(frame.Mouth.I, (double)mouth["I"], "mouth I");
        CheckClose(frame.Mouth.O, (double)mouth["O"], "mouth O");
        CheckClose(frame.Mouth.U, (double)mouth["U"], "mouth U");

        JToken bones = payload["bones"];
        CheckRotation(frame.Spine, bones["spine"], "spine");
        CheckRotation(frame.Chest, bones["chest"], "chest");
        CheckRotation(frame.Neck, bones["neck"], "neck");
        CheckRotation(frame.Head, bones["head"], "head");

        CheckClose(frame.EyesYaw, (double)payload["eyes"]["yaw"], "eyes yaw");
        CheckClose(frame.EyesPitch, (double)payload["eyes"]["pitch"], "eyes pitch");
    }

    private static void CheckRotation(BodyRotation rotation, JToken expected, string name)
    {
        CheckClose(rotation.X, (double)expected["x"], $"{name} x");
        CheckClose(rotation.Y, (double)expected["y"], $"{name} y");
        CheckClose(rotation.Z, (double)expected["z"], $"{name} z");
    }

    private static void TestInvalidHostMessages(JObject fixtures)
    {
        foreach (JToken fixture in (JArray)fixtures["invalidHostMessages"])
        {
            CheckRejected(fixture["message"].ToString(), (string)fixture["reason"]);
        }

        CheckRejected("{ not json", "text that is not JSON");
        CheckRejected("[]", "an array as the envelope");
    }

    private static void CheckRejected(string text, string reason)
    {
        try
        {
            StageProtocol.ParseHostMessage(text);
            Check(false, $"accepted an invalid message: {reason}");
        }
        catch (StageProtocolException)
        {
            Check(true, reason);
        }
    }

    /// <summary>Json.NET turns date-like strings into dates by default, which breaks text fields.</summary>
    private static void TestDateLikeText()
    {
        const string date = "2026-11-06T10:00:00Z";
        var message = (CharacterIdleMessage)StageProtocol.ParseHostMessage(
            $"{{\"type\":\"host.character.idle\",\"payload\":{{\"path\":\"{date}\"}}}}");

        Check(message.Path == date, $"date-like text changed to {message.Path}");
    }

    private static void TestSidecarMessages(JObject fixtures)
    {
        var fixtureByType = fixtures["sidecarMessages"].ToDictionary(item => (string)item["type"]);

        JToken bounds = fixtureByType["scene.applied"]["payload"]["avatarBounds"];
        var written = new Dictionary<string, string>
        {
            ["stage.ready"] = StageProtocol.StageReady(),
            ["stage.fatal"] = StageProtocol.StageFatal(
                (string)fixtureByType["stage.fatal"]["payload"]["message"]),
            ["scene.applied"] = StageProtocol.SceneApplied(
                (string)fixtureByType["scene.applied"]["payload"]["modelId"],
                new AvatarBounds(
                    (double)bounds["center"]["x"],
                    (double)bounds["center"]["y"],
                    (double)bounds["center"]["z"],
                    (double)bounds["size"]["x"],
                    (double)bounds["size"]["y"],
                    (double)bounds["size"]["z"],
                    (double)bounds["maxDimension"])),
            ["scene.error"] = StageProtocol.SceneError(
                (string)fixtureByType["scene.error"]["payload"]["message"]),
            ["character.error"] = StageProtocol.CharacterError(
                (string)fixtureByType["character.error"]["payload"]["message"],
                (string)fixtureByType["character.error"]["payload"]["type"]),
        };

        Check(
            written.Keys.ToHashSet().SetEquals(fixtureByType.Keys),
            "the writer covers each sidecar message of the fixtures");

        foreach (KeyValuePair<string, string> pair in written)
        {
            Check(
                SameJson(JToken.Parse(pair.Value), fixtureByType[pair.Key]),
                $"{pair.Key} differs from the fixture: {pair.Value}");
        }
    }

    /// <summary>
    /// Compares two JSON values as the host reads them. JavaScript has one number type, so `0.0`
    /// and `0` are the same value, but <see cref="JToken.DeepEquals(JToken, JToken)"/> separates
    /// them.
    /// </summary>
    private static bool SameJson(JToken left, JToken right)
    {
        if (IsNumber(left) && IsNumber(right))
        {
            return (double)left == (double)right;
        }

        if (left is JObject leftObject && right is JObject rightObject)
        {
            return leftObject.Count == rightObject.Count
                && leftObject.Properties().All(property =>
                    rightObject.TryGetValue(property.Name, out JToken other)
                    && SameJson(property.Value, other));
        }

        return JToken.DeepEquals(left, right);
    }

    private static bool IsNumber(JToken token)
    {
        return token.Type == JTokenType.Integer || token.Type == JTokenType.Float;
    }

    private static void TestRotations(JObject fixtures)
    {
        foreach (JToken fixture in (JArray)fixtures["rotations"])
        {
            JToken euler = fixture["euler"];
            StageQuaternion host = HumanoidFrame.FromEuler(new BodyRotation(
                (float)euler["x"],
                (float)euler["y"],
                (float)euler["z"]));
            CheckQuaternion(host, (JArray)fixture["quaternion"], $"from Euler {euler}");
            CheckQuaternion(
                HumanoidFrame.ToUnity(host),
                (JArray)fixture["unity"],
                $"to Unity {euler}");
        }
    }

    private static void CheckQuaternion(StageQuaternion actual, JArray expected, string name)
    {
        CheckClose(actual.X, (double)expected[0], $"{name} x");
        CheckClose(actual.Y, (double)expected[1], $"{name} y");
        CheckClose(actual.Z, (double)expected[2], $"{name} z");
        CheckClose(actual.W, (double)expected[3], $"{name} w");
    }

    private static async Task TestSocketExchangesMessages()
    {
        // More than the receive buffer of the client, so the message arrives in several parts.
        string large = new string('x', 64 * 1024);

        using var server = new LocalSocketServer();
        Task<WebSocket> accepted = server.AcceptAsync();
        using var client = new StageSocketClient();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await client.ConnectAsync(server.Url, timeout.Token);
        WebSocket host = await accepted;

        await SendText(host, "日本語");
        await SendText(host, large);
        Check(await ReceiveFromClient(client) == "日本語", "client receives UTF-8 text");
        Check(await ReceiveFromClient(client) == large, "client joins the parts of a message");

        client.Send("first");
        client.Send("second");
        Check(await ReceiveText(host) == "first", "host receives the first send");
        Check(await ReceiveText(host) == "second", "host receives the sends in order");
        Check(!client.IsClosed, "the connection stays open");
    }

    private static async Task TestSocketReportsHostClose()
    {
        using var server = new LocalSocketServer();
        Task<WebSocket> accepted = server.AcceptAsync();
        using var client = new StageSocketClient();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await client.ConnectAsync(server.Url, timeout.Token);
        WebSocket host = await accepted;

        await host.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "done",
            CancellationToken.None);

        await WaitUntil(() => client.IsClosed);
        Check(client.IsClosed, "client reports the close of the host");
        Check(client.CloseReason.Contains("host"), $"close reason: {client.CloseReason}");
    }

    private static async Task TestSocketDropsSendsAfterDispose()
    {
        using var server = new LocalSocketServer();
        Task<WebSocket> accepted = server.AcceptAsync();
        var client = new StageSocketClient();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await client.ConnectAsync(server.Url, timeout.Token);
        await accepted;

        client.Dispose();
        client.Send("dropped");

        Check(client.IsClosed, "dispose closes the client");
        Check(!client.TryReceive(out _), "nothing waits after dispose");
    }

    private static async Task<string> ReceiveFromClient(StageSocketClient client)
    {
        string message = null;
        await WaitUntil(() => client.TryReceive(out message));
        return message;
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition() && DateTime.UtcNow < deadline)
        {
            await Task.Delay(5);
        }
    }

    private static Task SendText(WebSocket socket, string text)
    {
        return socket.SendAsync(
            Encoding.UTF8.GetBytes(text),
            WebSocketMessageType.Text,
            true,
            CancellationToken.None);
    }

    private static async Task<string> ReceiveText(WebSocket socket)
    {
        var buffer = new byte[1024];
        WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, CancellationToken.None);
        return Encoding.UTF8.GetString(buffer, 0, result.Count);
    }

    /// <summary>A WebSocket endpoint on a free local port, in place of Electron main.</summary>
    private sealed class LocalSocketServer : IDisposable
    {
        private readonly HttpListener _listener = new HttpListener();

        public LocalSocketServer()
        {
            int port = FindFreePort();

            // HttpListener accepts `localhost` without an administrator URL reservation on Windows.
            _listener.Prefixes.Add($"http://localhost:{port}/");
            _listener.Start();
            Url = new Uri($"ws://localhost:{port}/");
        }

        public Uri Url { get; }

        public async Task<WebSocket> AcceptAsync()
        {
            HttpListenerContext context = await _listener.GetContextAsync();
            HttpListenerWebSocketContext socket = await context.AcceptWebSocketAsync(null);
            return socket.WebSocket;
        }

        public void Dispose()
        {
            _listener.Close();
        }

        private static int FindFreePort()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            int port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            return port;
        }
    }
}
