using System.Collections.Generic;
using System.IO;
using Airi.Stage.Core;
using lilToon;
using Mmd.Rendering.Universal;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;
using VRM10.MToon10;
using LilRenderingMode = lilToon.RenderingMode;

namespace Airi.Stage.Editor
{
    /// <summary>
    /// Writes the settings and the scene of the project through the API of Unity, so a review can
    /// read each choice here and a run of this method gives the same project again.
    ///
    /// Call stack:
    ///
    /// tools/run-unity.ps1 (-executeMethod)
    ///   -> <see cref="Apply"/>
    ///     -> <see cref="ApplyPlayerSettings"/>
    ///     -> <see cref="ApplyNavMeshAgent"/>
    ///     -> <see cref="CreateRenderPipeline"/>
    ///     -> <see cref="IncludeRuntimeShaders"/>
    ///     -> <see cref="CreateScene"/>
    /// </summary>
    public static class StageProjectSetup
    {
        private const string SettingsFolder = "Assets/Airi/Settings";
        private const string ScenePath = "Assets/Airi/Scenes/Stage.unity";
        private const string LookTemplateFolder = "Assets/Airi/Looks/Resources/AiriLooks";

        /// <summary>
        /// UniVRM and unity-mmd-loader find these shaders by name at runtime, while no asset of the
        /// project uses them. Without this list, a build removes them, and the model shows no material.
        /// </summary>
        private static readonly string[] RuntimeShaders =
        {
            "VRM10/Universal Render Pipeline/MToon10",
            "UniGLTF/UniUnlit",
            "MMD URP Toon",
            "MMD Basic URP Toon",
        };

        public static void Apply()
        {
            ApplyPlayerSettings();
            ApplyNavMeshAgent();
            ApplyRenderingLayers();
            UniversalRenderPipelineAsset pipeline = CreateRenderPipeline();
            GraphicsSettings.defaultRenderPipeline = pipeline;
            QualitySettings.renderPipeline = pipeline;
            IncludeRuntimeShaders();
            CreateLookTemplates();
            CreateScene();
            AssetDatabase.SaveAssets();
            Debug.Log("[Airi] The project settings and the scene are ready.");
        }

        private static void ApplyPlayerSettings()
        {
            // Sony requires Mono and Intel 64-bit for its plugin on ELF-SR1 and ELF-SR2.
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.SetArchitecture(NamedBuildTarget.Standalone, 1);
            PlayerSettings.companyName = "Moeru AI";
            PlayerSettings.productName = "AIRI Unity Stage";

            // The owner works in the Electron window while the character moves.
            PlayerSettings.runInBackground = true;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.defaultScreenWidth = 720;
            PlayerSettings.defaultScreenHeight = 1080;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.SplashScreen.show = false;

            // Before each build, lilToon removes the features that no material of the project uses. The stage
            // makes its materials at runtime, so this step must not see an empty project and remove them.
            const string keepLilToonFeatures = "LILTOON_DISABLE_OPTIMIZATION";
            PlayerSettings.GetScriptingDefineSymbols(NamedBuildTarget.Standalone, out string[] defines);
            if (System.Array.IndexOf(defines, keepLilToonFeatures) < 0)
            {
                var updated = new List<string>(defines) { keepLilToonFeatures };
                PlayerSettings.SetScriptingDefineSymbols(NamedBuildTarget.Standalone, updated.ToArray());
            }
        }

