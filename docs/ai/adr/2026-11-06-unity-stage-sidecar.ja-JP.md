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
- Active Input Handling はプロジェクトの既定である旧 Input Manager のままとする。ELF-SR1 / SR2 で Sony は旧 Input Manager か `Both` を要求しており、`Both` にはステージが使わないパッケージが 1 つ余分に必要である。
- `Application.runInBackground` は `true` とする。オーナーは Electron のウィンドウを操作しながらキャラクターを動かすためである。
- ウィンドウにはキャラクターが 1 人だけ映るので、描画の予算を輪郭と影に使う。MSAA 8x、レンダースケール 1.5、64 ビットの HDR バッファー、8 m の範囲に 4096 のマップを使うソフトシャドウ、不透明パスの後の SSAO である。カメラ効果は three.js のステージと同じく、VRM モデルに ACES、MMD モデルに Neutral を使う。
- これらの設定は `StageProjectSetup.Apply` が Unity の API で書き込む。レビューでは 1 つのファイルで各選択を読める。

`tools/run-unity.ps1` は Unity をバッチモードで実行する。Microsoft Store 版の Unity Hub はライセンスをパッケージの仮想フォルダーに置くので、単純な `Unity.exe` の実行は "No valid Unity Editor license found" で失敗する。このスクリプトは Hub のパッケージの中で Unity を起動し、ライセンスファイルには触れない。パッケージ内の起動では終了コードを得られないので、ログから結果を読む。`EditorApplication.Exit(1)` で終わった Unity はログに結果を書かないので、スクリプトは Unity のプロセスも見張る。そのような終わり方は終了コード 1 になる。

Unity は `Library/` に `package.json` を含むパッケージを置き、pnpm のワークスペース指定 `engines/**` がそれを読んでしまう。そこで `pnpm-workspace.yaml` で `Library/` と `Temp/` を除外する。

ELF-MN1 のプラグインが別の Unity バージョンを必要とする場合は、プロジェクトをそのバージョンに変更する。これは設定の変更であり、設計は変わらない。

### プロジェクト構成

```text
engines/stage-tamagotchi-unity/
  package.json                 # scripts: typecheck, test
  README.md
  Assets/Airi/Core/            # UnityEngine を参照しない（noEngineReferences）
  Assets/Airi/Stage/           # MonoBehaviour、UniVRM の利用
  Assets/Airi/SrDisplay/       # Sony プラグインがあるときだけコンパイルする
  Assets/Airi/Looks/Resources/ # lilToon の見た目のマテリアルのテンプレート
  Assets/LocalRooms/           # 開発者が取り込んだ部屋。Git は無視する
  Packages/manifest.json
  ProjectSettings/
  tests/                       # Assets/Airi/Core をコンパイルする dotnet のテストホスト
```

`Core` にはプロトコルのパーサー、WebSocket クライアントのループ、座標変換、キャラクターのロジック（ジェスチャー、表情、まばたき、フレームのストリーム）を置く。`Core` は Unity を参照しないので、Unity のライセンスがなくてもどの PC でも CI でも `dotnet` でテストできる。Godot エンジンの検証ホストと同じ方式である。

`Core` の JSON にはオーナーの選択で Newtonsoft.Json を使う。Unity に公式パッケージがあり、`dotnet` では同じライブラリを NuGet から得られる。別のプロジェクトが `Core` を C# 9 と .NET Standard 2.1 でコンパイルするので、Unity の外のビルドでも同じ言語の制限で失敗する。

Sony のプラグインパッケージ、モデルファイル、取り込んだ部屋、Unity のビルド出力は Git に入れない。

### プロセスの起動

| モード | 用途 | 起動方法 |
| --- | --- | --- |
| Player | 通常の利用 | Electron main がビルド済みの `.exe` を `--airi-ws-url=<url>` 付きで起動する。開発時のパスは `AIRI_UNITY_STAGE_EXECUTABLE` で渡す。 |
| Attach | Editor での作業 | Electron main はプロセスを起動しない。URL とトークンを `<userData>/unity-stage/attach.json` に書き、Editor の Play モードがこれを読んで接続する。 |

