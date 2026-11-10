using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Airi.Stage
{
    /// <summary>The materials of the avatar.</summary>
    public enum StageLookKind
    {
        /// <summary>The materials of the loader: MToon for VRM models, and MMD Toon Lit for PMX models.</summary>
        Source,
        LilToon,
    }

    public enum AvatarMaterialFormat
    {
        Vrm,
        Mmd,
    }

    /// <summary>
    /// The materials of a look for one avatar. The material morphs of MMD write to the materials of the
    /// loader, so <see cref="Sync"/> copies their colors to the new materials.
    ///
    /// State: one entry for each new material, with the last colors that it copied.
    /// </summary>
    public sealed class LookMaterials
    {
        private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");
        private static readonly int AmbientColorId = Shader.PropertyToID("_AmbientColor");

        private readonly List<Entry> _entries = new List<Entry>();

        internal void Add(Material mmdSource, Material converted, bool outline)
        {
            var entry = new Entry { MmdSource = mmdSource, Converted = converted, Outline = outline };
            if (mmdSource != null)
            {
                entry.Diffuse = mmdSource.GetColor(BaseColorId);
                entry.Ambient = mmdSource.GetColor(AmbientColorId);
            }

            _entries.Add(entry);
        }

        /// <summary>Copies the colors after a material morph. A call without a change only compares the colors.</summary>
        public void Sync()
        {
            foreach (Entry entry in _entries)
            {
                if (entry.MmdSource == null)
                {
                    continue;
                }

                Color diffuse = entry.MmdSource.GetColor(BaseColorId);
                Color ambient = entry.MmdSource.GetColor(AmbientColorId);
                if (diffuse == entry.Diffuse && ambient == entry.Ambient)
                {
                    continue;
                }

                entry.Diffuse = diffuse;
                entry.Ambient = ambient;
                StageLook.WriteColor(entry.Converted, StageLook.MmdSurfaceColor(diffuse, ambient), entry.Outline);
            }
        }

        public void Clear()
        {
            foreach (Entry entry in _entries)
            {
                UnityEngine.Object.Destroy(entry.Converted);
            }

            _entries.Clear();
        }

        private sealed class Entry
        {
            public Material MmdSource;
            public Material Converted;
            public bool Outline;
            public Color Diffuse;
            public Color Ambient;
        }
    }

    /// <summary>
    /// Replaces the materials of a loaded avatar with materials of lilToon.
    ///
    /// Use it through the argument <c>--airi-look=liltoon</c> of the player, or the environment variable
    /// AIRI_UNITY_STAGE_LOOK. Without them, the materials of the loader stay. This is a prototype, so the
    /// settings page has no control for it.
    ///
    /// New materials clone a template of <c>Resources/AiriLooks</c>. A material of a build needs a shader
    /// variant, and a build keeps only the variants of its assets. The templates are these assets.
    ///
    /// Known limits:
    /// - Expressions of UniVRM write to the old materials, so their color changes do not show. Blend shapes
    ///   keep working.
    /// - VRM and PMX files carry no smoothness or thickness data. The smoothness comes from the material name.
    /// </summary>
    public sealed class StageLook
    {
        private const string Argument = "--airi-look=";

        /// <summary>A mesh part with this share of its vertices on the head bone is a face, not a body.</summary>
        private const float FaceHeadShare = 0.6f;

        /// <summary>A skin material with this share of its vertices on the head bone also covers the face.</summary>
        private const float SharedSkinHeadShare = 0.1f;

        /// <summary>Below this alpha, a material is hidden. Authors hide optional parts this way, and morphs show them.</summary>
        private const float HiddenAlpha = 0.001f;

        /// <summary>
        /// The light of MMD Toon Lit in sRGB on this stage: a key light of 0.6, and the flat ambient light.
        /// New materials keep these values, so the color of a material does not change with the stage light.
        /// </summary>
        private const float MmdKeyLight = 0.8f;

        private const float MmdAmbientLight = 0.43f;

        private const string MmdHeadBone = "頭";

        /// <summary>The light modes of each pass that draws or writes depth. A hidden material turns them all off.</summary>
        private static readonly string[] DrawLightModes =
        {
            "UniversalForward",
            "UniversalForwardOnly",
            "ShadowCaster",
            "DepthOnly",
            "DepthNormals",
            "DepthNormalsOnly",
        };

        private const string UnlitLightMode = "SRPDefaultUnlit";

        private enum MaterialKind
        {
            Skin,
            Face,
            Hair,
            Eye,
            FaceLine,
            Cloth,
        }

        private enum AlphaKind
        {
            Opaque,
            Cutout,
            Transparent,
        }

        private readonly GradeSurface _surface;

        private StageLook(StageLookKind kind, GradeSurface surface)
        {
            Kind = kind;
            _surface = surface;
        }

        public StageLookKind Kind { get; }

        /// <summary>
        /// Reads the look. AIRI starts the player with its own arguments, and the player inherits the
        /// environment, so AIRI_UNITY_STAGE_LOOK selects a look in a normal run of the app.
        /// </summary>
        public static StageLook FromArguments(string[] arguments, StageGrade grade)
        {
            string name = Environment.GetEnvironmentVariable("AIRI_UNITY_STAGE_LOOK");
            foreach (string argument in arguments)
            {
                if (argument.StartsWith(Argument, StringComparison.Ordinal))
                {
                    name = argument.Substring(Argument.Length);
                }
            }

            return new StageLook(name == "liltoon" ? StageLookKind.LilToon : StageLookKind.Source, grade.Surface);
        }

        /// <summary>The light of the look. The source materials keep the values that suit them.</summary>
        public float LightIntensity(float sourceIntensity)
        {
            return Kind == StageLookKind.Source ? sourceIntensity : 0.9f;
        }

        /// <summary>Replaces the materials. The caller clears <paramref name="owned"/> with the avatar.</summary>
        public void Apply(IEnumerable<Renderer> renderers, AvatarMaterialFormat format, LookMaterials owned)
        {
            if (Kind == StageLookKind.Source)
            {
                return;
            }

            foreach (Renderer renderer in renderers)
            {
                Material[] sources = renderer.sharedMaterials;
                float[] headShares = format == AvatarMaterialFormat.Mmd
                    ? MmdHeadShares(renderer, sources.Length)
                    : new float[sources.Length];
                var converted = new Material[sources.Length];
                for (int index = 0; index < sources.Length; index++)
                {
                    if (sources[index] == null)
                    {
                        continue;
                    }

                    LookMaterial source = format == AvatarMaterialFormat.Vrm
                        ? ReadVrm(sources[index])
                        : ReadMmd(sources[index], headShares[index]);
                    converted[index] = WriteLilToon(source);
                    owned.Add(format == AvatarMaterialFormat.Mmd ? sources[index] : null, converted[index], HasOutline(source));
                    Debug.Log(
                        $"[Airi] Look {Kind}: {source.Name} kind={source.Kind} alpha={source.Alpha} head={headShares[index]:F2} "
                        + $"outline={source.OutlineMeters:F5} shade={source.ShadeColor} color={source.BaseColor} sphere={(source.MatcapMap == null ? "none" : source.MatcapAdds ? "add" : "multiply")}");
                }

                renderer.sharedMaterials = converted;
            }
        }

        /// <summary>
        /// The color of an MMD surface in full light. MMD adds the ambient color to the diffuse color, so a
        /// material can take its color from either one.
        /// </summary>
        internal static Color MmdSurfaceColor(Color diffuse, Color ambient)
        {
            return new Color(
                Mathf.Clamp01((diffuse.r * MmdKeyLight) + (ambient.r * MmdAmbientLight)),
                Mathf.Clamp01((diffuse.g * MmdKeyLight) + (ambient.g * MmdAmbientLight)),
                Mathf.Clamp01((diffuse.b * MmdKeyLight) + (ambient.b * MmdAmbientLight)),
                diffuse.a);
        }

        /// <summary>Writes the color and the alpha. An alpha of 0 turns the passes off, so the hidden part casts no shadow.</summary>
        internal static void WriteColor(Material material, Color color, bool outline)
        {
            material.SetColor("_Color", color);

            bool visible = color.a > HiddenAlpha;
            foreach (string lightMode in DrawLightModes)
            {
                material.SetShaderPassEnabled(lightMode, visible);
            }

            // lilToon draws its body with this light mode too, so the pass stays on with or without an outline.
            // A material without an outline uses a shader with no outline pass.
            material.SetShaderPassEnabled(UnlitLightMode, visible);
        }

        /// <summary>
        /// Returns the share of each material slot on the head bone. The name of a material does not always
        /// tell a face: 肌, 頭部, and Mt_Body are all real names of materials with a face in them.
        /// </summary>
        private static float[] MmdHeadShares(Renderer renderer, int slots)
        {
            var shares = new float[slots];
            if (!(renderer is SkinnedMeshRenderer skinned) || skinned.sharedMesh == null || !skinned.sharedMesh.isReadable)
            {
                return shares;
            }

            Mesh mesh = skinned.sharedMesh;
            BoneWeight[] weights = mesh.boneWeights;
            if (weights.Length == 0)
            {
                return shares;
            }

            Transform[] bones = skinned.bones;
            var onHead = new bool[bones.Length];
            for (int index = 0; index < bones.Length; index++)
            {
                for (Transform bone = bones[index]; bone != null && !onHead[index]; bone = bone.parent)
                {
                    onHead[index] = bone.name == MmdHeadBone;
                }
            }

            for (int slot = 0; slot < Mathf.Min(slots, mesh.subMeshCount); slot++)
            {
                int[] indices = mesh.GetIndices(slot);
                int onHeadCount = 0;
                foreach (int vertex in indices)
                {
                    if (onHead[StrongestBone(weights[vertex])])
                    {
                        onHeadCount++;
                    }
                }

                shares[slot] = indices.Length > 0 ? (float)onHeadCount / indices.Length : 0f;
            }

            return shares;
        }

        private static int StrongestBone(in BoneWeight weight)
        {
            int bone = weight.boneIndex0;
            float strongest = weight.weight0;
            if (weight.weight1 > strongest)
            {
                bone = weight.boneIndex1;
                strongest = weight.weight1;
            }

            if (weight.weight2 > strongest)
            {
                bone = weight.boneIndex2;
                strongest = weight.weight2;
            }

            return weight.weight3 > strongest ? weight.boneIndex3 : bone;
        }

        /// <summary>
        /// A cast shadow on smooth face normals or on hair strands reads as dirt, so these parts take only
        /// the toon shade.
        /// </summary>
        private static bool ReceivesCastShadow(MaterialKind kind, float headShare)
        {
            switch (kind)
            {
                case MaterialKind.Face:
                case MaterialKind.FaceLine:
                case MaterialKind.Eye:
                case MaterialKind.Hair:
                    return false;
                case MaterialKind.Skin:
                    return headShare < SharedSkinHeadShare;
                default:
                    return true;
            }
        }

        /// <summary>
        /// A pass with a width of 0 still draws the back faces in the outline color. Authors build their own
        /// lines from inverted meshes, and this pass paints those meshes black. So these materials have no pass.
        /// </summary>
        private static bool HasOutline(in LookMaterial source)
        {
            return source.Kind != MaterialKind.Eye && source.Kind != MaterialKind.FaceLine && source.OutlineMeters > 0f;
        }

        private static LookMaterial ReadVrm(Material material)
        {
            MaterialKind kind = Classify(material.name);
            var result = new LookMaterial
            {
                Name = material.name,
                Kind = kind,
                ZWrite = material.GetInt("_TransparentWithZWrite") != 0,
                ReceivesCastShadow = ReceivesCastShadow(kind, 0f),
                Alpha = (AlphaKind)Mathf.Clamp(material.GetInt("_AlphaMode"), 0, 2),
                Cutoff = material.GetFloat("_Cutoff"),
                TwoSided = material.GetInt("_DoubleSided") != 0,
                QueueOffset = material.GetInt("_RenderQueueOffset"),
                BaseMap = material.GetTexture("_MainTex"),
                BaseScale = material.GetTextureScale("_MainTex"),
                BaseOffset = material.GetTextureOffset("_MainTex"),
                BaseColor = material.GetColor("_Color"),
                ShadeMap = material.GetTexture("_ShadeTex"),
                ShadeColor = material.GetColor("_ShadeColor"),
                NormalMap = material.IsKeywordEnabled("_NORMALMAP") ? material.GetTexture("_BumpMap") : null,
                NormalScale = material.GetFloat("_BumpScale"),
                EmissionMap = material.GetTexture("_EmissionMap"),
                EmissionColor = material.GetColor("_EmissionColor"),
                ShadingShift = material.GetFloat("_ShadingShiftFactor"),
                ShadingToony = material.GetFloat("_ShadingToonyFactor"),
                MatcapMap = material.GetTexture("_MatcapTex"),

                // MToon adds its MatCap. Its default map and color are black, so a multiply turns the model black.
                MatcapAdds = true,
                MatcapColor = material.GetColor("_MatcapColor"),
                RimColor = material.GetColor("_RimColor"),
                RimPower = material.GetFloat("_RimFresnelPower"),
                OutlineColor = material.GetColor("_OutlineColor"),
            };

            // The modes are none, world width in meters, and screen width as a part of the height.
            int outlineMode = material.GetInt("_OutlineWidthMode");
            float outlineWidth = material.GetFloat("_OutlineWidth");
            result.OutlineMeters = outlineMode == 0 ? 0f : outlineMode == 1 ? outlineWidth : outlineWidth * 0.5f;
            return result;
        }

        private static LookMaterial ReadMmd(Material material, float headShare)
        {
            float cutoff = material.GetFloat("_AlphaClipThreshold");
            bool blended = material.GetFloat("_SrcBlend") != 1f || material.renderQueue >= 2501;
            float sphereMode = material.GetFloat("_SphereMode");
            MaterialKind kind = Classify(material.name);
            if (kind == MaterialKind.Skin && headShare >= FaceHeadShare)
            {
                kind = MaterialKind.Face;
            }

            return new LookMaterial
            {
                Name = material.name,
                Kind = kind,
                Alpha = blended ? AlphaKind.Transparent : cutoff > 0f ? AlphaKind.Cutout : AlphaKind.Opaque,
                Cutoff = cutoff,
                TwoSided = material.GetFloat("_Cull") == 0f,

                // The authors of MMD models rely on the order of the materials and on depth writes.
                QueueOffset = blended ? material.renderQueue - (int)RenderQueue.Transparent : 0,
                ZWrite = material.GetFloat("_ZWrite") > 0.5f,
                ReceivesCastShadow = ReceivesCastShadow(kind, headShare),
                BaseMap = material.GetFloat("_BaseMapBound") > 0f ? material.GetTexture("_BaseMap") : null,
                BaseScale = material.GetTextureScale("_BaseMap"),
                BaseOffset = material.GetTextureOffset("_BaseMap"),
                BaseColor = MmdSurfaceColor(material.GetColor("_BaseColor"), material.GetColor("_AmbientColor")),
                ShadeColor = MmdShade(material, kind),
                NormalMap = material.GetFloat("_MmdNormalMapBound") > 0f ? material.GetTexture("_MmdNormalMap") : null,
                NormalScale = 1f,
                EmissionColor = Color.black,
                ShadingShift = kind == MaterialKind.Skin || kind == MaterialKind.Face ? -0.1f : 0f,
                ShadingToony = 0.9f,
                MatcapMap = sphereMode > 0.5f ? material.GetTexture("_SphereMap") : null,
                MatcapAdds = sphereMode >= 1.5f,
                MatcapColor = Color.white,
                RimColor = Color.black,
                RimPower = 5f,
                OutlineColor = material.GetColor("_OutlineColor"),

                // The loader stores about 5 for an edge size of 1, for its own screen space outline pass.
                // A model of this size shows that edge at about one millimeter.
                OutlineMeters = material.GetFloat("_OutlineVisible") > 0f ? Mathf.Min(material.GetFloat("_OutlineWidth") * 0.0002f, 0.002f) : 0f,
            };
        }

        /// <summary>
        /// Reads the shade from the toon ramp, at the same point as MMD Toon Lit. A white ramp means no shade
        /// in MMD. lilToon keeps a shade there, so it takes the default.
        /// </summary>
        private static Color MmdShade(Material material, MaterialKind kind)
        {
            if (material.GetFloat("_ToonMapBound") > 0.5f && material.GetTexture("_ToonMap") is Texture2D ramp && ramp.isReadable)
            {
                Color sampled = ramp.GetPixelBilinear(0.5f, 0.22f);
                if (Mathf.Min(sampled.r, sampled.g, sampled.b) < 0.95f)
                {
                    sampled.a = 1f;
                    return sampled;
                }
            }

            return DefaultShade(kind);
        }

        /// <summary>The shade of a material without a ramp.</summary>
        private static Color DefaultShade(MaterialKind kind)
        {
            switch (kind)
            {
                case MaterialKind.Skin:
                case MaterialKind.Face:
                    return new Color(0.9f, 0.74f, 0.72f);
                case MaterialKind.Hair:
                    return new Color(0.74f, 0.7f, 0.78f);
                default:
                    return new Color(0.76f, 0.75f, 0.82f);
            }
        }

        private static MaterialKind Classify(string name)
        {
            string lower = name.ToLowerInvariant();

            // Small parts borrow the words of the body: 頭リボン, 足ベルト, 手袋. The short English words only
            // count at the start of a name, because Hairclip holds "lip" and a Charm holds "arm".
            if (ContainsAny(lower, "リボン", "ribbon", "ベルト", "belt", "紐", "ひも", "ゴム", "飾り", "手袋", "グローブ", "glove", "帽子", "足環", "ウサギ", "留め", "靴", "boot", "clip"))
            {
                return MaterialKind.Cloth;
            }

            // The painted lines and shadows of the authors. They take no shade and no outline.
            if (ContainsAny(lower, "eyeline", "eyelash", "brow", "faceline", "faceparts", "shadow", "blush", "crease", "まつ", "睫", "まゆ", "眉", "まぶた", "アイライン", "目の輪郭", "歯", "舌", "口", "頬", "ほほ", "表情", "涙", "カミカゲ", "影", "はぅ")
                || StartsWithAny(lower, "lip", "nose", "mouth", "teeth", "tongue", "tear", "shita"))
            {
                return MaterialKind.FaceLine;
            }

            if (ContainsAny(lower, "eye", "iris", "瞳", "白目", "眼", "目", "ハイライト") || StartsWithAny(lower, "hl"))
            {
                return MaterialKind.Eye;
            }

            if (ContainsAny(lower, "hair", "髪", "毛", "かみ", "編み", "束"))
            {
                return MaterialKind.Hair;
            }

            if (ContainsAny(lower, "face", "顔", "頭部") || lower == "頭")
            {
                return MaterialKind.Face;
            }

            if (ContainsAny(lower, "skin", "body", "bddy", "肌", "体", "胴", "腕", "脚", "足", "太もも", "首", "手", "耳")
                || StartsWithAny(lower, "neck", "jaw", "arm", "hand", "leg"))
            {
                return MaterialKind.Skin;
            }

            return MaterialKind.Cloth;
        }

        private static bool ContainsAny(string text, params string[] parts)
        {
            foreach (string part in parts)
            {
                if (text.Contains(part))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool StartsWithAny(string text, params string[] parts)
        {
            foreach (string part in parts)
            {
                if (text.StartsWith(part, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private Material WriteLilToon(LookMaterial source)
        {
            bool outline = HasOutline(source);
            Material material = FromTemplate($"liltoon-{Name(source.Alpha)}{(outline ? string.Empty : "-noline")}", source);
            bool plainFace = source.Kind == MaterialKind.Eye || source.Kind == MaterialKind.FaceLine;

            material.SetTexture("_MainTex", source.BaseMap);
            material.SetTextureScale("_MainTex", source.BaseScale);
            material.SetTextureOffset("_MainTex", source.BaseOffset);
            WriteColor(material, source.BaseColor, outline);
            material.SetFloat("_Cutoff", source.Cutoff);
            material.SetInt("_Cull", source.TwoSided ? 0 : 2);
            material.SetInt("_ZWrite", source.Alpha != AlphaKind.Transparent || source.ZWrite ? 1 : 0);

            material.SetInt("_UseBumpMap", source.NormalMap != null ? 1 : 0);
            material.SetTexture("_BumpMap", source.NormalMap);
            material.SetFloat("_BumpScale", source.NormalScale);

            // lilToon counts the border in half Lambert. The shade of MToon starts where the shift cancels the light.
            float border = Mathf.Clamp01(0.5f - (0.5f * source.ShadingShift));
            material.SetInt("_UseShadow", plainFace ? 0 : 1);
            material.SetFloat("_ShadowStrength", 1f);
            material.SetColor("_ShadowColor", source.ShadeColor);
            if (source.ShadeMap != null && source.ShadeMap != source.BaseMap)
            {
                material.SetTexture("_ShadowColorTex", source.ShadeMap);
            }

            material.SetFloat("_ShadowBorder", border);
            material.SetFloat("_ShadowBlur", Mathf.Clamp((1f - source.ShadingToony) * 0.5f, 0.02f, 1f));

            material.SetFloat("_ShadowReceive", source.ReceivesCastShadow ? 0.5f : 0f);
            material.SetColor("_Shadow2ndColor", new Color(source.ShadeColor.r * 0.85f, source.ShadeColor.g * 0.82f, source.ShadeColor.b * 0.88f, 1f));
            material.SetFloat("_Shadow2ndBorder", Mathf.Max(0f, border - 0.22f));
            material.SetFloat("_Shadow2ndBlur", 0.12f);
            bool warmBorder = source.Kind == MaterialKind.Skin || source.Kind == MaterialKind.Face;
            material.SetColor("_ShadowBorderColor", new Color(1f, 0.35f, 0.25f, warmBorder ? 1f : 0f));

            bool emits = source.EmissionColor.maxColorComponent > 0f;
            material.SetInt("_UseEmission", emits ? 1 : 0);
            material.SetColor("_EmissionColor", source.EmissionColor);
            if (source.EmissionMap != null)
            {
                material.SetTexture("_EmissionMap", source.EmissionMap);
            }

            material.SetInt("_UseRim", source.RimColor.maxColorComponent > 0f ? 1 : 0);
            material.SetColor("_RimColor", source.RimColor);
            material.SetFloat("_RimFresnelPower", source.RimPower);

            material.SetInt("_UseMatCap", source.MatcapMap != null ? 1 : 0);
            if (source.MatcapMap != null)
            {
                material.SetTexture("_MatCapTex", source.MatcapMap);
                material.SetColor("_MatCapColor", source.MatcapColor);

                // The modes are normal, add, screen, and multiply. An MMD sphere only adds or multiplies.
                material.SetInt("_MatCapBlendMode", source.MatcapAdds ? 1 : 3);
            }

            if (outline)
            {
                // lilToon counts the width in centimeters. The outline pass reads its alpha from this texture,
                // so without it the outline also draws the parts that the base map cuts away.
                material.SetTexture("_OutlineTex", source.BaseMap);
                material.SetTextureScale("_OutlineTex", source.BaseScale);
                material.SetTextureOffset("_OutlineTex", source.BaseOffset);
                material.SetColor("_OutlineColor", source.OutlineColor);
                material.SetFloat("_OutlineWidth", source.OutlineMeters * 100f);
            }

            if (_surface != null)
            {
                WriteGrade(material, source, outline, plainFace);
            }

            return material;
        }

        /// <summary>
        /// Writes the picture of the grade over the plain conversion: a rim that feeds the bloom, colored
        /// shadows, clean faces, and thin outlines in a dark tone of the surface, not in black.
        /// </summary>
        private void WriteGrade(Material material, in LookMaterial source, bool outline, bool plainFace)
        {
            // Each strand of hair has its own edge, so a full rim on hair reads as gold wires.
            float rimShare = plainFace ? 0f : source.Kind == MaterialKind.Face ? _surface.RimOnFace : source.Kind == MaterialKind.Hair ? 0.7f : 1f;
            material.SetInt("_UseRim", rimShare > 0f ? 1 : 0);
            Color rim = _surface.RimColor * rimShare;
            rim.a = 1f;
            material.SetColor("_RimColor", rim);
            material.SetFloat("_RimBorder", _surface.RimBorder);
            material.SetFloat("_RimBlur", _surface.RimBlur);
            material.SetFloat("_RimFresnelPower", _surface.RimPower);
            material.SetFloat("_RimDirStrength", _surface.RimDirection);
            material.SetFloat("_RimEnableLighting", 0f);
            material.SetFloat("_RimShadowMask", 0f);

            material.SetFloat("_ShadowMainStrength", _surface.ShadeFromSurface);

            // A warm edge on a shade reads as blood under skin. On cloth, it reads as a red stain.
            bool warmBorder = source.Kind == MaterialKind.Skin || source.Kind == MaterialKind.Face;
            material.SetFloat("_ShadowBorderRange", warmBorder ? 0.05f : 0f);
            if (!plainFace)
            {
                material.SetColor("_ShadowColor", Deepen(source.ShadeColor, _surface.ShadeDepth));
                material.SetColor("_Shadow2ndColor", Deepen(material.GetColor("_Shadow2ndColor"), _surface.ShadeDepth));
                material.SetFloat("_ShadowBorder", _surface.ShadeBorder);
                material.SetFloat("_Shadow2ndBorder", Mathf.Max(0f, _surface.ShadeBorder - 0.2f));
            }

            if (source.ReceivesCastShadow)
            {
                material.SetFloat("_ShadowReceive", _surface.CastShadow);
            }

            if (source.Kind == MaterialKind.Face)
            {
                // The mesh of a face has a real nose and real lips. A side light on them breaks the drawn face.
                material.SetFloat("_ShadowBorder", _surface.FaceShadeBorder);
                material.SetFloat("_ShadowBlur", 0.08f);
                material.SetFloat("_ShadowStrength", 0.7f);

                // A second shade on a face draws a dark band along the jaw.
                Color second = material.GetColor("_Shadow2ndColor");
                second.a = 0f;
                material.SetColor("_Shadow2ndColor", second);
            }

            if (outline)
            {
                float width = Mathf.Clamp(source.OutlineMeters * 100f, _surface.OutlineMinCentimeters, _surface.OutlineMaxCentimeters);
                material.SetFloat("_OutlineWidth", width);
                material.SetVector("_OutlineTexHSVG", new Vector4(0f, _surface.OutlineSaturation, _surface.OutlineValue, 1f));
                if (source.BaseMap != null)
                {
                    material.SetColor("_OutlineColor", Color.white);
                }
                else
                {
                    Color line = source.BaseColor * _surface.OutlineValue;
                    line.a = 1f;
                    material.SetColor("_OutlineColor", line);
                }
            }

            if (source.Kind == MaterialKind.Eye && source.EmissionColor.maxColorComponent <= 0f)
            {
                material.SetInt("_UseEmission", 1);
                material.SetTexture("_EmissionMap", source.BaseMap);
                Color glow = Color.white * _surface.EyeGlow;
                glow.a = 1f;
                material.SetColor("_EmissionColor", glow);
            }
        }

        private static Color Deepen(Color shade, float depth)
        {
            return new Color(shade.r * depth, shade.g * depth, shade.b * depth, shade.a);
        }

        private static string Name(AlphaKind alpha)
        {
            switch (alpha)
            {
                case AlphaKind.Cutout:
                    return "cutout";
                case AlphaKind.Transparent:
                    return "transparent";
                default:
                    return "opaque";
            }
        }

        private static Material FromTemplate(string template, LookMaterial source)
        {
            var found = Resources.Load<Material>($"AiriLooks/{template}");
            if (found == null)
            {
                throw new InvalidOperationException($"The build has no material template {template}.");
            }

            var material = new Material(found) { name = source.Name };
            if (source.QueueOffset != 0)
            {
                material.renderQueue = found.renderQueue + source.QueueOffset;
            }

            return material;
        }

        private struct LookMaterial
        {
            public string Name;
            public MaterialKind Kind;
            public AlphaKind Alpha;
            public float Cutoff;
            public bool TwoSided;
            public int QueueOffset;
            public bool ZWrite;
            public bool ReceivesCastShadow;
            public Texture BaseMap;
            public Vector2 BaseScale;
            public Vector2 BaseOffset;
            public Color BaseColor;
            public Texture ShadeMap;
            public Color ShadeColor;
            public Texture NormalMap;
            public float NormalScale;
            public Texture EmissionMap;
            public Color EmissionColor;
            public float ShadingShift;
            public float ShadingToony;
            public Texture MatcapMap;
            public bool MatcapAdds;
            public Color MatcapColor;
            public Color RimColor;
            public float RimPower;
            public Color OutlineColor;
            public float OutlineMeters;
        }
    }
}
