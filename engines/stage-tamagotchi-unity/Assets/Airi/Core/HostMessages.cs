using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// A message from Electron main. The contract is
    /// <c>packages/stage-shared/src/stage-sidecar/protocol.ts</c>.
    /// </summary>
    public abstract class HostMessage
    {
    }

    /// <summary>Shows the model at <see cref="Path"/>. A failed load keeps the previous model.</summary>
    public sealed class SceneApplyMessage : HostMessage
    {
        public readonly string Format;
        public readonly string ModelId;
        public readonly string Name;
        public readonly string Path;

        public SceneApplyMessage(string format, string modelId, string name, string path)
        {
            Format = format;
            ModelId = modelId;
            Name = name;
            Path = path;
        }
    }

    /// <summary>Sets the <c>.vrma</c> file that plays while no gesture plays.</summary>
    public sealed class CharacterIdleMessage : HostMessage
    {
        public readonly string Path;

        public CharacterIdleMessage(string path)
        {
            Path = path;
        }
    }

    /// <summary>Shows an expression, then returns to neutral.</summary>
    public sealed class CharacterExpressionMessage : HostMessage
    {
        public readonly string Name;
        public readonly float Intensity;

        /// <summary>Null means that the sidecar uses its default hold.</summary>
        public readonly float? HoldMs;

        public CharacterExpressionMessage(string name, float intensity, float? holdMs)
        {
            Name = name;
            Intensity = intensity;
            HoldMs = holdMs;
        }
    }

    /// <summary>
    /// The rotation keys of one bone of a gesture. <see cref="Values"/> holds four numbers
    /// <c>[x, y, z, w]</c> for each time, in the frame of a VRM humanoid. Convert each key with
    /// <see cref="HumanoidFrame.ToUnity"/> before use.
    /// </summary>
    public sealed class RotationTrack
    {
        public readonly string Bone;
        public readonly float[] Times;
        public readonly float[] Values;

        public RotationTrack(string bone, float[] times, float[] values)
        {
            Bone = bone;
            Times = times;
            Values = values;
        }
    }

    /// <summary>A built-in or generated gesture. It moves only the upper body.</summary>
    public sealed class CharacterGestureKeysMessage : HostMessage
    {
        public readonly string Id;
        public readonly float Duration;
        public readonly IReadOnlyList<RotationTrack> Tracks;

        public CharacterGestureKeysMessage(
            string id,
            float duration,
            IReadOnlyList<RotationTrack> tracks)
        {
            Id = id;
            Duration = duration;
            Tracks = tracks;
        }
    }

    /// <summary>
    /// A gesture in a <c>.vrma</c> file. <see cref="Part"/> is <c>upper</c>, or <c>full</c> for a
    /// clip that replaces the whole idle.
    /// </summary>
    public sealed class CharacterGestureVrmaMessage : HostMessage
    {
        public readonly string Id;
        public readonly string Part;
        public readonly string Path;

        public CharacterGestureVrmaMessage(string id, string part, string path)
        {
            Id = id;
            Part = part;
            Path = path;
        }
    }

    /// <summary>A rotation offset as Euler angles in radians, in the order XYZ.</summary>
    public readonly struct BodyRotation
    {
        public readonly float X;
        public readonly float Y;
        public readonly float Z;

        public BodyRotation(float x, float y, float z)
        {
            X = x;
            Y = y;
            Z = z;
        }
    }

    /// <summary>The vowel weights of the mouth, from 0 to 1.</summary>
    public readonly struct MouthWeights
    {
        public readonly float A;
        public readonly float E;
        public readonly float I;
        public readonly float O;
        public readonly float U;

        public MouthWeights(float a, float e, float i, float o, float u)
        {
            A = a;
            E = e;
            I = i;
            O = o;
            U = u;
        }
    }

    /// <summary>
    /// The continuous state of one moment, 30 times each second. The offsets are in the frame of a
    /// VRM humanoid.
    /// </summary>
    public sealed class CharacterFrameMessage : HostMessage
    {
        public readonly MouthWeights Mouth;
        public readonly BodyRotation Spine;
        public readonly BodyRotation Chest;
        public readonly BodyRotation Neck;
        public readonly BodyRotation Head;

        /// <summary>Radians. A positive value turns toward +X of the VRM frame.</summary>
        public readonly float EyesYaw;

        /// <summary>Radians. A positive value turns down.</summary>
        public readonly float EyesPitch;

        public CharacterFrameMessage(
            MouthWeights mouth,
            BodyRotation spine,
            BodyRotation chest,
            BodyRotation neck,
            BodyRotation head,
            float eyesYaw,
            float eyesPitch)
        {
            Mouth = mouth;
            Spine = spine;
            Chest = chest;
            Neck = neck;
            Head = head;
            EyesYaw = eyesYaw;
            EyesPitch = eyesPitch;
        }
    }

    /// <summary>
    /// Who the character turns to. The sidecar keeps the last value until the next message, and a new sidecar starts
    /// with <c>none</c>.
    /// </summary>
    public sealed class CharacterAttentionMessage : HostMessage
    {
        /// <summary>
        /// True for <c>viewer</c>: she stops, and turns her body, her head, and her eyes to the camera of the window.
        /// False for <c>none</c>: she returns to her own activity.
        /// </summary>
        public readonly bool ToViewer;

        public CharacterAttentionMessage(bool toViewer)
        {
            ToViewer = toViewer;
        }
    }

    /// <summary>Electron main stops the sidecar. The sidecar exits by itself.</summary>
    public sealed class ShutdownMessage : HostMessage
    {
    }
}