Godot はプロジェクトパスを指定して Editor を起動できるが、Unity Editor はこの用途には起動が遅すぎる。また、Sony はディスプレイでの Play モードに Settings アプリを求めているので、Attach モードが普段の開発経路になる。

`AIRI_UNITY_STAGE_ATTACH=1` で Attach モードになり、実行ファイルの指定より優先する。このモードでは `start` はステータス `starting` ですぐに返り、サイドカーが `stage.ready` を送ると `running` になる。サイドカーが切断するとステータスは `starting` に戻り、URL は有効なままである。したがって Play モードを止めて再び始められる。停止時には、ソケットがなくなるので `attach.json` を削除する。

Player モードでは、ホストは `-force-d3d12-single-pso-disk-cache` も渡す。このフラグがないと、プレイヤーは `host.shutdown` のあとに終了コード `0xC0000005` で終わることがある。Unity 6000.3.28f1 の `~GfxDeviceD3D12` はパイプラインステートを解放し、そのあとで `ID3D12PipelineLibrary::Serialize` が解放済みのシェーダーを読むためである。

この不具合が起きるのは、`dx12_pso_cache_lib.bin` を読み込んでいて、同じ名前で保存されたステートと異なるパイプラインステートがある場合である。結果はヒープの状態にも左右されるので、モデル、シェーダー、キャッシュファイルによって変わる。このフラグは、ライブラリを使わない `dx12_pso_cache.bin` を選ぶ。`boot.config` はこのフラグを無視するので、指定できる場所はコマンドラインだけである。古いライブラリファイルがある状態で 10 回起動すると、フラグなしでは 10 回クラッシュし、フラグありでは 0 回で、CPU 時間は同じだった。Unity の新しいバージョンがステートの解放より先に `Serialize` を呼ぶようになったら、このフラグを削除する。

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
| `host.character.attention` | `target`：`viewer` か `none` | 変わったとき。新しく `running` になったときにも送り直す。[歩行の ADR](2026-11-10-unity-stage-room-walking.ja-JP.md) で足す。 |
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

ファイルは Godot の経路と同じくディスクに置く。Electron main がモデルと `.vrma` のバイト列を `<userData>/unity-stage/` に書き、パスを送る。モデルは選ぶたびに書き直すので、停止時と起動時にモデルのコピーを消す。クリップは残す。

`format` の値は `vrm` か `pmx` である。PMX モデルは複数のファイルからなるフォルダーなので、Electron main はパッケージ全体を書き、`path` はその中の PMX ファイルを指す。

### どこで何を計算するか

| 信号 | 計算する場所 | 適用する場所 |
| --- | --- | --- |
| 感情とジェスチャーの選択、ジェスチャーの照合 | レンダラー（`Stage.vue`、`useMotionLibraryStore`） | Unity |
| 表情の保持とフェード | Unity | Unity |
| ジェスチャークリップの再生、アイドルとの合成 | Unity（`GestureLayer` 相当） | Unity |
| 口の母音 | レンダラー（`createWLipSyncVowelDriver`） | Unity |
| 呼吸、揺れ、うなずき、考えるときの視線外し | レンダラー（`ProceduralBodyMotion`） | Unity |
| スプリングボーン | Unity（UniVRM） | Unity |
| まばたき | Unity（`BlinkTimer`）。UniVRM のランタイムに自動のまばたきはない。 | Unity |
| PMX モデルの物理 | Unity（unity-mmd-loader） | Unity |

`Core` の `CharacterDriver` が各フレームの状態を計算し、アバターホストはそれを適用するだけである。このロジックは Unity なしでテストできる。

ホストは感情名をそのまま送る（例: `awkward`）。MMD モデルは VRM モデルに表情がない感情も表示できるので、`Core` の `EmotionTable` はモデルの種類ごとに表を持つ。

