using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Decides the light of the character in a room. A world bakes its lights, so at run time she gets only the light
    /// probes: a dim light with no direction, and toon shaders draw her dark and flat.
    ///
    /// - The light comes from the side of the camera, above and to one side, as a key light of a portrait. So the face
    ///   toward the viewer has light, also when she turns.
    /// - It takes the color of the room, half way to white, so it fits a warm room and does not paint her orange.
    /// - Its strength fills a part of what the room lacks at her place, so she looks alike in a bright room and a dark
    ///   corridor, and she still belongs to the room.
    ///
    /// State: the smoothed strength and color. It has no Unity type, so dotnet tests it.
    /// </summary>
    public sealed class CharacterLight
    {
        /// <summary>
        /// The rendering layer of URP that only the character and her light share. Layer 0 is the default of each
        /// renderer, so a room stays out of it. URP passes only layers with a name to the shaders, so the project setup
        /// names this layer.
        /// </summary>
        public const int RenderingLayer = 1;

        public const string RenderingLayerName = "Character";

        /// <summary>The light comes down at this angle.</summary>
        public const double ElevationDegrees = 35;

        /// <summary>The light comes from this far to the side of the camera.</summary>
        public const double SideDegrees = 30;

        /// <summary>A full fill of the light brings the room and the light to this brightness, as a luminance of the probe.</summary>
        public const double TargetBrightness = 0.95;

        /// <summary>
        /// The light fills this share of what the room lacks. A full fill lit her apart from the dim room in the
        /// captures of 2LDK, and this share kept her in the room.
        /// </summary>
        public const double FillShare = 0.65;

        /// <summary>A bright room still gets this much, so her toon shade keeps a direction.</summary>
        public const double WeakestIntensity = 0.2;

        /// <summary>The share of white in the color of the light. The rest is the color of the room.</summary>
        public const double WhiteShare = 0.5;

        /// <summary>The time constant of a change of the room light, for example from a room into a corridor.</summary>
        public const double FollowSeconds = 0.5;

        private bool _started;

        public double Intensity { get; private set; }

        /// <summary>The color of the light in linear values, with its largest part at 1.</summary>
        public double Red { get; private set; } = 1;

        public double Green { get; private set; } = 1;

        public double Blue { get; private set; } = 1;

        /// <summary>The turn of the light down from the horizon, in degrees, as the X of a Euler rotation in Unity.</summary>
        public double PitchDegrees { get; private set; } = ElevationDegrees;

        /// <summary>The turn of the light about the vertical axis, in degrees, as the Y of a Euler rotation in Unity.</summary>
        public double YawDegrees { get; private set; }

        /// <summary>
        /// Moves the light to the room and the camera of this frame. The first call sets the light at once.
        ///
        /// Expects:
        /// - <paramref name="roomRed"/>, <paramref name="roomGreen"/>, <paramref name="roomBlue"/>: the constant part (L0)
        ///   of the light probe at her chest, in linear values. It is the mean light that reaches her.
        /// - <paramref name="cameraForwardX"/>, <paramref name="cameraForwardZ"/>: the view direction of the camera on the
        ///   ground, in Unity. The length does not matter.
        /// </summary>
        public void Update(double deltaSeconds, double roomRed, double roomGreen, double roomBlue, double cameraForwardX, double cameraForwardZ)
        {
            double luminance = (0.2126 * roomRed) + (0.7152 * roomGreen) + (0.0722 * roomBlue);
            double intensity = Math.Max(WeakestIntensity, FillShare * (TargetBrightness - luminance));

            // A dark place has no color to take, so the light stays white there.
            double largest = Math.Max(roomRed, Math.Max(roomGreen, roomBlue));
            double red = largest > 1e-4 ? roomRed / largest : 1;
            double green = largest > 1e-4 ? roomGreen / largest : 1;
            double blue = largest > 1e-4 ? roomBlue / largest : 1;
            red += (1 - red) * WhiteShare;
            green += (1 - green) * WhiteShare;
            blue += (1 - blue) * WhiteShare;

            double amount = _started ? 1 - Math.Exp(-deltaSeconds / FollowSeconds) : 1;
            _started = true;
            Intensity += (intensity - Intensity) * amount;
            Red += (red - Red) * amount;
            Green += (green - Green) * amount;
            Blue += (blue - Blue) * amount;

            // A camera that looks straight down has no direction on the ground, so the light keeps its last one.
            if ((cameraForwardX * cameraForwardX) + (cameraForwardZ * cameraForwardZ) > 1e-8)
            {
                YawDegrees = (Math.Atan2(cameraForwardX, cameraForwardZ) * 180.0 / Math.PI) + SideDegrees;
            }
        }
    }
}
