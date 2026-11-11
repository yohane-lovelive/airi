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
        TestWebcamRig();
        TestScreenFit();
    }

    private static void TestScreenFit()
    {
        // The monitor of 2LDK is 0.909 m by 0.511 m.
        (double width, double height) = StageScreenFit.Fit(1920, 1080, 0.909, 0.511);
        CheckNear(height, 0.511, 1e-9, "a film of 16:9 fills the height of a screen of the same shape");
        Check(width <= 0.909 + 1e-9, "a film of 16:9 stays inside the width");

        (width, height) = StageScreenFit.Fit(800, 600, 0.909, 0.511);
        CheckNear(height, 0.511, 1e-9, "a film of 4:3 fills the height");
        CheckNear(width, 0.511 * 4 / 3, 1e-9, "a film of 4:3 leaves black bars at the sides");

        (width, height) = StageScreenFit.Fit(1920, 600, 0.909, 0.511);
        CheckNear(width, 0.909, 1e-9, "a wide film fills the width");
        CheckNear(height, 0.909 * 600 / 1920, 1e-9, "a wide film leaves black bars above and below");

        (width, height) = StageScreenFit.Fit(0, 0, 0.909, 0.511);
        CheckNear(width, 0.909, 1e-9, "an image with no size fills the screen");
    }

    private static void TestWebcamRig()
    {
        // She sits at -Z and faces +Z. The first screen faces her, so her right is +X.
        var first = new StageRoomScreen("Monitor", "Screen", new StagePoint(0, 1, 0), 180, 0.9, 0.5);
        var candidates = StageWebcamRig.Candidates(first);
        Check(candidates.Count == 3, "the second monitor has three places to try");

        StageRoomScreen right = candidates[0];
        Check(right.Center.X > 0.45 && right.Center.Z < 0, "the first place lies on her right, a little toward her");
        double rightTurn = ((right.FacingDegrees - 180 + 540) % 360) - 180;
        CheckNear(Math.Abs(rightTurn), StageWebcamRig.TurnDegrees, 1e-6, "the monitor beside her turns toward her");
        CheckNear(right.Center.Y - (right.Height / 2), 0.75, 1e-9, "the two monitors stand on the same line at the bottom");

        // The inner edge of the second screen stays at the gap from the edge of the first.
        double turn = StageWebcamRig.TurnDegrees * Math.PI / 180.0;
        double innerX = right.Center.X - (Math.Cos(turn) * right.Width / 2);
        double innerZ = right.Center.Z + (Math.Sin(turn) * right.Width / 2);
        CheckNear(innerX, 0.45 + StageWebcamRig.SideGap, 1e-9, "the inner edge stays near the first monitor");
        CheckNear(innerZ, 0, 1e-9, "the inner edge stays on the line of the first screen");

        // A screen faces where its corners show their front, so the turned screen faces her middle.
        double normalX = Math.Sin(right.FacingDegrees * Math.PI / 180.0);
        Check(normalX < 0, "the monitor on her right faces toward her middle");

        StageRoomScreen left = candidates[1];
        CheckNear(left.Center.X, -right.Center.X, 1e-9, "the second place mirrors the first on her left");

        StageRoomScreen above = candidates[2];
        CheckNear(above.Center.Y, 1 + 0.25 + StageWebcamRig.AboveGap + (StageWebcamRig.Height / 2), 1e-9, "the last place lies above the first monitor");
        CheckNear(above.FacingDegrees, 180, 1e-9, "the monitor above faces as the first");
        CheckNear(above.Width / above.Height, 16.0 / 9.0, 1e-9, "the second screen is 16:9");

        StagePoint webcam = StageWebcamRig.WebcamPosition(first);
        CheckNear(webcam.Y, 1.25 + StageWebcamRig.WebcamAbove, 1e-9, "the webcam stands on the top edge");
        CheckNear(webcam.Z, -StageWebcamRig.WebcamFront, 1e-9, "the webcam stands a little toward her");

        // At 0.71 m from her neck, the webcam needs about 46 degrees for her head and her shoulders.
        double fov = StageWebcamRig.FieldOfView(webcam, new StagePoint(0, 1.1, -0.7));
        CheckNear(fov, 2 * Math.Atan(0.3 / Math.Sqrt((0.26 * 0.26) + (0.66 * 0.66))) * 180.0 / Math.PI, 1e-6, "the lens holds her head and her shoulders");

        // Her head is 0.65 m from the screen, so the camera of the film stands 0.15 m past the screen.
        var head = new StagePoint(0, 0.95, -0.65);
        StagePoint front = StageWebcamRig.FrontCamera(head, first);
        CheckNear(front.X, 0, 1e-9, "the camera of the film stands in front of her face");
        CheckNear(front.Z, -0.65 + StageWebcamRig.FrontDistance, 1e-9, "the camera of the film stands on the line to the screen");
        CheckNear(front.Y, 0.95 + StageWebcamRig.EyeLift, 1e-9, "the camera of the film stands at the height of her eyes");
        StagePoint aim = StageWebcamRig.FilmedCenter(head);
        double viewLength = Math.Sqrt(((aim.Y - front.Y) * (aim.Y - front.Y)) + ((aim.Z - front.Z) * (aim.Z - front.Z)));
        double expectedNear = (0.15 / ((front.Z - aim.Z) / viewLength)) + StageWebcamRig.ScreenClearance;
        CheckNear(StageWebcamRig.NearClip(front, aim, first), expectedNear, 1e-6, "the near plane cuts the screen between the camera and her");

        // A head far from the screen puts the camera between her and the screen, and nothing needs a cut.
        var far = new StagePoint(0, 0.95, -1.2);
        StagePoint between = StageWebcamRig.FrontCamera(far, first);
        CheckNear(StageWebcamRig.NearClip(between, StageWebcamRig.FilmedCenter(far), first), StageWebcamRig.NearestNear, 1e-9, "a camera before the screen keeps the nearest near plane");

        // A head right at the screen center films along the facing of the screen.
        StagePoint level = StageWebcamRig.FrontCamera(new StagePoint(0, 0.95, 0), first);
        CheckNear(level.Z, StageWebcamRig.FrontDistance, 1e-9, "a head at the screen center gives a camera away from the face of the screen");

        StagePlaceSubject withSecond = DeskSubject().WithSecondScreen(above);
        Check(StagePlaceShot.PointsOf(withSecond).Length == 10, "the shot also holds the corners of the second screen");
        StageCameraPose wide = StagePlaceShot.Compute(withSecond, 125, 45, 0.72).Value;
        Check(HorizontalDistance(wide) >= HorizontalDistance(StagePlaceShot.Compute(DeskSubject(), 125, 45, 0.72).Value), "the second screen moves the camera back or keeps it");
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
