using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
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
        private readonly StageLook _look;
        private readonly LookMaterials _lookMaterials = new LookMaterials();
        private readonly Dictionary<string, ExpressionKey> _expressions =
            new Dictionary<string, ExpressionKey>(StringComparer.OrdinalIgnoreCase);

        private Vrm10Instance _current;
        private Vector3 _restHips;
        private float _restHeadHeight;
        private float _thighLength;
        private int _newestLoad;

        public VrmAvatarHost(Transform parent, StageLook look)
        {
            _parent = parent;
            _look = look;
        }

        /// <inheritdoc/>
        public EmotionTable Emotions => EmotionTable.Vrm;

        /// <inheritdoc/>
        public float HipHeight => _current != null ? _restHips.y : 0f;

        /// <inheritdoc/>
        public float HeadHeight => _current != null ? _restHeadHeight : 0f;

        /// <inheritdoc/>
        public float ThighLength => _current != null ? _thighLength : 0f;

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

            // UniVRM keeps the world rotations of its first moment as the rest pose of the control rig. A room
            // turns the parent, so the runtime must start here at the origin, or each rotation turns about a wrong axis.
            _ = loaded.Runtime;
            loaded.transform.SetParent(_parent, false);
            _look.Apply(loaded.GetComponentsInChildren<Renderer>(), AvatarMaterialFormat.Vrm, _lookMaterials);

            ReadExpressions(loaded);
            ITPoseProvider tPose = loaded.Runtime.ControlRig;
            _restHips = tPose.GetWorldTransform(HumanBodyBones.Hips).Value.Translation;
            _restHeadHeight = tPose.GetWorldTransform(HumanBodyBones.Head).Value.Translation.y;
            _thighLength = Vector3.Distance(
                tPose.GetWorldTransform(HumanBodyBones.LeftUpperLeg).Value.Translation,
                tPose.GetWorldTransform(HumanBodyBones.LeftLowerLeg).Value.Translation);

            return MeasureBounds(loaded.gameObject);
        }

        public void Clear()
        {
            if (_current != null)
            {
                UnityEngine.Object.Destroy(_current.gameObject);
                _current = null;
            }

            _lookMaterials.Clear();
        }

        /// <inheritdoc/>
        public void ApplyCharacter(CharacterDriver character, float deltaSeconds)
        {
            if (_current == null)
            {
                return;
            }

            Vrm10Runtime runtime = _current.Runtime;
            INormalizedPoseApplicable rig = runtime.ControlRig;
            StagePose pose = character.Pose;

            for (int index = 0; index < HumanBones.Count; index++)
            {
                StageQuaternion rotation = HumanoidFrame.ToUnity(pose.Rotations[index]);
                rig.SetNormalizedLocalRotation(
                    UnityHumanBones.ByIndex[index],
                    new Quaternion(rotation.X, rotation.Y, rotation.Z, rotation.W));
            }

            // The pose gives the hips in hip heights of its clip, and the X axis is mirrored in Unity.
            rig.SetRawHipsPosition(_restHips + new Vector3(-pose.HipsX, pose.HipsY, pose.HipsZ) * _restHips.y);

            IReadOnlyList<string> names = character.WeightNames;
            for (int index = 0; index < character.Weights.Length; index++)
            {
                if (_expressions.TryGetValue(names[index], out ExpressionKey key))
                {
                    runtime.Expression.SetWeight(key, character.Weights[index]);
                }
            }

            // UniVRM counts yaw to the right of the character and pitch upward. The host counts yaw
            // toward its +X, the left of the character, and pitch downward.
            runtime.LookAt.SetYawPitchManually(
                -character.EyesYaw * Mathf.Rad2Deg,
                -character.EyesPitch * Mathf.Rad2Deg);
        }

        /// <summary>A model can spell a custom expression in another case, so the search ignores the case, as on three.js.</summary>
        private void ReadExpressions(Vrm10Instance avatar)
        {
            _expressions.Clear();
            foreach (ExpressionKey key in avatar.Runtime.Expression.ExpressionKeys)
            {
                _expressions[key.Name] = key;
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
