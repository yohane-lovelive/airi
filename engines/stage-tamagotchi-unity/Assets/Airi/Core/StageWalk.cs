namespace Airi.Stage.Core
{
    /// <summary>
    /// Facts of the walk clip of the stage, <c>walk.vrma</c>: the casual walk of the Universal Animation Library of
    /// Quaternius. The clip plays in place, so the stage moves the character, and this class matches the two.
    /// </summary>
    public static class StageWalk
    {
        /// <summary>The file name of the clip in the folder <c>StreamingAssets/AiriMotions</c> of the player.</summary>
        public const string FileName = "walk.vrma";

        /// <summary>
        /// The distance of one cycle, in hip heights. The version of the clip with root motion moves 1.30 m in one
        /// cycle, and its hips are 0.90 m high in its T-pose.
        /// </summary>
        public const double StrideHipHeights = 1.30 / 0.90;

        /// <summary>
        /// Gives the rate of the clip that makes the feet move at the speed of the character. A model with longer
        /// legs takes longer steps, so it plays the clip slower at the same speed.
        ///
        /// Returns:
        /// - 1 for a model or a clip without a size.
        /// </summary>
        public static double Rate(double speedMetersPerSecond, double hipHeightMeters, double cycleSeconds)
        {
            if (hipHeightMeters <= 0 || cycleSeconds <= 0)
            {
                return 1;
            }

            return speedMetersPerSecond / (StrideHipHeights * hipHeightMeters / cycleSeconds);
        }
    }
}
