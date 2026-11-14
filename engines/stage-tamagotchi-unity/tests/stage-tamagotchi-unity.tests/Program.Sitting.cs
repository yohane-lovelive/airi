using System;
using System.Collections.Generic;
using System.Linq;
using Airi.Stage.Core;

/// <summary>Tests of the sit: the sit clips, the fit of a seat, the rests at places, and the turn of the spine.</summary>
public static partial class Program
{
    /// <summary>A clip that holds one rotation on its bones, and fixed hips.</summary>
    private sealed class PoseClip : IHumanClip
    {
        private readonly StageQuaternion _rotation;
        private readonly int[] _bones;
        private readonly float _hipsX;
        private readonly float _hipsY;
        private readonly float _hipsZ;

        public PoseClip(float duration, StageQuaternion rotation, float hipsX, float hipsY, float hipsZ, params string[] bones)
        {
            Duration = duration;
            _rotation = rotation;
            _hipsX = hipsX;
            _hipsY = hipsY;
            _hipsZ = hipsZ;
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

            pose.HipsX = _hipsX;
            pose.HipsY = _hipsY;
            pose.HipsZ = _hipsZ;
        }
    }

    private static readonly StageQuaternion TurnY = new StageQuaternion(0, 0.70710677f, 0, 0.70710677f);

    private static void TestSitting()
    {
        TestSeatMotion();
        TestSeatMotionTalk();
        TestSeatMotionGestures();
        TestSitFit();
        TestWanderPlaces();
        TestWanderPlaceChoice();
        TestGazeSpine();
        TestSitLaunchAndThigh();
    }

    /// <summary>Clips of a sit. The enter and the exit last 1 second. The loops hold the hips 0.4 hip heights down and 0.1 back.</summary>
    private static (PoseClip Enter, PoseClip Idle, PoseClip Talk, PoseClip Exit) SitClips()
    {
        return (
            new PoseClip(1f, TurnX, 0, -0.4f, -0.1f, "leftUpperLeg"),
            new PoseClip(2f, TurnX, 0.02f, -0.4f, -0.1f, "leftUpperLeg", "spine"),
            new PoseClip(3f, TurnZ, 0.02f, -0.4f, -0.1f, "leftUpperLeg", "spine"),
            new PoseClip(1f, TurnY, 0, -0.04f, 0, "leftUpperLeg"));
    }

    /// <summary>Runs the mixer in steps of 1/60 second. It counts whole frames, so a sum of steps does not add a frame.</summary>
    private static void RunMixer(GestureMixer mixer, StagePose pose, double seconds)
    {
        int frames = (int)Math.Round(seconds * 60);
        for (int frame = 0; frame < frames; frame++)
        {
            mixer.Update(1f / 60f, pose);
        }
    }

    private static void TestSeatMotion()
    {
        int leg = HumanBones.IndexOf("leftUpperLeg");
        var mixer = new GestureMixer();
        var pose = new StagePose();
        mixer.SetIdle(new HoldClip(5f, StageQuaternion.Identity, 0, "leftUpperLeg"));
        SeatMotion seat = mixer.Seat;
        Check(!seat.HasClips && !seat.Sit(), "she cannot sit without the clips");

        (PoseClip enter, PoseClip idle, PoseClip talk, PoseClip exit) = SitClips();
        seat.SetClips(enter, idle, talk, exit);
        CheckNear(seat.SeatedHipsY, -0.4, 1e-6, "the seated hips come from the idle loop");
        CheckNear(seat.SeatedHipsZ, -0.1, 1e-6, "the seated hips keep their move back");
        Check(seat.StandUp() == false, "she cannot get up while she stands");

        Check(seat.Sit() && seat.Phase == SeatPhase.Entering, "the enter clip starts");
        Check(!seat.Sit(), "she cannot sit down twice");
        RunMixer(mixer, pose, SeatMotion.LayerFade / 2);
        CheckNear(seat.Weight, 0.5, 0.02, "the layer fades in");

        RunMixer(mixer, pose, 1.0);
        Check(seat.Phase == SeatPhase.Seated, "the idle loop follows the enter clip");
        RunMixer(mixer, pose, 1.0);
        CheckSameRotation(pose.Rotations[leg], TurnX, "the idle loop gives the legs");
        CheckNear(pose.HipsY, -0.4, 1e-5, "the hips go down");
        CheckNear(pose.HipsZ, -0.1, 1e-5, "the hips keep their move back");
        CheckNear(pose.HipsX, 0.02, 1e-5, "the hips keep their move to the side");
        CheckNear(seat.Depth, 1, 1e-5, "she sits fully");

        Check(seat.StandUp() && seat.Phase == SeatPhase.Exiting, "the exit clip starts");
        RunMixer(mixer, pose, 1.0 + (SeatMotion.LayerFade / 2));
        Check(seat.Phase == SeatPhase.Standing, "she stands after the exit clip");
        Check(seat.Weight > 0.3 && seat.Weight < 0.7, $"the layer fades out after the exit clip: {seat.Weight}");
        CheckNear(ShareOf(pose.Rotations[leg], TurnY), seat.Weight, 0.02, "the layer holds the end of the exit clip while it fades");
        RunMixer(mixer, pose, SeatMotion.LayerFade);
        CheckNear(seat.Weight, 0, 1e-6, "the layer fades out");
        CheckNear(seat.Depth, 0, 1e-6, "she stands fully");
        CheckSameRotation(pose.Rotations[leg], StageQuaternion.Identity, "the idle returns");
        CheckNear(pose.HipsY, 0, 1e-6, "the hips of the idle return");

        Check(seat.Sit(), "she can sit again");
        RunMixer(mixer, pose, 2.0);
        mixer.Clear();
        Check(seat.Phase == SeatPhase.Standing && seat.Weight == 0, "a new model stands her up at once");
    }

