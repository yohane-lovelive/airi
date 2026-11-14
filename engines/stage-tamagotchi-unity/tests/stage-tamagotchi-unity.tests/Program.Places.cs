using System;
using System.Linq;
using Airi.Stage.Core;

/// <summary>Tests of the places of a room: the room file, the names, the screens, and the seats.</summary>
public static partial class Program
{
    private const string PlacesField = @"""places"": [
    {
      ""name"": ""モニター.002"", ""role"": ""screen"", ""stand"": [-1, 0, 0], ""facing"": 270, ""seat"": [-1.5, 0.5, 0.1],
      ""screen"": { ""object"": ""モニター.002"", ""material"": ""WallPaper"", ""center"": [-2.3, 1, 0.1], ""facing"": 90, ""width"": 0.91, ""height"": 0.52 }
    },
    {
      ""name"": ""TV"", ""role"": ""screen"", ""stand"": [0, 0, 1], ""facing"": 0,
      ""screen"": { ""object"": ""TV"", ""material"": ""Black_re"", ""center"": [0, 1, 2.2], ""facing"": 180, ""width"": 2.4, ""height"": 1.4 }
    },
    { ""name"": ""Sofa"", ""role"": ""seat"", ""stand"": [1, 0, -1], ""facing"": 90, ""seat"": [1.2, 0.45, -1] }
  ],";

    private static void TestRoomPlaces()
    {
        TestPlacesFile();
        TestPlacesRejections();
        TestPlaceNames();
        TestScreenSurface();
        TestSeatSurface();
        TestSeatInFrontOfScreen();
    }

    private static string RoomWithPlaces(string places)
    {
        return RoomFile.Replace("\"facing\": 90,", "\"facing\": 90, " + places);
    }

    private static void TestPlacesFile()
    {
        Check(StageRoomManifest.Parse(RoomFile).Places == null, "a room file without places gives no list");
        Check(StageRoomManifest.Parse(RoomWithPlaces("\"places\": [],")).Places.Count == 0, "an empty list of places stays empty");

        StageRoomManifest room = StageRoomManifest.Parse(RoomWithPlaces(PlacesField));
        Check(room.Places.Count == 3, "the room file gives three places");
        StageRoomPlace desk = room.Places[0];
        Check(desk.Name == "モニター.002" && desk.Role == StageRoomPlaceRole.Screen, "the first place is the screen of the desk");
        CheckNear(desk.Stand.X, -1, "a place gives its stand point");
        CheckNear(desk.FacingDegrees, 270, "a place gives its facing");
        Check(desk.Seat is StagePoint seat && Math.Abs(seat.Y - 0.5) < 1e-9, "a screen place can have a seat");
        Check(desk.Screen.ObjectName == "モニター.002" && desk.Screen.Material == "WallPaper", "a screen names its object and its material");
        CheckNear(desk.Screen.Center.X, -2.3, "a screen gives its center");
        CheckNear(desk.Screen.FacingDegrees, 90, "a screen gives its facing");
        CheckNear(desk.Screen.Width, 0.91, "a screen gives its width");
        CheckNear(desk.Screen.Height, 0.52, "a screen gives its height");
        Check(room.Places[1].Seat == null, "a screen place without a seat is a place to stand");
        Check(room.Places[2].Role == StageRoomPlaceRole.Seat && room.Places[2].Screen == null, "a seat place has no screen");
        Check(string.Join(", ", room.Places) == "モニター.002 (screen with a seat), TV (screen), Sofa (seat)", $"a log names each place and its kind: {string.Join(", ", room.Places)}");

        StageRoomManifest copy = StageRoomManifest.Parse(room.ToJson());
        Check(string.Join("|", copy.Places.Select(place => place.Name)) == "モニター.002|TV|Sofa", "the places survive a write in their order");
        Check(copy.Places[0].Seat is StagePoint copied && Math.Abs(copied.Z - 0.1) < 1e-9, "a seat survives a write");
        CheckNear(copy.Places[1].Screen.Width, 2.4, "a screen survives a write");
        Check(copy.Places[1].Seat == null && copy.Places[2].Screen == null, "missing seats and screens stay missing after a write");
        Check(StageRoomManifest.Parse(StageRoomManifest.Parse(RoomFile).ToJson()).Places == null, "a room without a list writes no list");
    }

    private static void TestPlacesRejections()
    {
        string sofa = "{ \"name\": \"Sofa\", \"role\": \"seat\", \"stand\": [1, 0, -1], \"facing\": 90, \"seat\": [1.2, 0.45, -1] }";
        string screen = "\"screen\": { \"object\": \"TV\", \"material\": \"Black\", \"center\": [0, 1, 2], \"facing\": 180, \"width\": 2.4, \"height\": 1.4 }";
        CheckRoomRejected(RoomWithPlaces("\"places\": {},"), "places that are not a list");
        CheckRoomRejected(RoomWithPlaces("\"places\": [3],"), "a place that is not an object");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("\"name\": \"Sofa\", ", string.Empty)}],"), "a place without a name");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("\"seat\", \"stand\"", "\"bed\", \"stand\"")}],"), "a place with another role");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace(", \"seat\": [1.2, 0.45, -1]", string.Empty)}],"), "a seat place without a seat");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("[1, 0, -1]", "[1, 0, -5]")}],"), "a stand point outside the box");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("[1.2, 0.45, -1]", "[1.2, 3, -1]")}],"), "a seat point outside the box");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("\"facing\": 90", "\"facing\": \"east\"")}],"), "a place with a facing that is not a number");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{sofa.Replace("}", ", " + screen + " }")}],"), "a seat place with a screen");

        string tv = "{ \"name\": \"TV\", \"role\": \"screen\", \"stand\": [0, 0, 1], \"facing\": 0, " + screen + " }";
        Check(StageRoomManifest.Parse(RoomWithPlaces($"\"places\": [{tv}],")).Places.Count == 1, "a screen place without a seat is valid");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{tv.Replace(", " + screen, string.Empty)}],"), "a screen place without a screen");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{tv.Replace("\"width\": 2.4", "\"width\": 0")}],"), "a screen without a width");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{tv.Replace("\"material\": \"Black\", ", string.Empty)}],"), "a screen without a material");
        CheckRoomRejected(RoomWithPlaces($"\"places\": [{tv.Replace("[0, 1, 2]", "[0, 1]")}],"), "a screen center with two numbers");
    }

    private static void TestPlaceNames()
    {
        foreach (string name in new[] { "モニター.002", "Monitor_L", "Display", "TV", "TV.002", "テレビ" })
        {
            Check(StageRoomPlaceNames.IsScreenName(name), $"{name} is a screen");
        }

        foreach (string name in new[] { "Light_MonitorLight", "TV_Light", "TVStand", "テレビ台", "MonitorArm", "PC", "Wall" })
        {
            Check(!StageRoomPlaceNames.IsScreenName(name), $"{name} is not a screen");
        }

        Check(StageRoomPlaceNames.IsTvName("TV.001") && !StageRoomPlaceNames.IsTvName("モニター.002"), "a TV is told from a monitor");
        Check(!StageRoomPlaceNames.IsTvName("TV_Monitor"), "a monitor with TV in its name counts as a monitor");

        foreach (string name in new[] { "Chair.006", "DeskChair", "Sofa.012", "Bed.003", "BedFrame", "ソファー", "ベッド", "椅子_1", "Stool", "Bench" })
        {
            Check(StageRoomPlaceNames.IsSeatName(name), $"{name} is a seat");
        }

        foreach (string name in new[] { "SofaTable", "Bedside_Table", "Bed_Light", "ソファテーブル", "Table.001", "Wall" })
        {
            Check(!StageRoomPlaceNames.IsSeatName(name), $"{name} is not a seat");
        }
    }

    private static void TestScreenSurface()
    {
        // The panel of the monitor of 2LDK: 0.91 m by 0.52 m at x -8.91, facing +X.
        StagePoint[] panel =
        {
            new StagePoint(-8.91, 0.71, 2.0),
            new StagePoint(-8.91, 1.23, 2.0),
            new StagePoint(-8.91, 1.23, 2.91),
            new StagePoint(-8.91, 0.71, 2.91),
        };
        StageRoomScreen screen = StageScreenSurface.Measure("モニター.002", "WallPaper", panel, new[] { 0, 1, 2, 0, 2, 3 });
        Check(screen != null, "a flat upright panel is a screen");
        CheckNear(screen.FacingDegrees, 90, "a screen faces the side of its front faces");
        CheckNear(screen.Width, 0.91, "a screen gives its width");
        CheckNear(screen.Height, 0.52, "a screen gives its height");
        CheckNear(screen.Center.X, -8.91, "the center of a screen lies on it");
        CheckNear(screen.Center.Y, 0.97, "the center of a screen lies in its middle");
        CheckNear(screen.Center.Z, 2.455, "the center of a screen lies in its middle across");
        Check(screen.ObjectName == "モニター.002" && screen.Material == "WallPaper", "a screen keeps its object and its material");
        CheckNear(StageScreenSurface.Measure("a", "b", panel, new[] { 0, 2, 1, 0, 3, 2 }).FacingDegrees, 270, "the other winding faces the other side");

        StagePoint[] small = panel.Select(point => new StagePoint(point.X, 0.71 + ((point.Y - 0.71) * 0.3), 2.0 + ((point.Z - 2.0) * 0.3))).ToArray();
        Check(StageScreenSurface.Measure("a", "b", small, new[] { 0, 1, 2, 0, 2, 3 }) == null, "a small panel is no screen");

        StagePoint[] top =
        {
            new StagePoint(0, 0.7, 0),
            new StagePoint(0, 0.7, 1),
            new StagePoint(1, 0.7, 1),
            new StagePoint(1, 0.7, 0),
        };
        Check(StageScreenSurface.Measure("a", "b", top, new[] { 0, 1, 2, 0, 2, 3 }) == null, "the top of a table is no screen");

        // The front and the back of a thin panel cancel each other, as for a glass with two sides.
        Check(StageScreenSurface.Measure("a", "b", panel, new[] { 0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2 }) == null, "a panel with two sides is no screen");
    }

    /// <summary>Makes a grid of 2.5 cm cells from a function of the middle of each cell. NaN means no hit.</summary>
    private static StageHeightGrid SeatGrid(double minX, double minZ, double maxX, double maxZ, Func<double, double, (double Height, bool Upward)> surface)
    {
        double cell = StageSeatSearch.CellSize;
        int countX = (int)Math.Round((maxX - minX) / cell);
        int countZ = (int)Math.Round((maxZ - minZ) / cell);
        var heights = new double[countX * countZ];
        var upward = new bool[countX * countZ];
        for (int z = 0; z < countZ; z++)
        {
            for (int x = 0; x < countX; x++)
            {
                (double height, bool up) = surface(minX + ((x + 0.5) * cell), minZ + ((z + 0.5) * cell));
                heights[x + (z * countX)] = height;
                upward[x + (z * countX)] = up;
            }
        }

        return new StageHeightGrid(minX, minZ, cell, countX, countZ, heights, upward);
    }

    private static void TestSeatSurface()
    {
        // A chair on the floor at y 0: a seat of 0.5 m at 0.45 m, and a slanted back on -Z.
        (double, bool) Chair(double x, double z)
        {
            if (Math.Abs(x) <= 0.25 && z >= -0.35 && z <= -0.27)
            {
                return (0.9, false);
            }

            return Math.Abs(x) <= 0.25 && Math.Abs(z) <= 0.25 ? (0.45, true) : (double.NaN, false);
        }

        StageHeightGrid chair = SeatGrid(-0.4, -0.4, 0.4, 0.4, Chair);
        StageSeatSurface seat = StageSeatSearch.FindSurface(chair, 0);
        Check(seat != null, "a chair has a seat surface");
        CheckNear(seat.Height, 0.45, "the seat surface has the height of the seat");
        Check(Math.Abs(seat.CenterX) < 0.03 && Math.Abs(seat.CenterZ) < 0.03, $"the middle of a square seat is its center: {seat.CenterX:F3}, {seat.CenterZ:F3}");
        Check(Math.Abs(seat.BackDegrees.Value - 180) < 3, $"the back of a chair is on the side of its back: {seat.BackDegrees}");
        StagePoint front = StageSeatSearch.FrontEdge(chair, seat, 0);
        CheckNear(front.Z, 0.25, "the front edge lies at the front of the seat");
        CheckNear(front.X, seat.CenterX, "the front edge lies on the line of the facing");
        CheckNear(front.Y, 0.45, "the front edge lies on the seat");

        // A gaming chair: arms on both sides do not count as a back.
        StageHeightGrid armed = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => Math.Abs(x) >= 0.27 && Math.Abs(x) <= 0.33 && Math.Abs(z) <= 0.25 ? (0.7, true) : Chair(x, z));
        Check(Math.Abs(StageSeatSearch.FindSurface(armed, 0).BackDegrees.Value - 180) < 3, "two arms do not hide the back");
        StageHeightGrid arms = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => Math.Abs(x) >= 0.27 && Math.Abs(x) <= 0.33 && Math.Abs(z) <= 0.25 ? (0.7, true) : Math.Abs(x) <= 0.25 && Math.Abs(z) <= 0.25 ? (0.45, true) : (double.NaN, false));
        Check(StageSeatSearch.FindSurface(arms, 0)?.BackDegrees == null, "a bench with two arms has no back");

        StageHeightGrid stool = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => Math.Abs(x) <= 0.25 && Math.Abs(z) <= 0.25 ? (0.45, true) : (double.NaN, false));
        Check(StageSeatSearch.FindSurface(stool, 0).BackDegrees == null, "a stool has no back");
        Check(StageSeatSearch.FindSurface(stool, 0.2) == null, "a seat too near the floor is no seat");
        Check(StageSeatSearch.FindSurface(stool, -0.3) == null, "a seat too high above the floor is no seat");

        StageHeightGrid small = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => Math.Abs(x) <= 0.1 && Math.Abs(z) <= 0.1 ? (0.45, true) : (double.NaN, false));
        Check(StageSeatSearch.FindSurface(small, 0) == null, "a seat smaller than the hips is no seat");

        StageHeightGrid bowl = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => (0.3 + (1.6 * Math.Max(Math.Abs(x), Math.Abs(z))), true));
        Check(StageSeatSearch.FindSurface(bowl, 0) == null, "a deep curve has no flat seat");

        StageHeightGrid sideways = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => x >= -0.35 && x <= -0.27 && Math.Abs(z) <= 0.25 ? (0.9, false) : Chair(z, x));
        Check(Math.Abs(StageSeatSearch.FindSurface(sideways, 0).BackDegrees.Value - 270) < 3, "a back on -X faces the seat to +X");

        // An L-shaped sofa: the middle of the shapes lies off the sofa, so the middle moves onto it.
        StageHeightGrid sofa = SeatGrid(0, 0, 2, 2, (x, z) => (x <= 1 && z <= 0.5) || (x <= 0.5 && z <= 2) ? (0.45, true) : (double.NaN, false));
        StageSeatSurface corner = StageSeatSearch.FindSurface(sofa, 0);
        bool onSofa = (corner.CenterX <= 1 && corner.CenterZ <= 0.5) || (corner.CenterX <= 0.5 && corner.CenterZ <= 2);
        Check(onSofa, $"the middle of an L-shaped sofa lies on it: {corner.CenterX:F2}, {corner.CenterZ:F2}");

        // A chair turned by 45 degrees: a seat of 0.45 m holds the circle, although no square along the axes fits.
        StageHeightGrid turned = SeatGrid(-0.4, -0.4, 0.4, 0.4, (x, z) => Math.Abs(x) + Math.Abs(z) <= 0.32 ? (0.45, true) : (double.NaN, false));
        Check(StageSeatSearch.FindSurface(turned, 0) != null, "a turned chair has a seat");

        // The cushions of a sofa with rounded edges: the cushion with a back wins over a larger one without a back.
        StageHeightGrid cushions = SeatGrid(-1, -0.5, 1.2, 0.5, (x, z) =>
        {
            if (x <= -0.97)
            {
                return (0.9, false);
            }

            if (x >= -0.95 && x <= -0.45 && Math.Abs(z) <= 0.25)
            {
                return (0.45, true);
            }

            return x >= 0 && x <= 1 && Math.Abs(z) <= 0.45 ? (0.45, true) : (double.NaN, false);
        });
        StageSeatSurface cushion = StageSeatSearch.FindSurface(cushions, 0);
        Check(Math.Abs(cushion.BackDegrees.Value - 270) < 3 && cushion.CenterX < -0.4, $"a cushion with a back wins over a larger one: {cushion.CenterX:F2}, {cushion.BackDegrees}");

        // A low bed: pillows at the far end are no back, so it has none.
        StageHeightGrid bed = SeatGrid(-1.5, -1, 1.5, 1, (x, z) => x >= 1.1 ? (0.55, true) : (0.35, true));
        StageSeatSurface edge = StageSeatSearch.FindSurface(bed, 0);
        Check(edge != null && edge.BackDegrees == null, "pillows at the end of a bed are no back");
        CheckNear(StageSeatSearch.FrontEdge(bed, edge, 180).Z, -1, "a bed has its front edge at its side");

        CheckNear(StageSeatSearch.FacingOf(1, 0), 90, "+X is a facing of 90 degrees");
        CheckNear(StageSeatSearch.FacingOf(0, -1), 180, "-Z is a facing of 180 degrees");
        CheckNear(StageSeatSearch.FacingOf(-1, 0), 270, "-X is a facing of 270 degrees");
        CheckNear(StageSeatSearch.FacingOf(0, 1), 0, "+Z is a facing of 0 degrees");
    }

    private static void TestSeatInFrontOfScreen()
    {
        var screen = new StageRoomScreen("monitor", "screen", new StagePoint(0, 1, 0), 90, 0.9, 0.5);
        Check(StageSeatSearch.InFrontOf(screen, 0.8, 0.1), "a chair at a desk is in front of its monitor");
        Check(!StageSeatSearch.InFrontOf(screen, -0.5, 0), "a seat behind a screen is not in front of it");
        Check(!StageSeatSearch.InFrontOf(screen, 1.6, 0), "a seat far from a screen is not in front of it");
        Check(StageSeatSearch.InFrontOf(screen, 0.8, 0.9), "a seat a little past the side of a screen is in front of it");
        Check(!StageSeatSearch.InFrontOf(screen, 0.8, 1.0), "a seat far to the side of a screen is not in front of it");
    }
}
