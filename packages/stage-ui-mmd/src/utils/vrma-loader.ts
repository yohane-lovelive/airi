import type { VRMAnimation } from '@pixiv/three-vrm-animation'

import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * Loads the first VRM Animation of a `.vrma` file, for example the AIRI idle loop.
 *
 * Use it with `retargetVRMAnimationToMMD` to play a VRM motion on an MMD model.
 */
export async function loadVRMAnimationFile(url: string): Promise<VRMAnimation | undefined> {
  const loader = new GLTFLoader()
  loader.register(parser => new VRMAnimationLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined
  return animations?.[0]
}
