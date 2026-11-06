using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// The parts of the body that a gesture can take from the idle clip. The rule is the one of
    /// <c>gestureGroupOfHumanBone</c> in <c>body-motion/gesture-layer.ts</c>.
    /// </summary>
    public enum GestureGroup
    {
        None,
        Head,
        Torso,
        LeftArm,
        RightArm,
    }

    /// <summary>
    /// The bones of a VRM humanoid that a pose can move, in parent-first order. Other code keeps a
    /// rotation for each bone in an array, by the index of this list.
    ///
    /// The eyes stay out, because the gaze owns them. The list is the one of <c>buildHumanBones</c> in
    /// <c>stage-ui-mmd/src/utils/vrma-retarget.ts</c>, with the standard MMD bone of each human bone.
    /// </summary>
    public static class HumanBones
    {
        private readonly struct Spec
        {
            public readonly string Name;
            public readonly string Parent;
            public readonly string Mmd;
            public readonly string Next;
            public readonly float TPoseX;

            public Spec(string name, string parent, string mmd, string next = null, float tPoseX = 0)
            {
                Name = name;
                Parent = parent;
                Mmd = mmd;
                Next = next;
                TPoseX = tPoseX;
            }
        }

        private const string FullWidthDigits = "０１２３";

        private static readonly (string Name, string Mmd, int First, string[] Joints)[] Fingers =
        {
            ("Thumb", "親指", 0, new[] { "Metacarpal", "Proximal", "Distal" }),
            ("Index", "人指", 1, new[] { "Proximal", "Intermediate", "Distal" }),
            ("Middle", "中指", 1, new[] { "Proximal", "Intermediate", "Distal" }),
            ("Ring", "薬指", 1, new[] { "Proximal", "Intermediate", "Distal" }),
            ("Little", "小指", 1, new[] { "Proximal", "Intermediate", "Distal" }),
        };

        private static readonly List<Spec> Specs = BuildSpecs();
        private static readonly Dictionary<string, int> Indices = BuildIndices();

        public static int Count => Specs.Count;

        public static string NameOf(int index)
        {
            return Specs[index].Name;
        }

        /// <summary>The index of a VRM bone name, or -1 when the name is not in the list.</summary>
        public static int IndexOf(string name)
        {
            return Indices.TryGetValue(name, out int index) ? index : -1;
        }

        /// <summary>The index of the VRM parent, or -1 for the hips.</summary>
        public static int ParentOf(int index)
        {
            string parent = Specs[index].Parent;
            return parent != null ? Indices[parent] : -1;
        }

        /// <summary>The standard name of this bone on an MMD model.</summary>
        public static string MmdNameOf(int index)
        {
            return Specs[index].Mmd;
        }

        /// <summary>The index of the bone that gives the direction of this bone, or -1.</summary>
        public static int NextOf(int index)
        {
            string next = Specs[index].Next;
            return next != null ? Indices[next] : -1;
        }

        /// <summary>The X of the direction of this bone in a T-pose, or 0 for a bone that has no direction here.</summary>
        public static float TPoseXOf(int index)
        {
            return Specs[index].TPoseX;
        }

        public static GestureGroup GroupOf(int index)
        {
            string name = Specs[index].Name;
            if (name == "neck" || name == "head")
            {
                return GestureGroup.Head;
            }

            if (name == "spine" || name == "chest" || name == "upperChest")
            {
                return GestureGroup.Torso;
            }

            if (name.Contains("UpperLeg") || name.Contains("LowerLeg") || name.Contains("Foot") || name.Contains("Toes"))
            {
                return GestureGroup.None;
            }

            if (name.StartsWith("left", StringComparison.Ordinal))
            {
                return GestureGroup.LeftArm;
            }

            return name.StartsWith("right", StringComparison.Ordinal) ? GestureGroup.RightArm : GestureGroup.None;
        }

        private static List<Spec> BuildSpecs()
        {
            var specs = new List<Spec>
            {
                new Spec("hips", null, "センター"),
                new Spec("spine", "hips", "上半身"),
                new Spec("chest", "spine", "上半身2"),
                new Spec("upperChest", "chest", "上半身3"),
                new Spec("neck", "upperChest", "首"),
                new Spec("head", "neck", "頭"),
            };

            foreach ((string side, string mmd, float x) in new[] { ("left", "左", 1f), ("right", "右", -1f) })
            {
                specs.Add(new Spec($"{side}Shoulder", "upperChest", $"{mmd}肩", $"{side}UpperArm", x));
                specs.Add(new Spec($"{side}UpperArm", $"{side}Shoulder", $"{mmd}腕", $"{side}LowerArm", x));
                specs.Add(new Spec($"{side}LowerArm", $"{side}UpperArm", $"{mmd}ひじ", $"{side}Hand", x));
                specs.Add(new Spec($"{side}Hand", $"{side}LowerArm", $"{mmd}手首", $"{side}MiddleProximal", x));
                specs.Add(new Spec($"{side}UpperLeg", "hips", $"{mmd}足"));
                specs.Add(new Spec($"{side}LowerLeg", $"{side}UpperLeg", $"{mmd}ひざ"));
                specs.Add(new Spec($"{side}Foot", $"{side}LowerLeg", $"{mmd}足首"));
                specs.Add(new Spec($"{side}Toes", $"{side}Foot", $"{mmd}つま先"));

                foreach ((string finger, string fingerMmd, int first, string[] joints) in Fingers)
                {
                    bool thumb = finger == "Thumb";
                    for (int index = 0; index < joints.Length; index++)
                    {
                        string parent = index == 0 ? $"{side}Hand" : $"{side}{finger}{joints[index - 1]}";
                        string next = !thumb && index < joints.Length - 1 ? $"{side}{finger}{joints[index + 1]}" : null;

                        // The thumb points forward in a T-pose, so it keeps the correction of the hand.
                        specs.Add(new Spec(
                            $"{side}{finger}{joints[index]}",
                            parent,
                            $"{mmd}{fingerMmd}{FullWidthDigits[first + index]}",
                            next,
                            thumb ? 0 : x));
                    }
                }
            }

            return specs;
        }

        private static Dictionary<string, int> BuildIndices()
        {
            var indices = new Dictionary<string, int>();
            for (int index = 0; index < Specs.Count; index++)
            {
                indices[Specs[index].Name] = index;
            }

            return indices;
        }
    }
}