        /// <summary>
        /// Sets the size of the agent type Humanoid. The import bakes the NavMesh of a room with it, and the character
        /// walks with it. The default radius of 0.5 m does not pass a door of 0.8 m.
        /// </summary>
        private static void ApplyNavMeshAgent()
        {
            var settings = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/NavMeshAreas.asset")[0]);
            SerializedProperty humanoid = settings.FindProperty("m_Settings").GetArrayElementAtIndex(0);
            if (humanoid.FindPropertyRelative("agentTypeID").intValue != 0)
            {
                throw new InvalidDataException("The first agent type of the NavMesh settings is not Humanoid.");
            }

            humanoid.FindPropertyRelative("agentRadius").floatValue = 0.25f;

            // The character is about 1.6 m tall. So she does not walk under a table or a low shelf.
            humanoid.FindPropertyRelative("agentHeight").floatValue = 1.7f;

            // A step of a door frame is lower than this. A step of a stair is often higher.
            humanoid.FindPropertyRelative("agentClimb").floatValue = 0.2f;
            humanoid.FindPropertyRelative("agentSlope").floatValue = 30f;
            settings.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>
        /// Names the rendering layer of the character light. URP passes only layers with a name to the shaders, so
        /// without a name the light reaches no renderer that checks layers.
        /// </summary>
        private static void ApplyRenderingLayers()
        {
            var tags = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset")[0]);
            SerializedProperty layers = tags.FindProperty("m_RenderingLayers");
            if (layers.arraySize <= CharacterLight.RenderingLayer)
            {
                layers.arraySize = CharacterLight.RenderingLayer + 1;
            }

            layers.GetArrayElementAtIndex(CharacterLight.RenderingLayer).stringValue = CharacterLight.RenderingLayerName;
            tags.ApplyModifiedPropertiesWithoutUndo();
        }

        private static UniversalRenderPipelineAsset CreateRenderPipeline()
        {
            Directory.CreateDirectory(SettingsFolder);

            string rendererPath = $"{SettingsFolder}/StageRenderer.asset";
            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(rendererPath);
            if (renderer == null)
            {
                renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
                AssetDatabase.CreateAsset(renderer, rendererPath);
            }

            string pipelinePath = $"{SettingsFolder}/StagePipeline.asset";
            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(pipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                AssetDatabase.CreateAsset(pipeline, pipelinePath);
            }

            ApplyPipelineQuality(pipeline);
            EditorUtility.SetDirty(pipeline);

            // MMD models draw their outlines and their shadows on themselves through these features.
            AddRendererFeature<MmdOutlineRendererFeature>(renderer);
            AddRendererFeature<MmdSelfShadowRendererFeature>(renderer);

            // URP draws the outline pass of MToon only through this feature.
            AddRendererFeature<MToonOutlineRenderFeature>(renderer);
            AddRendererFeature<ScreenSpaceAmbientOcclusion>(renderer);
            ApplyAmbientOcclusion(renderer);
            return pipeline;
        }

        /// <summary>
        /// One character fills the window, so the budget goes to its edges and to its shadow. The shadow
        /// distance covers only the character, so that the shadow map keeps its resolution.
        /// </summary>
        private static void ApplyPipelineQuality(UniversalRenderPipelineAsset pipeline)
        {
            pipeline.msaaSampleCount = 8;
            pipeline.renderScale = 1.5f;
            pipeline.supportsHDR = true;
            pipeline.supportsCameraDepthTexture = true;
            pipeline.shadowDistance = 8f;
            pipeline.shadowCascadeCount = 1;

            // These settings have no public setter.
            var serialized = new SerializedObject(pipeline);
            serialized.FindProperty("m_HDRColorBufferPrecision").intValue = (int)HDRColorBufferPrecision._64Bits;
            serialized.FindProperty("m_SoftShadowsSupported").boolValue = true;
            serialized.FindProperty("m_SoftShadowQuality").intValue = (int)SoftShadowQuality.High;
            serialized.FindProperty("m_MainLightShadowmapResolution").intValue = 4096;
            serialized.FindProperty("m_ColorGradingMode").intValue = (int)ColorGradingMode.HighDynamicRange;
            serialized.FindProperty("m_ColorGradingLutSize").intValue = 64;

            // A room bakes its lights, so the stage adds a light that only the character receives. URP limits a light
            // to some rendering layers only with this setting. See StageCharacterLight.
            serialized.FindProperty("m_SupportsLightLayers").boolValue = true;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>
        /// MToon and the example toon shaders declare the keyword of SSAO, but their code does not read it.
        /// So the effect runs after the opaque pass, and it darkens the color target for each shader.
        /// </summary>
        private static void ApplyAmbientOcclusion(UniversalRendererData renderer)
        {
            renderer.TryGetRendererFeature(out ScreenSpaceAmbientOcclusion feature);
            var serialized = new SerializedObject(feature);
            SerializedProperty settings = serialized.FindProperty("m_Settings");
            settings.FindPropertyRelative("AfterOpaque").boolValue = true;
            settings.FindPropertyRelative("Source").enumValueIndex = 1;
            settings.FindPropertyRelative("NormalSamples").enumValueIndex = 2;
            settings.FindPropertyRelative("Samples").enumValueIndex = 0;
            settings.FindPropertyRelative("Intensity").floatValue = 0.55f;
            settings.FindPropertyRelative("Radius").floatValue = 0.025f;
            settings.FindPropertyRelative("DirectLightingStrength").floatValue = 0.25f;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(feature);
        }

        /// <summary>A profile for each format, because the source colors of VRM and MMD models differ.</summary>
        private static VolumeProfile CreateLookProfile(
            string name,
            TonemappingMode tonemapping,
            float bloomIntensity,
            float bloomThreshold)
        {
            string path = $"{SettingsFolder}/{name}.asset";
            var profile = AssetDatabase.LoadAssetAtPath<VolumeProfile>(path);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<VolumeProfile>();
                AssetDatabase.CreateAsset(profile, path);
            }

            Tonemapping tone = OverrideIn<Tonemapping>(profile);
            tone.mode.Override(tonemapping);

            Bloom bloom = OverrideIn<Bloom>(profile);
            bloom.intensity.Override(bloomIntensity);
            bloom.threshold.Override(bloomThreshold);
            bloom.scatter.Override(0.6f);
            bloom.highQualityFiltering.Override(true);

            EditorUtility.SetDirty(profile);
            return profile;
        }

        private static T OverrideIn<T>(VolumeProfile profile)
            where T : VolumeComponent
        {
            if (profile.TryGet(out T existing))
            {
                EditorUtility.SetDirty(existing);
                return existing;
            }

            T added = profile.Add<T>(true);
            added.name = typeof(T).Name;
            AssetDatabase.AddObjectToAsset(added, profile);
            return added;
        }

        private static void AddRendererFeature<T>(UniversalRendererData renderer)
            where T : ScriptableRendererFeature
        {
            if (renderer.TryGetRendererFeature<T>(out _))
            {
                return;
            }

            var feature = ScriptableObject.CreateInstance<T>();
            feature.name = typeof(T).Name;
            AssetDatabase.AddObjectToAsset(feature, renderer);
            AssetDatabase.TryGetGUIDAndLocalFileIdentifier(feature, out _, out long localId);

            // The renderer reads the features through this map. The public list does not update it.
            var serialized = new SerializedObject(renderer);
            SerializedProperty features = serialized.FindProperty("m_RendererFeatures");
            SerializedProperty map = serialized.FindProperty("m_RendererFeatureMap");
            features.arraySize++;
            features.GetArrayElementAtIndex(features.arraySize - 1).objectReferenceValue = feature;
            map.arraySize++;
            map.GetArrayElementAtIndex(map.arraySize - 1).longValue = localId;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(renderer);
        }

        private static void IncludeRuntimeShaders()
        {
            var settings = new SerializedObject(GraphicsSettings.GetGraphicsSettings());
            SerializedProperty list = settings.FindProperty("m_AlwaysIncludedShaders");

            var present = new HashSet<Object>();
            for (int index = 0; index < list.arraySize; index++)
            {
                present.Add(list.GetArrayElementAtIndex(index).objectReferenceValue);
            }

            foreach (string name in RuntimeShaders)
            {
                Shader shader = Shader.Find(name);
                if (shader == null)
                {
                    throw new FileNotFoundException($"The shader {name} does not exist. Check the UniVRM packages.");
                }

                if (present.Add(shader))
                {
                    list.arraySize++;
                    list.GetArrayElementAtIndex(list.arraySize - 1).objectReferenceValue = shader;
                }
            }

            settings.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>
        /// Writes one material for each state that <see cref="StageLook"/> can need. The inspector of lilToon
        /// sets keywords and passes, and a player has no inspector. A clone of a template keeps them.
        /// </summary>
        private static void CreateLookTemplates()
        {
            Directory.CreateDirectory(LookTemplateFolder);
            lilShaderManager.InitializeShaders();

            SaveTemplate("liltoon-opaque", CreateLilToonTemplate(LilRenderingMode.Opaque, true));
            SaveTemplate("liltoon-cutout", CreateLilToonTemplate(LilRenderingMode.Cutout, true));
            SaveTemplate("liltoon-transparent", CreateLilToonTemplate(LilRenderingMode.Transparent, true));
            SaveTemplate("liltoon-opaque-noline", CreateLilToonTemplate(LilRenderingMode.Opaque, false));
            SaveTemplate("liltoon-cutout-noline", CreateLilToonTemplate(LilRenderingMode.Cutout, false));
            SaveTemplate("liltoon-transparent-noline", CreateLilToonTemplate(LilRenderingMode.Transparent, false));
        }

        private static void SaveTemplate(string name, Material material)
        {
            string path = $"{LookTemplateFolder}/{name}.mat";
            AssetDatabase.DeleteAsset(path);
            AssetDatabase.CreateAsset(material, path);
        }

        private static Material CreateLilToonTemplate(LilRenderingMode mode, bool outline)
        {
            var material = new Material(Shader.Find("lilToon"));
            lilToonInspector.SetupMaterialWithRenderingMode(material, mode, TransparentMode.Normal, outline, false, false, false);
            return material;
        }

        /// <summary>
        /// A soft studio: a bright top, a dim floor, and one large window at the front left of the character.
        /// MToon reads no reflection, so only the reflection of lilToon changes with this map.
        /// </summary>
        private static Cubemap CreateEnvironment()
        {
            const int size = 64;
            string path = $"{SettingsFolder}/StageEnvironment.asset";
            AssetDatabase.DeleteAsset(path);

            var cube = new Cubemap(size, TextureFormat.RGBAHalf, true);
            var window = new Vector3(0.45f, 0.45f, 0.77f);
            foreach (CubemapFace face in new[]
            {
                CubemapFace.PositiveX,
                CubemapFace.NegativeX,
                CubemapFace.PositiveY,
                CubemapFace.NegativeY,
                CubemapFace.PositiveZ,
                CubemapFace.NegativeZ,
            })
            {
                var pixels = new Color[size * size];
                for (int y = 0; y < size; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        Vector3 direction = DirectionOf(face, ((x + 0.5f) / size * 2f) - 1f, ((y + 0.5f) / size * 2f) - 1f);
                        float up = (direction.y * 0.5f) + 0.5f;
                        Color sky = Color.Lerp(new Color(0.16f, 0.15f, 0.16f), new Color(0.72f, 0.74f, 0.8f), up * up);
                        float glow = Mathf.Pow(Mathf.Max(0f, Vector3.Dot(direction, window)), 18f) * 2.6f;
                        pixels[(y * size) + x] = sky + (new Color(1f, 0.97f, 0.92f) * glow);
                    }
                }

                cube.SetPixels(pixels, face);
            }

            cube.Apply(true, false);
            AssetDatabase.CreateAsset(cube, path);
            return cube;
        }

        private static Vector3 DirectionOf(CubemapFace face, float u, float v)
        {
            switch (face)
            {
                case CubemapFace.PositiveX:
                    return new Vector3(1f, -v, -u).normalized;
                case CubemapFace.NegativeX:
                    return new Vector3(-1f, -v, u).normalized;
                case CubemapFace.PositiveY:
                    return new Vector3(u, 1f, v).normalized;
                case CubemapFace.NegativeY:
                    return new Vector3(u, -1f, -v).normalized;
                case CubemapFace.PositiveZ:
                    return new Vector3(u, -v, 1f).normalized;
                default:
                    return new Vector3(-u, -v, -1f).normalized;
            }
        }

        private static void CreateScene()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.42f, 0.42f, 0.44f);
            RenderSettings.skybox = null;
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Custom;
            RenderSettings.customReflectionTexture = CreateEnvironment();
            RenderSettings.reflectionIntensity = 1f;

