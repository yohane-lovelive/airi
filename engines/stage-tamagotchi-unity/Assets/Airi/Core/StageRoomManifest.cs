using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Airi.Stage.Core
{
    /// <summary>A room file is broken. The message names the field.</summary>
    public sealed class StageRoomException : Exception
    {
        public StageRoomException(string message)
            : base(message)
        {
        }
    }

    /// <summary>A box in world units, with its sides along the axes.</summary>
    public readonly struct StageRoomBox
    {
        public StageRoomBox(double minX, double minY, double minZ, double maxX, double maxY, double maxZ)
        {
            MinX = minX;
            MinY = minY;
            MinZ = minZ;
            MaxX = maxX;
            MaxY = maxY;
            MaxZ = maxZ;
        }

        public double MinX { get; }

        public double MinY { get; }

        public double MinZ { get; }

        public double MaxX { get; }

        public double MaxY { get; }

        public double MaxZ { get; }

        /// <summary>True for a point inside the box or on its sides.</summary>
        public bool Contains(double x, double y, double z)
        {
            return x >= MinX && x <= MaxX && y >= MinY && y <= MaxY && z >= MinZ && z <= MaxZ;
        }

        /// <summary>Moves each side in by <paramref name="margin"/>. A side never passes the center.</summary>
        public StageRoomBox Shrink(double margin)
        {
            double x = Math.Min(margin, (MaxX - MinX) / 2.0);
            double y = Math.Min(margin, (MaxY - MinY) / 2.0);
            double z = Math.Min(margin, (MaxZ - MinZ) / 2.0);
            return new StageRoomBox(MinX + x, MinY + y, MinZ + z, MaxX - x, MaxY - y, MaxZ - z);
        }

        /// <summary>
        /// Gives the share of the line from a point inside the box to another point that stays inside.
        ///
        /// Expects:
        /// - The first point is inside the box.
        ///
        /// Returns:
        /// - 1 when the second point is inside, and a smaller share for each side that the line crosses.
        /// </summary>
        public double ShareInside(double fromX, double fromY, double fromZ, double toX, double toY, double toZ)
        {
            double share = 1.0;
            share = Math.Min(share, AxisShare(fromX, toX, MinX, MaxX));
            share = Math.Min(share, AxisShare(fromY, toY, MinY, MaxY));
            share = Math.Min(share, AxisShare(fromZ, toZ, MinZ, MaxZ));
            return Math.Max(share, 0.0);
        }

        private static double AxisShare(double from, double to, double min, double max)
        {
            if (to > max)
            {
                return (max - from) / (to - from);
            }

            if (to < min)
            {
                return (min - from) / (to - from);
            }

            return 1.0;
        }
    }

    /// <summary>
    /// The file <c>room.json</c> beside a room bundle. The import in the Editor writes it, and the player reads it.
    ///
    /// The stand point and the facing are plain data, so another renderer can read the same room state later.
    /// The bundle itself is Unity data, and only the Unity stage can show it.
    ///
    /// Use it through <see cref="FindFolder"/> and <see cref="Parse"/> in the player.
    /// </summary>
    public sealed class StageRoomManifest
    {
        public const string FileName = "room.json";
        public const int CurrentVersion = 1;
        private const string Argument = "--airi-room=";

        public StageRoomManifest(
            string name,
            string bundle,
            double standX,
            double standY,
            double standZ,
            double facingDegrees,
            StageRoomBox box)
        {
            Name = name;
            Bundle = bundle;
            StandX = standX;
            StandY = standY;
            StandZ = standZ;
            FacingDegrees = facingDegrees;
            Box = box;
        }

        public string Name { get; }

        /// <summary>The file name of the bundle, in the folder of this file.</summary>
        public string Bundle { get; }

        /// <summary>The point on the floor where the avatar stands, in world units.</summary>
        public double StandX { get; }

        public double StandY { get; }

        public double StandZ { get; }

        /// <summary>The turn of the avatar about the vertical axis. At 0 degrees the avatar faces +Z, and 90 degrees face +X.</summary>
        public double FacingDegrees { get; }

        /// <summary>The inside of the room. The camera stays in it.</summary>
        public StageRoomBox Box { get; }

        /// <summary>
        /// Reads the room folder from the arguments of the process, or else from the environment variable
        /// <c>AIRI_UNITY_STAGE_ROOM</c>.
        ///
        /// Returns:
        /// - The folder, or null when neither gives one. Then the stage shows no room.
        /// </summary>
        public static string FindFolder(string[] arguments, string environmentValue)
        {
            string argument = arguments.LastOrDefault(value => value.StartsWith(Argument, StringComparison.Ordinal));
            string folder = argument != null ? argument.Substring(Argument.Length) : environmentValue;
            return string.IsNullOrWhiteSpace(folder) ? null : folder;
        }

        /// <summary>
        /// Reads the text of a room file.
        ///
        /// Throws:
        /// - <see cref="StageRoomException"/> for a broken file. The message names the field.
        /// </summary>
        public static StageRoomManifest Parse(string text)
        {
            JObject root;
            try
            {
                root = JObject.Parse(text);
            }
            catch (JsonException error)
            {
                throw new StageRoomException($"The room file is not JSON: {error.Message}");
            }

            JToken version = root["version"];
            if (version?.Type != JTokenType.Integer || (int)version != CurrentVersion)
            {
                throw new StageRoomException($"The room file needs \"version\": {CurrentVersion}.");
            }

            string name = ReadText(root, "name");
            string bundle = ReadText(root, "bundle");

            // The bundle must stay in the folder of the room file.
            if (bundle.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || bundle == "." || bundle == "..")
            {
                throw new StageRoomException($"The field \"bundle\" must be a file name in the room folder: {bundle}");
            }

            double[] stand = ReadPoint(root["stand"], "stand");
            double facing = ReadNumber(root["facing"], "facing");
            double[] min = ReadPoint(root["box"]?["min"], "box.min");
            double[] max = ReadPoint(root["box"]?["max"], "box.max");
            for (int axis = 0; axis < 3; axis++)
            {
                if (min[axis] >= max[axis])
                {
                    throw new StageRoomException("Each value of \"box.min\" must be less than the value of \"box.max\".");
                }
            }

            var box = new StageRoomBox(min[0], min[1], min[2], max[0], max[1], max[2]);
            if (!box.Contains(stand[0], stand[1], stand[2]))
            {
                throw new StageRoomException("The point \"stand\" must be inside \"box\".");
            }

            return new StageRoomManifest(name, bundle, stand[0], stand[1], stand[2], facing, box);
        }

        /// <summary>Gives the text of the room file. <see cref="Parse"/> reads it back.</summary>
        public string ToJson()
        {
            var root = new JObject
            {
                ["version"] = CurrentVersion,
                ["name"] = Name,
                ["bundle"] = Bundle,
                ["stand"] = Point(StandX, StandY, StandZ),
                ["facing"] = Round(FacingDegrees),
                ["box"] = new JObject
                {
                    ["min"] = Point(Box.MinX, Box.MinY, Box.MinZ),
                    ["max"] = Point(Box.MaxX, Box.MaxY, Box.MaxZ),
                },
            };
            return root.ToString(Formatting.Indented);
        }

        private static string ReadText(JObject root, string field)
        {
            JToken value = root[field];
            if (value?.Type != JTokenType.String || string.IsNullOrWhiteSpace((string)value))
            {
                throw new StageRoomException($"The room file needs the text field \"{field}\".");
            }

            return (string)value;
        }

        private static double[] ReadPoint(JToken value, string field)
        {
            if (!(value is JArray array) || array.Count != 3)
            {
                throw new StageRoomException($"The field \"{field}\" must be a list of 3 numbers.");
            }

            return array.Select(item => ReadNumber(item, field)).ToArray();
        }

        private static double ReadNumber(JToken value, string field)
        {
            if (value == null || (value.Type != JTokenType.Integer && value.Type != JTokenType.Float))
            {
                throw new StageRoomException($"The field \"{field}\" must be a number.");
            }

            double number = value.Value<double>();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                throw new StageRoomException($"The field \"{field}\" must be a finite number.");
            }

            return number;
        }

        private static JArray Point(double x, double y, double z)
        {
            return new JArray(Round(x), Round(y), Round(z));
        }

        /// <summary>Millimeters are enough for a room, and a short number reads better when the owner edits the file.</summary>
        private static double Round(double value)
        {
            return Math.Round(value, 3, MidpointRounding.AwayFromZero);
        }
    }
}