TypeScript の各パッケージのテストが、感情の表、モーフ名、ジェスチャーのキー、リターゲットの結果を `packages/stage-shared/src/stage-sidecar/character-fixtures/` に記録する。C# のテストはこのファイルを再生するので、片方を変更するともう片方のテストが失敗する。意図した変更の後は、テストのあるパッケージで `vitest run -u` を実行して更新する。

次の規則は意図して three.js のステージと変えている。

| 場面 | three.js | Unity |
| --- | --- | --- |
| ジェスチャー中に次のジェスチャーが来たとき | 前の姿勢が飛ぶ。 | 前のジェスチャーが新しいものの下でフェードアウトする。 |
| 全身モーション中の上半身ジェスチャー | VRM は両方再生し、MMD は再生しない。 | どちらも再生しない。 |
| 全身モーションの終わり | 待機モーションを最初から再生する。 | 裏で進めていた待機モーションに戻る。 |
| 話していない MMD モデルの `happy` | 口パクの処理が毎フレーム母音を 0 に書くので、アクセントは見えない。 | アクセントが見える。 |
| 強さ 0 の表情 | MMD モデルは重み 0 の顔になる。 | どちらも無視する。 |

手続き的な動きは TypeScript に残し、オフセットをストリームで送る。C# に移植すると、調整値とテストが 2 組になる。オフセットは小さくゆっくりなので、毎秒 30 回と Unity 側の平滑化で十分である。

クリップは Unity で再生する。全身のポーズをストリームで送るとジッターが目立つうえ、クリップのデータはすでにファイルか短いキーの一覧になっているためである。

口は、キャラクターが話している間だけリップシンクのノードに従う。ノードは入力に音声がないと最後の値を保持し、フレームは流れ続ける。このルールがないと、発話の後も口が開いたままになる。ステップ U1 の実機確認でこの不具合が見つかった。Live2D の経路にも同じルールがある。

ストリームには期限を設ける。500 ms フレームが届かなければ、Unity は口とオフセットをゼロへフェードする。これで、レンダラーの抑制やアプリの停止で口が開いたまま固まることを防ぐ。隠れたウィンドウでは `requestAnimationFrame` が止まるので、レンダラーはワーカーのタイマーからフレームを送る。

### `Stage.vue` と新しいレンダラー

`StageModelRenderer` に `unity` を追加する。`Stage.vue` は音声出力を持つので、キャンバスなしでマウントしたままにする。`vrm` の分岐に対応する `unity` の分岐を追加する。

`stage-ui` は `stage-tamagotchi` の Eventa 契約を import できない。そこで `stage-ui` に `StageSidecarOutput` インターフェースを持つ小さなストアを追加する。デスクトップアプリが Eventa を呼ぶ実装を登録し、Web アプリでは実装なしとする。

モデルはステージのページが `useUnityStageBridge` で送る。これは設定ページがモデルを送る Godot とは異なる。Godot では、設定を閉じている間のキャラクター変更はサイドカーに届かない。エージェントはいつでもキャラクターを変更できるので、Unity の経路にこの制限があってはならない。

### Electron main のサイドカーホスト

`godot-stage/index.ts` は 972 行あり、その大半はプロセスのライフサイクル、ソケット、起動待ち、ステータス通知で、Godot に依存しない。この ADR ではこれらを `services/airi/stage-sidecar/` に移す。Godot と Unity は、実行ファイルのパス、引数、固有のメッセージだけを持つ薄いファイルを持つ。

この変更は upstream のコードに触れるので、リベース時にこのファイルで競合が起こりうる。もう一方の選択肢は 972 行のコピーだが、リポジトリのルールは一度きりのコピーを認めていない。Godot の動作は変えてはならない。

この変更の前、Godot の管理コードにテストはなかった。そこで `godot-stage/index.test.ts` をまず古いコードで通し、新しいコードでも変更なしで通している。このテストは本物の子プロセスとソケットを使い、エンジンの代わりに `apps/stage-tamagotchi/scripts/fake-stage-sidecar.mjs` を動かす。

