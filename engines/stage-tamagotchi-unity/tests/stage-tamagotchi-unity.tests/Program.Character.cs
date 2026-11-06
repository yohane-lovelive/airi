using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Airi.Stage.Core;
using Newtonsoft.Json.Linq;

/// <summary>
/// The tests of the character logic of <c>Core</c>. The files of <c>character-fixtures</c> record
/// the output of the TypeScript code that this logic follows. Tests of each TypeScript package write
/// them, so a change on one side fails on the other side.
/// </summary>
public static partial class Program
{
    /// <summary>The fixtures keep 6 decimals, and the math here uses single precision.</summary>
    private const double FixtureTolerance = 3e-4;

    private static JObject ReadCharacterFixture(string name)
    {
        return JObject.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "character-fixtures", name)));
    }

    private static void CheckNear(double actual, double expected, double tolerance, string description)
    {
        Check(Math.Abs(actual - expected) <= tolerance, $"{description}: {actual} != {expected}");
    }

    private static void CheckSameRotation(StageQuaternion actual, StageQuaternion expected, string description)
    {
        // A quaternion and its negative are the same rotation. A long chain of products loses a little
        // length, on both sides, so the check compares the directions.
        double dot = actual.X * expected.X + actual.Y * expected.Y + actual.Z * expected.Z + actual.W * expected.W;
        double actualLength = Math.Sqrt(actual.X * actual.X + actual.Y * actual.Y + actual.Z * actual.Z + actual.W * actual.W);
        double expectedLength = Math.Sqrt(expected.X * expected.X + expected.Y * expected.Y + expected.Z * expected.Z + expected.W * expected.W);
        Check(
            Math.Abs(dot) / (actualLength * expectedLength) >= 1 - FixtureTolerance,
            $"{description}: ({actual.X}, {actual.Y}, {actual.Z}, {actual.W}) != ({expected.X}, {expected.Y}, {expected.Z}, {expected.W})");
    }

    private static StageQuaternion ToRotation(JToken values)
    {
        return new StageQuaternion((float)values[0], (float)values[1], (float)values[2], (float)values[3]);
    }

    private static void TestCharacter()
    {
        JObject gestures = ReadCharacterFixture("gestures.json");
        JObject mmd = ReadCharacterFixture("mmd.json");
        JObject vrm = ReadCharacterFixture("vrm.json");
        JObject emotions = ReadCharacterFixture("emotions.json");

        TestHumanBones(mmd);
        TestGestureKeys(gestures);
        TestRetarget(mmd);
        TestMorphCandidates(mmd);
        TestEmotionTables(mmd, emotions);
        TestVrmExpressionTimeline(vrm);
        TestMmdExpressionTimeline(mmd);
        TestExpressionHold();
        TestGestureMixerWeights();
        TestGestureMixerGroups();
        TestGestureMixerOverlap();
        TestGestureMixerWholeBody();
        TestBlink();
        TestFrameFollower();
        TestCharacterDriver();
    }

    private static float WeightOf(CharacterDriver driver, string name)
    {
        for (int index = 0; index < driver.WeightNames.Count; index++)
        {
            if (driver.WeightNames[index] == name)
            {
                return driver.Weights[index];
            }
        }

        throw new ArgumentException($"The driver has no weight {name}.");
    }

    private static void TestCharacterDriver()
    {
        int head = HumanBones.IndexOf("head");
        var driver = new CharacterDriver(() => 0);

        // A signal before the model must not fail, because the host sends the idle first.
        driver.SetExpression("happy", 1, null);
        driver.Update(0.1f);
        Check(driver.Weights.Length == 0, "no model has no weights");

        Check(!driver.HasMotion, "no clip gives no motion");
        driver.SetIdle(new HoldClip(5f, TurnX, 0, "head"));
        Check(driver.HasMotion, "the idle gives the motion");
        driver.StartModel(EmotionTable.Vrm);
        foreach (string name in new[] { "aa", "ih", "ou", "ee", "oh", "blink", "happy", "neutral" })
        {
            Check(driver.WeightNames.Contains(name), $"the VRM weights have {name}");
        }

        Check(driver.WeightNames.Distinct().Count() == driver.WeightNames.Count, "each VRM weight has one entry");

        driver.Update(0.01f);
        CheckSameRotation(driver.Pose.Rotations[head], TurnX, "the idle stays for a new model");

        // The offsets of the stream come after the clips, as `BodyPoseApplier` does.
        driver.ReceiveFrame(FrameWithMouth(0, 0.4f));
        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0.4f));
            driver.Update(1f / 60f);
        }

        StageQuaternion expected = TurnX * HumanoidFrame.FromEuler(new BodyRotation(0.4f, 0, 0));
        CheckSameRotation(driver.Pose.Rotations[head], expected, "the offset follows the clip");
        CheckNear(driver.EyesYaw, 0.2, 1e-2, "the driver gives the eyes");
        CheckNear(driver.EyesPitch, -0.1, 1e-2, "the driver gives the eyes");

        // The emotion holds its vowel at rest, and lip sync takes the mouth in speech.
        driver.SetExpression("happy", 1, 1e9f);
        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0));
            driver.Update(1f / 60f);
        }

        CheckNear(WeightOf(driver, "aa"), 0.2, 1e-3, "the emotion shows its vowel");
        CheckNear(WeightOf(driver, "happy"), 0.7, 1e-3, "the emotion shows");

        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0.05f, 0));
            driver.Update(1f / 60f);
        }

        CheckNear(WeightOf(driver, "aa"), 0.05, 1e-3, "lip sync takes the mouth, also with a small weight");
        CheckNear(WeightOf(driver, "happy"), 0.7, 1e-3, "the emotion stays in speech");

        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0));
            driver.Update(1f / 60f);
        }

        CheckNear(WeightOf(driver, "aa"), 0.2, 1e-3, "the vowel of the emotion comes back after the speech");

        // The VRM stage holds the blink while an expression owns the eyes.
        var vrmBlink = new CharacterDriver(() => 0);
        vrmBlink.StartModel(EmotionTable.Vrm);
        vrmBlink.SetExpression("happy", 1, 1e9f);
        float vrmMost = 0;
        for (int frame = 0; frame < 120; frame++)
        {
            vrmBlink.Update(1f / 60f);
            vrmMost = Math.Max(vrmMost, WeightOf(vrmBlink, "blink"));
        }

        CheckClose(vrmMost, 0, "an expression holds the VRM blink");

        var neutralBlink = new CharacterDriver(() => 0);
        neutralBlink.StartModel(EmotionTable.Vrm);
        float neutralMost = 0;
        for (int frame = 0; frame < 120; frame++)
        {
            neutralBlink.Update(1f / 60f);
            neutralMost = Math.Max(neutralMost, WeightOf(neutralBlink, "blink"));
        }

        Check(neutralMost > 0.5f, $"a VRM model blinks without an expression: {neutralMost}");

        // The MMD stage keeps the blink, and its names are slots.
        var mmd = new CharacterDriver(() => 0);
        mmd.StartModel(EmotionTable.Mmd);
        foreach (string name in new[] { MorphSlots.VowelA, MorphSlots.VowelO, MorphSlots.Blink, "smile" })
        {
            Check(mmd.WeightNames.Contains(name), $"the MMD weights have {name}");
        }

        Check(mmd.WeightNames.All(name => MorphSlots.Candidates.ContainsKey(name)), "each MMD weight is a slot");
        mmd.SetExpression("happy", 1, null);
        float mmdMost = 0;
        for (int frame = 0; frame < 120; frame++)
        {
            mmd.Update(1f / 60f);
            mmdMost = Math.Max(mmdMost, WeightOf(mmd, MorphSlots.Blink));
        }

        Check(mmdMost > 0.5f, $"an expression leaves the MMD blink: {mmdMost}");
        CheckNear(WeightOf(mmd, "smile"), 0.8, 1e-3, "the MMD emotion shows");

        // A new model drops a gesture and an expression of the old model, and it keeps the idle.
        driver.PlayGesture(new HoldClip(5f, TurnZ, 0, "neck"), wholeBody: false);
        driver.StartModel(EmotionTable.Mmd);
        driver.Update(0.5f);
        CheckNear(WeightOf(driver, "smile"), 0, 1e-3, "a new model starts with a neutral face");
        CheckSameRotation(driver.Pose.Rotations[HumanBones.IndexOf("neck")], StageQuaternion.Identity, "a new model ends the gesture");
        Check(driver.PlayGesture(new HoldClip(1f, TurnX, 0, "head"), wholeBody: false), "a gesture plays on the new model");
        Check(driver.PlayGesture(new HoldClip(1f, TurnX, 0, "leftUpperLeg"), wholeBody: true), "a clip of the whole body plays");
    }

    private static void TestHumanBones(JObject mmd)
    {
        var bones = (JArray)mmd["humanBones"];
        Check(bones.Count == HumanBones.Count, $"human bones: {HumanBones.Count} != {bones.Count}");

        foreach (JToken bone in bones)
        {
            string name = (string)bone["name"];
            int index = HumanBones.IndexOf(name);
            Check(index >= 0, $"the human bone {name} is missing");
            if (index < 0)
            {
                continue;
            }

            Check(HumanBones.MmdNameOf(index) == (string)bone["mmd"], $"the MMD bone of {name}");
            string group = (string)bone["group"];
            GestureGroup expected = group switch
            {
                "head" => GestureGroup.Head,
                "torso" => GestureGroup.Torso,
                "leftArm" => GestureGroup.LeftArm,
                "rightArm" => GestureGroup.RightArm,
                _ => GestureGroup.None,
            };
            Check(HumanBones.GroupOf(index) == expected, $"the group of {name}: {HumanBones.GroupOf(index)} != {group}");
        }

        for (int index = 0; index < HumanBones.Count; index++)
        {
            Check(HumanBones.ParentOf(index) < index, $"the parent of {HumanBones.NameOf(index)} comes first");
        }
    }

    private static KeyframeClip ClipOf(JToken gesture)
    {
        var tracks = new List<RotationTrack>();
        foreach (JToken track in (JArray)gesture["tracks"])
        {
            tracks.Add(new RotationTrack(
                (string)track["bone"],
                track["times"].Select(time => (float)time).ToArray(),
                track["values"].Select(value => (float)value).ToArray()));
        }

        return new KeyframeClip((float)gesture["duration"], tracks);
    }

    private static void TestGestureKeys(JObject gestures)
    {
        CheckClose(GestureMixer.Crossfade, (double)gestures["crossfade"], "the cross-fade");

        var seen = new List<string>();
        foreach (JToken gesture in (JArray)gestures["gestures"])
        {
            string id = (string)gesture["id"];
            seen.Add(id);
            KeyframeClip clip = ClipOf(gesture);
            var pose = new StagePose();

            foreach (JToken track in (JArray)gesture["tracks"])
            {
                string bone = (string)track["bone"];
                int index = HumanBones.IndexOf(bone);
                Check(index >= 0, $"{id} moves the known bone {bone}");
                Check(clip.Bones.Contains(index), $"{id} plays {bone}");

                float[] times = track["times"].Select(time => (float)time).ToArray();
                float[] values = track["values"].Select(value => (float)value).ToArray();
                for (int key = 0; key < times.Length; key++)
                {
                    clip.Sample(times[key], pose);
                    CheckSameRotation(
                        pose.Rotations[index],
                        new StageQuaternion(values[key * 4], values[key * 4 + 1], values[key * 4 + 2], values[key * 4 + 3]),
                        $"{id} {bone} at key {key}");
                }
            }
        }

        Check(seen.Count == 8, $"built-in gestures in the fixture: {seen.Count}");
    }

    private static void TestRetarget(JObject mmd)
    {
        JArray rig = (JArray)mmd["rig"];
        List<string> names = rig.Select(bone => (string)bone["name"]).ToList();
        MmdRigBone[] bones = rig.Select(bone =>
        {
            string parent = (string)bone["parent"];
            JToken position = bone["position"];

            // The rig of the fixture is in the frame of three-mmd, and a PMX file has Z inverted.
            return new MmdRigBone(
                (string)bone["name"],
                parent != null ? names.IndexOf(parent) : -1,
                (float)position[0],
                (float)position[1],
                -(float)position[2]);
        }).ToArray();

        var retarget = new MmdHumanoidRetarget(bones);
        var positions = new float[bones.Length * 3];
        var rotations = new float[bones.Length * 4];
        int centerIndex = names.IndexOf("センター");

        Check(retarget.DrivenBones.Contains(centerIndex), "the hips drive the center");
        CheckClose(retarget.HipHeight, 9, "the hip height");

        foreach (JToken entry in (JArray)mmd["retarget"])
        {
            string id = (string)entry["id"];
            foreach (JToken frame in (JArray)entry["frames"])
            {
                float time = (float)frame["time"];
                var pose = new StagePose();
                foreach (JProperty input in ((JObject)frame["input"]).Properties())
                {
                    pose.Rotations[HumanBones.IndexOf(input.Name)] = ToRotation(input.Value);
                }

                pose.HipsX = (float)frame["hips"][0];
                pose.HipsY = (float)frame["hips"][1];
                pose.HipsZ = (float)frame["hips"][2];

                Array.Clear(positions, 0, positions.Length);
                retarget.Apply(pose, 0, 0, positions, rotations);

                foreach (JProperty expected in ((JObject)frame["rotations"]).Properties())
                {
                    int index = names.IndexOf(expected.Name);
                    Check(index >= 0, $"{id} writes the known bone {expected.Name}");
                    if (index < 0)
                    {
                        continue;
                    }

                    // The fixture is in the frame of three-mmd, and the output has Z mirrored.
                    var actual = new StageQuaternion(
                        -rotations[index * 4],
                        -rotations[index * 4 + 1],
                        rotations[index * 4 + 2],
                        rotations[index * 4 + 3]);
                    CheckSameRotation(actual, ToRotation(expected.Value), $"{id} {expected.Name} at {time}");

                    double length = Math.Sqrt(actual.X * actual.X + actual.Y * actual.Y + actual.Z * actual.Z + actual.W * actual.W);
                    CheckNear(length, 1, 1e-5, $"{id} {expected.Name} keeps a length of 1");
                }

                JToken center = frame["centerOffset"];
                CheckNear(positions[centerIndex * 3], (float)center[0], FixtureTolerance * 10, $"{id} center x at {time}");
                CheckNear(positions[centerIndex * 3 + 1], (float)center[1], FixtureTolerance * 10, $"{id} center y at {time}");
                CheckNear(-positions[centerIndex * 3 + 2], (float)center[2], FixtureTolerance * 10, $"{id} center z at {time}");
            }
        }

        // A bone that the retarget does not know keeps its rest rotation.
        int lower = names.IndexOf("下半身");
        CheckClose(rotations[lower * 4 + 3], 1, "the lower body stays at rest");

        // A model without the standard bones skips those parts, and it still gives valid numbers.
        var small = new MmdHumanoidRetarget(new[] { new MmdRigBone("頭", -1, 0, 15, 0) });
        Check(small.DrivenBones.Count == 1, "a small model drives its one known bone");
        CheckClose(small.HipHeight, 0, "a model without hips has no hip height");
        var smallPositions = new float[3];
        var smallRotations = new float[4];
        small.Apply(new StagePose(), 0, 0, smallPositions, smallRotations);
        CheckClose(smallRotations[3], 1, "the small model stays at rest");

        TestRetargetEyes();
    }

    private static void TestRetargetEyes()
    {
        MmdRigBone[] bones =
        {
            new MmdRigBone("頭", -1, 0, 15, 0),
            new MmdRigBone("両目", 0, 0, 16, 0),
            new MmdRigBone("左目", 0, 0.3f, 16, 0),
            new MmdRigBone("右目", 0, -0.3f, 16, 0),
        };
        var retarget = new MmdHumanoidRetarget(bones);
        Check(retarget.DrivenBones.Contains(2) && retarget.DrivenBones.Contains(3), "the host drives the two eyes");
        Check(!retarget.DrivenBones.Contains(1), "a model with two eyes leaves its control bone");

        var positions = new float[bones.Length * 3];
        var rotations = new float[bones.Length * 4];
        retarget.Apply(new StagePose(), 0.2f, -0.1f, positions, rotations);

        // `createGazeController` sets `Euler(pitch, yaw, 0)` in the frame of three-mmd.
        StageQuaternion expected = HumanoidFrame.FromEuler(new BodyRotation(-0.1f, 0.2f, 0));
        foreach (int eye in new[] { 2, 3 })
        {
            CheckClose(-rotations[eye * 4], expected.X, "an eye turns on X");
            CheckClose(-rotations[eye * 4 + 1], expected.Y, "an eye turns on Y");
            CheckClose(rotations[eye * 4 + 2], expected.Z, "an eye turns on Z");
            CheckClose(rotations[eye * 4 + 3], expected.W, "an eye turns on W");
        }

        CheckClose(rotations[1 * 4 + 3], 1, "the control bone stays at rest");

        // The eyes stop at the limits of the three.js stage.
        retarget.Apply(new StagePose(), 9f, 9f, positions, rotations);
        StageQuaternion limited = HumanoidFrame.FromEuler(new BodyRotation(0.25f, 0.35f, 0));
        CheckClose(-rotations[2 * 4], limited.X, "the pitch stops at its limit");
        CheckClose(-rotations[2 * 4 + 1], limited.Y, "the yaw stops at its limit");

        var both = new MmdHumanoidRetarget(new[] { new MmdRigBone("頭", -1, 0, 15, 0), new MmdRigBone("両目", 0, 0, 16, 0) });
        Check(both.DrivenBones.Contains(1), "a model without two eyes uses its control bone");
    }

    private static void TestMorphCandidates(JObject mmd)
    {
        var expected = (JObject)mmd["morphCandidates"];
        Check(expected.Count == MorphSlots.Candidates.Count, $"morph slots: {MorphSlots.Candidates.Count} != {expected.Count}");

        foreach (JProperty slot in expected.Properties())
        {
            Check(MorphSlots.Candidates.ContainsKey(slot.Name), $"the morph slot {slot.Name} is missing");
            if (MorphSlots.Candidates.TryGetValue(slot.Name, out string[] candidates))
            {
                Check(
                    candidates.SequenceEqual(slot.Value.Select(name => (string)name)),
                    $"the candidates of {slot.Name}");
            }
        }

        var available = new HashSet<string> { "A", "あ", "にこり", "unrelated" };
        Dictionary<string, string> resolved = MorphSlots.Resolve(available.Contains);
        Check(resolved[MorphSlots.VowelA] == "あ", "the first candidate wins");
        Check(resolved["smile"] == "にこり", "a later candidate serves a slot");
        Check(!resolved.ContainsKey(MorphSlots.Blink), "a slot without a morph is absent");
    }

    private static void TestEmotionTables(JObject mmd, JObject emotions)
    {
        foreach (JToken emotion in (JArray)emotions["emotions"])
        {
            string name = (string)emotion;
            string expected = (string)emotions["vrmExpressions"][name];
            Check(EmotionTable.Vrm.Find(name, out string vrmName) != null, $"the VRM table shows {name}");
            Check(vrmName == expected, $"the VRM expression of {name}: {vrmName} != {expected}");

            EmotionState state = EmotionTable.Mmd.Find(name, out string mmdName);
            Check(mmdName == name, $"the MMD table keeps {name}");
            JToken source = mmd["emotions"][name];
            CheckClose(state.BlendSeconds, (double)source["blendDuration"], $"the MMD blend of {name}");
            var influences = (JArray)source["influences"];
            Check(state.Targets.Count == influences.Count, $"the MMD targets of {name}");
            foreach (JToken influence in influences)
            {
                string slot = (string)influence["slot"];
                Check(state.Targets.ContainsKey(slot), $"the MMD target {slot} of {name}");
                CheckClose(state.Targets[slot], (double)influence["value"], $"the MMD weight {slot} of {name}");
                Check(MorphSlots.Candidates.ContainsKey(slot), $"the slot {slot} has candidates");
            }
        }

        Check(EmotionTable.Vrm.Find("unknown", out _) == null, "the VRM table ignores an unknown name");
        EmotionTable.Mmd.Find("unknown", out string fallback);
        Check(fallback == "neutral", "the MMD table shows neutral for an unknown name");
    }

    private static void TestVrmExpressionTimeline(JObject vrm)
    {
        var fader = new ExpressionFader(EmotionTable.Vrm);
        List<string> owned = vrm["owned"].Select(name => (string)name).ToList();
        Check(
            owned.OrderBy(name => name, StringComparer.Ordinal).SequenceEqual(EmotionTable.Vrm.OwnedNames.OrderBy(name => name, StringComparer.Ordinal)),
            "the names of the VRM table");

        int step = 0;
        foreach (JToken entry in (JArray)vrm["timeline"])
        {
            step++;
            if (entry["set"] != null)
            {
                // The timeline has no timer, so the hold stays out of this replay.
                fader.Set((string)entry["set"], (float)entry["intensity"], 1e9f);
                continue;
            }

            fader.Update((float)entry["update"], (bool)entry["mouthBusy"]);
            foreach (string name in owned)
            {
                CheckNear(fader.WeightOf(name), (double)entry["weights"][name], FixtureTolerance, $"VRM step {step} {name}");
            }

            Check(fader.HidesBlink == (bool)entry["eyeAreaActive"], $"VRM step {step} blink: {fader.HidesBlink}");
        }
    }

    private static void TestMmdExpressionTimeline(JObject mmd)
    {
        var fader = new ExpressionFader(EmotionTable.Mmd);
        int step = 0;
        foreach (JToken entry in (JArray)mmd["emoteTimeline"])
        {
            step++;
            if (entry["set"] != null)
            {
                fader.Set((string)entry["set"], (float)entry["intensity"], null);
                continue;
            }

            fader.Update((float)entry["update"], false);
            foreach (JProperty weight in ((JObject)entry["weights"]).Properties())
            {
                CheckNear(fader.WeightOf(weight.Name), (double)weight.Value, FixtureTolerance, $"MMD step {step} {weight.Name}");
            }

            Check(!fader.HidesBlink, $"MMD step {step}: an expression never stops the blink");
        }
    }

    private static void TestExpressionHold()
    {
        var vrm = new ExpressionFader(EmotionTable.Vrm);
        vrm.Set("happy", 1, null);
        vrm.Update(1f, false);
        CheckClose(vrm.WeightOf("happy"), 0.7, "VRM happy shows");
        vrm.Update(1.9f, false);
        CheckClose(vrm.WeightOf("happy"), 0.7, "VRM happy holds until its default hold");
        vrm.Update(0.2f, false);
        vrm.Update(1f, false);
        CheckClose(vrm.WeightOf("happy"), 0, "VRM happy leaves after 3 seconds");
        CheckClose(vrm.WeightOf("neutral"), 1, "VRM neutral comes back");
        Check(!vrm.HidesBlink, "VRM neutral allows the blink");

        var mmd = new ExpressionFader(EmotionTable.Mmd);
        mmd.Set("happy", 1, null);
        mmd.Update(100f, false);
        CheckClose(mmd.WeightOf("smile"), 0.8, "MMD happy stays without a hold");
        mmd.Set("happy", 0.5f, 1000f);
        mmd.Update(0.9f, false);
        CheckClose(mmd.WeightOf("smile"), 0.4, "MMD happy follows the intensity");
        mmd.Update(0.2f, false);
        mmd.Update(1f, false);
        CheckClose(mmd.WeightOf("smile"), 0, "MMD happy leaves after its own hold");

        var quiet = new ExpressionFader(EmotionTable.Vrm);
        quiet.Set("happy", 0, null);
        quiet.Update(1f, false);
        CheckClose(quiet.WeightOf("happy"), 0, "an intensity of 0 does nothing");
        quiet.Set("unknown", 1, null);
        quiet.Update(1f, false);
        CheckClose(quiet.WeightOf("neutral"), 0, "the VRM table ignores an unknown name");
        CheckClose(quiet.WeightOf("not owned"), 0, "a name outside the table has no weight");
    }

    /// <summary>A clip that holds one rotation on each of its bones.</summary>
    private sealed class HoldClip : IHumanClip
    {
        private readonly StageQuaternion _rotation;
        private readonly int[] _bones;
        private readonly float _hipsY;

        public HoldClip(float duration, StageQuaternion rotation, float hipsY, params string[] bones)
        {
            Duration = duration;
            _rotation = rotation;
            _hipsY = hipsY;
            _bones = bones.Select(HumanBones.IndexOf).ToArray();
        }

        public float Duration { get; }

        public IReadOnlyList<int> Bones => _bones;

        public void Sample(float time, StagePose pose)
        {
            foreach (int bone in _bones)
            {
                pose.Rotations[bone] = _rotation;
            }

            pose.HipsY = _hipsY;
        }
    }

    private static readonly StageQuaternion TurnX = new StageQuaternion(0.70710677f, 0, 0, 0.70710677f);
    private static readonly StageQuaternion TurnZ = new StageQuaternion(0, 0, 0.70710677f, 0.70710677f);

    /// <summary>The share of <paramref name="target"/> in a rotation that goes from identity to it.</summary>
    private static double ShareOf(StageQuaternion rotation, StageQuaternion target)
    {
        double dot = Math.Min(1.0, Math.Abs(rotation.X * target.X + rotation.Y * target.Y + rotation.Z * target.Z + rotation.W * target.W));
        return (Math.PI / 4 - Math.Acos(dot)) / (Math.PI / 4);
    }

    private static void TestGestureMixerWeights()
    {
        int head = HumanBones.IndexOf("head");
        var mixer = new GestureMixer();
        var pose = new StagePose();
        var clip = new HoldClip(2f, TurnX, 0, "head");

        Check(mixer.PlayUpper(clip), "a head gesture plays");
        Check(mixer.IsPlaying, "the mixer reports the gesture");

        mixer.Update(0.2f, pose);
        CheckNear(ShareOf(pose.Rotations[head], TurnX), 0.5, 1e-3, "the gesture is at half weight in the middle of its fade");
        mixer.Update(0.8f, pose);
        CheckSameRotation(pose.Rotations[head], TurnX, "the gesture holds at full weight");

        // The fade back starts 0.2 seconds before the end, so the last frame is its middle.
        mixer.Update(0.8f, pose);
        CheckSameRotation(pose.Rotations[head], TurnX, "the gesture is at full weight when its fade starts");
        mixer.Update(0.2f, pose);
        CheckNear(ShareOf(pose.Rotations[head], TurnX), 0.5, 1e-3, "the end of the clip is the middle of the fade");
        Check(mixer.IsPlaying, "the gesture still fades");
        mixer.Update(0.2f, pose);
        CheckSameRotation(pose.Rotations[head], StageQuaternion.Identity, "the base returns");
        Check(!mixer.IsPlaying, "the gesture ended");

        // A clip that is shorter than the fade ends too, and it never reaches full weight.
        var tiny = new HoldClip(0.1f, TurnX, 0, "head");
        mixer.PlayUpper(tiny);
        double most = 0;
        for (int frame = 0; frame < 60; frame++)
        {
            mixer.Update(1f / 60f, pose);
            most = Math.Max(most, ShareOf(pose.Rotations[head], TurnX));
        }

        Check(most < 0.5, $"a short clip stays under full weight: {most}");
        Check(!mixer.IsPlaying, "a short clip ends");
    }

    private static void TestGestureMixerGroups()
    {
        int rightUpper = HumanBones.IndexOf("rightUpperArm");
        int rightLower = HumanBones.IndexOf("rightLowerArm");
        int leftUpper = HumanBones.IndexOf("leftUpperArm");
        int head = HumanBones.IndexOf("head");
        int hips = HumanBones.IndexOf("hips");
        int leg = HumanBones.IndexOf("leftUpperLeg");

        var mixer = new GestureMixer();
        var pose = new StagePose();
        mixer.SetIdle(new HoldClip(5f, TurnZ, 0.25f, "rightUpperArm", "leftUpperArm", "head", "hips", "leftUpperLeg"));

        mixer.Update(0.1f, pose);
        CheckSameRotation(pose.Rotations[rightUpper], TurnZ, "the idle moves the arm");
        CheckClose(pose.HipsY, 0.25, "the idle moves the hips");

        Check(mixer.PlayUpper(new HoldClip(3f, TurnX, 1f, "rightLowerArm")), "a right arm gesture plays");
        mixer.Update(1f, pose);

        CheckSameRotation(pose.Rotations[rightLower], TurnX, "the track of the gesture plays");
        CheckSameRotation(pose.Rotations[rightUpper], StageQuaternion.Identity, "a bone of the group without a track leaves the idle");
        CheckSameRotation(pose.Rotations[leftUpper], TurnZ, "the other arm keeps the idle");
        CheckSameRotation(pose.Rotations[head], TurnZ, "the head keeps the idle");
        CheckSameRotation(pose.Rotations[hips], TurnZ, "the hips keep the idle");
        CheckSameRotation(pose.Rotations[leg], TurnZ, "the leg keeps the idle");
        CheckClose(pose.HipsY, 0.25, "an upper-body gesture leaves the hips to the idle");

        var legs = new GestureMixer();
        Check(!legs.PlayUpper(new HoldClip(1f, TurnX, 0, "leftUpperLeg", "hips")), "a clip with no gesture part does not play");
        Check(!legs.IsPlaying, "the refused clip leaves no layer");

        var looped = new GestureMixer();
        var counter = new CountingClip(2f);
        looped.SetIdle(counter);
        looped.Update(1.5f, pose);
        CheckClose(counter.LastTime, 1.5, "the idle time runs");
        looped.Update(1f, pose);
        CheckClose(counter.LastTime, 0.5, "the idle loops");
    }

    private sealed class CountingClip : IHumanClip
    {
        public CountingClip(float duration)
        {
            Duration = duration;
        }

        public float LastTime { get; private set; }

        public float Duration { get; }

        public IReadOnlyList<int> Bones { get; } = Array.Empty<int>();

        public void Sample(float time, StagePose pose)
        {
            LastTime = time;
        }
    }

    private static void TestGestureMixerOverlap()
    {
        int head = HumanBones.IndexOf("head");
        int arm = HumanBones.IndexOf("rightUpperArm");
        var mixer = new GestureMixer();
        var pose = new StagePose();

        mixer.PlayUpper(new HoldClip(3f, TurnX, 0, "head"));
        mixer.Update(1f, pose);
        CheckSameRotation(pose.Rotations[head], TurnX, "the first gesture shows");

        // The old gesture must not jump away when the new one starts.
        mixer.PlayUpper(new HoldClip(3f, TurnZ, 0, "rightUpperArm"));
        mixer.Update(0.01f, pose);
        Check(ShareOf(pose.Rotations[head], TurnX) > 0.9, "the old gesture fades out and does not jump");
        mixer.Update(0.5f, pose);
        CheckSameRotation(pose.Rotations[head], StageQuaternion.Identity, "the old gesture is gone");
        CheckSameRotation(pose.Rotations[arm], TurnZ, "the new gesture plays");
    }

    private static void TestGestureMixerWholeBody()
    {
        int leg = HumanBones.IndexOf("leftUpperLeg");
        int head = HumanBones.IndexOf("head");
        var mixer = new GestureMixer();
        var pose = new StagePose();
        mixer.SetIdle(new HoldClip(5f, TurnZ, 0f, "head", "leftUpperLeg"));

        mixer.PlayWholeBody(new HoldClip(1f, TurnX, 0.5f, "leftUpperLeg"));
        mixer.Update(0.2f, pose);
        CheckNear(pose.HipsY, 0.25, 1e-3, "the hips follow the weight of the clip");
        mixer.Update(0.3f, pose);
        CheckSameRotation(pose.Rotations[leg], TurnX, "the clip moves the leg");
        CheckSameRotation(pose.Rotations[head], StageQuaternion.Identity, "a bone without a track leaves the idle");
        CheckClose(pose.HipsY, 0.5, "the clip owns the hips");

        Check(!mixer.PlayUpper(new HoldClip(1f, TurnZ, 0, "rightUpperArm")), "the whole body wins over a gesture");

        // A clip of the whole body plays to its end, and only then it fades.
        mixer.Update(0.49f, pose);
        CheckSameRotation(pose.Rotations[leg], TurnX, "the clip holds to its end");
        mixer.Update(0.2f, pose);
        mixer.Update(0.3f, pose);
        CheckSameRotation(pose.Rotations[leg], TurnZ, "the idle returns");
        Check(!mixer.IsPlaying, "the clip ended");

        // A new clip of the whole body replaces an upper-body gesture.
        mixer.PlayUpper(new HoldClip(5f, TurnX, 0, "rightUpperArm"));
        mixer.Update(1f, pose);
        mixer.PlayWholeBody(new HoldClip(5f, TurnX, 0, "leftUpperLeg"));
        mixer.Update(1f, pose);
        CheckSameRotation(pose.Rotations[leg], TurnX, "the clip of the whole body plays");

        mixer.Clear();
        Check(!mixer.IsPlaying, "a clear removes each gesture");
    }

    private static void TestBlink()
    {
        // A random number of 0 gives the shortest interval: 1 second.
        var blink = new BlinkTimer(() => 0);
        blink.Update(0.9f, false);
        CheckClose(blink.Weight, 0, "no blink before the interval");
        blink.Update(0.1f, false);

        // The first frame of the blink advances by its own time, so a short step keeps it near the start.
        CheckNear(blink.Weight, Math.Sin(Math.PI * 0.5), 1e-3, "the blink follows a sine curve");
        blink.Update(0.05f, false);
        CheckNear(blink.Weight, Math.Sin(Math.PI * 0.75), 1e-3, "the blink opens again");
        blink.Update(0.05f, false);
        CheckClose(blink.Weight, 0, "the blink ended");
        blink.Update(0.5f, false);
        CheckClose(blink.Weight, 0, "the next interval runs");

        // An expression that starts in a blink holds the lids open until the cycle ends.
        var suppressed = new BlinkTimer(() => 0);
        suppressed.Update(0.99f, false);
        suppressed.Update(0.02f, false);
        Check(suppressed.Weight > 0, "the blink started");
        suppressed.Update(0.01f, true);
        CheckClose(suppressed.Weight, 0, "the expression holds the lids open");
        suppressed.Update(0.01f, false);
        CheckClose(suppressed.Weight, 0, "the lids stay open until the cycle ends");
        suppressed.Update(0.2f, false);
        suppressed.Update(0.99f, false);
        suppressed.Update(0.02f, false);
        Check(suppressed.Weight > 0, "the next cycle blinks again");

        // The longest interval is 6 seconds.
        var longest = new BlinkTimer(() => 0.999999);
        longest.Update(5.9f, false);
        CheckClose(longest.Weight, 0, "the longest interval runs");
        longest.Update(0.11f, false);
        Check(longest.Weight > 0, "the blink comes after the longest interval");
    }

    private static CharacterFrameMessage FrameWithMouth(float a, float headX)
    {
        var rest = new BodyRotation(0, 0, 0);
        return new CharacterFrameMessage(
            new MouthWeights(a, 0, 0, 0, 0),
            rest,
            rest,
            rest,
            new BodyRotation(headX, 0, 0),
            0.2f,
            -0.1f);
    }

    private static void TestFrameFollower()
    {
        var follower = new FrameFollower();
        follower.Update(1f / 60f);
        CheckClose(follower.Mouth.A, 0, "no frame keeps the mouth closed");
        Check(!follower.MouthBusy, "a closed mouth is not busy");

        follower.Receive(FrameWithMouth(1f, 0.3f));
        follower.Update(1f / 60f);
        Check(follower.Mouth.A > 0.2f && follower.Mouth.A < 0.6f, $"one frame moves part of the way: {follower.Mouth.A}");
        Check(follower.MouthBusy, "an open mouth is busy");

        float last = follower.Mouth.A;
        for (int frame = 0; frame < 20; frame++)
        {
            follower.Receive(FrameWithMouth(1f, 0.3f));
            follower.Update(1f / 60f);
            Check(follower.Mouth.A >= last, "the mouth moves without a step back");
            last = follower.Mouth.A;
        }

        CheckNear(follower.Mouth.A, 1, 1e-2, "the mouth reaches the frame");
        CheckNear(follower.Head.X, 0.3, 1e-2, "the head reaches the frame");
        CheckNear(follower.EyesYaw, 0.2, 1e-2, "the eyes reach the frame");
        CheckNear(follower.EyesPitch, -0.1, 1e-2, "the eyes reach the frame");

        // The stream stops. The values hold until the deadline, and then they fade to zero.
        for (float time = 0; time < FrameFollower.DeadlineSeconds - 0.05f; time += 1f / 60f)
        {
            follower.Update(1f / 60f);
        }

        CheckNear(follower.Mouth.A, 1, 1e-2, "the mouth holds before the deadline");
        for (int frame = 0; frame < 120; frame++)
        {
            follower.Update(1f / 60f);
        }

        CheckNear(follower.Mouth.A, 0, 1e-2, "the mouth closes after the deadline");
        CheckNear(follower.Head.X, 0, 1e-2, "the head returns after the deadline");
        CheckNear(follower.EyesYaw, 0, 1e-2, "the eyes return after the deadline");
        Check(!follower.MouthBusy, "a faded mouth is not busy");

        // A long pause of the display does not jump past the frame.
        follower.Receive(FrameWithMouth(1f, 0));
        follower.Update(10f);
        CheckNear(follower.Mouth.A, 0, 1e-2, "a frame older than the deadline does not open the mouth");

        // The stream comes back.
        for (int frame = 0; frame < 30; frame++)
        {
            follower.Receive(FrameWithMouth(0.5f, 0));
            follower.Update(1f / 60f);
        }

        CheckNear(follower.Mouth.A, 0.5, 1e-2, "the stream comes back");
    }
}
