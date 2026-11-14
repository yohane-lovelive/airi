using System;
using Airi.Stage.Core;

/// <summary>Tests of the turn of the head and the eyes to the viewer.</summary>
public static partial class Program
{
    private const double Degree = Math.PI / 180.0;

    private static void TestGaze()
    {
        TestGazeDirections();
        TestGazeFade();
        TestGazeFollow();
        TestDriverGaze();
    }

    /// <summary>Aims for one second, longer than the fade and the follow, in steps of 1/60 second.</summary>
    private static GazeAim SettledAim(double x, double y, double z)
    {
        var aim = new GazeAim();
        for (int frame = 0; frame < 60; frame++)
        {
            aim.Aim(x, y, z);
            aim.Update(1.0 / 60.0);
        }

        return aim;
    }

    /// <summary>The angle of a turn about one axis. A rotation about Y has only Y and W, and one about X has only X and W.</summary>
    private static double AngleOf(float part, float w)
    {
        return 2 * Math.Atan2(part, w);
    }

    private static void TestGazeDirections()
    {
        GazeAim front = SettledAim(0, 0, 1);
        CheckSameRotation(front.Neck, StageQuaternion.Identity, "a point in front leaves the neck");
        CheckSameRotation(front.Head, StageQuaternion.Identity, "a point in front leaves the head");
        CheckNear(front.EyesYaw, 0, 1e-6, "a point in front leaves the eyes");

        // Unity -X is her left, and the host counts a turn to her left as a positive yaw.
        GazeAim left = SettledAim(-1, 0, 1);
        CheckNear(AngleOf(left.Neck.Y, left.Neck.W), 45 * 0.4 * Degree, 1e-4, "the neck takes 40% of a turn to the left");
        CheckNear(AngleOf(left.Head.Y, left.Head.W), 45 * 0.6 * Degree, 1e-4, "the head takes the rest of a turn to the left");
        CheckNear(left.EyesYaw, 0, 1e-6, "the eyes stay when the head reaches the point");

        GazeAim side = SettledAim(-1, 0, 0);
        double sideHead = AngleOf(side.Neck.Y, side.Neck.W) + AngleOf(side.Head.Y, side.Head.W);
        CheckNear(sideHead, GazeAim.HeadYawLimit, 1e-4, "the head stops at its limit");
        CheckNear(side.EyesYaw, GazeAim.EyesYawLimit, 1e-4, "the eyes take the rest up to their limit");

        GazeAim right = SettledAim(1, 0, 0);
        CheckNear(right.EyesYaw, -GazeAim.EyesYawLimit, 1e-4, "a point on her right turns the eyes the other way");

        // The host counts a turn down as a positive pitch.
        GazeAim down = SettledAim(0, -1, 1);
        double downHead = AngleOf(down.Neck.X, down.Neck.W) + AngleOf(down.Head.X, down.Head.W);
        CheckNear(downHead, GazeAim.HeadPitchLimit, 1e-4, "the head bends down to its limit");
        CheckNear(down.EyesPitch, GazeAim.EyesPitchLimit, 1e-4, "the eyes look down for the rest");

        GazeAim up = SettledAim(0, 1, 1);
        CheckNear(up.EyesPitch, -GazeAim.EyesPitchLimit, 1e-4, "a point above turns the eyes up");
    }

    private static void TestGazeFade()
    {
        var aim = new GazeAim();
        aim.Aim(-1, 0, 1);
        aim.Update(GazeAim.FadeSeconds / 2);
        double half = AngleOf(aim.Neck.Y, aim.Neck.W) + AngleOf(aim.Head.Y, aim.Head.W);

        // The aim starts at the new point, so half of the fade gives half of the turn, with no swing.
        CheckNear(half, 22.5 * Degree, 1e-3, "the aim fades in");

        aim.Update(GazeAim.FadeSeconds / 2);
        aim.Release();
        aim.Update(GazeAim.FadeSeconds / 2);
        double releasing = AngleOf(aim.Neck.Y, aim.Neck.W) + AngleOf(aim.Head.Y, aim.Head.W);
        CheckNear(releasing, 22.5 * Degree, 1e-3, "the aim fades out in place");

        aim.Update(GazeAim.FadeSeconds / 2);
        CheckSameRotation(aim.Head, StageQuaternion.Identity, "the head returns to the clips");
        CheckNear(aim.EyesYaw, 0, 1e-6, "the eyes return to the clips");
    }

    private static void TestGazeFollow()
    {
        GazeAim aim = SettledAim(0, 0, 1);

        // The aim moves toward a new point with a time constant of 0.12 seconds.
        aim.Aim(-1, 0, 1);
        aim.Update(0.12);
        double turned = AngleOf(aim.Neck.Y, aim.Neck.W) + AngleOf(aim.Head.Y, aim.Head.W);
        CheckNear(turned, 45 * Degree * (1 - Math.Exp(-1)), 1e-3, "the aim follows a moved point smoothly");
    }

    private static void TestDriverGaze()
    {
        int head = HumanBones.IndexOf("head");
        var driver = new CharacterDriver(() => 0);
        driver.SetIdle(new HoldClip(5f, TurnX, 0, "head"));
        driver.StartModel(EmotionTable.Vrm);

        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0.4f));
            driver.AimGaze(-1, 0, 0);
            driver.Update(1f / 60f);
        }

        // The aim comes after the clip and before the offset of the stream, so a nod stays a nod.
        StageQuaternion aimHead = HumanoidFrame.FromEuler(new BodyRotation(0, (float)(GazeAim.HeadYawLimit * 0.6), 0));
        StageQuaternion expected = TurnX * aimHead * HumanoidFrame.FromEuler(new BodyRotation(0.4f, 0, 0));
        CheckSameRotation(driver.Pose.Rotations[head], expected, "the aim sits between the clip and the offset");
        CheckNear(driver.EyesYaw, GazeAim.EyesYawLimit + 0.2, 1e-2, "the eyes add the aim to the eyes of the stream");

        for (int frame = 0; frame < 60; frame++)
        {
            driver.ReceiveFrame(FrameWithMouth(0, 0.4f));
            driver.ReleaseGaze();
            driver.Update(1f / 60f);
        }

        expected = TurnX * HumanoidFrame.FromEuler(new BodyRotation(0.4f, 0, 0));
        CheckSameRotation(driver.Pose.Rotations[head], expected, "a released aim leaves the clip and the offset");
        CheckNear(driver.EyesYaw, 0.2, 1e-2, "a released aim leaves the eyes of the stream");
    }
}