### 座標系

ジェスチャーのキーは VRM ヒューマノイドの正規化ボーンを回転させる。座標系は右手系で +Z を向き、+Y が上である。UniVRM は左手系の Unity でもモデルを +Z 向きに保つので、X 軸が反転する。したがって変換は `(x, y, z, w)` から `(x, -y, -z, w)` である。

これは `Core` の純粋関数 1 つとし、テストを付ける。

ステップ U3 の実機確認で、組み込みの 8 ジェスチャーを AvatarSample_A、AvatarSample_B、PMX モデル 1 体で両方のステージを比較した。

- PMX モデル（1 体）は three.js のステージと一致する。
- VRM モデルは当初は異なっていた。three.js のステージが前腕を曲げなかったためである。`VRMModel.vue` が `AnimationMixer` を深い `ref` に持っていた。読み出すたびに reactive proxy が返るので、各ジェスチャーは idle の上で半分の重みで再生された。その後の修正で mixer を `shallowRef` に持つようにした。
- この修正のあとに比較をやり直した。両方の VRM モデルで、8 ジェスチャーすべてが両方のステージで同じポーズになる。例えば `cross-arms` はどちらのステージでも胸の前で腕を組む。
- これらの比較はキャプチャの目視による。2 つのステージの最終的なボーンを比べるテストはない。ステージのカメラと照明は異なる。three.js のカメラは近く、肩の高さにある。Unity のカメラは全身を映す。

### モデル

**VRM** は UniVRM v0.131.4（MIT）を使う。次の名前はソースで確認した。

- `Vrm10.LoadPathAsync` は `canLoadVrm0X: true` で VRM 1.0 と VRM 0.x の両方を読む。Godot の経路は現時点で VRM 1.0 に対応していない。
- `UrpVrm10MaterialDescriptorGenerator` を `materialGenerator` 引数に渡すと URP のマテリアルになる。
- `Vrm10RuntimeExpression.SetWeight` で表情を設定する。
- `VrmAnimationImporter` と `Vrm10AnimationInstance` で `.vrma` を読み込んで再生する。

UniVRM の README はバックエンドとして `.NET` と IL2CPP を挙げ、Mono の名前を挙げていない。ステップ U2 で Mono のプレイヤーを確認し、VRM 0.x モデルを読み込んで表示できた。VRM 1.0 のファイルは手元になく、この確認に含まれていない。

MToon シェーダーは実行時に `Shader.Find` で探され、プロジェクトのアセットからは参照されない。そこでグラフィック設定の「常に含める」一覧に入れる。ビルドに含まれていなければ、サイドカーは起動時に `stage.fatal` を返す。モデルごとに失敗させない。

新しいモデルは読み込みが終わってから古いモデルと入れ替える。したがって、壊れたファイルでも古いモデルはステージに残る。入れ替えを繰り返してもメモリは増え続けない。計測では 20 回の読み込みごとに 614、700、703、707、706 MB だった。`player.integration.test.ts` は、`AIRI_UNITY_STAGE_PLAYER` でプレイヤーを指定すると、これらを実際のプレイヤーで確かめる。

**MMD** は、ステップ U4 の試作を経て unity-mmd-loader v0.5.1 を使う。オーナーはアプリ内でモデルを選ぶので、ローダーは実行時に PMX ファイルを読める必要がある。Unity Editor でのインポートはビルド後のプレイヤーでは使えない。

オーナーのモデルを Mono のプレイヤーで試作した結果は次のとおりである。

