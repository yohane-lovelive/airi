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
    /// State: the camera of <see cref="StageCameraRig"/>, and the drag that runs now. The camera returns at
    /// the next start, because it is in <see cref="PlayerPrefs"/>. The argument <c>--airi-camera=</c> fixes
    /// the camera instead, so a capture has no saved camera and no stray click in it.
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

        private readonly Camera _camera;
        private readonly StageCameraRig _rig;
        private readonly bool _isFixed;
        private readonly float _facingDegrees;
        private Bounds? _avatarBounds;
        private Vector3 _follow;
        private float _framedAspect;
        private int _dragButton = NoButton;
        private Vector3 _lastMouse;
        private Vector3 _lastClickPosition;
        private float _lastClickTime = float.NegativeInfinity;
        private float _saveTime = float.PositiveInfinity;

        /// <param name="facingDegrees">The turn of the avatar about the vertical axis. A room can turn it.</param>
        public WindowOutput(Camera camera, StageCameraLimits limits, string fixedCamera, float facingDegrees)
        {
            _camera = camera;
            _rig = new StageCameraRig(limits);
            _isFixed = fixedCamera != null;
            _facingDegrees = facingDegrees;

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
            _follow = Vector3.zero;
            Apply();
        }

        public void Follow(Vector3 offset)
        {
            if (offset == _follow)
            {
                return;
            }

            _follow = offset;
            if (_avatarBounds != null)
            {
                Apply();
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

            if (changed || !Mathf.Approximately(_camera.aspect, _framedAspect))
            {
                Apply();
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

            Vector3 center = bounds.center + _follow;
            return new StageCameraFrame(
                center.x,
                center.y,
                center.z,
                bounds.size.y,
                bounds.min.y + _follow.y,
                fitDistance,
                _camera.fieldOfView,
                _facingDegrees);
        }

        private void Apply()
        {
            _framedAspect = _camera.aspect;

            StageCameraPose pose = _rig.Resolve(ToFrame());
            var position = new Vector3((float)pose.X, (float)pose.Y, (float)pose.Z);
            var target = new Vector3((float)pose.TargetX, (float)pose.TargetY, (float)pose.TargetZ);
            float distance = Vector3.Distance(position, target);

            _camera.transform.SetPositionAndRotation(position, Quaternion.LookRotation(target - position, Vector3.up));
            _camera.nearClipPlane = Mathf.Max(0.01f, distance * 0.05f);
            _camera.farClipPlane = distance * 4f + 10f;
        }
    }
}