    private static void TestSeatMotionTalk()
    {
        int leg = HumanBones.IndexOf("leftUpperLeg");
        var mixer = new GestureMixer();
        var pose = new StagePose();
        (PoseClip enter, PoseClip idle, PoseClip talk, PoseClip exit) = SitClips();
        mixer.Seat.SetClips(enter, idle, talk, exit);
        mixer.Seat.Sit();
        RunMixer(mixer, pose, 2.0);

        mixer.Seat.SetTalking(true);
        RunMixer(mixer, pose, SeatMotion.ClipFade / 2);
        // The two loops lie 120 degrees apart, so the middle of the fade gives a share of about 1/3.
        double half = ShareOf(pose.Rotations[leg], TurnZ);
        Check(half > 0.2 && half < 0.6, $"the talk loop fades in: {half}");
        RunMixer(mixer, pose, SeatMotion.ClipFade);
        CheckSameRotation(pose.Rotations[leg], TurnZ, "the talk loop plays while she talks");

        mixer.Seat.SetTalking(false);
        RunMixer(mixer, pose, SeatMotion.ClipFade + 0.05);
        CheckSameRotation(pose.Rotations[leg], TurnX, "the idle loop returns after the talk");
        CheckNear(mixer.Seat.Depth, 1, 1e-5, "the talk does not change the depth");
    }

    private static void TestSeatMotionGestures()
    {
        int leg = HumanBones.IndexOf("leftUpperLeg");
        int head = HumanBones.IndexOf("head");
        var mixer = new GestureMixer();
        var pose = new StagePose();
        (PoseClip enter, PoseClip idle, PoseClip talk, PoseClip exit) = SitClips();
        mixer.Seat.SetClips(enter, idle, talk, exit);
        Check(mixer.PlayWholeBody(new HoldClip(1f, TurnZ, 0, "leftUpperLeg")), "a clip of the whole body plays while she stands");
        RunMixer(mixer, pose, 1.5);

        mixer.Seat.Sit();
        RunMixer(mixer, pose, 2.0);
        Check(!mixer.PlayWholeBody(new HoldClip(1f, TurnZ, 0, "leftUpperLeg")), "a clip of the whole body does not play while she sits");
        Check(mixer.PlayUpper(new HoldClip(2f, TurnZ, 0, "head")), "an upper-body gesture plays while she sits");
        RunMixer(mixer, pose, 1.0);
        CheckSameRotation(pose.Rotations[head], TurnZ, "the gesture lies over the sit");
        CheckSameRotation(pose.Rotations[leg], TurnX, "the legs keep the sit under the gesture");
    }

