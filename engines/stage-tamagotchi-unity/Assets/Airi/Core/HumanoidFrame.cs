using System;

namespace Airi.Stage.Core
{
    /// <summary>A quaternion, without a dependency on UnityEngine.</summary>
    public readonly struct StageQuaternion
    {
        public readonly float X;
        public readonly float Y;
        public readonly float Z;
        public readonly float W;

        public StageQuaternion(float x, float y, float z, float w)
        {
            X = x;
            Y = y;
            Z = z;
            W = w;
        }
    }

    /// <summary>
    /// Converts rotations from the frame of the host to the frame of Unity.
    ///
    /// The host sends rotations of the normalized bones of a VRM humanoid. Its frame is right-handed
    /// with +Y up, and the model faces +Z. UniVRM keeps the model facing +Z in the left-handed frame
    /// of Unity, so the X axis is mirrored between the two frames.
    /// </summary>
    public static class HumanoidFrame
    {
        /// <summary>
        /// Converts one rotation to the frame of Unity. A mirror of the X axis keeps the X part of a
        /// quaternion and inverts the Y and Z parts.
        /// </summary>
        public static StageQuaternion ToUnity(StageQuaternion rotation)
        {
            return new StageQuaternion(rotation.X, -rotation.Y, -rotation.Z, rotation.W);
        }

        /// <summary>
        /// Gives the quaternion of Euler angles in the order XYZ, in the frame of the host. The
        /// formula is the one of <c>quaternionFromEuler</c> in <c>body-motion/pose-applier.ts</c>.
        /// </summary>
        public static StageQuaternion FromEuler(BodyRotation rotation)
        {
            double c1 = Math.Cos(rotation.X / 2.0);
            double c2 = Math.Cos(rotation.Y / 2.0);
            double c3 = Math.Cos(rotation.Z / 2.0);
            double s1 = Math.Sin(rotation.X / 2.0);
            double s2 = Math.Sin(rotation.Y / 2.0);
            double s3 = Math.Sin(rotation.Z / 2.0);

            return new StageQuaternion(
                (float)(s1 * c2 * c3 + c1 * s2 * s3),
                (float)(c1 * s2 * c3 - s1 * c2 * s3),
                (float)(c1 * c2 * s3 + s1 * s2 * c3),
                (float)(c1 * c2 * c3 - s1 * s2 * s3));
        }
    }
}
