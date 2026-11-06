using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.Rendering;

namespace Airi.Stage
{
    /// <summary>
    /// The entry of the sidecar. It connects to Electron main and applies its messages.
    ///
    /// Lifecycle:
    /// - The sidecar lives as long as its host. It exits when the host stops it or disappears, so
    ///   Electron cannot leave a stage window behind.
    /// - In the Editor, an exit ends Play mode. Electron main then waits for the next Play mode.
    /// </summary>
    public sealed class StageRoot : MonoBehaviour
    {
        /// <summary>UniVRM finds this shader by name at runtime, so a build must include it.</summary>
        private const string MToonShader = "VRM10/Universal Render Pipeline/MToon10";

        [SerializeField]
        private Camera _camera;

        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private StageSocketClient _socket;
        private IStageOutput _output;
        private VrmAvatarHost _avatar;

        private async void Start()
        {
            Application.runInBackground = true;
            _output = new WindowOutput(_camera);
            _avatar = new VrmAvatarHost(transform);

            await ConnectAsync();
        }

        private void Update()
        {
            _output?.Tick();

            if (_socket == null)
            {
                return;
            }

            while (_socket.TryReceive(out string text))
            {
                HandleMessage(text);
            }

            if (_socket.IsClosed)
            {
                Debug.Log($"[Airi] {_socket.CloseReason}");
                Exit(0);
            }
        }

        private void OnDestroy()
        {
            _lifetime.Cancel();
            _socket?.Dispose();
        }

        private async Task ConnectAsync()
        {
            string url = StageLaunch.FindUrlInArguments(Environment.GetCommandLineArgs());

#if UNITY_EDITOR
            url ??= await WaitForAttachFileAsync();
#endif

            if (url == null)
            {
                if (!_lifetime.IsCancellationRequested)
                {
                    Debug.LogError("[Airi] Start this player from AIRI: the argument --airi-ws-url is missing.");
                    Exit(2);
                }

                return;
            }

            var socket = new StageSocketClient();
            try
            {
                await socket.ConnectAsync(new Uri(url), _lifetime.Token);
            }
            catch (Exception error) when (!_lifetime.IsCancellationRequested)
            {
                socket.Dispose();
                Debug.LogError($"[Airi] Could not connect to AIRI: {error.Message}");
                Exit(1);
                return;
            }

            _socket = socket;

            string fatal = FindStartupFault();
            if (fatal != null)
            {
                Debug.LogError($"[Airi] {fatal}");
                _socket.Send(StageProtocol.StageFatal(fatal));
                return;
            }

            _socket.Send(StageProtocol.StageReady());
        }

#if UNITY_EDITOR
        /// <summary>
        /// Waits for the file of Electron main. Play mode can start first, so the file can come later.
        /// AIRI_UNITY_STAGE_ATTACH_FILE has priority, for a host with another data folder.
        /// </summary>
        private async Task<string> WaitForAttachFileAsync()
        {
            string path = Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_ATTACH_FILE");
            if (string.IsNullOrEmpty(path))
            {
                path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "@proj-airi",
                    "stage-tamagotchi",
                    "unity-stage",
                    "attach.json");
            }

            Debug.Log($"[Airi] Waiting for {path}. Select the Unity Stage button in AIRI.");

            while (!_lifetime.IsCancellationRequested)
            {
                if (File.Exists(path))
                {
                    string url = StageLaunch.ReadUrlFromAttachFile(File.ReadAllText(path));
                    if (url != null)
                    {
                        return url;
                    }
                }

                await Task.Delay(500);
            }

            return null;
        }
#endif

        /// <summary>Finds a project fault that makes each model fail, so the owner reads its cause once.</summary>
        private static string FindStartupFault()
        {
            if (GraphicsSettings.currentRenderPipeline == null)
            {
                return "The Unity stage has no render pipeline asset.";
            }

            if (Shader.Find(MToonShader) == null)
            {
                return $"The build of the Unity stage does not include the shader {MToonShader}.";
            }

            return null;
        }

        private void HandleMessage(string text)
        {
            HostMessage message;
            try
            {
                message = StageProtocol.ParseHostMessage(text);
            }
            catch (StageProtocolException error)
            {
                _socket.Send(StageProtocol.CharacterError(error.Message, string.Empty));
                return;
            }

            switch (message)
            {
                case SceneApplyMessage scene:
                    _ = ApplySceneAsync(scene);
                    break;
                case ShutdownMessage:
                    Exit(0);
                    break;

                // Step U3 of the ADR applies the idle, the expressions, the gestures, and the frames.
                // They are valid messages, so no error goes back to the host.
                default:
                    break;
            }
        }

        private async Task ApplySceneAsync(SceneApplyMessage scene)
        {
            try
            {
                Bounds? bounds = await _avatar.LoadAsync(scene.Path, _lifetime.Token);
                if (bounds == null)
                {
                    return;
                }

                _output.Frame(bounds.Value);
                _socket.Send(StageProtocol.SceneApplied(scene.ModelId, ToProtocol(bounds.Value)));
            }
            catch (OperationCanceledException)
            {
                // The sidecar is exiting, and nobody reads the result.
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not load {scene.Path}: {error}");
                _socket.Send(StageProtocol.SceneError($"Could not load the model {scene.Name}: {error.Message}"));
            }
        }

        private static AvatarBounds ToProtocol(Bounds bounds)
        {
            return new AvatarBounds(
                bounds.center.x,
                bounds.center.y,
                bounds.center.z,
                bounds.size.x,
                bounds.size.y,
                bounds.size.z,
                Mathf.Max(bounds.size.x, bounds.size.y, bounds.size.z));
        }

        private static void Exit(int code)
        {
#if UNITY_EDITOR
            UnityEditor.EditorApplication.ExitPlaymode();
#else
            Application.Quit(code);
#endif
        }
    }
}
