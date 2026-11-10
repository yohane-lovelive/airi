using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// Where the stage shows the avatar. A normal window and a spatial reality display differ in
    /// their cameras and their scale, so the rest of the stage does not know which one runs.
    /// </summary>
    public interface IStageOutput
    {
        /// <summary>Fits the output to a new avatar. It runs when a model loads.</summary>
        void Frame(Bounds avatarBounds);

        /// <summary>
        /// Moves the framing with the avatar, by the move of the avatar since the last <see cref="Frame"/>. A walk
        /// calls it in each frame. The angles of the camera stay.
        /// </summary>
        void Follow(Vector3 offset);

        /// <summary>Follows a change of the output, for example a new window size. It runs each frame.</summary>
        void Tick();
    }
}
