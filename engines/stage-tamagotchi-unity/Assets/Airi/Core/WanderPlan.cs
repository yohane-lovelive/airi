using System;
using System.Collections.Generic;

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

        /// <summary>Whether a path reaches a point of the floor now, for example the stand point of a place.</summary>
        bool CanReach(StagePoint point);

        /// <summary>Whether the character can sit now. She cannot without a model, or before the sit clips load.</summary>
        bool CanSit { get; }
    }

    public enum WanderState
    {
        Rest,
        Walk,
        Attend,

        /// <summary>She goes from the stand point of a place to the spot in front of its seat, and turns to its facing.</summary>
        Approach,

        /// <summary>She sits on the seat of a place.</summary>
        Sit,

        /// <summary>She gets up, and goes back to the stand point of the place.</summary>
        Leave,
    }

    /// <summary>The change of one frame of a <see cref="WanderPlan"/>. The Stage side acts on it.</summary>
    public enum WanderChange
    {
        None,

        /// <summary>Walk to <see cref="WanderPlan.Destination"/>. For a place, it is the stand point of the place.</summary>
        StartWalk,

        /// <summary>
        /// The walk ended. Stop, and turn to the most open direction. At a place without a seat, turn to the facing of
        /// the place.
        /// </summary>
        EndWalk,

        /// <summary>The host asks for the attention of the viewer. Stop, and turn to the camera.</summary>
        StartAttend,

        /// <summary>The host released the attention.</summary>
        EndAttend,

        /// <summary>She reached the stand point of a place with a seat. Leave the NavMesh, and go to the seat.</summary>
        StartApproach,

        /// <summary>She stands in front of the seat and faces the facing of the place. Sit down.</summary>
        SitDown,

        /// <summary>The rest on the seat ended. Get up, and go back to the stand point.</summary>
        StandUp,

        /// <summary>She stands at the stand point again. Give her back to the NavMesh.</summary>
        EndSit,
    }

    /// <summary>
    /// Decides where the character goes in a room: she rests, then walks to a new place, and so on. One rest in three
    /// goes to a place of the room. There she sits on its seat, or she stands and faces it. When the host asks for the
    /// attention of the viewer, she stops, and the plan waits until the host releases her. While she sits, she stays on
    /// the seat, and only her upper body turns. During a commentary, she watches the screen of the first screen place,
    /// see <see cref="SetWatchingScreen"/>.
    ///
    /// State: the state, the time in it, the length of the rest or the sit, the destination, the place, and the
    /// activity. It has no Unity reference, so <c>dotnet</c> tests it.
    /// </summary>
    public sealed class WanderPlan
    {
        public const double MinRestSeconds = 6;
        public const double MaxRestSeconds = 20;

        /// <summary>A walk ends after this time also without arrival, for example when something blocks the path.</summary>
        public const double WalkLimitSeconds = 30;

        /// <summary>The share of the rests that go to a place.</summary>
        public const double PlaceShare = 1.0 / 3.0;

        /// <summary>A short sit looks restless, so a sit lasts at least this long.</summary>
        public const double MinSitSeconds = 20;

        public const double MaxSitSeconds = 60;

        private readonly IWanderRoom _room;
        private readonly Func<double> _random;
        private readonly IReadOnlyList<StageRoomPlace> _places;
        private double _elapsed;
        private double _restSeconds;
        private double _sitSeconds;
        private int _place = -1;
        private int _lastPlace = -1;
        private int _askedPlace = -1;

        /// <summary>The first place with the role screen, or -1. The activity of watching a screen goes there.</summary>
        private readonly int _screenPlace = -1;

        private bool _watching;

        /// <summary>The activity ended, and the next frame ends what it started.</summary>
        private bool _endActivity;

        /// <param name="random">Gives a number from 0 to 1. A test gives fixed numbers.</param>
        /// <param name="places">The places of the room, or null for a room without a list.</param>
        public WanderPlan(IWanderRoom room, Func<double> random, IReadOnlyList<StageRoomPlace> places = null)
        {
            _room = room;
            _random = random;
            _places = places ?? Array.Empty<StageRoomPlace>();
            for (int index = 0; index < _places.Count && _screenPlace < 0; index++)
            {
                if (_places[index].Role == StageRoomPlaceRole.Screen)
                {
                    _screenPlace = index;
                }
            }

            StartRest();
        }

        /// <summary>The place where she watches a screen during a commentary, or null in a room without a screen place.</summary>
        public StageRoomPlace ScreenPlace => _screenPlace >= 0 ? _places[_screenPlace] : null;

        /// <summary>Whether the activity of watching a screen goes on.</summary>
        public bool WatchingScreen => _watching;

        /// <summary>
        /// Whether she watches the screen of her place now: the activity goes on, and she sits or stands at its place.
        /// The stage then aims her head and her eyes at the screen.
        /// </summary>
        public bool LooksAtScreen => _watching && _place == _screenPlace && (State == WanderState.Sit || State == WanderState.Rest);

        public WanderState State { get; private set; }

        /// <summary>The destination of the current walk.</summary>
        public StagePoint Destination { get; private set; }

        /// <summary>The place of the current walk, rest, or sit, or null.</summary>
        public StageRoomPlace Place => _place >= 0 ? _places[_place] : null;

        /// <summary>
        /// Sends her to a place after the current rest, for example for a check of the place.
        ///
        /// Returns:
        /// - False when the room has no place of this name.
        /// </summary>
        public bool AskPlace(string name)
        {
            for (int index = 0; index < _places.Count; index++)
            {
                if (_places[index].Name == name)
                {
                    _askedPlace = index;
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Starts or ends the activity of watching a screen, for a commentary.
        ///
        /// - On a start, she goes to <see cref="ScreenPlace"/>. She gets up first from another seat. There she sits or
        ///   stands as long as the activity goes on. Rests and random walks stop, and an attention turns only her upper
        ///   body.
        /// - On an end, she gets up, or she stops her walk to the screen, and the walk through the room goes on.
        ///
        /// Returns:
        /// - False for a start in a room without a screen place. The plan then stays as it is.
        /// </summary>
        public bool SetWatchingScreen(bool watching)
        {
            if (watching && _screenPlace < 0)
            {
                return false;
            }

            _endActivity = _watching && !watching;
            _watching = watching;
            return true;
        }

        /// <summary>Ends a walk, a sit, or an attention at once, for example for a new model. She rests.</summary>
        public void Interrupt()
        {
            LeavePlace();
            StartRest();
        }

        /// <summary>
        /// Advances the plan by one frame.
        ///
        /// Returns:
        /// - The change of this frame, or <see cref="WanderChange.None"/>.
        /// </summary>
        /// <param name="arrived">
        /// Whether the character reached the end of the current move: the destination of a walk, the seat of an
        /// approach, or the stand point after a sit.
        /// </param>
        /// <param name="attention">Whether the host asks for the attention of the viewer.</param>
        public WanderChange Update(double deltaSeconds, bool arrived, bool attention)
        {
            _elapsed += deltaSeconds;
            WanderChange activityChange = FollowActivity();
            if (activityChange != WanderChange.None)
            {
                return activityChange;
            }

            // During the activity, an attention turns only her upper body. So she does not stop for it.
            bool stops = attention && !_watching;
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
                    if (stops)
                    {
                        return StartAttend();
                    }

                    if (!arrived && _elapsed < WalkLimitSeconds)
                    {
                        return WanderChange.None;
                    }

                    if (Place?.Seat != null && _room.CanSit)
                    {
                        State = WanderState.Approach;
                        _elapsed = 0;
                        return WanderChange.StartApproach;
                    }

                    StartRest();
                    return WanderChange.EndWalk;

                case WanderState.Approach:
                    if (!arrived && _elapsed < WalkLimitSeconds)
                    {
                        return WanderChange.None;
                    }

                    State = WanderState.Sit;
                    _elapsed = 0;
                    _sitSeconds = MinSitSeconds + ((MaxSitSeconds - MinSitSeconds) * _random());
                    return WanderChange.SitDown;

                case WanderState.Sit:
                    // She does not get up while she talks to the viewer, or while she watches the screen.
                    if (_elapsed < _sitSeconds || attention || _watching)
                    {
                        return WanderChange.None;
                    }

                    return StartLeave();

                case WanderState.Leave:
                    if (!arrived && _elapsed < WalkLimitSeconds)
                    {
                        return WanderChange.None;
                    }

                    // She sat long, so she walks on at once.
                    LeavePlace();
                    StartRest();
                    _restSeconds = 0;
                    return WanderChange.EndSit;

                default:
                    if (stops)
                    {
                        return StartAttend();
                    }

                    // During the activity, she rests only at the screen place, and as long as the activity goes on.
                    if (_elapsed < _restSeconds || _watching)
                    {
                        return WanderChange.None;
                    }

                    LeavePlace();
                    if (TryPickPlace(out int place))
                    {
                        _place = place;
                        return StartWalk(_places[place].Stand);
                    }

                    if (!_room.TryPickDestination(_random, out StagePoint destination))
                    {
                        // The room has no destination now, so the character rests once more.
                        StartRest();
                        return WanderChange.None;
                    }

                    return StartWalk(destination);
            }
        }

        /// <summary>Selects the asked place, or one rest in three a random place other than the last one that a path reaches.</summary>
        private bool TryPickPlace(out int place)
        {
            place = -1;
            if (_places.Count == 0)
            {
                return false;
            }

            if (_askedPlace >= 0)
            {
                int asked = _askedPlace;
                _askedPlace = -1;
                if (_room.CanReach(_places[asked].Stand))
                {
                    place = asked;
                    return true;
                }

                return false;
            }

            if (_random() >= PlaceShare)
            {
                return false;
            }

            var free = new List<int>();
            for (int index = 0; index < _places.Count; index++)
            {
                if (index != _lastPlace && _room.CanReach(_places[index].Stand))
                {
                    free.Add(index);
                }
            }

            if (free.Count == 0)
            {
                return false;
            }

            place = free[Math.Min(free.Count - 1, (int)(_random() * free.Count))];
            return true;
        }

        /// <summary>
        /// Acts on a start or an end of the activity. During the activity, she goes to the screen place from anywhere
        /// else, and from another seat she gets up first.
        ///
        /// Returns:
        /// - The change of this frame, or <see cref="WanderChange.None"/> when the usual rules go on.
        /// </summary>
        private WanderChange FollowActivity()
        {
            if (_endActivity)
            {
                _endActivity = false;
                switch (State)
                {
                    case WanderState.Approach:
                    case WanderState.Sit:
                        return StartLeave();
                    case WanderState.Walk:
                        LeavePlace();
                        StartRest();
                        return WanderChange.EndWalk;
                    case WanderState.Rest when _place >= 0:
                        // She stood at the screen, so the next walk starts at once.
                        _restSeconds = 0;
                        break;
                }

                return WanderChange.None;
            }

            if (!_watching || (_place == _screenPlace && State != WanderState.Attend) || State == WanderState.Leave)
            {
                return WanderChange.None;
            }

            if (State == WanderState.Approach || State == WanderState.Sit)
            {
                return StartLeave();
            }

            LeavePlace();
            _place = _screenPlace;
            return StartWalk(_places[_screenPlace].Stand);
        }

        /// <summary>Gets her up from a seat, or out of the step to it, and back to the stand point.</summary>
        private WanderChange StartLeave()
        {
            State = WanderState.Leave;
            _elapsed = 0;
            return WanderChange.StandUp;
        }

        private WanderChange StartWalk(StagePoint destination)
        {
            State = WanderState.Walk;
            Destination = destination;
            _elapsed = 0;
            return WanderChange.StartWalk;
        }

        /// <summary>Forgets the place, and keeps it as the last one, so the next place is another one.</summary>
        private void LeavePlace()
        {
            if (_place >= 0)
            {
                _lastPlace = _place;
                _place = -1;
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
            LeavePlace();
            State = WanderState.Attend;
            _elapsed = 0;
            return WanderChange.StartAttend;
        }
    }
}
