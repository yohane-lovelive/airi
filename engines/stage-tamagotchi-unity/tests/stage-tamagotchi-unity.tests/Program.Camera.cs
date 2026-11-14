using System;
using System.Globalization;
using System.Threading;
using Airi.Stage.Core;

/// <summary>Tests of the camera that the owner moves in the window.</summary>
public static partial class Program
{
    /// <summary>A vertical field of view of 90 degrees has a tangent of 1 at its half, so the numbers stay simple.</summary>
    private static readonly StageCameraFrame CameraFrame = new StageCameraFrame(0, 1, 0, 2, 0, 3, 90);

    /// <summary>A room much larger than the camera paths of the tests, so only its angles and its floor apply.</summary>
    private static readonly StageCameraLimits OpenRoom = StageCameraLimits.InRoom(new StageRoomBox(-10, -10, -10, 10, 10, 10), 0);

    private static void CheckNear(double actual, double expected, string description)
    {
        Check(Math.Abs(actual - expected) < 1e-6, $"{description}: {actual} != {expected}");
    }

    private static void TestCameraRig()
    {
        TestCameraFramings();
        TestCameraRotate();
        TestCameraPan();
        TestCameraZoom();
        TestCameraKeepsComposition();
        TestCameraSaveAndLoad();
        TestCameraArguments();
    }

    private static void TestCameraFramings()
    {
        // The first view must stay the same as the camera before this feature: in front of the center.
        StageCameraPose full = new StageCameraRig(StageCameraLimits.Free).Resolve(CameraFrame);
        CheckNear(full.X, 0, "the full view stands on the axis of the avatar");
        CheckNear(full.Y, 1, "the full view stands at the height of the center");
        CheckNear(full.Z, 3, "the full view stands at the fit distance");
        CheckNear(full.TargetY, 1, "the full view looks at the center");

        var rig = new StageCameraRig(StageCameraLimits.Free);
        rig.SetView(StageCameraView.Upper);
        StageCameraPose upper = rig.Resolve(CameraFrame);

        // The height is 2 and the tangent is 1, so half of the height shows at a distance of 0.5.
        CheckNear(upper.Distance, 0.5, "the upper view shows half of the height");
        CheckNear(upper.TargetY, 1.5, "the upper view looks a quarter of the height below the top");

        rig.SetView(StageCameraView.Face);
        StageCameraPose face = rig.Resolve(CameraFrame);
        CheckNear(face.Distance, 0.24, "the face view shows about a quarter of the height");
        CheckNear(face.TargetY, 1.78, "the face view looks near the top");

        // A wide avatar in a narrow window: the fit distance is the limit of each view.
        var narrow = new StageCameraFrame(0, 1, 0, 2, 0, 0.2, 90);
        rig.SetView(StageCameraView.Upper);
        CheckNear(rig.Resolve(narrow).Distance, 0.2, "a view never stands farther than the full view");

        // A window with another size gives another fit distance, and a framing of a key follows it.
        rig.SetView(StageCameraView.Full);
        var wide = new StageCameraFrame(0, 1, 0, 2, 0, 5, 90);
        CheckNear(rig.Resolve(wide).Distance, 5, "a framing of a key fits a new window");

        rig.SetView(StageCameraView.Upper);
        Check(rig.View == StageCameraView.Upper, "the rig reports the framing of a key");
    }

