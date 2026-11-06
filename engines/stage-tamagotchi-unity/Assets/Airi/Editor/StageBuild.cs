using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Airi.Stage.Editor
{
    /// <summary>
    /// Builds the player for Windows. Set <c>AIRI_UNITY_STAGE_EXECUTABLE</c> to the output path to
    /// start it from AIRI.
    /// </summary>
    public static class StageBuild
    {
        private const string OutputPath = "Builds/Windows/airi-unity-stage.exe";

        public static void BuildPlayer()
        {
            BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { "Assets/Airi/Scenes/Stage.unity" },
                locationPathName = OutputPath,
                target = BuildTarget.StandaloneWindows64,
                options = BuildOptions.None,
            });

            Debug.Log($"[Airi] The build ended: {report.summary.result}, {report.summary.totalErrors} errors, {report.summary.totalSize / 1048576} MB.");

            // A batch run with -quit reports success after a failed method only if the method exits itself.
            if (report.summary.result != BuildResult.Succeeded)
            {
                EditorApplication.Exit(1);
            }
        }
    }
}
