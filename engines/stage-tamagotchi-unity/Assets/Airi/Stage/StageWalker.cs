using System;
using System.Linq;
using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.AI;

namespace Airi.Stage
{
    /// <summary>
    /// Walks the character through a room: <see cref="WanderPlan"/> decides where she goes, and a
    /// <see cref="NavMeshAgent"/> moves the root of the avatars there over the NavMesh of the room.
    ///
    /// Use it through the argument <c>--airi-wander</c> of the player, or the environment variable
    /// AIRI_UNITY_STAGE_WANDER=1. It needs a room with a NavMesh. This is a prototype, so the settings page has no
    /// control for it.
    ///
    /// State: the plan, the agent on the root of the avatars, and the turn after a walk.
    /// </summary>
    internal sealed class StageWalker : IWanderRoom
    {
        private const string Argument = "--airi-wander";

        /// <summary>The speed of a calm walk in a home, in meters each second.</summary>
        private const float Speed = 0.8f;

        /// <summary>The turn of the body toward the next corner of the path, in degrees each second.</summary>
        private const float WalkTurnSpeed = 240f;

        /// <summary>The turn of the body after a walk, in degrees each second.</summary>
        private const float TurnSpeed = 150f;

        private const float MinimumDistance = 2f;
        private const float MinimumEdgeDistance = 0.5f;

        /// <summary>The distance that the search for the most open direction looks along each direction.</summary>
        private const float OpenLookDistance = 3f;

        private const int DestinationAttempts = 30;

        private readonly Transform _root;
        private readonly NavMeshAgent _agent;
        private readonly StageRoomManifest _room;
        private readonly WanderPlan _plan;
        private readonly NavMeshPath _path = new NavMeshPath();
        private Quaternion? _turn;
        private float _walkStarted;

        private StageWalker(Transform avatarRoot, StageRoomManifest room)
        {
            _root = avatarRoot;
            _room = room;
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

            Debug.Log($"[Airi] The character starts at {Format(avatarRoot.position)}, {avatarRoot.position.y - room.StandY:F3} m above the stand point.");
            _plan = new WanderPlan(this, () => UnityEngine.Random.value);
        }

        /// <summary>
        /// Starts the walk when the arguments or the environment ask for it.
        ///
        /// Returns:
        /// - The walker, or null when nobody asks for it, or when the room has no NavMesh. The log has the cause.
        /// </summary>
        public static StageWalker Create(string[] arguments, Transform avatarRoot, StageRoom room)
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
            return new StageWalker(avatarRoot, room.Manifest);
        }

        /// <summary>Advances the plan, moves the character, and gives the walk its speed. It runs once each frame.</summary>
        public void Tick(float deltaSeconds, StageCharacter character)
        {
            bool arrived = _plan.State == WanderState.Walk && !_agent.pathPending && (!_agent.hasPath || _agent.remainingDistance <= _agent.stoppingDistance);
            switch (_plan.Update(deltaSeconds, arrived, false))
            {
                case WanderChange.StartWalk:
                    _turn = null;
                    _walkStarted = Time.time;
                    Vector3 destination = ToVector(_plan.Destination);
                    _agent.SetDestination(destination);

                    // The search for the destination computed this path in this frame.
                    Debug.Log($"[Airi] Walk from {Format(_root.position)} to {Format(destination)} through {string.Join(" ", _path.corners.Select(Format))}.");
                    break;
                case WanderChange.EndWalk:
                    _agent.ResetPath();
                    _turn = OpenDirection();
                    Debug.Log($"[Airi] Stop at {Format(_root.position)} after {Time.time - _walkStarted:F1} s.");
                    break;
                case WanderChange.StartAttend:
                    _turn = null;
                    _agent.ResetPath();
                    break;
            }

            if (_plan.State == WanderState.Walk && _agent.hasPath)
            {
                FaceSteeringTarget(deltaSeconds);
            }

            if (_turn != null)
            {
                _root.rotation = Quaternion.RotateTowards(_root.rotation, _turn.Value, TurnSpeed * deltaSeconds);
                if (Quaternion.Angle(_root.rotation, _turn.Value) < 0.5f)
                {
                    _turn = null;
                }
            }

            character.Move(_agent.velocity.magnitude);
        }

        /// <inheritdoc/>
        public bool TryPickDestination(Func<double> random, out StagePoint destination)
        {
            StageRoomBox box = _room.Box;
            Vector3 from = _root.position;
            for (int attempt = 0; attempt < DestinationAttempts; attempt++)
            {
                var point = new Vector3(
                    (float)(box.MinX + (random() * (box.MaxX - box.MinX))),
                    (float)_room.StandY,
                    (float)(box.MinZ + (random() * (box.MaxZ - box.MinZ))));
                if (!NavMesh.SamplePosition(point, out NavMeshHit hit, 0.5f, NavMesh.AllAreas)
                    || Mathf.Abs(hit.position.y - (float)_room.StandY) > StageRoomManifest.SameFloor
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
