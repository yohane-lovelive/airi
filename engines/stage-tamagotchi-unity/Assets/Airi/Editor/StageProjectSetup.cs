using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

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
    ///     -> <see cref="CreateRenderPipeline"/>
    ///     -> <see cref="IncludeRuntimeShaders"/>
    ///     -> <see cref="CreateScene"/>
    /// </summary>
    public static class StageProjectSetup
    {
        private const string SettingsFolder = "Assets/Airi/Settings";
        private const string ScenePath = "Assets/Airi/Scenes/Stage.unity";

        /// <summary>
        /// UniVRM finds these shaders by name at runtime, while no asset of the project uses them.
        /// Without this list, a build removes them, and the model shows no material.
        /// </summary>
        private static readonly string[] RuntimeShaders =
        {
            "VRM10/Universal Render Pipeline/MToon10",
            "UniGLTF/UniUnlit",
        };

        public static void Apply()
        {
            ApplyPlayerSettings();
            UniversalRenderPipelineAsset pipeline = CreateRenderPipeline();
            GraphicsSettings.defaultRenderPipeline = pipeline;
            QualitySettings.renderPipeline = pipeline;
            IncludeRuntimeShaders();
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

            pipeline.msaaSampleCount = 4;
            EditorUtility.SetDirty(pipeline);
            return pipeline;
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

        private static void CreateScene()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.42f, 0.42f, 0.44f);
            RenderSettings.skybox = null;

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

            var lightObject = new GameObject("Stage Light", typeof(Light));
            var light = lightObject.GetComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 0.85f;
            light.shadows = LightShadows.Soft;
            lightObject.transform.rotation = Quaternion.Euler(35f, 160f, 0f);

            var rootObject = new GameObject("Stage Root", typeof(StageRoot));
            var root = new SerializedObject(rootObject.GetComponent<StageRoot>());
            root.FindProperty("_camera").objectReferenceValue = camera;
            root.ApplyModifiedPropertiesWithoutUndo();

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }
    }
}
