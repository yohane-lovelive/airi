using System;
using System.IO;
using System.Threading.Tasks;
using Airi.Stage.Core;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// Connects the signals of the host to the avatar on the stage. <see cref="CharacterDriver"/>
    /// computes the state of each frame, and the avatar host applies it.
    ///
    /// State: the current avatar host. A new model of any format calls <see cref="ShowAvatar"/>. A load
    /// of a clip takes time, so a clip that a newer signal replaced does not play when it arrives.
    /// </summary>
    internal sealed class StageCharacter
    {
        /// <summary>Below this speed in meters each second, the character stands, and the walk fades out.</summary>
        private const float SlowestWalk = 0.05f;

        private readonly CharacterDriver _driver = new CharacterDriver(() => UnityEngine.Random.value);
        private readonly VrmaClipLibrary _clips;
        private readonly Action<string, string> _reportError;
        private IAvatarHost _host;
        private VrmaClip _walk;
        private int _newestIdle;
        private int _newestGesture;

        /// <param name="clipParent">The parent of the hidden skeletons of the clips.</param>
        /// <param name="reportError">Sends a message and the type of the signal that failed to the host.</param>
        public StageCharacter(Transform clipParent, Action<string, string> reportError)
        {
            _clips = new VrmaClipLibrary(clipParent);
            _reportError = reportError;
        }

        public void ShowAvatar(IAvatarHost host)
        {
            _host = host;
            _driver.StartModel(host.Emotions);
        }

        public void ReceiveFrame(CharacterFrameMessage frame)
        {
            _driver.ReceiveFrame(frame);
        }

        public void SetExpression(CharacterExpressionMessage expression)
        {
            _driver.SetExpression(expression.Name, expression.Intensity, expression.HoldMs);
        }

        public void PlayKeys(CharacterGestureKeysMessage gesture)
        {
            _newestGesture++;
            _driver.PlayGesture(new KeyframeClip(gesture.Duration, gesture.Tracks), wholeBody: false);
        }

        public async Task SetIdleAsync(string path)
        {
            int current = ++_newestIdle;
            try
            {
                VrmaClip clip = await _clips.LoadAsync(path);
                if (current == _newestIdle)
                {
                    _driver.SetIdle(clip);
                }
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not load the idle clip {path}: {error}");
                _reportError($"Could not load the idle clip: {error.Message}", "host.character.idle");
            }
        }

        /// <summary>Loads the walk clip of the player. It reports its hips from its T-pose, see <see cref="VrmaClip.HipsFromRest"/>.</summary>
        public async Task SetWalkAsync(string path)
        {
            try
            {
                _walk = await _clips.LoadAsync(path);
                _walk.HipsFromRest = true;
                _driver.SetWalk(_walk);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not load the walk clip {path}: {error}");
            }
        }

        /// <summary>
        /// Loads the four sit clips of the player. They report their hips from their T-pose, so the drop of the hips
        /// and their move back stay.
        /// </summary>
        public async Task SetSeatAsync(string folder)
        {
            try
            {
                var clips = new VrmaClip[4];
                string[] files = { SeatMotion.EnterFile, SeatMotion.IdleFile, SeatMotion.TalkFile, SeatMotion.ExitFile };
                for (int index = 0; index < files.Length; index++)
                {
                    clips[index] = await _clips.LoadAsync(Path.Combine(folder, files[index]));
                    clips[index].HipsFromRest = true;
                }

                _driver.Seat.SetClips(clips[0], clips[1], clips[2], clips[3]);
                SeatMotion seat = _driver.Seat;
                Debug.Log($"[Airi] The sit clips load. While she sits, her hips are at ({seat.SeatedHipsX:F2}, {seat.SeatedHipsY:F2}, {seat.SeatedHipsZ:F2}) hip heights from the T-pose.");
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not load the sit clips from {folder}: {error}");
            }
        }

        /// <summary>Whether she can sit: an avatar with legs is on the stage, and the sit clips loaded.</summary>
        public bool CanSit => _host != null && _host.HipHeight > 0f && _host.ThighLength > 0f && _driver.Seat.HasClips;

        public SeatPhase SeatPhase => _driver.Seat.Phase;

        /// <summary>How far she sat down, from 0 to 1. <see cref="SeatMotion.Depth"/> gives the rules.</summary>
        public float SeatDepth => _driver.Seat.Depth;

        /// <summary>
        /// The move of her hips from a stand as far as she sat down, in meters, in the frame of her body: to her right,
        /// up, and to her front. Her head moves with her hips, so the camera follows this move.
        /// </summary>
        public Vector3 SeatShift
        {
            get
            {
                if (!CanSit)
                {
                    return Vector3.zero;
                }

                SeatMotion seat = _driver.Seat;
                return new Vector3(-seat.SeatedHipsX, seat.SeatedHipsY, seat.SeatedHipsZ) * (_host.HipHeight * seat.Depth);
            }
        }

        /// <summary>The length from her hip joint to her knee, in meters, or 0 without an avatar.</summary>
        public float ThighLength => _host?.ThighLength ?? 0f;

        /// <summary>The height of her hips in the rest pose, in meters, or 0 without an avatar.</summary>
        public float HipHeight => _host?.HipHeight ?? 0f;

        /// <summary>
        /// The hips of the sit loop from the root of the avatar, in meters, in the frame of her body: to her right, up,
        /// and to her front. The X axis of a pose is mirrored, so her right is its negative X.
        /// </summary>
        public Vector3 SeatedHips
        {
            get
            {
                float height = HipHeight;
                SeatMotion seat = _driver.Seat;
                return new Vector3(-seat.SeatedHipsX * height, (1f + seat.SeatedHipsY) * height, seat.SeatedHipsZ * height);
            }
        }

        /// <summary>
        /// Sits her down.
        ///
        /// Returns:
        /// - False when she cannot sit now, or does not stand.
        /// </summary>
        public bool Sit()
        {
            return CanSit && _driver.Seat.Sit();
        }

        /// <summary>Gets her up. The exit clip plays, and the stand returns after it.</summary>
        public void StandUp()
        {
            _driver.Seat.StandUp();
        }

        /// <summary>Whether she talks to the viewer while she sits. The talk loop then plays.</summary>
        public void SetTalking(bool talking)
        {
            _driver.Seat.SetTalking(talking);
        }

        /// <summary>Whether her body cannot turn to the viewer. The spine then takes a share of the turn.</summary>
        public void SetBodyFixed(bool bodyFixed)
        {
            _driver.SetBodyFixed(bodyFixed);
        }

        /// <summary>
        /// Shows the walk at the speed of the character. The clip plays at the rate that matches the speed to the
        /// legs of the avatar, so the feet slide less.
        /// </summary>
        public void Move(float metersPerSecond)
        {
            float hipHeight = _host?.HipHeight ?? 0f;
            float cycle = _walk?.Duration ?? 0f;
            _driver.SetLocomotion(metersPerSecond > SlowestWalk ? 1f : 0f, (float)StageWalk.Rate(metersPerSecond, hipHeight, cycle));
        }

        /// <summary>
        /// Turns the head and the eyes to a point in the world, or lets them return to the clips with null. Without an
        /// avatar, they return too.
        /// </summary>
        /// <param name="body">The root of the avatars. Its rotation is the facing of her body.</param>
        public void LookAt(Vector3? point, Transform body)
        {
            float headHeight = _host?.HeadHeight ?? 0f;
            if (point == null || headHeight <= 0f)
            {
                _driver.ReleaseGaze();
                return;
            }

            Vector3 head = body.position + (body.up * headHeight);
            Vector3 direction = body.InverseTransformDirection(point.Value - head);
            _driver.AimGaze(direction.x, direction.y, direction.z);
        }

        public async Task PlayVrmaAsync(CharacterGestureVrmaMessage gesture)
        {
            int current = ++_newestGesture;
            try
            {
                VrmaClip clip = await _clips.LoadAsync(gesture.Path);
                bool wholeBody = gesture.Part == "full";
                if (current == _newestGesture && !_driver.PlayGesture(clip, wholeBody) && wholeBody)
                {
                    Debug.Log($"[Airi] The gesture {gesture.Id} moves the whole body, so it does not play while she sits.");
                }
            }
            catch (Exception error)
            {
                Debug.LogError($"[Airi] Could not load the gesture {gesture.Path}: {error}");
                _reportError($"Could not load the gesture {gesture.Id}: {error.Message}", "host.character.gesture");
            }
        }

        /// <summary>Computes and applies the state of this frame. Without an avatar, it does nothing.</summary>
        public void Tick(float deltaSeconds)
        {
            if (_host == null)
            {
                return;
            }

            _driver.Update(deltaSeconds);

            _host.ApplyCharacter(_driver, deltaSeconds);
        }
    }
}