- PMX の 34 体すべてが正しく読み込まれて表示された。読み込み時間は中央値 2.7 秒、最大 5.9 秒である。各モデルの画面を撮影して目で確認した。テクスチャ 1066 枚のうち 3 枚は、2 体のモデルの ZIP に入っていないので欠けている。
- オーナーの 37 体のうち 3 体は PMD である。ローダーは PMX しか読めないので、AIRI はこれらにエラーを表示し、古いモデルが残る。
- 物理は動きに追従し、毎秒 180、60、30 フレームで安定している。全 34 体で、最も遠いボーンはモデルの身長の 1.3 倍以内である。
- 全 34 体で母音とまばたきが動く。29 体は単純な頂点モーフである。残りの 5 体はグループモーフかボーンモーフが必要だが、ローダーが解決する。AIRI にこのためのコードはない。

物理の計算の後でボーンを動かしても、物理には伝わらない。そこで `AiriMmdHostPose` は計算の前にネイティブのセッションへ姿勢を渡し、セッションが付与、補助 IK、物理を計算する。このセッションはローダーの Humanoid 経路が使うもので、内部 API である。そのためこのファイルをパッケージの中に置く。追加はこの 1 ファイルだけで、ローダーの既存ファイルは変更しない。ローダーの Humanoid 経路はモーフの重みを常に 0 で送るので、モーフの重みもこのファイルを通す。

`CreateSkinned` にはモーションが必要だが、AIRI にモーションファイルはない。そのため `MmdAvatarHost` はキーのない 66 バイトの VMD を渡す。このモーションは再生しない。

`Core` の `MmdHumanoidRetarget` は `retargetVRMAnimationToMMD` の移植で、両者が同じ結果になることをフィクスチャで確認している。ボーンの回転を直接書くので、Animator、Avatar、プロキシリグは不要である。この経路では足の IK に目標がないので、脚はクリップにそのまま従う。ドライバーの T ポーズは MMD モデルでは不自然なので、クリップがないときは物理を動かしたまま休めの姿勢で立つ。

リポジトリにはパッケージのコピーを、3 つのパッチと追加ファイル 1 つとともに置く。これらは `engines/stage-tamagotchi-unity/docs/vendor-patches.md` に記録する。パッチがないと、パッケージは Unity 6000.3 でコンパイルできず、プレイヤーに DLL が入らず、16bit のテクスチャが白いままになる。

この経路を変更するときに守る必要がある事実は次のとおりである。

- ローダーが Shift_JIS を使うので、プレイヤーには `I18N.dll` と `I18N.CJK.dll` が必要である。`StageBuild` がコピーする。
- モデルの変更時には `Resources.UnloadUnusedAssets` を呼ぶ必要がある。呼ばないと、モデルを変更するたびにメモリが増える。呼ぶと、40 回の変更でも約 2 GB で止まる。
- MMD モデルには MMD のライトの強さ 0.6 が必要である。VRM モデルは 0.85 のままである。`StageRoot` がモデルの読み込み時にライトを設定する。
- モデルの輪郭線と影のために、レンダラーに `MmdOutlineRendererFeature` と `MmdSelfShadowRendererFeature` が必要である。

ZIP はレンダラーで展開する。`entriesFromZip` がすでに Shift_JIS の名前を読めるためである。three.js のステージと同じく、パッケージの最初のモデルを選ぶ。テクスチャはモデルからの相対パスで読まれるので、Electron main はフォルダー構造ごと書き出す。パスは第三者が作れる ZIP に由来するので、`materializePackage` はモデルのフォルダーの外に出られるパスを拒否し、その場合は何も書き出さない。

次の表は試作の前の比較である。unity-mmd-loader のソースから、README に書かれていない実行時の読み込みがあると分かった。

