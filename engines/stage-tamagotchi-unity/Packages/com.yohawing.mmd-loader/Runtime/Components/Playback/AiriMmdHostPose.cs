#nullable enable

using System;
using System.Collections.Generic;
using Mmd.Parser;
using Mmd.Physics;
using UnityEngine;

namespace Mmd.UnityIntegration
{
    /// <summary>
    /// AIRI addition, not a part of unity-mmd-loader. docs/vendor-patches.md of the engine records it.
    ///
    /// Moves a loaded model from a pose of the host, through the native session that the Humanoid
    /// path of the loader uses. So grants, helper IK, and physics follow the pose. The API of this
    /// path is internal, and a host outside this assembly cannot give morph weights to it.
    ///
    /// Lifecycle: <see cref="Attach"/> takes the binding, and this component disposes it. The caller
    /// fills the arrays and calls <see cref="Step"/> once each frame. The binding must not play a motion.
    /// </summary>
    public sealed class AiriMmdHostPose : MonoBehaviour
    {
        private MmdUnityPlaybackBinding _binding = null!;
        private MmdUnityModelInstance _instance = null!;
        private MmdModelDefinition _model = null!;
        private float[] _scales = Array.Empty<float>();
        private byte[] _ikEnabled = Array.Empty<byte>();
        private int _step = -1;
        private bool _morphsChanged;
        private readonly MmdEvaluatedFrame _morphFrame = new();
        private readonly HashSet<string> _morphNames = new(StringComparer.Ordinal);

        /// <summary>Three numbers for each bone: the offset from its rest place, in the frame of the PMX file.</summary>
        public float[] LocalPositionOffsets { get; private set; } = Array.Empty<float>();

        /// <summary>Four numbers <c>[x, y, z, w]</c> for each bone, in the frame of the PMX file.</summary>
        public float[] LocalRotations { get; private set; } = Array.Empty<float>();

        /// <summary>One number for each morph of the model, from 0 to 1.</summary>
        public float[] MorphWeights { get; private set; } = Array.Empty<float>();

        /// <summary>
        /// Starts the native session of a model.
        ///
        /// Expects:
        /// - A binding that is in no playback. Its physics mode changes to Live.
        /// - The indices of the bones that the host moves. A bone outside this list gets its pose from
        ///   the native grants, IK, and physics.
        ///
        /// Throws:
        /// - <see cref="InvalidOperationException"/> when the native session cannot start.
        /// </summary>
        public static AiriMmdHostPose Attach(MmdUnityPlaybackBinding binding, IReadOnlyList<int> drivenBones)
        {
            MmdUnityModelInstance instance = binding.Instance;
            MmdModelDefinition model = binding.NativeHostPoseModel;
            Transform[] bones = instance.BoneTransforms;
            Transform marker = instance.Root.transform;

            // The rig selection reads only the bone index and the two transforms of an entry.
            var entries = new List<MmdHumanoidRetargetBinding>(drivenBones.Count);
            foreach (int index in drivenBones)
            {
                entries.Add(new MmdHumanoidRetargetBinding(HumanBodyBones.LastBone, index, marker, bones[index]));
            }

            MmdUnityPlaybackController.HumanoidHostPoseRigSelection selection =
                MmdUnityPlaybackController.BuildHumanoidHostPoseRigSelection(model, bones, entries);

            binding.SetPhysicsMode(MmdPhysicsMode.Live);
            if (!binding.TryEnableNativeHumanoidHostPose(selection.DrivenBones, selection.GoalBones))
            {
                throw new InvalidOperationException(binding.LastNativeHumanoidHostPoseFailureReason);
            }

            AiriMmdHostPose pose = instance.Root.AddComponent<AiriMmdHostPose>();
            pose._binding = binding;
            pose._instance = instance;
            pose._model = model;
            pose._ikEnabled = selection.IkEligibility;
            pose.LocalPositionOffsets = new float[bones.Length * 3];
            pose.LocalRotations = new float[bones.Length * 4];
            pose.MorphWeights = new float[model.morphs.Count];
            pose._scales = new float[bones.Length * 3];
            for (int index = 0; index < pose._scales.Length; index++)
            {
                pose._scales[index] = 1f;
            }

            for (int index = 0; index < bones.Length; index++)
            {
                pose.LocalRotations[index * 4 + 3] = 1f;
            }

            return pose;
        }

        /// <summary>Sets each bone back to its rest pose.</summary>
        public void ResetToRest()
        {
            Array.Clear(LocalPositionOffsets, 0, LocalPositionOffsets.Length);
            Array.Clear(LocalRotations, 0, LocalRotations.Length);
            for (int index = 3; index < LocalRotations.Length; index += 4)
            {
                LocalRotations[index] = 1f;
            }
        }

        /// <summary>Marks the morph weights as changed, so the next <see cref="Step"/> applies them to the mesh.</summary>
        public void MarkMorphsChanged()
        {
            _morphsChanged = true;
        }

        /// <summary>
        /// Evaluates the pose and the physics, and writes the result to the bones of the model.
        ///
        /// The native session reads the morph weights for bone morphs, but it returns no weights in
        /// this path. So this method also applies the vertex and material morphs to the mesh.
        /// </summary>
        public void Step(float deltaTime)
        {
            _step++;
            bool seed = _step == 0;
            _binding.StepLivePhysicsFromHostPose(
                _step,
                seed ? 0f : deltaTime,
                seed,
                LocalPositionOffsets,
                LocalRotations,
                _scales,
                MorphWeights,
                _ikEnabled);

            if (_morphsChanged)
            {
                _morphsChanged = false;
                ApplyMorphsToMesh();
            }
        }

        private void ApplyMorphsToMesh()
        {
            _morphFrame.morphs.Clear();
            _morphNames.Clear();
            for (int index = 0; index < MorphWeights.Length; index++)
            {
                float weight = MorphWeights[index];
                string name = _model.morphs[index].name;
                if (weight > 0f && !string.IsNullOrWhiteSpace(name) && _morphNames.Add(name))
                {
                    _morphFrame.morphs.Add(new MmdEvaluatedMorphWeight { name = name, weight = weight });
                }
            }

            MmdUnityFrameApplier.ApplyMorphs(_instance, _morphFrame, groupMorphsResolvedExternally: false);
        }

        private void OnDestroy()
        {
            _binding?.Dispose();
        }
    }
}
