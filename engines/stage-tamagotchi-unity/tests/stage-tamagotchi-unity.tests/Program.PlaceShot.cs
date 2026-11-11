using System;
using Airi.Stage.Core;

/// <summary>Tests of the camera that shows the character and the screen of her place together.</summary>
public static partial class Program
{
    private static void TestPlaceShot()
    {
        TestPlaceShotPoints();
        TestPlaceShotAngle();
        TestPlaceShotDistance();
        TestPlaceShotAdjust();
        TestPlaceShotBlend();
    }

    private static void TestPlaceShotAdjust()
    {
        // The camera stands 2 m in front of the target, on the side of -Z, at the height of the target.
        var pose = new StageCameraPose(0, 1, -2, 0, 1, 0);
        StageCameraPose same = StagePlaceShot.Adjust(pose, 0, 0, 1, 0, 0);
        CheckNear(same.X, 0, 1e-9, "no move keeps the camera x");
        CheckNear(same.Z, -2, 1e-9, "no move keeps the camera z");

        StageCameraPose turned = StagePlaceShot.Adjust(pose, 90, 0, 1, 0, 0);
        CheckNear(turned.X, -2, 1e-9, "a turn of 90 degrees goes around the target");
        CheckNear(turned.Z, 0, 1e-9, "a turn of 90 degrees keeps the distance");

        StageCameraPose raised = StagePlaceShot.Adjust(pose, 0, 200, 1, 0, 0);
        double elevation = Math.Atan2(raised.Y - raised.TargetY, HorizontalDistance(raised)) * 180.0 / Math.PI;
        CheckNear(elevation, StagePlaceShot.HighestElevation, 1e-6, "a drag up stops at the highest angle");

        CheckNear(StagePlaceShot.Adjust(pose, 0, 0, 0.5, 0, 0).Distance, 1, 1e-9, "the wheel brings the camera nearer");
        CheckNear(StagePlaceShot.Adjust(pose, 0, 0, 10, 0, 0).Distance, 2 * StagePlaceShot.FarthestZoom, 1e-9, "the wheel stops at the farthest share");

        // The camera looks toward +Z, so the right of the view is +X.
        StageCameraPose panned = StagePlaceShot.Adjust(pose, 0, 0, 1, 1, 0.5);
        CheckNear(panned.TargetX, 1, 1e-9, "a pan to the right moves the target to the right of the view");
        CheckNear(panned.TargetY, 1.5, 1e-9, "a pan up moves the target up");
        CheckNear(panned.X, 1, 1e-9, "the camera moves with the target");
    }

    private static void TestPlaceShotBlend()
    {
        var from = new StageCameraPose(0, 0, 0, 0, 0, 1);
        var to = new StageCameraPose(2, 4, 6, 1, 1, 1);
        StageCameraPose start = StagePlaceShot.Blend(from, to, 0);
        StageCameraPose end = StagePlaceShot.Blend(from, to, 1);
        StageCameraPose middle = StagePlaceShot.Blend(from, to, 0.5);
        StageCameraPose early = StagePlaceShot.Blend(from, to, 0.1);
        CheckNear(start.X, 0, 1e-9, "a weight of 0 gives the first camera");
        CheckNear(end.Z, 6, 1e-9, "a weight of 1 gives the second camera");
        CheckNear(middle.Y, 2, 1e-9, "the middle of the blend lies in the middle");
        CheckNear(middle.TargetX, 0.5, 1e-9, "the target blends too");
        Check(early.Y < 0.4, $"the blend starts softly: {early.Y}");
    }

    /// <summary>She sits at the origin and faces +Z. A screen 0.9 m wide stands 0.8 m in front of her and faces her.</summary>
    private static StagePlaceSubject DeskSubject(double facingDegrees = 0)
    {
        var screen = new StageRoomScreen("Monitor", "Screen", new StagePoint(0, 1.0, 0.8), 180, 0.9, 0.5);
        return new StagePlaceSubject("Desk", new StagePoint(0, 1.1, 0), new StagePoint(0, 0.5, 0.25), facingDegrees, screen);
    }