    private static void TestSitFit()
    {
        // She faces +Z. The seat is 0.5 m high, her thighs are 0.4 m long, and the loop puts her hips 0.1 m back.
        StageSitFit fit = StageSit.Fit(new StagePoint(0, 0.5, 1), 0, 0, 0.8, 0.4, 0, 0.8 * 0.6, -0.1);
        double hipsZ = 1 - (0.4 - StageSit.KneeClearance);
        CheckNear(fit.Hips.Z, hipsZ, 1e-9, "the hips go behind the seat point by the thighs, less the margin of the knees");
        CheckNear(fit.Root.X, 0, 1e-9, "the root stays on the line of the seat");
        CheckNear(fit.Root.Z, hipsZ + 0.1, 1e-9, "the root lies in front of the hips by their move back");
        double hips = 0.5 + (StageSit.SeatClearance * 0.8);
        CheckNear(fit.Hips.Y, hips, 1e-9, "the hip joints lie a little above the seat");
        CheckNear(fit.Lift, hips - 0.48, 1e-9, "short legs lift the root, so the feet hang");
        CheckNear(fit.Root.Y, fit.Lift, 1e-9, "the root lies above the floor by the lift");
        CheckNear(fit.HipsGap, 0, 1e-9, "the hips rest on the seat");

        // She faces +X. Her right is then -Z, so hips on her right put the root at +Z.
        fit = StageSit.Fit(new StagePoint(2, 0.5, 0), 90, 0, 0.8, 0.4, 0.05, 0.48, -0.1);
        CheckNear(fit.Root.X, 2 - (0.4 - StageSit.KneeClearance) + 0.1, 1e-9, "a turned seat turns the fit");
        CheckNear(fit.Root.Z, 0.05, 1e-9, "the move of the hips to her right turns too");

        // Long legs sink the feet only by the limit, and lift the hips for the rest.
        fit = StageSit.Fit(new StagePoint(0, 0.4, 0), 0, 0, 1.2, 0.6, 0, 1.2 * 0.6, 0);
        double wanted = 0.4 + (StageSit.SeatClearance * 1.2) - 0.72;
        CheckNear(fit.Lift, -StageSit.DeepestSink, 1e-9, "the feet sink at most to the limit");
        CheckNear(fit.HipsGap, -StageSit.DeepestSink - wanted, 1e-9, "the hips stay above the seat for the rest");
        CheckNear(fit.Hips.Y, 0.4 + (StageSit.SeatClearance * 1.2) + fit.HipsGap, 1e-9, "the hips report their place above the seat");

        // Thighs shorter than the margin keep the hips on the seat point.
        fit = StageSit.Fit(new StagePoint(0, 0.4, 1), 0, 0, 0.5, 0.05, 0, 0.3, 0);
        CheckNear(fit.Hips.Z, 1, 1e-9, "the hips never go in front of the seat point");

        // A floor above 0 moves the root with it.
        fit = StageSit.Fit(new StagePoint(0, 0.2, 1), 0, -0.3, 0.8, 0.4, 0, 0.48, -0.1);
        CheckNear(fit.Root.Y, -0.3 + fit.Lift, 1e-9, "the root lies above the floor of the room");
    }

    /// <summary>Two places: a chair at x = 5 with a seat, and a TV at x = 8 without one.</summary>
    private static StageRoomPlace[] TwoPlaces()
    {
        var screen = new StageRoomScreen("TV", "Black", new StagePoint(9, 1, 0), 270, 1.5, 0.8);
        return new[]
        {
            new StageRoomPlace("Chair", StageRoomPlaceRole.Seat, new StagePoint(5, 0, 0), 90, new StagePoint(5.5, 0.45, 0), null),
            new StageRoomPlace("TV", StageRoomPlaceRole.Screen, new StagePoint(8, 0, 0), 90, null, screen),
        };
    }

    private static void TestWanderPlaces()
    {
        // A random value of 0 gives the shortest rest, a place in each rest, the first free place, and the shortest sit.
        var room = new ListRoom(new StagePoint(1, 0, 1));
        var plan = new WanderPlan(room, () => 0, TwoPlaces());
        Check(RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false) == WanderChange.StartWalk, "a walk starts after the rest");
        Check(plan.Place?.Name == "Chair" && plan.Destination.X == 5, "the walk goes to the stand point of the place");

        Check(plan.Update(0.5, true, false) == WanderChange.StartApproach, "at a seat, the arrival starts the step to the seat");
        Check(plan.State == WanderState.Approach, "the plan steps to the seat");
        Check(RunUntilChange(plan, 5, false, true) == WanderChange.None, "the step goes on during the attention");
        Check(plan.Update(0.5, true, false) == WanderChange.SitDown && plan.State == WanderState.Sit, "the end of the step sits her down");

