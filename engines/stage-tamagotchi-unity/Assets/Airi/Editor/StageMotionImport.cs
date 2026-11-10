using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UniGLTF;
using UnityEditor;
using UnityEngine;
using UniVRM10;

namespace Airi.Stage.Editor
{
    /// <summary>
    /// Makes VRM animations (<c>.vrma</c>) for the player from humanoid clips of local FBX files, for example the
    /// Universal Animation Library of Quaternius under CC0.
    ///
    /// Put each FBX file in a folder <c>.cache/motions/&lt;name&gt;/</c>, and run <c>pnpm run import:motion</c>. The
    /// import copies each file to <c>Assets/LocalMotions</c>, which stays out of Git, and imports it as a humanoid.
    /// Then it writes each clip of <see cref="Motions"/> to <c>Assets/StreamingAssets/AiriMotions</c>, where the
    /// player reads it. A clip goes into Git only when its license allows it.
    ///
    /// A VRM animation needs a skeleton whose rest pose is a T-pose with no rotation on any bone, like the
    /// normalized bones of VRM. The import builds such a skeleton with the proportions of the source. Then it moves
    /// each frame of the clip onto that skeleton through the humanoid muscles of Unity. So each humanoid rig works
    /// as a source.
    ///
    /// Call stack:
    ///
    /// tools/run-unity.ps1 (-executeMethod)
    ///   -> <see cref="ImportAll"/>
    ///     -> <see cref="ImportModel"/>
    ///     -> <see cref="BuildNormalizedSkeleton"/>
    ///     -> <see cref="Convert"/>
    /// </summary>
    public static class StageMotionImport
    {
        private const string LocalRoot = "Assets/LocalMotions";
        private const string OutputFolder = "Assets/StreamingAssets/AiriMotions";
        private const float FramesPerSecond = 30f;

        /// <summary>
        /// The clips to convert, by the end of their name in a model file, and the names of the files to write. The
        /// owner chose the casual walk of the Universal Animation Library over its formal walk.
        /// </summary>
        private static readonly (string Clip, string File)[] Motions =
        {
            ("Walk_Loop", "walk"),
        };

        /// <summary>Converts the clips of each model. A missing clip or a failed model fails the run, so the batch reports it.</summary>
        public static void ImportAll()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string motionsFolder = Path.GetFullPath(Path.Combine(projectRoot, "../../.cache/motions"));
            string[] files = Directory.Exists(motionsFolder)
                ? Directory.GetFiles(motionsFolder, "*.fbx", SearchOption.AllDirectories).OrderBy(file => file, StringComparer.Ordinal).ToArray()
                : Array.Empty<string>();
            if (files.Length == 0)
            {
                Debug.LogError($"[Airi] No motion file. Put each FBX file in its own folder in {motionsFolder}.");
                EditorApplication.Exit(1);
                return;
            }

