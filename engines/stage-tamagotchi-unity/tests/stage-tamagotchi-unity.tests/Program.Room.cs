using System;
using Airi.Stage.Core;

/// <summary>Tests of the room file and of the camera in a room.</summary>
public static partial class Program
{
    private const string RoomFile = @"{
  ""version"": 1,
  ""name"": ""mr009"",
  ""bundle"": ""room.bundle"",
  ""stand"": [-1.5, 0, 0.25],
  ""facing"": 90,
  ""box"": { ""min"": [-6, -0.1, -2.3], ""max"": [2.3, 2.6, 2.2] }
}";

    private static void TestRoom()
    {
        TestRoomFile();
        TestRoomFileRejections();
        TestRoomFolder();
        TestRoomBox();
        TestCameraFacing();
        TestCameraInRoom();
        TestDoorNames();
        TestRoomPlaces();
    }

    private static void TestDoorNames()
    {
        foreach (string name in new[] { "Door", "Door.018", "Glass_Door.001", "BathroomDOOR", "ドア", "引き戸", "扉.002" })
        {
            Check(StageRoomDoors.IsDoorName(name), $"{name} is a door");
        }

        foreach (string name in new[] { "DoorFrame.005", "Door_frame", "ドア枠", "Wall.008", "Window" })
        {
            Check(!StageRoomDoors.IsDoorName(name), $"{name} is not a door");
        }
    }

    private static void TestRoomFile()
    {
        StageRoomManifest room = StageRoomManifest.Parse(RoomFile);
        Check(room.Name == "mr009", "the room file gives the name");
        Check(room.Bundle == "room.bundle", "the room file gives the bundle");
        CheckNear(room.StandX, -1.5, "the room file gives the stand point x");
        CheckNear(room.StandZ, 0.25, "the room file gives the stand point z");
        CheckNear(room.FacingDegrees, 90, "the room file gives the facing");
        CheckNear(room.Box.MinX, -6, "the room file gives the box");
        CheckNear(room.Box.MaxY, 2.6, "the room file gives the top of the box");

        StageRoomManifest copy = StageRoomManifest.Parse(room.ToJson());
        Check(copy.Name == room.Name && copy.Bundle == room.Bundle, "the text of a room survives a write");
        CheckNear(copy.StandX, room.StandX, "the stand point survives a write");
        CheckNear(copy.Box.MaxZ, room.Box.MaxZ, "the box survives a write");

        var precise = new StageRoomManifest("a", "b", 0.12345, 0, 0, 33.33333, new StageRoomBox(-1, -1, -1, 1, 1, 1));
        CheckNear(StageRoomManifest.Parse(precise.ToJson()).StandX, 0.123, "a written room keeps millimeters");

        // Without a list, the import finds the doors. An empty list means that the owner opens no door.
        Check(room.OpenDoors == null, "a room file without doors gives no list");
        Check(copy.OpenDoors == null, "a room without a list writes no list");
        StageRoomManifest doors = StageRoomManifest.Parse(RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, \"openDoors\": [\"Door.011\", \"ドア\"],"));
        Check(doors.OpenDoors != null && doors.OpenDoors.Count == 2 && doors.OpenDoors[1] == "ドア", "the room file gives the open doors");
        Check(string.Join("|", StageRoomManifest.Parse(doors.ToJson()).OpenDoors) == "Door.011|ドア", "the open doors survive a write");
        StageRoomManifest none = StageRoomManifest.Parse(RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, \"openDoors\": [],"));
        Check(none.OpenDoors != null && none.OpenDoors.Count == 0, "an empty list of doors stays empty");
    }

    private static void TestRoomFileRejections()
    {
        CheckRoomRejected("{", "not JSON");
        CheckRoomRejected(RoomFile.Replace("\"version\": 1", "\"version\": 2"), "another version");
        CheckRoomRejected(RoomFile.Replace("\"name\": \"mr009\",", string.Empty), "no name");
        CheckRoomRejected(RoomFile.Replace("room.bundle", "../room.bundle"), "a bundle outside the folder");
        CheckRoomRejected(RoomFile.Replace("room.bundle", "C:room.bundle"), "a bundle on a drive");
        CheckRoomRejected(RoomFile.Replace("room.bundle", ".."), "the parent folder as a bundle");
        CheckRoomRejected(RoomFile.Replace("[-1.5, 0, 0.25]", "[-1.5, 0]"), "a stand point with two numbers");
        CheckRoomRejected(RoomFile.Replace("[-1.5, 0, 0.25]", "[-1.5, \"0\", 0.25]"), "a stand point with a text");
        CheckRoomRejected(RoomFile.Replace("\"facing\": 90,", string.Empty), "no facing");
        CheckRoomRejected(RoomFile.Replace("[-6, -0.1, -2.3]", "[3, -0.1, -2.3]"), "a box with min over max");
        CheckRoomRejected(RoomFile.Replace("[-1.5, 0, 0.25]", "[-1.5, 0, 5]"), "a stand point outside the box");
        CheckRoomRejected(RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, \"openDoors\": \"Door\","), "doors that are not a list");
        CheckRoomRejected(RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, \"openDoors\": [\"Door\", 3],"), "a door that is not a name");
        CheckRoomRejected(RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, \"openDoors\": [\" \"],"), "a door with an empty name");
    }

    private static void CheckRoomRejected(string text, string reason)
    {
        try
        {
            StageRoomManifest.Parse(text);
            Check(false, $"rejects a room file with {reason}");
        }
        catch (StageRoomException)
        {
            Check(true, $"rejects a room file with {reason}");
        }
    }

    private static void TestRoomFolder()
    {
        Check(StageRoomManifest.FindFolder(new[] { "stage.exe", "--airi-room=C:/rooms/a" }, "C:/rooms/b") == "C:/rooms/a", "the argument comes before the environment");
        Check(StageRoomManifest.FindFolder(new[] { "stage.exe" }, "C:/rooms/b") == "C:/rooms/b", "the environment gives the folder");
        Check(StageRoomManifest.FindFolder(new[] { "stage.exe" }, null) == null, "no room without a folder");
        Check(StageRoomManifest.FindFolder(new[] { "stage.exe", "--airi-room=" }, "C:/rooms/b") == null, "an empty argument turns the room off");
    }

    private static void TestRoomBox()
    {
        var box = new StageRoomBox(-2, 0, -1, 2, 3, 1);
        Check(box.Contains(0, 1, 0), "a box contains its center");
        Check(box.Contains(2, 3, 1), "a box contains its sides");
        Check(!box.Contains(0, 1, 1.01), "a box does not contain a point past a side");

        StageRoomBox inner = box.Shrink(0.25);
        CheckNear(inner.MaxX, 1.75, "a smaller box moves each side in");
        CheckNear(inner.MinY, 0.25, "a smaller box moves the floor up");
        CheckNear(new StageRoomBox(0, 0, 0, 0.2, 1, 1).Shrink(0.25).MaxX, 0.1, "a side never passes the center");

        CheckNear(box.ShareInside(0, 1, 0, 0, 1, 0.5), 1, "a line inside the box stays whole");
        CheckNear(box.ShareInside(0, 1, 0, 0, 1, 4), 0.25, "a line through the back stops at the side");
        CheckNear(box.ShareInside(0, 1, 0, -4, 1, -2), 0.5, "the nearest side stops a line through two sides");
    }

    private static void TestCameraFacing()
    {
        // An avatar that faces +X: the full view stands on +X.
        var facingX = new StageCameraFrame(0, 1, 0, 2, 0, 3, 90, 90);
        StageCameraPose full = new StageCameraRig(StageCameraLimits.Free).Resolve(facingX);
        CheckNear(full.X, 3, "the full view stands in front of a turned avatar");
        CheckNear(full.Z, 0, "the full view of a turned avatar stays on its axis");

        // The yaw counts from the front of the avatar: 90 degrees go to its left side, which is -Z.
        var rig = new StageCameraRig(StageCameraLimits.Free);
        Check(rig.TryLoad("custom:90,0,1.5,0,0.25,0"), "a camera to the side loads");
        StageCameraPose side = rig.Resolve(facingX);
        CheckNear(side.X, 0, "a side camera of a turned avatar leaves its front axis");
        CheckNear(side.Z, -3, "a side camera of a turned avatar turns with it");
        CheckNear(side.TargetY, 1.5, "a turn keeps the height of the target");

        // A target offset to the side of the avatar turns with the avatar.
        Check(rig.TryLoad("custom:0,0,1.5,0.5,0,0"), "a camera with a side target loads");
        CheckNear(rig.Resolve(facingX).TargetZ, -1, "a side target turns with the avatar");
    }

    private static void TestCameraInRoom()
    {
        // The back wall stands at z 1.5, and the camera keeps 0.2 from it.
        var room = new StageRoomBox(-2, -0.5, -2, 2, 3, 1.5);
        StageCameraLimits limits = StageCameraLimits.InRoom(room, 0.2);

        StageCameraPose full = new StageCameraRig(limits).Resolve(CameraFrame);
        CheckNear(full.Z, 1.3, "a wall stops the camera");
        CheckNear(full.X, 0, "a stopped camera keeps its direction");
        CheckNear(full.TargetY, 1, "a stopped camera keeps its target");

        var near = new StageCameraFrame(0, 1, 0, 2, 0, 1, 90);
        CheckNear(new StageCameraRig(limits).Resolve(near).Z, 1, "a camera inside the room keeps its place");

        // A room has walls on each side, so the camera goes around the avatar.
        var rig = new StageCameraRig(limits);
        rig.Rotate(1000, 0, 1000, CameraFrame);
        StageCameraPose back = rig.Resolve(CameraFrame);
        CheckNear(back.Z, -1.8, "a camera behind the avatar stops at the other wall");

        rig = new StageCameraRig(limits);
        rig.Rotate(0, -100000, 1000, CameraFrame);
        Check(rig.Save().Contains(",-70.000,") || rig.Save().Contains(",70.000,"), $"a room limits the pitch to 70 degrees: {rig.Save()}");
    }
}
