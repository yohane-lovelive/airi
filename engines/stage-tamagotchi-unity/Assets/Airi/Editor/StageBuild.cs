using System.IO;
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
                return;
            }

            CopyShiftJisSupport();
        }

        /// <summary>
        /// Copies the Shift_JIS tables of Mono to the player. unity-mmd-loader needs them, because MMD
        /// files use Shift_JIS. A build includes only the assemblies that the code references, and
        /// Mono loads these two by name at runtime, so a player without this copy fails at the first
        /// model. The files stay out of Git, because each Editor has them.
        /// </summary>
        private static void CopyShiftJisSupport()
        {
            string source = Path.Combine(EditorApplication.applicationContentsPath, "MonoBleedingEdge/lib/mono/4.5");
            string managed = Path.Combine(Path.GetDirectoryName(OutputPath), $"{Path.GetFileNameWithoutExtension(OutputPath)}_Data", "Managed");

            foreach (string file in new[] { "I18N.dll", "I18N.CJK.dll" })
            {
                File.Copy(Path.Combine(source, file), Path.Combine(managed, file), true);
            }
        }
    }
}
