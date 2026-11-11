using System;
using System.Collections.Generic;
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

        /// <summary>A point at most this far above or below the stand point is on the floor of the stand point.</summary>
        public const float SameFloor = 0.3f;

        /// <summary>A world has some dozens of doors. This limit only stops a broken file.</summary>
        private const int MaxOpenDoors = 500;

        /// <summary>A home has some dozens of seats. This limit only stops a broken file.</summary>
        private const int MaxPlaces = 200;

        public StageRoomManifest(
            string name,
            string bundle,
            double standX,
            double standY,
            double standZ,
            double facingDegrees,
            StageRoomBox box,
            IReadOnlyList<string> openDoors = null,
            IReadOnlyList<StageRoomPlace> places = null)
        {
            Name = name;
            Bundle = bundle;
            StandX = standX;
            StandY = standY;
            StandZ = standZ;
            FacingDegrees = facingDegrees;
            Box = box;
            OpenDoors = openDoors;
            Places = places;
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
        /// The names of the doors that the import hides, so the character can walk through their doorways. Null when
        /// the file has no list. Then the import finds the doors itself.
        /// </summary>
        public IReadOnlyList<string> OpenDoors { get; }

        /// <summary>
        /// The places with a meaning, for example a desk with a monitor, or a sofa. Null when the file has no list. Then
        /// the import finds the places itself. A screen place with a seat comes first.
        /// </summary>
        public IReadOnlyList<StageRoomPlace> Places { get; }

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

            return new StageRoomManifest(name, bundle, stand[0], stand[1], stand[2], facing, box, ReadNames(root["openDoors"], "openDoors"), ReadPlaces(root["places"], box));
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
            if (OpenDoors != null)
            {
                root["openDoors"] = new JArray(OpenDoors);
            }

            if (Places != null)
            {
                root["places"] = new JArray(Places.Select(WritePlace));
            }

            return root.ToString(Formatting.Indented);
        }

        private static JObject WritePlace(StageRoomPlace place)
        {
            var value = new JObject
            {
                ["name"] = place.Name,
                ["role"] = place.Role == StageRoomPlaceRole.Screen ? "screen" : "seat",
                ["stand"] = Point(place.Stand.X, place.Stand.Y, place.Stand.Z),
                ["facing"] = Round(place.FacingDegrees),
            };
            if (place.Seat is StagePoint seat)
            {
                value["seat"] = Point(seat.X, seat.Y, seat.Z);
            }

            if (place.Screen != null)
            {
                StageRoomScreen screen = place.Screen;
                value["screen"] = new JObject
                {
                    ["object"] = screen.ObjectName,
                    ["material"] = screen.Material,
                    ["center"] = Point(screen.Center.X, screen.Center.Y, screen.Center.Z),
                    ["facing"] = Round(screen.FacingDegrees),
                    ["width"] = Round(screen.Width),
                    ["height"] = Round(screen.Height),
                };
            }

            return value;
        }

        /// <summary>
        /// Reads an optional list of places. A missing field gives null, and an empty list stays empty. Each stand point
        /// and each seat point must be inside the box of the room.
        /// </summary>
        private static IReadOnlyList<StageRoomPlace> ReadPlaces(JToken value, StageRoomBox box)
        {
            if (value == null)
            {
                return null;
            }

            if (!(value is JArray array) || array.Count > MaxPlaces)
            {
                throw new StageRoomException($"The field \"places\" must be a list of at most {MaxPlaces} places.");
            }

            var places = new List<StageRoomPlace>();
            for (int index = 0; index < array.Count; index++)
            {
                if (!(array[index] is JObject item))
                {
                    throw new StageRoomException($"Each item of \"places\" must be an object, and places[{index}] is not.");
                }

                places.Add(ReadPlace(item, $"places[{index}]", box));
            }

            return places;
        }

        private static StageRoomPlace ReadPlace(JObject item, string field, StageRoomBox box)
        {
            string name = ReadText(item, "name", field);
            string roleText = item["role"]?.Type == JTokenType.String ? (string)item["role"] : null;
            StageRoomPlaceRole role;
            switch (roleText)
            {
                case "screen":
                    role = StageRoomPlaceRole.Screen;
                    break;
                case "seat":
                    role = StageRoomPlaceRole.Seat;
                    break;
                default:
                    throw new StageRoomException($"The field \"{field}.role\" must be \"screen\" or \"seat\".");
            }

            StagePoint stand = ReadPointInside(item["stand"], $"{field}.stand", box);
            double facing = ReadNumber(item["facing"], $"{field}.facing");
            StagePoint? seat = item["seat"] == null ? (StagePoint?)null : ReadPointInside(item["seat"], $"{field}.seat", box);
            if (role == StageRoomPlaceRole.Seat && seat == null)
            {
                throw new StageRoomException($"The seat place {field} needs the field \"seat\".");
            }

            StageRoomScreen screen = null;
            if (role == StageRoomPlaceRole.Screen)
            {
                if (!(item["screen"] is JObject screenItem))
                {
                    throw new StageRoomException($"The screen place {field} needs the object \"screen\".");
                }

                string screenField = $"{field}.screen";
                double[] center = ReadPoint(screenItem["center"], $"{screenField}.center");
                screen = new StageRoomScreen(
                    ReadText(screenItem, "object", screenField),
                    ReadText(screenItem, "material", screenField),
                    new StagePoint(center[0], center[1], center[2]),
                    ReadNumber(screenItem["facing"], $"{screenField}.facing"),
                    ReadPositive(screenItem["width"], $"{screenField}.width"),
                    ReadPositive(screenItem["height"], $"{screenField}.height"));
            }
            else if (item["screen"] != null)
            {
                throw new StageRoomException($"Only a screen place has the field \"screen\", and {field} is a seat.");
            }

            return new StageRoomPlace(name, role, stand, facing, seat, screen);
        }

        private static StagePoint ReadPointInside(JToken value, string field, StageRoomBox box)
        {
            double[] point = ReadPoint(value, field);
            if (!box.Contains(point[0], point[1], point[2]))
            {
                throw new StageRoomException($"The point \"{field}\" must be inside \"box\".");
            }

            return new StagePoint(point[0], point[1], point[2]);
        }

        private static double ReadPositive(JToken value, string field)
        {
            double number = ReadNumber(value, field);
            if (number <= 0)
            {
                throw new StageRoomException($"The field \"{field}\" must be more than 0.");
            }

            return number;
        }

        /// <summary>Reads an optional list of names. A missing field gives null, and an empty list stays empty.</summary>
        private static IReadOnlyList<string> ReadNames(JToken value, string field)
        {
            if (value == null)
            {
                return null;
            }

            if (!(value is JArray array) || array.Count > MaxOpenDoors)
            {
                throw new StageRoomException($"The field \"{field}\" must be a list of at most {MaxOpenDoors} names.");
            }

            var names = new List<string>();
            foreach (JToken item in array)
            {
                if (item.Type != JTokenType.String || string.IsNullOrWhiteSpace((string)item))
                {
                    throw new StageRoomException($"Each item of \"{field}\" must be a name.");
                }

                names.Add((string)item);
            }

            return names;
        }

        private static string ReadText(JObject root, string field, string parent = null)
        {
            JToken value = root[field];
            if (value?.Type != JTokenType.String || string.IsNullOrWhiteSpace((string)value))
            {
                throw new StageRoomException($"The room file needs the text field \"{(parent == null ? field : $"{parent}.{field}")}\".");
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

    /// <summary>
    /// Tells the doors of a room from its other parts by their names. The import opens the doors that cut off floor.
    /// The player gives each closed door a collider, so the camera does not look through it.
    /// </summary>
    public static class StageRoomDoors
    {
        /// <summary>Words of the names of doors, in English and in Japanese.</summary>
        private static readonly string[] DoorWords = { "door", "ドア", "扉", "戸" };

        /// <summary>A door frame stays, because it is a part of the wall.</summary>
        private static readonly string[] FrameWords = { "frame", "枠" };

        /// <summary>Whether a name is the name of a door, and not of a door frame. The case does not matter.</summary>
        public static bool IsDoorName(string name)
        {
            string lower = name.ToLowerInvariant();
            return DoorWords.Any(lower.Contains) && !FrameWords.Any(lower.Contains);
        }
    }
}
