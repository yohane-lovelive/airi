using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Finds the socket of Electron main, in the two ways that a sidecar can start, and the display of the window.
    ///
    /// - Player mode: Electron main starts the player with <c>--airi-ws-url=&lt;url&gt;</c>.
    /// - Attach mode: Electron main writes <c>attach.json</c>, and Play mode in the Editor reads it.
    /// </summary>
    public static class StageLaunch
    {
        private const string UrlArgument = "--airi-ws-url=";
        private const string DisplayArgument = "--airi-display=";

        /// <summary>
        /// Reads the display for the window of the player, for example a second monitor beside a game. The number counts
        /// from 1, in the order of the display layout of Unity, which the player logs at its start. The argument
        /// <c>--airi-display=&lt;number&gt;</c> wins over the environment variable AIRI_UNITY_STAGE_DISPLAY.
        ///
        /// Returns:
        /// - The number, or null when neither gives a whole number of 1 or more. The window then stays where the system
        ///   puts it.
        /// </summary>
        public static int? FindDisplay(string[] arguments, string environmentValue)
        {
            string argument = arguments.LastOrDefault(value => value.StartsWith(DisplayArgument, StringComparison.Ordinal));
            string text = argument != null ? argument.Substring(DisplayArgument.Length) : environmentValue;
            return int.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out int number) && number >= 1
                ? number
                : (int?)null;
        }

        /// <summary>
        /// Reads the socket URL from the arguments of the process.
        ///
        /// Returns:
        /// - The URL, or null when the arguments have none. Then the caller tries attach mode.
        /// </summary>
        public static string FindUrlInArguments(string[] arguments)
        {
            string argument = arguments.FirstOrDefault(value => value.StartsWith(UrlArgument, StringComparison.Ordinal));
            if (argument == null || argument.Length == UrlArgument.Length)
            {
                return null;
            }

            return argument.Substring(UrlArgument.Length);
        }

        /// <summary>
        /// Reads the socket URL from the text of <c>attach.json</c>.
        ///
        /// Returns:
        /// - The URL, or null when the text has none. Electron main can write the file at the same
        ///   moment, so the caller reads it again later.
        /// </summary>
        public static string ReadUrlFromAttachFile(string text)
        {
            try
            {
                JToken url = JObject.Parse(text)["url"];
                return url?.Type == JTokenType.String ? (string)url : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    /// <summary>Places a camera so that an avatar fits a window.</summary>
    public static class StageFraming
    {
        /// <summary>
        /// Gives the distance from the center of an avatar to a camera that shows the whole avatar.
        ///
        /// Expects:
        /// - The camera looks at the center, along the depth axis of the avatar.
        /// - <paramref name="margin"/> is more than 1, for example 1.1 for a free border of 10%.
        ///
        /// Returns:
        /// - A distance in world units. The tighter of the height and the width sets it, so a tall
        ///   avatar fits a wide window and a wide avatar fits a tall window.
        /// </summary>
        public static double DistanceToFit(
            double height,
            double width,
            double depth,
            double verticalFovDegrees,
            double aspect,
            double margin)
        {
            double halfFov = verticalFovDegrees * Math.PI / 360.0;
            double tangent = Math.Tan(halfFov);
            double forHeight = height * margin / 2.0 / tangent;
            double forWidth = width * margin / 2.0 / (tangent * aspect);

            // The fit above is true for the plane through the center. The front of the avatar is
            // nearer to the camera by half of its depth.
            return Math.Max(forHeight, forWidth) + depth / 2.0;
        }
    }
}
