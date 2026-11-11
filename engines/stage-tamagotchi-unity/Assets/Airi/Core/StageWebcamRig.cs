using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Places the second monitor and the webcam at a desk, as a streamer has them. The first monitor shows the game.
    /// The webcam stands on its top edge and films her face, and the second monitor shows this film.
    ///
    /// The second monitor stands beside the first, turned toward her, or above the first when furniture fills both
    /// sides. The stage tests each candidate against the room, because the room has no free space in its file.
    /// </summary>
    public static class StageWebcamRig
    {
        /// <summary>The width of the screen of the second monitor, in meters, about a monitor of 24 inches.</summary>
        public const double Width = 0.55;

        public const double Height = Width * 9.0 / 16.0;

        /// <summary>A second monitor beside the first turns toward her by this angle, as on a desk of two monitors.</summary>
        public const double TurnDegrees = 25;

        /// <summary>The gap between the two monitors beside each other, in meters. The frames fill it.</summary>
        public const double SideGap = 0.04;

        /// <summary>
        /// The gap between the two monitors above each other, in meters. A lamp often hangs on the top edge of a monitor,
        /// as in 2LDK.
        /// </summary>
        public const double AboveGap = 0.12;

        /// <summary>The webcam stands this far above the top edge of the first screen, in meters.</summary>
        public const double WebcamAbove = 0.03;

        /// <summary>The webcam stands this far in front of the first screen, toward her, in meters.</summary>
        public const double WebcamFront = 0.04;

        /// <summary>The webcam films this height around her head, in meters: the head and the shoulders.</summary>
        public const double FilmedHeight = 0.6;

        /// <summary>The middle of the film lies this far below her head joint, at her neck, in meters.</summary>
        public const double FilmedCenterBelowHead = 0.08;

        /// <summary>
        /// Gives the places for the second monitor in the order that the stage tries them: beside the first on the right
        /// as she sees it, beside it on the left, and above it.
        /// </summary>
        public static IReadOnlyList<StageRoomScreen> Candidates(StageRoomScreen first)
        {
            double radians = first.FacingDegrees * Math.PI / 180.0;
            double normalX = Math.Sin(radians);
            double normalZ = Math.Cos(radians);

            // The screen faces her, so her right is the left of the screen itself.
            double rightX = -Math.Cos(radians);
            double rightZ = Math.Sin(radians);
            double turn = TurnDegrees * Math.PI / 180.0;
            double bottom = first.Center.Y - (first.Height / 2);
            var candidates = new List<StageRoomScreen>();
            foreach (double side in new[] { 1.0, -1.0 })
            {
                // The inner edge stays at the first monitor, and the outer edge comes toward her.
                double edgeX = first.Center.X + (side * rightX * ((first.Width / 2) + SideGap));
                double edgeZ = first.Center.Z + (side * rightZ * ((first.Width / 2) + SideGap));
                double alongX = (side * rightX * Math.Cos(turn)) + (normalX * Math.Sin(turn));
                double alongZ = (side * rightZ * Math.Cos(turn)) + (normalZ * Math.Sin(turn));
                double turnedNormalX = (normalX * Math.Cos(turn)) - (side * rightX * Math.Sin(turn));
                double turnedNormalZ = (normalZ * Math.Cos(turn)) - (side * rightZ * Math.Sin(turn));
                candidates.Add(new StageRoomScreen(
                    "Webcam Monitor",
                    "Webcam",
                    new StagePoint(edgeX + (alongX * Width / 2), bottom + (Height / 2), edgeZ + (alongZ * Width / 2)),
                    Math.Atan2(turnedNormalX, turnedNormalZ) * 180.0 / Math.PI,
                    Width,
                    Height));
            }

            candidates.Add(new StageRoomScreen(
                "Webcam Monitor",
                "Webcam",
                new StagePoint(first.Center.X, first.Center.Y + (first.Height / 2) + AboveGap + (Height / 2), first.Center.Z),
                first.FacingDegrees,
                Width,
                Height));
            return candidates;
        }

        /// <summary>The place of the webcam: on the middle of the top edge of the first screen, a little toward her.</summary>
        public static StagePoint WebcamPosition(StageRoomScreen first)
        {
            double radians = first.FacingDegrees * Math.PI / 180.0;
            return new StagePoint(
                first.Center.X + (Math.Sin(radians) * WebcamFront),
                first.Center.Y + (first.Height / 2) + WebcamAbove,
                first.Center.Z + (Math.Cos(radians) * WebcamFront));
        }

        /// <summary>The point that the webcam aims at: her neck, the middle of her head and her shoulders.</summary>
        public static StagePoint FilmedCenter(StagePoint head)
        {
            return new StagePoint(head.X, head.Y - FilmedCenterBelowHead, head.Z);
        }

        /// <summary>The vertical field of view of the webcam, in degrees, that holds <see cref="FilmedHeight"/> at her neck.</summary>
        public static double FieldOfView(StagePoint webcam, StagePoint head)
        {
            StagePoint center = FilmedCenter(head);
            double x = center.X - webcam.X;
            double y = center.Y - webcam.Y;
            double z = center.Z - webcam.Z;
            double distance = Math.Max(0.1, Math.Sqrt((x * x) + (y * y) + (z * z)));
            return 2 * Math.Atan(FilmedHeight / 2 / distance) * 180.0 / Math.PI;
        }
    }
}