            string output = Path.Combine(projectRoot, OutputFolder);
            Directory.CreateDirectory(output);
            var written = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                foreach (string file in files)
                {
                    string modelPath = ImportModel(file);
                    foreach (string name in ConvertClips(modelPath, output))
                    {
                        written.Add(name);
                    }
                }
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not convert the motions: {error}");
                EditorApplication.Exit(1);
                return;
            }

            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            string[] missing = Motions.Select(motion => motion.Clip).Where(clip => !written.Contains(clip)).ToArray();
            if (missing.Length > 0)
            {
                Debug.LogError($"[Airi] No model has these clips: {string.Join(", ", missing)}.");
                EditorApplication.Exit(1);
            }
        }

        /// <summary>
        /// Copies a model file into the project and imports it as a humanoid. Each clip loops and keeps the whole
        /// move of the body in its pose, so the root of the model does not move.
        ///
        /// Returns:
        /// - The asset path of the model.
        /// </summary>
        private static string ImportModel(string file)
        {
            string folder = Path.GetFileName(Path.GetDirectoryName(file));
            string target = $"{LocalRoot}/{folder}";
            Directory.CreateDirectory(target);
            string path = $"{target}/{Path.GetFileName(file)}";
            File.Copy(file, path, true);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);

            var importer = (ModelImporter)AssetImporter.GetAtPath(path);
            importer.animationType = ModelImporterAnimationType.Human;
            importer.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
            importer.importAnimation = true;
            importer.clipAnimations = importer.defaultClipAnimations.Select(clip =>
            {
                clip.loopTime = clip.name.EndsWith("_Loop", StringComparison.Ordinal);
                clip.lockRootRotation = true;
                clip.lockRootHeightY = true;
                clip.lockRootPositionXZ = true;
                return clip;
            }).ToArray();
            importer.SaveAndReimport();
            Debug.Log($"[Airi] Imported {path} as a humanoid, with {importer.clipAnimations.Length} clips.");
            return path;
        }

        /// <summary>
        /// Writes each clip of <see cref="Motions"/> that the model has.
        ///
        /// Returns:
        /// - The names of the clips that it wrote, as <see cref="Motions"/> names them.
        /// </summary>
        private static List<string> ConvertClips(string modelPath, string output)
        {
            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(modelPath);
            Avatar avatar = assets.OfType<Avatar>().FirstOrDefault();
            if (avatar == null || !avatar.isValid || !avatar.isHuman)
            {
                throw new InvalidOperationException($"Unity could not map {modelPath} to a humanoid. Read the log of Unity.");
            }

            AnimationClip[] clips = assets.OfType<AnimationClip>().Where(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal)).ToArray();
            var written = new List<string>();
            GameObject source = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(modelPath));
            try
            {
                Animator animator = source.GetComponent<Animator>() ?? source.AddComponent<Animator>();
                animator.avatar = avatar;
                animator.applyRootMotion = false;
                using (var sourcePose = new HumanPoseHandler(avatar, source.transform))
                {
                    NormalizedSkeleton skeleton = BuildNormalizedSkeleton(animator);
                    try
                    {
                        foreach ((string clipName, string fileName) in Motions)
                        {
                            AnimationClip clip = clips.FirstOrDefault(item => item.name == clipName || item.name.EndsWith("|" + clipName, StringComparison.Ordinal));
                            if (clip == null)
                            {
                                continue;
                            }

                            byte[] bytes = Convert(clip, animator, sourcePose, skeleton);
                            string path = Path.Combine(output, fileName + ".vrma");
                            File.WriteAllBytes(path, bytes);
                            written.Add(clipName);
                            Debug.Log($"[Airi] Wrote {path}: {clip.name}, {clip.length:F2} s, {bytes.Length / 1024} KB.");
                        }
                    }
                    finally
                    {
                        UnityEngine.Object.DestroyImmediate(skeleton.Root);
                    }
                }
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(source);
            }

            return written;
        }

        /// <summary>
        /// Puts the source into the T-pose of its avatar. Unity enforces a T-pose when it builds an avatar, and keeps
        /// it in the skeleton of the description. A pose with each muscle at 0 is not a T-pose, so it does not serve.
        /// </summary>
        private static void ApplyTPose(Animator source)
        {
            var rest = new Dictionary<string, SkeletonBone>(StringComparer.Ordinal);
            foreach (SkeletonBone bone in source.avatar.humanDescription.skeleton)
            {
                rest[bone.name] = bone;
            }

            foreach (Transform part in source.GetComponentsInChildren<Transform>(true))
            {
                if (part != source.transform && rest.TryGetValue(part.name, out SkeletonBone bone))
                {
                    part.localPosition = bone.position;
                    part.localRotation = bone.rotation;
                }
            }
        }

        /// <summary>
        /// Builds a skeleton for the export: one object for each humanoid bone of the source, at its place in the
        /// T-pose, with no rotation. The parent of a bone is its nearest humanoid ancestor in the source. The skeleton
        /// gets an avatar of its own, so the humanoid muscles can pose it.
        ///
        /// A VRM model faces +Z, and its right arm points to +X. A source can face another way, so the skeleton turns
        /// about the vertical axis until its right arm points to +X. Without this turn, the whole clip faces away.
        /// </summary>
        private static NormalizedSkeleton BuildNormalizedSkeleton(Animator source)
        {
            ApplyTPose(source);
            Vector3 across = source.GetBoneTransform(HumanBodyBones.RightUpperArm).position - source.GetBoneTransform(HumanBodyBones.LeftUpperArm).position;
            across.y = 0f;
            Quaternion turn = Quaternion.FromToRotation(across.normalized, Vector3.right);
            Vector3 center = source.GetBoneTransform(HumanBodyBones.Hips).position;
            center.y = 0f;

            var root = new GameObject("Airi Normalized Skeleton");
            var bones = new Dictionary<HumanBodyBones, Transform>();
            var bySource = new Dictionary<Transform, HumanBodyBones>();
            for (var bone = (HumanBodyBones)0; bone < HumanBodyBones.LastBone; bone++)
            {
                Transform sourceBone = source.GetBoneTransform(bone);
                if (sourceBone == null)
                {
                    continue;
                }

                var target = new GameObject(bone.ToString()).transform;
                target.SetPositionAndRotation(center + (turn * (sourceBone.position - center)), Quaternion.identity);
                bones.Add(bone, target);
                bySource.Add(sourceBone, bone);
            }

            foreach (KeyValuePair<HumanBodyBones, Transform> pair in bones)
            {
                Transform parent = root.transform;
                for (Transform ancestor = source.GetBoneTransform(pair.Key).parent; ancestor != null; ancestor = ancestor.parent)
                {
                    if (bySource.TryGetValue(ancestor, out HumanBodyBones parentBone))
                    {
                        parent = bones[parentBone];
                        break;
                    }
                }

                pair.Value.SetParent(parent, true);
            }

            var description = new HumanDescription
            {
                human = bones.Select(pair => new HumanBone
                {
                    boneName = pair.Value.name,
                    humanName = HumanTrait.BoneName[(int)pair.Key],
                    limit = new HumanLimit { useDefaultValues = true },
                }).ToArray(),
                skeleton = root.GetComponentsInChildren<Transform>().Select(part => new SkeletonBone
                {
                    name = part.name,
                    position = part.localPosition,
                    rotation = part.localRotation,
                    scale = part.localScale,
                }).ToArray(),
                upperArmTwist = 0.5f,
                lowerArmTwist = 0.5f,
                upperLegTwist = 0.5f,
                lowerLegTwist = 0.5f,
                armStretch = 0.05f,
                legStretch = 0.05f,
                hasTranslationDoF = false,
            };
            Avatar avatar = AvatarBuilder.BuildHumanAvatar(root, description);
            if (!avatar.isValid || !avatar.isHuman)
            {
                UnityEngine.Object.DestroyImmediate(root);
                throw new InvalidOperationException("Unity could not build an avatar for the normalized skeleton.");
            }

            return new NormalizedSkeleton(root, bones, avatar);
        }

        /// <summary>
        /// Samples the clip on the source at 30 frames each second, and records the normalized skeleton. The animation
        /// mode of the Editor samples a humanoid clip outside Play mode, and puts the scene back at its end.
        ///
        /// A humanoid pose gives the turn of the body against the root of its model. A clip can turn the body away
        /// from the root, for example by 180 degrees when its root faces another way. So each frame takes off the
        /// turn of the body in the first frame, and adds the turn of the skeleton in its T-pose. The clip then starts
        /// with the body to the front of the skeleton.
        /// </summary>
        private static byte[] Convert(AnimationClip clip, Animator source, HumanPoseHandler sourcePose, NormalizedSkeleton skeleton)
        {
            var data = new ExportingGltfData();
            int legMuscle = Array.IndexOf(HumanTrait.MuscleName, "Left Upper Leg Front-Back");
            float legLow = float.PositiveInfinity;
            float legHigh = float.NegativeInfinity;
            var rest = default(HumanPose);
            AnimationMode.StartAnimationMode();
            try
            {
                using (var exporter = new VrmAnimationExporter(data, new GltfExportSettings()))
                using (var targetPose = new HumanPoseHandler(skeleton.Avatar, skeleton.Root.transform))
                {
                    // The export takes the rest pose from the skeleton as it stands now. A clip before this one moved it.
                    skeleton.Reset();
                    targetPose.GetHumanPose(ref rest);
                    Quaternion targetTurn = Yaw(rest.bodyRotation);
                    AnimationMode.BeginSampling();
                    AnimationMode.SampleAnimationClip(source.gameObject, clip, 0f);
                    AnimationMode.EndSampling();
                    sourcePose.GetHumanPose(ref rest);
                    Quaternion correction = targetTurn * Quaternion.Inverse(Yaw(rest.bodyRotation));
                    exporter.Prepare(skeleton.Root);
                    exporter.Export(vrma =>
                    {
                        vrma.SetPositionBoneAndParent(skeleton.Bones[HumanBodyBones.Hips], skeleton.Root.transform);
                        foreach (KeyValuePair<HumanBodyBones, Transform> pair in skeleton.Bones)
                        {
                            vrma.AddRotationBoneAndParent(pair.Key, pair.Value, pair.Value.parent);
                        }

                        var pose = default(HumanPose);
                        int frames = Mathf.Max(2, Mathf.RoundToInt(clip.length * FramesPerSecond) + 1);
                        for (int frame = 0; frame < frames; frame++)
                        {
                            double time = clip.length * frame / (double)(frames - 1);
                            AnimationMode.BeginSampling();
                            AnimationMode.SampleAnimationClip(source.gameObject, clip, (float)time);
                            AnimationMode.EndSampling();
                            sourcePose.GetHumanPose(ref pose);
                            legLow = Mathf.Min(legLow, pose.muscles[legMuscle]);
                            legHigh = Mathf.Max(legHigh, pose.muscles[legMuscle]);
                            pose.bodyRotation = correction * pose.bodyRotation;
                            pose.bodyPosition = correction * pose.bodyPosition;
                            targetPose.SetHumanPose(ref pose);
                            vrma.AddFrame(TimeSpan.FromSeconds(time));
                        }
                    });
                }
            }
            finally
            {
                AnimationMode.StopAnimationMode();
            }

            // A clip that did not move gives the same muscle in each frame. Then the file holds one still pose.
            Debug.Log($"[Airi] {clip.name}: the muscle of the left upper leg moves from {legLow:F2} to {legHigh:F2}.");
            if (legHigh - legLow < 0.05f)
            {
                throw new InvalidOperationException($"The clip {clip.name} did not move the legs of the source.");
            }

            return data.ToGlbBytes();
        }

        /// <summary>The turn of a rotation about the vertical axis only.</summary>
        private static Quaternion Yaw(Quaternion rotation)
        {
            Vector3 forward = rotation * Vector3.forward;
            forward.y = 0f;
            return forward.sqrMagnitude > 1e-6f ? Quaternion.LookRotation(forward.normalized, Vector3.up) : Quaternion.identity;
        }

        /// <summary>The skeleton of the export, with its T-pose. State: the local places of the T-pose, for <see cref="Reset"/>.</summary>
        private sealed class NormalizedSkeleton
        {
            private readonly Dictionary<Transform, Vector3> _restPositions;

            public NormalizedSkeleton(GameObject root, Dictionary<HumanBodyBones, Transform> bones, Avatar avatar)
            {
                Root = root;
                Bones = bones;
                Avatar = avatar;
                _restPositions = bones.Values.ToDictionary(bone => bone, bone => bone.localPosition);
            }

            public GameObject Root { get; }

            public Dictionary<HumanBodyBones, Transform> Bones { get; }

            public Avatar Avatar { get; }

            /// <summary>Returns to the T-pose: the places of the T-pose, and no rotation on any bone.</summary>
            public void Reset()
            {
                foreach (KeyValuePair<Transform, Vector3> pair in _restPositions)
                {
                    pair.Key.localPosition = pair.Value;
                    pair.Key.localRotation = Quaternion.identity;
                }
            }
        }
    }
}
