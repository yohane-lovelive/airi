using System;
using System.Collections.Generic;

namespace Airi.Stage.Core
{
    /// <summary>
    /// The morphs of an MMD model that AIRI drives. The names differ for each model, so each slot has a
    /// list of candidates, and the first name that the model has wins. The list is the one of
    /// <c>MORPH_CANDIDATES</c> in <c>stage-ui-mmd/src/constants/morphs.ts</c>.
    /// </summary>
    public static class MorphSlots
    {
        public const string VowelA = "vowelA";
        public const string VowelI = "vowelI";
        public const string VowelU = "vowelU";
        public const string VowelE = "vowelE";
        public const string VowelO = "vowelO";
        public const string Blink = "blink";

        public static readonly IReadOnlyDictionary<string, string[]> Candidates = new Dictionary<string, string[]>
        {
            [VowelA] = new[] { "あ", "a", "A" },
            [VowelI] = new[] { "い", "i", "I" },
            [VowelU] = new[] { "う", "u", "U" },
            [VowelE] = new[] { "え", "e", "E" },
            [VowelO] = new[] { "お", "o", "O" },
            [Blink] = new[] { "まばたき", "blink", "Blink" },
            ["blinkLeft"] = new[] { "ウィンク", "ウインク", "wink", "Wink" },
            ["blinkRight"] = new[] { "ウィンク右", "ウインク右", "ウィンク2", "wink_r", "Wink_R" },
            ["smile"] = new[] { "笑い", "にこり", "わらい", "smile", "Smile" },
            ["anger"] = new[] { "怒り", "いかり", "anger", "Anger" },
            ["sad"] = new[] { "悲しい", "悲しむ", "sad", "Sad" },
            ["surprise"] = new[] { "驚き", "びっくり", "surprise", "Surprise" },
            ["troubled"] = new[] { "困る", "こまる", "troubled", "Troubled" },
            ["serious"] = new[] { "真面目", "じと目", "serious", "Serious" },
        };

        /// <summary>
        /// Finds the morph of each slot on one model.
        ///
        /// Expects:
        /// - A check for a morph name on the model.
        ///
        /// Returns:
        /// - The morph name of each slot that the model has. A slot without a morph is absent.
        /// </summary>
        public static Dictionary<string, string> Resolve(Func<string, bool> hasMorph)
        {
            var resolved = new Dictionary<string, string>();
            foreach (KeyValuePair<string, string[]> slot in Candidates)
            {
                foreach (string candidate in slot.Value)
                {
                    if (hasMorph(candidate))
                    {
                        resolved[slot.Key] = candidate;
                        break;
                    }
                }
            }

            return resolved;
        }
    }
}
