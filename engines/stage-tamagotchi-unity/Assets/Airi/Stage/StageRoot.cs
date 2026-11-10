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

        /// <summary>
        /// The light of MMD itself. MMD materials expect this value, and a stronger light turns a pale
        /// skin texture white, with its blush and its mouth gone.
        /// </summary>
        private const float MmdLightIntensity = 0.6f;

        /// <summary>The light that shows MToon materials of VRM models with no white areas.</summary>
        private const float VrmLightIntensity = 0.85f;

        [SerializeField]
        private Camera _camera;

        [SerializeField]
        private Light _light;

        [SerializeField]
        private Volume _look;

        [SerializeField]
        private VolumeProfile _vrmLook;

        [SerializeField]
        private VolumeProfile _mmdLook;

        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private StageSocketClient _socket;
        private IStageOutput _output;
        private StageLook _stageLook;
        private StageGrade _grade;
        private StageRoom _room;
        private VrmAvatarHost _vrm;
        private MmdAvatarHost _mmd;
        private StageCharacter _character;

        /// <summary>The parent of the avatars. A walk moves it, and the stage under it stays.</summary>
        private Transform _avatarRoot;

        /// <summary>The place of <see cref="_avatarRoot"/> at the last framing. The camera follows the walk from it.</summary>
        private Vector3 _framedAt;

        private StageWalker _walker;

        /// <summary>The number of the newest scene. An older scene drops its model when it finishes.</summary>
        private int _newestScene;

        private async void Start()
        {
            Application.runInBackground = true;
            string[] arguments = Environment.GetCommandLineArgs();
            _grade = StageGrade.FromArguments(arguments);
            try
            {
                _room = await StageRoom.LoadAsync(arguments, _lifetime.Token);
            }
            catch (OperationCanceledException)
            {
                // The sidecar exits during the load, and nobody sees the room.
                return;
            }

            _output = new WindowOutput(
                _camera,
                _room?.CameraLimits ?? StageCameraLimits.Free,
                StageCameraRig.FindInArguments(arguments),
                _room != null ? (float)_room.Manifest.FacingDegrees : 0f);
            _stageLook = StageLook.FromArguments(arguments, _grade);
            if (_room != null)
            {
                PrepareRoom();
            }
            else
            {
                _grade.PrepareStage(_light);
            }

            _avatarRoot = new GameObject("Avatar Root").transform;
            _avatarRoot.SetParent(transform, false);
            _vrm = new VrmAvatarHost(_avatarRoot, _stageLook);
            _mmd = new MmdAvatarHost(_avatarRoot, _stageLook);
            _character = new StageCharacter(transform, (message, type) => _socket?.Send(StageProtocol.CharacterError(message, type)));
            _walker = StageWalker.Create(arguments, _avatarRoot, _room);
            if (_walker != null)
            {
                _ = _character.SetWalkAsync(Path.Combine(Application.streamingAssetsPath, "AiriMotions", StageWalk.FileName));
            }

            await ConnectAsync();
        }

        /// <summary>Puts the avatars into the room. The room has its own lights, so the light of the stage would light the avatar twice.</summary>
        private void PrepareRoom()
        {
            _room.PlaceAvatars(transform);
            _light.enabled = false;
            _camera.clearFlags = CameraClearFlags.Skybox;
            _camera.fieldOfView = StageRoom.FieldOfView;
            _grade.PrepareRoom();
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

                case CharacterIdleMessage idle:
                    _ = _character.SetIdleAsync(idle.Path);
                    break;
                case CharacterExpressionMessage expression:
                    _character.SetExpression(expression);
                    break;
                case CharacterGestureKeysMessage keys:
                    _character.PlayKeys(keys);
                    break;
                case CharacterGestureVrmaMessage vrma:
                    _ = _character.PlayVrmaAsync(vrma);
                    break;
                case CharacterFrameMessage frame:
                    _character.ReceiveFrame(frame);
                    break;
                default:
                    break;
            }
        }

        /// <summary>
        /// Applies the character after the clips of this frame. UniVRM reads the result later in
        /// this frame, because its execution order comes after the default order. The NavMesh agent
        /// moved the avatars before this call, so the camera follows them here.
        /// </summary>
        private void LateUpdate()
        {
            if (_character == null)
            {
                return;
            }

            _walker?.Tick(Time.deltaTime, _character);
            _character.Tick(Time.deltaTime);
            _output.Follow(_avatarRoot.position - _framedAt);
        }

        private async Task ApplySceneAsync(SceneApplyMessage scene)
        {
            int current = ++_newestScene;
            IAvatarHost host = scene.Format == "pmx" ? _mmd : _vrm;
            IAvatarHost other = scene.Format == "pmx" ? _vrm : _mmd;

            try
            {
                Bounds? bounds = await host.LoadAsync(scene.Path, _lifetime.Token);
                if (bounds == null)
                {
                    return;
                }

                // Two formats have two hosts, so a host alone cannot see that a newer scene replaced it.
                if (current != _newestScene)
                {
                    host.Clear();
                    return;
                }

                other.Clear();
                _character.ShowAvatar(host);
                if (_room != null)
                {
                    _look.sharedProfile = _grade.IsActive ? _grade.Profile : scene.Format == "pmx" ? _mmdLook : _vrmLook;
                }
                else if (_grade.IsActive)
                {
                    _light.intensity = _grade.KeyIntensity;
                    _look.sharedProfile = _grade.Profile;
                }
                else
                {
                    _light.intensity = _stageLook.LightIntensity(scene.Format == "pmx" ? MmdLightIntensity : VrmLightIntensity);
                    _look.sharedProfile = scene.Format == "pmx" ? _mmdLook : _vrmLook;
                }

                _framedAt = _avatarRoot.position;
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
