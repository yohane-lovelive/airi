using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Computes the state of the character for each frame: the pose, the weights of the face, and the
    /// gaze. An avatar host only applies the result, so this logic needs no Unity.
    ///
    /// Call stack of one frame:
    ///
    /// Update
    ///   -> FrameFollower.Update (mouth, offsets, eyes)
    ///   -> GestureMixer.Update (idle, walk, sit, and gestures)
    ///   -> GazeAim.Update (the turn to the viewer, after the clips)
    ///   -> offsets after the aim, as <c>BodyPoseApplier</c> does after the clips
    ///   -> ExpressionFader.Update, BlinkTimer.Update
    ///   -> Weights (expressions, mouth, blink)
    ///
    /// State: a new model needs <see cref="StartModel"/>. The idle clip stays, because the host sends
    /// it before the model.
    /// </summary>
    public sealed class CharacterDriver
    {
        private static readonly int Spine = HumanBones.IndexOf("spine");
        private static readonly int Chest = HumanBones.IndexOf("chest");
        private static readonly int Neck = HumanBones.IndexOf("neck");
        private static readonly int Head = HumanBones.IndexOf("head");

        private readonly Func<double> _random;
        private readonly GestureMixer _mixer = new GestureMixer();
        private readonly FrameFollower _frames = new FrameFollower();
        private readonly GazeAim _gaze = new GazeAim();
        private EmotionTable _table;
        private ExpressionFader _fader;
        private BlinkTimer _blink;
        private readonly List<string> _names = new List<string>();
        private int[] _mouthIndices = Array.Empty<int>();
        private int _blinkIndex;

        /// <param name="random">Gives a number from 0 to 1 for the blink. A test gives fixed numbers.</param>
        public CharacterDriver(Func<double> random)
        {
            _random = random;
        }

        /// <summary>The pose of this frame, in the frame of the host.</summary>
        public StagePose Pose { get; } = new StagePose();

        /// <summary>
        /// Whether a clip gives the pose. Without one, the pose is the T-pose, because the idle clip did
        /// not arrive or did not load.
        /// </summary>
        public bool HasMotion => _mixer.HasMotion;

        /// <summary>The names of <see cref="Weights"/>. The table of the model gives them.</summary>
        public IReadOnlyList<string> WeightNames => _names;

        /// <summary>One weight for each name of <see cref="WeightNames"/>.</summary>
        public float[] Weights { get; private set; } = Array.Empty<float>();

        /// <summary>Radians. A positive value turns toward +X of the frame of the host.</summary>
        public float EyesYaw => _gaze.EyesYaw + _frames.EyesYaw;

        /// <summary>Radians. A positive value turns down.</summary>
        public float EyesPitch => _gaze.EyesPitch + _frames.EyesPitch;

        /// <summary>Starts a new model with the emotions of its kind. A gesture of the old model ends.</summary>
        public void StartModel(EmotionTable table)
        {
            _table = table;
            _fader = new ExpressionFader(table);
            _blink = new BlinkTimer(_random);
            _mixer.Clear();

            _names.Clear();
            _names.AddRange(table.OwnedNames);
            _mouthIndices = new int[table.MouthNames.Count];
            for (int index = 0; index < _mouthIndices.Length; index++)
            {
                _mouthIndices[index] = IndexOfName(table.MouthNames[index]);
            }

            _blinkIndex = IndexOfName(table.BlinkName);
            Weights = new float[_names.Count];
        }

        public void SetIdle(IHumanClip clip)
        {
            _mixer.SetIdle(clip);
        }

        /// <summary>Sets the walk clip. <see cref="GestureMixer.SetWalk"/> gives the rules.</summary>
        public void SetWalk(IHumanClip clip)
        {
            _mixer.SetWalk(clip);
        }

        /// <summary>Sets how much the walk shows and how fast it plays. <see cref="GestureMixer.SetLocomotion"/> gives the rules.</summary>
        public void SetLocomotion(float weight, float rate)
        {
            _mixer.SetLocomotion(weight, rate);
        }

        /// <summary>How much the walk shows now, from 0 to 1.</summary>
        public float WalkWeight => _mixer.WalkWeight;

        /// <summary>The sit clips. A new model stands her up at once.</summary>
        public SeatMotion Seat => _mixer.Seat;

        /// <summary>
        /// Plays a gesture.
        ///
        /// Returns:
        /// - False when the gesture cannot play. <see cref="GestureMixer.PlayUpper"/> and
        ///   <see cref="GestureMixer.PlayWholeBody"/> give the rules.
        /// </summary>
        public bool PlayGesture(IHumanClip clip, bool wholeBody)
        {
            return wholeBody ? _mixer.PlayWholeBody(clip) : _mixer.PlayUpper(clip);
        }

        /// <summary>Starts an expression. Without a model, it does nothing.</summary>
        public void SetExpression(string name, float intensity, float? holdMs)
        {
            _fader?.Set(name, intensity, holdMs);
        }

        public void ReceiveFrame(CharacterFrameMessage frame)
        {
            _frames.Receive(frame);
        }

        /// <summary>Turns the head and the eyes to a point in this frame. <see cref="GazeAim.Aim"/> gives the frame of the direction.</summary>
        public void AimGaze(double x, double y, double z)
        {
            _gaze.Aim(x, y, z);
        }

        /// <summary>Lets the head and the eyes return to the clips.</summary>
        public void ReleaseGaze()
        {
            _gaze.Release();
        }

        /// <summary>Whether her body cannot turn to the viewer, for example while she sits. <see cref="GazeAim.SetBodyFixed"/> gives the rules.</summary>
        public void SetBodyFixed(bool bodyFixed)
        {
            _gaze.SetBodyFixed(bodyFixed);
        }

        /// <summary>Computes the state of this frame. A call before <see cref="StartModel"/> does nothing.</summary>
        public void Update(float deltaSeconds)
        {
            if (_table == null)
            {
                return;
            }

            _frames.Update(deltaSeconds);
            _mixer.Update(deltaSeconds, Pose);
            _gaze.Update(deltaSeconds);
            Pose.Rotations[Spine] = Pose.Rotations[Spine] * _gaze.Spine;
            Pose.Rotations[Neck] = Pose.Rotations[Neck] * _gaze.Neck;
            Pose.Rotations[Head] = Pose.Rotations[Head] * _gaze.Head;

            AddOffset(Spine, _frames.Spine);
            AddOffset(Chest, _frames.Chest);
            AddOffset(Neck, _frames.Neck);
            AddOffset(Head, _frames.Head);

            _fader.Update(deltaSeconds, _frames.MouthBusy);
            _blink.Update(deltaSeconds, _fader.HidesBlink);
            WriteWeights();
        }

        private void AddOffset(int bone, BodyRotation offset)
        {
            Pose.Rotations[bone] = Pose.Rotations[bone] * HumanoidFrame.FromEuler(offset);
        }

        private void WriteWeights()
        {
            for (int index = 0; index < Weights.Length; index++)
            {
                Weights[index] = _fader.WeightOf(_names[index]);
            }

            // Lip sync and an emotion can both want a vowel. While lip sync moves the mouth, the fader
            // gives 0 for the vowels, so the larger weight is the one that shows.
            MouthWeights mouth = _frames.Mouth;
            RaiseWeight(_mouthIndices[0], mouth.A);
            RaiseWeight(_mouthIndices[1], mouth.I);
            RaiseWeight(_mouthIndices[2], mouth.U);
            RaiseWeight(_mouthIndices[3], mouth.E);
            RaiseWeight(_mouthIndices[4], mouth.O);

            Weights[_blinkIndex] = _blink.Weight;
        }

        private void RaiseWeight(int index, float weight)
        {
            Weights[index] = Math.Max(Weights[index], weight);
        }

        private int IndexOfName(string name)
        {
            int index = _names.IndexOf(name);
            if (index >= 0)
            {
                return index;
            }

            _names.Add(name);
            return _names.Count - 1;
        }
    }
}