            var cameraObject = new GameObject("Stage Camera", typeof(Camera), typeof(UniversalAdditionalCameraData))
            {
                tag = "MainCamera",
            };
            var camera = cameraObject.GetComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.16f, 0.18f, 0.22f);
            camera.fieldOfView = 25f;
            cameraObject.transform.SetPositionAndRotation(
                new Vector3(0f, 1f, 4f),
                Quaternion.LookRotation(Vector3.back, Vector3.up));

            var cameraData = cameraObject.GetComponent<UniversalAdditionalCameraData>();
            cameraData.renderPostProcessing = true;
            cameraData.dithering = true;

            // The three.js stage uses ACES for VRM models and Neutral for MMD models.
            VolumeProfile vrmLook = CreateLookProfile("StageLookVrm", TonemappingMode.ACES, 0.25f, 1f);
            VolumeProfile mmdLook = CreateLookProfile("StageLookMmd", TonemappingMode.Neutral, 0.3f, 0.9f);
            var volumeObject = new GameObject("Stage Look", typeof(Volume));
            var volume = volumeObject.GetComponent<Volume>();
            volume.isGlobal = true;
            volume.sharedProfile = vrmLook;

            var lightObject = new GameObject("Stage Light", typeof(Light));
            var light = lightObject.GetComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 0.85f;
            light.shadows = LightShadows.Soft;
            lightObject.transform.rotation = Quaternion.Euler(35f, 160f, 0f);

            var rootObject = new GameObject("Stage Root", typeof(StageRoot));
            var root = new SerializedObject(rootObject.GetComponent<StageRoot>());
            root.FindProperty("_camera").objectReferenceValue = camera;
            root.FindProperty("_light").objectReferenceValue = light;
            root.FindProperty("_look").objectReferenceValue = volume;
            root.FindProperty("_vrmLook").objectReferenceValue = vrmLook;
            root.FindProperty("_mmdLook").objectReferenceValue = mmdLook;
            root.ApplyModifiedPropertiesWithoutUndo();

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }
    }
}
