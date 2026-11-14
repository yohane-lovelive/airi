using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>Loads the models of one file format, and owns the avatar of this format on the stage.</summary>
    public interface IAvatarHost
    {
        /// <summary>The emotions of this kind of model.</summary>
        EmotionTable Emotions { get; }

        /// <summary>The height of the hips of the avatar in its rest pose, in meters, or 0 without an avatar. A walk takes its step length from it.</summary>
        float HipHeight { get; }

        /// <summary>The height of the head joint of the avatar in its rest pose, in meters, or 0 without an avatar. A turn to the viewer aims from it.</summary>
        float HeadHeight { get; }

        /// <summary>The length from the hip joint to the knee of the avatar, in meters, or 0 without an avatar. A sit takes it.</summary>
        float ThighLength { get; }

        /// <summary>
        /// Loads a model and replaces the avatar of this host.
        ///
        /// Returns:
        /// - The bounds of the avatar, or null when a newer load of this host replaced this load.
        ///
        /// Throws:
        /// - The cause when the file is missing or broken. The old avatar stays.
        /// </summary>
        Task<Bounds?> LoadAsync(string path, CancellationToken cancellation);

        /// <summary>Removes the avatar of this host. The stage calls it when another format takes over.</summary>
        void Clear();

        /// <summary>
        /// Moves the avatar to the state of this frame, once each frame. Without an avatar, it does nothing.
        /// </summary>
        void ApplyCharacter(CharacterDriver character, float deltaSeconds);
    }
}
