# Unity ステージのサイドカー

Status: accepted

英語版: [2026-11-06-unity-stage-sidecar.md](2026-11-06-unity-stage-sidecar.md)

## 背景

オーナーは AIRI のキャラクターを Sony の空間再現ディスプレイ ELF-MN1 に 3D で表示したいと考えている。このディスプレイ向けには Unity プラグインが提供される。エージェント、音声、記憶のコードは Electron アプリに残す。アプリ全体を Unity に移すと、これらのコードを捨てることになる。

### 前例

`engines/stage-tamagotchi-godot` は表示専用のサイドカーである。`apps/stage-tamagotchi/src/main/services/airi/godot-stage/index.ts` がプロセスを起動してローカル WebSocket を開き、サイドカーがトークン付きで接続し返す。

Godot の経路が運ぶのはモデルとカメラだけである。`Stage.vue` は `godot` レンダラーでは文字のパネルを出すだけで、キャラクターの信号はそこで止まる。

- 感情のキューに `godot` の分岐がない。
- `ACT` マーカーがジェスチャーを再生するのは `vrm` と `mmd` だけである。
- 口、発話レベル、手続き的な動きは three.js と MMD のコンポーネントの中にある。

したがって、この ADR ではこれらの信号の経路を新しく定義する必要がある。この部分は Godot から流用できない。

### Sony の記載

以下は 2026-11-06 に Sony の開発者向けページで確認した内容である。

| 項目 | ELF-MN1 | ELF-SR1 / ELF-SR2 |
| --- | --- | --- |
| プラグイン | "Coming soon"。発売は 2026-12-11。 | v2.6.0 |
| Unity バージョン | 記載なし | 2022.3、Unity 6、Unity 6.3 |
| レンダーパイプライン | URP を推奨 | BRP、URP、HDRP |
| Windows ビルド | Intel 64-bit。ビルドした `.exe` がディスプレイに表示する。 | Intel 64-bit、Mono のみ |
| Android ビルド | ARM64、IL2CPP | なし |
| 中心の Prefab | `PortraitSRDisplayManager` | `SRDisplayManager` |

Prefab について、設計に影響する事実は次のとおりである。

- Prefab は `LeftEyeCamera` と `RightEyeCamera` を持ち、`MainCamera` を持たない。したがって、シーンはカメラが 1 台だと仮定できず、カメラ設定もこのディスプレイには適用されない。
- シーンに置ける Manager は 1 つだけである。
- スケールは `SRD View Space Scale` で設定する。Manager 自身の GameObject のスケールは実行時に上書きされる。
- 実際のビュースペースは「最大 0.4x0.2x0.2m」である。縦長のディスプレイでどの軸が垂直かは記載がない。
- Sony は物体をビュースペース内に収めるよう求めている。はみ出す物体には Spatial Clipping を使う。
- フォーカスなしで動作できるか、全画面が必須かは記載がない。

### この PC の状態

Unity Hub も Unity Editor も入っていない。.NET SDK 10.0.401 は入っている。ELF-MN1 の実機は発売日まで手に入らない。

## 決定

### Electron が頭脳のまま、Unity は描画だけを担当する

Unity にチャット、音声、記憶、設定のロジックは持たせない。音声は Electron が再生するので、Unity は音声に触れない。

対象は Windows の `apps/stage-tamagotchi` である。ELF-MN1 のスマートフォン経路は対象外とする。頭脳が PC で動くためである。

機能は既定でオフとし、Godot Stage と同じく実験的な扱いにする。

### エンジンとプロジェクト設定

- プロジェクトは Godot の隣の `engines/stage-tamagotchi-unity` に置く。
- Editor は Unity 6.3 LTS とする。Sony の一覧にある最新版である。`unity-mmd-loader` は 6000.0 以降、UniVRM は 2022.3 以降を要求する。
- レンダーパイプラインは URP、バックエンドは Mono、アーキテクチャは Intel 64-bit とする。
- Active Input Handling は `Both` とする。ELF-SR1 / SR2 で Sony が旧 Input Manager か `Both` を要求しているためである。
- `Application.runInBackground` は `true` とする。オーナーは Electron のウィンドウを操作しながらキャラクターを動かすためである。

ELF-MN1 のプラグインが別の Unity バージョンを必要とする場合は、プロジェクトをそのバージョンに変更する。これは設定の変更であり、設計は変わらない。

### プロジェクト構成

```text
engines/stage-tamagotchi-unity/
  package.json                 # scripts: typecheck, test
  README.md
  Assets/Airi/Core/            # UnityEngine を参照しない（noEngineReferences）
  Assets/Airi/Stage/           # MonoBehaviour、UniVRM の利用
  Assets/Airi/SrDisplay/       # Sony プラグインがあるときだけコンパイルする
  Packages/manifest.json
  ProjectSettings/
  tests/                       # Assets/Airi/Core をコンパイルする dotnet のテストホスト
```

