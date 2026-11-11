using System;
using System.Collections.Generic;
using System.Linq;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Tells screens and seats from the other objects of a room by their names. The room import finds places from them.
    /// A world can name its furniture in another way, so the owner can edit the places in <c>room.json</c>.
    /// </summary>
    public static class StageRoomPlaceNames
    {
        private static readonly string[] MonitorWords = { "monitor", "display", "screen", "モニター", "ディスプレイ", "スクリーン" };

        private static readonly string[] TvWords = { "tv", "テレビ" };

        /// <summary>Parts near a screen that are no screen, for example the light on a monitor or the stand of a TV.</summary>
        private static readonly string[] ScreenExclusions = { "light", "lamp", "stand", "board", "rack", "shelf", "arm", "frame", "ライト", "ランプ", "台", "棚", "枠" };

        private static readonly string[] SeatWords = { "chair", "sofa", "couch", "bench", "stool", "seat", "bed", "椅子", "イス", "ソファ", "ベンチ", "ベッド" };

        /// <summary>Furniture with the name of a seat in its name, for example a sofa table or a bedside lamp.</summary>
        private static readonly string[] SeatExclusions = { "table", "bedside", "light", "lamp", "shelf", "テーブル", "机", "ライト", "ランプ", "棚" };

        /// <summary>Whether a name is the name of a monitor or a TV, and not of a part near it. The case does not matter.</summary>
        public static bool IsScreenName(string name)
        {
            string lower = name.ToLowerInvariant();
            return (MonitorWords.Any(lower.Contains) || TvWords.Any(lower.Contains)) && !ScreenExclusions.Any(lower.Contains);
        }

        /// <summary>Whether a screen name is the name of a TV. A monitor comes before a TV, because a PC game shows on a monitor.</summary>
        public static bool IsTvName(string name)
        {
            string lower = name.ToLowerInvariant();
            return TvWords.Any(lower.Contains) && !MonitorWords.Any(lower.Contains);
        }

        /// <summary>Whether a name is the name of a seat, for example a chair, a sofa, or a bed. The case does not matter.</summary>
        public static bool IsSeatName(string name)
        {
            string lower = name.ToLowerInvariant();
            return SeatWords.Any(lower.Contains) && !SeatExclusions.Any(lower.Contains);
        }
    }

    /// <summary>
    /// The heights of a piece of furniture on a grid of its floor plan, from rays down. The cell (x, z) has its middle at
    /// (<see cref="MinX"/> + (x + 0.5) × <see cref="CellSize"/>, <see cref="MinZ"/> + (z + 0.5) × <see cref="CellSize"/>).
    /// </summary>
    public sealed class StageHeightGrid
    {
        private readonly double[] _heights;
        private readonly bool[] _upward;

        /// <param name="heights">The height of the first hit of each cell, x first. NaN when the ray hits nothing.</param>
        /// <param name="upward">Whether the surface of the first hit faces up.</param>
        public StageHeightGrid(double minX, double minZ, double cellSize, int countX, int countZ, double[] heights, bool[] upward)
        {
            if (heights.Length != countX * countZ || upward.Length != countX * countZ)
            {
                throw new ArgumentException("The grid needs one height and one direction for each cell.");
            }

            MinX = minX;
            MinZ = minZ;
            CellSize = cellSize;
            CountX = countX;
            CountZ = countZ;
            _heights = heights;
            _upward = upward;
        }

        public double MinX { get; }

        public double MinZ { get; }

        public double CellSize { get; }

        public int CountX { get; }

        public int CountZ { get; }

        public double Height(int x, int z) => _heights[x + (z * CountX)];

        public bool Upward(int x, int z) => _upward[x + (z * CountX)];

        public double CellX(int x) => MinX + ((x + 0.5) * CellSize);

        public double CellZ(int z) => MinZ + ((z + 0.5) * CellSize);
    }

    /// <summary>The seat surface of a piece of furniture.</summary>
    public sealed class StageSeatSurface
    {
        public StageSeatSurface(double centerX, double centerZ, double height, double? backDegrees, IReadOnlyList<(int X, int Z)> cells)
        {
            CenterX = centerX;
            CenterZ = centerZ;
            Height = height;
            BackDegrees = backDegrees;
            Cells = cells;
        }

        /// <summary>A point of the surface where a square of <see cref="StageSeatSearch.SeatWidth"/> fits, near its middle.</summary>
        public double CenterX { get; }

        public double CenterZ { get; }

        /// <summary>The height of the surface in the world.</summary>
        public double Height { get; }

        /// <summary>The direction from the middle to the back of the seat, as a facing. Null for a seat without a back.</summary>
        public double? BackDegrees { get; }

        /// <summary>The cells of the grid that make the surface.</summary>
        public IReadOnlyList<(int X, int Z)> Cells { get; }
    }

    /// <summary>
    /// Finds seats and screens for the places of a room. The room import casts the rays and asks the NavMesh. This class
    /// does the math, so <c>dotnet</c> tests it.
    /// </summary>
    public static class StageSeatSearch
    {
        /// <summary>The import casts one ray down for each cell of this size.</summary>
        public const double CellSize = 0.025;

        /// <summary>A seat surface lies this high above the floor. A bed is low, and a bar stool is too high to sit on in a clip.</summary>
        public const double LowestSeat = 0.3;

        public const double HighestSeat = 0.65;

        /// <summary>
        /// A seat holds a circle of this width, so her hips fit on it. A circle does not depend on the turn of the seat, as
        /// a square along the axes does.
        /// </summary>
        public const double SeatWidth = 0.3;

        /// <summary>Two cells side by side belong to one surface when their heights differ by this much at most.</summary>
        public const double SameHeight = 0.03;

        /// <summary>A part this much above the seat, and this near to its middle, is a back or an arm.</summary>
        public const double BackRise = 0.15;

        public const double BackReach = 0.8;

        /// <summary>
        /// The directions of a back pull to one side. When they pull less than this share of their number, the parts
        /// stand around the seat, and none of them is the back.
        /// </summary>
        public const double BackPull = 0.3;

        /// <summary>The front edge is the farthest cell in the facing within this distance to each side of the middle.</summary>
        public const double FrontBand = 0.15;

        /// <summary>A seat belongs to a screen when its middle is this near in front of the screen.</summary>
        public const double ScreenDistance = 1.5;

        /// <summary>A seat to the side of a screen still belongs to it when it is this far past the side of the screen.</summary>
        public const double ScreenMargin = 0.5;

        /// <summary>
        /// Finds the seat surface of a piece of furniture: a flat area at the height of a seat that holds a circle of
        /// <see cref="SeatWidth"/>. The rounded edges of cushions split a sofa into one area for each cushion. So an area
        /// with a back wins, and then the largest area. The cushion without a back in front of a sofa then loses.
        ///
        /// Returns:
        /// - The surface, or null when the furniture has none, for example a round chair with a deep curve.
        /// </summary>
        public static StageSeatSurface FindSurface(StageHeightGrid grid, double floorY)
        {
            var visited = new bool[grid.CountX * grid.CountZ];
            StageSeatSurface best = null;
            for (int startZ = 0; startZ < grid.CountZ; startZ++)
            {
                for (int startX = 0; startX < grid.CountX; startX++)
                {
                    if (visited[startX + (startZ * grid.CountX)] || !IsSeatCell(grid, startX, startZ, floorY))
                    {
                        continue;
                    }

                    StageSeatSurface surface = Measure(grid, Flood(grid, startX, startZ, floorY, visited));
                    bool better = best == null
                        || (surface != null && surface.BackDegrees != null && best.BackDegrees == null)
                        || (surface != null && (surface.BackDegrees != null) == (best.BackDegrees != null) && surface.Cells.Count > best.Cells.Count);
                    if (surface != null && better)
                    {
                        best = surface;
                    }
                }
            }

            return best;
        }

        /// <summary>Measures one flat area. Null when no circle of <see cref="SeatWidth"/> fits in it.</summary>
        private static StageSeatSurface Measure(StageHeightGrid grid, List<(int X, int Z)> region)
        {
            List<(double X, double Z)> centers = CircleCenters(grid, region);
            if (centers.Count == 0)
            {
                return null;
            }

            // The middle of an L-shaped area can lie off it, so the nearest place for the circle takes its place.
            double meanX = centers.Average(center => center.X);
            double meanZ = centers.Average(center => center.Z);
            (double X, double Z) middle = centers.OrderBy(center => Square(center.X - meanX) + Square(center.Z - meanZ)).First();
            double[] heights = region.Select(cell => grid.Height(cell.X, cell.Z)).OrderBy(height => height).ToArray();
            double height = heights[heights.Length / 2];
            return new StageSeatSurface(middle.X, middle.Z, height, FindBack(grid, middle.X, middle.Z, height), region);
        }

        /// <summary>
        /// Finds the middle of the front edge of a seat in a facing: the farthest cell of the surface in the facing, near
        /// the line through the middle. Her knees go there.
        /// </summary>
        public static StagePoint FrontEdge(StageHeightGrid grid, StageSeatSurface surface, double facingDegrees)
        {
            double radians = facingDegrees * Math.PI / 180.0;
            double forwardX = Math.Sin(radians);
            double forwardZ = Math.Cos(radians);
            double reach = 0;
            foreach ((int x, int z) in surface.Cells)
            {
                double offsetX = grid.CellX(x) - surface.CenterX;
                double offsetZ = grid.CellZ(z) - surface.CenterZ;
                double ahead = (offsetX * forwardX) + (offsetZ * forwardZ);
                double aside = (offsetX * forwardZ) - (offsetZ * forwardX);
                if (Math.Abs(aside) <= FrontBand)
                {
                    reach = Math.Max(reach, ahead + (grid.CellSize / 2.0));
                }
            }

            return new StagePoint(surface.CenterX + (forwardX * reach), surface.Height, surface.CenterZ + (forwardZ * reach));
        }

        /// <summary>Whether a seat with its middle at (x, z) stands in front of a screen, near enough to watch it.</summary>
        public static bool InFrontOf(StageRoomScreen screen, double x, double z)
        {
            double radians = screen.FacingDegrees * Math.PI / 180.0;
            double normalX = Math.Sin(radians);
            double normalZ = Math.Cos(radians);
            double offsetX = x - screen.Center.X;
            double offsetZ = z - screen.Center.Z;
            double ahead = (offsetX * normalX) + (offsetZ * normalZ);
            double aside = Math.Abs((offsetX * normalZ) - (offsetZ * normalX));
            return ahead > 0 && ahead <= ScreenDistance && aside <= (screen.Width / 2.0) + ScreenMargin;
        }

        /// <summary>The facing of a direction on the floor. At 0 degrees it is +Z, and 90 degrees are +X.</summary>
        public static double FacingOf(double directionX, double directionZ)
        {
            double degrees = Math.Atan2(directionX, directionZ) * 180.0 / Math.PI;
            return degrees < 0 ? degrees + 360.0 : degrees;
        }

        private static bool IsSeatCell(StageHeightGrid grid, int x, int z, double floorY)
        {
            double above = grid.Height(x, z) - floorY;
            return grid.Upward(x, z) && above >= LowestSeat && above <= HighestSeat;
        }

        /// <summary>Collects the seat cells that a walk from one cell reaches through steps of at most <see cref="SameHeight"/>.</summary>
        private static List<(int X, int Z)> Flood(StageHeightGrid grid, int startX, int startZ, double floorY, bool[] visited)
        {
            var region = new List<(int X, int Z)>();
            var open = new Stack<(int X, int Z)>();
            open.Push((startX, startZ));
            visited[startX + (startZ * grid.CountX)] = true;
            while (open.Count > 0)
            {
                (int x, int z) = open.Pop();
                region.Add((x, z));
                foreach ((int nextX, int nextZ) in new[] { (x + 1, z), (x - 1, z), (x, z + 1), (x, z - 1) })
                {
                    if (nextX < 0 || nextZ < 0 || nextX >= grid.CountX || nextZ >= grid.CountZ || visited[nextX + (nextZ * grid.CountX)])
                    {
                        continue;
                    }

                    if (IsSeatCell(grid, nextX, nextZ, floorY) && Math.Abs(grid.Height(nextX, nextZ) - grid.Height(x, z)) <= SameHeight)
                    {
                        visited[nextX + (nextZ * grid.CountX)] = true;
                        open.Push((nextX, nextZ));
                    }
                }
            }

            return region;
        }

        /// <summary>Gives the middle of each cell of the region where a circle of <see cref="SeatWidth"/> lies whole in the region.</summary>
        private static List<(double X, double Z)> CircleCenters(StageHeightGrid grid, List<(int X, int Z)> region)
        {
            var inside = new bool[grid.CountX * grid.CountZ];
            foreach ((int x, int z) in region)
            {
                inside[x + (z * grid.CountX)] = true;
            }

            // The circle covers each cell whose middle lies within its radius, less half a cell.
            double radius = ((SeatWidth / 2.0) - (grid.CellSize / 2.0)) / grid.CellSize;
            int reach = (int)Math.Floor(radius);
            var offsets = new List<(int X, int Z)>();
            for (int z = -reach; z <= reach; z++)
            {
                for (int x = -reach; x <= reach; x++)
                {
                    if ((x * x) + (z * z) <= radius * radius)
                    {
                        offsets.Add((x, z));
                    }
                }
            }

            var centers = new List<(double X, double Z)>();
            foreach ((int x, int z) in region)
            {
                bool fits = offsets.All(offset =>
                {
                    int cellX = x + offset.X;
                    int cellZ = z + offset.Z;
                    return cellX >= 0 && cellZ >= 0 && cellX < grid.CountX && cellZ < grid.CountZ && inside[cellX + (cellZ * grid.CountX)];
                });
                if (fits)
                {
                    centers.Add((grid.CellX(x), grid.CellZ(z)));
                }
            }

            return centers;
        }

        /// <summary>
        /// Finds the back of a seat from the parts above the seat near its middle. Their directions from the middle add
        /// up. Two arms face each other, so they cancel, and the back remains.
        ///
        /// Returns:
        /// - The direction of the back, or null when the parts pull to no side, or when a part stands in front.
        /// </summary>
        private static double? FindBack(StageHeightGrid grid, double centerX, double centerZ, double height)
        {
            var directions = new List<(double X, double Z)>();
            for (int z = 0; z < grid.CountZ; z++)
            {
                for (int x = 0; x < grid.CountX; x++)
                {
                    double top = grid.Height(x, z);
                    if (double.IsNaN(top) || top < height + BackRise)
                    {
                        continue;
                    }

                    double offsetX = grid.CellX(x) - centerX;
                    double offsetZ = grid.CellZ(z) - centerZ;
                    double distance = Math.Sqrt(Square(offsetX) + Square(offsetZ));
                    if (distance > 0 && distance <= BackReach)
                    {
                        directions.Add((offsetX / distance, offsetZ / distance));
                    }
                }
            }

            double sumX = directions.Sum(direction => direction.X);
            double sumZ = directions.Sum(direction => direction.Z);
            if (directions.Count == 0 || Math.Sqrt(Square(sumX) + Square(sumZ)) < BackPull * directions.Count)
            {
                return null;
            }

            // A part in front of the seat closes it, so she cannot sit there.
            double lengthBack = Math.Sqrt(Square(sumX) + Square(sumZ));
            double frontX = -sumX / lengthBack;
            double frontZ = -sumZ / lengthBack;
            if (directions.Any(direction => (direction.X * frontX) + (direction.Z * frontZ) > Math.Cos(Math.PI / 4.0)))
            {
                return null;
            }

            return FacingOf(sumX, sumZ);
        }

        private static double Square(double value) => value * value;
    }

    /// <summary>Measures the screen surface of a mesh part: a flat, upright, and large surface, for example the panel of a monitor.</summary>
    public static class StageScreenSurface
    {
        /// <summary>A smaller surface is a lamp or a button, not a screen.</summary>
        public const double SmallestArea = 0.1;

        /// <summary>The share of the area whose normals agree. A box or a curved body has less.</summary>
        public const double SmallestFlatness = 0.95;

        /// <summary>A surface whose normal rises more than this is a top of a table, not a screen.</summary>
        public const double SteepestNormal = 0.3;

        /// <summary>
        /// Measures a surface from its triangles in world space. A triangle faces the side from which its points
        /// turn clockwise, as in Unity.
        ///
        /// Returns:
        /// - The screen, or null when the surface is not flat, not upright, or too small.
        /// </summary>
        public static StageRoomScreen Measure(string objectName, string material, IReadOnlyList<StagePoint> points, IReadOnlyList<int> triangles)
        {
            double sumX = 0;
            double sumY = 0;
            double sumZ = 0;
            double area = 0;
            for (int index = 0; index + 2 < triangles.Count; index += 3)
            {
                StagePoint a = points[triangles[index]];
                StagePoint b = points[triangles[index + 1]];
                StagePoint c = points[triangles[index + 2]];
                double abX = b.X - a.X;
                double abY = b.Y - a.Y;
                double abZ = b.Z - a.Z;
                double acX = c.X - a.X;
                double acY = c.Y - a.Y;
                double acZ = c.Z - a.Z;

                // The cross product of Unity: with the left-handed axes of Unity, it gives the front of a clockwise triangle.
                double crossX = (abY * acZ) - (abZ * acY);
                double crossY = (abZ * acX) - (abX * acZ);
                double crossZ = (abX * acY) - (abY * acX);
                sumX += crossX / 2.0;
                sumY += crossY / 2.0;
                sumZ += crossZ / 2.0;
                area += Math.Sqrt((crossX * crossX) + (crossY * crossY) + (crossZ * crossZ)) / 2.0;
            }

            double length = Math.Sqrt((sumX * sumX) + (sumY * sumY) + (sumZ * sumZ));
            if (area < SmallestArea || length / area < SmallestFlatness || Math.Abs(sumY / length) > SteepestNormal)
            {
                return null;
            }

            double normalX = sumX / length;
            double normalY = sumY / length;
            double normalZ = sumZ / length;

            // The side axis lies on the floor, and the up axis lies in the surface.
            double sideLength = Math.Sqrt((normalZ * normalZ) + (normalX * normalX));
            double sideX = normalZ / sideLength;
            double sideZ = -normalX / sideLength;
            double upX = (normalY * sideZ) - (normalZ * 0);
            double upY = (normalZ * sideX) - (normalX * sideZ);
            double upZ = (normalX * 0) - (normalY * sideX);

            var used = triangles.Distinct().Select(index => points[index]).ToArray();
            double[] across = used.Select(point => (point.X * sideX) + (point.Z * sideZ)).ToArray();
            double[] along = used.Select(point => (point.X * upX) + (point.Y * upY) + (point.Z * upZ)).ToArray();
            double depth = used.Average(point => (point.X * normalX) + (point.Y * normalY) + (point.Z * normalZ));
            double middleAcross = (across.Min() + across.Max()) / 2.0;
            double middleAlong = (along.Min() + along.Max()) / 2.0;
            var center = new StagePoint(
                (sideX * middleAcross) + (upX * middleAlong) + (normalX * depth),
                (upY * middleAlong) + (normalY * depth),
                (sideZ * middleAcross) + (upZ * middleAlong) + (normalZ * depth));
            return new StageRoomScreen(objectName, material, center, StageSeatSearch.FacingOf(normalX, normalZ), across.Max() - across.Min(), along.Max() - along.Min());
        }
    }
}
