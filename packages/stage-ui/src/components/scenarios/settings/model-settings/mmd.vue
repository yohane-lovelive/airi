<script setup lang="ts">
import type { MMDGazeMode, MMDGraphicsAdjustments, MMDSurfaceKind, MMDSurfaceOverride, MMDSurfaceValues, MorphSlot } from '@proj-airi/stage-ui-mmd'

import type { ModelSettingsRuntimeSnapshot } from './runtime'

import { applyMMDSurfaceOverride, controlConfig, DEFAULT_IDLE_MOTION, MMD_SURFACE_KINDS, useMMD } from '@proj-airi/stage-ui-mmd'
import { Button, FieldCheckbox, FieldCombobox, FieldRange, GhostButton } from '@proj-airi/ui'
import { useFileDialog } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSettings } from '../../../../stores/settings'
import { Container, PropertyColor, PropertyNumber } from '../../../data-pane'
import { Section } from '../../../layouts'
import { ColorPalette } from '../../../widgets'

const props = withDefaults(defineProps<{
  palette: string[]
  allowExtractColors?: boolean
  runtimeSnapshot: ModelSettingsRuntimeSnapshot
}>(), {
  allowExtractColors: true,
})

defineEmits<{
  (e: 'extractColorsFromModel'): void
}>()

const { t } = useI18n()

const mmdStore = useMMD()
const {
  scale,
  position,
  rotationY,
  physicsEnabled,
  ikEnabled,
  grantEnabled,
  physicsGravity,
  gazeMode,
  idleMotionName,
  availableMotions,
  availableMorphs,
  availableMaterials,
  materialOpacity,
  morphOverrides,
  cameraFov,
  ambientColor,
  ambientIntensity,
  directionalColor,
  directionalIntensity,
  directionalPosition,
  albedoGlow,
  renderScale,
  graphicsQuality,
  graphicsAdjustments,
  renderMode,
  materialSurfaces,
} = storeToRefs(mmdStore)
const { stageModelSelected } = storeToRefs(useSettings())

const graphicsQualityOptions = computed(() => (['off', 'low', 'medium', 'high'] as const).map(value => ({
  label: t(`settings.mmd.graphics.quality-options.${value}`),
  value,
})))
const toneMappingOptions = computed(() => (['neutral', 'agx', 'aces'] as const).map(value => ({
  label: t(`settings.mmd.graphics.tone-mapping-options.${value}`),
  value,
})))

function handleGraphicsQuality(value: string | number | undefined) {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high')
    graphicsQuality.value = value
}

/** Replaces one adjustment, so the stored object changes as a whole and every window reads the change. */
function setGraphicsAdjustment<K extends keyof MMDGraphicsAdjustments>(key: K, value: MMDGraphicsAdjustments[K]) {
  graphicsAdjustments.value = { ...graphicsAdjustments.value, [key]: value }
}

function handleToneMapping(value: string | number | undefined) {
  if (value === 'neutral' || value === 'agx' || value === 'aces')
    setGraphicsAdjustment('toneMapping', value)
}

const renderModeOptions = computed(() => (['toon', 'hybrid', 'pbr'] as const).map(value => ({
  label: t(`settings.mmd.graphics.render-mode-options.${value}`),
  value,
})))

function handleRenderMode(value: string | number | undefined) {
  if (value === 'toon' || value === 'hybrid' || value === 'pbr')
    renderMode.value = value
}

// === Material surfaces (hybrid and PBR) ===
// The combobox does not show an item with an empty value, so the guessed kind needs its own value.
const AUTO_KIND = 'auto'

// The changes are keyed by material index, because one name can cover the face skin and the clothes. The combobox
// values are strings, so the index travels as a string.
const selectedSurfaceIndex = ref<string>()
const selectedSurfaceMaterial = computed(() => availableMaterials.value.find(material => String(material.index) === selectedSurfaceIndex.value)
  ?? availableMaterials.value[0])
const surfaceMaterialOptions = computed(() => availableMaterials.value.map(material => ({
  label: `${material.index}. ${material.label} (${t(`settings.mmd.surfaces.kinds.${material.kind}`)})`,
  value: String(material.index),
})))

