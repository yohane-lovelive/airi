using System;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Airi.Stage
{
    /// <summary>The surface values of a grade, for the look that reads them.</summary>
    public sealed class GradeSurface
    {
        public Color RimColor;
        public float RimBorder;
        public float RimBlur;
        public float RimPower;

        /// <summary>0 draws the rim around the whole figure. 1 draws it only on the side of the key light.</summary>
        public float RimDirection;

        /// <summary>The share of the rim on a face. A strong rim on a face reads as a mask.</summary>
        public float RimOnFace;

        /// <summary>Colored shadows: how much the shade takes from the color of the surface.</summary>
        public float ShadeFromSurface;

        /// <summary>The shade of a face starts below this value, so a face stays clean and bright.</summary>
        public float FaceShadeBorder;

        /// <summary>The shade of other parts starts below this value. A higher value gives more shade and more depth.</summary>
        public float ShadeBorder;

        /// <summary>A multiplier of the shade color. A lower value gives deeper shadows.</summary>
        public float ShadeDepth;

        public float CastShadow;
        public float OutlineSaturation;
        public float OutlineValue;
        public float OutlineMinCentimeters;
        public float OutlineMaxCentimeters;
        public float EyeGlow;
    }

    /// <summary>
    /// The picture of the stage: the key light, the ambient light, and the camera effects.
    ///
    /// Use it through the argument <c>--airi-grade=backlit|live|cinema</c> of the player, or the environment
    /// variable AIRI_UNITY_STAGE_GRADE. Without them, the stage keeps its plain picture. This is a prototype,
    /// so the settings page has no control for it.
    ///
    /// State: the profile of the camera effects, which <see cref="PrepareStage"/> or <see cref="PrepareRoom"/> builds.
    /// </summary>
    public sealed class StageGrade
    {
        private const string Argument = "--airi-grade=";

        private readonly Color _keyColor;
        private readonly float _keyIntensity;
        private readonly Vector3 _keyRotation;
        private readonly Color _ambient;
        private readonly Action<VolumeProfile> _writeProfile;

        private VolumeProfile _profile;

        private StageGrade()
        {
        }

        private StageGrade(
            Color keyColor,
            float keyIntensity,
            Vector3 keyRotation,
            Color ambient,
            GradeSurface surface,
            Action<VolumeProfile> writeProfile)
        {
            _keyColor = keyColor;
            _keyIntensity = keyIntensity;
            _keyRotation = keyRotation;
            _ambient = ambient;
            Surface = surface;
            _writeProfile = writeProfile;
        }

        /// <summary>The surface values, or null when no grade is active.</summary>
        public GradeSurface Surface { get; }

        public bool IsActive => Surface != null;

        public float KeyIntensity => _keyIntensity;

        public VolumeProfile Profile => _profile;

        public static StageGrade FromArguments(string[] arguments)
        {
            string name = Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_GRADE");
            foreach (string argument in arguments)
            {
                if (argument.StartsWith(Argument, StringComparison.Ordinal))
                {
                    name = argument.Substring(Argument.Length);
                }
            }

            switch (name)
            {
                case "backlit":
                    return Backlit();
                case "live":
                    return Live();
                case "cinema":
                    return Cinema();
                default:
                    return new StageGrade();
            }
        }

        /// <summary>Sets the key light, the ambient light, and the camera effects of the stage without a room.</summary>
        public void PrepareStage(Light key)
        {
            if (!IsActive)
            {
                return;
            }

            key.color = _keyColor;
            key.intensity = _keyIntensity;
            key.transform.rotation = Quaternion.Euler(_keyRotation);

            var ambient = default(SphericalHarmonicsL2);
            ambient.AddAmbientLight(_ambient);
            RenderSettings.ambientMode = AmbientMode.Custom;
            RenderSettings.ambientProbe = ambient;

            BuildProfile();
        }

        /// <summary>
        /// Builds only the camera effects. A room has its own lights, its own ambient light, and its own walls,
        /// so the grade keeps the surface values and the camera effects.
        /// </summary>
        public void PrepareRoom()
        {
            if (IsActive)
            {
                BuildProfile();
            }
        }

        private void BuildProfile()
        {
            _profile = ScriptableObject.CreateInstance<VolumeProfile>();
            _writeProfile(_profile);
        }

        /// <summary>Strong sun behind the character: warm edges and a wide glow.</summary>
        private static StageGrade Backlit()
        {
            return new StageGrade(
                new Color(1f, 0.97f, 0.93f),
                0.62f,
                new Vector3(30f, 128f, 0f),
                new Color(0.42f, 0.39f, 0.4f),
                new GradeSurface
                {
                    RimColor = new Color(1f, 0.78f, 0.5f) * 1.7f,
                    RimBorder = 0.46f,
                    RimBlur = 0.2f,
                    RimPower = 2f,
                    RimDirection = 0f,
                    RimOnFace = 0.3f,
                    ShadeFromSurface = 0.55f,
                    FaceShadeBorder = 0.15f,
                    ShadeBorder = 0.58f,
                    ShadeDepth = 0.82f,
                    CastShadow = 0.7f,
                    OutlineSaturation = 1.25f,
                    OutlineValue = 0.42f,
                    OutlineMinCentimeters = 0.07f,
                    OutlineMaxCentimeters = 0.14f,
                    EyeGlow = 0.12f,
                },
                profile =>
                {
                    Tone(profile, TonemappingMode.Neutral);
                    Glow(profile, 0.95f, 1.9f, 0.9f, new Color(1f, 0.78f, 0.52f));
                    Colors(profile, 0f, 10f, 14f);
                    Tint(profile, new Vector4(1.02f, 0.98f, 0.96f, 0.01f), new Vector4(1.02f, 1f, 0.97f, 0f));
                    Edges(profile, 0.16f, 0.08f);
                });
        }

        /// <summary>A stage show: saturated color, a very soft glow over everything, and pink edges.</summary>
        private static StageGrade Live()
        {
            return new StageGrade(
                new Color(1f, 0.93f, 0.95f),
                0.56f,
                new Vector3(22f, 162f, 0f),
                new Color(0.5f, 0.42f, 0.55f),
                new GradeSurface
                {
                    RimColor = new Color(0.92f, 0.52f, 1f) * 1.4f,
                    RimBorder = 0.42f,
                    RimBlur = 0.32f,
                    RimPower = 1.8f,
                    RimDirection = 0f,
                    RimOnFace = 0.22f,
                    ShadeFromSurface = 0.6f,
                    FaceShadeBorder = 0.12f,
                    ShadeBorder = 0.5f,
                    ShadeDepth = 0.92f,
                    CastShadow = 0.45f,
                    OutlineSaturation = 1.3f,
                    OutlineValue = 0.5f,
                    OutlineMinCentimeters = 0.05f,
                    OutlineMaxCentimeters = 0.11f,
                    EyeGlow = 0.16f,
                },
                profile =>
                {
                    Tone(profile, TonemappingMode.Neutral);
                    Glow(profile, 0.92f, 1.45f, 0.9f, new Color(1f, 0.78f, 1f));
                    Colors(profile, 0f, 6f, 20f);
                    Tint(profile, new Vector4(1f, 0.96f, 1.06f, 0.03f), new Vector4(1f, 0.99f, 1.01f, 0f));
                    Edges(profile, 0.12f, 0.06f);
                });
        }

        /// <summary>A film frame: a hard white edge on one side, dark edges of the frame, cool shadows, and lens faults.</summary>
        private static StageGrade Cinema()
        {
            return new StageGrade(
                new Color(1f, 0.95f, 0.9f),
                0.55f,
                new Vector3(26f, 232f, 0f),
                new Color(0.34f, 0.37f, 0.43f),
                new GradeSurface
                {
                    RimColor = new Color(0.94f, 0.97f, 1f) * 2.1f,
                    RimBorder = 0.5f,
                    RimBlur = 0.04f,
                    RimPower = 2f,
                    RimDirection = 0.85f,
                    RimOnFace = 0.45f,
                    ShadeFromSurface = 0.6f,
                    FaceShadeBorder = 0.15f,
                    ShadeBorder = 0.6f,
                    ShadeDepth = 0.78f,
                    CastShadow = 0.75f,
                    OutlineSaturation = 1.2f,
                    OutlineValue = 0.32f,
                    OutlineMinCentimeters = 0.08f,
                    OutlineMaxCentimeters = 0.15f,
                    EyeGlow = 0.1f,
                },
                profile =>
                {
                    Tone(profile, TonemappingMode.Neutral);
                    Glow(profile, 1f, 0.75f, 0.72f, new Color(0.95f, 0.97f, 1f));
                    Colors(profile, 0f, 12f, 10f);
                    Tint(profile, new Vector4(0.94f, 1f, 1.08f, -0.01f), new Vector4(1.05f, 1f, 0.94f, 0f));
                    Edges(profile, 0.3f, 0.3f);
                    Grain(profile, 0.14f);
                });
        }

        private static void Tone(VolumeProfile profile, TonemappingMode mode)
        {
            profile.Add<Tonemapping>(true).mode.Override(mode);
        }

        private static void Glow(VolumeProfile profile, float threshold, float intensity, float scatter, Color tint)
        {
            Bloom bloom = profile.Add<Bloom>(true);
            bloom.threshold.Override(threshold);
            bloom.intensity.Override(intensity);
            bloom.scatter.Override(scatter);
            bloom.tint.Override(tint);
            bloom.highQualityFiltering.Override(true);
        }

        private static void Colors(VolumeProfile profile, float exposure, float contrast, float saturation)
        {
            ColorAdjustments colors = profile.Add<ColorAdjustments>(true);
            colors.postExposure.Override(exposure);
            colors.contrast.Override(contrast);
            colors.saturation.Override(saturation);
        }

        private static void Tint(VolumeProfile profile, Vector4 shadows, Vector4 highlights)
        {
            ShadowsMidtonesHighlights tint = profile.Add<ShadowsMidtonesHighlights>(true);
            tint.shadows.Override(shadows);
            tint.highlights.Override(highlights);
        }

        private static void Edges(VolumeProfile profile, float vignette, float aberration)
        {
            profile.Add<Vignette>(true).intensity.Override(vignette);
            profile.Add<ChromaticAberration>(true).intensity.Override(aberration);
        }

        private static void Grain(VolumeProfile profile, float intensity)
        {
            FilmGrain grain = profile.Add<FilmGrain>(true);
            grain.type.Override(FilmGrainLookup.Thin1);
            grain.intensity.Override(intensity);
        }
    }
}
