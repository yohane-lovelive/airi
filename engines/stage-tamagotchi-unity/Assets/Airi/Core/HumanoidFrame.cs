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

        public static readonly StageQuaternion Identity = new StageQuaternion(0f, 0f, 0f, 1f);

        public StageQuaternion(float x, float y, float z, float w)
        {
            X = x;
            Y = y;
            Z = z;
            W = w;
        }

        public static StageQuaternion operator *(StageQuaternion a, StageQuaternion b)
        {
            return new StageQuaternion(
                a.X * b.W + a.W * b.X + a.Y * b.Z - a.Z * b.Y,
                a.Y * b.W + a.W * b.Y + a.Z * b.X - a.X * b.Z,
                a.Z * b.W + a.W * b.Z + a.X * b.Y - a.Y * b.X,
                a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z);
        }

        /// <summary>The inverse of a rotation. A rotation has a length of 1.</summary>
        public StageQuaternion Inverse()
        {
            return new StageQuaternion(-X, -Y, -Z, W);
        }

        /// <summary>The same rotation with a length of 1. A rotation of no length stays identity.</summary>
        public StageQuaternion Normalized()
        {
            double length = Math.Sqrt(X * X + Y * Y + Z * Z + W * W);
            if (length < 1e-9)
            {
                return Identity;
            }

            return new StageQuaternion((float)(X / length), (float)(Y / length), (float)(Z / length), (float)(W / length));
        }

        /// <summary>The rotation between two rotations, on the shorter way.</summary>
        public static StageQuaternion Slerp(StageQuaternion a, StageQuaternion b, float t)
        {
            double dot = a.X * b.X + a.Y * b.Y + a.Z * b.Z + a.W * b.W;
            double sign = 1.0;
            if (dot < 0)
            {
                dot = -dot;
                sign = -1.0;
            }

            double fromA;
            double fromB;
            if (dot > 0.9995)
            {
                fromA = 1.0 - t;
                fromB = t;
            }
            else
            {
                double angle = Math.Acos(dot);
                double sine = Math.Sin(angle);
                fromA = Math.Sin((1.0 - t) * angle) / sine;
                fromB = Math.Sin(t * angle) / sine;
            }

            fromB *= sign;
            double x = fromA * a.X + fromB * b.X;
            double y = fromA * a.Y + fromB * b.Y;
            double z = fromA * a.Z + fromB * b.Z;
            double w = fromA * a.W + fromB * b.W;
            double length = Math.Sqrt(x * x + y * y + z * z + w * w);
            return new StageQuaternion((float)(x / length), (float)(y / length), (float)(z / length), (float)(w / length));
        }

        /// <summary>
        /// The rotation that turns one direction into another. Both directions have a length of 1.
        /// The formula is the one of <c>Quaternion.setFromUnitVectors</c> of three.js.
        /// </summary>
        public static StageQuaternion FromUnitVectors(float fromX, float fromY, float fromZ, float toX, float toY, float toZ)
        {
            double r = fromX * toX + fromY * toY + fromZ * toZ + 1.0;
            double x;
            double y;
            double z;
            if (r < 1e-6)
            {
                // The directions are opposite, so any axis at a right angle to them works.
                r = 0;
                if (Math.Abs(fromX) > Math.Abs(fromZ))
                {
                    x = -fromY;
                    y = fromX;
                    z = 0;
                }
                else
                {
                    x = 0;
                    y = -fromZ;
                    z = fromY;
                }
            }
            else
            {
                x = fromY * toZ - fromZ * toY;
                y = fromZ * toX - fromX * toZ;
                z = fromX * toY - fromY * toX;
            }

            double length = Math.Sqrt(x * x + y * y + z * z + r * r);
            return new StageQuaternion((float)(x / length), (float)(y / length), (float)(z / length), (float)(r / length));
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
