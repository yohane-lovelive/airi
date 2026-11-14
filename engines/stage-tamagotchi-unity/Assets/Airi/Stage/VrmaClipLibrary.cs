using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Airi.Stage.Core;
using UniGLTF;
using UnityEngine;
using UniVRM10;
using Object = UnityEngine.Object;

namespace Airi.Stage
{
    /// <summary>The Unity bone of each bone of <see cref="HumanBones"/>.</summary>
    internal static class UnityHumanBones
    {
        public static readonly HumanBodyBones[] ByIndex = Build();

        private static HumanBodyBones[] Build()
        {
            var bones = new HumanBodyBones[HumanBones.Count];
            for (int index = 0; index < bones.Length; index++)
            {
                // VRM names the three thumb joints from the metacarpal, and Unity names them from the proximal.
                string name = HumanBones.NameOf(index)
                    .Replace("ThumbProximal", "ThumbIntermediate")
                    .Replace("ThumbMetacarpal", "ThumbProximal");
                bones[index] = (HumanBodyBones)Enum.Parse(typeof(HumanBodyBones), char.ToUpperInvariant(name[0]) + name.Substring(1));
            }

            return bones;
        }
    }

    /// <summary>
    /// A clip from a <c>.vrma</c> file. UniVRM loads it as a hidden skeleton with a legacy
    /// <c>Animation</c>. So a sample moves this skeleton to a time, and the normalized rotations
    /// come from its pose provider. The clip stays usable while no other code samples it.
    /// </summary>
    internal sealed class VrmaClip : IHumanClip
    {
        private readonly GameObject _root;
        private readonly Animation _animation;
        private readonly AnimationState _state;
        private readonly INormalizedPoseProvider _pose;
        private readonly List<int> _bones;
        private readonly Vector3 _firstHips;
        private readonly Vector3 _restHips;
        private readonly float _restHipsHeight;

        public float Duration { get; }

        public IReadOnlyList<int> Bones => _bones;

        /// <summary>
        /// Whether the clip gives the move of the hips from its T-pose, not from its first frame. A walk bends its
        /// knees in each frame, so only its T-pose gives the drop of its hips, and without the drop the feet float.
        /// </summary>
        public bool HipsFromRest { get; set; }

        private VrmaClip(RuntimeGltfInstance instance, List<int> bones)
        {
            _root = instance.gameObject;
            var clip = instance.GetComponent<Vrm10AnimationInstance>();
            if (clip.BoxMan != null)
            {
                clip.ShowBoxMan(false);
            }

            _pose = clip.ControlRig.Item1;
            ITPoseProvider tPose = clip.ControlRig.Item2;
            _restHips = tPose.GetWorldTransform(HumanBodyBones.Hips).Value.Translation;
            _restHipsHeight = _restHips.y;

            _animation = instance.GetComponent<Animation>();
            _animation.cullingType = AnimationCullingType.AlwaysAnimate;
            _animation.playAutomatically = false;
            _animation.Stop();
            _state = _animation[_animation.clip.name];
            _bones = bones;
            Duration = _state.length;

            MoveTo(0);
            _firstHips = _pose.GetRawHipsPosition();
        }

        /// <summary>
        /// Loads a file.
        ///
        /// Throws:
        /// - The error of the parser when the file is missing or broken.
        /// - <see cref="InvalidOperationException"/> when the file has no humanoid clip.
        /// </summary>
        public static async Task<VrmaClip> LoadAsync(string path, Transform parent)
        {
            using GltfData data = new AutoGltfFileParser(path).Parse();
            var animationData = new VrmAnimationData(data);
            using var importer = new VrmAnimationImporter(animationData);
            RuntimeGltfInstance instance = await importer.LoadAsync(new RuntimeOnlyAwaitCaller());

            if (instance.GetComponent<Vrm10AnimationInstance>()?.ControlRig.Item1 == null || instance.GetComponent<Animation>()?.clip == null)
            {
                Object.Destroy(instance.gameObject);
                throw new InvalidOperationException($"The file {path} has no humanoid clip.");
            }

            instance.transform.SetParent(parent, false);
            return new VrmaClip(instance, ReadRotatedBones(data, importer));
        }

        /// <summary>
        /// Lists the bones that have rotation tracks in the file. A file names each humanoid bone, also
        /// a bone without a track, and a gesture must take only the parts that it moves.
        /// </summary>
        private static List<int> ReadRotatedBones(GltfData data, VrmAnimationImporter importer)
        {
            var boneOfNode = new Dictionary<string, HumanBodyBones>();
            foreach ((Transform node, HumanBodyBones bone) in importer.GetHumanMap())
            {
                boneOfNode[node.name] = bone;
            }

            var rotated = new HashSet<HumanBodyBones>();
            foreach (UniGLTF.glTFAnimationChannel channel in data.GLTF.animations[0].channels)
            {
                if (channel.target.path == "rotation"
                    && channel.target.node >= 0
                    && channel.target.node < data.GLTF.nodes.Count
                    && boneOfNode.TryGetValue(data.GLTF.nodes[channel.target.node].name, out HumanBodyBones bone))
                {
                    rotated.Add(bone);
                }
            }

            var bones = new List<int>();
            for (int index = 0; index < HumanBones.Count; index++)
            {
                if (rotated.Contains(UnityHumanBones.ByIndex[index]))
                {
                    bones.Add(index);
                }
            }

            return bones;
        }

        public void Sample(float time, StagePose pose)
        {
            MoveTo(time);

            foreach (int index in _bones)
            {
                Quaternion q = _pose.GetNormalizedLocalRotation(UnityHumanBones.ByIndex[index], HumanBodyBones.LastBone);

                // The inverse of `HumanoidFrame.ToUnity`, which changes the same two signs.
                pose.Rotations[index] = new StageQuaternion(q.x, -q.y, -q.z, q.w);
            }

            // The X axis is mirrored between the frame of Unity and the frame of the host.
            Vector3 hips = _pose.GetRawHipsPosition() - (HipsFromRest ? _restHips : _firstHips);
            float scale = _restHipsHeight > 0 ? 1f / _restHipsHeight : 0;
            pose.HipsX = -hips.x * scale;
            pose.HipsY = hips.y * scale;
            pose.HipsZ = hips.z * scale;
        }

        private void MoveTo(float time)
        {
            _state.enabled = true;
            _state.weight = 1f;
            _state.time = Mathf.Min(time, Duration);
            _animation.Sample();
            _state.enabled = false;
        }

        public void Destroy()
        {
            Object.Destroy(_root);
        }
    }

    /// <summary>
    /// Loads each <c>.vrma</c> file once. The host writes a clip to the same path each time, and the
    /// idle of each model is the same file, so a second load does not cost a stutter.
    /// </summary>
    internal sealed class VrmaClipLibrary
    {
        private readonly Transform _parent;
        private readonly Dictionary<string, Task<VrmaClip>> _clips = new Dictionary<string, Task<VrmaClip>>();

        public VrmaClipLibrary(Transform parent)
        {
            _parent = parent;
        }

        /// <summary>Gives the clip of a file. A failed load does not stay, so the next call tries again.</summary>
        public async Task<VrmaClip> LoadAsync(string path)
        {
            if (!_clips.TryGetValue(path, out Task<VrmaClip> task))
            {
                task = VrmaClip.LoadAsync(path, _parent);
                _clips[path] = task;
            }

            try
            {
                return await task;
            }
            catch
            {
                _clips.Remove(path);
                throw;
            }
        }
    }
}
