# dsh-skin-center-mod

一个 **DSH Web GUI 皮肤中心（`@linxin666/dsh-client-ui-skin-center`）的魔改 fork**：
修掉一处「滑杆是死的」结构性错位，给循环视频背景补上生命周期与无障碍策略，
外加两款原创皮肤和一套烤循环/校验/预览的工具链。

上游：[`zhu1090093659/dsh-skins`](https://github.com/zhu1090093659/dsh-skins) · fork 自 **v0.4.4** · 许可与归属见 [`NOTICE.md`](NOTICE.md)

---

## 一句话起因

皮肤中心的「背景遮蔽」滑杆**对多数皮肤是死的**。

`backgroundOpacity` 只被写成 `body` 上的一个 CSS 变量（`--dsw-skin-scrim`），运行时**自己不画任何东西** —— 它指望皮肤主动消费这个变量。而实测：

| CSS 变量 | `whale-fantasy`（社区皮肤） | `blue-fantasy`（内置） |
|---|---|---|
| `--dsw-skin-scrim`（背景遮蔽） | **0 次** | 16 次 |
| `--dsh-skin-bubble-alpha`（气泡不透明度） | **0 次** | 25 次 |
| `--dsh-skin-bubble-blur`（气泡模糊） | **0 次** | — |

把遮蔽从 0 拉到 40，**画面上什么都不会发生**；而卡片提示只要 manifest 声明了
`backgroundMedia` 就显示 —— 界面在展示一个对多数皮肤无效的控制项。

同一条链路上只有**模糊**是可靠的，因为它由运行时自绘，与皮肤无关。
`mods/01` 就是把遮蔽也变成运行时自绘。

---

## 仓库结构

```
├── README.md              本文件
├── NOTICE.md              归属、上游许可证矛盾、改动范围
├── LICENSE                BSD 3-Clause（保留上游版权声明）
│
├── MODDING-REPORT.md      ★ 全文分析：架构、20+ 条带 file:line 的缺陷、扩展点、21 项路线图
│
├── mods/                  ★ 三个补丁 + 原始基线，可直接 review / git apply
│   ├── 01-runtime-occlusion.patch      background.ts：运行时自绘遮蔽层
│   ├── 02-occlusion-tests.patch        background.spec.ts：+4 个测试，查找方式改为按属性
│   ├── 03-backdrop-media-policy.patch  decoration-layers.ts：视频背景生命周期 + 无障碍
│   ├── baseline/          未改动的上游原文（review 用）
│   └── patched/           改后文件（对照用）
│
├── skins/                 ★ 两款原创 v2 皮肤
│   ├── cyber-maiden/      女仆少女 · 冷钢之夜（13.57s 循环，1.03 MiB）
│   └── cyber-abyss/       深蓝深渊 · 数据流（16.57s 循环，4.26 MiB）
│
├── tools/                 工具链（不含二进制）
│   ├── build-skin.py          调色板 JSON → skin.css（N 个皮肤共用）
│   ├── palettes/              一个皮肤一个调色板文件 = 唯一真相源
│   ├── bake-loop.sh           任何视频 → 无缝循环 + 自动无缝判定
│   ├── validate-skin.mjs      跑皮肤中心的**真校验器**
│   ├── render-preview.mjs     headless Chrome 渲染预览（走真实 transform 输出）
│   ├── make-comparison.py     拼对比图
│   ├── validator/             皮肤中心校验源码的逐字节拷贝（诚实本地验证用）
│   └── source-audit/          6 条底片的全尺寸审计截图
│
└── docs/
    └── skins-and-loop-guide.md   两款皮肤的完整工程说明（量色数据、踩坑记录）
```

---

## 两个改动

### 01 · 让遮蔽真正生效

运行时自绘一个 body 级 fixed 遮罩层（`data-dsh-backdrop-scrim`），
`background: var(--dsw-skin-scrim-color, #000)` + `opacity = 遮蔽值/100`。

- 与已有的模糊层同一 `z-index: -1`，并**插在模糊层之前** —— 让模糊去采样「已加纱的画面」而不是原始视频
- 完全复用模糊层已有的生命周期：主开关 → 移除；WE 壁纸挂载 → 移除（壁纸自带调暗）；值为 0 → 移除；值未变 → 不写样式
- 顺手修掉 `dispose()` 把 `--dsw-skin-scrim` 留在 `body` 上的原有缺陷

### 03 · 视频背景的生命周期与无障碍

- `clearLayer()` 在摘除节点前先跑媒体策略的 teardown 并 `pause()` —— 裸摘的 `<video>` 在部分浏览器里继续解码，监听器也会活过本次激活
- `preload="metadata"` —— 默认 `auto` 会在首屏前把整段几 MB 拉完，而这层可能永远不可见
- 新增稳定钩子 `data-dsh-backdrop-media`，让 `patches.css` 与第三方不必猜层级或哈希类名
- `visibilitychange` **隐藏即暂停**、可见恢复
- `prefers-reduced-motion: reduce` 时**不自动播放、解出一帧后按住**（仍给到画面，只是不动）

> 这一条对着上游自己的性能契约 `contracts/performance-guidelines-v1.md` 的 **R3**：
> 契约明确要求「帧循环与无限动画必须在隐藏时暂停」，而 WE 壁纸那条路径实现了
> （`client/wallpaper.ts`）、**背景视频没有** —— 同一产品两套标准。

**两个改动都不涉及契约变更**：没有新增/删除 skin manifest 字段（v2 schema 是
`additionalProperties: false`，加字段就是契约变更），没有重命名任何已持久化的标识符、
线协议字段或 profile 格式，不破坏任何现有皮肤。

---

## 验证

不是「写完看着对」。全部在上游仓库里真跑：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | **0 错误** |
| 测试 | `pnpm test` | **628 通过 / 15 失败** |
| 构建 | `pnpm build` | **成功**，`lib/index.js` 354 KB + `lib/client.js` 294 KB，改动标记均在产物中 |

**零回归是跑对照实验得出的**（在完全相同的 `skins/` 状态下）：

| | 测试总数 | 失败 | 通过 |
|---|---|---|---|
| 原始上游代码 | 639 | **15** | 624 |
| 本仓库的补丁 | 643 | **15** | **628** |

失败集合完全一致。那 15 个**全部**是 `ENOENT` / `Cannot find module` 指向仓库里的
**市场皮肤测试夹具**（`matrix` / `maid-atelier` / `orca-link` / `whale-mom` /
`ice-princess` / `mint` / `phoebe-atelier` / `wallpaper-exclusive` / `last-exile` /
`porco-rosso` / `white-snake`）—— 这些皮肤**本来就不在 npm 包里**（`files` 白名单只含
`skins/blue-fantasy`）。全量 **0 个 AssertionError / TypeError / ReferenceError**。

**补丁可复现性**：三个补丁 `patch -p1` 打到原始文件上，结果与 `mods/patched/` **逐字节一致**。

---

## 怎么用

### A. 直接装成 dev fork（最省事）

```sh
# 需要一个上游源码 checkout（含构建依赖），把 mods/ 打进去
git clone https://github.com/zhu1090093659/dsh-skins && cd dsh-skins
patch -p1 < /path/to/mods/01-runtime-occlusion.patch
patch -p1 < /path/to/mods/02-occlusion-tests.patch
patch -p1 < /path/to/mods/03-backdrop-media-policy.patch

pnpm install
pnpm typecheck && pnpm test && pnpm build

# 以 link: 方式挂进 DSH profile（与 dsh-boot-animation-pro 同一种挂法）
dsh plugin --profile desktop add link:$PWD
```

**回滚**（回到 npm 上的官方版）：

```sh
dsh plugin --profile desktop add @linxin666/dsh-client-ui-skin-center
```

> 上游仓库的 `skins/` 有 200 MB 皮肤素材。只要不是跑全量测试，可以只取代码：
> `git sparse-checkout set src contracts docs scripts tests shared`。

### B. 只提 PR

`mods/` 里每个补丁都是对**单个上游文件**的 unified diff，带原始基线，可直接开 PR。
建议拆成三个提交（Conventional Commits）：

```
fix(skin-center): paint the occlusion veil in the runtime
test(skin-center): cover the runtime occlusion veil
fix(skin-center): give the backdrop video a lifecycle policy
```

`MODDING-REPORT.md` 里还有 18 项未实现的改进，含落点、工作量与是否需要契约变更。

### C. 用这两款皮肤

```sh
cp -R skins/cyber-maiden skins/cyber-abyss ~/.dsh/skins/
# 重开卡片或刷新页面即被目录册收录（皮肤本身不需要重启 DSH）
```

改调色板：编辑 `tools/palettes/<id>.json`，然后

```sh
python3 tools/build-skin.py cyber-maiden     # 重新生成 skin.css
node tools/validate-skin.mjs cyber-maiden    # 跑官方真校验器
node tools/render-preview.mjs cyber-maiden   # 重出预览图
```

**加一个皮肤 = 一个调色板 JSON + 一段视频**，不用写 CSS：
两款皮肤逐字节共用 `patches.css`，材质变量是中性前缀 `--skin-*`。

---

## 工具链的一个真实教训

`tools/render-preview.mjs` 渲染的预览，用的 CSS 是**皮肤中心 `transformSkinCss()` 的真实输出**，
不是手写的近似。所以预览里看到什么，加载器就画什么。

`tools/bake-loop.sh` 每次烤完会自动量四个数并给判决：

```
first/last: mean luma 33.90 / 33.96   (limited-range black is Y=16, not 0)
seam PSNR : 40.27 dB   (first frame vs last frame)
head splice: 55.32 dB   (frame 0 vs frame 1)
tail splice: 51.43 dB   (last frame vs its neighbour)
verdict   : seamless
```

> 途中抓到四个真问题，都固化成了守卫：
> ① 底片**第 0 帧是黑帧** → 「首末帧平均差」验出 0.008 是**假阳性**（两个都偏黑的帧互相比），
> 真正抓到它的是**端点硬切检测**；
> ② 有限范围 YUV 下**黑的 Y 是 16 不是 0**；
> ③ 所谓的 1080p 宣传素材其实是**播放器录屏**，画面里烧着「跳过」按钮与进度条，
> **缩略图上看不出来**；
> ④ `setpts=PTS*30/90` 是**加速**不是减速（PTS 乘法方向）。

---

## English summary

A **modified fork of the DSH Skin Center plugin** (`@linxin666/dsh-client-ui-skin-center`
v0.4.4), plus two original skins and the tooling that builds them.

The motivating finding: the Skin Center's **background-occlusion slider is inert for
most skins**. `backgroundOpacity` is only written to a CSS variable that the skin
itself must consume — the runtime paints nothing. The community skin `whale-fantasy`
consumes that variable **0 times** (the bundled `blue-fantasy` consumes it 16 times),
so moving the slider from 0 to 40 changes nothing on screen, while the UI keeps
showing the control. `mods/01` makes the runtime paint the veil itself.

`mods/03` gives the looping backdrop `<video>` the lifecycle and accessibility policy
it lacks: pause while the document is hidden (the wallpaper path already does this,
and the repository's own performance contract R3 *requires* it), honour
`prefers-reduced-motion` by holding one frame, `preload="metadata"`, an explicit
teardown, and a stable hook attribute.

**Verification** — all three upstream gates were run in the upstream tree:
`pnpm typecheck` 0 errors; `pnpm test` 628 passed / 15 failed with a **controlled
experiment proving zero regressions** (pristine upstream: 15 failed / 624 passed;
this fork: 15 failed / 628 passed — same failure set, every remaining failure a
missing market-skin test fixture that is not part of the npm package);
`pnpm build` succeeds with the changes present in the bundle. The patches apply
cleanly to pristine upstream and reproduce `mods/patched/` byte-for-byte.

Neither change alters the skin manifest schema (which is
`additionalProperties: false`, so a new field *would* be a contract change),
renames a persisted identifier, or breaks an existing skin.

See [`MODDING-REPORT.md`](MODDING-REPORT.md) for the full analysis: architecture,
20+ evidenced defects across correctness/performance/security, the extension-point
inventory, and a 21-item prioritised roadmap.

Licensing and the upstream's own **license discrepancy** (`LICENSE` file is
BSD 3-Clause while `package.json` claims Apache-2.0) are documented in
[`NOTICE.md`](NOTICE.md).