/** The changes of the model on the stage. Each model keeps its own, because the indexes differ between models. */
const modelSurfaceOverrides = computed(() => materialSurfaces.value[stageModelSelected.value] ?? {})
const selectedSurfaceOverride = computed(() => modelSurfaceOverrides.value[selectedSurfaceMaterial.value?.index ?? -1] ?? {})
const selectedSurface = computed(() => selectedSurfaceMaterial.value
  ? applyMMDSurfaceOverride(selectedSurfaceMaterial.value.kind, selectedSurfaceOverride.value)
  : undefined)
const surfaceKindOptions = computed(() => [
  {
    label: t('settings.mmd.surfaces.kind-auto', { kind: t(`settings.mmd.surfaces.kinds.${selectedSurfaceMaterial.value?.kind ?? 'other'}`) }),
    value: AUTO_KIND,
  },
  ...MMD_SURFACE_KINDS.map(kind => ({ label: t(`settings.mmd.surfaces.kinds.${kind}`), value: kind })),
])

function handleSurfaceMaterial(value: string | number | undefined) {
  if (typeof value === 'string')
    selectedSurfaceIndex.value = value
}

/** Replaces the changes of the selected material. An empty change removes its entry. */
function writeSurfaceOverride(override: MMDSurfaceOverride) {
  const material = selectedSurfaceMaterial.value
  if (!material)
    return
  const overrides = { ...modelSurfaceOverrides.value }
  if (Object.keys(override).length === 0)
    delete overrides[material.index]
  else
    overrides[material.index] = override

  const models = { ...materialSurfaces.value, [stageModelSelected.value]: overrides }
  if (Object.keys(overrides).length === 0)
    delete models[stageModelSelected.value]
  materialSurfaces.value = models
}

function handleSurfaceKind(value: string | number | undefined) {
  const { kind: _kind, ...values } = selectedSurfaceOverride.value
  if (value === AUTO_KIND)
    writeSurfaceOverride(values)
  else if (MMD_SURFACE_KINDS.includes(value as MMDSurfaceKind))
    writeSurfaceOverride({ ...values, kind: value as MMDSurfaceKind })
}

function setSurfaceValue(key: keyof MMDSurfaceValues, value: number) {
  writeSurfaceOverride({ ...selectedSurfaceOverride.value, [key]: value })
}

const canExtractColors = computed(() => props.runtimeSnapshot.canCapturePreview)

// VRM-style eye-tracking buttons placed in the scene grid (cols 3–5).
const trackingOptions = computed<{ value: MMDGazeMode, label: string, class: string }[]>(() => [
  { value: 'camera', label: t('settings.mmd.gaze.options.camera'), class: 'col-start-3' },
  { value: 'mouse', label: t('settings.mmd.gaze.options.cursor'), class: 'col-start-4' },
  { value: 'none', label: t('settings.mmd.gaze.options.none'), class: 'col-start-5' },
])

// The setting stores an empty name for the AIRI default idle. The option needs its own value, because the combobox
// does not show an item with an empty value.
const idleMotionChoice = computed(() => idleMotionName.value || DEFAULT_IDLE_MOTION)
const motionOptions = computed(() => [
  { label: t('settings.mmd.animation.default-idle'), value: DEFAULT_IDLE_MOTION, description: '' },
  ...availableMotions.value.map(motion => ({
    label: motion.name,
    value: motion.name,
    description: '',
  })),
])

// '(auto)' lets the renderer pick the morph by its standard-name candidates.
const morphOptions = computed(() => [
  { label: t('settings.mmd.morphs.auto'), value: '', description: '' },
  ...availableMorphs.value.map(name => ({ label: name, value: name, description: '' })),
])

/** Logical morph slots exposed for manual remapping, grouped by purpose. */
const MORPH_SLOTS: { slot: MorphSlot, label: string }[] = [
  { slot: 'vowelA', label: 'Mouth あ (A)' },
  { slot: 'vowelI', label: 'Mouth い (I)' },
  { slot: 'vowelU', label: 'Mouth う (U)' },
  { slot: 'vowelE', label: 'Mouth え (E)' },
  { slot: 'vowelO', label: 'Mouth お (O)' },
  { slot: 'blink', label: 'Blink' },
  { slot: 'blinkLeft', label: 'Wink (L)' },
  { slot: 'blinkRight', label: 'Wink (R)' },
  { slot: 'smile', label: 'Smile' },
  { slot: 'anger', label: 'Anger' },
  { slot: 'sad', label: 'Sad' },
  { slot: 'surprise', label: 'Surprise' },
  { slot: 'troubled', label: 'Troubled' },
  { slot: 'serious', label: 'Serious' },
]

