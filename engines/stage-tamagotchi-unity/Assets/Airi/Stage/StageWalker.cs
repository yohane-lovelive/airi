using System;
using System.Linq;
using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.AI;

namespace Airi.Stage
{
    /// <summary>
    /// Walks the character through a room: <see cref="WanderPlan"/> decides where she goes, and a
    /// <see cref="NavMeshAgent"/> moves the root of the avatars there over the NavMesh of the room. At a place with a
    /// seat, she leaves the NavMesh for a short step to the seat, sits there, and steps back to the stand point.
    ///
    /// Use it through the argument <c>--airi-wander</c> of the player, or the environment variable
    /// AIRI_UNITY_STAGE_WANDER=1. It needs a room with a NavMesh. This is a prototype, so the settings page has no
    /// control for it.
    ///
    /// State: the plan, the agent on the root of the avatars, the turn after a walk, and the step and the fit of a
    /// seat. The agent is off while she is away from the NavMesh.
    /// </summary>
    internal sealed class StageWalker : IWanderRoom
    {
        private const string Argument = "--airi-wander";

        /// <summary>The speed of a calm walk in a home, in meters each second.</summary>
        private const float Speed = 0.8f;

        /// <summary>The speed of the step between the stand point of a place and its seat, in meters each second.</summary>
        private const float StepSpeed = 0.5f;

        /// <summary>A step ends this near to its end, in meters.</summary>
        private const float StepArrival = 0.02f;

        /// <summary>A turn at the end of a step ends within this angle, in degrees.</summary>
        private const float TurnArrival = 1f;

        /// <summary>The turn of the body toward the next corner of the path, in degrees each second.</summary>
        private const float WalkTurnSpeed = 240f;

        /// <summary>The turn of the body after a walk, in degrees each second.</summary>
        private const float TurnSpeed = 150f;

        /// <summary>The turn of the body to the viewer, in degrees each second. A half turn takes 0.5 seconds.</summary>
        private const float AttendTurnSpeed = 360f;

        private const float MinimumDistance = 2f;
        private const float MinimumEdgeDistance = 0.5f;

        /// <summary>The distance that the search for the most open direction looks along each direction.</summary>
        private const float OpenLookDistance = 3f;

        /// <summary>The stand point of a place lies this near to the NavMesh, in meters.</summary>
        private const float ReachSearch = 0.3f;

        private const int DestinationAttempts = 30;

        private readonly Transform _root;
        private readonly NavMeshAgent _agent;
        private readonly StageRoom _room;
        private readonly StageCharacter _character;
        private readonly WanderPlan _plan;
        private readonly NavMeshPath _path = new NavMeshPath();
        private Quaternion? _turn;
        private float _walkStarted;

        /// <summary>The end of the current step off the NavMesh, or null.</summary>
        private Vector3? _step;

        /// <summary>The facing at the end of the current step, or null to keep the facing.</summary>
        private Quaternion? _stepFacing;

        private bool _stepDone;
        private float _stepSpeed;

        /// <summary>The point where she left the NavMesh. She returns there after a sit.</summary>
        private Vector3 _standPoint;

        private StageSitFit _fit;

        /// <summary>A point of the seat under her hips. The camera ignores the furniture boxes around it.</summary>
        private Vector3 _underHips;

        private StageWalker(Transform avatarRoot, StageRoom room, StageCharacter character, string placeName)
        {
            _root = avatarRoot;
            _room = room;
            _character = character;
            _agent = avatarRoot.gameObject.AddComponent<NavMeshAgent>();
            _agent.speed = Speed;
            _agent.acceleration = 2f;

            // The agent moves to any side at once. This class turns the body, and lets her walk only toward her facing.
            _agent.updateRotation = false;
            _agent.stoppingDistance = 0.15f;
            _agent.radius = 0.25f;
            _agent.height = 1.7f;
            _agent.autoBraking = true;

            // Nothing else moves in the room, so the agent needs no avoidance.
            _agent.obstacleAvoidanceType = ObstacleAvoidanceType.NoObstacleAvoidance;
            if (NavMesh.SamplePosition(avatarRoot.position, out NavMeshHit start, 1f, NavMesh.AllAreas))
            {
                _agent.Warp(start.position);
            }

            Debug.Log($"[Airi] The character starts at {Format(avatarRoot.position)}, {avatarRoot.position.y - room.Manifest.StandY:F3} m above the stand point.");
            _plan = new WanderPlan(this, () => UnityEngine.Random.value, room.Manifest.Places);
            if (placeName == null)
            {
                return;
            }

            if (_plan.AskPlace(placeName))
            {
                Debug.Log($"[Airi] The character goes to the place {placeName} after her first rest.");
            }
            else
            {
                Debug.LogWarning($"[Airi] The room has no place {placeName}. Its places are in room.json.");
            }
        }

