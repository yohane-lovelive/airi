using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using Mmd;
using Mmd.Parser;
using Mmd.Rendering;
using Mmd.UnityIntegration;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

namespace Airi.Stage
{
    /// <summary>
    /// Owns the one MMD avatar of the stage. It uses the runtime API of unity-mmd-loader, because the
    /// owner selects a model in AIRI and a built player has no Editor import.
    ///
    /// State: the current avatar, and the number of the newest load. A new model replaces the old
    /// model only after it loads, so a broken file keeps the old model on the stage.
    /// </summary>
    public sealed class MmdAvatarHost : IAvatarHost
    {
        /// <summary>The default of the loader. MMD models are about 20 units tall.</summary>
        private const float ImportScale = 0.1f;

        /// <summary>A long frame must not throw the physics bodies away in one step.</summary>
        private const float MaxPhysicsStepSeconds = 0.1f;

        /// <summary>A smaller change of a morph does not show, and each change costs a write to the mesh.</summary>
        private const float MorphChangeThreshold = 0.001f;

        private readonly Transform _parent;
        private readonly StageLook _look;
        private readonly LookMaterials _lookMaterials = new LookMaterials();
        private GameObject _current;
        private MmdHumanoidRetarget _retarget;
        private AiriMmdHostPose _hostPose;
        private Dictionary<string, int> _morphOfSlot = new Dictionary<string, int>();
        private int _newestLoad;

        public MmdAvatarHost(Transform parent, StageLook look)
        {
            _parent = parent;
            _look = look;
        }

        /// <inheritdoc/>
        public EmotionTable Emotions => EmotionTable.Mmd;

        /// <inheritdoc/>
        public float HipHeight => _retarget != null ? _retarget.HipHeight * ImportScale : 0f;

        /// <inheritdoc/>
        public float HeadHeight => _retarget != null ? _retarget.HeadHeight * ImportScale : 0f;

        /// <inheritdoc/>
        public float ThighLength => _retarget != null ? _retarget.ThighLength * ImportScale : 0f;

        /// <summary>
        /// Loads a PMX file. The textures load from paths relative to this file, so the file must stay
        /// in its folder.
        ///
        /// Returns:
        /// - The bounds of the avatar, or null when a newer load replaced this load.
        ///
        /// Throws:
        /// - The error of the parser when the file is missing or broken. The old avatar stays.
        /// </summary>
        public async Task<Bounds?> LoadAsync(string path, CancellationToken cancellation)
        {
            int load = ++_newestLoad;
            var timer = Stopwatch.StartNew();

            // The files are large and the parser is native, so both run away from the main thread.
            (MmdModelDefinition model, MmdMotionDefinition restMotion) = await Task.Run(
                () =>
                {
                    var parser = new NativeMmdParser();
                    MmdModelDefinition parsed = parser.LoadModel(File.ReadAllBytes(path));
                    MmdModelValidator.ThrowIfInvalid(parsed);
                    return (parsed, parser.LoadMotion(BuildRestMotion()));
                },
                cancellation);

            if (load != _newestLoad)
            {
                return null;
            }

            MmdUnityPlaybackBinding binding = MmdUnityPlaybackBinding.CreateSkinned(
                model,
                restMotion,
                path,
                "airi-rest",
                path,
                ImportScale,
                MmdMaterialPreset.MmdToonLit);

            MmdUnityModelInstance instance = binding.Instance;
            GameObject root = instance.Root;
            root.transform.SetParent(_parent, false);

            MmdHumanoidRetarget retarget;
            AiriMmdHostPose hostPose;
            try
            {
                retarget = new MmdHumanoidRetarget(ToRigBones(model));
                hostPose = AiriMmdHostPose.Attach(binding, retarget.DrivenBones);
            }
            catch
            {
                // The old avatar stays, so this model must not stay on the stage with it.
                binding.Dispose();
                Object.Destroy(root);
                throw;
            }

            Clear();
            _current = root;
            _retarget = retarget;
            _hostPose = hostPose;
            _morphOfSlot = FindMorphsOfSlots(model);
            _look.Apply(root.GetComponentsInChildren<Renderer>(), AvatarMaterialFormat.Mmd, _lookMaterials);

            // A newer model can replace this one during the unload below, so the measure comes first.
            Bounds bounds = MeasureBounds(instance);
            Debug.Log(
                $"[Airi] MMD {Path.GetFileName(path)}: {timer.ElapsedMilliseconds} ms, "
                + $"{instance.VertexCount} vertices, {instance.PhysicsBodies.Length} bodies, "
                + $"{instance.LoadedDiffuseTextureCount} textures, {instance.MissingTextureReferenceCount} missing, "
                + $"{instance.UnsupportedTextureReferenceCount} unsupported");

            // The old model leaves large textures and arrays behind. A destroy frees them only at the
            // next unload, so a run of model changes grows without this call.
            await Resources.UnloadUnusedAssets();
            GC.Collect();

            return bounds;
        }

