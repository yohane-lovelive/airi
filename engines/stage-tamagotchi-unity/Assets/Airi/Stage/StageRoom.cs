using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Airi.Stage
{
    /// <summary>
    /// A room around the avatar. The import of the Editor makes it from a local package, as a bundle and
    /// a <c>room.json</c> in one folder.
    ///
    /// Use it through the argument <c>--airi-room=&lt;folder&gt;</c> of the player, or the environment
    /// variable AIRI_UNITY_STAGE_ROOM. Without them, the stage shows no room. This is a prototype, so the
    /// settings page has no control for it.
    ///
    /// State: the scene of the room, which stays loaded as long as the player runs.
    /// </summary>
    public sealed class StageRoom
    {
        /// <summary>A real camera in a room needs a wider lens, or the whole avatar does not fit between the walls.</summary>
        public const float FieldOfView = 45f;

        /// <summary>The camera stays this far inside the walls, so the near plane never cuts a wall.</summary>
        private const double WallClearance = 0.2;

        private StageRoom(StageRoomManifest manifest)
        {
            Manifest = manifest;
        }

        public StageRoomManifest Manifest { get; }

        public StageCameraLimits CameraLimits => StageCameraLimits.InRoom(Manifest.Box, WallClearance);

        /// <summary>
        /// Loads the room of the arguments or the environment, next to the stage scene.
        ///
        /// Returns:
        /// - The room, or null when the arguments name no room or the room fails. The log has the cause.
        /// </summary>
        public static async Task<StageRoom> LoadAsync(string[] arguments, CancellationToken cancellation)
        {
            string folder = StageRoomManifest.FindFolder(arguments, Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_ROOM"));
            if (folder == null)
            {
                return null;
            }

            try
            {
                StageRoomManifest manifest = StageRoomManifest.Parse(File.ReadAllText(Path.Combine(folder, StageRoomManifest.FileName)));
                AssetBundle bundle = AssetBundle.LoadFromFile(Path.Combine(folder, manifest.Bundle));
                if (bundle == null)
                {
                    throw new StageRoomException($"Unity could not read the bundle {manifest.Bundle}.");
                }

                string[] scenes = bundle.GetAllScenePaths();
                if (scenes.Length != 1)
                {
                    throw new StageRoomException($"The bundle {manifest.Bundle} must hold one scene, and it holds {scenes.Length}.");
                }

                AsyncOperation load = SceneManager.LoadSceneAsync(scenes[0], LoadSceneMode.Additive);
                while (!load.isDone)
                {
                    cancellation.ThrowIfCancellationRequested();
                    await Task.Yield();
                }

                // The active scene gives the sky, the ambient light, and the fog, so the room keeps its own.
                SceneManager.SetActiveScene(SceneManager.GetSceneByPath(scenes[0]));

                // Light probes of a scene that loads next to another scene take part only after this call.
                LightProbes.Tetrahedralize();

                Debug.Log($"[Airi] Room {manifest.Name}: {LightmapSettings.lightmaps.Length} lightmaps, stand at ({manifest.StandX}, {manifest.StandY}, {manifest.StandZ}), facing {manifest.FacingDegrees} degrees.");
                return new StageRoom(manifest);
            }
            catch (Exception error) when (!(error is OperationCanceledException))
            {
                Debug.LogError($"[Airi] Could not load the room in {folder}: {error.Message}");
                return null;
            }
        }

        /// <summary>Moves the root of the avatars to the stand point, and turns it to the facing of the room.</summary>
        public void PlaceAvatars(Transform root)
        {
            root.SetPositionAndRotation(
                new Vector3((float)Manifest.StandX, (float)Manifest.StandY, (float)Manifest.StandZ),
                Quaternion.Euler(0f, (float)Manifest.FacingDegrees, 0f));
        }
    }
}
