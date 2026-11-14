# Vendored Packages

`Packages/com.yohawing.mmd-loader` is a copy of [unity-mmd-loader](https://github.com/yohawing/unity-mmd-loader) v0.5.1 (MIT). The copy has `Runtime`, `Editor`, `package.json`, `CHANGELOG.md`, and `LICENSE`. It does not have `Tests`, `Samples~`, or `Documentation~`.

The package is a copy because version 0.5.1 cannot run in a Windows player of Unity 6000.3 without the patches below. A UPM package from Git cannot have patches.

## Patches

Each code patch has a comment that starts with `AIRI patch`.

| File | Change | Cause |
| --- | --- | --- |
| `Runtime/Animation/Humanoid/MmdHumanoidProxyRigFactory.cs` | The guard of `rootMotionBoneName` is `UNITY_6000_4_OR_NEWER`, not `UNITY_6000_1_OR_NEWER`. | Unity 6000.3 does not have this property, so the package does not compile. |
| `Runtime/Plugins/x86_64/mmd_runtime_ffi.dll.meta` | The platform is `Standalone: Win64`, not `Standalone: Windows64`. | Unity does not know the old name, so a player build does not include the DLL. |
| `Runtime/Import/MmdRuntimeTextureResolver.cs` | A PNG file that the decoder of the package refuses goes to `Texture2D.LoadImage`. | The decoder reads only 8-bit files with no interlace. A 16-bit face texture stayed white. |

## Added File

`Runtime/Components/Playback/AiriMmdHostPose.cs` is not a part of the package. It gives the pose of AIRI and the morph weights to the native session, so physics follow the character. It stays in the assembly of the package, because this path of the loader is internal:

- `MmdUnityPlaybackBinding.TryEnableNativeHumanoidHostPose`
- `MmdUnityPlaybackBinding.StepLivePhysicsFromHostPose`
- `MmdUnityPlaybackController.BuildHumanoidHostPoseRigSelection`
- `MmdUnityFrameApplier.ApplyMorphs`

A new version can change these members without notice.

## Update the Package

1. Read the release notes of the new version.
2. Replace the folder with the files of the new version.
3. Copy `AiriMmdHostPose.cs` and its `.meta` file back, and fix it for the internal API of the new version.
4. Apply each patch that the new version still needs, and update this table.
5. Run the test with a real player. The `README.md` of this engine gives the command.

## Commit an Update

An update changes hundreds of files. `nano-staged` gives all staged paths to one command, and the command line of Windows has a limit. So a commit with all these files stops in the pre-commit hook, with the error `Spread syntax requires ...iterable[Symbol.iterator] to be a function`.

Commit the package alone, with `git commit --no-verify`. The hook checks no file of this package, because `eslint.config.ts` ignores the folder and the folder has no JavaScript or TypeScript. Commit all other files in a second commit, with the hook.

## Report to Upstream

The three patches are faults of the package, so a report to the project can remove them. Nobody has reported them yet.
