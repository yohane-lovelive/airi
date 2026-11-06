using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>One bone of a PMX model at rest. The place is in the frame of the PMX file.</summary>
    public readonly struct MmdRigBone
    {
        public readonly string Name;

        /// <summary>The index of the parent bone, or -1 for a root.</summary>
        public readonly int Parent;

        public readonly float X;
        public readonly float Y;
        public readonly float Z;

        public MmdRigBone(string name, int parent, float x, float y, float z)
        {
            Name = name;
            Parent = parent;
            X = x;
            Y = y;
            Z = z;
        }
    }

    /// <summary>
    /// Turns a pose of the normalized bones of a VRM humanoid into local rotations of PMX bones.
    ///
    /// The math is the one of <c>retargetVRMAnimationToMMD</c> in <c>stage-ui-mmd</c>, so a gesture
    /// looks the same on the three.js stage:
    /// - Each VRM rotation is relative to the T-pose. Code turns it into a world rotation, and the
    ///   PMX bone gets the same world rotation, corrected for its rest direction.
    /// - MMD models rest in an A-pose, so the arms differ most.
    /// - The hips drive <c>センター</c>, so <c>上半身</c> and <c>下半身</c> follow it.
    ///
    /// The VRM frame is right-handed, faces +Z, and has the left arm at +X. A PMX file has the same
    /// axes with Z inverted.
    ///
    /// It also turns the eye bones, as <c>createGazeController</c> in <c>stage-ui-mmd</c> does. The
    /// eyeballs follow <c>左目</c> and <c>右目</c>. <c>両目</c> serves only a model without them.
    /// </summary>
    public sealed class MmdHumanoidRetarget
    {
        private const float EyeYawLimit = 0.35f;
        private const float EyePitchLimit = 0.25f;

        private static readonly string[] LeftEyeNames = { "左目", "eye_L", "EyeLeft", "LeftEye" };
        private static readonly string[] RightEyeNames = { "右目", "eye_R", "EyeRight", "RightEye" };
        private static readonly string[] BothEyesNames = { "両目", "Eyes" };

        private readonly IReadOnlyList<MmdRigBone> _bones;
        private readonly int[] _targetOfHuman;
        private readonly int[] _humanOfBone;
        private readonly bool[] _isEye;
        private readonly StageQuaternion[] _corrections;
        private readonly int[] _order;
        private readonly StageQuaternion[] _vrmWorld;
        private readonly StageQuaternion[] _boneWorld;
        private readonly int _hipsTarget;

        /// <summary>The indices of the PMX bones that this retarget writes.</summary>
        public IReadOnlyList<int> DrivenBones { get; }

        /// <summary>The height of the hip joints in PMX units, for the scale of a hips motion.</summary>
        public float HipHeight { get; }

        public MmdHumanoidRetarget(IReadOnlyList<MmdRigBone> bones)
        {
            _bones = bones;

            var boneIndex = new Dictionary<string, int>();
            for (int index = bones.Count - 1; index >= 0; index--)
            {
                boneIndex[bones[index].Name] = index;
            }

            _targetOfHuman = new int[HumanBones.Count];
            _humanOfBone = new int[bones.Count];
            Array.Fill(_humanOfBone, -1);
            var driven = new List<int>();
            for (int human = 0; human < HumanBones.Count; human++)
            {
                if (boneIndex.TryGetValue(HumanBones.MmdNameOf(human), out int target))
                {
                    _targetOfHuman[human] = target;
                    _humanOfBone[target] = human;
                    driven.Add(target);
                }
                else
                {
                    _targetOfHuman[human] = -1;
                }
            }

            _isEye = new bool[bones.Count];
            foreach (int eye in FindEyeBones(boneIndex))
            {
                _isEye[eye] = true;
                if (!driven.Contains(eye))
                {
                    driven.Add(eye);
                }
            }

            DrivenBones = driven;
            _hipsTarget = _targetOfHuman[HumanBones.IndexOf("hips")];
            _corrections = ComputeCorrections();
            _order = ParentFirstOrder(bones);
            _vrmWorld = new StageQuaternion[HumanBones.Count];
            _boneWorld = new StageQuaternion[bones.Count];
            HipHeight = ComputeHipHeight(boneIndex);
        }

        /// <summary>
        /// Writes the pose of one frame.
        ///
        /// Expects:
        /// - The eye angles in radians, in the VRM frame. A positive yaw turns toward +X, and a positive
        ///   pitch turns down.
        /// - The output arrays have 3 and 4 numbers for each PMX bone. They get values in the PMX frame.
        /// </summary>
        public void Apply(StagePose pose, float eyesYaw, float eyesPitch, float[] localPositionOffsets, float[] localRotations)
        {
            StageQuaternion eyes = HumanoidFrame.FromEuler(new BodyRotation(
                Math.Max(-EyePitchLimit, Math.Min(EyePitchLimit, eyesPitch)),
                Math.Max(-EyeYawLimit, Math.Min(EyeYawLimit, eyesYaw)),
                0));

            for (int human = 0; human < HumanBones.Count; human++)
            {
                int parent = HumanBones.ParentOf(human);
                _vrmWorld[human] = parent >= 0 ? _vrmWorld[parent] * pose.Rotations[human] : pose.Rotations[human];
            }

            foreach (int index in _order)
            {
                int parent = _bones[index].Parent;
                StageQuaternion parentWorld = parent >= 0 ? _boneWorld[parent] : StageQuaternion.Identity;
                int human = _humanOfBone[index];
                StageQuaternion local = StageQuaternion.Identity;
                if (human >= 0)
                {
                    StageQuaternion world = _vrmWorld[human] * _corrections[human];

                    // Without this step, the length error doubles at each level of a long chain of bones.
                    local = (parentWorld.Inverse() * world).Normalized();
                }
                else if (_isEye[index])
                {
                    local = eyes;
                }

                _boneWorld[index] = (parentWorld * local).Normalized();

                // The VRM frame and the PMX frame differ by a mirror of Z.
                int offset = index * 4;
                localRotations[offset] = -local.X;
                localRotations[offset + 1] = -local.Y;
                localRotations[offset + 2] = local.Z;
                localRotations[offset + 3] = local.W;
            }

            if (_hipsTarget >= 0)
            {
                int offset = _hipsTarget * 3;
                localPositionOffsets[offset] = pose.HipsX * HipHeight;
                localPositionOffsets[offset + 1] = pose.HipsY * HipHeight;
                localPositionOffsets[offset + 2] = -pose.HipsZ * HipHeight;
            }
        }

        private static List<int> FindEyeBones(Dictionary<string, int> boneIndex)
        {
            var eyes = new List<int>();
            AddFirstBone(eyes, boneIndex, LeftEyeNames);
            AddFirstBone(eyes, boneIndex, RightEyeNames);
            if (eyes.Count == 0)
            {
                AddFirstBone(eyes, boneIndex, BothEyesNames);
            }

            return eyes;
        }

        private static void AddFirstBone(List<int> bones, Dictionary<string, int> boneIndex, string[] names)
        {
            foreach (string name in names)
            {
                if (boneIndex.TryGetValue(name, out int index))
                {
                    bones.Add(index);
                    return;
                }
            }
        }

        private StageQuaternion[] ComputeCorrections()
        {
            var corrections = new StageQuaternion[HumanBones.Count];
            for (int human = 0; human < HumanBones.Count; human++)
            {
                int parent = HumanBones.ParentOf(human);

                // A bone without its own direction keeps the correction of its parent.
                corrections[human] = parent >= 0 ? corrections[parent] : StageQuaternion.Identity;

                float tPoseX = HumanBones.TPoseXOf(human);
                int next = HumanBones.NextOf(human);
                int own = _targetOfHuman[human];
                if (tPoseX == 0 || next < 0 || own < 0 || _targetOfHuman[next] < 0)
                {
                    continue;
                }

                MmdRigBone from = _bones[own];
                MmdRigBone to = _bones[_targetOfHuman[next]];

                // The rest direction in the VRM frame. A PMX place has its Z inverted.
                float x = to.X - from.X;
                float y = to.Y - from.Y;
                float z = -(to.Z - from.Z);
                float lengthSquared = x * x + y * y + z * z;
                if (lengthSquared > 1e-8f)
                {
                    float length = (float)Math.Sqrt(lengthSquared);
                    corrections[human] = StageQuaternion.FromUnitVectors(x / length, y / length, z / length, tPoseX, 0f, 0f);
                }
            }

            return corrections;
        }

        private float ComputeHipHeight(Dictionary<string, int> boneIndex)
        {
            float sum = 0;
            int count = 0;
            foreach (string name in new[] { "左足", "右足" })
            {
                if (boneIndex.TryGetValue(name, out int index))
                {
                    sum += _bones[index].Y;
                    count++;
                }
            }

            if (count > 0)
            {
                return sum / count;
            }

            return _hipsTarget >= 0 ? _bones[_hipsTarget].Y : 0;
        }

        private static int[] ParentFirstOrder(IReadOnlyList<MmdRigBone> bones)
        {
            var order = new List<int>(bones.Count);
            var visited = new bool[bones.Count];

            void Visit(int index)
            {
                if (visited[index])
                {
                    return;
                }

                visited[index] = true;
                int parent = bones[index].Parent;
                if (parent >= 0)
                {
                    Visit(parent);
                }

                order.Add(index);
            }

            for (int index = 0; index < bones.Count; index++)
            {
                Visit(index);
            }

            return order.ToArray();
        }
    }
}
