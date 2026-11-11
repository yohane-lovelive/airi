using System;
using System.Collections.Generic;
using System.Linq;

namespace Airi.Stage.Core
{
    /// <summary>The phase of a <see cref="SeatMotion"/>.</summary>
    public enum SeatPhase
    {
        Standing,
        Entering,
        Seated,
        Exiting,
    }

    /// <summary>
    /// Plays the sit clips of the character: she sits down, sits with a loop, and gets up again. While she talks to the
    /// viewer, the talk loop takes the place of the idle loop.
    ///
    /// The layer lies over the idle and the walk, and under the gestures. It takes the rotations of its clips and the
    /// whole move of their hips. A sit clip moves the hips back while the feet stay, so the hips keep this move. The
    /// player reports the hips of these clips from their T-pose, see <see cref="StagePose"/>.
    ///
    /// State: the phase, the time in the clip, the weight of the layer and of the talk, and a pose to fade from. A
    /// change of clip fades from the last pose of the layer in <see cref="ClipFade"/>, so no clip has to start where
    /// another ends.
    /// </summary>
    public sealed class SeatMotion
    {
        public const string EnterFile = "sit-enter.vrma";
        public const string IdleFile = "sit-idle.vrma";
        public const string TalkFile = "sit-talk.vrma";
        public const string ExitFile = "sit-exit.vrma";

        /// <summary>The time in seconds in which the layer comes over the idle, or leaves it.</summary>
        public const float LayerFade = 0.4f;

        /// <summary>The time in seconds of the fade from one clip of the layer to the next.</summary>
        public const float ClipFade = 0.25f;

        private readonly StagePose _layer = new StagePose();
        private readonly StagePose _from = new StagePose();
        private readonly StagePose _scratch = new StagePose();
        private IHumanClip _enter;
        private IHumanClip _idle;
        private IHumanClip _talk;
        private IHumanClip _exit;
        private int[] _bones = Array.Empty<int>();
        private float _time;
        private float _loopTime;
        private float _fromWeight;
        private float _talkWeight;
        private bool _talking;

        public SeatPhase Phase { get; private set; }

        /// <summary>How much the layer shows now, from 0 to 1.</summary>
        public float Weight { get; private set; }

        public bool HasClips => _enter != null;

        /// <summary>
        /// How far she sat down, from 0 while she stands to 1 while she sits. It follows the drop of the hips in the
        /// pose, so it does not depend on the timing of the clips.
        /// </summary>
        public float Depth { get; private set; }

        /// <summary>The hips of the idle loop from the T-pose, in hip heights, as <see cref="StagePose"/> gives them.</summary>
        public float SeatedHipsX { get; private set; }

        /// <inheritdoc cref="SeatedHipsX"/>
        public float SeatedHipsY { get; private set; }

        /// <inheritdoc cref="SeatedHipsX"/>
        public float SeatedHipsZ { get; private set; }

        /// <summary>Sets the four clips, and stands her up at once.</summary>
        public void SetClips(IHumanClip enter, IHumanClip idle, IHumanClip talk, IHumanClip exit)
        {
            _enter = enter;
            _idle = idle;
            _talk = talk;
            _exit = exit;
            _bones = enter.Bones.Concat(idle.Bones).Concat(talk.Bones).Concat(exit.Bones).Distinct().OrderBy(bone => bone).ToArray();

            _scratch.Reset();
            idle.Sample(0, _scratch);
            SeatedHipsX = _scratch.HipsX;
            SeatedHipsY = _scratch.HipsY;
            SeatedHipsZ = _scratch.HipsZ;
            Stop();
        }

        /// <summary>
        /// Starts the clip that sits her down.
        ///
        /// Returns:
        /// - False without clips, or when she does not stand.
        /// </summary>
        public bool Sit()
        {
            if (!HasClips || Phase != SeatPhase.Standing)
            {
                return false;
            }

            if (Weight > 0)
            {
                Freeze();
            }

            Phase = SeatPhase.Entering;
            _time = 0;
            return true;
        }

        /// <summary>
        /// Starts the clip that gets her up. The layer fades out after its end.
        ///
        /// Returns:
        /// - False when she does not sit and does not sit down.
        /// </summary>
        public bool StandUp()
        {
            if (Phase != SeatPhase.Entering && Phase != SeatPhase.Seated)
            {
                return false;
            }

            Freeze();
            Phase = SeatPhase.Exiting;
            _time = 0;
            return true;
        }

