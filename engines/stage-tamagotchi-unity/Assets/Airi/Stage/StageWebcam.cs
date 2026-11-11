using System.Linq;
using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace Airi.Stage
{
    /// <summary>
    /// The second monitor and the webcam at the desk of a room, as a streamer has them. The first monitor of the place
    /// shows the game. A webcam on its top edge films her face, and the second monitor shows this film. So the shot
    /// from behind her also shows her face from the front.
    ///
    /// <see cref="StageWebcamRig"/> gives the places. The room has no free space in its file, so this class tests each
    /// place against the parts of the room. The monitor stays in the room, and the webcam films only while she sits at
    /// the place. The film has 15 pictures each second, so it costs little of the frame.
    ///
    /// State: the objects of the monitor, the camera and its texture, the time to the next picture, the weight of the
    /// webcam for the light, and the frame times for the log.
    /// </summary>
    internal sealed class StageWebcam
    {
        private const string TemplatePath = "AiriRoom/screen-unlit";
        private const int TextureWidth = 512;
        private const int TextureHeight = 288;
        private const float PicturesPerSecond = 15f;

        /// <summary>The light moves to the side of the webcam in this time, as the camera moves to its shot.</summary>
        private const float FadeSeconds = 1.2f;

        /// <summary>The frame around the screen, in meters on each side.</summary>
        private const float Bezel = 0.015f;

        private const float FrameDepth = 0.03f;

        /// <summary>A space for the monitor keeps this far from the parts of the room, in meters.</summary>
        private const float Clearance = 0.01f;

        private static readonly Color FrameColor = new Color(0.06f, 0.06f, 0.07f);
        private static readonly Color OffColor = new Color(0.015f, 0.015f, 0.02f);

        private readonly Camera _camera;
        private readonly RenderTexture _texture;
        private readonly Material _screen;
        private float _sincePicture;
        private bool _active;
        private float _activeSince;
        private int _pictures;
        private float _idleFrame;
        private float _activeFrame;

        private StageWebcam(string placeName, StageRoomScreen screen, StagePoint webcam, Transform parent, Material template, StageRoomScreen first)
        {
            PlaceName = placeName;
            Screen = screen;
            Position = ToVector(webcam);

            var root = new GameObject("Airi Webcam Monitor").transform;
            root.SetParent(parent, false);
            Vector3 normal = NormalOf(screen);
            Vector3 center = ToVector(screen.Center);
            Quaternion turn = Quaternion.LookRotation(-normal, Vector3.up);

            AddBox(root, "Frame", center - (normal * (FrameDepth / 2)), turn, new Vector3((float)screen.Width + (2 * Bezel), (float)screen.Height + (2 * Bezel), FrameDepth), Tinted(template, FrameColor));
            _screen = Tinted(template, OffColor);
            GameObject quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Object.Destroy(quad.GetComponent<Collider>());
            quad.name = "Screen";
            quad.transform.SetParent(root, false);
            quad.transform.SetPositionAndRotation(center + (normal * 0.002f), turn);
            quad.transform.localScale = new Vector3((float)screen.Width, (float)screen.Height, 1f);
            quad.GetComponent<MeshRenderer>().sharedMaterial = _screen;

            // A pole from the desk holds the monitor, behind the first monitor when the second stands above it.
            Vector3 firstNormal = NormalOf(first);
            Vector3 poleTop = screen.Center.Y > first.Center.Y + (first.Height / 2)
                ? ToVector(first.Center) - (firstNormal * 0.1f) + (Vector3.up * (float)(screen.Center.Y - first.Center.Y))
                : center - (normal * 0.08f);
            if (Physics.Raycast(poleTop, Vector3.down, out RaycastHit desk, 2f, 1 << StageCameraFollow.FurnitureLayer, QueryTriggerInteraction.Ignore))
            {
                float height = poleTop.y - desk.point.y;
                AddBox(root, "Pole", poleTop + (Vector3.down * (height / 2)), turn, new Vector3(0.04f, height, 0.04f), Tinted(template, FrameColor));
            }

            AddBox(root, "Webcam", Position, Quaternion.LookRotation(firstNormal, Vector3.up), new Vector3(0.09f, 0.03f, 0.03f), Tinted(template, FrameColor));

            _texture = new RenderTexture(TextureWidth, TextureHeight, 24, RenderTextureFormat.ARGB32) { name = "Airi Webcam" };
            var cameraObject = new GameObject("Airi Webcam Camera");
            cameraObject.transform.SetParent(root, false);
            _camera = cameraObject.AddComponent<Camera>();
            _camera.targetTexture = _texture;
            _camera.nearClipPlane = 0.05f;
            _camera.farClipPlane = 30f;
            _camera.depth = -10f;
            _camera.enabled = false;
            UniversalAdditionalCameraData data = _camera.GetUniversalAdditionalCameraData();
            data.renderPostProcessing = false;
            data.renderShadows = false;

            Debug.Log($"[Airi] Webcam monitor at the place {placeName}: {Describe(screen, first)}.");
        }

        /// <summary>The name of the place of the desk.</summary>
        public string PlaceName { get; }

        /// <summary>The screen of the second monitor, for the shot of the camera.</summary>
        public StageRoomScreen Screen { get; }

        /// <summary>The place of the webcam. During a commentary, she looks here for each line.</summary>
        public Vector3 Position { get; }

        /// <summary>How far the light moved to the side of the webcam, from 0 to 1.</summary>
        public float Weight { get; private set; }

        /// <summary>The view direction of the webcam, toward her.</summary>
        public Vector3 Forward => _camera.transform.forward;

        /// <summary>
        /// Adds the second monitor and the webcam to the screen place with a seat that the commentary uses.
        ///
        /// Returns:
        /// - The webcam, or null when the place has no seat, the template is missing, or no place for the monitor is free.
        ///   The log has the cause.
        /// </summary>
        public static StageWebcam Create(StageRoom room, StageRoomPlace place, Transform parent)
        {
            if (place?.Screen == null || place.Seat == null)
            {
                return null;
            }

            var template = Resources.Load<Material>(TemplatePath);
            if (template == null)
            {
                Debug.LogWarning($"[Airi] The material {TemplatePath} is missing, so the desk gets no webcam. Run setup:project.");
                return null;
            }

            StageRoomScreen first = place.Screen;
            StageRoomScreen free = StageWebcamRig.Candidates(first).FirstOrDefault(candidate => room.IsFree(SpaceOf(candidate)));
            if (free == null)
            {
                Debug.Log($"[Airi] No space beside or above the screen of {place.Name} is free, so the desk gets no webcam.");
                return null;
            }

            return new StageWebcam(place.Name, free, StageWebcamRig.WebcamPosition(first), parent, template, first);
        }

        /// <summary>
        /// Films her while she sits at the place, 15 pictures each second, and moves the weight of the light. Otherwise
        /// the second monitor is dark.
        /// </summary>
        /// <param name="head">Her head joint while she sits, or null when she does not sit at the place.</param>
        public void Tick(float deltaSeconds, StagePoint? head)
        {
            bool active = head != null;
            if (active != _active)
            {
                _active = active;
                _screen.SetTexture("_BaseMap", active ? _texture : null);
                _screen.SetColor("_BaseColor", active ? Color.white : OffColor);
                if (active)
                {
                    _activeSince = Time.unscaledTime;
                    _pictures = 0;
                    StagePoint center = StageWebcamRig.FilmedCenter(head.Value);
                    Vector3 lens = Position + ((ToVector(center) - Position).normalized * 0.03f);
                    _camera.transform.SetPositionAndRotation(lens, Quaternion.LookRotation(ToVector(center) - lens, Vector3.up));
                    _camera.fieldOfView = (float)StageWebcamRig.FieldOfView(ToPoint(lens), head.Value);
                    Debug.Log($"[Airi] The webcam films her at {_camera.fieldOfView:F0} degrees. Frame time before it: {_idleFrame * 1000:F1} ms.");
                }
                else
                {
                    Debug.Log($"[Airi] The webcam stops after {Time.unscaledTime - _activeSince:F0} s and {_pictures} pictures. Frame time with it: {_activeFrame * 1000:F1} ms, without it: {_idleFrame * 1000:F1} ms.");
                }
            }

            // The frame times follow with a time constant of about 2 seconds, for the log.
            float share = Mathf.Clamp01(deltaSeconds / 2f);
            if (_active)
            {
                _activeFrame += (Time.unscaledDeltaTime - _activeFrame) * share;
            }
            else
            {
                _idleFrame += (Time.unscaledDeltaTime - _idleFrame) * share;
            }

            float step = deltaSeconds / FadeSeconds;
            Weight = _active ? Mathf.Min(1f, Weight + step) : Mathf.Max(0f, Weight - step);

            // A camera that is on renders in this frame, so it is on only for each picture.
            _sincePicture += deltaSeconds;
            _camera.enabled = _active && _sincePicture >= 1f / PicturesPerSecond;
            if (_camera.enabled)
            {
                _sincePicture = 0f;
                _pictures++;
            }
        }

        /// <summary>The box in the world that the frame of a monitor takes, a little larger for the clearance.</summary>
        private static Bounds SpaceOf(StageRoomScreen screen)
        {
            Vector3 normal = NormalOf(screen);
            Vector3 right = Vector3.Cross(Vector3.up, -normal).normalized;
            Vector3 center = ToVector(screen.Center) - (normal * (FrameDepth / 2));
            float halfWidth = ((float)screen.Width / 2) + Bezel;
            float halfDepth = FrameDepth / 2;

            // A turned box takes more space along each axis than its own sides.
            var extents = new Vector3(
                (Mathf.Abs(right.x) * halfWidth) + (Mathf.Abs(normal.x) * halfDepth),
                ((float)screen.Height / 2) + Bezel,
                (Mathf.Abs(right.z) * halfWidth) + (Mathf.Abs(normal.z) * halfDepth));
            return new Bounds(center, (2 * extents) + (Vector3.one * (2 * Clearance)));
        }

        private static string Describe(StageRoomScreen screen, StageRoomScreen first)
        {
            if (screen.Center.Y > first.Center.Y + (first.Height / 2))
            {
                return "above the first monitor";
            }

            Vector3 toSecond = ToVector(screen.Center) - ToVector(first.Center);
            Vector3 herRight = Vector3.Cross(Vector3.up, NormalOf(first));
            return Vector3.Dot(toSecond, herRight) > 0 ? "on her right" : "on her left";
        }

        private static void AddBox(Transform parent, string name, Vector3 position, Quaternion rotation, Vector3 size, Material material)
        {
            GameObject box = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Object.Destroy(box.GetComponent<Collider>());
            box.name = name;
            box.transform.SetParent(parent, false);
            box.transform.SetPositionAndRotation(position, rotation);
            box.transform.localScale = size;
            box.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        private static Material Tinted(Material template, Color color)
        {
            var material = new Material(template);
            material.SetColor("_BaseColor", color);
            return material;
        }

        /// <summary>The direction that a screen faces, toward the viewer.</summary>
        private static Vector3 NormalOf(StageRoomScreen screen)
        {
            float radians = (float)screen.FacingDegrees * Mathf.Deg2Rad;
            return new Vector3(Mathf.Sin(radians), 0f, Mathf.Cos(radians));
        }

        private static Vector3 ToVector(StagePoint point)
        {
            return new Vector3((float)point.X, (float)point.Y, (float)point.Z);
        }

        private static StagePoint ToPoint(Vector3 point)
        {
            return new StagePoint(point.x, point.y, point.z);
        }
    }
}