        Check(RunUntilChange(plan, WanderPlan.MinSitSeconds - 0.5, false, false) == WanderChange.None, "the sit lasts its time");
        Check(RunUntilChange(plan, 30, false, true) == WanderChange.None, "she stays on the seat while she talks to the viewer");
        Check(plan.State == WanderState.Sit, "the attention does not end the sit");
        Check(plan.Update(0.5, false, false) == WanderChange.StandUp && plan.State == WanderState.Leave, "the release gets her up");
        Check(plan.Place?.Name == "Chair", "she gets up from her place");

        Check(RunUntilChange(plan, 5, false, false) == WanderChange.None, "she goes back to the stand point");
        Check(plan.Update(0.5, true, false) == WanderChange.EndSit, "the stand point ends the sit");
        Check(plan.State == WanderState.Rest && plan.Place == null, "she rests without a place after the sit");

        Check(plan.Update(0.5, false, false) == WanderChange.StartWalk, "she walks on at once after a sit");
        Check(plan.Place?.Name == "TV", "the next place is another place");
        Check(plan.Update(0.5, true, false) == WanderChange.EndWalk, "a place without a seat ends the walk");
        Check(plan.State == WanderState.Rest && plan.Place?.Name == "TV", "she rests at the place, so the stage turns her to it");