`Core` にはプロトコルのパーサー、WebSocket クライアントのループ、座標変換を置く。保持とフェードの規則はステップ U3 で追加する。`Core` は Unity を参照しないので、Unity のライセンスがなくてもどの PC でも CI でも `dotnet` でテストできる。Godot エンジンの検証ホストと同じ方式である。

`Core` の JSON にはオーナーの選択で Newtonsoft.Json を使う。Unity に公式パッケージがあり、`dotnet` では同じライブラリを NuGet から得られる。別のプロジェクトが `Core` を C# 9 と .NET Standard 2.1 でコンパイルするので、Unity の外のビルドでも同じ言語の制限で失敗する。

Sony のプラグインパッケージ、モデルファイル、Unity のビルド出力は Git に入れない。

### プロセスの起動

| モード | 用途 | 起動方法 |
| --- | --- | --- |
| Player | 通常の利用 | Electron main がビルド済みの `.exe` を `--airi-ws-url=<url>` 付きで起動する。開発時のパスは `AIRI_UNITY_STAGE_EXECUTABLE` で渡す。 |
| Attach | Editor での作業 | Electron main はプロセスを起動しない。URL とトークンを `<userData>/unity-stage/attach.json` に書き、Editor の Play モードがこれを読んで接続する。 |

Godot はプロジェクトパスを指定して Editor を起動できるが、Unity Editor はこの用途には起動が遅すぎる。また、Sony はディスプレイでの Play モードに Settings アプリを求めているので、Attach モードが普段の開発経路になる。

リリース用のパッケージングはステップ U5 まで対象外とする。Unity のビルドにはライセンスが必要なので、追加の作業なしには CI でビルドできない。

### プロトコル

エンベロープは Godot と同じ `{ type, payload }` の JSON テキストである。接続先は `127.0.0.1` で、ランダムなトークンを使う。

ホストからサイドカーへ:

| Type | Payload | 頻度 |
| --- | --- | --- |
| `host.scene.apply` | `format`、`modelId`、`name`、`path` | モデル変更時 |
| `host.character.idle` | `.vrma` ファイルの `path` | モデル変更時 |
| `host.character.expression` | `name`、`intensity`、`holdMs` | `ACT` マーカー時 |
| `host.character.gesture` | `kind`、`id`、`part`、および `tracks` と `duration`（`keys`）、または `.vrma` ファイルの `path`（`vrma`） | `ACT` マーカー時 |
| `host.character.frame` | `mouth`（A、E、I、O、U）、`bones`（spine、chest、neck、head）、`eyes` | 毎秒 30 回 |
| `host.shutdown` | なし | 停止時 |

サイドカーからホストへ:

| Type | Payload |
| --- | --- |
| `stage.ready` | なし |
| `stage.fatal` | `message` |
| `scene.applied` | `modelId`、`avatarBounds` |
| `scene.error` | `message` |
| `character.error` | `message`、失敗したメッセージの `type` |

Valibot のスキーマは `packages/stage-shared/src/stage-sidecar/` に置く。名前にエンジン名を入れないので、後で Godot も同じメッセージを使える。同じフォルダーに各メッセージの正しい例を 1 つずつ持つ JSON フィクスチャを置き、TypeScript と C# の両方のテストが読む。これで両者のずれを防ぐ。

ファイルは Godot の経路と同じくディスクに置く。Electron main がモデルと `.vrma` のバイト列を `<userData>/unity-stage/` に書き、パスを送る。

### どこで何を計算するか

| 信号 | 計算する場所 | 適用する場所 |
| --- | --- | --- |
| 感情とジェスチャーの選択、ジェスチャーの照合 | レンダラー（`Stage.vue`、`useMotionLibraryStore`） | Unity |
| 表情の保持とフェード | Unity | Unity |
| ジェスチャークリップの再生、アイドルとの合成 | Unity（`GestureLayer` 相当） | Unity |
| 口の母音 | レンダラー（`createWLipSyncVowelDriver`） | Unity |
| 呼吸、揺れ、うなずき、考えるときの視線外し | レンダラー（`ProceduralBodyMotion`） | Unity |
| スプリングボーンとまばたき | Unity（UniVRM） | Unity |

手続き的な動きは TypeScript に残し、オフセットをストリームで送る。C# に移植すると、調整値とテストが 2 組になる。オフセットは小さくゆっくりなので、毎秒 30 回と Unity 側の平滑化で十分である。

クリップは Unity で再生する。全身のポーズをストリームで送るとジッターが目立つうえ、クリップのデータはすでにファイルか短いキーの一覧になっているためである。

