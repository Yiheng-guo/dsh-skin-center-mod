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
├── mods/                  ★ 十四个补丁 + 原始基线，可直接 review / git apply
│   ├── 01-runtime-occlusion.patch       background.ts：运行时自绘遮蔽层
│   ├── 02-occlusion-tests.patch         background.spec.ts：+4 个测试，查找方式改为按属性
│   ├── 03-backdrop-media-policy.patch   decoration-layers.ts：视频背景生命周期 + 无障碍
│   ├── 04-legacy-bridge-before-seed.patch  index.ts：修 v1 升级静默丢皮肤
│   ├── 05-skin-id-single-pattern.patch  id 正则统一（校验器 + 注入器 + 2 个 spec）
│   ├── 06-stylesheet-link-leak.patch    skin-controller.ts：修 <head> 无界增长
│   ├── 07-provenance-hygiene.patch      忙等阻塞事件循环 / 临时目录泄漏 / 伪造市场来源
│   ├── 08-http-caching-and-integrity.patch  ETag+Range+transform memo / verify 默认只读 / 可服务性告警
│   ├── 09-frost-and-detector-consistency.patch  主开关失效 / 两个分歧的探测器
│   ├── baseline/          未改动的上游原文（review 用）
│   └── patched/           改后文件（对照用）
│
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

## 九处改动

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

**这九处改动都不涉及契约变更**：没有新增/删除 skin manifest 字段（v2 schema 是
`additionalProperties: false`，加字段就是契约变更），没有重命名任何已持久化的标识符、
线协议字段或 profile 格式，不破坏任何现有皮肤。

### 04 · v1 升级不再静默丢皮肤

插件原来**先**执行「默认皮肤种子」、**后**执行 v1→v2 legacy bridge。bridge 看到 v2 里已经
有选择了就跳过 id 迁移，**却仍然把旧段删掉** —— 所以 v1 老用户升级后，自己选的皮肤被
无声替换成 `blue-fantasy`，任何地方都没有报错（而种子上方的注释还宣称行为正好相反）。
改成先迁移、后种子。

### 05 · skin id 只有一份正则

校验器接受 `^[a-z][a-z0-9-]{0,31}$`（所以 `a-`、`x--y` 合法），注入器要求 kebab-case 并对
这些 id 抛异常。异常被 bootstrap 吞掉并降级成 stock look —— **这种皮肤能装、但永远不渲染**。
改成一份导出的 `SKIN_ID_PATTERN`，两边共用；kebab-case 是本项目脚手架本来的形状，所以
收紧的是校验器。收紧前核对过：**53 个已发布 id 全部同时满足两个正则**。

### 06 · 修 `<head>` 无界增长

`trackStylesheet` 记录拆卸时是**按 href 反查**元素的，而服务端为首屏预渲染了一个同 href 的
link 且排在更前面 —— 于是每次都删掉预渲染那个、**泄漏自己刚创建的那个**：每次切皮肤
`<head>` 多出最多两个 link，每个都是一次额外的样式重算，且终生不回收。改成由 loader 返回
自己创建的元素、按节点身份拆卸。

> **这里我要修正自己报告里的一处错误结论。** 报告曾说泄漏的 `patches` link 会在别的皮肤下
> 「继续上色」。**这是错的**：`transformSkinCss` 对 `skin.css` 和 `patches.css` 的每个选择器
> 都强制加了作用域，所以 `html[data-dsh-skin]` 一翻转，旧 link 的规则就完全失效。真实代价是
> **`<head>` 无界增长 + 样式重算开销**，新测试钉的是「有界」（而不是「清空」——那个预渲染的
> link 不属于任何一次激活，它本来就该留下）。


---

### 07 · provenance 层的三个缺陷

