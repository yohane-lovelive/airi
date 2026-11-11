using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>What a shot at a place must show: the character at the place, and the screen of the place.</summary>
    public readonly struct StagePlaceSubject
    {
        /// <param name="head">Her head joint.</param>
        /// <param name="low">The lowest point to show, for example the seat point, or her feet while she stands.</param>
        /// <param name="facingDegrees">Her facing, as in the room file: 0 is +Z, and 90 is +X.</param>
        public StagePlaceSubject(string name, StagePoint head, StagePoint low, double facingDegrees, StageRoomScreen screen)
        {
            Name = name;
            Head = head;
            Low = low;
            FacingDegrees = facingDegrees;
            Screen = screen;
        }

        /// <summary>The name of the place, for the log.</summary>
        public string Name { get; }

        public StagePoint Head { get; }

        public StagePoint Low { get; }

        public double FacingDegrees { get; }

        public StageRoomScreen Screen { get; }
    }

    /// <summary>
    /// Computes the camera that shows the character and the screen of her place together, as a stream of a player does.
    ///
    /// The camera stands behind her and to one side, about 125 degrees from her facing, and a little above her head. Its
    /// target lies between her head and the center of the screen. Its distance is the shortest that holds her head, the
    /// low point of her body, and the corners of the screen in the view. When she turns to the viewer, her face turns up
    /// to about 90 degrees, so the camera sees it from the side.
    /// </summary>
    public static class StagePlaceShot
    {
        /// <summary>The turns from her facing that the stage tries, in this order, each to her right and to her left.</summary>
        public static readonly double[] TurnDegrees = { 125, 105, 145, 85 };

        /// <summary>The camera stands this far above her head, in meters.</summary>
        public const double HeightAboveHead = 0.3;

        /// <summary>The top of her head lies this far above the head joint, in meters.</summary>
        public const double HeadTop = 0.15;

        /// <summary>The free border of the view. A point must lie inside the view divided by this share.</summary>
        public const double Margin = 1.12;

        public const double NearestDistance = 0.5;

        public const double FarthestDistance = 6;

        /// <summary>The time in seconds of the move from the usual camera to the shot, or back.</summary>
        public const double BlendSeconds = 1.2;

        /// <summary>A drag of the owner keeps the camera between these angles above the level of the target, in degrees.</summary>
        public const double LowestElevation = -20;

        public const double HighestElevation = 60;

        /// <summary>The wheel of the owner keeps the distance between these shares of the shot.</summary>
        public const double NearestZoom = 0.4;

        public const double FarthestZoom = 2.5;

        /// <summary>
        /// Computes the camera for one turn from her facing.
        ///
        /// Returns:
        /// - The pose, or null when no distance up to <see cref="FarthestDistance"/> holds each point.
        /// </summary>
        /// <param name="turnDegrees">The turn of the camera from her facing. A positive turn goes to her right.</param>
        /// <param name="aspect">The width of the window divided by its height.</param>
        public static StageCameraPose? Compute(in StagePlaceSubject subject, double turnDegrees, double verticalFovDegrees, double aspect)
        {
            StagePoint[] points = PointsOf(subject);
            StagePoint screen = subject.Screen.Center;
            var target = new StagePoint((subject.Head.X + screen.X) / 2, (subject.Head.Y + screen.Y) / 2, (subject.Head.Z + screen.Z) / 2);
            double radians = (subject.FacingDegrees + turnDegrees) * Math.PI / 180.0;
            double awayX = Math.Sin(radians);
            double awayZ = Math.Cos(radians);
            double cameraY = subject.Head.Y + HeightAboveHead;
            double tangentY = Math.Tan(verticalFovDegrees * Math.PI / 360.0) / Margin;
            double tangentX = tangentY * aspect;

            StageCameraPose PoseAt(double distance)
            {
                return new StageCameraPose(target.X + (awayX * distance), cameraY, target.Z + (awayZ * distance), target.X, target.Y, target.Z);
            }

            if (!Holds(PoseAt(FarthestDistance), points, tangentX, tangentY))
            {
                return null;
            }

            // A nearer camera shows the points larger, so the shortest distance that holds them lies between the two.
            double near = NearestDistance;
            double far = FarthestDistance;
            if (Holds(PoseAt(near), points, tangentX, tangentY))
            {
                return PoseAt(near);
            }

            for (int step = 0; step < 40; step++)
            {
                double middle = (near + far) / 2;
                if (Holds(PoseAt(middle), points, tangentX, tangentY))
                {
                    far = middle;
                }
                else
                {
                    near = middle;
                }
            }

            return PoseAt(far);
        }

        /// <summary>
        /// Moves the shot for the mouse of the owner: around the target, up or down, nearer or farther, and across. The
        /// shot itself stays, so the moves end when she leaves the place.
        /// </summary>
        /// <param name="yawDegrees">The turn around the vertical axis of the target. A positive turn goes toward +X from +Z.</param>
        /// <param name="pitchDegrees">The change of the angle above the target. A positive change raises the camera.</param>
        /// <param name="zoom">The share of the distance of the shot.</param>
        /// <param name="panRight">The move of the target to the right of the view, in meters.</param>
        /// <param name="panUp">The move of the target up, in meters.</param>
        public static StageCameraPose Adjust(in StageCameraPose pose, double yawDegrees, double pitchDegrees, double zoom, double panRight, double panUp)
        {
            double x = pose.X - pose.TargetX;
            double y = pose.Y - pose.TargetY;
            double z = pose.Z - pose.TargetZ;
            double horizontal = Math.Sqrt((x * x) + (z * z));
            double distance = Math.Sqrt((horizontal * horizontal) + (y * y)) * Math.Max(NearestZoom, Math.Min(FarthestZoom, zoom));
            double heading = Math.Atan2(x, z) + (yawDegrees * Math.PI / 180.0);
            double elevation = (Math.Atan2(y, horizontal) * 180.0 / Math.PI) + pitchDegrees;
            elevation = Math.Max(LowestElevation, Math.Min(HighestElevation, elevation)) * Math.PI / 180.0;

            // The view looks from the camera to the target, so its right is the level line across that direction.
            double targetX = pose.TargetX - (Math.Cos(heading) * panRight);
            double targetY = pose.TargetY + panUp;
            double targetZ = pose.TargetZ + (Math.Sin(heading) * panRight);
            return new StageCameraPose(
                targetX + (Math.Sin(heading) * Math.Cos(elevation) * distance),
                targetY + (Math.Sin(elevation) * distance),
                targetZ + (Math.Cos(heading) * Math.Cos(elevation) * distance),
                targetX,
                targetY,
                targetZ);
        }

        /// <summary>
        /// Blends two cameras: a weight of 0 gives the first, and 1 the second. The weight eases in and out, so the move
        /// starts and ends softly.
        /// </summary>
        public static StageCameraPose Blend(in StageCameraPose from, in StageCameraPose to, double weight)
        {
            double share = Math.Max(0, Math.Min(1, weight));
            share = share * share * (3 - (2 * share));
            return new StageCameraPose(
                from.X + ((to.X - from.X) * share),
                from.Y + ((to.Y - from.Y) * share),
                from.Z + ((to.Z - from.Z) * share),
                from.TargetX + ((to.TargetX - from.TargetX) * share),
                from.TargetY + ((to.TargetY - from.TargetY) * share),
                from.TargetZ + ((to.TargetZ - from.TargetZ) * share));
        }

        /// <summary>The points that the view must hold: the top of her head, her low point, and the four corners of the screen.</summary>
        public static StagePoint[] PointsOf(in StagePlaceSubject subject)
        {
            StageRoomScreen screen = subject.Screen;
            double radians = screen.FacingDegrees * Math.PI / 180.0;

            // The right of a screen that faces +Z is +X in Unity, as for a body.
            double rightX = Math.Cos(radians) * screen.Width / 2;
            double rightZ = -Math.Sin(radians) * screen.Width / 2;
            double halfHeight = screen.Height / 2;
            var points = new List<StagePoint>
            {
                new StagePoint(subject.Head.X, subject.Head.Y + HeadTop, subject.Head.Z),
                subject.Low,
            };
            foreach (double side in new[] { -1.0, 1.0 })
            {
                foreach (double level in new[] { -1.0, 1.0 })
                {
                    points.Add(new StagePoint(
                        screen.Center.X + (rightX * side),
                        screen.Center.Y + (halfHeight * level),
                        screen.Center.Z + (rightZ * side)));
                }
            }

            return points.ToArray();
        }

        /// <summary>Whether each point lies in front of the camera and inside the view less its border.</summary>
        public static bool Holds(in StageCameraPose pose, IReadOnlyList<StagePoint> points, double tangentX, double tangentY)
        {
            double forwardX = pose.TargetX - pose.X;
            double forwardY = pose.TargetY - pose.Y;
            double forwardZ = pose.TargetZ - pose.Z;
            double length = Math.Sqrt((forwardX * forwardX) + (forwardY * forwardY) + (forwardZ * forwardZ));
            forwardX /= length;
            forwardY /= length;
            forwardZ /= length;

            // The right of the view is level. Its up is the cross product of the forward and the right.
            double rightLength = Math.Sqrt((forwardZ * forwardZ) + (forwardX * forwardX));
            double rightX = forwardZ / rightLength;
            double rightZ = -forwardX / rightLength;
            double upX = forwardY * rightZ;
            double upY = (forwardZ * rightX) - (forwardX * rightZ);
            double upZ = -(forwardY * rightX);

            foreach (StagePoint point in points)
            {
                double x = point.X - pose.X;
                double y = point.Y - pose.Y;
                double z = point.Z - pose.Z;
                double depth = (x * forwardX) + (y * forwardY) + (z * forwardZ);
                if (depth <= 0
                    || Math.Abs((x * rightX) + (z * rightZ)) > depth * tangentX
                    || Math.Abs((x * upX) + (y * upY) + (z * upZ)) > depth * tangentY)
                {
                    return false;
                }
            }

            return true;
        }
    }
}
