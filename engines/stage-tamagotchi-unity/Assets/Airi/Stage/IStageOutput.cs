using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// Where the stage shows the avatar. A normal window and a spatial reality display differ in
    /// their cameras and their scale, so the rest of the stage does not know which one runs.
    /// </summary>
    public interface IStageOutput
    {
        /// <summary>Shows the whole avatar. It runs when a model loads.</summary>
        void Frame(Bounds avatarBounds);

        /// <summary>Follows a change of the output, for example a new window size. It runs each frame.</summary>
        void Tick();
    }
}