- **忙等阻塞事件循环** —— `repairSkinFromMarket` 用 `while (Date.now() - start < 50) {}` 等刚删掉的目录项落定（Windows 索引器/杀软会造成瞬时 `EBUSY`/`EPERM`）。**同步空转帮不上同步系统调用**，只会把宿主卡住最多 50ms。改成导出的异步 `renameWithRetry`：`setTimeout` 退避、10ms 起倍增至 1s 预算、只重试瞬时错误码、其余立即抛、预算耗尽抛最后一个瞬时错误。失败语义不变。
- **临时目录崩溃即泄漏** —— 原子写与修复路径都在 `finally` 里删临时目录，进程死在中间就永远留着，而且没有任何清扫。加了 `sweepStaleTempDirs`：精确模块前缀 + `mkdtempSync` 形状的 6 位尾、只删目录、只删超过 1 小时的、永不递归也永不抛，并按目录节流到每分钟一次（免得每次写入都多一次目录列举）。
- **信任门可以自称市场来源** —— 修复路径给**取自包内 `skins/` 的本地拷贝**写了 `source: 'dsh-market.com'`。而 provenance 正是之后判定用户目录皮肤 `hooks.mjs` 能否执行的那个输入。新增 `LOCAL_PROVENANCE_SOURCE = 'local'`：本地来源仍可做完整性校验，但**不获得市场信任、其 hooks 被拒**；内置皮肤改由「已审阅 hooks 注册表 + 字节哈希匹配」建立信任。市场安装的信任完全不变。

### 08 · HTTP 层的四个缺陷

- **资产整文件缓冲、不可缓存、不支持 seek** —— 每个 `assets/`/`preview/` 请求都 `readFileSync` 进内存并回 `no-store`，没有 `ETag` / `Last-Modified` / `Range`。6.6 MiB 的背景视频每次重载都全量重下，宿主每个请求持一份完整副本。现在：stat 派生强 `ETag` 与 `Last-Modified`、广播 `Accept-Ranges: bytes`、`If-None-Match`（支持列表与 `*`、容忍 weak；优先于 `If-Modified-Since`）回 `304` 无 body、单段 `bytes=` 回 `206` + `Content-Range`、不可满足回 `416` + `bytes */size`，body 用 `createReadStream` + `pipeline` 流式发送。
  > `bytes=-N` 我实现成**最后 N 字节**，**故意没有照抄** `src/we-routes.ts` 的实现 —— 那个 `/(\d*)-(\d*)/` 会把 `bytes=-500` 当成 `0-500`。**那个 bug 现在仍在 `we-routes.ts` 里**，属于未纳入项。
- **CSS transform 每次请求重跑** —— 它对 (skin id, 文件名, 文件字节) 是纯函数，现在按 `(skinId, filename, mtimeMs, size)` 记忆化，硬上限 64 条（约 32 个皮肤 × 2 张样式表，最坏几 MB，**不随请求数增长**），淘汰最久未用。**失败永不缓存** —— 白名单违规仍然每次 422。
- **完整性接口默认自动修复** —— `POST /v2/verify` 原来默认 `autoRepair: true`，等于任何调用者都能触发一次从 dsh-market.com 下载并**替换用户皮肤目录**的操作。默认改为只读报告，`{"autoRepair": true}` 仍可用；顺手把 `POST /verify` 补进了文件头那份路由清单。
- **清单可以引用取不到的路径并静默 404** —— 校验器接受任意相对路径，而只有 `assets/` 与 `preview/` 有路由，于是 `media/bg.webp` 能过校验、能安装，然后静默加载失败。现在扫描期给出 catalog 警告（**仅警告**，皮肤仍可安装，校验语法不变）。

### 09 · 磨砂与探测器的不一致

- **主开关关不掉输入卡磨砂** —— 磨砂原来由一个**样式表**规则施加：`blur(var(--dsh-input-card-blur, 10px)) !important`。两个后果：`!important` 的样式表规则压过任何运行时取值；而它的 10px 兜底在主开关**移除该变量之后依然生效** —— 所以「关」比「设成 0」更糟。规则已删除，改由运行时读 `document.body` 计算样式里的 `--dsh-input-card-blur`，把模糊内联画在 body 级 follower 上：变量缺失 ⇒ 不挂层、不模糊；存在但不可解析 ⇒ 10px 兼容兜底；其余夹到 0–20，0 即关闭。用 body 的 `style` 属性观察做实时重算（不轮询、rAF 合并）。
  **#1724 的不变量保持不变**：模糊仍然在一个独立的 body 级兄弟元素上，绝不落在输入卡本体（卡片一旦带非 none 的 `backdrop-filter`，就会成为 shell 里 `position:fixed` tooltip 的包含块）。
