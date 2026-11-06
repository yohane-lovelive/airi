using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>Loads the models of one file format, and owns the avatar of this format on the stage.</summary>
    public interface IAvatarHost
    {
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
    }
}
