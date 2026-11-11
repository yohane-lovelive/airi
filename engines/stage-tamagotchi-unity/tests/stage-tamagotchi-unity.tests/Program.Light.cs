using System;
using Airi.Stage.Core;

/// <summary>Tests of the light of the character in a room.</summary>
public static partial class Program
{
    private static void TestCharacterLight()
    {
        TestCharacterLightStrength();
        TestCharacterLightColor();
        TestCharacterLightFollow();
        TestCharacterLightDirection();
    }

    private static double LuminanceOf(double red, double green, double blue)
    {
        return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    }

    private static void TestCharacterLightStrength()
    {
        var room = new CharacterLight();
        room.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 0, 1);
        CheckNear(room.Intensity, CharacterLight.FillShare * (CharacterLight.TargetBrightness - LuminanceOf(0.4, 0.3, 0.2)), 1e-9, "the light fills a share of what the room lacks");

        var corridor = new CharacterLight();
        corridor.Update(1.0 / 60.0, 0.2, 0.15, 0.1, 0, 1);
        Check(corridor.Intensity > room.Intensity, $"a darker place gets a stronger light: {corridor.Intensity} <= {room.Intensity}");

        var bright = new CharacterLight();
        bright.Update(1.0 / 60.0, 1, 1, 1, 0, 1);
        CheckNear(bright.Intensity, CharacterLight.WeakestIntensity, 1e-9, "a bright room still gets the weakest light");

        var dark = new CharacterLight();
        dark.Update(1.0 / 60.0, 0, 0, 0, 0, 1);
        CheckNear(dark.Intensity, CharacterLight.FillShare * CharacterLight.TargetBrightness, 1e-9, "a dark room gets the share of the whole target");
    }

    private static void TestCharacterLightColor()
    {
        var warm = new CharacterLight();
        warm.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 0, 1);
        CheckNear(warm.Red, 1, 1e-9, "the largest part of the color stays 1");
        CheckNear(warm.Green, 0.75 + (0.25 * CharacterLight.WhiteShare), 1e-9, "the green goes half way to white");
        CheckNear(warm.Blue, 0.5 + (0.5 * CharacterLight.WhiteShare), 1e-9, "the blue goes half way to white");

        var dark = new CharacterLight();
        dark.Update(1.0 / 60.0, 0, 0, 0, 0, 1);
        CheckNear(dark.Blue, 1, 1e-9, "a room with no light gives a white light");
    }

    private static void TestCharacterLightFollow()
    {
        var light = new CharacterLight();
        light.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 0, 1);
        double before = light.Intensity;
        double after = CharacterLight.FillShare * (CharacterLight.TargetBrightness - LuminanceOf(0.2, 0.15, 0.1));

        light.Update(CharacterLight.FollowSeconds, 0.2, 0.15, 0.1, 0, 1);

        CheckNear(light.Intensity, before + ((after - before) * (1 - Math.Exp(-1))), 1e-9, "the light follows a darker place smoothly");
    }

    private static void TestCharacterLightDirection()
    {
        var light = new CharacterLight();
        light.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 0, 1);
        CheckNear(light.PitchDegrees, CharacterLight.ElevationDegrees, 1e-9, "the light comes down at its angle");
        CheckNear(light.YawDegrees, CharacterLight.SideDegrees, 1e-9, "a camera that looks toward +Z gets a light from its side");

        light.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 2, 0);
        CheckNear(light.YawDegrees, 90 + CharacterLight.SideDegrees, 1e-9, "the light turns with the camera");

        light.Update(1.0 / 60.0, 0.4, 0.3, 0.2, 0, 0);
        CheckNear(light.YawDegrees, 90 + CharacterLight.SideDegrees, 1e-9, "a camera that looks straight down keeps the last direction");
    }
}