| ライブラリ | ライセンス | 更新 | Unity 6 と URP | 実行時の PMX 読み込み |
| --- | --- | --- | --- | --- |
| [unity-mmd-loader](https://github.com/yohawing/unity-mmd-loader) v0.5.1 | MIT | 2026-10 | 対応 | 対応（`NativeMmdParser` と `MmdUnityPlaybackBinding`）。 |
| [mmd-anim](https://github.com/yohawing/mmd-anim) v0.5.4 | MIT | 2026-11 | ホスト次第 | 対応（バイト列から）。メッシュとマテリアルは AIRI が作る必要がある。README は評価段階としている。 |
| [UnityPMXRuntimeLoader](https://github.com/hobosore/UnityPMXRuntimeLoader) | MIT | 2020-02 | 記載なし | 対応（`PMXModelLoader.LoadPMXModel(path)`）。 |
| [libmmd-for-unity](https://github.com/OneYoungMean/libmmd-for-unity) | BSD-3-Clause | 2019-08 | 記載なし | 対応。PMD と Bullet 物理を含む。 |

AIRI の MMD の見た目（PBR モード、ブルーム、被写界深度）は three.js に残す。ステップ U4 では移植しない。代わりに Unity には独自の任意の見た目があり、次の節に書く。

### 見た目と光

これらは試作である。どれもプレイヤーの引数か環境変数で有効にするまでは無効のままで、設定画面には操作がない。

- `--airi-look=liltoon` または `AIRI_UNITY_STAGE_LOOK=liltoon` は、モデルのマテリアルを lilToon 2.4.1 に置き換える。指定がなければ、VRM モデルは MToon、PMX モデルは MMD Toon Lit のままである。
- `StageLook` は元の各マテリアルの値を読み、`Assets/Airi/Looks/Resources/AiriLooks` のテンプレートの複製に書き込む。プレイヤーは自分のアセットのシェーダーバリアントだけを持つので、これらのテンプレートがそのアセットになる。
- ステージは実行時にマテリアルを作るので、`LILTOON_DISABLE_OPTIMIZATION` でビルドに lilToon の各機能を残す。
- `--airi-grade=backlit|live|cinema` または `AIRI_UNITY_STAGE_GRADE` は、キーライト、環境光、カメラ効果（ブルーム、色、ビネット、グレイン）を設定する。lilToon のときは、各マテリアルのリムと陰も書き込む。

オーナーは約 10 体の PMX モデルと 2 体の VRM サンプルで、4 つの見た目を比べた。元のマテリアル、lilToon、Unity Toon Shader、URP Lit である。どれも RTX 5080 で 1 フレームあたり 1 ms 未満だった。オーナーは lilToon を選んだ。そこで残りの 2 つの見た目とパッケージ `com.unity.toonshader` はプロジェクトから外した。キャラクターの後ろの平面の背景も、部屋が置き換えるので外した。

### 表示の出力先

小さなインターフェース `IStageOutput` に 2 つの実装を持たせる。

- `WindowOutput`: 通常のウィンドウと通常のカメラ 1 台。ステップ U2 から U4 の出力である。カメラはアバターの境界から構図を決める。オーナーはウィンドウの中でマウスでカメラを動かせる。左ドラッグでキャラクターの周りを回り、右ドラッグで画面に沿って動き、ホイールで近づく。キー 1、2、3 は全身、上半身、顔の構図にし、ダブルクリックで全身に戻る。最後のカメラは `PlayerPrefs` が覚える。引数 `--airi-camera=full|upper|face|custom:...` はカメラを固定し、入力を無視する。
- `SrDisplayOutput`: `PortraitSRDisplayManager` をシーンに置き、通常のカメラを取り除く。

`Assets/Airi/SrDisplay/` は専用のアセンブリ定義と define 制約を持つので、Sony のプラグインがなくてもプロジェクトはコンパイルできる。

スケールは固定値ではなくアバターの境界から決める。ステップ U5 で、腕と髪の余白を含めたキャラクター全身がビュースペースに収まるように `SRD View Space Scale` を設定する。Spatial Clipping はオンのままとする。以前の「2 m のデスクの一角を 1/10 に」というメモは計算にすぎず、ビュースペースの垂直軸もまだ分かっていない。

### 部屋の状態

現在リポジトリにキャラクターの部屋や座席の状態はなく、この ADR でも追加しない。そのような状態を追加するときは、three.js と Unity で共有できるように、状態をレンダラーから独立させる必要がある。

試作として、Unity のキャラクターを部屋の中に表示できる。ただし、そのような状態は持たない。部屋はキャラクターの周りのシーンにすぎない。

- `pnpm -F @proj-airi/stage-tamagotchi-unity import:room` は、各フォルダー `.cache/rooms/<name>/` の Unity パッケージを読む。たとえば BOOTH の VRChat 用ワールドである。データファイルだけを `Assets/LocalRooms/<name>` にコピーし、コードとシェーダーはコピーしない。
- 取り込みは、足りないスクリプトと足りないプレハブ（たとえば `VRCWorld`）を外し、ワールドのカメラを無効にする。マテリアルは URP に移す。取り込みが外した透明なシェーダーのマテリアルは、透明のままにする。別のパッケージにある空は `Skybox/Procedural` にする。焼いたライトマップは残す。
- 取り込みは `room.bundle` を作り、`room.json` を書く。中身はライトプローブの箱、立ち位置、向きである。立ち位置は一番低い床の上で、壁から離れ、前にカメラの空きがある場所を選ぶ。この探索の間は、当たり判定のない家具に仮の当たり判定を付け、光線は裏面にも当たる。そのため、テーブルの中や空洞の壁の中は選ばない。`room.json` で書き換えた立ち位置は、次の取り込みでも残る。
- [部屋の中の歩行](2026-11-10-unity-stage-room-walking.ja-JP.md)のために、取り込みは部屋の描画用のメッシュから NavMesh も焼く。エージェントは半径 0.25 m、高さ 1.7 m である。読み込むとき、プレイヤーは、床の乱数の 20 地点のうち立ち位置から行ける数をログに出す。
- ワールドの閉じたドアは NavMesh をさえぎる。そこで取り込みは、行ける床を 1.5 m² 以上増やすドアを隠し、`room.json` の `openDoors` に並べる。
- `--airi-room=<folder>` または `AIRI_UNITY_STAGE_ROOM` は、ステージのシーンの隣に部屋を読み込む。カメラは部屋の箱の中に留まる。部屋には自分の焼いた光があるので、ステージのライトは消す。光のプリセットは、カメラ効果と lilToon の値だけを使う。
- プロジェクトには音声のモジュールとパーティクルのモジュールがないので、ワールドの音とパーティクルは消える。
- 部屋のあるプレイヤーは、大きいシェーダーキャッシュを書くので、RTX 5080 で終了に 2.1 秒かかった。そこで Unity のマネージャーは、`host.shutdown` の後にサイドカーへ 5 秒を与える。ほかのサイドカーは 2 秒のままである。
- そのようなワールドのライセンスは再配布を禁じている。そこでパッケージ、バンドル、`Assets/LocalRooms` は Git にもビルドにも入れない。各開発者が自分のコピーを取り込む。

## ステップ

| ステップ | 内容 | Unity が必要か | 完了条件 |
| --- | --- | --- | --- |
| U0 | エンジンのフォルダー、`Core` と `dotnet` のテスト、`stage-sidecar` スキーマ、共有フィクスチャ | 不要 | TypeScript と C# のテストが同じフィクスチャで通る。 |
| U1 | `stage-sidecar` ホスト、Godot の移行、Unity サービス、Eventa 契約、`unity` レンダラー、設定のスイッチ | 不要 | 偽のサイドカーがモデルのパスと信号を受け取る。Godot のテストが通る。 |
| U2 | Unity プロジェクト、VRM の読み込み、ウィンドウ出力、Attach と Player のモード | 必要 | AIRI で選んだ VRM モデルが Unity のウィンドウに表示される。 |
| U3 | VRM と PMX の表情、アイドル、ジェスチャー、口、手続き的オフセット | 必要 | TTS 付きのチャット返信でキャラクターが動く。8 ジェスチャーが、PMX モデルと VRM モデルで three.js のステージと一致する。 |
| U4 | MMD の試作、ライブラリの選択、AIRI からのモデルの経路。オーナーの判断で U3 より先に行った。 | 必要 | オーナーの PMX モデルが AIRI のボタンから表示される。試作でモーフを名前で動かした。 |
| U5 | `SrDisplayOutput`、境界からのスケール、視聴者への視線、パッケージング | 必要（プラグインと実機も） | 実機の ELF-MN1 でキャラクターがビュースペース内に表示される。 |

ステップ U5 は 2026-12-11 より前には始められない。視聴者の位置を運ぶメッセージは、読めるプラグインがまだないので、この ADR には含めない。

## この設計でやらないこと

three.js のステージとの違いは次のとおりである。いずれも意図した選択である。

- 透過のデスクトップマスコットウィンドウは作らない。Unity のウィンドウは不透過である。目標は ELF-MN1 であり、デスクトップには three.js のステージがある。
- Unity 用のカメラスライダーを設定に出さない。`SrDisplayOutput` には操作するカメラがない。`WindowOutput` では、オーナーが Unity のウィンドウの中でマウスでカメラを動かす。
- Unity のキャラクターへのポインター操作はない。
- Unity で Live2D、Spine、立ち絵は扱わない。
- Unity で VMD モーションは再生しない。オーナーが選ぶ待機モーションも、感情に割り当てたモーションも対象外である。姿勢の経路と VMD の再生は同時に動かせない。
- Unity で `.vrma` クリップの表情トラックは再生しない。
- Unity に待機中の視線の動き、視線に合わせた頭の動き、目標を見る視線はない。考えるときの視線外しは目を動かす。視聴者を見る視線はステップ U5 で追加する。

## リスク

| リスク | 結果 | 対応 |
| --- | --- | --- |
| ELF-MN1 のプラグインに未公開の要件がある。 | プロジェクト設定が変わる。 | リリース時に注記を読む。Sony に関する利用はすべて `SrDisplay/` に閉じる。 |
| プラグインがフォーカスや全画面を必要とする。 | オーナーがチャットウィンドウを同時に使えない。 | ステップ U5 で実機で確認する。Sony は記載していない。 |
| UniVRM が Mono で動かない。 | ステップ U2 が止まる。 | U2 の最初に確認する。失敗したら Windows プラグインの IL2CPP 対応を調べる。 |
| unity-mmd-loader の新しい版で API が変わる。プロジェクトは 1.0 より前である。 | パッケージの更新に失敗する。 | リポジトリに v0.5.1 のコピーを置き、判断してから更新する。 |
| `AiriMmdHostPose` はローダーの内部 API を使う。 | パッケージの更新で動かなくなる可能性がある。 | このファイルはパッケージのコピーの中にあり、`vendor-patches.md` の更新手順に記載している。 |
| 毎秒 30 回の JSON で Unity の GC が止まる。 | 小さなカクつき。 | ステップ U3 の測定では、確保は毎秒約 450 KB、GC は 10 秒に 0〜1 回、60 fps の最大フレームは 17.1 ms である。そのため JSON のままとする。停止が見えるようになったら、このメッセージをバイナリに変える。 |
| Sony はビュースペース外の表示が快適さを損なうと警告している。 | オーナーが不快を感じうる。 | 境界からスケールを決め、Spatial Clipping をオンにして、実機で確認する。 |

## 出典

- [ELF-MN1 ダウンロード（スマートフォン）](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info)、[ELF-MN1 ダウンロード（Windows）](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/download-info2)
- [ELF-MN1 Prefab](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/srdmanagerprefab)、[World Scaling](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/worldscaling)、[Spatial Clipping](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/spatialclipping)、[Android ビルド](https://xyn.sony.net/en/developer/setup/spatial-reality-display-mini/unity/builds-for-android)
- [ELF-SR Unity クイックスタート](https://xyn.sony.net/en/developer/setup/spatial-reality-display/unity/quickstart)
- [UniVRM](https://github.com/vrm-c/UniVRM)