    private static void TestCameraRotate()
    {
        // A window of 1000 pixels turns 180 degrees, so 200 pixels turn 36 degrees.
        var rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(200, 0, 1000, CameraFrame);
        StageCameraPose right = rig.Resolve(CameraFrame);
        Check(rig.View == StageCameraView.Custom, "a drag leaves the framing of a key");
        CheckNear(right.X, 3 * Math.Sin(36 * Math.PI / 180), "a drag to the right moves the camera toward +X");
        CheckNear(right.Z, 3 * Math.Cos(36 * Math.PI / 180), "the camera keeps its distance on the circle");
        CheckNear(right.TargetX, 0, "a rotation keeps the target");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(0, 100, 1000, CameraFrame);
        Check(rig.Resolve(CameraFrame).Y < 1, "a drag up moves the camera down, so the scene follows the mouse");

        // A drag starts from the current picture, not from the full view.
        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.SetView(StageCameraView.Upper);
        rig.Rotate(0, 0, 1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Distance, 0.5, "a drag from the upper view keeps its distance");
        CheckNear(rig.Resolve(CameraFrame).TargetY, 1.5, "a drag from the upper view keeps its target");

        rig = new StageCameraRig(OpenRoom);
        rig.Rotate(0, -100000, 1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Y, 1 + (3 * Math.Sin(70 * Math.PI / 180)), "a room limits the high pitch");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(0, 100000, 1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Y, 1 - (3 * Math.Sin(80 * Math.PI / 180)), "the pitch stops before the pole");

        // 2000 pixels are 360 degrees, so the camera comes back to the front.
        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(2000, 0, 1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Z, 3, "a full turn comes back");
        Check(rig.Save().StartsWith("custom:0.000", StringComparison.Ordinal) || rig.Save().StartsWith("custom:-0.000", StringComparison.Ordinal), $"a free yaw wraps: {rig.Save()}");

        // A low target and a low angle would take the camera under the floor.
        rig = new StageCameraRig(OpenRoom);
        rig.TryLoad("custom:0,-4,1.5,0,-0.5,0");
        CheckNear(rig.Resolve(CameraFrame).Y, 0.04, "a room keeps the camera above the floor");
    }

    private static void TestCameraPan()
    {
        // The distance is 3 and the tangent is 1, so 1000 pixels cover 6 units, and 100 pixels cover 0.6.
        var rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Pan(100, 0, 1000, CameraFrame);
        StageCameraPose right = rig.Resolve(CameraFrame);
        CheckNear(right.TargetX, 0.6, "a drag to the right moves the target to the left side of the camera");
        CheckNear(right.X, 0.6, "the camera moves with its target");
        CheckNear(right.Z, 3, "a pan keeps the depth");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Pan(0, 100, 1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).TargetY, 0.4, "a drag up lowers the target, so the scene follows the mouse");

