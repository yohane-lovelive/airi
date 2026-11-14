using System;
using System.Globalization;
using System.Linq;

namespace Airi.Stage.Core
{
    /// <summary>The framings that a key selects. A drag or a wheel turns any of them into <see cref="Custom"/>.</summary>
    public enum StageCameraView
    {
        Full,
        Upper,
        Face,
        Custom,
    }

    /// <summary>One avatar and one lens, in world units.</summary>
    public readonly struct StageCameraFrame
    {
        public StageCameraFrame(
            double centerX,
            double centerY,
            double centerZ,
            double height,
            double feetY,
            double fitDistance,
            double verticalFovDegrees,
            double facingDegrees = 0)
        {
            CenterX = centerX;
            CenterY = centerY;
            CenterZ = centerZ;
            Height = height;
            FeetY = feetY;
            FitDistance = fitDistance;
            VerticalFovDegrees = verticalFovDegrees;
            FacingDegrees = facingDegrees;
        }

        public double CenterX { get; }

        public double CenterY { get; }

        public double CenterZ { get; }

        public double Height { get; }

        public double FeetY { get; }

        /// <summary>The distance that shows the whole avatar. <see cref="StageFraming"/> gives it.</summary>
        public double FitDistance { get; }

        public double VerticalFovDegrees { get; }

        /// <summary>The turn of the avatar about the vertical axis. At 0 degrees the avatar faces +Z, and 90 degrees face +X.</summary>
        public double FacingDegrees { get; }
    }

    /// <summary>Where a camera can go. The camera always goes around the avatar. A room has walls on each side, and a floor.</summary>
    public sealed class StageCameraLimits
    {
        /// <summary>No room, so only the poles stop the camera.</summary>
        public static readonly StageCameraLimits Free = new StageCameraLimits(-80, 80, false, null);

        private StageCameraLimits(double minPitchDegrees, double maxPitchDegrees, bool keepsAboveFeet, StageRoomBox? room)
        {
            MinPitchDegrees = minPitchDegrees;
            MaxPitchDegrees = maxPitchDegrees;
            KeepsAboveFeet = keepsAboveFeet;
            Room = room;
        }

        /// <summary>The camera stays above the floor and <paramref name="wallClearance"/> inside each side of the room.</summary>
        public static StageCameraLimits InRoom(StageRoomBox room, double wallClearance)
        {
            return new StageCameraLimits(-30, 70, true, room.Shrink(wallClearance));
        }

        public double MinPitchDegrees { get; }

        public double MaxPitchDegrees { get; }

        public bool KeepsAboveFeet { get; }

        /// <summary>The space for the camera in world units, or null without a room.</summary>
        public StageRoomBox? Room { get; }
    }

    /// <summary>A place for the camera, and the point that it looks at.</summary>
    public readonly struct StageCameraPose
    {
        public StageCameraPose(double x, double y, double z, double targetX, double targetY, double targetZ)
        {
            X = x;
            Y = y;
            Z = z;
            TargetX = targetX;
            TargetY = targetY;
            TargetZ = targetZ;
        }

        public double X { get; }

        public double Y { get; }

        public double Z { get; }

        public double TargetX { get; }

        public double TargetY { get; }

        public double TargetZ { get; }

        public double Distance
        {
            get
            {
                double x = X - TargetX;
                double y = Y - TargetY;
                double z = Z - TargetZ;
                return Math.Sqrt((x * x) + (y * y) + (z * z));
            }
        }

        /// <summary>The camera on the same line to the same target, at another distance. The view keeps its direction.</summary>
        public StageCameraPose AtDistance(double distance)
        {
            double current = Distance;
            if (current <= 0)
            {
                return this;
            }

            double share = distance / current;
            return new StageCameraPose(
                TargetX + ((X - TargetX) * share),
                TargetY + ((Y - TargetY) * share),
                TargetZ + ((Z - TargetZ) * share),
                TargetX,
                TargetY,
                TargetZ);
        }
    }

