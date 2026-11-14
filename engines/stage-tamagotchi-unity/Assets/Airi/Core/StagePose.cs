using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// A pose of the normalized bones of a VRM humanoid, in the frame of the host: right-handed, facing
    /// +Z, with +Y up. A rotation of identity is the T-pose.
    /// </summary>
    public sealed class StagePose
    {
        /// <summary>One rotation for each bone of <see cref="HumanBones"/>.</summary>
        public readonly StageQuaternion[] Rotations = new StageQuaternion[HumanBones.Count];

        /// <summary>
        /// The move of the hips from the first frame of the clip, in hip heights of the clip. So each
        /// model scales it by its own hip height.
        /// </summary>
        public float HipsX;

        public float HipsY;
        public float HipsZ;

        public StagePose()
        {
            Reset();
        }

        /// <summary>Returns to the T-pose.</summary>
        public void Reset()
        {
            Array.Fill(Rotations, StageQuaternion.Identity);
            HipsX = 0;
            HipsY = 0;
            HipsZ = 0;
        }
    }

    /// <summary>A motion that a pose can read at any time.</summary>
    public interface IHumanClip
    {
        float Duration { get; }

        /// <summary>The indices of the bones in <see cref="HumanBones"/> that this clip rotates.</summary>
        IReadOnlyList<int> Bones { get; }

        /// <summary>Writes the rotations of <see cref="Bones"/> and the hips, and leaves the other bones as they are.</summary>
        void Sample(float time, StagePose pose);
    }

    /// <summary>A clip from the rotation keys of a gesture message.</summary>
    public sealed class KeyframeClip : IHumanClip
    {
        private readonly List<(int Bone, RotationTrack Track)> _tracks = new List<(int Bone, RotationTrack Track)>();
        private readonly List<int> _bones = new List<int>();

        public float Duration { get; }

        public IReadOnlyList<int> Bones => _bones;

        /// <param name="duration">The length in seconds.</param>
        /// <param name="tracks">The keys. A track of a bone outside <see cref="HumanBones"/> plays nothing.</param>
        public KeyframeClip(float duration, IReadOnlyList<RotationTrack> tracks)
        {
            Duration = duration;
            foreach (RotationTrack track in tracks)
            {
                int bone = HumanBones.IndexOf(track.Bone);
                if (bone >= 0)
                {
                    _tracks.Add((bone, track));
                    _bones.Add(bone);
                }
            }
        }

        public void Sample(float time, StagePose pose)
        {
            foreach ((int bone, RotationTrack track) in _tracks)
            {
                pose.Rotations[bone] = SampleTrack(track, time);
            }
        }

        private static StageQuaternion SampleTrack(RotationTrack track, float time)
        {
            float[] times = track.Times;
            int last = times.Length - 1;
            if (time <= times[0])
            {
                return KeyOf(track, 0);
            }

            if (time >= times[last])
            {
                return KeyOf(track, last);
            }

            int next = 1;
            while (times[next] < time)
            {
                next++;
            }

            float t = (time - times[next - 1]) / (times[next] - times[next - 1]);
            return StageQuaternion.Slerp(KeyOf(track, next - 1), KeyOf(track, next), t);
        }

        private static StageQuaternion KeyOf(RotationTrack track, int index)
        {
            int offset = index * 4;
            return new StageQuaternion(
                track.Values[offset],
                track.Values[offset + 1],
                track.Values[offset + 2],
                track.Values[offset + 3]);
        }
    }
}