        /// <summary>Stands her up at once, with no clip, for example for a new model.</summary>
        public void Stop()
        {
            Phase = SeatPhase.Standing;
            Weight = 0;
            Depth = 0;
            _fromWeight = 0;
            _talkWeight = 0;
        }

        /// <summary>Whether she talks to the viewer. The talk loop then takes the place of the idle loop.</summary>
        public void SetTalking(bool talking)
        {
            _talking = talking;
        }

        /// <summary>Advances the clips, and blends the layer over <paramref name="output"/>.</summary>
        public void Update(float deltaSeconds, StagePose output)
        {
            if (!HasClips)
            {
                return;
            }

            Advance(deltaSeconds);
            if (Weight <= 0)
            {
                Depth = 0;
                return;
            }

            SampleLayer();
            if (_fromWeight > 0)
            {
                Blend(_from, _layer, _fromWeight);
                _fromWeight = Math.Max(0f, _fromWeight - (deltaSeconds / ClipFade));
            }

            Blend(_layer, output, Weight);
            Depth = SeatedHipsY < 0 ? Math.Max(0f, Math.Min(1f, _layer.HipsY * Weight / SeatedHipsY)) : 0f;
        }

        private void Advance(float deltaSeconds)
        {
            float step = deltaSeconds / LayerFade;
            Weight = Phase != SeatPhase.Standing ? Math.Min(1f, Weight + step) : Math.Max(0f, Weight - step);
            float talkStep = deltaSeconds / ClipFade;
            _talkWeight = _talking ? Math.Min(1f, _talkWeight + talkStep) : Math.Max(0f, _talkWeight - talkStep);

            switch (Phase)
            {
                case SeatPhase.Entering:
                    _time += deltaSeconds;
                    if (_time >= _enter.Duration)
                    {
                        Freeze();
                        Phase = SeatPhase.Seated;
                        _loopTime = 0;
                    }

                    break;
                case SeatPhase.Seated:
                    _loopTime += deltaSeconds;
                    break;
                case SeatPhase.Exiting:
                    _time += deltaSeconds;
                    if (_time >= _exit.Duration)
                    {
                        // The layer holds the last frame of the exit while it fades out.
                        Phase = SeatPhase.Standing;
                    }

                    break;
            }
        }

        /// <summary>Writes the clip of the phase into the pose of the layer.</summary>
        private void SampleLayer()
        {
            _layer.Reset();
            switch (Phase)
            {
                case SeatPhase.Entering:
                    _enter.Sample(Math.Min(_time, _enter.Duration), _layer);
                    break;
                case SeatPhase.Seated:
                    _idle.Sample(Loop(_idle), _layer);
                    if (_talkWeight > 0)
                    {
                        _scratch.Reset();
                        _talk.Sample(Loop(_talk), _scratch);
                        Blend(_scratch, _layer, _talkWeight);
                    }

                    break;
                default:
                    _exit.Sample(Math.Min(_time, _exit.Duration), _layer);
                    break;
            }
        }

        private float Loop(IHumanClip clip)
        {
            return clip.Duration > 0 ? _loopTime % clip.Duration : 0;
        }

        /// <summary>Keeps the last pose of the layer, so the next clip fades from it.</summary>
        private void Freeze()
        {
            Array.Copy(_layer.Rotations, _from.Rotations, _layer.Rotations.Length);
            _from.HipsX = _layer.HipsX;
            _from.HipsY = _layer.HipsY;
            _from.HipsZ = _layer.HipsZ;
            _fromWeight = 1f;
        }

        /// <summary>Moves the bones of the layer and the hips of <paramref name="target"/> toward <paramref name="source"/>.</summary>
        private void Blend(StagePose source, StagePose target, float weight)
        {
            foreach (int bone in _bones)
            {
                target.Rotations[bone] = StageQuaternion.Slerp(target.Rotations[bone], source.Rotations[bone], weight);
            }

            target.HipsX += (source.HipsX - target.HipsX) * weight;
            target.HipsY += (source.HipsY - target.HipsY) * weight;
            target.HipsZ += (source.HipsZ - target.HipsZ) * weight;
        }
    }
}
