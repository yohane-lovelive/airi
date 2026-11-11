using System;
using Airi.Stage.Core;

/// <summary>Tests of the camera that follows a walk and stays in front of walls.</summary>
public static partial class Program
{
    private static void TestCameraFollow()
    {
        TestCameraFollowTarget();
        TestCameraKeepClear();
        TestCameraPoseAtDistance();
        TestCameraSwing();
        TestCameraSwingChoices();
    }

    private static void SwingFor(StageCameraFollow follow, double seconds, Func<double, double> roomAt, bool held = false)
    {
        for (int frame = 0; frame < (int)Math.Round(seconds * 60); frame++)
        {
            follow.Swing(1.0 / 60.0, roomAt, held);
        }
    }

    private static void TestCameraSwing()
    {
        var follow = new StageCameraFollow();
        SwingFor(follow, 1, _ => 1);
        CheckNear(follow.SwingDegrees, 0, 1e-9, "with room, the camera keeps the angle of the owner");

        // A wall stands at the angle of the owner. Turns of 40 and -60 degrees have room.
        Func<double, double> wall = turn => turn == 40 || turn == -60 ? 1 : 0.3;
        SwingFor(follow, 1, wall, held: true);
        CheckNear(follow.SwingDegrees, 0, 1e-9, "the camera waits while the owner drags it");

        follow.Swing(1.0 / 60.0, wall, false);
        Check(follow.SwingDegrees > 0 && follow.SwingDegrees <= (StageCameraFollow.SwingDegreesPerSecond / 60.0) + 1e-9, $"the swing starts softly: {follow.SwingDegrees}");

        SwingFor(follow, 3, wall);
        CheckNear(follow.SwingDegrees, 40, 0.5, "the camera swings to the nearest side with room");

        // The angle of the owner has room again. The camera waits one second, and then swings back.
        double swung = follow.SwingDegrees;
        SwingFor(follow, 0.9, _ => 1);
        Check(follow.SwingDegrees >= swung, $"the camera waits before it swings back: {follow.SwingDegrees}");
        SwingFor(follow, 0.2, _ => 1);
        Check(follow.SwingDegrees < swung, $"the camera swings back after the wait: {follow.SwingDegrees}");
        SwingFor(follow, 4, _ => 1);
        CheckNear(follow.SwingDegrees, 0, 0.5, "the camera returns to the angle of the owner");

        follow.Reset(0, 0, 0);
        CheckNear(follow.SwingDegrees, 0, 1e-9, "a new model forgets the swing");
    }

    private static void TestCameraSwingChoices()
    {
        var nearest = new StageCameraFollow();
        SwingFor(nearest, 3, turn => turn == -20 || turn == 40 ? 1 : 0.3);
        CheckNear(nearest.SwingDegrees, -20, 0.5, "the nearest side with room wins");

        var widest = new StageCameraFollow();
        SwingFor(widest, 3, turn => turn == 80 ? 0.5 : 0.3);
        CheckNear(widest.SwingDegrees, 80, 0.5, "without a side with room, the side with the most room wins");

        // She walks on, and the side of the swing closes. The camera finds the next side.
        var moving = new StageCameraFollow();
        SwingFor(moving, 3, turn => turn == 40 ? 1 : 0.3);
        SwingFor(moving, 4, turn => turn == -60 ? 1 : 0.3);
        CheckNear(moving.SwingDegrees, -60, 0.5, "a closed side sends the camera to the next side");

        var limited = new StageCameraFollow();
        SwingFor(limited, 3, turn => turn == 140 ? 1 : 0.3);
        CheckNear(limited.SwingDegrees, 0, 1e-9, "the camera does not go farther than its largest swing");

        // Sides from -120 to -20 degrees have room. The middle of this span stays open while she walks on.
        var span = new StageCameraFollow();
        span.Swing(1.0 / 60.0, turn => turn >= -120 && turn <= -20 ? 1 : 0.2, false);
        CheckNear(span.SwingDegrees, -70, 1e-9, "the camera takes the middle of a span with room");

        // A span of three sides wins over one side, also when the one side is nearer.
        var wide = new StageCameraFollow();
        SwingFor(wide, 3, turn => turn == 20 || (turn >= -100 && turn <= -60) ? 1 : 0.2);
        CheckNear(wide.SwingDegrees, -80, 1e-9, "a wide span wins over one side");

        // A corridor: only the sides along it have room, 80 degrees away. The camera cuts there, at its whole distance.
        var corridor = new StageCameraFollow();
        Func<double, double> along = turn => turn == 80 ? 1 : 0.2;
        corridor.KeepClear(1.0 / 60.0, 3, 0.6);
        corridor.Swing(1.0 / 60.0, along, false);
        CheckNear(corridor.SwingDegrees, 80, 1e-9, "a far side takes a cut");
        CheckNear(corridor.KeepClear(1.0 / 60.0, 3, 3), 3, 1e-9, "after a cut, the camera stands at its whole distance");

        // The angle of the owner opens again. After the wait, the camera cuts back.
        SwingFor(corridor, 1.1, _ => 1);
        CheckNear(corridor.SwingDegrees, 0, 1e-9, "the camera cuts back to the angle of the owner");
    }

