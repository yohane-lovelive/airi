using Airi.Stage.Core;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// One normal camera in a normal window. The camera stands in front of the avatar, which faces
    /// +Z, and looks back along -Z.
    /// </summary>
    public sealed class WindowOutput : IStageOutput
    {
        /// <summary>The free border around the avatar, because arms and hair move past the bounds.</summary>
        private const double FitMargin = 1.1;

        private readonly Camera _camera;
        private Bounds? _avatarBounds;
        private float _framedAspect;

        public WindowOutput(Camera camera)
        {
            _camera = camera;
        }

        public void Frame(Bounds avatarBounds)
        {
            _avatarBounds = avatarBounds;
            Apply();
        }

        public void Tick()
        {
            if (_avatarBounds != null && !Mathf.Approximately(_camera.aspect, _framedAspect))
            {
                Apply();
            }
        }

        private void Apply()
        {
            Bounds bounds = _avatarBounds.Value;
            _framedAspect = _camera.aspect;

            float distance = (float)StageFraming.DistanceToFit(
                bounds.size.y,
                bounds.size.x,
                bounds.size.z,
                _camera.fieldOfView,
                _camera.aspect,
                FitMargin);

            _camera.transform.SetPositionAndRotation(
                bounds.center + Vector3.forward * distance,
                Quaternion.LookRotation(Vector3.back, Vector3.up));
            _camera.nearClipPlane = Mathf.Max(0.01f, distance * 0.05f);
            _camera.farClipPlane = distance * 4f + 10f;
        }
    }
}
