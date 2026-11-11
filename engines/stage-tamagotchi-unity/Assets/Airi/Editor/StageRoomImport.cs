using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Airi.Stage.Core;
using Unity.AI.Navigation;
using UnityEditor;
using UnityEditor.Rendering;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace Airi.Stage.Editor
{
    /// <summary>
    /// Makes rooms for the player from local Unity packages, for example worlds for VRChat from BOOTH.
    ///
    /// Put each package in its own folder, <c>.cache/rooms/&lt;name&gt;/&lt;file&gt;.unitypackage</c>, and run
    /// <c>pnpm run import:room</c>. The folder then has <c>room.bundle</c> and <c>room.json</c> for the
    /// argument <c>--airi-room</c> of the player.
    ///
    /// The licenses of such rooms forbid redistribution, so each file stays out of Git: the package and the
    /// bundle in <c>.cache</c>, and the imported assets in <c>Assets/LocalRooms</c>. The import takes only
    /// data from a package. Code and shaders stay out, because code runs in the Editor, and the shaders of
    /// VRChat worlds draw nothing in URP.
    ///
    /// Call stack:
    ///
    /// tools/run-unity.ps1 (-executeMethod)
    ///   -> <see cref="ImportAll"/>
    ///     -> <see cref="CopyDataFiles"/>
    ///     -> <see cref="CleanPrefabs"/>
    ///     -> <see cref="OpenRoomScene"/>
    ///     -> <see cref="CleanScene"/>
    ///     -> <see cref="ConvertMaterials"/>
    ///     -> <see cref="FillMissingSky"/>
    ///     -> <see cref="CheckLightmaps"/>
    ///     -> <see cref="MeasureRoom"/>
    ///     -> <see cref="OpenDoors"/>
    ///     -> <see cref="BakeNavMesh"/>
    ///     -> <see cref="BuildBundle"/>
    /// </summary>
    public static class StageRoomImport
    {
        private const string LocalRoot = "Assets/LocalRooms";
        private const string BundleName = "room.bundle";

        /// <summary>The shader that Unity gives a material when the package does not bring its shader.</summary>
        private const string MissingShader = "Hidden/InternalErrorShader";

        /// <summary>
        /// The import looks for walls and furniture at these heights over the floor: about a table, and about a chest.
        /// A table is lower than a chest, so a probe at the chest alone does not find it.
        /// </summary>
        private static readonly float[] ProbeHeights = { 0.5f, 1.2f };

        /// <summary>A spot needs this much free space above the floor, so a loft or a shelf is not over the avatar.</summary>
        private const float MinimumHeadroom = 2.1f;

        /// <summary>A spot keeps this far from each wall and each piece of furniture, so hair and hands stay out of them.</summary>
        private const float MinimumWallClearance = 0.6f;

        /// <summary>
        /// An open door must add this much floor, in square meters. A toilet adds about 1.5. The inside of a closet adds
        /// less, because the agent fits in it only as a narrow strip.
        /// </summary>
        private const float MinimumNewFloor = 1.5f;

        /// <summary>Each round can open a door that a room of the round before shows. Three rooms deep is enough for a home.</summary>
        private const int DoorRounds = 3;

        /// <summary>Asset kinds that hold only data. Each other kind stays out of the project.</summary>
        private static readonly HashSet<string> DataKinds = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".fbx", ".obj", ".png", ".jpg", ".jpeg", ".tga", ".psd", ".tif", ".tiff", ".exr", ".hdr",
            ".mat", ".prefab", ".unity", ".asset", ".lighting", ".anim", ".controller", ".overrideController",
            ".mask", ".cubemap", ".mesh", ".physicMaterial", ".physicsMaterial", ".renderTexture",
        };

        /// <summary>The entries of a package that the import reads: a folder per GUID with the asset, its meta file, and its path.</summary>
        private static readonly Regex PackageEntry = new Regex(@"^(?:\./)?([0-9a-f]{32})/(asset|asset\.meta|pathname)$");

        private static readonly Regex RoomName = new Regex(@"^[A-Za-z0-9][A-Za-z0-9_-]*$");

        /// <summary>A tag of a shader that draws after the opaque parts, for example <c>"Queue" = "Transparent-6"</c>.</summary>
        private static readonly Regex TransparentQueue = new Regex(@"""Queue""\s*=\s*""(Transparent|Overlay)", RegexOptions.IgnoreCase);

        /// <summary>The shader reference in the text of a material.</summary>
        private static readonly Regex ShaderReference = new Regex(@"m_Shader: \{fileID: -?\d+, guid: ([0-9a-f]{32})");

        /// <summary>The sky reference in the text of a scene. A file ID of 0 means that the scene has no sky.</summary>
        private static readonly Regex SkyReference = new Regex(@"m_SkyboxMaterial: \{fileID: (-?\d+)");

        /// <summary>Imports each room folder that has a package. A failed room fails the run, so the batch reports it.</summary>
        public static void ImportAll()
        {
            string roomsFolder = Path.GetFullPath(Path.Combine(Application.dataPath, "../../../.cache/rooms"));
            string[] folders = Directory.Exists(roomsFolder)
                ? Directory.GetDirectories(roomsFolder).Where(folder => Directory.GetFiles(folder, "*.unitypackage").Length > 0).OrderBy(folder => folder, StringComparer.Ordinal).ToArray()
                : Array.Empty<string>();

            if (folders.Length == 0)
            {
                Debug.LogError($"[Airi] No room package. Put each package in its own folder in {roomsFolder}.");
                EditorApplication.Exit(1);
                return;
            }

            int failures = 0;
            foreach (string folder in folders)
            {
                try
                {
                    Import(folder);
                }
                catch (Exception error)
                {
                    failures++;
                    Debug.LogError($"[Airi] Could not import the room in {folder}: {error}");
                }
            }

            if (failures > 0)
            {
                EditorApplication.Exit(1);
            }
        }

        private static void Import(string folder)
        {
            string name = Path.GetFileName(folder);
            if (!RoomName.IsMatch(name))
            {
                throw new InvalidOperationException($"Rename the folder {name}. A room name has only letters, digits, '-', and '_'.");
            }

            string[] packages = Directory.GetFiles(folder, "*.unitypackage");
            if (packages.Length != 1)
            {
                throw new InvalidOperationException($"The folder has {packages.Length} packages. Keep one package in each room folder.");
            }

            string target = $"{LocalRoot}/{name}";
            if (AssetDatabase.IsValidFolder(target))
            {
                AssetDatabase.DeleteAsset(target);
            }

            HashSet<string> transparentShaders = CopyDataFiles(packages[0], target);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            CleanPrefabs(target);

            Scene scene = OpenRoomScene(target);
            CleanScene(scene);
            ConvertMaterials(scene, target, transparentShaders);
            FillMissingSky(scene, target);
            CheckLightmaps(scene);
            EditorSceneManager.SaveScene(scene);
            AssetDatabase.SaveAssets();

            StageRoomManifest measured = MeasureRoom(scene, name, folder);
            IReadOnlyList<string> openDoors = OpenDoors(scene, folder, measured);
            var withDoors = new StageRoomManifest(measured.Name, measured.Bundle, measured.StandX, measured.StandY, measured.StandZ, measured.FacingDegrees, measured.Box, openDoors);
            BakeNavMesh(scene, target, withDoors.Box);
            IReadOnlyList<StageRoomPlace> places = FindPlaces(scene, folder, withDoors);
            var manifest = new StageRoomManifest(withDoors.Name, withDoors.Bundle, withDoors.StandX, withDoors.StandY, withDoors.StandZ, withDoors.FacingDegrees, withDoors.Box, openDoors, places);
            EditorSceneManager.SaveScene(scene);
            BuildBundle(scene.path, folder);

            // The player reads the file with the same rules, so a file that it refuses must fail the import here.
            string text = manifest.ToJson();
            StageRoomManifest.Parse(text);
            File.WriteAllText(Path.Combine(folder, StageRoomManifest.FileName), text);
            Debug.Log($"[Airi] Room {name} is ready in {folder}: scene {scene.path}, stand at ({manifest.StandX}, {manifest.StandY}, {manifest.StandZ}), facing {manifest.FacingDegrees} degrees, {manifest.Places.Count} places.");
        }

        /// <summary>
        /// Copies the data files of a package into <paramref name="target"/>, with their meta files, so each
        /// reference by GUID stays whole. A package is a gzip tar file with a folder for each asset.
        ///
        /// Returns:
        /// - The GUIDs of the shaders that the import leaves out and that draw transparent parts. The import reads
        ///   their text only.
        /// </summary>
        private static HashSet<string> CopyDataFiles(string package, string target)
        {
            var transparentShaders = new HashSet<string>(StringComparer.Ordinal);
            string temporary = Path.Combine(Path.GetTempPath(), $"airi-room-{Guid.NewGuid():N}");
            try
            {
                // The entries of an asset come in any order, so the files wait in a temporary folder.
                using (FileStream file = File.OpenRead(package))
                using (var gzip = new GZipStream(file, CompressionMode.Decompress))
                {
                    ReadTar(gzip, (entryName, data, size) =>
                    {
                        Match match = PackageEntry.Match(entryName);
                        if (!match.Success)
                        {
                            Skip(data, size);
                            return;
                        }

                        string folder = Path.Combine(temporary, match.Groups[1].Value);
                        Directory.CreateDirectory(folder);
                        using (FileStream output = File.Create(Path.Combine(folder, match.Groups[2].Value)))
                        {
                            Copy(data, output, size);
                        }
                    });
                }

                int copied = 0;
                var skipped = new List<string>();
                foreach (string assetFolder in Directory.GetDirectories(temporary))
                {
                    string pathFile = Path.Combine(assetFolder, "pathname");
                    string asset = Path.Combine(assetFolder, "asset");
                    if (!File.Exists(pathFile) || !File.Exists(asset))
                    {
                        continue;
                    }

                    string path = File.ReadAllText(pathFile).Split('\n')[0].Trim();
                    if (!IsSafeAssetPath(path))
                    {
                        throw new InvalidOperationException($"The package has an asset outside its Assets folder: {path}");
                    }

                    if (!DataKinds.Contains(Path.GetExtension(path)))
                    {
                        if (string.Equals(Path.GetExtension(path), ".shader", StringComparison.OrdinalIgnoreCase) && TransparentQueue.IsMatch(File.ReadAllText(asset)))
                        {
                            transparentShaders.Add(Path.GetFileName(assetFolder));
                        }

                        skipped.Add(path);
                        continue;
                    }

                    string destination = Path.Combine(target, path.Substring("Assets/".Length));
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    File.Copy(asset, destination, true);
                    string meta = Path.Combine(assetFolder, "asset.meta");
                    if (File.Exists(meta))
                    {
                        File.Copy(meta, destination + ".meta", true);
                    }

                    copied++;
                }

                Debug.Log($"[Airi] Copied {copied} data files to {target}. Left out {skipped.Count} files: {string.Join(", ", skipped.Select(Path.GetExtension).Distinct().OrderBy(kind => kind))}. {transparentShaders.Count} of the shaders left out are transparent.");
                return transparentShaders;
            }
            finally
            {
                if (Directory.Exists(temporary))
                {
                    Directory.Delete(temporary, true);
                }
            }
        }

        private static bool IsSafeAssetPath(string path)
        {
            return path.StartsWith("Assets/", StringComparison.Ordinal)
                && path.IndexOfAny(new[] { '\\', ':' }) < 0
                && path.Split('/').All(part => part.Length > 0 && part != "." && part != "..");
        }

        /// <summary>
        /// Reads a tar stream. It knows the ustar prefix, GNU long names, and pax paths, because tools that
        /// write packages use each of them.
        /// </summary>
        private static void ReadTar(Stream stream, Action<string, Stream, long> onFile)
        {
            var header = new byte[512];
            string longName = null;
            while (ReadBlock(stream, header))
            {
                if (header.All(value => value == 0))
                {
                    return;
                }

                string name = Text(header, 0, 100);
                long size = Octal(header, 124, 12);
                char type = (char)header[156];
                if (Text(header, 257, 5) == "ustar")
                {
                    string prefix = Text(header, 345, 155);
                    if (prefix.Length > 0)
                    {
                        name = $"{prefix}/{name}";
                    }
                }

                if (type == 'L' || type == 'x')
                {
                    var data = new MemoryStream();
                    Copy(stream, data, size);
                    SkipPadding(stream, size);
                    string text = Encoding.UTF8.GetString(data.ToArray());
                    longName = type == 'L' ? text.TrimEnd('\0') : PaxPath(text) ?? longName;
                    continue;
                }

                if (longName != null)
                {
                    name = longName;
                    longName = null;
                }

                if (type == '0' || type == '\0')
                {
                    onFile(name, stream, size);
                }
                else
                {
                    Skip(stream, size);
                }

                SkipPadding(stream, size);
            }
        }

        private static string PaxPath(string text)
        {
            foreach (string record in text.Split('\n'))
            {
                int space = record.IndexOf(' ');
                if (space > 0 && record.Substring(space + 1).StartsWith("path=", StringComparison.Ordinal))
                {
                    return record.Substring(space + 1 + "path=".Length);
                }
            }

            return null;
        }

        private static bool ReadBlock(Stream stream, byte[] block)
        {
            int read = 0;
            while (read < block.Length)
            {
                int count = stream.Read(block, read, block.Length - read);
                if (count == 0)
                {
                    return false;
                }

                read += count;
            }

            return true;
        }

        private static string Text(byte[] block, int offset, int length)
        {
            int end = Array.IndexOf(block, (byte)0, offset, length);
            return Encoding.UTF8.GetString(block, offset, (end < 0 ? offset + length : end) - offset);
        }

        private static long Octal(byte[] block, int offset, int length)
        {
            string text = Text(block, offset, length).Trim();
            return text.Length == 0 ? 0 : Convert.ToInt64(text, 8);
        }

        private static void Copy(Stream source, Stream destination, long size)
        {
            var buffer = new byte[81920];
            long left = size;
            while (left > 0)
            {
                int count = source.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                if (count == 0)
                {
                    throw new EndOfStreamException("The package ends inside a file.");
                }

                destination.Write(buffer, 0, count);
                left -= count;
            }
        }

        private static void Skip(Stream stream, long size)
        {
            Copy(stream, Stream.Null, size);
        }

        private static void SkipPadding(Stream stream, long size)
        {
            long padding = (512 - (size % 512)) % 512;
            Skip(stream, padding);
        }

        /// <summary>Removes scripts that the project does not have from each prefab, and turns off its cameras.</summary>
        private static void CleanPrefabs(string target)
        {
            foreach (string guid in AssetDatabase.FindAssets("t:Prefab", new[] { target }))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                GameObject contents = PrefabUtility.LoadPrefabContents(path);
                try
                {
                    int changed = contents.GetComponentsInChildren<Transform>(true).Sum(part => Clean(part.gameObject));
                    if (changed > 0)
                    {
                        PrefabUtility.SaveAsPrefabAsset(contents, path);
                        Debug.Log($"[Airi] Removed or turned off {changed} parts in {path}.");
                    }
                }
                finally
                {
                    PrefabUtility.UnloadPrefabContents(contents);
                }
            }
        }

        /// <summary>
        /// Opens the first scene that needs no other package. A world can have a second scene with the furniture
        /// of another product, and that scene shows errors without it.
        ///
        /// When each scene needs another package, the import takes the scene with the fewest missing prefabs, and
        /// removes them. In a world for VRChat, these are often parts of the VRChat SDK that draw nothing, for
        /// example VRCWorld. The log names each removed prefab.
        /// </summary>
        private static Scene OpenRoomScene(string target)
        {
            string[] paths = AssetDatabase.FindAssets("t:Scene", new[] { target })
                .Select(AssetDatabase.GUIDToAssetPath)
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToArray();

            string fewestPath = null;
            int fewest = int.MaxValue;
            foreach (string path in paths)
            {
                Scene scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
                string[] missing = MissingPrefabRoots(scene).Select(part => part.name).ToArray();
                if (missing.Length == 0)
                {
                    return scene;
                }

                Debug.Log($"[Airi] The scene {path} has {missing.Length} prefabs of another package: {string.Join(", ", missing)}.");
                if (missing.Length < fewest)
                {
                    fewest = missing.Length;
                    fewestPath = path;
                }
            }

            if (fewestPath == null)
            {
                throw new InvalidOperationException("The package has no scene.");
            }

            Scene chosen = EditorSceneManager.OpenScene(fewestPath, OpenSceneMode.Single);
            GameObject[] removed = MissingPrefabRoots(chosen).ToArray();
            foreach (GameObject part in removed)
            {
                UnityEngine.Object.DestroyImmediate(part);
            }

            Debug.Log($"[Airi] Took the scene {fewestPath}, and removed its {removed.Length} missing prefabs.");
            return chosen;
        }

        /// <summary>Finds the outer part of each prefab instance whose prefab is not in the project.</summary>
        private static IEnumerable<GameObject> MissingPrefabRoots(Scene scene)
        {
            return AllObjects(scene).Where(part => PrefabUtility.IsPrefabAssetMissing(part)
                && (part.transform.parent == null || !PrefabUtility.IsPrefabAssetMissing(part.transform.parent.gameObject)));
        }

        /// <summary>Cleans the parts of the scene itself. The parts of prefabs are clean already.</summary>
        private static void CleanScene(Scene scene)
        {
            int changed = AllObjects(scene)
                .Where(part => !PrefabUtility.IsPartOfPrefabInstance(part))
                .Sum(Clean);
            Debug.Log($"[Airi] Removed or turned off {changed} parts in the scene {scene.path}.");
        }

        /// <summary>
        /// Cleans one object of the world.
        ///
        /// - Removes each script that the project does not have, for example of the VRChat SDK.
        /// - Turns off each camera. The stage has its own, and a second camera draws over it. Other parts can
        ///   depend on a camera, so the import does not remove it.
        ///
        /// The project has no audio module and no particle module, so Unity drops the sounds and the particles of
        /// a world by itself. The character speaks through AIRI, so the player plays no sound.
        /// </summary>
        private static int Clean(GameObject part)
        {
            int changed = GameObjectUtility.RemoveMonoBehavioursWithMissingScript(part);
            foreach (Camera camera in part.GetComponents<Camera>())
            {
                if (camera.enabled)
                {
                    camera.enabled = false;
                    changed++;
                }
            }

            return changed;
        }

        /// <summary>
        /// Moves each material of the room to URP with the converters of URP. A material without its shader
        /// gets the Standard shader first, because the shaders of VRChat worlds, for example Filamented, keep
        /// the property names of the Standard shader.
        ///
        /// A material of a transparent shader gets the transparent mode of Standard, or the converter makes it
        /// opaque. The material or the text of its shader tells this, for example the glass of FakeGlass.
        /// </summary>
        private static void ConvertMaterials(Scene scene, string target, HashSet<string> transparentShaders)
        {
            List<MaterialUpgrader> converters = MaterialUpgrader.FetchAllUpgradersForPipeline(typeof(UniversalRenderPipelineAsset));
            var materials = new HashSet<Material>();
            foreach (GameObject part in AllObjects(scene))
            {
                foreach (Renderer renderer in part.GetComponents<Renderer>())
                {
                    materials.UnionWith(renderer.sharedMaterials.Where(material => material != null));
                }
            }

            foreach (Material material in materials.OrderBy(material => material.name, StringComparer.Ordinal))
            {
                if (!AssetDatabase.GetAssetPath(material).StartsWith(target + "/", StringComparison.Ordinal))
                {
                    continue;
                }

                string before = material.shader.name;
                bool madeTransparent = false;
                if (before == MissingShader)
                {
                    bool transparent = material.rawRenderQueue > (int)UnityEngine.Rendering.RenderQueue.GeometryLast
                        || transparentShaders.Contains(ShaderGuidOf(material) ?? string.Empty);
                    material.shader = Shader.Find("Standard");

                    // The modes of Standard: 0 opaque, 1 cutout, 2 fade, and 3 transparent. Fade stays as it is.
                    if (transparent && material.GetFloat("_Mode") < 2f)
                    {
                        material.SetFloat("_Mode", 3f);
                        madeTransparent = true;
                    }
                }

                string message = string.Empty;
                bool converted = MaterialUpgrader.Upgrade(material, converters, MaterialUpgrader.UpgradeFlags.None, ref message);
                EditorUtility.SetDirty(material);
                Debug.Log($"[Airi] Material {material.name}: {before} -> {material.shader.name}{(madeTransparent ? ", transparent" : string.Empty)}{(converted ? string.Empty : ", no converter")}");
            }
        }

        /// <summary>Reads the GUID of the shader from the text of a material. A material inside a model has no such text.</summary>
        private static string ShaderGuidOf(Material material)
        {
            string path = AssetDatabase.GetAssetPath(material);
            if (!path.EndsWith(".mat", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            Match match = ShaderReference.Match(File.ReadAllText(path));
            return match.Success ? match.Groups[1].Value : null;
        }

        /// <summary>
        /// Gives the room a plain sky when its own sky comes from another package, for example Skybox Series Free.
        /// The windows then show a sky, not the background of the camera. The light of the room does not change,
        /// because the lightmaps and the probes hold it.
        /// </summary>
        private static void FillMissingSky(Scene scene, string target)
        {
            Match reference = SkyReference.Match(File.ReadAllText(scene.path));
            if (RenderSettings.skybox != null || !reference.Success || reference.Groups[1].Value == "0")
            {
                return;
            }

            // The room has no sun light, so the sky has no sun disk. The disk would follow the light of the avatar.
            var sky = new Material(Shader.Find("Skybox/Procedural"));
            sky.SetFloat("_SunDisk", 0f);
            sky.EnableKeyword("_SUNDISK_NONE");
            sky.DisableKeyword("_SUNDISK_SIMPLE");
            sky.DisableKeyword("_SUNDISK_HIGH_QUALITY");
            string path = $"{target}/AiriSky.mat";
            AssetDatabase.CreateAsset(sky, path);
            RenderSettings.skybox = sky;
            EditorSceneManager.MarkSceneDirty(scene);
            Debug.Log($"[Airi] The sky of the scene {scene.path} is in another package. The room uses the plain sky {path}.");
        }

        /// <summary>
        /// Reports the lightmaps of the scene. A room without them looks flat and dark, so the import bakes them
        /// again in that case. A bake takes minutes.
        /// </summary>
        private static void CheckLightmaps(Scene scene)
        {
            if (LightmapSettings.lightmaps.Length > 0)
            {
                Debug.Log($"[Airi] The scene {scene.path} keeps its {LightmapSettings.lightmaps.Length} lightmaps.");
                return;
            }

            Debug.Log($"[Airi] The scene {scene.path} has no lightmaps after the import. Unity bakes them again.");
            if (!Lightmapping.Bake())
            {
                throw new InvalidOperationException("The bake of the lightmaps failed. Read the log of Unity.");
            }

            Debug.Log($"[Airi] The bake gave {LightmapSettings.lightmaps.Length} lightmaps.");
        }

        /// <summary>
        /// Finds the inside of the room, the stand point, and the facing. An earlier <c>room.json</c> keeps its
        /// stand point and its facing, so the owner can edit them once.
        ///
        /// The light probes of a world fill its inside, so they give the box of the camera. Reflection probes and
        /// renderers reach past the walls, so they are only the fallback.
        ///
        /// The floor comes from the colliders of the world only, because players walk on them. The furniture gets
        /// temporary colliders after that, for the space above and around each point. A model under a glass floor,
        /// for example, then does not become the floor.
        /// </summary>
        private static StageRoomManifest MeasureRoom(Scene scene, string name, string folder)
        {
            Bounds inside = MeasureInside(scene);
            StageRoomManifest earlier = ReadEarlierManifest(folder);
            if (earlier != null && IsInsideRoom(inside, earlier))
            {
                inside.Encapsulate(new Vector3((float)earlier.StandX, (float)earlier.StandY, (float)earlier.StandZ));
                return new StageRoomManifest(name, BundleName, earlier.StandX, earlier.StandY, earlier.StandZ, earlier.FacingDegrees, ToBox(inside));
            }

            Physics.SyncTransforms();
            List<Vector3> floor = FindFloor(inside);
            List<MeshCollider> obstacles = AddObstacleColliders(scene);
            bool backfaces = Physics.queriesHitBackfaces;
            Spot best;
            try
            {
                Physics.SyncTransforms();

                // A point inside a thick wall sees only the back faces of the wall. The rays of the rating meet back
                // faces too, so such a point is near a wall. The floor search does not, or a ray down meets the
                // underside of the floor.
                Physics.queriesHitBackfaces = true;
                best = RateSpots(floor, inside).OrderByDescending(spot => spot.Score).FirstOrDefault();
            }
            finally
            {
                Physics.queriesHitBackfaces = backfaces;
                foreach (MeshCollider obstacle in obstacles)
                {
                    UnityEngine.Object.DestroyImmediate(obstacle);
                }
            }

            Debug.Log($"[Airi] The search of a spot used {obstacles.Count} parts without a collider as obstacles.");
            if (best == null)
            {
                throw new InvalidOperationException("The room has no free spot on its floor. Write the stand point in room.json by hand.");
            }

            Debug.Log($"[Airi] The best spot has {best.Front:F2} m free in front, {best.Back:F2} m behind, and {best.Headroom:F2} m above.");

            // The lowest probes can float a little over a sunken floor, so the box takes the floor of the spot.
            inside.Encapsulate(best.Point);
            return new StageRoomManifest(name, BundleName, best.Point.x, best.Point.y, best.Point.z, best.Facing, ToBox(inside));
        }

        /// <summary>
        /// Tells whether the stand point of an earlier <c>room.json</c> is still in the room. The floor can lie under
        /// the lowest light probes, so the bottom of the box does not count.
        /// </summary>
        private static bool IsInsideRoom(Bounds inside, StageRoomManifest earlier)
        {
            return earlier.StandX >= inside.min.x && earlier.StandX <= inside.max.x
                && earlier.StandZ >= inside.min.z && earlier.StandZ <= inside.max.z
                && earlier.StandY <= inside.max.y;
        }

        private static StageRoomBox ToBox(Bounds bounds)
        {
            return new StageRoomBox(bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z);
        }

        private static Bounds MeasureInside(Scene scene)
        {
            Vector3[] points = AllObjects(scene)
                .SelectMany(part => part.GetComponents<LightProbeGroup>())
                .SelectMany(group => group.probePositions.Select(group.transform.TransformPoint))
                .ToArray();
            Bounds[] areas = points.Length > 0
                ? points.Select(point => new Bounds(point, Vector3.zero)).ToArray()
                : AllObjects(scene).SelectMany(part => part.GetComponents<ReflectionProbe>()).Select(probe => probe.bounds).ToArray();
            if (areas.Length == 0)
            {
                areas = AllObjects(scene).SelectMany(part => part.GetComponents<Renderer>()).Select(renderer => renderer.bounds).ToArray();
            }

            if (areas.Length == 0)
            {
                throw new InvalidOperationException("The scene has no light probe, no reflection probe, and no renderer, so the import cannot find the room.");
            }

            Bounds inside = areas[0];
            foreach (Bounds area in areas)
            {
                inside.Encapsulate(area);
            }

            return inside;
        }

        /// <summary>
        /// Gives each visible part without a collider a temporary collider, so the search of a spot also finds the
        /// furniture. Worlds often leave the colliders off their furniture. The caller removes these colliders after
        /// the search, and the scene is saved before it, so the bundle never has them.
        /// </summary>
        private static List<MeshCollider> AddObstacleColliders(Scene scene)
        {
            var added = new List<MeshCollider>();
            foreach (MeshRenderer renderer in AllObjects(scene).Where(part => part.activeInHierarchy).SelectMany(part => part.GetComponents<MeshRenderer>()))
            {
                MeshFilter filter = renderer.GetComponent<MeshFilter>();
                if (!renderer.enabled || filter == null || filter.sharedMesh == null || renderer.GetComponent<Collider>() != null)
                {
                    continue;
                }

                MeshCollider collider = renderer.gameObject.AddComponent<MeshCollider>();
                collider.sharedMesh = filter.sharedMesh;
                added.Add(collider);
            }

            return added;
        }

        /// <summary>
        /// Finds the points of the lowest floor on a grid. Each point is the lowest hit of a ray down through the room.
        /// </summary>
        private static List<Vector3> FindFloor(Bounds inside)
        {
            const float step = 0.25f;
            var points = new List<Vector3>();
            for (float x = inside.min.x + step; x < inside.max.x; x += step)
            {
                for (float z = inside.min.z + step; z < inside.max.z; z += step)
                {
                    RaycastHit[] hits = Physics.RaycastAll(new Vector3(x, inside.max.y, z), Vector3.down, inside.size.y + 1f);
                    if (hits.Length > 0)
                    {
                        points.Add(hits.OrderBy(hit => hit.point.y).First().point);
                    }
                }
            }

            if (points.Count == 0)
            {
                return points;
            }

            float lowest = points.Min(point => point.y);
            return points.Where(point => point.y < lowest + 0.15f).ToList();
        }

        /// <summary>
        /// Rates the points of the floor. A good spot has free space above it, keeps away from the walls and the
        /// furniture, has space for the camera in front, and shows the depth of the room behind.
        /// </summary>
        private static List<Spot> RateSpots(List<Vector3> floor, Bounds inside)
        {
            var spots = new List<Spot>();
            int withHeadroom = 0;
            int clear = 0;
            foreach (Vector3 point in floor)
            {
                float headroom = Physics.Raycast(point + (Vector3.up * 0.05f), Vector3.up, out RaycastHit above, 10f) ? above.distance : 10f;
                if (headroom < MinimumHeadroom)
                {
                    continue;
                }

                withHeadroom++;

                // Each direction takes the shortest free distance of the heights.
                float[] free = Enumerable.Range(0, 8)
                    .Select(index => ProbeHeights.Min(height => FreeDistance(point + (Vector3.up * height), Quaternion.Euler(0f, index * 45f, 0f) * Vector3.forward, inside)))
                    .ToArray();
                if (free.Min() < MinimumWallClearance)
                {
                    continue;
                }

                clear++;

                // A corridor is long in two directions only, and the middle of a room is open in each direction.
                float openness = free.Average(distance => Mathf.Min(distance, 3f));
                foreach (int index in new[] { 0, 2, 4, 6 })
                {
                    float front = free[index];
                    float back = free[(index + 4) % 8];

                    // The camera needs about 2.5 m for the whole avatar. The room behind her is the picture: a wall at
                    // 1.5 m to 3.5 m fills it, and a farther wall is often the end of a corridor.
                    float score = (2f * openness) + Mathf.Min(front, 2.5f) + (0.5f * Mathf.Min(back, 3f)) - (0.5f * Mathf.Max(back - 3.5f, 0f));
                    spots.Add(new Spot { Point = point, Headroom = headroom, Facing = index * 45f, Front = front, Back = back, Score = score });
                }
            }

            Debug.Log($"[Airi] The lowest floor has {floor.Count} points. {withHeadroom} have free space above, and {clear} of them keep away from the walls and the furniture.");
            return spots;
        }

        /// <summary>Gives the distance to the first wall, or to the side of the room when no collider stands in the way.</summary>
        private static float FreeDistance(Vector3 from, Vector3 direction, Bounds inside)
        {
            float distance = float.PositiveInfinity;
            for (int axis = 0; axis < 3; axis++)
            {
                if (direction[axis] > 0.0001f)
                {
                    distance = Mathf.Min(distance, (inside.max[axis] - from[axis]) / direction[axis]);
                }
                else if (direction[axis] < -0.0001f)
                {
                    distance = Mathf.Min(distance, (inside.min[axis] - from[axis]) / direction[axis]);
                }
            }

            distance = Mathf.Max(distance, 0f);
            if (Physics.Raycast(from, direction, out RaycastHit wall, distance))
            {
                distance = wall.distance;
            }

            return distance;
        }

        private static StageRoomManifest ReadEarlierManifest(string folder)
        {
            string path = Path.Combine(folder, StageRoomManifest.FileName);
            if (!File.Exists(path))
            {
                return null;
            }

            try
            {
                return StageRoomManifest.Parse(File.ReadAllText(path));
            }
            catch (StageRoomException error)
            {
                Debug.LogWarning($"[Airi] The import writes {path} again, because it is broken: {error.Message}");
                return null;
            }
        }

        /// <summary>
        /// Bakes the walkable area of the room from the render meshes inside the box of the room, with a margin of
        /// 0.5 m on each side. So the furniture is part of the bake, also without colliders. The ceilings stay in the
        /// volume, because a mesh outside the volume does not block the space above a surface. Their tops become
        /// areas that the floor does not reach. The agent type Humanoid gives the size of the character, see
        /// <see cref="StageProjectSetup"/>.
        ///
        /// The parts of seats are not walkable. Without this, the frame of a low bed is a step onto the bed, and a path
        /// can cross it. The modifiers that mark them leave the scene after the bake, so the bundle never has them.
        ///
        /// The data is an asset next to the scene, so the scene bundle carries it. The surface adds the data to the
        /// NavMesh when the player loads the room.
        /// </summary>
        private static void BakeNavMesh(Scene scene, string target, StageRoomBox box)
        {
            int notWalkable = NavMesh.GetAreaFromName("Not Walkable");
            List<NavMeshModifier> seats = AllObjects(scene)
                .Where(part => part.activeInHierarchy && part.GetComponent<Renderer>() != null && StageRoomPlaceNames.IsSeatName(part.name))
                .Select(part =>
                {
                    NavMeshModifier modifier = part.AddComponent<NavMeshModifier>();
                    modifier.overrideArea = true;
                    modifier.area = notWalkable;
                    return modifier;
                })
                .ToList();
            NavMeshSurface surface = AddSurface(scene, box, "Airi NavMesh");
            try
            {
                surface.BuildNavMesh();
            }
            finally
            {
                foreach (NavMeshModifier modifier in seats)
                {
                    UnityEngine.Object.DestroyImmediate(modifier);
                }
            }

            if (surface.navMeshData == null)
            {
                throw new InvalidOperationException("The bake of the NavMesh gave no data.");
            }

            string path = $"{target}/AiriNavMesh.asset";
            AssetDatabase.CreateAsset(surface.navMeshData, path);
            EditorSceneManager.MarkSceneDirty(scene);
            NavMeshTriangulation triangulation = NavMesh.CalculateTriangulation();
            Debug.Log($"[Airi] The NavMesh of the room has {triangulation.indices.Length / 3} triangles, in {path}. {seats.Count} parts of seats are not walkable.");
        }

        /// <summary>
        /// Finds the places of the room: screens by <see cref="StageRoomPlaceNames.IsScreenName"/>, and seats by
        /// <see cref="StageRoomPlaceNames.IsSeatName"/>. An earlier <c>room.json</c> with a list keeps that list, so the
        /// owner can edit it once.
        ///
        /// - A seat is a group of parts that touch, for example the cushions and the backs of a sofa. Rays down onto the
        ///   group give its heights, and <see cref="StageSeatSearch"/> finds the seat.
        /// - A seat in front of a screen joins the screen, and she faces the screen there. A screen without a seat is a
        ///   place to stand in front of it.
        /// - Each stand point is a point of the NavMesh on the floor of the stand point of the room, and a path from the
        ///   stand point of the room reaches it.
        ///
        /// Returns:
        /// - The places: screens with a seat, a monitor before a TV, then screens without a seat, then seats. The log
        ///   names each candidate that the import leaves out, and the cause.
        /// </summary>
        private static IReadOnlyList<StageRoomPlace> FindPlaces(Scene scene, string folder, StageRoomManifest room)
        {
            StageRoomManifest earlier = ReadEarlierManifest(folder);
            if (earlier?.Places != null)
            {
                var objects = new HashSet<string>(AllObjects(scene).Select(part => part.name), StringComparer.Ordinal);
                string[] missing = earlier.Places.Where(place => place.Screen != null && !objects.Contains(place.Screen.ObjectName)).Select(place => place.Screen.ObjectName).ToArray();
                Debug.Log($"[Airi] Kept the {earlier.Places.Count} places of room.json.{(missing.Length > 0 ? $" No object has these screen names: {string.Join(", ", missing)}." : string.Empty)}");
                return earlier.Places;
            }

            var places = new List<StageRoomPlace>();
            var standPoint = new Vector3((float)room.StandX, (float)room.StandY, (float)room.StandZ);
            if (!NavMesh.SamplePosition(standPoint, out NavMeshHit start, 1f, NavMesh.AllAreas))
            {
                Debug.LogWarning("[Airi] The stand point of the room is not on the NavMesh, so the room gets no places.");
                return places;
            }

            MeshRenderer[] renderers = AllObjects(scene)
                .Where(part => part.activeInHierarchy)
                .SelectMany(part => part.GetComponents<MeshRenderer>())
                .Where(renderer => renderer.enabled && renderer.GetComponent<MeshFilter>()?.sharedMesh != null)
                .ToArray();
            var finder = new PlaceFinder(start.position, room);
            List<StageRoomScreen> screens = renderers
                .Where(renderer => StageRoomPlaceNames.IsScreenName(renderer.name))
                .Select(MeasureScreen)
                .Where(screen => screen != null)
                .OrderBy(screen => StageRoomPlaceNames.IsTvName(screen.ObjectName) ? 1 : 0)
                .ThenBy(screen => screen.ObjectName, StringComparer.Ordinal)
                .ToList();
            List<SeatCandidate> seats = GroupTouching(renderers.Where(renderer => StageRoomPlaceNames.IsSeatName(renderer.name)).Select(renderer => renderer.gameObject).ToArray())
                .Select(group => MeasureSeat(group, (float)room.StandY))
                .Where(seat => seat != null)
                .OrderBy(seat => seat.Name, StringComparer.Ordinal)
                .ToList();

            var standing = new List<StageRoomPlace>();
            foreach (StageRoomScreen screen in screens)
            {
                SeatCandidate seat = seats
                    .Where(candidate => StageSeatSearch.InFrontOf(screen, candidate.Surface.CenterX, candidate.Surface.CenterZ))
                    .OrderBy(candidate => Square(candidate.Surface.CenterX - screen.Center.X) + Square(candidate.Surface.CenterZ - screen.Center.Z))
                    .FirstOrDefault();
                StageRoomPlace place = seat != null
                    ? finder.Sit(seat, StageSeatSearch.FacingOf(screen.Center.X - seat.Surface.CenterX, screen.Center.Z - seat.Surface.CenterZ), screen)
                    : finder.Watch(screen);
                if (place == null)
                {
                    continue;
                }

                if (seat != null)
                {
                    seats.Remove(seat);
                    places.Add(place);
                }
                else
                {
                    standing.Add(place);
                }
            }

            places.AddRange(standing);
            foreach (SeatCandidate seat in seats)
            {
                double? facing = seat.Surface.BackDegrees is double back ? (back + 180.0) % 360.0 : finder.FacingToFloor(seat);
                StageRoomPlace place = facing is double value ? finder.Sit(seat, value, null) : null;
                if (place != null)
                {
                    places.Add(place);
                }
            }

            Debug.Log($"[Airi] The room has {places.Count} places{(places.Count > 0 ? $": {string.Join(", ", places)}" : string.Empty)}.");
            return places;
        }

        /// <summary>
        /// Measures the screen of a part with the name of a screen: its largest flat and upright surface. A static batch
        /// in the player hides the mesh, so the import measures it here.
        ///
        /// Returns:
        /// - The screen, or null when the part has no such surface, for example the stand of a monitor.
        /// </summary>
        private static StageRoomScreen MeasureScreen(MeshRenderer renderer)
        {
            Mesh mesh = renderer.GetComponent<MeshFilter>().sharedMesh;
            StagePoint[] points = mesh.vertices
                .Select(vertex => renderer.transform.TransformPoint(vertex))
                .Select(point => new StagePoint(point.x, point.y, point.z))
                .ToArray();
            Material[] materials = renderer.sharedMaterials;
            StageRoomScreen best = Enumerable.Range(0, mesh.subMeshCount)
                .Where(index => index < materials.Length && materials[index] != null)
                .Select(index => StageScreenSurface.Measure(renderer.name, materials[index].name, points, mesh.GetTriangles(index)))
                .Where(screen => screen != null)
                .OrderByDescending(screen => screen.Width * screen.Height)
                .FirstOrDefault();
            if (best == null)
            {
                Debug.Log($"[Airi] {renderer.name} has the name of a screen, but no flat and upright surface of {StageScreenSurface.SmallestArea} m² or more.");
            }

            return best;
        }

        /// <summary>
        /// Measures the seat of a group of parts. Temporary colliders on the parts take the rays down, and only these
        /// colliders count, so a table over a chair does not hide its seat. The colliders leave before the scene is saved.
        ///
        /// Returns:
        /// - The seat, or null when the group has no seat surface. The log gives the cause.
        /// </summary>
        private static SeatCandidate MeasureSeat(List<GameObject> group, float floorY)
        {
            string name = group.Select(part => part.name).OrderBy(part => part, StringComparer.Ordinal).First();
            var colliders = new List<MeshCollider>();
            try
            {
                Bounds bounds = group[0].GetComponent<Renderer>().bounds;
                foreach (GameObject part in group)
                {
                    bounds.Encapsulate(part.GetComponent<Renderer>().bounds);
                    var probe = new GameObject("Airi Seat Probe");
                    probe.transform.SetParent(part.transform, false);
                    MeshCollider collider = probe.AddComponent<MeshCollider>();
                    collider.sharedMesh = part.GetComponent<MeshFilter>().sharedMesh;
                    colliders.Add(collider);
                }

                Physics.SyncTransforms();
                float cell = (float)StageSeatSearch.CellSize;
                int countX = Mathf.CeilToInt(bounds.size.x / cell);
                int countZ = Mathf.CeilToInt(bounds.size.z / cell);
                var heights = new double[countX * countZ];
                var upward = new bool[countX * countZ];
                for (int z = 0; z < countZ; z++)
                {
                    for (int x = 0; x < countX; x++)
                    {
                        var ray = new Ray(new Vector3(bounds.min.x + ((x + 0.5f) * cell), bounds.max.y + 0.1f, bounds.min.z + ((z + 0.5f) * cell)), Vector3.down);
                        RaycastHit? first = null;
                        foreach (MeshCollider collider in colliders)
                        {
                            if (collider.Raycast(ray, out RaycastHit hit, bounds.size.y + 0.2f) && (first == null || hit.distance < first.Value.distance))
                            {
                                first = hit;
                            }
                        }

                        heights[x + (z * countX)] = first?.point.y ?? double.NaN;
                        upward[x + (z * countX)] = first != null && first.Value.normal.y >= 0.7f;
                    }
                }

                var grid = new StageHeightGrid(bounds.min.x, bounds.min.z, cell, countX, countZ, heights, upward);
                StageSeatSurface surface = StageSeatSearch.FindSurface(grid, floorY);
                if (surface == null)
                {
                    Debug.Log($"[Airi] No place for {name}: it has no flat seat of {StageSeatSearch.SeatWidth} m between {StageSeatSearch.LowestSeat} m and {StageSeatSearch.HighestSeat} m above the floor.");
                    return null;
                }

                return new SeatCandidate { Name = name, Grid = grid, Surface = surface };
            }
            finally
            {
                foreach (MeshCollider collider in colliders)
                {
                    UnityEngine.Object.DestroyImmediate(collider.gameObject);
                }
            }
        }

        private static double Square(double value) => value * value;

        /// <summary>A seat that the import found, before it has a stand point.</summary>
        private sealed class SeatCandidate
        {
            public string Name;
            public StageHeightGrid Grid;
            public StageSeatSurface Surface;
        }

        /// <summary>Finds the stand points of places on the NavMesh of the room.</summary>
        private sealed class PlaceFinder
        {
            /// <summary>A stand point lies at most this far from its seat, or from its spot in front of a screen.</summary>
            private const float Reach = 1.2f;

            /// <summary>She stands at least this far in front of a screen, and as far as the screen is wide.</summary>
            private const float NearestView = 0.8f;

            /// <summary>A seat without a back faces the open floor, the nearest floor within this distance.</summary>
            private const float FloorSearch = 3f;

            private readonly Vector3 _start;
            private readonly StageRoomManifest _room;
            private readonly NavMeshPath _path = new NavMeshPath();

            public PlaceFinder(Vector3 start, StageRoomManifest room)
            {
                _start = start;
                _room = room;
            }

            /// <summary>Makes a place to sit on a seat in a facing, with a screen or without one. Null when she cannot reach it.</summary>
            public StageRoomPlace Sit(SeatCandidate seat, double facing, StageRoomScreen screen)
            {
                StagePoint front = StageSeatSearch.FrontEdge(seat.Grid, seat.Surface, facing);
                Vector3? stand = Nearest(new Vector3((float)front.X, (float)_room.StandY, (float)front.Z), Reach, 0.1f);
                string label = screen != null ? $"{screen.ObjectName} with the seat {seat.Name}" : seat.Name;
                if (stand == null || !_room.Box.Contains(front.X, front.Y, front.Z))
                {
                    Debug.Log($"[Airi] No place for {label}: no point of the floor within {Reach} m of its seat is reachable.");
                    return null;
                }

                Debug.Log($"[Airi] Place {label}: seat {front.Y - _room.StandY:F2} m above the floor, facing {facing:F0} degrees, stand at {stand.Value.ToString("F2")}.");
                return new StageRoomPlace(screen?.ObjectName ?? seat.Name, screen != null ? StageRoomPlaceRole.Screen : StageRoomPlaceRole.Seat, ToPoint(stand.Value), facing, front, screen);
            }

            /// <summary>Makes a place to stand in front of a screen. Null when she cannot reach it.</summary>
            public StageRoomPlace Watch(StageRoomScreen screen)
            {
                double radians = screen.FacingDegrees * Math.PI / 180.0;
                float distance = Mathf.Max(NearestView, (float)screen.Width);
                var spot = new Vector3((float)(screen.Center.X + (Math.Sin(radians) * distance)), (float)_room.StandY, (float)(screen.Center.Z + (Math.Cos(radians) * distance)));
                Vector3? stand = Nearest(spot, Reach, 0.1f);
                if (stand == null)
                {
                    Debug.Log($"[Airi] No place for {screen.ObjectName}: no point of the floor within {Reach} m of its front is reachable.");
                    return null;
                }

                double facing = StageSeatSearch.FacingOf(screen.Center.X - stand.Value.x, screen.Center.Z - stand.Value.z);
                Debug.Log($"[Airi] Place {screen.ObjectName}: a screen to watch standing, facing {facing:F0} degrees, stand at {stand.Value.ToString("F2")}.");
                return new StageRoomPlace(screen.ObjectName, StageRoomPlaceRole.Screen, ToPoint(stand.Value), facing, null, screen);
            }

            /// <summary>The facing from the middle of a seat to the nearest floor that she reaches. Null when no such floor is near.</summary>
            public double? FacingToFloor(SeatCandidate seat)
            {
                Vector3? floor = Nearest(new Vector3((float)seat.Surface.CenterX, (float)_room.StandY, (float)seat.Surface.CenterZ), FloorSearch, 0.2f);
                if (floor == null)
                {
                    Debug.Log($"[Airi] No place for {seat.Name}: no floor within {FloorSearch} m is reachable.");
                    return null;
                }

                return StageSeatSearch.FacingOf(floor.Value.x - seat.Surface.CenterX, floor.Value.z - seat.Surface.CenterZ);
            }

            /// <summary>
            /// Finds the point of the NavMesh nearest to a spot on the floor, on the floor of the stand point of the room,
            /// that a path from that stand point reaches. The nearest point of the NavMesh can lie on an island, so the
            /// search tests points on a grid around the spot, nearest first.
            /// </summary>
            private Vector3? Nearest(Vector3 spot, float reach, float step)
            {
                var hits = new List<Vector3>();
                for (float x = -reach; x <= reach + 0.001f; x += step)
                {
                    for (float z = -reach; z <= reach + 0.001f; z += step)
                    {
                        if ((x * x) + (z * z) <= reach * reach
                            && NavMesh.SamplePosition(spot + new Vector3(x, 0f, z), out NavMeshHit hit, 0.25f, NavMesh.AllAreas)
                            && Mathf.Abs(hit.position.y - _start.y) <= StageRoomManifest.SameFloor)
                        {
                            hits.Add(hit.position);
                        }
                    }
                }

                foreach (Vector3 hit in hits.OrderBy(point => Square(point.x - spot.x) + Square(point.z - spot.z)))
                {
                    if (Square(hit.x - spot.x) + Square(hit.z - spot.z) > reach * reach)
                    {
                        break;
                    }

                    if (_room.Box.Contains(hit.x, hit.y, hit.z)
                        && NavMesh.CalculatePath(_start, hit, NavMesh.AllAreas, _path)
                        && _path.status == NavMeshPathStatus.PathComplete)
                    {
                        return hit;
                    }
                }

                return null;
            }

            private static StagePoint ToPoint(Vector3 point) => new StagePoint(point.x, point.y, point.z);
        }

        /// <summary>Adds a surface that collects the render meshes inside the box of the room, with a margin of 0.5 m.</summary>
        private static NavMeshSurface AddSurface(Scene scene, StageRoomBox box, string name)
        {
            const float margin = 0.5f;
            var holder = new GameObject(name);
            SceneManager.MoveGameObjectToScene(holder, scene);
            var surface = holder.AddComponent<NavMeshSurface>();
            surface.collectObjects = CollectObjects.Volume;
            surface.useGeometry = NavMeshCollectGeometry.RenderMeshes;
            surface.center = new Vector3((float)(box.MinX + box.MaxX) / 2f, (float)(box.MinY + box.MaxY) / 2f, (float)(box.MinZ + box.MaxZ) / 2f);
            surface.size = new Vector3((float)(box.MaxX - box.MinX) + (2f * margin), (float)(box.MaxY - box.MinY) + (2f * margin), (float)(box.MaxZ - box.MinZ) + (2f * margin));
            return surface;
        }

        /// <summary>
        /// Opens the doors that cut off floor of the room, so the character can walk into each room, also onto a
        /// balcony. The import hides each such door, so its doorway is open in the bundle and in the NavMesh. A hidden
        /// door does not swing or slide, and the baked light still holds its shade.
        ///
        /// An earlier <c>room.json</c> with a list keeps that list, so the owner can edit it once. Without a list, the
        /// import finds the doors with <see cref="FindDoorsToOpen"/>.
        ///
        /// Returns:
        /// - The names of the open doors, for <c>room.json</c>.
        /// </summary>
        private static IReadOnlyList<string> OpenDoors(Scene scene, string folder, StageRoomManifest room)
        {
            GameObject[] doors = AllObjects(scene).Where(IsDoor).ToArray();
            StageRoomManifest earlier = ReadEarlierManifest(folder);
            if (earlier?.OpenDoors == null)
            {
                return FindDoorsToOpen(scene, doors, room);
            }

            var listed = new HashSet<string>(earlier.OpenDoors, StringComparer.Ordinal);
            foreach (GameObject door in doors.Where(door => listed.Contains(door.name)))
            {
                door.SetActive(false);
            }

            string[] missing = earlier.OpenDoors.Where(name => doors.All(door => door.name != name)).ToArray();
            Debug.Log($"[Airi] Opened the {earlier.OpenDoors.Count} doors of room.json.{(missing.Length > 0 ? $" No door has these names: {string.Join(", ", missing)}." : string.Empty)}");
            return earlier.OpenDoors;
        }

        /// <summary>A door is a part with a renderer and a name like a door, but not a door frame.</summary>
        private static bool IsDoor(GameObject part)
        {
            return part.GetComponent<Renderer>() != null && StageRoomDoors.IsDoorName(part.name);
        }

        /// <summary>
        /// Finds the doors that cut off floor. The import hides each group of doors, bakes, and measures the floor
        /// that the stand point reaches. A group stays hidden only when it adds at least
        /// <see cref="MinimumNewFloor"/>. So a closet, an open door, and the front door stay as they are.
        ///
        /// Doors that touch each other are one group, for example the panels of a sliding door, because one panel
        /// alone leaves no passage. A new room can have a door further in, so the search runs a few rounds.
        /// </summary>
        private static List<string> FindDoorsToOpen(Scene scene, GameObject[] doors, StageRoomManifest room)
        {
            var open = new List<string>();
            List<List<GameObject>> groups = GroupTouching(doors);
            var stand = new Vector3((float)room.StandX, (float)room.StandY, (float)room.StandZ);
            NavMeshSurface surface = AddSurface(scene, room.Box, "Airi Door Test");
            try
            {
                surface.BuildNavMesh();
                float first = ReachableFloor(stand, room.Box);
                float floor = first;
                for (int round = 0; round < DoorRounds; round++)
                {
                    bool opened = false;
                    foreach (List<GameObject> group in groups.Where(group => group[0].activeSelf))
                    {
                        group.ForEach(door => door.SetActive(false));
                        surface.BuildNavMesh();
                        float reached = ReachableFloor(stand, room.Box);
                        if (reached - floor < MinimumNewFloor)
                        {
                            group.ForEach(door => door.SetActive(true));
                            continue;
                        }

                        Debug.Log($"[Airi] Opened {string.Join(", ", group.Select(door => door.name))}: {reached - floor:F1} m² more floor.");
                        open.AddRange(group.Select(door => door.name));
                        floor = reached;
                        opened = true;
                    }

                    if (!opened)
                    {
                        break;
                    }
                }

                Debug.Log($"[Airi] {doors.Length} doors in {groups.Count} groups. The stand point reaches {floor:F1} m² of floor, {floor - first:F1} m² more with {open.Count} open doors.");
            }
            finally
            {
                surface.RemoveData();
                UnityEngine.Object.DestroyImmediate(surface.gameObject);
            }

            return open;
        }

        /// <summary>
        /// Puts parts whose bounds touch, with a gap of up to 0.05 m, into one group, for example the panels of a sliding
        /// door or the cushions of a sofa.
        /// </summary>
        private static List<List<GameObject>> GroupTouching(GameObject[] parts)
        {
            var groups = new List<List<GameObject>>();
            foreach (GameObject part in parts)
            {
                // Expand adds the amount to the size, so each side moves by half of it.
                Bounds bounds = part.GetComponent<Renderer>().bounds;
                bounds.Expand(0.1f);
                List<List<GameObject>> touching = groups.Where(group => group.Any(other => bounds.Intersects(other.GetComponent<Renderer>().bounds))).ToList();
                var merged = new List<GameObject> { part };
                foreach (List<GameObject> group in touching)
                {
                    merged.AddRange(group);
                    groups.Remove(group);
                }

                groups.Add(merged);
            }

            return groups;
        }

        /// <summary>The area of the floor of the stand point, inside the box, that a path from the stand point reaches.</summary>
        private static float ReachableFloor(Vector3 stand, StageRoomBox box)
        {
            if (!NavMesh.SamplePosition(stand, out NavMeshHit start, 1f, NavMesh.AllAreas))
            {
                return 0f;
            }

            NavMeshTriangulation mesh = NavMesh.CalculateTriangulation();
            var path = new NavMeshPath();
            float area = 0f;
            for (int index = 0; index + 2 < mesh.indices.Length; index += 3)
            {
                Vector3 a = mesh.vertices[mesh.indices[index]];
                Vector3 b = mesh.vertices[mesh.indices[index + 1]];
                Vector3 c = mesh.vertices[mesh.indices[index + 2]];
                Vector3 center = (a + b + c) / 3f;
                if (Mathf.Abs(center.y - start.position.y) > StageRoomManifest.SameFloor || !box.Contains(center.x, box.MinY, center.z))
                {
                    continue;
                }

                if (NavMesh.CalculatePath(start.position, center, NavMesh.AllAreas, path) && path.status == NavMeshPathStatus.PathComplete)
                {
                    area += Vector3.Cross(b - a, c - a).magnitude / 2f;
                }
            }

            return area;
        }

        /// <summary>Builds the bundle in a temporary folder, and copies only the bundle to the room folder.</summary>
        private static void BuildBundle(string scenePath, string folder)
        {
            string output = Path.Combine(Path.GetTempPath(), $"airi-room-bundle-{Guid.NewGuid():N}");
            Directory.CreateDirectory(output);
            try
            {
                AssetBundleManifest built = BuildPipeline.BuildAssetBundles(
                    output,
                    new[] { new AssetBundleBuild { assetBundleName = BundleName, assetNames = new[] { scenePath } } },
                    BuildAssetBundleOptions.ChunkBasedCompression,
                    BuildTarget.StandaloneWindows64);
                if (built == null)
                {
                    throw new InvalidOperationException("The build of the bundle failed. Read the log of Unity.");
                }

                File.Copy(Path.Combine(output, BundleName), Path.Combine(folder, BundleName), true);
            }
            finally
            {
                Directory.Delete(output, true);
            }
        }

        private sealed class Spot
        {
            public Vector3 Point;
            public float Headroom;
            public float Facing;
            public float Front;
            public float Back;
            public float Score;
        }

        private static IEnumerable<GameObject> AllObjects(Scene scene)
        {
            return scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<Transform>(true)).Select(part => part.gameObject);
        }
    }
}
