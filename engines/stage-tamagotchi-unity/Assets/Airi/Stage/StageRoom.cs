using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using Unity.AI.Navigation;
using UnityEngine;
using UnityEngine.AI;
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
    /// State: the scene of the room, which stays loaded as long as the player runs. Its NavMesh, when the import
    /// baked one, stays in the NavMesh of the player as long as the scene.
    /// </summary>
    public sealed class StageRoom
    {
        /// <summary>A real camera in a room needs a wider lens, or the whole avatar does not fit between the walls.</summary>
        public const float FieldOfView = 45f;

        /// <summary>The camera stays this far inside the walls, so the near plane never cuts a wall.</summary>
        private const double WallClearance = 0.2;

        private const int CheckPoints = 20;

        private StageRoom(StageRoomManifest manifest)
        {
            Manifest = manifest;
        }

        public StageRoomManifest Manifest { get; }

        /// <summary>Whether the room has a NavMesh. A room from an import before the NavMesh step has none.</summary>
        public bool HasNavMesh { get; private set; }

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
                var room = new StageRoom(manifest);
                room.CheckNavMesh(SceneManager.GetSceneByPath(scenes[0]));
                return room;
            }
            catch (Exception error) when (!(error is OperationCanceledException))
            {
                Debug.LogError($"[Airi] Could not load the room in {folder}: {error.Message}");
                return null;
            }
        }

        /// <summary>
        /// Finds the NavMesh of the room, and logs how much of the floor the stand point reaches. The points come from
        /// a random sequence with a fixed seed, so each run of one room gives the same result.
        /// </summary>
        private void CheckNavMesh(Scene scene)
        {
            int surfaces = scene.GetRootGameObjects().Sum(root => root.GetComponentsInChildren<NavMeshSurface>().Length);
            if (surfaces == 0)
            {
                Debug.LogWarning($"[Airi] Room {Manifest.Name} has no NavMesh, so the character cannot walk in it. Import the room again.");
                return;
            }

            var stand = new Vector3((float)Manifest.StandX, (float)Manifest.StandY, (float)Manifest.StandZ);
            if (!NavMesh.SamplePosition(stand, out NavMeshHit start, 1f, NavMesh.AllAreas))
            {
                Debug.LogWarning($"[Airi] Room {Manifest.Name}: the stand point is not on the NavMesh.");
                return;
            }

            HasNavMesh = true;
            StageRoomBox box = Manifest.Box;
            var random = new System.Random(1);
            var path = new NavMeshPath();
            int found = 0;
            int reached = 0;
            for (int attempt = 0; attempt < CheckPoints * 20 && found < CheckPoints; attempt++)
            {
                var point = new Vector3(
                    (float)(box.MinX + (random.NextDouble() * (box.MaxX - box.MinX))),
                    start.position.y,
                    (float)(box.MinZ + (random.NextDouble() * (box.MaxZ - box.MinZ))));
                if (!NavMesh.SamplePosition(point, out NavMeshHit hit, 0.5f, NavMesh.AllAreas) || Mathf.Abs(hit.position.y - start.position.y) > StageRoomManifest.SameFloor)
                {
                    continue;
                }

                found++;
                if (NavMesh.CalculatePath(start.position, hit.position, NavMesh.AllAreas, path) && path.status == NavMeshPathStatus.PathComplete)
                {
                    reached++;
                }
            }

            int triangles = NavMesh.CalculateTriangulation().indices.Length / 3;
            Debug.Log($"[Airi] Room {Manifest.Name}: NavMesh with {triangles} triangles. {reached} of {found} points on the floor are reachable from the stand point.");
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
