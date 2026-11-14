using System.Diagnostics;
using Airi.Stage.Core;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Airi.Stage
{
    /// <summary>
    /// Shows the game of a commentary on the first screen of the screen place, for example the monitor of the desk.
    ///
    /// The UVs of a screen of a world are unknown, so its material stays. A black plate covers the screen instead, and the
    /// image lies on it with its own shape, see <see cref="StageScreenFit"/>. Without a frame for 3 seconds, or at the end
    /// of the activity, the plates hide, and the screen of the world shows again.
    ///
    /// The frames stay in memory. Each one replaces the texture of the last one, and nothing reaches the disk.
    ///
    /// State: the plates, one texture, the time of the last frame, and the decode times for the log.
    /// </summary>
    internal sealed class StageGameScreen
    {
        /// <summary>Without a frame for this time, the screen of the world shows again.</summary>
        private const float HideAfterSeconds = 3f;

        private const float LogEverySeconds = 10f;

        /// <summary>The black plate lies this far in front of the screen of the world, and the image a little farther.</summary>
        private const float BlackLift = 0.003f;

        private const float ImageLift = 0.004f;

        private readonly GameObject _root;
        private readonly Transform _image;
        private readonly Texture2D _texture;
        private readonly StageRoomScreen _screen;
        private readonly Stopwatch _watch = new Stopwatch();
        private float _lastFrame = float.NegativeInfinity;
        private float _logAt;
        private int _frames;
        private double _decodeSum;
        private double _decodeMax;

        private StageGameScreen(string placeName, StageRoomScreen screen, Transform parent, Material template)
        {
            PlaceName = placeName;
            _screen = screen;
            _root = new GameObject("Airi Game Screen");
            _root.transform.SetParent(parent, false);
            Vector3 normal = StageScreenPlates.NormalOf(screen);
            Vector3 center = StageScreenPlates.ToVector(screen.Center);
            StageScreenPlates.AddPlate(_root.transform, "Black", center, normal, (float)screen.Width, (float)screen.Height, BlackLift, StageScreenPlates.Tinted(template, Color.black));

            _texture = new Texture2D(2, 2, TextureFormat.RGB24, false) { name = "Airi Game Frame", wrapMode = TextureWrapMode.Clamp };
            Material image = StageScreenPlates.Tinted(template, Color.white);
            image.SetTexture("_BaseMap", _texture);
            _image = StageScreenPlates.AddPlate(_root.transform, "Image", center, normal, (float)screen.Width, (float)screen.Height, ImageLift, image);
            _root.SetActive(false);
        }

        /// <summary>The name of the screen place.</summary>
        public string PlaceName { get; }

        /// <summary>
        /// Adds the plates to the screen of a place.
        ///
        /// Returns:
        /// - The game screen, or null when the place has no screen or the template is missing.
        /// </summary>
        public static StageGameScreen Create(StageRoomPlace place, Transform parent)
        {
            if (place?.Screen == null)
            {
                return null;
            }

            Material template = StageScreenPlates.LoadTemplate("game screen");
            return template != null ? new StageGameScreen(place.Name, place.Screen, parent, template) : null;
        }

        /// <summary>Shows one JPEG. A broken image keeps the last frame, and the log says so.</summary>
        public void Show(byte[] jpeg)
        {
            _watch.Restart();
            bool loaded = _texture.LoadImage(jpeg);
            _watch.Stop();
            if (!loaded)
            {
                Debug.LogWarning("[Airi] A frame of the game screen is no image Unity can read.");
                return;
            }

            double milliseconds = _watch.Elapsed.TotalMilliseconds;
            _decodeSum += milliseconds;
            _decodeMax = System.Math.Max(_decodeMax, milliseconds);
            _frames++;

            (double width, double height) = StageScreenFit.Fit(_texture.width, _texture.height, _screen.Width, _screen.Height);
            _image.localScale = new Vector3((float)width, (float)height, 1f);
            if (!_root.activeSelf)
            {
                _root.SetActive(true);
                _logAt = Time.unscaledTime + LogEverySeconds;
                Debug.Log($"[Airi] The game shows on the screen of {PlaceName}, at {_texture.width}x{_texture.height}.");
            }

            _lastFrame = Time.unscaledTime;
        }

        /// <summary>Hides the plates at once, for example at the end of the activity.</summary>
        public void Hide()
        {
            if (!_root.activeSelf)
            {
                return;
            }

            LogFrames();
            _root.SetActive(false);
            Debug.Log($"[Airi] The screen of {PlaceName} shows its own picture again.");
        }

        /// <summary>Hides the plates when no frame came for 3 seconds, and logs the decode times each 10 seconds.</summary>
        public void Tick()
        {
            if (!_root.activeSelf)
            {
                return;
            }

            if (Time.unscaledTime - _lastFrame > HideAfterSeconds)
            {
                Hide();
                return;
            }

            if (Time.unscaledTime >= _logAt)
            {
                LogFrames();
                _logAt = Time.unscaledTime + LogEverySeconds;
            }
        }

        private void LogFrames()
        {
            if (_frames == 0)
            {
                return;
            }

            Debug.Log($"[Airi] Game screen: {_frames} frames, decode {_decodeSum / _frames:F1} ms on average and {_decodeMax:F1} ms at most.");
            _frames = 0;
            _decodeSum = 0;
            _decodeMax = 0;
        }
    }
}