    /// <summary>
    /// The camera of a window, as the owner moves it. It knows no Unity type, so the tests run without Unity.
    ///
    /// State: the framing, and for <see cref="StageCameraView.Custom"/> its angles, its distance, and its target.
    /// Lengths count in avatar heights, so another model keeps the same composition. A framing of a key has no
    /// numbers of its own, so it fits each new model and each new window size.
    ///
    /// Use it through <see cref="Rotate"/>, <see cref="Pan"/>, <see cref="Zoom"/>, and <see cref="SetView"/>.
    /// Then read the camera with <see cref="Resolve"/>.
    /// </summary>
    public sealed class StageCameraRig
    {
        private const string Argument = "--airi-camera=";
        private const string CustomPrefix = "custom:";
        private const double DegreesPerWindowHeight = 180.0;
        private const double DistancePerWheelStep = 0.9;

        /// <summary>The nearest camera still shows this part of the height, about two eyes.</summary>
        private const double SmallestVisibleShare = 0.08;
        private const double FarthestOverFit = 2.0;
        private const double FarthestTarget = 0.75;
        private const double ClearanceAboveFeet = 0.02;

        private const double UpperVisibleShare = 0.5;
        private const double UpperTargetBelowTop = 0.25;
        private const double FaceVisibleShare = 0.24;
        private const double FaceTargetBelowTop = 0.11;

        private readonly StageCameraLimits _limits;
        private Placement _custom;

        public StageCameraRig(StageCameraLimits limits)
        {
            _limits = limits;
        }

        public StageCameraView View { get; private set; } = StageCameraView.Full;

        /// <summary>
        /// Reads the framing from the arguments of the process, for captures with a fixed camera.
        ///
        /// Returns:
        /// - The text for <see cref="TryLoad"/>, or null when the arguments have none.
        /// </summary>
        public static string FindInArguments(string[] arguments)
        {
            string argument = arguments.LastOrDefault(value => value.StartsWith(Argument, StringComparison.Ordinal));
            if (argument == null || argument.Length == Argument.Length)
            {
                return null;
            }

            return argument.Substring(Argument.Length);
        }

        /// <summary>Selects a framing of a key. A selection of <see cref="StageCameraView.Custom"/> keeps the last numbers.</summary>
        public void SetView(StageCameraView view)
        {
            View = view;
        }

        /// <summary>Goes around the target. The scene follows the mouse, as in the three.js stage.</summary>
        public void Rotate(double pixelsRight, double pixelsUp, double windowHeight, in StageCameraFrame frame)
        {
            UseCustom(frame);
            double degreesPerPixel = DegreesPerWindowHeight / Math.Max(windowHeight, 1);
            _custom.Yaw += pixelsRight * degreesPerPixel;
            _custom.Pitch -= pixelsUp * degreesPerPixel;
            KeepInLimits();
        }

        /// <summary>Moves the target across the view. The scene follows the mouse.</summary>
        public void Pan(double pixelsRight, double pixelsUp, double windowHeight, in StageCameraFrame frame)
        {
            UseCustom(frame);
            double yaw = Radians(_custom.Yaw);
            double pitch = Radians(_custom.Pitch);
            double heightsPerPixel = _custom.Distance * 2.0 * TangentOfHalfFov(frame) / Math.Max(windowHeight, 1);
            double right = -pixelsRight * heightsPerPixel;
            double up = -pixelsUp * heightsPerPixel;

            // The camera looks toward -Z at a yaw of 0, so its right side is -X.
            _custom.TargetX += (-Math.Cos(yaw) * right) + (-Math.Sin(pitch) * Math.Sin(yaw) * up);
            _custom.TargetY += Math.Cos(pitch) * up;
            _custom.TargetZ += (Math.Sin(yaw) * right) + (-Math.Sin(pitch) * Math.Cos(yaw) * up);
            KeepInLimits();
        }

        /// <summary>Moves toward the target. A positive step comes closer.</summary>
        public void Zoom(double steps, in StageCameraFrame frame)
        {
            UseCustom(frame);
            _custom.Distance = LimitDistance(_custom.Distance * Math.Pow(DistancePerWheelStep, steps), frame);
        }

