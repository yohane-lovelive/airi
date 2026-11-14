using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// The blink of a character. UniVRM has no automatic blink in its runtime, and an MMD model has
    /// none. The rules are the ones of <c>useBlink</c> and <c>useMMDBlink</c>: a random interval of 1 to
    /// 6 seconds, and a blink of 0.2 seconds on a sine curve.
    /// </summary>
    public sealed class BlinkTimer
    {
        private const float BlinkSeconds = 0.2f;
        private const float MinIntervalSeconds = 1f;
        private const float MaxIntervalSeconds = 6f;

        private readonly Func<double> _random;
        private float _sinceLast;
        private float _nextAt;
        private bool _blinking;
        private bool _suppressedCycle;
        private float _progress;

        /// <param name="random">Gives a number from 0 to 1. A test gives fixed numbers.</param>
        public BlinkTimer(Func<double> random)
        {
            _random = random;
            _nextAt = NextInterval();
        }

        /// <summary>The weight of the blink in this frame, from 0 to 1.</summary>
        public float Weight { get; private set; }

        /// <param name="deltaSeconds">The time of this frame.</param>
        /// <param name="suppress">
        /// Whether an expression owns the eyes. The cycle keeps going, so a blink cannot stay closed,
        /// and the weight stays 0 until the cycle ends. So a release cannot show half-closed lids.
        /// </param>
        public void Update(float deltaSeconds, bool suppress)
        {
            _sinceLast += deltaSeconds;

            if (!_blinking && _sinceLast >= _nextAt)
            {
                _blinking = true;
                _progress = 0;
                _suppressedCycle = suppress;
            }

            if (!_blinking)
            {
                Weight = 0;
                return;
            }

            _progress += deltaSeconds / BlinkSeconds;
            _suppressedCycle |= suppress;

            if (_progress >= 1f)
            {
                _blinking = false;
                _suppressedCycle = false;
                _sinceLast = 0;
                _nextAt = NextInterval();
                Weight = 0;
                return;
            }

            Weight = _suppressedCycle ? 0 : (float)Math.Sin(Math.PI * _progress);
        }

        private float NextInterval()
        {
            return (float)(_random() * (MaxIntervalSeconds - MinIntervalSeconds) + MinIntervalSeconds);
        }
    }
}