- **两个分歧的「会话有内容」探测器** —— `background.ts` 全文匹配**裸的** `[data-chat-anchor-key]`，而 `backdrop-scene.ts` 限定在 `[data-conversation-scroll]` 内、并明确记录了「旧话题选择行」正是误判源。切到空话题时，背景模糊与磨砂可能一个开一个不开。现在两边共用一个导出的、作用域限定到 scrollport 的选择器；裸形式已删除，而旧选择器覆盖到的官方 shell 行后缀在两个作用域里都保留。

## 验证

不是「写完看着对」。全部在上游仓库里真跑：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | **0 错误** |
| 测试 | `pnpm test` | **698 通过 / 15 失败** |
| 构建 | `pnpm build` | **成功**，`lib/index.js` + `lib/client.js`，改动标记均在产物中 |

**零回归是跑对照实验得出的**（在完全相同的 `skins/` 状态下）：

| | 测试总数 | 失败 | 通过 |
|---|---|---|---|
| 原始上游代码 | 639 | **15** | 624 |
| 本仓库的补丁 | 713 | **15** | **698** |

失败集合完全一致。那 15 个**全部**是 `ENOENT` / `Cannot find module` 指向仓库里的
**市场皮肤测试夹具**（`matrix` / `maid-atelier` / `orca-link` / `whale-mom` /
`ice-princess` / `mint` / `phoebe-atelier` / `wallpaper-exclusive` / `last-exile` /
`porco-rosso` / `white-snake`）—— 这些皮肤**本来就不在 npm 包里**（`files` 白名单只含
`skins/blue-fantasy`）。全量 **0 个 AssertionError / TypeError / ReferenceError**。

新增的 74 个测试全部通过，**每一个修复都被单独验证过「有牙」**——把对应的源码改动临时回退，
测试立即失败，恢复后再次通过。

**补丁可复现性**：十四个补丁 `patch -p1` 打到原始文件上，39 个文件（其中 3 个是新增文件）与 `mods/patched/` **逐字节一致**。

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

Beyond those two fixes, three defects from the survey are repaired in the same
series: the default-skin seed ran before the legacy v1→v2 bridge and silently
lost an upgrading user's chosen skin; the manifest validator and the index
injector disagreed about which skin ids are legal, so an id like `a-` installed
and then never rendered; and `trackStylesheet` looked its own `<link>` up by href
while the server pre-renders one with the same href, leaking up to two links into
`<head>` per switch for the life of the page.

**Verification** — all three upstream gates were run in the upstream tree:
`pnpm typecheck` 0 errors; `pnpm test` 698 passed / 15 failed with a **controlled
experiment proving zero regressions** (pristine upstream: 15 failed / 624 passed;
this fork: 15 failed / 698 passed — same failure set, every remaining failure a
missing market-skin test fixture that is not part of the npm package);
`pnpm build` succeeds with the changes present in the bundle. The patches apply
cleanly to pristine upstream and reproduce `mods/patched/` byte-for-byte across
thirty-nine files, and every fix in the series was individually shown to fail when
its source change is reverted.

No change alters the skin manifest schema (which is
`additionalProperties: false`, so a new field *would* be a contract change),
renames a persisted identifier, or breaks an existing skin.

**A correction.** The survey claimed a leaked `patches` link could keep painting
under another skin. That is wrong — the loader force-scopes every selector in
both stylesheets, so a stale link is inert once the skin attribute flips. The real
cost is unbounded `<head>` growth. The report and `mods/README.md` carry the
correction.

See [`MODDING-REPORT.md`](MODDING-REPORT.md) for the full analysis: architecture,
20+ evidenced defects across correctness/performance/security, the extension-point
inventory, and a prioritised roadmap with the remaining items.

Licensing and the upstream's own **license discrepancy** (`LICENSE` file is
BSD 3-Clause while `package.json` claims Apache-2.0) are documented in
[`NOTICE.md`](NOTICE.md).
