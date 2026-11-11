using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Smooths the camera of a window while the character walks through a room.
    ///
    /// - The target follows the move of the avatar with a short delay, so the start and the end of a walk do not jerk the
    ///   view.
    /// - A wall that comes between the camera and its target pulls the camera in at once, so no frame shows the wall. When
    ///   the wall goes, the camera returns slowly, so it does not swing back and forth in a narrow corridor.
    /// - A wall that leaves too little room swings the camera around her, to the nearest side with room. A side far
    ///   around her takes a cut instead. When the angle of the owner has room again for a while, the camera returns.
    ///
    /// State: the smoothed move of the target, the distance of the camera from the target, and the swing. <c>WindowOutput</c>
    /// gives it the move of the avatar and the free space that sphere casts find. It has no Unity type, so dotnet tests it.
    /// </summary>
    public sealed class StageCameraFollow
    {
        /// <summary>Below this share of the framed distance, the camera is too near, and it looks for another side.</summary>
        public const double CrampedShare = 0.6;

        /// <summary>A side with this share of the framed distance shows her well.</summary>
        public const double ClearShare = 0.9;

        /// <summary>The sides that the camera tries: steps of this many degrees to the left and the right.</summary>
        public const double SwingStepDegrees = 20;

        /// <summary>The camera goes at most this far around her. More turns the view against the angle of the owner.</summary>
        public const double LargestSwingDegrees = 120;

        /// <summary>The fastest swing, in degrees each second.</summary>
        public const double SwingDegreesPerSecond = 90;

        /// <summary>The time constant of a swing. It starts and ends softly.</summary>
        public const double SwingSeconds = 0.4;

        /// <summary>The angle of the owner must have room this long before the camera swings back. It stops a hunt at a door.</summary>
        public const double ReturnDelaySeconds = 1;

        /// <summary>
        /// A larger turn cuts to the new side at once, as a cut between two cameras. The angles between two sides of a
        /// corridor face its walls, so a swing through them shows only a part of her for a second or two.
        /// </summary>
        public const double CutDegrees = 45;

        /// <summary>Without a clear side, another side must be this much better, so two similar sides do not trade places.</summary>
        private const double BetterShare = 0.1;

        private double _swingGoal;
        private double _ownerClearSeconds;
        /// <summary>The time constant of the target. A walk of 0.8 m/s leaves the target 0.2 m behind.</summary>
        public const double FollowSeconds = 0.25;

        /// <summary>The time constant of the return of the camera after a wall.</summary>
        public const double ReturnSeconds = 0.5;

        /// <summary>A wall does not pull the camera nearer than this to its target. Nearer, the camera is in her body.</summary>
        public const double NearestDistance = 0.3;

        private double? _distance;

        public double TargetX { get; private set; }

        public double TargetY { get; private set; }

        public double TargetZ { get; private set; }

        /// <summary>The turn of the camera around her on top of the angle of the owner, in degrees.</summary>
        public double SwingDegrees { get; private set; }

        /// <summary>Puts the target on the avatar at once, and forgets the walls and the swing. A new model calls it.</summary>
        public void Reset(double x, double y, double z)
        {
            TargetX = x;
            TargetY = y;
            TargetZ = z;
            _distance = null;
            SwingDegrees = 0;
            _swingGoal = 0;
            _ownerClearSeconds = 0;
        }

        /// <summary>
        /// Swings the camera around her when a wall leaves too little room, by the time of this frame.
        ///
        /// Expects:
        /// - <paramref name="roomAt"/>: for a turn in degrees on top of the angle of the owner, the share of the framed
        ///   distance that the camera keeps in front of the walls, from 0 to 1. Each call costs a sphere cast.
        /// - <paramref name="held"/>: true while the owner drags the camera. The swing then waits, so the camera stays
        ///   under the mouse.
        /// </summary>
        public void Swing(double deltaSeconds, Func<double, double> roomAt, bool held)
        {
            if (held)
            {
                return;
            }

            double goalRoom = roomAt(_swingGoal);
            if (_swingGoal != 0)
            {
                _ownerClearSeconds = roomAt(0) >= ClearShare ? _ownerClearSeconds + deltaSeconds : 0;
                if (_ownerClearSeconds >= ReturnDelaySeconds)
                {
                    _swingGoal = 0;
                    _ownerClearSeconds = 0;
                    goalRoom = 1;
                }
            }

            if (goalRoom < CrampedShare)
            {
                _swingGoal = FindSide(roomAt, goalRoom);
            }

            double gap = _swingGoal - SwingDegrees;
            if (Math.Abs(gap) > CutDegrees)
            {
                // The new side has room, so the camera also takes its whole distance at once.
                SwingDegrees = _swingGoal;
                _distance = null;
                return;
            }

            double step = Math.Min(Math.Abs(gap) * (1 - Math.Exp(-deltaSeconds / SwingSeconds)), SwingDegreesPerSecond * deltaSeconds);
            SwingDegrees += Math.Sign(gap) * step;
        }

        /// <summary>
        /// Finds a side with room. The angle of the owner wins when it has room. Otherwise the camera takes the middle of
        /// a span of sides with room, so a step of her does not close it again. A wide span wins over one side, and then
        /// the span nearest to the camera wins, so the view moves little. Without a side with room, the side with the
        /// most room wins.
        /// </summary>
        private double FindSide(Func<double, double> roomAt, double goalRoom)
        {
            int steps = (int)(LargestSwingDegrees / SwingStepDegrees);
            var rooms = new double[(2 * steps) + 1];
            for (int index = 0; index < rooms.Length; index++)
            {
                rooms[index] = roomAt((index - steps) * SwingStepDegrees);
            }

            if (rooms[steps] >= ClearShare)
            {
                return 0;
            }

            double? spanMiddle = null;
            bool spanWide = false;
            for (int start = 0; start < rooms.Length; start++)
            {
                if (rooms[start] < ClearShare)
                {
                    continue;
                }

                int end = start;
                while (end + 1 < rooms.Length && rooms[end + 1] >= ClearShare)
                {
                    end++;
                }

                double middle = ((start + end) / 2.0 - steps) * SwingStepDegrees;
                bool wide = end > start;
                if (spanMiddle == null
                    || (wide && !spanWide)
                    || (wide == spanWide && Math.Abs(middle - SwingDegrees) < Math.Abs(spanMiddle.Value - SwingDegrees)))
                {
                    spanMiddle = middle;
                    spanWide = wide;
                }

                start = end;
            }

            if (spanMiddle != null)
            {
                return spanMiddle.Value;
            }

            double best = _swingGoal;
            double bestRoom = goalRoom;
            for (int index = 0; index < rooms.Length; index++)
            {
                if (rooms[index] > bestRoom + BetterShare)
                {
                    best = (index - steps) * SwingStepDegrees;
                    bestRoom = rooms[index];
                }
            }

            return best;
        }

        /// <summary>Moves the target toward the move of the avatar since its framing, by the time of this frame.</summary>
        public void FollowTarget(double deltaSeconds, double x, double y, double z)
        {
            double amount = 1 - Math.Exp(-deltaSeconds / FollowSeconds);
            TargetX += (x - TargetX) * amount;
            TargetY += (y - TargetY) * amount;
            TargetZ += (z - TargetZ) * amount;
        }

        /// <summary>
        /// Gives the distance of the camera from its target in this frame.
        ///
        /// Expects:
        /// - <paramref name="framed"/>: the distance of the framing of the owner.
        /// - <paramref name="free"/>: how far the camera can go from the target before it meets a wall. Without a wall, it
        ///   is the framed distance or more.
        /// </summary>
        public double KeepClear(double deltaSeconds, double framed, double free)
        {
            // A framing nearer than the nearest distance stays, because the owner chose it.
            double limit = Math.Min(framed, Math.Max(NearestDistance, free));
            double distance = _distance ?? limit;
            if (limit < distance)
            {
                distance = limit;
            }
            else
            {
                distance += (limit - distance) * (1 - Math.Exp(-deltaSeconds / ReturnSeconds));
            }

            _distance = distance;
            return distance;
        }
    }
}