        /// <summary>The distance from the camera to its target that the framing asks for, before any wall shortens it.</summary>
        public double FramedDistance(in StageCameraFrame frame)
        {
            return PlacementFor(frame).Distance * HeightOf(frame);
        }

        /// <summary>
        /// Gives the camera for this avatar and this lens. The angles and the target count from the front
        /// of the avatar, so they turn with <see cref="StageCameraFrame.FacingDegrees"/>.
        /// </summary>
        /// <param name="yawOffsetDegrees">A turn around the target on top of the framing. A camera that goes around a wall uses it.</param>
        public StageCameraPose Resolve(in StageCameraFrame frame, double yawOffsetDegrees = 0)
        {
            Placement placement = PlacementFor(frame);
            double height = HeightOf(frame);
            double distance = placement.Distance * height;
            double yaw = Radians(placement.Yaw + yawOffsetDegrees);
            double pitch = Radians(placement.Pitch);
            double facing = Radians(frame.FacingDegrees);

            Turn(placement.TargetX * height, placement.TargetZ * height, facing, out double targetOffsetX, out double targetOffsetZ);
            double targetX = frame.CenterX + targetOffsetX;
            double targetY = frame.CenterY + (placement.TargetY * height);
            double targetZ = frame.CenterZ + targetOffsetZ;

            Turn(
                distance * Math.Sin(yaw) * Math.Cos(pitch),
                distance * Math.Cos(yaw) * Math.Cos(pitch),
                facing,
                out double cameraOffsetX,
                out double cameraOffsetZ);
            double x = targetX + cameraOffsetX;
            double y = targetY + (distance * Math.Sin(pitch));
            double z = targetZ + cameraOffsetZ;
            if (_limits.KeepsAboveFeet)
            {
                y = Math.Max(y, frame.FeetY + (ClearanceAboveFeet * height));
            }

            // A wall stands before the camera, so the camera moves toward its target. The view keeps its direction.
            if (_limits.Room is StageRoomBox room && room.Contains(targetX, targetY, targetZ))
            {
                double share = room.ShareInside(targetX, targetY, targetZ, x, y, z);
                x = targetX + ((x - targetX) * share);
                y = targetY + ((y - targetY) * share);
                z = targetZ + ((z - targetZ) * share);
            }

            return new StageCameraPose(x, y, z, targetX, targetY, targetZ);
        }

        /// <summary>Gives a text for <see cref="TryLoad"/>. The log and the settings store use it.</summary>
        public string Save()
        {
            switch (View)
            {
                case StageCameraView.Full:
                    return "full";
                case StageCameraView.Upper:
                    return "upper";
                case StageCameraView.Face:
                    return "face";
                default:
                    return CustomPrefix + string.Join(
                        ",",
                        new[] { _custom.Yaw, _custom.Pitch, _custom.Distance, _custom.TargetX, _custom.TargetY, _custom.TargetZ }
                            .Select(value => value.ToString("F3", CultureInfo.InvariantCulture)));
            }
        }

        /// <summary>
        /// Reads a text of <see cref="Save"/>. The limits of this rig apply, because a saved camera can come
        /// from a run with other limits.
        ///
        /// Returns:
        /// - False for a broken text. The rig then keeps its state.
        /// </summary>
        public bool TryLoad(string text)
        {
            switch (text)
            {
                case "full":
                    View = StageCameraView.Full;
                    return true;
                case "upper":
                    View = StageCameraView.Upper;
                    return true;
                case "face":
                    View = StageCameraView.Face;
                    return true;
            }

            if (text == null || !text.StartsWith(CustomPrefix, StringComparison.Ordinal))
            {
                return false;
            }

            string[] parts = text.Substring(CustomPrefix.Length).Split(',');
            var numbers = new double[parts.Length];
            for (int index = 0; index < parts.Length; index++)
            {
                if (!double.TryParse(parts[index], NumberStyles.Float, CultureInfo.InvariantCulture, out numbers[index])
                    || double.IsNaN(numbers[index])
                    || double.IsInfinity(numbers[index]))
                {
                    return false;
                }
            }

            if (numbers.Length != 6 || numbers[2] <= 0)
            {
                return false;
            }

            _custom = new Placement
            {
                Yaw = numbers[0],
                Pitch = numbers[1],
                Distance = numbers[2],
                TargetX = numbers[3],
                TargetY = numbers[4],
                TargetZ = numbers[5],
            };
            View = StageCameraView.Custom;
            KeepInLimits();
            return true;
        }

