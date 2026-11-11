using Airi.Stage.Core;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Airi.Stage
{
    /// <summary>
    /// The light of the character in a room. <see cref="CharacterLight"/> decides its strength, its color, and its
    /// direction, and this class applies them to a directional light.
    ///
    /// Only the character receives it. The light reaches one rendering layer of URP, and the avatars join this layer when
    /// they load. The renderers of a room keep the default layer, and their URP shaders check the layer, so the baked
    /// light of the room stays. MToon and the shader of the MMD loader do not check layers, so they receive each light.
    ///
    /// A room must come from an import with rendering layers on. A bundle of an earlier import has no shader variant
    /// that checks the layer, and this light then also lights the room.
    ///
    /// The light casts no shadow. A shadow of the bangs drew a band across the face.
    ///
    /// State: the light, and the smoothing of <see cref="CharacterLight"/>.
    /// </summary>
    internal sealed class StageCharacterLight
    {
        private const uint Layer = 1u << CharacterLight.RenderingLayer;

        /// <summary>The probe reads the light at about the chest of a person.</summary>
        private const float ProbeHeight = 1.0f;

        private readonly Light _light;
        private readonly CharacterLight _math = new CharacterLight();

        public StageCharacterLight(Transform parent)
        {
            var lightObject = new GameObject("Character Light");
            lightObject.transform.SetParent(parent, false);
            _light = lightObject.AddComponent<Light>();
            _light.type = LightType.Directional;
            _light.shadows = LightShadows.None;
            _light.GetUniversalAdditionalLightData().renderingLayers = Layer;
        }

        /// <summary>Puts each renderer of the avatars into the layer of the light. Each new model calls it.</summary>
        public static void Mark(Transform avatarRoot)
        {
            foreach (Renderer renderer in avatarRoot.GetComponentsInChildren<Renderer>(true))
            {
                renderer.renderingLayerMask |= Layer;
            }
        }

        /// <summary>Moves the light to the room light at her place and to the view of this frame.</summary>
        /// <param name="feet">The place of her feet. The probe reads the light above it.</param>
        /// <param name="viewForward">The view direction that the light follows, for example of the camera of the window.</param>
        public void Tick(float deltaSeconds, Vector3 feet, Vector3 viewForward)
        {
            LightProbes.GetInterpolatedProbe(feet + (Vector3.up * ProbeHeight), null, out SphericalHarmonicsL2 probe);
            _math.Update(deltaSeconds, probe[0, 0], probe[1, 0], probe[2, 0], viewForward.x, viewForward.z);

            // The math gives linear values, and the color of a light is in gamma space.
            _light.color = new Color((float)_math.Red, (float)_math.Green, (float)_math.Blue).gamma;
            _light.intensity = (float)_math.Intensity;
            _light.transform.rotation = Quaternion.Euler((float)_math.PitchDegrees, (float)_math.YawDegrees, 0f);
        }
    }
}
