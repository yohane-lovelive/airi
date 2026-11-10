using System;

namespace Airi.Stage.Core
{
    /// <summary>A point in the room, in world units of Unity.</summary>
    public readonly struct StagePoint
    {
        public StagePoint(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public double X { get; }

        public double Y { get; }

        public double Z { get; }
    }

    /// <summary>What a <see cref="WanderPlan"/> needs from the room. The Stage side answers with the NavMesh of Unity.</summary>
    public interface IWanderRoom
    {
        /// <summary>
        /// Selects a destination: a point of the floor of the stand point that a path reaches, at least 2 m away from
        /// the character, and at least 0.5 m from each edge.
        ///
        /// Returns:
        /// - False when the room has no such point now.
        /// </summary>
        bool TryPickDestination(Func<double> random, out StagePoint destination);
    }

    public enum WanderState
    {
        Rest,
        Walk,
        Attend,
    }

    /// <summary>The change of one frame of a <see cref="WanderPlan"/>. The Stage side acts on it.</summary>
    public enum WanderChange
    {
        None,

        /// <summary>Walk to <see cref="WanderPlan.Destination"/>.</summary>
        StartWalk,

        /// <summary>The walk ended. Stop, and turn to the most open direction.</summary>
        EndWalk,

        /// <summary>The host asks for the attention of the viewer. Stop, and turn to the camera.</summary>
        StartAttend,

        /// <summary>The host released the attention.</summary>
        EndAttend,
    }

    /// <summary>
    /// Decides where the character goes in a room: she rests, then walks to a new place, and so on. When the host
    /// asks for the attention of the viewer, she stops, and the plan waits until the host releases her.
    ///
    /// State: the state, the time in it, the length of the rest, and the destination of the walk. It has no Unity
    /// reference, so <c>dotnet</c> tests it.
    /// </summary>
    public sealed class WanderPlan
    {
        public const double MinRestSeconds = 6;
        public const double MaxRestSeconds = 20;

        /// <summary>A walk ends after this time also without arrival, for example when something blocks the path.</summary>
        public const double WalkLimitSeconds = 30;

        private readonly IWanderRoom _room;
        private readonly Func<double> _random;
        private double _elapsed;
        private double _restSeconds;

        /// <param name="random">Gives a number from 0 to 1. A test gives fixed numbers.</param>
        public WanderPlan(IWanderRoom room, Func<double> random)
        {
            _room = room;
            _random = random;
            StartRest();
        }

        public WanderState State { get; private set; }

        /// <summary>The destination of the current walk.</summary>
        public StagePoint Destination { get; private set; }

        /// <summary>
        /// Advances the plan by one frame.
        ///
        /// Returns:
        /// - The change of this frame, or <see cref="WanderChange.None"/>.
        /// </summary>
        /// <param name="arrived">Whether the character reached the destination of the walk.</param>
        /// <param name="attention">Whether the host asks for the attention of the viewer.</param>
        public WanderChange Update(double deltaSeconds, bool arrived, bool attention)
        {
            _elapsed += deltaSeconds;
            switch (State)
            {
                case WanderState.Attend:
                    if (attention)
                    {
                        return WanderChange.None;
                    }

                    StartRest();
                    return WanderChange.EndAttend;

                case WanderState.Walk:
                    if (attention)
                    {
                        return StartAttend();
                    }

                    if (!arrived && _elapsed < WalkLimitSeconds)
                    {
                        return WanderChange.None;
                    }

                    StartRest();
                    return WanderChange.EndWalk;

                default:
                    if (attention)
                    {
                        return StartAttend();
                    }

                    if (_elapsed < _restSeconds)
                    {
                        return WanderChange.None;
                    }

                    if (!_room.TryPickDestination(_random, out StagePoint destination))
                    {
                        // The room has no destination now, so the character rests once more.
                        StartRest();
                        return WanderChange.None;
                    }

                    State = WanderState.Walk;
                    Destination = destination;
                    _elapsed = 0;
                    return WanderChange.StartWalk;
            }
        }

        private void StartRest()
        {
            State = WanderState.Rest;
            _elapsed = 0;
            _restSeconds = MinRestSeconds + ((MaxRestSeconds - MinRestSeconds) * _random());
        }

        private WanderChange StartAttend()
        {
            State = WanderState.Attend;
            _elapsed = 0;
            return WanderChange.StartAttend;
        }
    }
}