    private static void TestCameraFollowTarget()
    {
        var follow = new StageCameraFollow();
        follow.Reset(0, 0, 0);

        follow.FollowTarget(StageCameraFollow.FollowSeconds, 1, 0, -2);
        CheckNear(follow.TargetX, 1 - Math.Exp(-1), 1e-9, "the target follows with its time constant");
        CheckNear(follow.TargetZ, -2 * (1 - Math.Exp(-1)), 1e-9, "the target follows on each axis");

        for (int frame = 0; frame < 180; frame++)
        {
            follow.FollowTarget(1.0 / 60.0, 1, 0, -2);
        }

        CheckNear(follow.TargetX, 1, 1e-3, "the target reaches a stopped avatar");

        follow.Reset(5, 0, 0);
        CheckNear(follow.TargetX, 5, 1e-9, "a new model puts the target on the avatar at once");
    }

    private static void TestCameraKeepClear()
    {
        var follow = new StageCameraFollow();
        CheckNear(follow.KeepClear(1.0 / 60.0, 3, 3), 3, 1e-9, "without a wall, the camera keeps its framing");

        CheckNear(follow.KeepClear(1.0 / 60.0, 3, 1.2), 1.2, 1e-9, "a wall pulls the camera in at once");

        double returned = follow.KeepClear(StageCameraFollow.ReturnSeconds, 3, 3);
        CheckNear(returned, 1.2 + (1.8 * (1 - Math.Exp(-1))), 1e-9, "the camera returns slowly after the wall");

        for (int frame = 0; frame < 300; frame++)
        {
            returned = follow.KeepClear(1.0 / 60.0, 3, 3);
        }

        CheckNear(returned, 3, 1e-3, "the camera reaches its framing again");

        CheckNear(follow.KeepClear(1.0 / 60.0, 3, 0.1), StageCameraFollow.NearestDistance, 1e-9, "a wall does not pull the camera into her");
        CheckNear(follow.KeepClear(1.0 / 60.0, 0.2, 0.1), 0.2, 1e-9, "a near framing of the owner stays");

        follow.Reset(0, 0, 0);
        CheckNear(follow.KeepClear(1.0 / 60.0, 3, 3), 3, 1e-9, "a new model forgets the walls");
    }

    private static void TestCameraPoseAtDistance()
    {
        var pose = new StageCameraPose(0, 1, 3, 0, 1, 0);

        StageCameraPose near = pose.AtDistance(1);

        CheckNear(near.Z, 1, 1e-9, "the camera moves along its line");
        CheckNear(near.Y, 1, 1e-9, "the camera keeps its height on a level line");
        CheckNear(near.TargetZ, 0, 1e-9, "the target stays");
        CheckNear(near.Distance, 1, 1e-9, "the camera has the new distance");
    }
}
