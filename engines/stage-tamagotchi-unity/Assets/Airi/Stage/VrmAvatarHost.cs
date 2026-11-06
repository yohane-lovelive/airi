using System;
using System.Threading;
using System.Threading.Tasks;
using UniGLTF;
using UnityEngine;
using UniVRM10;

namespace Airi.Stage
{
    /// <summary>
    /// Owns the one avatar of the stage.
    ///
    /// State: the current avatar, and the number of the newest load. A new model replaces the old
    /// model only after it loads, so a failed load keeps the old model on the stage. A load that a
    /// newer load replaced drops its result, so an old model cannot arrive last.
    /// </summary>
    public sealed class VrmAvatarHost : IAvatarHost
    {
        private readonly Transform _parent;
        private Vrm10Instance _current;
        private int _newestLoad;

        public VrmAvatarHost(Transform parent)
        {
            _parent = parent;
        }

        /// <summary>
        /// Loads a VRM 1.0 or VRM 0.x file. UniVRM migrates a VRM 0.x model to the form of VRM 1.0.
        ///
        /// Returns:
        /// - The bounds of the avatar, or null when a newer load replaced this load.
        ///
        /// Throws:
        /// - The error of UniVRM when the file is missing or broken. The old avatar stays.
        /// </summary>
        public async Task<Bounds?> LoadAsync(string path, CancellationToken cancellation)
        {
            int load = ++_newestLoad;

            Vrm10Instance loaded = await Vrm10.LoadPathAsync(
                path,
                canLoadVrm0X: true,
                awaitCaller: new RuntimeOnlyAwaitCaller(),
                materialGenerator: new UrpVrm10MaterialDescriptorGenerator(),
                ct: cancellation);

            if (loaded == null)
            {
                throw new InvalidOperationException($"UniVRM could not load {path}.");
            }

            if (load != _newestLoad)
            {
                UnityEngine.Object.Destroy(loaded.gameObject);
                return null;
            }

            Clear();

            _current = loaded;
            loaded.transform.SetParent(_parent, false);

            return MeasureBounds(loaded.gameObject);
        }

        public void Clear()
        {
            if (_current != null)
            {
                UnityEngine.Object.Destroy(_current.gameObject);
                _current = null;
            }
        }

        private static Bounds MeasureBounds(GameObject avatar)
        {
            Renderer[] renderers = avatar.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0)
            {
                throw new InvalidOperationException("The model has nothing to show.");
            }

            Bounds bounds = renderers[0].bounds;
            foreach (Renderer renderer in renderers)
            {
                bounds.Encapsulate(renderer.bounds);
            }

            return bounds;
        }
    }
}