        private static double Radians(double degrees)
        {
            return degrees * Math.PI / 180.0;
        }

        /// <summary>Turns a horizontal offset as a turn of <paramref name="radians"/> about +Y turns it in Unity.</summary>
        private static void Turn(double x, double z, double radians, out double turnedX, out double turnedZ)
        {
            turnedX = (x * Math.Cos(radians)) + (z * Math.Sin(radians));
            turnedZ = (z * Math.Cos(radians)) - (x * Math.Sin(radians));
        }

        private static double HeightOf(in StageCameraFrame frame)
        {
            return Math.Max(frame.Height, 0.01);
        }

        private static double TangentOfHalfFov(in StageCameraFrame frame)
        {
            return Math.Tan(Radians(frame.VerticalFovDegrees) / 2.0);
        }

        private static double Clamp(double value, double smallest, double largest)
        {
            return Math.Min(Math.Max(value, smallest), largest);
        }

        /// <summary>A camera for a part of the height. It never stands farther than the camera for the whole avatar.</summary>
        private static Placement Close(in StageCameraFrame frame, double visibleShare, double targetBelowTop)
        {
            return new Placement
            {
                Distance = Math.Min(visibleShare / (2.0 * TangentOfHalfFov(frame)), frame.FitDistance / HeightOf(frame)),
                TargetY = 0.5 - targetBelowTop,
            };
        }

        private Placement PlacementFor(in StageCameraFrame frame)
        {
            switch (View)
            {
                case StageCameraView.Full:
                    return new Placement { Distance = frame.FitDistance / HeightOf(frame) };
                case StageCameraView.Upper:
                    return Close(frame, UpperVisibleShare, UpperTargetBelowTop);
                case StageCameraView.Face:
                    return Close(frame, FaceVisibleShare, FaceTargetBelowTop);
                default:
                    Placement placement = _custom;
                    placement.Distance = LimitDistance(placement.Distance, frame);
                    return placement;
            }
        }

        private double LimitDistance(double distance, in StageCameraFrame frame)
        {
            return Clamp(
                distance,
                SmallestVisibleShare / (2.0 * TangentOfHalfFov(frame)),
                FarthestOverFit * frame.FitDistance / HeightOf(frame));
        }

        /// <summary>A framing of a key turns into numbers here, so that a drag starts from the current picture.</summary>
        private void UseCustom(in StageCameraFrame frame)
        {
            _custom = PlacementFor(frame);
            View = StageCameraView.Custom;
        }

        private void KeepInLimits()
        {
            _custom.Yaw = Math.IEEERemainder(_custom.Yaw, 360.0);
            _custom.Pitch = Clamp(_custom.Pitch, _limits.MinPitchDegrees, _limits.MaxPitchDegrees);
            _custom.TargetX = Clamp(_custom.TargetX, -FarthestTarget, FarthestTarget);
            _custom.TargetY = Clamp(_custom.TargetY, -FarthestTarget, FarthestTarget);
            _custom.TargetZ = Clamp(_custom.TargetZ, -FarthestTarget, FarthestTarget);
        }

        /// <summary>Angles in degrees. The distance and the target count in avatar heights, from the center of the avatar.</summary>
        private struct Placement
        {
            public double Yaw;
            public double Pitch;
            public double Distance;
            public double TargetX;
            public double TargetY;
            public double TargetZ;
        }
    }
}