        /// <summary>
        /// Starts the walk when the arguments or the environment ask for it.
        ///
        /// Returns:
        /// - The walker, or null when nobody asks for it, or when the room has no NavMesh. The log has the cause.
        /// </summary>
        public static StageWalker Create(string[] arguments, Transform avatarRoot, StageRoom room, StageCharacter character)
        {
            bool asked = Array.IndexOf(arguments, Argument) >= 0 || Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_WANDER") == "1";
            if (!asked)
            {
                return null;
            }

            if (room == null || !room.HasNavMesh)
            {
                Debug.LogWarning("[Airi] The character walks only in a room with a NavMesh.");
                return null;
            }

            Debug.Log("[Airi] The character walks in the room.");
            string place = StageLaunch.FindPlace(arguments, Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_PLACE"));
            return new StageWalker(avatarRoot, room, character, place);
        }

        /// <inheritdoc/>
        public bool CanSit => _character.CanSit;

        /// <summary>The place where she watches a screen during a commentary, or null. <see cref="WanderPlan.ScreenPlace"/> gives it.</summary>
        public StageRoomPlace ScreenPlace => _plan.ScreenPlace;

        /// <summary>Whether a commentary goes on.</summary>
        public bool WatchingScreen => _plan.WatchingScreen;

        /// <summary>Whether she sits on a seat now, also while she sits down or gets up.</summary>
        public bool Sits => _plan.State == WanderState.Sit && _character.SeatPhase != SeatPhase.Standing;

        /// <summary>Starts or ends the activity of watching a screen. <see cref="WanderPlan.SetWatchingScreen"/> gives the rules.</summary>
        public void SetActivity(bool watchingScreen)
        {
            if (!_plan.SetWatchingScreen(watchingScreen))
            {
                Debug.LogWarning("[Airi] The room has no screen place, so the character does not watch a screen.");
                return;
            }

            if (watchingScreen)
            {
                Debug.Log($"[Airi] Watch the screen of {_plan.ScreenPlace.Name}.");
            }
        }

        /// <summary>
        /// What a shot of the camera shows while she sits or stands at a place with a screen, or null elsewhere. The
        /// head of a sitting character lies above the hips of the fit of the seat, by the length of her body above the
        /// hips.
        /// </summary>
        public StagePlaceSubject? PlaceSubject
        {
            get
            {
                StageRoomPlace place = _plan.Place;
                if (place?.Screen == null)
                {
                    return null;
                }

                if (_plan.State == WanderState.Sit && place.Seat != null && _character.SeatPhase != SeatPhase.Standing)
                {
                    StagePoint hips = _fit.Hips;
                    var head = new StagePoint(hips.X, hips.Y + _character.HeadHeight - _character.HipHeight, hips.Z);
                    return new StagePlaceSubject(place.Name, head, place.Seat.Value, place.FacingDegrees, place.Screen);
                }

                if (_plan.State == WanderState.Rest)
                {
                    Vector3 feet = _root.position;
                    var head = new StagePoint(feet.x, feet.y + _character.HeadHeight, feet.z);
                    return new StagePlaceSubject(place.Name, head, new StagePoint(feet.x, feet.y, feet.z), place.FacingDegrees, place.Screen);
                }

                return null;
            }
        }

        /// <summary>
        /// Gives the point for her head and her eyes: the camera during an attention, or the screen of her place while
        /// she watches it.
        ///
        /// Returns:
        /// - The point, or null to let the head and the eyes follow the clips.
        /// </summary>
        public Vector3? GazeTarget(bool attention, Vector3 camera)
        {
            if (attention)
            {
                return camera;
            }

            StageRoomScreen screen = _plan.Place?.Screen;
            return _plan.LooksAtScreen && screen != null ? ToVector(screen.Center) : (Vector3?)null;
        }

        /// <summary>
        /// Advances the plan, moves the character, and gives the walk its speed. It runs once each frame.
        /// </summary>
        /// <param name="attention">Whether the host asks for the attention of the viewer.</param>
        /// <param name="camera">The place of the camera of the window. She turns her body to it during an attention.</param>
        public void Tick(float deltaSeconds, bool attention, Vector3 camera)
        {
            _stepSpeed = 0f;
            bool arrived = _plan.State switch
            {
                WanderState.Walk => !_agent.pathPending && (!_agent.hasPath || _agent.remainingDistance <= _agent.stoppingDistance),
                WanderState.Approach or WanderState.Leave => _stepDone,
                _ => false,
            };
            switch (_plan.Update(deltaSeconds, arrived, attention))
            {
                case WanderChange.StartWalk:
                    StartWalk();
                    break;
                case WanderChange.EndWalk:
                    _agent.ResetPath();
                    _turn = _plan.Place != null ? Facing(_plan.Place.FacingDegrees) : OpenDirection();
                    Debug.Log($"[Airi] Stop at {Format(_root.position)} after {Time.time - _walkStarted:F1} s{(_plan.Place != null ? $", at the place {_plan.Place.Name}" : string.Empty)}.");
                    break;
                case WanderChange.StartAttend:
                    _turn = null;
                    _agent.ResetPath();
                    Debug.Log($"[Airi] Turn to the viewer at {Format(_root.position)}.");
                    break;
                case WanderChange.EndAttend:
                    Debug.Log("[Airi] The attention of the viewer ends.");
                    break;
                case WanderChange.StartApproach:
                    StartApproach(_plan.Place);
                    break;
                case WanderChange.SitDown:
                    _room.SetSeatBox(_underHips);
                    if (_character.Sit())
                    {
                        Debug.Log($"[Airi] Sit down on {_plan.Place.Name}.");
                    }
                    else
                    {
                        Debug.LogWarning($"[Airi] The character cannot sit on {_plan.Place.Name} now, so she stands in front of it.");
                    }

                    break;
                case WanderChange.StandUp:
                    _character.StandUp();
                    _step = _standPoint;
                    _stepFacing = null;
                    _stepDone = false;
                    Debug.Log($"[Airi] Get up from {_plan.Place.Name}.");
                    break;
                case WanderChange.EndSit:
                    ReturnToNavMesh();
                    Debug.Log($"[Airi] Back on the NavMesh at {Format(_root.position)}.");
                    break;
            }

            switch (_plan.State)
            {
                case WanderState.Walk:
                    if (_agent.hasPath)
                    {
                        FaceSteeringTarget(deltaSeconds);
                    }

                    break;
                case WanderState.Attend:
                    Face(camera, AttendTurnSpeed * deltaSeconds);
                    break;
                case WanderState.Approach:
                    Step(deltaSeconds);
                    break;
                case WanderState.Sit:
                    Seat();
                    break;
                case WanderState.Leave:
                    // She steps back only after the exit clip.
                    if (_character.SeatPhase == SeatPhase.Standing)
                    {
                        Step(deltaSeconds);
                    }
                    else
                    {
                        Seat();
                    }

                    break;
            }

            if (_turn != null)
            {
                _root.rotation = Quaternion.RotateTowards(_root.rotation, _turn.Value, TurnSpeed * deltaSeconds);
                if (Quaternion.Angle(_root.rotation, _turn.Value) < 0.5f)
                {
                    _turn = null;
                }
            }

            // During the activity, she does not stop for the viewer, so only her upper body turns.
            bool offNavMesh = _plan.State == WanderState.Approach || _plan.State == WanderState.Sit || _plan.State == WanderState.Leave;
            _character.SetBodyFixed(offNavMesh || _plan.WatchingScreen);
            _character.SetTalking(attention && _plan.State == WanderState.Sit);
            _character.Move(_agent.enabled ? _agent.velocity.magnitude : _stepSpeed);
        }

        /// <summary>
        /// Puts her back on the NavMesh at once after a new model, when she sits or steps to a seat. A new model
        /// stands at once, so it must not stand in the seat.
        ///
        /// Returns:
        /// - The move of the root, so the framing of the new model can follow it.
        /// </summary>
        public Vector3 ModelChanged()
        {
            if (_agent.enabled)
            {
                return Vector3.zero;
            }

            Vector3 before = _root.position;
            ReturnToNavMesh();
            _plan.Interrupt();
            Debug.Log($"[Airi] A new model stands at {Format(_root.position)}, the stand point of the place.");
            return _root.position - before;
        }

        /// <inheritdoc/>
        public bool TryPickDestination(Func<double> random, out StagePoint destination)
        {
            StageRoomManifest manifest = _room.Manifest;
            StageRoomBox box = manifest.Box;
            Vector3 from = _root.position;
            for (int attempt = 0; attempt < DestinationAttempts; attempt++)
            {
                var point = new Vector3(
                    (float)(box.MinX + (random() * (box.MaxX - box.MinX))),
                    (float)manifest.StandY,
                    (float)(box.MinZ + (random() * (box.MaxZ - box.MinZ))));
                if (!NavMesh.SamplePosition(point, out NavMeshHit hit, 0.5f, NavMesh.AllAreas)
                    || Mathf.Abs(hit.position.y - (float)manifest.StandY) > StageRoomManifest.SameFloor
                    || Vector3.Distance(hit.position, from) < MinimumDistance
                    || !NavMesh.FindClosestEdge(hit.position, out NavMeshHit edge, NavMesh.AllAreas)
                    || edge.distance < MinimumEdgeDistance
                    || !NavMesh.CalculatePath(from, hit.position, NavMesh.AllAreas, _path)
                    || _path.status != NavMeshPathStatus.PathComplete)
                {
                    continue;
                }

                destination = new StagePoint(hit.position.x, hit.position.y, hit.position.z);
                return true;
            }

            destination = default;
            return false;
        }

        /// <inheritdoc/>
        public bool CanReach(StagePoint point)
        {
            return _agent.enabled
                && NavMesh.SamplePosition(ToVector(point), out NavMeshHit hit, ReachSearch, NavMesh.AllAreas)
                && NavMesh.CalculatePath(_root.position, hit.position, NavMesh.AllAreas, _path)
                && _path.status == NavMeshPathStatus.PathComplete;
        }

        private void StartWalk()
        {
            _turn = null;
            _walkStarted = Time.time;
            Vector3 destination = ToVector(_plan.Destination);
            _agent.SetDestination(destination);
            NavMesh.CalculatePath(_root.position, destination, NavMesh.AllAreas, _path);
            string place = _plan.Place != null ? $", the stand point of {_plan.Place.Name}" : string.Empty;
            Debug.Log($"[Airi] Walk from {Format(_root.position)} to {Format(destination)}{place} through {string.Join(" ", _path.corners.Select(Format))}.");
        }

        /// <summary>
        /// Leaves the NavMesh at the stand point of a place, and starts the step to the seat. The fit of the seat gives
        /// the end of the step: the point where her feet stand before she sits.
        /// </summary>
        private void StartApproach(StageRoomPlace place)
        {
            StagePoint seat = place.Seat.Value;
            Vector3 hips = _character.SeatedHips;
            float floor = _root.position.y;
            _fit = StageSit.Fit(seat, place.FacingDegrees, floor, _character.HipHeight, _character.ThighLength, hips.x, hips.y, hips.z);

            Quaternion facing = Facing(place.FacingDegrees);

            // The box of a cushion can end under her hip joints, so the point lies just under the seat.
            _underHips = new Vector3((float)_fit.Hips.X, (float)seat.Y - 0.02f, (float)_fit.Hips.Z);
            _standPoint = _root.position;
            _agent.ResetPath();
            _agent.enabled = false;
            _turn = null;
            _step = new Vector3((float)_fit.Root.X, floor, (float)_fit.Root.Z);
            _stepFacing = facing;
            _stepDone = false;

            string hipsGap = _fit.HipsGap > 0 ? $" Her legs are long, so her hips stay {_fit.HipsGap:F2} m above the seat." : string.Empty;
            Debug.Log($"[Airi] Step {Vector3.Distance(_standPoint, _step.Value):F2} m to the seat of {place.Name}, from {Format(_standPoint)} to {Format(_step.Value)}. While she sits, her feet are {_fit.Lift:+0.00;-0.00} m above the floor.{hipsGap}");
        }

        /// <summary>Gives her back to the NavMesh at the point where she left it.</summary>
        private void ReturnToNavMesh()
        {
            _room.SetSeatBox(null);
            _root.position = _standPoint;
            _agent.enabled = true;
            _agent.Warp(_standPoint);
            _step = null;
        }

        /// <summary>
        /// Moves her along the step off the NavMesh. She turns toward the end first, as in a walk, and turns to the
        /// facing of the step at its end.
        /// </summary>
        private void Step(float deltaSeconds)
        {
            if (_step == null || _stepDone)
            {
                return;
            }

            Vector3 toward = _step.Value - _root.position;
            toward.y = 0f;
            float distance = toward.magnitude;
            if (distance > StepArrival)
            {
                Vector3 direction = toward / distance;
                _root.rotation = Quaternion.RotateTowards(_root.rotation, Quaternion.LookRotation(direction, Vector3.up), WalkTurnSpeed * deltaSeconds);
                float speed = StepSpeed * Mathf.Clamp01(Vector3.Dot(_root.forward, direction));
                float move = Mathf.Min(distance, speed * deltaSeconds);
                _root.position += direction * move;
                _stepSpeed = deltaSeconds > 0f ? move / deltaSeconds : 0f;
                return;
            }

            if (_stepFacing == null)
            {
                _stepDone = true;
                return;
            }

            _root.rotation = Quaternion.RotateTowards(_root.rotation, _stepFacing.Value, TurnSpeed * deltaSeconds);
            if (Quaternion.Angle(_root.rotation, _stepFacing.Value) < TurnArrival)
            {
                _root.rotation = _stepFacing.Value;
                _stepDone = true;
            }
        }

        /// <summary>Lifts or lowers the root as far as she sat down, so her hips land on the seat.</summary>
        private void Seat()
        {
            Vector3 position = _root.position;
            position.y = _standPoint.y + ((float)_fit.Lift * _character.SeatDepth);
            _root.position = position;
        }

        /// <summary>
        /// Turns the body to the next corner of the path. The speed follows the facing, so at the start of a walk she
        /// turns first, and she does not slide to the side.
        /// </summary>
        private void FaceSteeringTarget(float deltaSeconds)
        {
            Vector3 toward = _agent.steeringTarget - _root.position;
            toward.y = 0f;
            if (toward.sqrMagnitude < 0.0001f)
            {
                return;
            }

            toward.Normalize();
            _root.rotation = Quaternion.RotateTowards(_root.rotation, Quaternion.LookRotation(toward, Vector3.up), WalkTurnSpeed * deltaSeconds);
            _agent.speed = Speed * Mathf.Clamp01(Vector3.Dot(_root.forward, toward));
        }

        /// <summary>Turns the body about the vertical axis toward a point. The camera follows her, so the point moves.</summary>
        private void Face(Vector3 point, float maxDegrees)
        {
            Vector3 toward = point - _root.position;
            toward.y = 0f;
            if (toward.sqrMagnitude < 0.0001f)
            {
                return;
            }

            _root.rotation = Quaternion.RotateTowards(_root.rotation, Quaternion.LookRotation(toward, Vector3.up), maxDegrees);
        }

        /// <summary>Finds the direction with the most free floor in front, out of eight, so she does not face a wall.</summary>
        private Quaternion OpenDirection()
        {
            Vector3 from = _root.position;
            Vector3 best = _root.forward;
            float bestDistance = -1f;
            foreach (float degrees in Enumerable.Range(0, 8).Select(index => index * 45f))
            {
                Vector3 direction = Quaternion.Euler(0f, degrees, 0f) * Vector3.forward;
                float distance = NavMesh.Raycast(from, from + (direction * OpenLookDistance), out NavMeshHit hit, NavMesh.AllAreas) ? hit.distance : OpenLookDistance;
                if (distance > bestDistance)
                {
                    bestDistance = distance;
                    best = direction;
                }
            }

            return Quaternion.LookRotation(best, Vector3.up);
        }

        /// <summary>The rotation of a facing of the room file: 0 is +Z, and 90 is +X.</summary>
        private static Quaternion Facing(double degrees)
        {
            return Quaternion.Euler(0f, (float)degrees, 0f);
        }

        private static Vector3 ToVector(StagePoint point)
        {
            return new Vector3((float)point.X, (float)point.Y, (float)point.Z);
        }

        private static string Format(Vector3 point)
        {
            return $"({point.x:F2}, {point.z:F2})";
        }
    }
}
