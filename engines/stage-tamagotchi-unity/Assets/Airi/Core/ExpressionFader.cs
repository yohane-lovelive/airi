using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>The target weights and the cross-fade time of one emotion.</summary>
    public sealed class EmotionState
    {
        public readonly IReadOnlyDictionary<string, float> Targets;
        public readonly float BlendSeconds;

        public EmotionState(float blendSeconds, params (string Name, float Weight)[] targets)
        {
            BlendSeconds = blendSeconds;
            var map = new Dictionary<string, float>();
            foreach ((string name, float weight) in targets)
            {
                map[name] = weight;
            }

            Targets = map;
        }
    }

    /// <summary>
    /// The emotions of one kind of model. The shared fixtures check both tables against their sources:
    /// <c>stage-ui-three/src/composables/vrm/expression.ts</c> and <c>stage-ui-mmd/src/constants/morphs.ts</c>.
    /// </summary>
    public sealed class EmotionTable
    {
        private const string Neutral = "neutral";

        /// <summary>The names of a table for VRM models are VRM expressions.</summary>
        public static readonly EmotionTable Vrm = new EmotionTable(
            new Dictionary<string, EmotionState>
            {
                ["happy"] = new EmotionState(0.4f, ("happy", 0.7f), ("aa", 0.2f)),
                ["sad"] = new EmotionState(0.4f, ("sad", 0.7f), ("oh", 0.15f)),
                ["angry"] = new EmotionState(0.3f, ("angry", 0.7f), ("ee", 0.3f)),
                ["surprised"] = new EmotionState(0.15f, ("surprised", 0.8f), ("oh", 0.4f)),
                [Neutral] = new EmotionState(0.6f, (Neutral, 1f)),
                ["think"] = new EmotionState(0.5f, ("think", 0.7f)),
                ["relaxed"] = new EmotionState(0.4f, ("relaxed", 0.7f)),
            },
            new[] { "aa", "ih", "ou", "ee", "oh" },
            blinkName: "blink",
            defaultHoldMs: 3000f,
            hidesBlink: true,
            aliases: new Dictionary<string, string>
            {
                // `EMOTION_VRMExpressionName_value` of `stage-ui`. VRM models have no such expressions.
                ["awkward"] = Neutral,
                ["question"] = "think",
                ["curious"] = "think",
            },
            unknownIsNeutral: false);

        /// <summary>The names of a table for MMD models are the slots of <see cref="MorphSlots"/>.</summary>
        public static readonly EmotionTable Mmd = new EmotionTable(
            new Dictionary<string, EmotionState>
            {
                ["happy"] = new EmotionState(0.4f, ("smile", 0.8f), ("vowelA", 0.2f)),
                ["sad"] = new EmotionState(0.4f, ("sad", 0.75f), ("troubled", 0.3f)),
                ["angry"] = new EmotionState(0.3f, ("anger", 0.8f)),
                ["surprised"] = new EmotionState(0.15f, ("surprise", 0.8f), ("vowelO", 0.4f)),
                ["think"] = new EmotionState(0.5f, ("troubled", 0.5f), ("serious", 0.4f)),
                ["awkward"] = new EmotionState(0.4f, ("troubled", 0.6f), ("smile", 0.2f)),
                ["question"] = new EmotionState(0.4f, ("troubled", 0.4f), ("surprise", 0.2f)),
                ["curious"] = new EmotionState(0.4f, ("surprise", 0.35f), ("smile", 0.25f)),
                [Neutral] = new EmotionState(0.6f),
            },
            new[] { MorphSlots.VowelA, MorphSlots.VowelI, MorphSlots.VowelU, MorphSlots.VowelE, MorphSlots.VowelO },
            blinkName: MorphSlots.Blink,
            defaultHoldMs: null,
            hidesBlink: false,
            aliases: new Dictionary<string, string>(),
            unknownIsNeutral: true);

        private readonly Dictionary<string, EmotionState> _states;
        private readonly Dictionary<string, string> _aliases;
        private readonly bool _unknownIsNeutral;
        private readonly HashSet<string> _mouthNames;
        private readonly List<string> _ownedNames = new List<string>();

        /// <summary>Each name that an emotion of this table writes.</summary>
        public IReadOnlyList<string> OwnedNames => _ownedNames;

        /// <summary>The names of the vowels, in the order A, I, U, E, O.</summary>
        public readonly IReadOnlyList<string> MouthNames;

        /// <summary>The name of the blink.</summary>
        public readonly string BlinkName;

        /// <summary>
        /// The hold of an expression without its own hold. Null keeps it until the next one, as the MMD stage does.
        /// </summary>
        public readonly float? DefaultHoldMs;

        /// <summary>Whether an expression stops the blink. The VRM stage does this, and the MMD stage does not.</summary>
        public readonly bool HidesBlink;

        private EmotionTable(
            Dictionary<string, EmotionState> states,
            string[] mouthNames,
            string blinkName,
            float? defaultHoldMs,
            bool hidesBlink,
            Dictionary<string, string> aliases,
            bool unknownIsNeutral)
        {
            _states = states;
            _aliases = aliases;
            _unknownIsNeutral = unknownIsNeutral;
            _mouthNames = new HashSet<string>(mouthNames);
            MouthNames = mouthNames;
            BlinkName = blinkName;
            DefaultHoldMs = defaultHoldMs;
            HidesBlink = hidesBlink;

            foreach (EmotionState state in states.Values)
            {
                foreach (string name in state.Targets.Keys)
                {
                    if (!_ownedNames.Contains(name))
                    {
                        _ownedNames.Add(name);
                    }
                }
            }
        }

        public bool IsMouth(string name)
        {
            return _mouthNames.Contains(name);
        }

        /// <summary>The state of an emotion name, or null when this table cannot show it.</summary>
        public EmotionState Find(string emotion, out string resolved)
        {
            resolved = _aliases.TryGetValue(emotion, out string alias) ? alias : emotion;
            if (_states.TryGetValue(resolved, out EmotionState state))
            {
                return state;
            }

            if (_unknownIsNeutral)
            {
                resolved = Neutral;
                return _states[Neutral];
            }

            return null;
        }
    }

    /// <summary>
    /// Fades the expression of a character. The rules are the ones of <c>useVRMEmote</c> and <c>useMMDEmote</c>:
    /// - A new emotion cross-fades from the weights that show now, with an ease-in-out curve.
    /// - After its hold, the expression returns to neutral.
    /// - While lip sync owns the mouth, the mouth names of an emotion yield. They blend back when the speech ends.
    ///
    /// State: the weights of the names of the table. A new model starts a new instance.
    /// </summary>
    public sealed class ExpressionFader
    {
        private const string Neutral = "neutral";

        private readonly EmotionTable _table;
        private readonly Dictionary<string, float> _current = new Dictionary<string, float>();
        private readonly Dictionary<string, float> _start = new Dictionary<string, float>();
        private readonly Dictionary<string, float> _target = new Dictionary<string, float>();

        private string _emotion;
        private EmotionState _state;
        private bool _transitioning;
        private float _progress;
        private float? _holdLeftMs;
        private bool _mouthWasBusy;
        private bool _mouthReturning;
        private float _mouthProgress;
        private float _mouthFactor = 1f;

        public ExpressionFader(EmotionTable table)
        {
            _table = table;
            foreach (string name in table.OwnedNames)
            {
                _current[name] = 0;
                _start[name] = 0;
                _target[name] = 0;
            }
        }

        /// <summary>Whether the blink must wait, because an expression owns the eyes.</summary>
        public bool HidesBlink => _table.HidesBlink && IsEyeAreaActive;

        /// <summary>
        /// Starts an emotion.
        ///
        /// Expects:
        /// - An emotion name, or a name of the table. A table ignores a name that it cannot show, or
        ///   shows neutral, as its stage does.
        /// - An intensity. A value of 0 or below does nothing.
        /// - A hold in milliseconds. Null uses the default hold of the table.
        /// </summary>
        public void Set(string name, float intensity, float? holdMs)
        {
            float clamped = Math.Min(1f, Math.Max(0f, intensity));
            if (clamped <= 0)
            {
                return;
            }

            EmotionState state = _table.Find(name, out string resolved);
            if (state == null)
            {
                return;
            }

            _emotion = resolved;
            _state = state;
            _transitioning = true;
            _progress = 0;
            _holdLeftMs = resolved == Neutral ? null : holdMs ?? _table.DefaultHoldMs;

            foreach (string owned in _table.OwnedNames)
            {
                _start[owned] = WeightOf(owned);
                _target[owned] = 0;
            }

            foreach (KeyValuePair<string, float> target in state.Targets)
            {
                _target[target.Key] = target.Value * clamped;
            }

            // The start values hold what shows now, so the mouth needs no blend of its own.
            _mouthWasBusy = false;
            _mouthReturning = false;
            _mouthFactor = 1f;
        }

        /// <summary>The weight of a name of the table, or 0 for another name.</summary>
        public float WeightOf(string name)
        {
            if (!_current.TryGetValue(name, out float weight))
            {
                return 0;
            }

            return _table.IsMouth(name) ? weight * _mouthFactor : weight;
        }

        /// <param name="deltaSeconds">The time of this frame.</param>
        /// <param name="mouthBusy">Whether lip sync moves the mouth in this frame.</param>
        public void Update(float deltaSeconds, bool mouthBusy)
        {
            if (_holdLeftMs.HasValue)
            {
                _holdLeftMs -= deltaSeconds * 1000f;
                if (_holdLeftMs <= 0)
                {
                    Set(Neutral, 1f, null);
                }
            }

            if (_state == null)
            {
                return;
            }

            UpdateMouth(deltaSeconds, mouthBusy);

            if (!_transitioning)
            {
                return;
            }

            _progress += deltaSeconds / _state.BlendSeconds;
            bool settling = _progress >= 1f;
            float t = settling ? 1f : EaseInOutCubic(_progress);
            foreach (string owned in _table.OwnedNames)
            {
                _current[owned] = settling ? _target[owned] : _start[owned] + (_target[owned] - _start[owned]) * t;
            }

            if (settling)
            {
                _transitioning = false;
                if (_emotion == Neutral)
                {
                    _emotion = null;
                    _state = null;
                }
            }
        }

        private void UpdateMouth(float deltaSeconds, bool mouthBusy)
        {
            if (mouthBusy)
            {
                _mouthWasBusy = true;
                _mouthReturning = false;
                _mouthFactor = 0;
                return;
            }

            if (_mouthWasBusy)
            {
                _mouthWasBusy = false;
                _mouthReturning = true;
                _mouthProgress = 0;
            }

            if (_mouthReturning)
            {
                _mouthProgress += deltaSeconds / _state.BlendSeconds;
                if (_mouthProgress >= 1f)
                {
                    _mouthReturning = false;
                    _mouthFactor = 1f;
                }
                else
                {
                    _mouthFactor = EaseInOutCubic(_mouthProgress);
                }
            }
        }

        private bool IsEyeAreaActive
        {
            get
            {
                if (_emotion != null && _emotion != Neutral && AnyEyeWeight(_target))
                {
                    return true;
                }

                return _transitioning && AnyEyeWeight(_start);
            }
        }

        private bool AnyEyeWeight(Dictionary<string, float> weights)
        {
            foreach (KeyValuePair<string, float> weight in weights)
            {
                if (weight.Value > 0.001f && !_table.IsMouth(weight.Key))
                {
                    return true;
                }
            }

            return false;
        }

        private static float EaseInOutCubic(float t)
        {
            if (t < 0.5f)
            {
                return 4f * t * t * t;
            }

            float inverse = -2f * t + 2f;
            return 1f - inverse * inverse * inverse / 2f;
        }
    }
}