ストリームには期限を設ける。500 ms フレームが届かなければ、Unity は口とオフセットをゼロへフェードする。これで、レンダラーの抑制やアプリの停止で口が開いたまま固まることを防ぐ。隠れたウィンドウでは `requestAnimationFrame` が止まるので、レンダラーはワーカーのタイマーからフレームを送る。

### `Stage.vue` と新しいレンダラー

`StageModelRenderer` に `unity` を追加する。`Stage.vue` は音声出力を持つので、キャンバスなしでマウントしたままにする。`vrm` の分岐に対応する `unity` の分岐を追加する。

`stage-ui` は `stage-tamagotchi` の Eventa 契約を import できない。そこで `stage-ui` に `StageSidecarOutput` インターフェースを持つ小さなストアを追加する。デスクトップアプリが Eventa を呼ぶ実装を登録し、Web アプリでは実装なしとする。

### Electron main のサイドカーホスト

`godot-stage/index.ts` は 972 行あり、その大半はプロセスのライフサイクル、ソケット、起動待ち、ステータス通知で、Godot に依存しない。この ADR ではこれらを `services/airi/stage-sidecar/` に移す。Godot と Unity は、実行ファイルのパス、引数、固有のメッセージだけを持つ薄いファイルを持つ。

この変更は upstream のコードに触れるので、リベース時にこのファイルで競合が起こりうる。もう一方の選択肢は 972 行のコピーだが、リポジトリのルールは一度きりのコピーを認めていない。Godot の動作は変えてはならない。

### 座標系

ジェスチャーのキーは VRM ヒューマノイドの正規化ボーンを回転させる。座標系は右手系で +Z を向き、+Y が上である。UniVRM は左手系の Unity でもモデルを +Z 向きに保つので、X 軸が反転する。したがって変換は `(x, y, z, w)` から `(x, -y, -z, w)` である。

これは `Core` の純粋関数 1 つとし、テストを付ける。ステップ U3 で、組み込みの 8 ジェスチャーを three.js レンダラーと比較して確認する。

### モデル

**VRM** は UniVRM v0.131.4（MIT）を使う。次の名前はソースで確認した。

- `Vrm10.LoadPathAsync` は `canLoadVrm0X: true` で VRM 1.0 と VRM 0.x の両方を読む。Godot の経路は現時点で VRM 1.0 に対応していない。
- `UrpVrm10MaterialDescriptorGenerator` を `materialGenerator` 引数に渡すと URP のマテリアルになる。
- `Vrm10RuntimeExpression.SetWeight` で表情を設定する。
- `VrmAnimationImporter` と `Vrm10AnimationInstance` で `.vrma` を読み込んで再生する。

UniVRM の README はバックエンドとして `.NET` と IL2CPP を挙げ、Mono の名前を挙げていない。Sony が ELF-SR1 / SR2 で Mono を要求しているので、ステップ U2 で最初にこれを確認する。

**MMD** は明確な選択肢がないので、試作を含む別ステップとする。オーナーはアプリ内でモデルを選ぶので、ローダーは実行時に PMX ファイルを読める必要がある。Unity Editor でのインポートはビルド後のプレイヤーでは使えない。