        // At a yaw of 90 degrees the camera stands at +X, and its right side is +Z.
        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(500, 0, 1000, CameraFrame);
        rig.Pan(100, 0, 1000, CameraFrame);
        StageCameraPose side = rig.Resolve(CameraFrame);
        CheckNear(side.TargetX, 0, "a pan from the side keeps the target on its axis");
        CheckNear(side.TargetZ, -0.6, "a pan from the side moves the target along the depth");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Pan(100000, 100000, 1000, CameraFrame);
        StageCameraPose far = rig.Resolve(CameraFrame);
        CheckNear(far.TargetX, 1.5, "the target stays near the avatar on the side");
        CheckNear(far.TargetY, 1 - 1.5, "the target stays near the avatar in the height");
    }

    private static void TestCameraZoom()
    {
        var rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Zoom(1, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Distance, 2.7, "a wheel step up comes closer");
        CheckNear(rig.Resolve(CameraFrame).Z, 2.7, "a zoom keeps the direction");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Zoom(1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Distance, 0.08, "the nearest camera still shows the eyes");

        rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Zoom(-1000, CameraFrame);
        CheckNear(rig.Resolve(CameraFrame).Distance, 6, "the farthest camera stands at two fit distances");
    }

    private static void TestCameraKeepsComposition()
    {
        var rig = new StageCameraRig(StageCameraLimits.Free);
        rig.Rotate(100, 0, 1000, CameraFrame);
        rig.Zoom(1, CameraFrame);
        StageCameraPose first = rig.Resolve(CameraFrame);

        // Another model, twice as tall, in another place.
        var tall = new StageCameraFrame(10, 2, 0, 4, 0, 6, 90);
        StageCameraPose second = rig.Resolve(tall);
        CheckNear(second.Distance, first.Distance * 2, "a taller model keeps the composition");
        CheckNear(second.TargetX, 10, "the camera follows the new place of the model");

        // A new window gives another fit distance. A drag result stays, and the farthest limit moves.
        CheckNear(rig.Resolve(new StageCameraFrame(0, 1, 0, 2, 0, 4, 90)).Distance, first.Distance, "a new window keeps the drag result");
        CheckNear(rig.Resolve(new StageCameraFrame(0, 1, 0, 2, 0, 1, 90)).Distance, 2, "a new limit applies to the drag result");

        rig.SetView(StageCameraView.Full);
        StageCameraPose reset = rig.Resolve(CameraFrame);
        CheckNear(reset.X, 0, "the full view leaves the drag result");
        CheckNear(reset.Z, 3, "the full view comes back to the fit distance");
    }

    private static void TestCameraSaveAndLoad()
    {
        foreach (StageCameraView view in new[] { StageCameraView.Full, StageCameraView.Upper, StageCameraView.Face })
        {
            var source = new StageCameraRig(StageCameraLimits.Free);
            source.SetView(view);
            var loaded = new StageCameraRig(StageCameraLimits.Free);
            Check(loaded.TryLoad(source.Save()) && loaded.View == view, $"the framing {view} survives a save");
        }

        var custom = new StageCameraRig(StageCameraLimits.Free);
        custom.Rotate(100, 50, 1000, CameraFrame);
        custom.Zoom(2, CameraFrame);
        custom.Pan(10, 20, 1000, CameraFrame);
        var copy = new StageCameraRig(StageCameraLimits.Free);
        Check(copy.TryLoad(custom.Save()), "a drag result loads");
        StageCameraPose before = custom.Resolve(CameraFrame);
        StageCameraPose after = copy.Resolve(CameraFrame);
        Check(Math.Abs(before.X - after.X) < 0.01 && Math.Abs(before.Y - after.Y) < 0.01 && Math.Abs(before.Z - after.Z) < 0.01, "a drag result survives a save");

        var limited = new StageCameraRig(OpenRoom);
        Check(limited.TryLoad("custom:0,80,1.5,0,0,0"), "a saved camera loads under other limits");
        CheckNear(limited.Resolve(CameraFrame).Y, 1 + (3 * Math.Sin(70 * Math.PI / 180)), "the limits apply to a saved camera");

        var broken = new StageCameraRig(StageCameraLimits.Free);
        broken.SetView(StageCameraView.Upper);
        foreach (string text in new[] { null, string.Empty, "sideways", "custom:", "custom:1,2,3", "custom:0,0,0,0,0,0", "custom:0,0,-1,0,0,0", "custom:NaN,0,1,0,0,0", "custom:x,0,1,0,0,0" })
        {
            Check(!broken.TryLoad(text), $"a broken text fails: {text}");
            Check(broken.View == StageCameraView.Upper, $"a broken text keeps the state: {text}");
        }

        // A German Windows writes 1,5 for 1.5. The text must not change with the language of the machine.
        CultureInfo culture = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
            var german = new StageCameraRig(StageCameraLimits.Free);
            german.Zoom(1, CameraFrame);
            Check(german.Save() == "custom:0.000,0.000,1.350,0.000,0.000,0.000", $"the text ignores the language: {german.Save()}");
            Check(new StageCameraRig(StageCameraLimits.Free).TryLoad(german.Save()), "the text loads in any language");
        }
        finally
        {
            Thread.CurrentThread.CurrentCulture = culture;
        }
    }

    private static void TestCameraArguments()
    {
        Check(StageCameraRig.FindInArguments(new[] { "a.exe", "--airi-camera=upper" }) == "upper", "the argument gives the framing");
        Check(StageCameraRig.FindInArguments(new[] { "a.exe" }) == null, "no argument gives no framing");
        Check(StageCameraRig.FindInArguments(new[] { "--airi-camera=" }) == null, "an empty argument gives no framing");
    }
}
