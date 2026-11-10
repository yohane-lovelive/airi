using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Turns the head and the eyes of the character to a point, for example the camera of the window, while the host asks
    /// for the attention of the viewer.
    ///
    /// The neck and the head turn first, up to the limits of a person. The eyes take the rest, up to their own limits.
    /// <see cref="CharacterDriver"/> puts the result over the clips and under the offsets of the frame stream, so the
    /// breath, the nods, and the look aside of a thought stay.
    ///
    /// State: the weight of the aim, and the smoothed direction. The weight fades in and out in
    /// <see cref="FadeSeconds"/>. During the fade out, the direction stays, so the head does not swing back first.
    /// </summary>
    public sealed class GazeAim
    {
        public const double FadeSeconds = 0.3;

        /// <summary>The neck and the head together turn this far at most. For more, a person turns the body.</summary>
        public static readonly double HeadYawLimit = Radians(50);

        public static readonly double HeadPitchLimit = Radians(25);

        public static readonly double EyesYawLimit = Radians(12);

        public static readonly double EyesPitchLimit = Radians(8);

        /// <summary>The share of the turn of the head that the neck takes. The head takes the rest.</summary>
        private const double NeckShare = 0.4;

        /// <summary>The time constant of the move toward a new direction. It hides the steps of a camera that moves.</summary>
        private const double FollowSeconds = 0.12;

        private bool _active;
        private double _targetYaw;
        private double _targetPitch;
        private double _weight;
        private double _yaw;
        private double _pitch;

        /// <summary>The turn of the neck in this frame, in the frame of the host.</summary>
        public StageQuaternion Neck { get; private set; } = StageQuaternion.Identity;

        /// <summary>The turn of the head in this frame, in the frame of the host.</summary>
        public StageQuaternion Head { get; private set; } = StageQuaternion.Identity;

        /// <summary>Radians. A positive value turns toward +X of the frame of the host, the left of the character.</summary>
        public float EyesYaw { get; private set; }

        /// <summary>Radians. A positive value turns down.</summary>
        public float EyesPitch { get; private set; }

        /// <summary>
        /// Aims at a point. Call it in each frame, because the point and the character move.
        ///
        /// Expects:
        /// - The direction from the head to the point, in the frame of the body in Unity: +X is the right of the
        ///   character, +Y is up, and +Z is her front. The length does not matter.
        /// </summary>
        public void Aim(double x, double y, double z)
        {
            // The host frame mirrors X, so a point on her left (Unity -X) gives a positive yaw.
            double yaw = Math.Atan2(-x, z);
            double pitch = Math.Atan2(-y, Math.Sqrt((x * x) + (z * z)));

            // At no weight, the old direction does not show. So the aim starts at the new point, with no swing to it.
            if (!_active && _weight <= 0)
            {
                _yaw = yaw;
                _pitch = pitch;
            }

            _active = true;
            _targetYaw = yaw;
            _targetPitch = pitch;
        }

        /// <summary>Lets the head and the eyes return to the clips in <see cref="FadeSeconds"/>.</summary>
        public void Release()
        {
            _active = false;
        }

        /// <summary>Moves the aim by the time of this frame.</summary>
        public void Update(double deltaSeconds)
        {
            double step = deltaSeconds / FadeSeconds;
            _weight = _active ? Math.Min(1, _weight + step) : Math.Max(0, _weight - step);
            if (_active)
            {
                double amount = 1 - Math.Exp(-deltaSeconds / FollowSeconds);
                _yaw += (_targetYaw - _yaw) * amount;
                _pitch += (_targetPitch - _pitch) * amount;
            }

            double headYaw = Clamp(_yaw, HeadYawLimit);
            double headPitch = Clamp(_pitch, HeadPitchLimit);
            Neck = Turn(headYaw * NeckShare * _weight, headPitch * NeckShare * _weight);
            Head = Turn(headYaw * (1 - NeckShare) * _weight, headPitch * (1 - NeckShare) * _weight);
            EyesYaw = (float)(Clamp(_yaw - headYaw, EyesYawLimit) * _weight);
            EyesPitch = (float)(Clamp(_pitch - headPitch, EyesPitchLimit) * _weight);
        }

        /// <summary>A yaw about the vertical axis, then a pitch about the turned side axis, as a person turns the head.</summary>
        private static StageQuaternion Turn(double yaw, double pitch)
        {
            return HumanoidFrame.FromEuler(new BodyRotation(0, (float)yaw, 0))
                * HumanoidFrame.FromEuler(new BodyRotation((float)pitch, 0, 0));
        }

        private static double Clamp(double value, double limit)
        {
            return Math.Max(-limit, Math.Min(limit, value));
        }

        private static double Radians(double degrees)
        {
            return degrees * Math.PI / 180.0;
        }
    }
}