        // The rest ends, and the last place is the TV, so the chair is free again.
        Check(RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false) == WanderChange.StartWalk, "a walk starts after the rest at the place");
        Check(plan.Place?.Name == "Chair", "the next walk goes to the other place");
        Check(plan.Update(0.5, false, true) == WanderChange.StartAttend, "attention stops a walk to a place");
        Check(plan.Place == null, "the attention forgets the place");

        // Without a model or sit clips, she stands at a seat.
        room = new ListRoom(new StagePoint(1, 0, 1)) { CanSit = false };
        plan = new WanderPlan(room, () => 0, TwoPlaces());
        RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false);
        Check(plan.Update(0.5, true, false) == WanderChange.EndWalk, "she stands at a seat when she cannot sit");

        // A new model during a sit ends the sit at once.
        room = new ListRoom(new StagePoint(1, 0, 1));
        plan = new WanderPlan(room, () => 0, TwoPlaces());
        RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false);
        plan.Update(0.5, true, false);
        plan.Update(0.5, true, false);
        plan.Interrupt();
        Check(plan.State == WanderState.Rest && plan.Place == null, "an interruption ends the sit");
    }

    private static void TestWanderPlaceChoice()
    {
        // A random value of 0.5 is above the share of the places, so the rest goes to a destination.
        var plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.5, TwoPlaces());
        Check(RunUntilChange(plan, 14, false, false) == WanderChange.StartWalk, "a walk starts after the rest");
        Check(plan.Place == null && plan.Destination.X == 1, "two rests in three go to a destination");

        // A place that no path reaches does not count.
        var room = new ListRoom(new StagePoint(1, 0, 1));
        room.Unreachable.Add(5);
        room.Unreachable.Add(8);
        plan = new WanderPlan(room, () => 0, TwoPlaces());
        RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false);
        Check(plan.Place == null && plan.Destination.X == 1, "no reachable place gives a destination");

        // An asked place wins over the share of the places.
        plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0.9, TwoPlaces());
        Check(plan.AskPlace("TV"), "the plan knows the place");
        Check(!plan.AskPlace("Kitchen"), "the plan does not know another name");
        RunUntilChange(plan, WanderPlan.MaxRestSeconds, false, false);
        Check(plan.Place?.Name == "TV", "the first walk goes to the asked place");
        plan.Update(0.5, true, false);
        RunUntilChange(plan, WanderPlan.MaxRestSeconds, false, false);
        Check(plan.Place == null, "the asked place counts only once");

        // A room without a list of places walks as before.
        plan = new WanderPlan(new ListRoom(new StagePoint(1, 0, 1)), () => 0);
        RunUntilChange(plan, WanderPlan.MinRestSeconds + 0.5, false, false);
        Check(plan.Place == null && plan.Destination.X == 1, "a room without places gives a destination");
    }

    private static void TestGazeSpine()
    {
        GazeAim free = SettledAim(-1, 0, 0);
        CheckSameRotation(free.Spine, StageQuaternion.Identity, "the spine stays while the body can turn");

        GazeAim side = SettledFixedAim(-1, 0, 0);
        double spine = AngleOf(side.Spine.Y, side.Spine.W);
        double head = AngleOf(side.Neck.Y, side.Neck.W) + AngleOf(side.Head.Y, side.Head.W);
        CheckNear(spine, 90 * GazeAim.SpineShare * Degree, 1e-4, "the spine takes its share of a turn to the side");
        CheckNear(head, GazeAim.HeadYawLimit, 1e-4, "the head takes the rest up to its limit");
        CheckNear(spine + head + side.EyesYaw, 89 * Degree, 1e-4, "the face turns almost 90 degrees with the eyes");

        // A point behind her side turns the spine to its limit, and the face turns about 92 degrees.
        GazeAim behind = SettledFixedAim(-1, 0, -0.5);
        double behindSpine = AngleOf(behind.Spine.Y, behind.Spine.W);
        CheckNear(behindSpine, GazeAim.SpineYawLimit, 1e-4, "the spine stops at its limit");
        double face = behindSpine + AngleOf(behind.Neck.Y, behind.Neck.W) + AngleOf(behind.Head.Y, behind.Head.W) + behind.EyesYaw;
        CheckNear(face, 92 * Degree, 1e-4, "the face turns 92 degrees at most");

        // The share of the spine fades in, so the head does not jump when she sits down.
        var aim = new GazeAim();
        for (int frame = 0; frame < 60; frame++)
        {
            aim.Aim(-1, 0, 0);
            aim.Update(1.0 / 60.0);
        }

        aim.SetBodyFixed(true);
        aim.Aim(-1, 0, 0);
        aim.Update(GazeAim.FadeSeconds / 2);
        CheckNear(AngleOf(aim.Spine.Y, aim.Spine.W), 90 * GazeAim.SpineShare / 2 * Degree, 1e-3, "the share of the spine fades in");

        int spineBone = HumanBones.IndexOf("spine");
        var driver = new CharacterDriver(() => 0);
        driver.StartModel(EmotionTable.Vrm);
        driver.SetBodyFixed(true);
        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0));
            driver.AimGaze(-1, 0, 0);
            driver.Update(1f / 60f);
        }

        StageQuaternion turned = driver.Pose.Rotations[spineBone];
        CheckNear(AngleOf(turned.Y, turned.W), 90 * GazeAim.SpineShare * Degree, 1e-3, "the driver turns the spine of the pose");
    }

    /// <summary>Aims for one second with a body that cannot turn, in steps of 1/60 second.</summary>
    private static GazeAim SettledFixedAim(double x, double y, double z)
    {
        var aim = new GazeAim();
        aim.SetBodyFixed(true);
        for (int frame = 0; frame < 60; frame++)
        {
            aim.Aim(x, y, z);
            aim.Update(1.0 / 60.0);
        }

        return aim;
    }

    private static void TestSitLaunchAndThigh()
    {
        Check(StageLaunch.FindPlace(new[] { "stage.exe", "--airi-place=Sofa" }, null) == "Sofa", "reads the place of the argument");
        Check(StageLaunch.FindPlace(new[] { "stage.exe" }, "モニター.002") == "モニター.002", "reads the place of the environment");
        Check(StageLaunch.FindPlace(new[] { "--airi-place=Bed" }, "Sofa") == "Bed", "the argument wins over the environment");
        Check(StageLaunch.FindPlace(new[] { "--airi-place=" }, null) == null, "no place from an empty argument");
        Check(StageLaunch.FindPlace(new[] { "stage.exe" }, " ") == null, "no place from a blank value");

        var legs = new MmdHumanoidRetarget(new[]
        {
            new MmdRigBone("センター", -1, 0, 8, 0),
            new MmdRigBone("左足", 0, 1, 9, 0),
            new MmdRigBone("左ひざ", 1, 1, 5, 0.3f),
        });
        CheckNear(legs.ThighLength, Math.Sqrt(16 + 0.09), 1e-4, "the thigh goes from the hip joint to the knee");
        CheckNear(new MmdHumanoidRetarget(new[] { new MmdRigBone("頭", -1, 0, 15, 0) }).ThighLength, 0, 1e-9, "a model without legs has no thigh");
    }
}