| ライブラリ | ライセンス | 更新 | Unity 6 と URP | 実行時の PMX 読み込み |
| --- | --- | --- | --- | --- |
| [unity-mmd-loader](https://github.com/yohawing/unity-mmd-loader) v0.5.1 | MIT | 2026-10 | 対応 | 未確認。README は Editor でのインポートを説明している。 |
| [mmd-anim](https://github.com/yohawing/mmd-anim) v0.5.4 | MIT | 2026-11 | ホスト次第 | 対応（バイト列から）。メッシュとマテリアルは AIRI が作る必要がある。README は評価段階としている。 |
| [UnityPMXRuntimeLoader](https://github.com/hobosore/UnityPMXRuntimeLoader) | MIT | 2020-02 | 記載なし | 対応（`PMXModelLoader.LoadPMXModel(path)`）。 |
| [libmmd-for-unity](https://github.com/OneYoungMean/libmmd-for-unity) | BSD-3-Clause | 2019-08 | 記載なし | 対応。PMD と Bullet 物理を含む。 |

AIRI の MMD の見た目（PBR モード、ブルーム、被写界深度）は three.js に残す。ステップ U4 では移植しない。

### 表示の出力先

小さなインターフェース `IStageOutput` に 2 つの実装を持たせる。

- `WindowOutput`: 通常のウィンドウと通常のカメラ 1 台。ステップ U2 から U4 の出力である。カメラはアバターの境界から構図を決める。
- `SrDisplayOutput`: `PortraitSRDisplayManager` をシーンに置き、通常のカメラを取り除く。

`Assets/Airi/SrDisplay/` は専用のアセンブリ定義と define 制約を持つので、Sony のプラグインがなくてもプロジェクトはコンパイルできる。

スケールは固定値ではなくアバターの境界から決める。ステップ U5 で、腕と髪の余白を含めたキャラクター全身がビュースペースに収まるように `SRD View Space Scale` を設定する。Spatial Clipping はオンのままとする。以前の「2 m のデスクの一角を 1/10 に」というメモは計算にすぎず、ビュースペースの垂直軸もまだ分かっていない。

### 部屋の状態

現在リポジトリに部屋や座席の状態はなく、この ADR でも追加しない。部屋を追加するときは、three.js と Unity で共有できるように、状態をレンダラーから独立させる必要がある。

## ステップ

| ステップ | 内容 | Unity が必要か | 完了条件 |
| --- | --- | --- | --- |
| U0 | エンジンのフォルダー、`Core` と `dotnet` のテスト、`stage-sidecar` スキーマ、共有フィクスチャ | 不要 | TypeScript と C# のテストが同じフィクスチャで通る。 |
| U1 | `stage-sidecar` ホスト、Godot の移行、Unity サービス、Eventa 契約、`unity` レンダラー、設定のスイッチ | 不要 | 偽のサイドカーがモデルのパスと信号を受け取る。Godot のテストが通る。 |
| U2 | Unity プロジェクト、VRM の読み込み、ウィンドウ出力、Attach と Player のモード | 必要 | AIRI で選んだ VRM モデルが Unity のウィンドウに表示される。 |
| U3 | 表情、アイドル、ジェスチャー、口、手続き的オフセット | 必要 | TTS 付きのチャット返信でキャラクターが動く。8 ジェスチャーが three.js と一致する。 |
| U4 | MMD の試作とライブラリの選択 | 必要 | オーナーの PMX モデルが表示されて話す。または、できない理由をこの ADR に記録する。 |
| U5 | `SrDisplayOutput`、境界からのスケール、視聴者への視線、パッケージング | 必要（プラグインと実機も） | 実機の ELF-MN1 でキャラクターがビュースペース内に表示される。 |

ステップ U5 は 2026-12-11 より前には始められない。視聴者の位置を運ぶメッセージは、読めるプラグインがまだないので、この ADR には含めない。

## この設計でやらないこと

three.js のステージとの違いは次のとおりである。いずれも意図した選択である。

- 透過のデスクトップマスコットウィンドウは作らない。Unity のウィンドウは不透過である。目標は ELF-MN1 であり、デスクトップには three.js のステージがある。
- 最初のステップでは Unity 用のカメラスライダーを設定に出さない。`SrDisplayOutput` には操作するカメラがなく、`WindowOutput` は自分で構図を決める。
- Unity のキャラクターへのポインター操作はない。
- Unity で Live2D、Spine、立ち絵は扱わない。

## リスク

| リスク | 結果 | 対応 |
| --- | --- | --- |
| ELF-MN1 のプラグインに未公開の要件がある。 | プロジェクト設定が変わる。 | リリース時に注記を読む。Sony に関する利用はすべて `SrDisplay/` に閉じる。 |
| プラグインがフォーカスや全画面を必要とする。 | オーナーがチャットウィンドウを同時に使えない。 | ステップ U5 で実機で確認する。Sony は記載していない。 |
| UniVRM が Mono で動かない。 | ステップ U2 が止まる。 | U2 の最初に確認する。失敗したら Windows プラグインの IL2CPP 対応を調べる。 |
| 十分な実行時 PMX ローダーがない。 | MMD モデルを Unity で表示できない。 | ステップ U4 は試作であり、結果を見てオーナーが判断する。 |
| 毎秒 30 回の JSON で Unity の GC が止まる。 | 小さなカクつき。 | ステップ U3 で測定する。見えるようなら、このメッセージをバイナリに変える。 |
| Sony はビュースペース外の表示が快適さを損なうと警告している。 | オーナーが不快を感じうる。 | 境界からスケールを決め、Spatial Clipping をオンにして、実機で確認する。 |

## 出典

- [ELF-MN1 ダウンロード（スマートフォン）](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info)、[ELF-MN1 ダウンロード（Windows）](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info2)
- [ELF-MN1 Prefab](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/srdmanagerprefab)、[World Scaling](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/worldscaling)、[Spatial Clipping](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/spatialclipping)、[Android ビルド](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/builds-for-android)
- [ELF-SR Unity クイックスタート](https://xyn.sony.net/en/developer/setup/spatial-reality-display/unity/quickstart)
- [UniVRM](https://github.com/vrm-c/UniVRM)