    private static double HorizontalDistance(in StageCameraPose pose)
    {
        return Math.Sqrt(((pose.X - pose.TargetX) * (pose.X - pose.TargetX)) + ((pose.Z - pose.TargetZ) * (pose.Z - pose.TargetZ)));
    }

    private static void TestPlaceShotPoints()
    {
        StagePoint[] points = StagePlaceShot.PointsOf(DeskSubject());
        Check(points.Length == 6, "the shot holds the head, the low point, and four corners");
        CheckNear(points[0].Y, 1.1 + StagePlaceShot.HeadTop, 1e-9, "the shot holds the top of her head");

        // A screen that faces -Z has its right at -X, so its corners lie at x = -0.45 and x = 0.45.
        CheckNear(Math.Min(points[2].X, points[4].X), -0.45, 1e-9, "a corner lies at the left edge of the screen");
        CheckNear(Math.Max(points[2].X, points[4].X), 0.45, 1e-9, "a corner lies at the right edge of the screen");
        CheckNear(Math.Min(points[2].Y, points[3].Y), 0.75, 1e-9, "a corner lies at the bottom of the screen");
    }

    private static void TestPlaceShotAngle()
    {
        StageCameraPose? right = StagePlaceShot.Compute(DeskSubject(), 125, 45, 0.72);
        Check(right != null, "a shot holds her and the screen");
        StageCameraPose pose = right.Value;
        double degrees = Math.Atan2(pose.X - pose.TargetX, pose.Z - pose.TargetZ) * 180.0 / Math.PI;
        CheckNear(degrees, 125, 1e-6, "the camera stands 125 degrees from her facing");
        Check(pose.X > 0, "a positive turn puts the camera on her right");
        CheckNear(pose.Y, 1.1 + StagePlaceShot.HeightAboveHead, 1e-9, "the camera stands a little above her head");
        CheckNear(pose.TargetZ, 0.4, 1e-9, "the target lies between her head and the screen");

        StageCameraPose left = StagePlaceShot.Compute(DeskSubject(), -125, 45, 0.72).Value;
        Check(left.X < 0, "a negative turn puts the camera on her left");

        // Her facing turns the shot with her.
        StageCameraPose turned = StagePlaceShot.Compute(DeskSubject(90), 125, 45, 0.72).Value;
        double turnedDegrees = Math.Atan2(turned.X - turned.TargetX, turned.Z - turned.TargetZ) * 180.0 / Math.PI;
        CheckNear(turnedDegrees, 215 - 360, 1e-6, "the camera turns with her facing");
    }

    private static void TestPlaceShotDistance()
    {
        StagePlaceSubject subject = DeskSubject();
        StagePoint[] points = StagePlaceShot.PointsOf(subject);
        double tangentY = Math.Tan(45 * Math.PI / 360.0) / StagePlaceShot.Margin;
        StageCameraPose pose = StagePlaceShot.Compute(subject, 125, 45, 0.72).Value;
        Check(StagePlaceShot.Holds(pose, points, tangentY * 0.72, tangentY), "the shot holds each point");

        // A camera a little nearer on the same side loses a point, so the distance is the shortest.
        double distance = HorizontalDistance(pose);
        double share = (distance * 0.97) / distance;
        var nearer = new StageCameraPose(
            pose.TargetX + ((pose.X - pose.TargetX) * share),
            pose.Y,
            pose.TargetZ + ((pose.Z - pose.TargetZ) * share),
            pose.TargetX,
            pose.TargetY,
            pose.TargetZ);
        Check(!StagePlaceShot.Holds(nearer, points, tangentY * 0.72, tangentY), "a nearer camera loses a point");

        // A wide window holds the points at a shorter distance than a tall window.
        double wide = HorizontalDistance(StagePlaceShot.Compute(subject, 125, 45, 1.78).Value);
        Check(wide < distance, $"a wide window comes nearer: {wide:F2} m and {distance:F2} m");

        Check(StagePlaceShot.Compute(subject, 125, 1, 0.72) == null, "a lens too narrow for each distance gives no shot");

        var behind = new StageCameraPose(0, 1, 2, 0, 1, 3);
        Check(!StagePlaceShot.Holds(behind, points, 1, 1), "a point behind the camera is out of the view");
    }
}
