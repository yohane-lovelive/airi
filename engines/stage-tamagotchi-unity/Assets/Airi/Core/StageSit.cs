using System;

namespace Airi.Stage.Core
{
    /// <summary>Where the root of the avatar stands while she sits on a seat. <see cref="StageSit.Fit"/> computes it.</summary>
    public readonly struct StageSitFit
    {
        public StageSitFit(StagePoint root, StagePoint hips, double lift, double hipsGap)
        {
            Root = root;
            Hips = hips;
            Lift = lift;
            HipsGap = hipsGap;
        }

        /// <summary>The root while she sits. Before she sits, she stands here on the floor, under this point.</summary>
        public StagePoint Root { get; }

        /// <summary>The place of her hip joints on the seat.</summary>
        public StagePoint Hips { get; }

        /// <summary>The height of the root over the floor while she sits. Above 0 her feet hang, and below 0 they sink.</summary>
        public double Lift { get; }

        /// <summary>The height of her hips over their place on the seat. It is above 0 only when long legs reach the sink limit.</summary>
        public double HipsGap { get; }
    }

    /// <summary>
    /// Fits a sitting character to a seat of a room. The seat point is the middle of the front edge of the seat, and her
    /// knees go a little in front of it. So her hips go behind it by the length of her thighs less that margin, and a
    /// little above the seat. A model with short legs lets her feet hang, and a model with long legs lets them sink a
    /// little. The stage has no IK of the feet.
    /// </summary>
    public static class StageSit
    {
        /// <summary>The hip joints lie above the seat by this share of the hip height, for the flesh under them.</summary>
        public const double SeatClearance = 0.12;

        /// <summary>
        /// The knee joints lie this far in front of the front edge, in meters. On the edge, the back of the calves goes
        /// into the front of a sofa.
        /// </summary>
        public const double KneeClearance = 0.08;

        /// <summary>
        /// Her feet sink at most this far under the floor, in meters, about the sole of a shoe. A shoe is low, so a
        /// deeper sink hides it. Longer legs lift her hips above the seat, for example on a low bed.
        /// </summary>
        public const double DeepestSink = 0.02;

        /// <summary>
        /// Computes where the root of the avatar goes while she sits.
        ///
        /// Expects:
        /// - The facing in degrees, as in the room file: 0 is +Z, and 90 is +X.
        /// - The hips of the sit loop from the root, in meters, in the frame of her body: to her right, up, and to her
        ///   front.
        /// </summary>
        /// <param name="seat">The seat point of the place.</param>
        /// <param name="floorY">The height of the floor under her feet.</param>
        /// <param name="hipHeight">The height of her hips in the rest pose, in meters.</param>
        /// <param name="thighLength">The length from her hip joint to her knee, in meters.</param>
        public static StageSitFit Fit(
            StagePoint seat,
            double facingDegrees,
            double floorY,
            double hipHeight,
            double thighLength,
            double hipsRight,
            double hipsUp,
            double hipsForward)
        {
            double radians = facingDegrees * Math.PI / 180.0;
            double forwardX = Math.Sin(radians);
            double forwardZ = Math.Cos(radians);

            // The right of a body that faces +Z is +X in Unity. A turn of the facing turns it too.
            double rightX = forwardZ;
            double rightZ = -forwardX;

            double back = Math.Max(0, thighLength - KneeClearance);
            double hipsX = seat.X - (forwardX * back);
            double hipsZ = seat.Z - (forwardZ * back);
            double hipsY = seat.Y + (SeatClearance * hipHeight);

            double lift = hipsY - hipsUp - floorY;
            double gap = 0;
            if (lift < -DeepestSink)
            {
                gap = -DeepestSink - lift;
                lift = -DeepestSink;
            }

            var root = new StagePoint(
                hipsX - (rightX * hipsRight) - (forwardX * hipsForward),
                floorY + lift,
                hipsZ - (rightZ * hipsRight) - (forwardZ * hipsForward));
            return new StageSitFit(root, new StagePoint(hipsX, hipsY + gap, hipsZ), lift, gap);
        }
    }
}
