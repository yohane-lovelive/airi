using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Plays gestures over an idle clip, part by part. It follows <c>GestureLayer</c> of
    /// <c>body-motion/gesture-layer.ts</c>, and <c>playVrmGesture</c> for a clip of the whole body:
    /// - An upper-body gesture takes each <see cref="GestureGroup"/> that it moves. A bone of such a
    ///   group without a track goes to its T-pose, as on the three.js stage.
    /// - It fades in over <see cref="Crossfade"/>. It starts to fade out before its end, so its last
    ///   frame is the middle of the fade.
    /// - A clip of the whole body fades the idle out, and it plays to its end before it fades out.
    ///   While it plays, no upper-body gesture starts.
    ///
    /// One difference: three.js stops an old gesture at once when a new one starts, so the old pose
    /// jumps. Here the old gesture fades out under the new one.
    ///
    /// A walk clip lies between the idle and the gestures, with a weight that follows the speed of the
    /// character. Only the Unity stage walks, so three.js has no such layer.
    /// </summary>
    public sealed class GestureMixer
    {
        /// <summary>The cross-fade of a gesture in seconds, like <c>GESTURE_CROSSFADE</c>.</summary>
        public const float Crossfade = 0.4f;

        /// <summary>The time in seconds in which the weight of the walk goes from 0 to 1, or back.</summary>
        public const float WalkFade = 0.25f;

        private static readonly int[] AllBones = BuildAllBones();

        private sealed class Layer
        {
            public IHumanClip Clip;
            public bool WholeBody;
            public int[] Bones;
            public float Elapsed;
            public float ReleaseAt;
            public bool Released;
            public float ReleasedAt;
            public float WeightAtRelease;

            public float Weight
            {
                get
                {
                    if (!Released)
                    {
                        return Math.Min(1f, Elapsed / Crossfade);
                    }

                    return WeightAtRelease * Math.Max(0f, 1f - (Elapsed - ReleasedAt) / Crossfade);
                }
            }

            /// <summary>Starts the fade out now, for a gesture that a new gesture replaces.</summary>
            public void Release()
            {
                if (Released)
                {
                    return;
                }

                WeightAtRelease = Weight;
                Released = true;
                ReleasedAt = Elapsed;
            }

            /// <summary>Starts the fade out at its planned time, so the result does not depend on the frame rate.</summary>
            public void ReleaseAtPlannedTime()
            {
                WeightAtRelease = Math.Min(1f, ReleaseAt / Crossfade);
                Released = true;
                ReleasedAt = ReleaseAt;
            }
        }

        private readonly List<Layer> _layers = new List<Layer>();
        private readonly StagePose _scratch = new StagePose();
        private IHumanClip _idle;
        private float _idleTime;
        private IHumanClip _walk;
        private float _walkTime;
        private float _walkTarget;
        private float _walkRate = 1f;

        /// <summary>Whether a gesture plays now, including its fade back to the idle.</summary>
        public bool IsPlaying => _layers.Count > 0;

        /// <summary>Whether a clip gives the pose. Without one, the pose is the T-pose.</summary>
        public bool HasMotion => _idle != null || _layers.Count > 0 || WalkWeight > 0;

        /// <summary>How much the walk shows now, from 0 to 1.</summary>
        public float WalkWeight { get; private set; }

        /// <summary>Sets the clip that loops under the gestures. Without a clip, the base is the T-pose.</summary>
        public void SetIdle(IHumanClip clip)
        {
            _idle = clip;
            _idleTime = 0;
        }

        /// <summary>
        /// Sets the walk clip. It plays in place: the mixer takes its rotations and the height of its hips,
        /// and drops the move of its hips to the sides and to the front. Something else moves the character.
        /// </summary>
        public void SetWalk(IHumanClip clip)
        {
            _walk = clip;
            _walkTime = 0;
        }

        /// <summary>
        /// Sets how much the walk shows, from 0 to 1, and how fast it plays. The weight moves to the new value in
        /// <see cref="WalkFade"/>, so a start and a stop do not jump.
        /// </summary>
        public void SetLocomotion(float weight, float rate)
        {
            _walkTarget = Math.Max(0f, Math.Min(1f, weight));
            _walkRate = Math.Max(0f, rate);
        }

        /// <summary>Removes each gesture at once, for a new model.</summary>
        public void Clear()
        {
            _layers.Clear();
        }

        /// <summary>
        /// Plays a gesture once over the parts of the body that it moves.
        ///
        /// Returns:
        /// - False when a clip of the whole body plays, or when the clip moves no part that a gesture can take.
        /// </summary>
        public bool PlayUpper(IHumanClip clip)
        {
            foreach (Layer layer in _layers)
            {
                if (layer.WholeBody && !layer.Released)
                {
                    return false;
                }
            }

            int[] bones = BonesOfGroupsOf(clip);
            if (bones.Length == 0)
            {
                return false;
            }

            ReleaseAll();
            _layers.Add(new Layer
            {
                Clip = clip,
                Bones = bones,
                ReleaseAt = clip.Duration - Crossfade / 2,
            });
            return true;
        }

        /// <summary>Plays a clip of the whole body once, instead of the idle.</summary>
        public void PlayWholeBody(IHumanClip clip)
        {
            ReleaseAll();
            _layers.Add(new Layer
            {
                Clip = clip,
                WholeBody = true,
                Bones = AllBones,
                ReleaseAt = clip.Duration,
            });
        }

        /// <summary>Advances the time and writes the pose of this frame.</summary>
        public void Update(float deltaSeconds, StagePose output)
        {
            output.Reset();
            if (_idle != null)
            {
                _idleTime += deltaSeconds;
                _idle.Sample(_idle.Duration > 0 ? _idleTime % _idle.Duration : 0, output);
            }

            BlendWalk(deltaSeconds, output);

            for (int index = 0; index < _layers.Count; index++)
            {
                Layer layer = _layers[index];
                layer.Elapsed += deltaSeconds;
                if (!layer.Released && layer.Elapsed >= layer.ReleaseAt)
                {
                    layer.ReleaseAtPlannedTime();
                }

                if (layer.Released && layer.Elapsed >= layer.ReleasedAt + Crossfade)
                {
                    _layers.RemoveAt(index);
                    index--;
                    continue;
                }

                Blend(layer, output);
            }
        }

        /// <summary>Moves the weight of the walk toward its target, and blends the walk over the idle.</summary>
        private void BlendWalk(float deltaSeconds, StagePose output)
        {
            if (_walk == null)
            {
                WalkWeight = 0;
                return;
            }

            float step = deltaSeconds / WalkFade;
            WalkWeight = WalkWeight < _walkTarget ? Math.Min(_walkTarget, WalkWeight + step) : Math.Max(_walkTarget, WalkWeight - step);
            if (WalkWeight <= 0)
            {
                // The next walk starts at the start of the cycle.
                _walkTime = 0;
                return;
            }

            _walkTime += deltaSeconds * _walkRate;
            _scratch.Reset();
            _walk.Sample(_walk.Duration > 0 ? _walkTime % _walk.Duration : 0, _scratch);
            foreach (int bone in _walk.Bones)
            {
                output.Rotations[bone] = StageQuaternion.Slerp(output.Rotations[bone], _scratch.Rotations[bone], WalkWeight);
            }

            output.HipsY += (_scratch.HipsY - output.HipsY) * WalkWeight;
        }

        private void Blend(Layer layer, StagePose output)
        {
            float weight = layer.Weight;
            _scratch.Reset();
            layer.Clip.Sample(layer.Elapsed, _scratch);

            foreach (int bone in layer.Bones)
            {
                output.Rotations[bone] = StageQuaternion.Slerp(output.Rotations[bone], _scratch.Rotations[bone], weight);
            }

            if (layer.WholeBody)
            {
                output.HipsX += (_scratch.HipsX - output.HipsX) * weight;
                output.HipsY += (_scratch.HipsY - output.HipsY) * weight;
                output.HipsZ += (_scratch.HipsZ - output.HipsZ) * weight;
            }
        }

        private void ReleaseAll()
        {
            foreach (Layer layer in _layers)
            {
                layer.Release();
            }
        }

        private static int[] BonesOfGroupsOf(IHumanClip clip)
        {
            var groups = new HashSet<GestureGroup>();
            foreach (int bone in clip.Bones)
            {
                GestureGroup group = HumanBones.GroupOf(bone);
                if (group != GestureGroup.None)
                {
                    groups.Add(group);
                }
            }

            var bones = new List<int>();
            for (int bone = 0; bone < HumanBones.Count; bone++)
            {
                if (groups.Contains(HumanBones.GroupOf(bone)))
                {
                    bones.Add(bone);
                }
            }

            return bones.ToArray();
        }

        private static int[] BuildAllBones()
        {
            var bones = new int[HumanBones.Count];
            for (int bone = 0; bone < bones.Length; bone++)
            {
                bones[bone] = bone;
            }

            return bones;
        }
    }
}
