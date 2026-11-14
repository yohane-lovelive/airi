using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Follows the frame stream of the host, 30 times each second, at the rate of the display.
    ///
    /// The values move smoothly toward the newest frame. If no frame arrives for
    /// <see cref="DeadlineSeconds"/>, they fade to zero. So a throttled renderer or a stopped app does
    /// not freeze the character with an open mouth.
    /// </summary>
    public sealed class FrameFollower
    {
        /// <summary>The time without a frame before the fade starts.</summary>
        public const float DeadlineSeconds = 0.5f;

        /// <summary>The time constant of the move toward a frame. It hides the steps of the 30 Hz stream.</summary>
        private const float FollowSeconds = 0.04f;

        /// <summary>The time constant of the fade after the deadline.</summary>
        private const float FadeSeconds = 0.15f;

        /// <summary>A vowel above this weight means that lip sync owns the mouth, as in <c>useVRMLipSync</c>.</summary>
        private const float MouthBusyWeight = 0.01f;

        private static readonly MouthWeights ClosedMouth = new MouthWeights(0, 0, 0, 0, 0);
        private static readonly BodyRotation Rest = new BodyRotation(0, 0, 0);

        private CharacterFrameMessage _target;
        private float _age;

        public MouthWeights Mouth { get; private set; } = ClosedMouth;

        public BodyRotation Spine { get; private set; } = Rest;

        public BodyRotation Chest { get; private set; } = Rest;

        public BodyRotation Neck { get; private set; } = Rest;

        public BodyRotation Head { get; private set; } = Rest;

        public float EyesYaw { get; private set; }

        public float EyesPitch { get; private set; }

        public bool MouthBusy =>
            Mouth.A > MouthBusyWeight
            || Mouth.E > MouthBusyWeight
            || Mouth.I > MouthBusyWeight
            || Mouth.O > MouthBusyWeight
            || Mouth.U > MouthBusyWeight;

        public void Receive(CharacterFrameMessage frame)
        {
            _target = frame;
            _age = 0;
        }

        /// <summary>Moves the values by the time of this frame.</summary>
        public void Update(float deltaSeconds)
        {
            _age += deltaSeconds;
            bool expired = _target == null || _age >= DeadlineSeconds;
            float amount = 1f - (float)Math.Exp(-deltaSeconds / (expired ? FadeSeconds : FollowSeconds));

            MouthWeights mouth = expired ? ClosedMouth : _target.Mouth;
            Mouth = new MouthWeights(
                Follow(Mouth.A, mouth.A, amount),
                Follow(Mouth.E, mouth.E, amount),
                Follow(Mouth.I, mouth.I, amount),
                Follow(Mouth.O, mouth.O, amount),
                Follow(Mouth.U, mouth.U, amount));

            Spine = Follow(Spine, expired ? Rest : _target.Spine, amount);
            Chest = Follow(Chest, expired ? Rest : _target.Chest, amount);
            Neck = Follow(Neck, expired ? Rest : _target.Neck, amount);
            Head = Follow(Head, expired ? Rest : _target.Head, amount);
            EyesYaw = Follow(EyesYaw, expired ? 0 : _target.EyesYaw, amount);
            EyesPitch = Follow(EyesPitch, expired ? 0 : _target.EyesPitch, amount);
        }

        private static BodyRotation Follow(BodyRotation current, BodyRotation target, float amount)
        {
            return new BodyRotation(
                Follow(current.X, target.X, amount),
                Follow(current.Y, target.Y, amount),
                Follow(current.Z, target.Z, amount));
        }

        private static float Follow(float current, float target, float amount)
        {
            return current + (target - current) * amount;
        }
    }
}
