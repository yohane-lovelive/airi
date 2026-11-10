using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Airi.Stage.Core;
using UnityEditor;
using UnityEditor.Rendering;
using UnityEditor.SceneManagement;
using UnityEngine;
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

            StageRoomManifest manifest = MeasureRoom(scene, name, folder);
            BuildBundle(scene.path, folder);

            // The player reads the file with the same rules, so a file that it refuses must fail the import here.
            string text = manifest.ToJson();
            StageRoomManifest.Parse(text);
            File.WriteAllText(Path.Combine(folder, StageRoomManifest.FileName), text);
            Debug.Log($"[Airi] Room {name} is ready in {folder}: scene {scene.path}, stand at ({manifest.StandX}, {manifest.StandY}, {manifest.StandZ}), facing {manifest.FacingDegrees} degrees.");
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
