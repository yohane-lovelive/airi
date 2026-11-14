using System;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Fits an image into a screen, as a TV fits a film of another shape. The image keeps its shape and fills the screen
    /// in one direction. The rest of the screen stays black.
    /// </summary>
    public static class StageScreenFit
    {
        /// <summary>
        /// Gives the size of the image on the screen, in the units of the screen.
        ///
        /// Returns:
        /// - The size of the screen for an image with no size.
        /// </summary>
        public static (double Width, double Height) Fit(double imageWidth, double imageHeight, double screenWidth, double screenHeight)
        {
            if (imageWidth <= 0 || imageHeight <= 0)
            {
                return (screenWidth, screenHeight);
            }

            double scale = Math.Min(screenWidth / imageWidth, screenHeight / imageHeight);
            return (imageWidth * scale, imageHeight * scale);
        }
    }
}
