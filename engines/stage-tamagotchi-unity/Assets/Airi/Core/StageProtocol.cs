using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Airi.Stage.Core
{
    /// <summary>A host message that does not obey the protocol.</summary>
    public sealed class StageProtocolException : Exception
    {
        public StageProtocolException(string message)
            : base(message)
        {
        }
    }

    /// <summary>The size of an avatar, as Electron main uses it for the range of its controls.</summary>
    public readonly struct AvatarBounds
    {
        public readonly double CenterX;
        public readonly double CenterY;
        public readonly double CenterZ;
        public readonly double SizeX;
        public readonly double SizeY;
        public readonly double SizeZ;
        public readonly double MaxDimension;

        public AvatarBounds(
            double centerX,
            double centerY,
            double centerZ,
            double sizeX,
            double sizeY,
            double sizeZ,
            double maxDimension)
        {
            CenterX = centerX;
            CenterY = centerY;
            CenterZ = centerZ;
            SizeX = sizeX;
            SizeY = sizeY;
            SizeZ = sizeZ;
            MaxDimension = maxDimension;
        }
    }

    /// <summary>
    /// Reads and writes the JSON text of the WebSocket. The envelope is
    /// <c>{ type, payload }</c>.
    ///
    /// The rules of <c>packages/stage-shared/src/stage-sidecar/protocol.ts</c> apply here too:
    /// unknown types and unknown fields are errors, and both sides read the same fixtures.
    /// </summary>
    public static class StageProtocol
    {
        /// <summary>
        /// Parses one host message.
        ///
        /// Expects:
        /// - The text of one WebSocket message.
        ///
        /// Returns:
        /// - A subclass of <see cref="HostMessage"/>.
        ///
        /// Throws:
        /// - <see cref="StageProtocolException"/> when the text does not obey the protocol. The
        ///   caller answers with <see cref="CharacterError"/> and keeps the connection.
        /// </summary>
        public static HostMessage ParseHostMessage(string text)
        {
            JObject envelope = ParseObject(text);
            string type = ReadText(envelope, "type");

            if (type == "host.shutdown")
            {
                RequireOnlyFields(envelope, "type");
                return new ShutdownMessage();
            }

            RequireOnlyFields(envelope, "type", "payload");
            JObject payload = ReadObject(envelope, "payload");

            switch (type)
            {
                case "host.scene.apply":
                    return ParseSceneApply(payload);
                case "host.character.idle":
                    RequireOnlyFields(payload, "path");
                    return new CharacterIdleMessage(ReadText(payload, "path"));
                case "host.character.expression":
                    return ParseExpression(payload);
                case "host.character.gesture":
                    return ParseGesture(payload);
                case "host.character.frame":
                    return ParseFrame(payload);
                case "host.character.attention":
                    return ParseAttention(payload);
                case "host.character.activity":
                    return ParseActivity(payload);
                case "host.room.screen":
                    return ParseRoomScreen(payload);
                default:
                    throw new StageProtocolException($"Unknown host message type: {type}");
            }
        }

        public static string StageReady()
        {
            return Serialize(new JObject { ["type"] = "stage.ready" });
        }

        public static string StageFatal(string message)
        {
            return Envelope("stage.fatal", new JObject { ["message"] = message });
        }

        public static string SceneApplied(string modelId, AvatarBounds bounds)
        {
            return Envelope("scene.applied", new JObject
            {
                ["modelId"] = modelId,
                ["avatarBounds"] = new JObject
                {
                    ["center"] = Vector(bounds.CenterX, bounds.CenterY, bounds.CenterZ),
                    ["size"] = Vector(bounds.SizeX, bounds.SizeY, bounds.SizeZ),
                    ["maxDimension"] = bounds.MaxDimension,
                },
            });
        }

        public static string SceneError(string message)
        {
            return Envelope("scene.error", new JObject { ["message"] = message });
        }

        /// <param name="message">What failed.</param>
        /// <param name="type">
        /// The <c>type</c> of the host message that failed. It is empty when the type is unknown.
        /// </param>
        public static string CharacterError(string message, string type)
        {
            return Envelope("character.error", new JObject
            {
                ["message"] = message,
                ["type"] = type,
            });
        }

        private static SceneApplyMessage ParseSceneApply(JObject payload)
        {
            RequireOnlyFields(payload, "format", "modelId", "name", "path");

            string format = ReadText(payload, "format");
            if (format != "vrm" && format != "pmx")
            {
                throw new StageProtocolException($"Unsupported model format: {format}");
            }

            return new SceneApplyMessage(
                format,
                ReadText(payload, "modelId"),
                ReadText(payload, "name"),
                ReadText(payload, "path"));
        }

        private static CharacterExpressionMessage ParseExpression(JObject payload)
        {
            RequireOnlyFields(payload, "name", "intensity", "holdMs");

            float? holdMs = null;
            if (payload.ContainsKey("holdMs"))
            {
                holdMs = ReadPositive(payload, "holdMs");
            }

            return new CharacterExpressionMessage(
                ReadText(payload, "name"),
                ReadWeight(payload, "intensity"),
                holdMs);
        }

        private static HostMessage ParseGesture(JObject payload)
        {
            string kind = ReadText(payload, "kind");
            switch (kind)
            {
                case "keys":
                    return ParseGestureKeys(payload);
                case "vrma":
                    return ParseGestureVrma(payload);
                default:
                    throw new StageProtocolException($"Unknown gesture kind: {kind}");
            }
        }

        private static CharacterGestureKeysMessage ParseGestureKeys(JObject payload)
        {
            RequireOnlyFields(payload, "kind", "id", "part", "duration", "tracks");

            // Only the upper body plays from keys. A full-body clip needs the hips and the legs,
            // which come from a file.
            string part = ReadText(payload, "part");
            if (part != "upper")
            {
                throw new StageProtocolException($"A keys gesture cannot have the part: {part}");
            }

            JArray items = ReadArray(payload, "tracks");
            if (items.Count == 0)
            {
                throw new StageProtocolException("A keys gesture needs at least one track.");
            }

            RotationTrack[] tracks = items.Select(ParseTrack).ToArray();

            return new CharacterGestureKeysMessage(
                ReadText(payload, "id"),
                ReadPositive(payload, "duration"),
                tracks);
        }

        private static RotationTrack ParseTrack(JToken token)
        {
            JObject track = AsObject(token, "tracks");
            RequireOnlyFields(track, "bone", "times", "values");

            float[] times = ReadNumbers(track, "times");
            float[] values = ReadNumbers(track, "values");

            if (times.Length == 0)
            {
                throw new StageProtocolException("A rotation track needs at least one time.");
            }

            if (times.Any(time => time < 0))
            {
                throw new StageProtocolException("A rotation track cannot have a negative time.");
            }

            if (values.Length != times.Length * 4)
            {
                throw new StageProtocolException("A rotation track needs four values for each time.");
            }

            return new RotationTrack(ReadText(track, "bone"), times, values);
        }

        private static CharacterGestureVrmaMessage ParseGestureVrma(JObject payload)
        {
            RequireOnlyFields(payload, "kind", "id", "part", "path");

            string part = ReadText(payload, "part");
            if (part != "upper" && part != "full")
            {
                throw new StageProtocolException($"Unknown gesture part: {part}");
            }

            return new CharacterGestureVrmaMessage(
                ReadText(payload, "id"),
                part,
                ReadText(payload, "path"));
        }

        private static CharacterAttentionMessage ParseAttention(JObject payload)
        {
            RequireOnlyFields(payload, "target");
            string target = ReadText(payload, "target");
            switch (target)
            {
                case "viewer":
                    return new CharacterAttentionMessage(true);
                case "none":
                    return new CharacterAttentionMessage(false);
                default:
                    throw new StageProtocolException($"Unknown attention target: {target}");
            }
        }

        /// <summary>The longest frame of the room screen, in characters of base64, as the TypeScript schema allows.</summary>
        public const int RoomScreenMaxLength = 2_000_000;

        private static RoomScreenMessage ParseRoomScreen(JObject payload)
        {
            RequireOnlyFields(payload, "image");
            string image = ReadText(payload, "image");
            if (image.Length > RoomScreenMaxLength)
            {
                throw new StageProtocolException($"The screen image has {image.Length} characters, and the limit is {RoomScreenMaxLength}.");
            }

            try
            {
                return new RoomScreenMessage(Convert.FromBase64String(image));
            }
            catch (FormatException)
            {
                throw new StageProtocolException("The screen image is no base64.");
            }
        }

        private static CharacterActivityMessage ParseActivity(JObject payload)
        {
            RequireOnlyFields(payload, "activity");
            string activity = ReadText(payload, "activity");
            switch (activity)
            {
                case "watching-screen":
                    return new CharacterActivityMessage(true);
                case "none":
                    return new CharacterActivityMessage(false);
                default:
                    throw new StageProtocolException($"Unknown activity: {activity}");
            }
        }

        private static CharacterFrameMessage ParseFrame(JObject payload)
        {
            RequireOnlyFields(payload, "mouth", "bones", "eyes");

            JObject mouth = ReadObject(payload, "mouth");
            RequireOnlyFields(mouth, "A", "E", "I", "O", "U");

            JObject bones = ReadObject(payload, "bones");
            RequireOnlyFields(bones, "spine", "chest", "neck", "head");

            JObject eyes = ReadObject(payload, "eyes");
            RequireOnlyFields(eyes, "yaw", "pitch");

            return new CharacterFrameMessage(
                new MouthWeights(
                    ReadWeight(mouth, "A"),
                    ReadWeight(mouth, "E"),
                    ReadWeight(mouth, "I"),
                    ReadWeight(mouth, "O"),
                    ReadWeight(mouth, "U")),
                ReadRotation(bones, "spine"),
                ReadRotation(bones, "chest"),
                ReadRotation(bones, "neck"),
                ReadRotation(bones, "head"),
                ReadNumber(eyes, "yaw"),
                ReadNumber(eyes, "pitch"));
        }

        private static BodyRotation ReadRotation(JObject parent, string field)
        {
            JObject rotation = ReadObject(parent, field);
            RequireOnlyFields(rotation, "x", "y", "z");

            return new BodyRotation(
                ReadNumber(rotation, "x"),
                ReadNumber(rotation, "y"),
                ReadNumber(rotation, "z"));
        }

        private static JObject ParseObject(string text)
        {
            try
            {
                using (var reader = new JsonTextReader(new StringReader(text)))
                {
                    // NOTICE:
                    // A path or a name that looks like a date must stay text.
                    // Json.NET turns such a string into a date token by default.
                    // https://www.newtonsoft.com/json/help/html/DatesInJSON.htm
                    // Keep this setting for as long as this parser reads strings through JToken.
                    reader.DateParseHandling = DateParseHandling.None;

                    return AsObject(JToken.ReadFrom(reader), "message");
                }
            }
            catch (JsonException error)
            {
                throw new StageProtocolException($"The message is not JSON: {error.Message}");
            }
        }

        private static void RequireOnlyFields(JObject value, params string[] allowed)
        {
            foreach (JProperty property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw new StageProtocolException($"Unknown field: {property.Name}");
                }
            }
        }

        private static JToken ReadField(JObject parent, string field)
        {
            if (!parent.TryGetValue(field, out JToken token))
            {
                throw new StageProtocolException($"Missing field: {field}");
            }

            return token;
        }

        private static string ReadText(JObject parent, string field)
        {
            JToken token = ReadField(parent, field);
            if (token.Type != JTokenType.String || string.IsNullOrEmpty((string)token))
            {
                throw new StageProtocolException($"The field {field} must be text.");
            }

            return (string)token;
        }

        private static JObject ReadObject(JObject parent, string field)
        {
            return AsObject(ReadField(parent, field), field);
        }

        private static JObject AsObject(JToken token, string field)
        {
            if (token is JObject value)
            {
                return value;
            }

            throw new StageProtocolException($"The field {field} must be an object.");
        }

        private static JArray ReadArray(JObject parent, string field)
        {
            if (ReadField(parent, field) is JArray value)
            {
                return value;
            }

            throw new StageProtocolException($"The field {field} must be an array.");
        }

        private static float ReadNumber(JObject parent, string field)
        {
            return AsNumber(ReadField(parent, field), field);
        }

        private static float ReadWeight(JObject parent, string field)
        {
            float value = ReadNumber(parent, field);
            if (value < 0 || value > 1)
            {
                throw new StageProtocolException($"The field {field} must be from 0 to 1.");
            }

            return value;
        }

        private static float ReadPositive(JObject parent, string field)
        {
            float value = ReadNumber(parent, field);
            if (value <= 0)
            {
                throw new StageProtocolException($"The field {field} must be more than 0.");
            }

            return value;
        }

        private static float[] ReadNumbers(JObject parent, string field)
        {
            return ReadArray(parent, field).Select(token => AsNumber(token, field)).ToArray();
        }

        private static float AsNumber(JToken token, string field)
        {
            // Value<float>() also converts text such as "1". The token type check rejects it.
            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw new StageProtocolException($"The field {field} must be a number.");
            }

            float value = token.Value<float>();
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                throw new StageProtocolException($"The field {field} must be a finite number.");
            }

            return value;
        }

        private static JObject Vector(double x, double y, double z)
        {
            return new JObject
            {
                ["x"] = x,
                ["y"] = y,
                ["z"] = z,
            };
        }

        private static string Envelope(string type, JObject payload)
        {
            return Serialize(new JObject
            {
                ["type"] = type,
                ["payload"] = payload,
            });
        }

        private static string Serialize(JObject envelope)
        {
            return envelope.ToString(Formatting.None);
        }
    }
}
