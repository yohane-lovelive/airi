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
    /// it. When a wall leaves too little room, or furniture hides most of her legs, the camera swings around her to a
    /// side with room. Without a room, nothing can stand between them, so the camera stays as the rig places it.
    ///
    /// At a place with a screen, the camera moves to a shot of <see cref="StagePlaceShot"/>, which shows her and the
    /// screen. The mouse then moves this shot, and a key or a double click returns to the usual camera. The saved camera
    /// does not change.
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

        /// <summary>The furniture boxes of a room stop no camera. They only tell which points of her body hide.</summary>
        private const int FurnitureMask = 1 << StageCameraFollow.FurnitureLayer;

        private const int WallMask = Physics.DefaultRaycastLayers & ~FurnitureMask;

        /// <summary>A shot camera keeps this far from the inside of furniture, in meters.</summary>
        private const float ShotClearance = 0.12f;

        /// <summary>A drag across the whole height of the window turns a shot by this many degrees, as it turns the usual camera.</summary>
        private const double ShotDegreesPerWindowHeight = 180;

        /// <summary>One step of the wheel changes the distance of a shot by this share, as for the usual camera.</summary>
        private const double ShotZoomPerStep = 0.9;

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

        /// <summary>The place of the current shot, or null away from a place with a screen.</summary>
        private StagePlaceSubject? _shotSubject;

        /// <summary>The shot for <see cref="_shotSubject"/>, or null when no side shows her and the screen.</summary>
        private StageCameraPose? _shot;

        /// <summary>A key or a double click of the owner returned to the usual camera at this place.</summary>
        private bool _shotDismissed;

        /// <summary>How far the camera moved to the shot, from 0 to 1.</summary>
        private double _shotWeight;

        private double _shotYaw;
        private double _shotPitch;
        private double _shotZoom = 1;
        private double _shotPanRight;
        private double _shotPanUp;

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

            // A move of a shot is not the camera of the owner, so it is not saved.
            if (changed && !ShotActive)
            {
                _saveTime = Time.unscaledTime + SaveDelaySeconds;
            }

            bool resized = !Mathf.Approximately(_camera.aspect, _framedAspect);
            if (resized && _shotSubject != null)
            {
                // Another shape of the window needs another distance.
                _shot = ChooseShot(_shotSubject.Value);
            }

            // No time passes here. <see cref="Follow"/> moves the smoothing later in this frame.
            if (changed || resized)
            {
                Apply(0f);
            }

            SaveWhenSettled();
        }

        /// <inheritdoc/>
        public void ShowPlace(StagePlaceSubject? subject)
        {
            if (subject == null)
            {
                if (_shotSubject != null)
                {
                    Debug.Log($"[Airi] The camera leaves the place {_shotSubject.Value.Name}.");
                }

                _shotSubject = null;
                return;
            }

            if (_shotSubject?.Name == subject.Value.Name)
            {
                return;
            }

            _shotSubject = subject;
            _shotDismissed = false;
            _shotYaw = 0;
            _shotPitch = 0;
            _shotZoom = 1;
            _shotPanRight = 0;
            _shotPanUp = 0;
            _shot = ChooseShot(subject.Value);
        }

        private bool ShotActive => _shotSubject != null && _shot != null && !_shotDismissed;

        /// <summary>
        /// Selects the shot of a place. Each turn of <see cref="StagePlaceShot.TurnDegrees"/> tries both sides, and the
        /// side with more room wins. A side counts only when no wall cuts its distance, the camera stands outside
        /// furniture, and nothing stands between the camera and her head or the screen.
        ///
        /// Returns:
        /// - The shot, or null when no side shows both. The usual camera then stays.
        /// </summary>
        private StageCameraPose? ChooseShot(in StagePlaceSubject subject)
        {
            StagePoint head = subject.Head;
            StageRoomScreen screen = subject.Screen;
            double facing = screen.FacingDegrees * Math.PI / 180.0;
            var headPoint = new Vector3((float)head.X, (float)head.Y, (float)head.Z);
            var screenPoint = new Vector3(
                (float)(screen.Center.X + (Math.Sin(facing) * 0.03)),
                (float)screen.Center.Y,
                (float)(screen.Center.Z + (Math.Cos(facing) * 0.03)));

            foreach (double turn in StagePlaceShot.TurnDegrees)
            {
                StageCameraPose? best = null;
                double bestRoom = 0;
                double bestTurn = 0;
                foreach (double side in new[] { 1.0, -1.0 })
                {
                    StageCameraPose? candidate = StagePlaceShot.Compute(subject, side * turn, _camera.fieldOfView, _camera.aspect);
                    if (candidate == null)
                    {
                        continue;
                    }

                    StageCameraPose pose = candidate.Value;
                    var camera = new Vector3((float)pose.X, (float)pose.Y, (float)pose.Z);

                    // The room behind the camera tells the better side, so the cast goes on past the camera.
                    double room = FreeDistance(pose.AtDistance(pose.Distance * 1.5)) / pose.Distance;
                    if (room < 0.98
                        || Physics.CheckSphere(camera, ShotClearance, FurnitureMask, QueryTriggerInteraction.Ignore)
                        || Blocked(camera, headPoint)
                        || Blocked(camera, screenPoint)
                        || room <= bestRoom)
                    {
                        continue;
                    }

                    best = pose;
                    bestRoom = room;
                    bestTurn = side * turn;
                }

                if (best != null)
                {
                    Debug.Log($"[Airi] Camera at the place {subject.Name}: {Math.Abs(bestTurn):F0} degrees to her {(bestTurn > 0 ? "right" : "left")}, {best.Value.Distance:F2} m from the target.");
                    return best;
                }
            }

            Debug.Log($"[Airi] No camera at the place {subject.Name} shows her and the screen, so the usual camera stays.");
            return null;
        }

        /// <summary>
        /// Whether a wall or furniture stands between two points. The colliders of her own model do not count, and
        /// neither does a collider around the end point, for example the box of the monitor around its screen.
        /// </summary>
        private bool Blocked(Vector3 from, Vector3 to)
        {
            Vector3 path = to - from;
            float length = path.magnitude;
            if (length < 1e-4f)
            {
                return false;
            }

            bool hitsBackfaces = Physics.queriesHitBackfaces;
            Physics.queriesHitBackfaces = true;
            int count = Physics.RaycastNonAlloc(from, path / length, _hits, length, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            Physics.queriesHitBackfaces = hitsBackfaces;
            for (int index = 0; index < count; index++)
            {
                Collider collider = _hits[index].collider;
                if (!collider.transform.IsChildOf(_avatarRoot) && !collider.bounds.Contains(to))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>Returns to the usual camera at this place, after a key or a double click of the owner.</summary>
        private void DismissShot()
        {
            if (ShotActive)
            {
                _shotDismissed = true;
                Debug.Log($"[Airi] The owner returns to the usual camera at the place {_shotSubject.Value.Name}.");
            }
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
            if (changed)
            {
                DismissShot();
            }

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
                    DismissShot();
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
                    if (ShotActive)
                    {
                        MoveShot(delta, _dragButton == LeftButton);
                    }
                    else if (_dragButton == LeftButton)
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
                float steps = Mathf.Clamp(wheel, -LargestWheelSteps, LargestWheelSteps);
                if (ShotActive)
                {
                    _shotZoom = Math.Max(StagePlaceShot.NearestZoom, Math.Min(StagePlaceShot.FarthestZoom, _shotZoom * Math.Pow(ShotZoomPerStep, steps)));
                }
                else
                {
                    _rig.Zoom(steps, frame);
                }

                changed = true;
            }

            return changed;
        }

        /// <summary>Turns the shot with a left drag, or moves it across with a right drag, as the usual camera moves.</summary>
        private void MoveShot(Vector3 delta, bool turn)
        {
            double height = Math.Max(Screen.height, 1);
            if (turn)
            {
                double degreesPerPixel = ShotDegreesPerWindowHeight / height;
                _shotYaw += delta.x * degreesPerPixel;
                _shotPitch -= delta.y * degreesPerPixel;
                return;
            }

            // A pixel covers more of the room at a farther camera, so the move follows the distance.
            double distance = StagePlaceShot.Adjust(_shot.Value, _shotYaw, _shotPitch, _shotZoom, 0, 0).Distance;
            double metersPerPixel = distance * 2.0 * Math.Tan(_camera.fieldOfView * Math.PI / 360.0) / height;
            _shotPanRight -= delta.x * metersPerPixel;
            _shotPanUp -= delta.y * metersPerPixel;
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

            pose = BlendShot(pose, deltaSeconds);
            var position = new Vector3((float)pose.X, (float)pose.Y, (float)pose.Z);
            var target = new Vector3((float)pose.TargetX, (float)pose.TargetY, (float)pose.TargetZ);
            float distance = Vector3.Distance(position, target);

            _camera.transform.SetPositionAndRotation(position, Quaternion.LookRotation(target - position, Vector3.up));
            _camera.nearClipPlane = Mathf.Max(0.01f, distance * 0.05f);
            _camera.farClipPlane = distance * 4f + 10f;
        }

        /// <summary>
        /// Moves the camera toward the shot of a place, or back to the usual camera, by the time of this frame. The usual
        /// camera goes on under the shot, so the way back starts from where it stands now.
        /// </summary>
        private StageCameraPose BlendShot(StageCameraPose usual, float deltaSeconds)
        {
            double goal = ShotActive ? 1 : 0;
            double step = deltaSeconds / StagePlaceShot.BlendSeconds;
            _shotWeight = goal > _shotWeight ? Math.Min(goal, _shotWeight + step) : Math.Max(goal, _shotWeight - step);
            if (_shotWeight <= 0 || _shot == null)
            {
                return usual;
            }

            StageCameraPose shot = StagePlaceShot.Adjust(_shot.Value, _shotYaw, _shotPitch, _shotZoom, _shotPanRight, _shotPanUp);

            // A drag of the owner can turn the shot toward a wall.
            shot = shot.AtDistance(Math.Min(shot.Distance, FreeDistance(shot)));
            return StagePlaceShot.Blend(usual, shot, _shotWeight);
        }

        /// <summary>The share of the framed distance that a camera turned by <paramref name="turnDegrees"/> keeps in front of the walls.</summary>
        private double RoomAt(StageCameraFrame frame, double turnDegrees, double framed)
        {
            StageCameraPose pose = _rig.Resolve(frame, turnDegrees);
            double distance = Math.Min(pose.Distance, FreeDistance(pose));
            StageCameraPose placed = pose.AtDistance(distance);
            var camera = new Vector3((float)placed.X, (float)placed.Y, (float)placed.Z);
            return StageCameraFollow.RoomOf(framed > 0 ? distance / framed : 1, HiddenBodyPoints(frame, camera));
        }

        /// <summary>
        /// Counts the points of her body that furniture hides from a camera at <paramref name="camera"/>. The points stand
        /// on the vertical line through the center of the avatar.
        /// </summary>
        private static int HiddenBodyPoints(in StageCameraFrame frame, Vector3 camera)
        {
            int hidden = 0;
            foreach (double share in StageCameraFollow.BodyPointShares)
            {
                var point = new Vector3((float)frame.CenterX, (float)(frame.FeetY + (frame.Height * share)), (float)frame.CenterZ);
                if (Physics.Linecast(camera, point, FurnitureMask, QueryTriggerInteraction.Ignore))
                {
                    hidden++;
                }
            }

            return hidden;
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
            int count = Physics.SphereCastNonAlloc(target, WallProbeRadius, toCamera / framed, _hits, framed, WallMask, QueryTriggerInteraction.Ignore);
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
