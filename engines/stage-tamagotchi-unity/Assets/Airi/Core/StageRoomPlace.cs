namespace Airi.Stage.Core
{
    /// <summary>What the character does at a place of a room.</summary>
    public enum StageRoomPlaceRole
    {
        /// <summary>A monitor or a TV. She watches it from its seat, or she stands in front of it.</summary>
        Screen,

        /// <summary>A chair, a sofa, a bench, or a bed. She sits on it.</summary>
        Seat,
    }

    /// <summary>
    /// The surface of a screen, where a game can show. A static batch in the player hides the mesh of the screen, so the
    /// import measures the surface and writes it to <c>room.json</c>.
    /// </summary>
    public sealed class StageRoomScreen
    {
        public StageRoomScreen(string objectName, string material, StagePoint center, double facingDegrees, double width, double height)
        {
            ObjectName = objectName;
            Material = material;
            Center = center;
            FacingDegrees = facingDegrees;
            Width = width;
            Height = height;
        }

        /// <summary>The name of the object with the screen.</summary>
        public string ObjectName { get; }

        /// <summary>The name of the material of the screen surface. A game replaces this material only.</summary>
        public string Material { get; }

        /// <summary>The middle of the surface.</summary>
        public StagePoint Center { get; }

        /// <summary>The direction that the surface faces, about the vertical axis. At 0 degrees it faces +Z, and 90 degrees face +X.</summary>
        public double FacingDegrees { get; }

        /// <summary>The size of the surface, in world units.</summary>
        public double Width { get; }

        public double Height { get; }
    }

    /// <summary>
    /// A place of a room with a meaning, for example the desk with the monitor. The room import finds the places from the
    /// names of objects, and the owner can edit them in <c>room.json</c>.
    /// </summary>
    public sealed class StageRoomPlace
    {
        public StageRoomPlace(string name, StageRoomPlaceRole role, StagePoint stand, double facingDegrees, StagePoint? seat, StageRoomScreen screen)
        {
            Name = name;
            Role = role;
            Stand = stand;
            FacingDegrees = facingDegrees;
            Seat = seat;
            Screen = screen;
        }

        public string Name { get; }

        public StageRoomPlaceRole Role { get; }

        /// <summary>The point of the NavMesh where she stands before she sits, or where she stands to watch a screen.</summary>
        public StagePoint Stand { get; }

        /// <summary>The facing of the character at the place, about the vertical axis, as the facing of the room.</summary>
        public double FacingDegrees { get; }

        /// <summary>
        /// The middle of the front edge of the seat, on its surface, where her knees go. Null when she stands at the place.
        /// The stage puts her hips behind this point by the length of her thighs, because models differ in it.
        /// </summary>
        public StagePoint? Seat { get; }

        /// <summary>The screen of the place. Only a place with the role <see cref="StageRoomPlaceRole.Screen"/> has one.</summary>
        public StageRoomScreen Screen { get; }

        /// <summary>Names the place for a log, for example "モニター.002 (screen with a seat)".</summary>
        public override string ToString()
        {
            string kind = Role == StageRoomPlaceRole.Seat ? "seat" : Seat != null ? "screen with a seat" : "screen";
            return $"{Name} ({kind})";
        }
    }
}