        public void Clear()
        {
            if (_current != null)
            {
                Object.Destroy(_current);
                _current = null;
                _retarget = null;
                _hostPose = null;
            }

            _lookMaterials.Clear();
        }

        /// <inheritdoc/>
        public void ApplyCharacter(CharacterDriver character, float deltaSeconds)
        {
            if (_hostPose == null)
            {
                return;
            }

            IReadOnlyList<string> names = character.WeightNames;
            float[] weights = character.Weights;
            bool morphsChanged = false;
            for (int index = 0; index < weights.Length; index++)
            {
                if (_morphOfSlot.TryGetValue(names[index], out int morph)
                    && Math.Abs(_hostPose.MorphWeights[morph] - weights[index]) > MorphChangeThreshold)
                {
                    _hostPose.MorphWeights[morph] = weights[index];
                    _hostPose.MarkMorphsChanged();
                    morphsChanged = true;
                }
            }

            // Without a clip, the driver gives the T-pose. An MMD model rests in an A-pose, and its rest
            // pose looks better while the idle clip is missing. The physics keep running in this pose.
            if (character.HasMotion)
            {
                _retarget.Apply(
                    character.Pose,
                    character.EyesYaw,
                    character.EyesPitch,
                    _hostPose.LocalPositionOffsets,
                    _hostPose.LocalRotations);
            }
            else
            {
                _hostPose.ResetToRest();
            }

            _hostPose.Step(Mathf.Min(deltaSeconds, MaxPhysicsStepSeconds));

            // The step writes the material morphs to the materials of the loader.
            if (morphsChanged)
            {
                _lookMaterials.Sync();
            }
        }

        private static Dictionary<string, int> FindMorphsOfSlots(MmdModelDefinition model)
        {
            var indexOfName = new Dictionary<string, int>();
            for (int index = model.morphs.Count - 1; index >= 0; index--)
            {
                indexOfName[model.morphs[index].name] = index;
            }

            var morphs = new Dictionary<string, int>();
            foreach (KeyValuePair<string, string> slot in MorphSlots.Resolve(indexOfName.ContainsKey))
            {
                morphs[slot.Key] = indexOfName[slot.Value];
            }

            return morphs;
        }

        private static MmdRigBone[] ToRigBones(MmdModelDefinition model)
        {
            var bones = new MmdRigBone[model.bones.Count];
            for (int index = 0; index < bones.Length; index++)
            {
                MmdBoneDefinition bone = model.bones[index];
                bones[index] = new MmdRigBone(bone.name, bone.parentIndex, bone.origin[0], bone.origin[1], bone.origin[2]);
            }

            return bones;
        }

        /// <summary>
        /// Builds a VMD file with no keys: a 30-byte header, a 20-byte model name, and four counts of
        /// zero. The loader needs a motion to run its physics, and AIRI has no motion file. The name
        /// stays empty, so this code needs no Shift_JIS encoding, which a Mono player can lack.
        /// </summary>
        private static byte[] BuildRestMotion()
        {
            var bytes = new byte[66];
            byte[] header = Encoding.ASCII.GetBytes("Vocaloid Motion Data 0002");
            Array.Copy(header, bytes, header.Length);
            return bytes;
        }

        /// <summary>
        /// Measures the mesh in its rest pose. The bounds of the renderer do not fit: the loader widens
        /// them to a large cube, so that physics cannot move hair out of them and cull it.
        /// </summary>
        private static Bounds MeasureBounds(MmdUnityModelInstance instance)
        {
            Transform transform = instance.SkinnedMeshRenderer != null
                ? instance.SkinnedMeshRenderer.transform
                : instance.Root.transform;
            Bounds local = instance.Mesh.bounds;
            Vector3 size = transform.lossyScale;

            return new Bounds(
                transform.TransformPoint(local.center),
                new Vector3(local.size.x * size.x, local.size.y * size.y, local.size.z * size.z));
        }
    }
}