function handleIdleMotionSelect(name: string | number | undefined) {
  if (typeof name !== 'string')
    return
  idleMotionName.value = name === DEFAULT_IDLE_MOTION ? '' : name
}

function setMorphOverride(slot: MorphSlot, value: string | number | undefined) {
  if (typeof value !== 'string')
    return
  morphOverrides.value = { ...morphOverrides.value, [slot]: value }
}

function setMaterialOpacity(name: string, value: number) {
  materialOpacity.value = { ...materialOpacity.value, [name]: value }
}

const vmdDialog = useFileDialog({ accept: '.vmd', multiple: true, reset: true })
vmdDialog.onChange(async (files) => {
  if (!files)
    return
  // The AIRI default idle plays until the owner chooses an imported motion as the idle.
  for (const file of Array.from(files))
    await mmdStore.addMotion(file)
})

function playMotionOnce(name: string) {
  mmdStore.playOneShotAction(name, false)
}

function removeMotion(id: string) {
  void mmdStore.removeMotion(id)
}
</script>

<template>
  <Container
    :title="t('settings.pages.models.sections.section.scene')"
    icon="i-solar:people-nearby-bold-duotone"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
  >
    <template v-if="allowExtractColors">
      <ColorPalette class="mb-4 mt-2" :colors="palette.map(hex => ({ hex, name: hex }))" mx-auto />
      <Button :disabled="!canExtractColors" @click="$emit('extractColorsFromModel')">
        {{ t('settings.mmd.theme-color-from-model.button-extract.title') }}
      </Button>
    </template>

    <div grid="~ cols-5 gap-1" p-2>
      <PropertyNumber
        v-model="scale"
        :config="{ min: controlConfig.scale.min, max: controlConfig.scale.max, step: controlConfig.scale.step, label: 'Scale', formatValue: val => val?.toFixed(2) }"
        :label="t('settings.mmd.scale-and-position.scale')"
      />
      <PropertyNumber
        v-model="position.x"
        :config="{ min: controlConfig.x.min, max: controlConfig.x.max, step: controlConfig.x.step, label: 'X', formatValue: val => val?.toFixed(2) }"
        :label="t('settings.mmd.scale-and-position.x')"
      />
      <PropertyNumber
        v-model="position.y"
        :config="{ min: controlConfig.y.min, max: controlConfig.y.max, step: controlConfig.y.step, label: 'Y', formatValue: val => val?.toFixed(2) }"
        :label="t('settings.mmd.scale-and-position.y')"
      />
      <PropertyNumber
        v-model="cameraFov"
        :config="{ min: 10, max: 120, step: 1, label: 'FOV' }"
        label="Camera FOV"
      />
      <PropertyNumber
        v-model="rotationY"
        :config="{ min: controlConfig.rotationY.min, max: controlConfig.rotationY.max, step: controlConfig.rotationY.step, label: 'Rotation', formatValue: val => val?.toFixed(2) }"
        :label="t('settings.mmd.scale-and-position.rotation')"
      />

      <!-- Eye tracking mode -->
      <div class="text-xs">
        {{ t('settings.mmd.gaze.tracking') }}:
      </div>
      <div />
      <template v-for="option in trackingOptions" :key="option.value">
        <GhostButton
          :class="[option.class, 'w-auto']"
          size="sm"
          :active="gazeMode === option.value"
          :label="option.label"
          @click="gazeMode = option.value"
        />
      </template>

      <PropertyNumber
        v-model="directionalPosition.x"
        :config="{ min: -10, max: 10, step: 0.1, label: 'X' }"
        label="Directional Light - X"
      />
      <PropertyNumber
        v-model="directionalPosition.y"
        :config="{ min: -10, max: 10, step: 0.1, label: 'Y' }"
        label="Directional Light - Y"
      />
      <PropertyNumber
        v-model="directionalPosition.z"
        :config="{ min: -10, max: 10, step: 0.1, label: 'Z' }"
        label="Directional Light - Z"
      />
      <PropertyColor
        v-model="directionalColor"
        label="Directional Light Color"
      />
      <PropertyNumber
        v-model="directionalIntensity"
        :config="{ min: 0, max: 3, step: 0.01, label: 'Intensity' }"
        label="Directional Light Intensity"
      />

      <PropertyNumber
        v-model="ambientIntensity"
        :config="{ min: 0, max: 3, step: 0.01, label: 'Intensity' }"
        label="Ambient Light Intensity"
      />
      <PropertyColor
        v-model="ambientColor"
        label="Ambient Light Color"
      />

      <PropertyNumber
        v-model="albedoGlow"
        :config="{ min: 0, max: 1, step: 0.01, label: 'Glow', formatValue: val => val?.toFixed(2) }"
        label="Albedo Glow"
      />
      <PropertyNumber
        v-model="renderScale"
        :config="{ min: 0.5, max: 2, step: 0.1, label: 'Scale' }"
        label="Render Scale"
      />
    </div>
  </Container>

  <Section
    :title="t('settings.mmd.graphics.title')"
    icon="i-solar:magic-stick-3-bold-duotone"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <p :class="['mb-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
      {{ t('settings.mmd.graphics.description') }}
    </p>
    <FieldCombobox
      :model-value="graphicsQuality"
      :options="graphicsQualityOptions"
      :label="t('settings.mmd.graphics.quality')"
      @update:model-value="handleGraphicsQuality"
    />
    <FieldCombobox
      :model-value="renderMode"
      :options="renderModeOptions"
      :label="t('settings.mmd.graphics.render-mode')"
      @update:model-value="handleRenderMode"
    />
    <template v-if="renderMode !== 'toon'">
      <FieldRange
        :model-value="graphicsAdjustments.environmentIntensity"
        as="div" :min="0" :max="3" :step="0.05" :default-value="1"
        :label="t('settings.mmd.graphics.environment-intensity')"
        @update:model-value="value => setGraphicsAdjustment('environmentIntensity', value)"
      />
      <FieldRange
        :model-value="graphicsAdjustments.rimIntensity"
        as="div" :min="0" :max="1" :step="0.01" :default-value="0.3"
        :label="t('settings.mmd.graphics.rim-intensity')"
        @update:model-value="value => setGraphicsAdjustment('rimIntensity', value)"
      />
      <FieldCheckbox
        :model-value="graphicsAdjustments.shadows"
        :label="t('settings.mmd.graphics.shadows')"
        @update:model-value="value => setGraphicsAdjustment('shadows', value)"
      />
      <FieldRange
        v-if="graphicsQuality === 'high'"
        :model-value="graphicsAdjustments.ambientOcclusion"
        as="div" :min="0" :max="1" :step="0.01" :default-value="0.6"
        :label="t('settings.mmd.graphics.ambient-occlusion')"
        @update:model-value="value => setGraphicsAdjustment('ambientOcclusion', value)"
      />
    </template>
    <template v-if="graphicsQuality !== 'off'">
      <FieldCombobox
        :model-value="graphicsAdjustments.toneMapping"
        :options="toneMappingOptions"
        :label="t('settings.mmd.graphics.tone-mapping')"
        @update:model-value="handleToneMapping"
      />
      <FieldRange
        :model-value="graphicsAdjustments.exposure"
        as="div" :min="0.5" :max="2" :step="0.05" :default-value="1"
        :label="t('settings.mmd.graphics.exposure')"
        @update:model-value="value => setGraphicsAdjustment('exposure', value)"
      />
      <FieldRange
        :model-value="graphicsAdjustments.bloomIntensity"
        as="div" :min="0" :max="3" :step="0.05" :default-value="0.6"
        :label="t('settings.mmd.graphics.bloom-intensity')"
        @update:model-value="value => setGraphicsAdjustment('bloomIntensity', value)"
      />
      <FieldRange
        :model-value="graphicsAdjustments.bloomThreshold"
        as="div" :min="0" :max="1" :step="0.01" :default-value="0.8"
        :label="t('settings.mmd.graphics.bloom-threshold')"
        @update:model-value="value => setGraphicsAdjustment('bloomThreshold', value)"
      />
      <template v-if="graphicsQuality !== 'low'">
        <FieldRange
          :model-value="graphicsAdjustments.saturation"
          as="div" :min="-1" :max="1" :step="0.01" :default-value="0"
          :label="t('settings.mmd.graphics.saturation')"
          @update:model-value="value => setGraphicsAdjustment('saturation', value)"
        />
        <FieldRange
          :model-value="graphicsAdjustments.contrast"
          as="div" :min="-1" :max="1" :step="0.01" :default-value="0"
          :label="t('settings.mmd.graphics.contrast')"
          @update:model-value="value => setGraphicsAdjustment('contrast', value)"
        />
        <FieldRange
          :model-value="graphicsAdjustments.vignette"
          as="div" :min="0" :max="1" :step="0.01" :default-value="0.3"
          :label="t('settings.mmd.graphics.vignette')"
          @update:model-value="value => setGraphicsAdjustment('vignette', value)"
        />
        <FieldRange
          :model-value="graphicsAdjustments.depthOfField"
          as="div" :min="0" :max="1" :step="0.01" :default-value="0.5"
          :label="t('settings.mmd.graphics.depth-of-field')"
          @update:model-value="value => setGraphicsAdjustment('depthOfField', value)"
        />
        <FieldRange
          :model-value="graphicsAdjustments.chromaticAberration"
          as="div" :min="0" :max="1" :step="0.01" :default-value="0.2"
          :label="t('settings.mmd.graphics.chromatic-aberration')"
          @update:model-value="value => setGraphicsAdjustment('chromaticAberration', value)"
        />
      </template>
    </template>
  </Section>

  <Section
    v-if="renderMode !== 'toon'"
    :title="t('settings.mmd.surfaces.title')"
    icon="i-solar:pallete-2-bold-duotone"
    inner-class="text-sm"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <p :class="['mb-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
      {{ t('settings.mmd.surfaces.description') }}
    </p>
    <template v-if="selectedSurfaceMaterial && selectedSurface">
      <FieldCombobox
        :model-value="String(selectedSurfaceMaterial.index)"
        :options="surfaceMaterialOptions"
        :label="t('settings.mmd.surfaces.material')"
        @update:model-value="handleSurfaceMaterial"
      />
      <FieldCombobox
        :model-value="selectedSurfaceOverride.kind ?? AUTO_KIND"
        :options="surfaceKindOptions"
        :label="t('settings.mmd.surfaces.kind')"
        @update:model-value="handleSurfaceKind"
      />
      <template v-if="renderMode === 'pbr' || (selectedSurface.kind !== 'face' && selectedSurface.kind !== 'eye')">
        <FieldRange
          v-for="key in (['roughness', 'metalness', 'sheen', 'clearcoat'] as const)"
          :key="key"
          :model-value="selectedSurface[key]"
          as="div" :min="0" :max="1" :step="0.01"
          :label="t(`settings.mmd.surfaces.${key}`)"
          @update:model-value="value => setSurfaceValue(key, value)"
        />
      </template>
      <p v-else :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
        {{ t('settings.mmd.surfaces.stays-toon') }}
      </p>
      <Button
        :class="['mt-2']"
        :disabled="Object.keys(selectedSurfaceOverride).length === 0"
        @click="writeSurfaceOverride({})"
      >
        {{ t('settings.mmd.surfaces.reset') }}
      </Button>
    </template>
    <p v-else :class="['text-xs', 'text-amber-600', 'dark:text-amber-400']">
      {{ t('settings.mmd.materials.no-materials') }}
    </p>
  </Section>

  <Section
    :title="t('settings.mmd.physics.title')"
    icon="i-solar:atom-bold-duotone"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <FieldCheckbox v-model="physicsEnabled" :label="t('settings.mmd.physics.enabled')" />
    <FieldCheckbox v-model="ikEnabled" :label="t('settings.mmd.physics.ik')" />
    <FieldCheckbox v-model="grantEnabled" :label="t('settings.mmd.physics.grant')" />
    <FieldRange
      v-model="physicsGravity"
      as="div"
      :min="0"
      :max="200"
      :step="1"
      :default-value="98"
      :label="t('settings.mmd.physics.gravity')"
    />
  </Section>

  <Section
    :title="t('settings.mmd.animation.title')"
    icon="i-solar:play-bold-duotone"
    inner-class="text-sm"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <p :class="['mb-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
      {{ t('settings.mmd.animation.description') }}
    </p>
    <Button :class="['mb-2']" @click="vmdDialog.open()">
      {{ t('settings.mmd.animation.import-motion') }}
    </Button>
    <FieldCombobox
      :model-value="idleMotionChoice"
      :options="motionOptions"
      :label="t('settings.mmd.animation.idle-motion')"
      @update:model-value="handleIdleMotionSelect"
    />
    <div v-if="availableMotions.length > 0" :class="['mt-2', 'flex', 'flex-col', 'gap-1']">
      <div
        v-for="motion in availableMotions"
        :key="motion.name"
        :class="['flex', 'items-center', 'justify-between', 'gap-2']"
      >
        <div :class="['truncate', 'text-sm']">
          {{ motion.name }}
        </div>
        <div :class="['flex', 'shrink-0', 'items-center', 'gap-1']">
          <Button @click="playMotionOnce(motion.name)">
            {{ t('settings.mmd.animation.play-once') }}
          </Button>
          <Button

            :aria-label="t('settings.mmd.animation.remove')"
            @click="removeMotion(motion.id)"
          >
            <div i-solar:trash-bin-minimalistic-bold-duotone />
          </Button>
        </div>
      </div>
    </div>
  </Section>

  <Section
    :title="t('settings.mmd.morphs.title')"
    icon="i-solar:emoji-funny-square-bold-duotone"
    inner-class="text-sm"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <p :class="['mb-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
      {{ t('settings.mmd.morphs.description') }}
    </p>
    <template v-if="availableMorphs.length > 0">
      <FieldCombobox
        v-for="entry in MORPH_SLOTS"
        :key="entry.slot"
        :model-value="morphOverrides[entry.slot] ?? ''"
        :options="morphOptions"
        :label="entry.label"
        @update:model-value="value => setMorphOverride(entry.slot, value)"
      >
        <template #label>
          <span>{{ entry.label }}</span>
          <button
            v-if="morphOverrides[entry.slot]"
            type="button"
            :title="t('settings.mmd.morphs.revert')"
            :aria-label="t('settings.mmd.morphs.revert')"
            :class="['ml-1', 'inline-flex', 'items-center']"
            @click.stop.prevent="setMorphOverride(entry.slot, '')"
          >
            <div :class="['i-solar:forward-linear', 'transform-scale-x--100', 'text-neutral-500', 'dark:text-neutral-400']" />
          </button>
        </template>
      </FieldCombobox>
    </template>
    <p v-else :class="['text-xs', 'text-amber-600', 'dark:text-amber-400']">
      {{ t('settings.mmd.morphs.no-morphs') }}
    </p>
  </Section>

  <Section
    :title="t('settings.mmd.materials.title')"
    icon="i-solar:layers-bold-duotone"
    inner-class="text-sm"
    :class="['rounded-xl', 'bg-white/80 dark:bg-black/75', 'backdrop-blur-lg']"
    size="sm"
    :expand="false"
  >
    <p :class="['mb-2', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
      {{ t('settings.mmd.materials.description') }}
    </p>
    <template v-if="availableMaterials.length > 0">
      <FieldRange
        v-for="material in availableMaterials"
        :key="material.index"
        as="div"
        :min="0"
        :max="1"
        :step="0.01"
        :default-value="1"
        :model-value="materialOpacity[material.name] ?? 1"
        :label="material.label"
        @update:model-value="value => setMaterialOpacity(material.name, value)"
      />
    </template>
    <p v-else :class="['text-xs', 'text-amber-600', 'dark:text-amber-400']">
      {{ t('settings.mmd.materials.no-materials') }}
    </p>
  </Section>
</template>
