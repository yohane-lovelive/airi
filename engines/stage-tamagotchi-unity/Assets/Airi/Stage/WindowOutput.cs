using System;
using Airi.Stage.Core;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// One normal camera in a normal window. The owner moves it with the mouse and the keys:
    ///
    /// - Left drag: goes around the character.
    /// - Right drag: moves across the view.
    /// - Wheel: comes closer or goes back.
    /// - Keys 1, 2, and 3: the full body, the upper body, and the face.
    /// - Double click: back to the full body.
    ///
    /// State: the camera of <see cref="StageCameraRig"/>, the smoothing of <see cref="StageCameraFollow"/>, and the
    /// drag that runs now. The camera returns at the next start, because it is in <see cref="PlayerPrefs"/>. The
    /// argument <c>--airi-camera=</c> fixes the camera instead, so a capture has no saved camera and no stray click in it.
    ///
    /// In a room, a sphere cast from the target to the camera finds the first wall, and the camera stops in front of
    /// it. When a wall leaves too little room, the camera swings around her to a side with room. Without a room, nothing
    /// can stand between them, so the camera stays as the rig places it.
    /// </summary>
    public sealed class WindowOutput : IStageOutput
    {
        /// <summary>The free border around the avatar, because arms and hair move past the bounds.</summary>
        private const double FitMargin = 1.1;

        private const string SavedCameraKey = "airi.stage.camera";
        private const float DoubleClickSeconds = 0.3f;
        private const float DoubleClickPixels = 6f;
        private const float SaveDelaySeconds = 0.5f;

        /// <summary>A mouse can report many steps at once, and one frame must not jump through the whole range.</summary>
        private const float LargestWheelSteps = 3f;

        private const int NoButton = -1;
        private const int LeftButton = 0;
        private const int RightButton = 1;

        /// <summary>
        /// The radius of the sphere that finds walls. It is larger than the near plane of a close camera, so the near
        /// plane does not cut into a wall.
        /// </summary>
        private const float WallProbeRadius = 0.15f;

        private readonly Camera _camera;
        private readonly StageCameraRig _rig;
        private readonly bool _isFixed;
        private readonly float _facingDegrees;
        private readonly bool _inRoom;
        private readonly Transform _avatarRoot;
        private readonly StageCameraFollow _follow = new StageCameraFollow();
        private readonly RaycastHit[] _hits = new RaycastHit[32];
        private Bounds? _avatarBounds;
        private float _framedAspect;
        private int _dragButton = NoButton;
        private Vector3 _lastMouse;
        private Vector3 _lastClickPosition;
        private float _lastClickTime = float.NegativeInfinity;
        private float _saveTime = float.PositiveInfinity;

        /// <param name="facingDegrees">The turn of the avatar about the vertical axis. A room can turn it.</param>
        /// <param name="avatarRoot">The parent of the avatars. An MMD model has colliders for its physics, and they are not walls.</param>
        public WindowOutput(Camera camera, StageCameraLimits limits, string fixedCamera, float facingDegrees, Transform avatarRoot)
        {
            _camera = camera;
            _rig = new StageCameraRig(limits);
            _isFixed = fixedCamera != null;
            _facingDegrees = facingDegrees;
            _inRoom = limits.Room != null;
            _avatarRoot = avatarRoot;

            string text = fixedCamera ?? PlayerPrefs.GetString(SavedCameraKey, string.Empty);
            if (text.Length > 0)
            {
                bool loaded = _rig.TryLoad(text);
                Debug.Log($"[Airi] Camera at start: {_rig.Save()}{(loaded ? string.Empty : $", the text {text} is broken")}");
            }
        }

        public void Frame(Bounds avatarBounds)
        {
            _avatarBounds = avatarBounds;
            _follow.Reset(0, 0, 0);
            Apply(0f);
        }

        public void Follow(Vector3 offset)
        {
            _follow.FollowTarget(Time.deltaTime, offset.x, offset.y, offset.z);
            if (_avatarBounds != null)
            {
                Apply(Time.deltaTime);
            }
        }

        public void Tick()
        {
            if (_avatarBounds == null)
            {
                return;
            }

            bool changed = !_isFixed && ReadInput();
            if (changed)
            {
                _saveTime = Time.unscaledTime + SaveDelaySeconds;
            }

            // No time passes here. <see cref="Follow"/> moves the smoothing later in this frame.
            if (changed || !Mathf.Approximately(_camera.aspect, _framedAspect))
            {
                Apply(0f);
            }

            SaveWhenSettled();
        }

        /// <summary>
        /// Applies the mouse and the keys of this frame.
        ///
        /// Returns:
        /// - True when the camera changed.
        /// </summary>
        private bool ReadInput()
        {
            // AIRI keeps this window running while the owner works in another window.
            if (!Application.isFocused)
            {
                _dragButton = NoButton;
                return false;
            }

            StageCameraFrame frame = ToFrame();
            bool changed = ReadKeys();
            Vector3 mouse = Input.mousePosition;
            bool inside = mouse.x >= 0f && mouse.y >= 0f && mouse.x < Screen.width && mouse.y < Screen.height;

            // A press of this frame has no movement yet, so the drag starts in the next frame.
            bool pressedNow = false;
            if (inside && Input.GetMouseButtonDown(LeftButton))
            {
                pressedNow = true;
                _dragButton = LeftButton;
                if (IsDoubleClick(mouse))
                {
                    _rig.SetView(StageCameraView.Full);
                    _dragButton = NoButton;
                    changed = true;
                }
            }
            else if (inside && Input.GetMouseButtonDown(RightButton))
            {
                pressedNow = true;
                _dragButton = RightButton;
            }

            if (_dragButton != NoButton && !Input.GetMouseButton(_dragButton))
            {
                _dragButton = NoButton;
            }

            if (_dragButton != NoButton && !pressedNow)
            {
                Vector3 delta = mouse - _lastMouse;
                if (delta.x != 0f || delta.y != 0f)
                {
                    if (_dragButton == LeftButton)
                    {
                        _rig.Rotate(delta.x, delta.y, Screen.height, frame);
                    }
                    else
                    {
                        _rig.Pan(delta.x, delta.y, Screen.height, frame);
                    }

                    changed = true;
                }
            }

            _lastMouse = mouse;

            float wheel = Input.mouseScrollDelta.y;
            if (inside && wheel != 0f)
            {
                _rig.Zoom(Mathf.Clamp(wheel, -LargestWheelSteps, LargestWheelSteps), frame);
                changed = true;
            }

            return changed;
        }

        private bool ReadKeys()
        {
            if (Input.GetKeyDown(KeyCode.Alpha1) || Input.GetKeyDown(KeyCode.Keypad1))
            {
                _rig.SetView(StageCameraView.Full);
                return true;
            }

            if (Input.GetKeyDown(KeyCode.Alpha2) || Input.GetKeyDown(KeyCode.Keypad2))
            {
                _rig.SetView(StageCameraView.Upper);
                return true;
            }

            if (Input.GetKeyDown(KeyCode.Alpha3) || Input.GetKeyDown(KeyCode.Keypad3))
            {
                _rig.SetView(StageCameraView.Face);
                return true;
            }

            return false;
        }

        private bool IsDoubleClick(Vector3 mouse)
        {
            bool isDouble = Time.unscaledTime - _lastClickTime <= DoubleClickSeconds
                && Vector3.Distance(mouse, _lastClickPosition) <= DoubleClickPixels;

            // A third click starts a new pair.
            _lastClickTime = isDouble ? float.NegativeInfinity : Time.unscaledTime;
            _lastClickPosition = mouse;
            return isDouble;
        }

        /// <summary>Saves after the camera rests, so a drag does not write to the store in each frame.</summary>
        private void SaveWhenSettled()
        {
            if (Time.unscaledTime < _saveTime || _dragButton != NoButton)
            {
                return;
            }

            _saveTime = float.PositiveInfinity;
            string text = _rig.Save();
            PlayerPrefs.SetString(SavedCameraKey, text);
            PlayerPrefs.Save();

            // The owner can read a good composition here, and a grade can start from it.
            Debug.Log($"[Airi] Camera: {text}");
        }

        private StageCameraFrame ToFrame()
        {
            Bounds bounds = _avatarBounds.Value;
            double fitDistance = StageFraming.DistanceToFit(
                bounds.size.y,
                bounds.size.x,
                bounds.size.z,
                _camera.fieldOfView,
                _camera.aspect,
                FitMargin);

            return new StageCameraFrame(
                bounds.center.x + _follow.TargetX,
                bounds.center.y + _follow.TargetY,
                bounds.center.z + _follow.TargetZ,
                bounds.size.y,
                bounds.min.y + _follow.TargetY,
                fitDistance,
                _camera.fieldOfView,
                _facingDegrees);
        }

        private void Apply(float deltaSeconds)
        {
            _framedAspect = _camera.aspect;

            StageCameraFrame frame = ToFrame();
            StageCameraPose pose;
            if (_inRoom)
            {
                double framed = _rig.FramedDistance(frame);
                _follow.Swing(deltaSeconds, turn => RoomAt(frame, turn, framed), _dragButton != NoButton);
                pose = _rig.Resolve(frame, _follow.SwingDegrees);
                pose = pose.AtDistance(_follow.KeepClear(deltaSeconds, pose.Distance, FreeDistance(pose)));
            }
            else
            {
                pose = _rig.Resolve(frame);
            }

            var position = new Vector3((float)pose.X, (float)pose.Y, (float)pose.Z);
            var target = new Vector3((float)pose.TargetX, (float)pose.TargetY, (float)pose.TargetZ);
            float distance = Vector3.Distance(position, target);

            _camera.transform.SetPositionAndRotation(position, Quaternion.LookRotation(target - position, Vector3.up));
            _camera.nearClipPlane = Mathf.Max(0.01f, distance * 0.05f);
            _camera.farClipPlane = distance * 4f + 10f;
        }

        /// <summary>The share of the framed distance that a camera turned by <paramref name="turnDegrees"/> keeps in front of the walls.</summary>
        private double RoomAt(StageCameraFrame frame, double turnDegrees, double framed)
        {
            StageCameraPose pose = _rig.Resolve(frame, turnDegrees);
            return framed > 0 ? Math.Min(pose.Distance, FreeDistance(pose)) / framed : 1;
        }

        /// <summary>
        /// Measures how far the camera can go from its target toward its place before the sphere meets a wall.
        ///
        /// Returns:
        /// - The distance of the center of the sphere at the first wall, or the distance of the pose without a wall.
        /// </summary>
        private double FreeDistance(StageCameraPose pose)
        {
            var target = new Vector3((float)pose.TargetX, (float)pose.TargetY, (float)pose.TargetZ);
            Vector3 toCamera = new Vector3((float)pose.X, (float)pose.Y, (float)pose.Z) - target;
            float framed = toCamera.magnitude;
            if (framed < 1e-4f)
            {
                return framed;
            }

            // A wall of a world can be one plane that faces the other room. The cast must also hit its back, so the
            // setting changes only for this cast.
            bool hitsBackfaces = Physics.queriesHitBackfaces;
            Physics.queriesHitBackfaces = true;
            int count = Physics.SphereCastNonAlloc(target, WallProbeRadius, toCamera / framed, _hits, framed, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            Physics.queriesHitBackfaces = hitsBackfaces;
            float free = framed;
            for (int index = 0; index < count; index++)
            {
                RaycastHit hit = _hits[index];

                // A distance of 0 is a collider around the start, which does not stand between the two. The colliders of
                // an MMD model move with her hair and her skirt, and they are not walls.
                if (hit.distance <= 0f || hit.collider.transform.IsChildOf(_avatarRoot))
                {
                    continue;
                }

                free = Mathf.Min(free, hit.distance);
            }

            return free;
        }
    }
}
