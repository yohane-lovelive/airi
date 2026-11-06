using System;
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
        private readonly CharacterDriver _driver = new CharacterDriver(() => UnityEngine.Random.value);
        private readonly VrmaClipLibrary _clips;
        private readonly Action<string, string> _reportError;
        private IAvatarHost _host;
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

        public async Task PlayVrmaAsync(CharacterGestureVrmaMessage gesture)
        {
            int current = ++_newestGesture;
            try
            {
                VrmaClip clip = await _clips.LoadAsync(gesture.Path);
                if (current == _newestGesture)
                {
                    _driver.PlayGesture(clip, gesture.Part == "full");
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
