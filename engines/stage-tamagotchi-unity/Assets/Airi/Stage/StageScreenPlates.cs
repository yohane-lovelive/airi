using Airi.Stage.Core;
using UnityEngine;

namespace Airi.Stage
{
    /// <summary>
    /// Makes the flat plates that the stage puts on the screens of a room: the screen of the webcam monitor, and the game
    /// on the first monitor. Each plate uses a clone of the unlit material of URP that <c>setup:project</c> writes, so the
    /// light of the room does not change a picture.
    /// </summary>
    internal static class StageScreenPlates
    {
        private const string TemplatePath = "AiriRoom/screen-unlit";

        /// <summary>
        /// Loads the unlit material.
        ///
        /// Returns:
        /// - The material, or null when the project setup did not write it. The log says so.
        /// </summary>
        public static Material LoadTemplate(string user)
        {
            var template = Resources.Load<Material>(TemplatePath);
            if (template == null)
            {
                Debug.LogWarning($"[Airi] The material {TemplatePath} is missing, so the room gets no {user}. Run setup:project.");
            }

            return template;
        }

        /// <summary>A clone of the material with a color.</summary>
        public static Material Tinted(Material template, Color color)
        {
            var material = new Material(template);
            material.SetColor("_BaseColor", color);
            return material;
        }

        /// <summary>
        /// Adds a plate that faces the way of a screen, a little in front of the screen, with no collider.
        /// </summary>
        /// <param name="lift">The distance in front of the screen, in meters, so the plate covers the screen of the world.</param>
        public static Transform AddPlate(Transform parent, string name, Vector3 center, Vector3 normal, float width, float height, float lift, Material material)
        {
            GameObject quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Object.Destroy(quad.GetComponent<Collider>());
            quad.name = name;
            quad.transform.SetParent(parent, false);

            // A quad shows its front toward its -Z, so its +Z points away from the viewer.
            quad.transform.SetPositionAndRotation(center + (normal * lift), Quaternion.LookRotation(-normal, Vector3.up));
            quad.transform.localScale = new Vector3(width, height, 1f);
            quad.GetComponent<MeshRenderer>().sharedMaterial = material;
            return quad.transform;
        }

        /// <summary>The direction that a screen faces, toward the viewer.</summary>
        public static Vector3 NormalOf(StageRoomScreen screen)
        {
            float radians = (float)screen.FacingDegrees * Mathf.Deg2Rad;
            return new Vector3(Mathf.Sin(radians), 0f, Mathf.Cos(radians));
        }

        public static Vector3 ToVector(StagePoint point)
        {
            return new Vector3((float)point.X, (float)point.Y, (float)point.Z);
        }
    }
}
