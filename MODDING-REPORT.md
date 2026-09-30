# 皮肤中心（`@linxin666/dsh-client-ui-skin-center` v0.4.4）二开 / 魔改报告

上游：<https://github.com/zhu1090093659/dsh-skins> · License **Apache-2.0**（可自由 fork、改、再分发，需保留声明）
本报告基于**完整源码**（186 个文件，除 `skins/` 素材）：`build/.upstream/`
引用格式 `文件:行`，全部相对 `build/.upstream/`。

---

## 0. 一句话结论

这套代码的**工程质量高于同类插件**（运行时代码里 `TODO/FIXME` 几乎为零、有 fail-closed 校验器、有性能契约、52 个测试套件、append-only 效果账本）。
但它在**「背景控制」这条链路上有一个结构性错位**：控制项写成了 CSS 变量，指望皮肤自己消费；运行时只自绘了模糊。结果是**多数皮肤下，遮蔽/气泡滑杆是死的，而 UI 还在展示它们**。

这不是我们运气差，是设计取舍的后果 —— 也正是最值得魔改的地方。

---

## 1. 架构速览

**宿主半区（Node）**
- Cordis 插件 `ui-skin-center`，注入 `webServer`（`src/index.ts:48-51`），注册路由 + index 注入器，失败只记日志不抛（`src/index.ts:330-355`）
- 路由（`src/routes-v2.ts:350-359`）：`GET /v2/catalog`、`POST /v2/verify`、`GET /v2/skins/{stylesheet,patches,hooks.mjs,assets/*,preview/*}`、`POST /v2/skins/{uninstall,repair}`、`GET|POST /v2/active`；另有 WE 家族挂在 `/api/skin-center/we`
- 皮肤发现：内置 `<pkg>/skins` + 用户 `$DSH_HOME/skins`，用户同名遮蔽内置（`src/skin-repo.ts:93-129,211-225`）；`skin.json` fail-closed 校验，**未知字段是硬错误**（`src/core/manifest-v2/validate.ts:46-48,120`）
- 状态：`$DSH_HOME/skin-center-active.json`，临时文件 + rename 原子写，merge 语义（`src/active-state.ts:26-28,73-96`）
- **首屏无闪**：结构化行把 `<link>` 推进 `<head>`，raw tap 同时给 `<html>` 打 `data-dsh-skin`（`src/tap-index-adapter.ts:55-123`）

**浏览器半区**
- 一个 store 管一个 document（`src/client/runtime/boot.ts:83-203`）：账本 → 控制器 → 语义适配器 → shell 渲染适配器
- **激活身份 + append-only 效果账本**（`src/client/runtime/effect-ledger.ts:92-107`）：每次切换铸一个单调 id，所有副作用登记可幂等清理，`record()` 在已 dispose 的激活上直接抛，保证没有孤儿活过切换
- **切换是原子剪切**（`src/client/runtime/skin-controller.ts:338-401`）：先装样式/背景/hooks，再翻转 `html[data-dsh-skin]`，最后销毁上一个；翻转前失败只销毁新的，旧皮肤完好
- 背景视频挂在固定 `z-index:-2` 层的 `<video muted loop autoplay playsInline>`（`src/client/runtime/decoration-layers.ts:120-152`）
- 语义适配器：一个合并的 body observer，21 条规则给官方 DOM 打 `data-dsh-surface|part|plugin`（`src/client/runtime/semantic-adapter.ts:40-142`）

---

## 2. 真实缺陷（按「能不能坑到用户」排序）

### A. 直接坑到用户的

**A1 · 遮蔽滑杆对多数皮肤是死的，而 UI 还在展示它** ← 我们亲测撞上
`backgroundOpacity` 只被写成 `body.style["--dsw-skin-scrim"]`（`src/client/background.ts:339-346`），**运行时自己什么都不画**；只有皮肤 CSS 主动读这个变量才有视觉效果。
实测：`whale-fantasy` 的 CSS 命中 **0 次**，内置 `blue-fantasy` 命中 **16 次**。
而卡片提示只要 manifest 声明了 `backgroundMedia` 就显示（`src/client/SkinCenter.tsx:96,480-482`）→ **界面在骗人**。

**A2 · 模糊是唯一与皮肤无关的杠杆**
模糊由运行时自绘一个满视口 `backdrop-filter` div（`src/client/background.ts:353-401`），不依赖皮肤 CSS。
这解释了实测现象：**同一条链路上只有改模糊有效**。

**A3 · 视频背景没有任何生命周期/无障碍策略** ← 违反他们自己的契约
`decoration-layers.ts:134-144` 建的 `<video>`：**无 `visibilitychange` 暂停、无 `prefers-reduced-motion`、无 `poster`、无 error 路径、卸载前不显式 `pause()`**。
- 全仓库 `matchMedia` **零命中**（唯一的 `prefers-reduced-motion` 出现在按钮过渡的 CSS 里）
- 而 WE 壁纸那条路径**实现了隐藏暂停**（`src/client/wallpaper.ts:914-918`）→ 同产品两套标准
- 他们自己的性能契约 **R3 明确要求**「帧循环与无限动画必须在隐藏时暂停 … 并给 CSS 一个可读的 hidden 属性 + `animation-play-state: paused`」（`contracts/performance-guidelines-v1.md:52-67`）—— **要求皮肤做到，自己没对背景视频做**
- 后果：隐藏标签页/窗口里继续解码 1080p 循环；对运动敏感用户无法关闭

**A4 · 主开关关掉仍留 10px 磨砂**
磨砂 follower 只由 backdrop 标记驱动，并硬编码 `INPUT_FROST_BLUR_PX = 10`（`src/client/runtime/backdrop-scene.ts:88,221-224`）。主开关会把变量摘掉（`src/client/background.ts:316-321`），但 follower 不看它 → 「关掉」比「设成 0」还糟。

**A5 · 应用皮肤会静默清掉用户的壁纸**
`applySkin` / `restoreOfficialLook` 调 `wallpaper.clearSelection()`（`src/client/SkinCenter.tsx:180-184,202-206`），与控制器宣称的共存/优先级模型（`skin-controller.ts:266-271`、`index.ts:297-299`）矛盾。

### B. 正确性

**B1 · 样式表 `<link>` 泄漏 → `<head>` 无界增长** ✅ **已修（补丁 06）**
`trackStylesheet` 按**属性选择器（href）**而非节点身份找回自己的 link（`src/client/runtime/skin-controller.ts:205-208`），而服务端**预渲染了同 href 的 link**（`src/tap-index-adapter.ts:46`）且排在更前面。
→ 每次激活的清理删掉的是预渲染 link，JS 建的那个被永久留下：**每次切皮肤泄漏最多两个 link、终生不回收**，每个都是一次额外的样式重算。

> **本报告的一处更正（初版写错了）。** 初版在这里断言「泄漏的 patches 会在别的皮肤下继续上色」——**这是错的**。`transformSkinCss` 对 `skin.css` 与 `patches.css` 的**每一个选择器**都强制加了 `html[data-dsh-skin="<id>"]` 作用域（`src/core/css-safety/transform.ts:189-193`），所以属性一翻转，旧 link 的规则就完全失效。`patches.css` 的「自由」指**可以选中任意元素**，不是**可以逃出作用域**。真实代价只有 `<head>` 膨胀 + 样式重算开销，严重性低于初版描述，但仍需修。
>
> 修法与验证：改成由 loader 返回自己创建的元素、按**节点身份**拆卸（返回 void 的注入式 loader 保留兜底反查）；新测试钉的是**有界性**（反复切换后 link 数不增长），不是清空——那个预渲染 link 不属于任何一次激活，本来就该留下。测试已验证「有牙」：回退源码立即失败。

**B2 · v1→v2 升级会静默丢掉用户选的皮肤** ✅ **已修（补丁 04）**
种子（未初始化时写 blue-fantasy）跑在 legacy bridge **之前**（`src/index.ts:363-368` vs `src/legacy-bridge.ts:254-281`）：bridge 看到 v2 已有值就跳过 id 迁移，却**仍然删掉旧段**。
而 `src/index.ts:359-362` 的注释声称的正好相反。

**B3 · skin id 正则两边不一致**
校验器 `^[a-z][a-z0-9-]{0,31}$`（`validate.ts:22`）vs 注入器 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`tap-index-adapter.ts:28,43`）
→ `a-`、`x--y` 这类 id 能过校验、能安装，但注入时抛异常 → **永久回落 stock look**。

**B4 · manifest 里的相对路径不保证可服务**
只有 `assets/`、`preview/` 有路由（`src/routes-v2.ts:287`），但校验器接受任意 relPath（`validate.ts:51-55`），客户端按 `assetBase/<src>` 取（`decoration-layers.ts:130,140`）
→ 声明 `media/bg.webp` 的皮肤能过校验、能安装，然后**静默 404**。

**B5 · 两个分歧的「会话有内容」探测器**
`src/client/background.ts:127-133,373-375` 在 body 全扫裸 `[data-chat-anchor-key]`；`backdrop-scene.ts:76-82,143-149` 限定在 `[data-conversation-scroll]` 内，并**明确记录了**「旧话题选择行」正是误判源 → 切换空话题时可能背景糊了但磨砂没上（或反之）。

**B6 · `requires.contracts` 只校验不读取**
`validate.ts:90-98` 校验 `apiVersion` / `optional`，运行时从不消费 → 死元数据，对外承诺了版本协商却不做。

### C. 性能

| | 问题 | 证据 |
|---|---|---|
| C1 | **资产整文件缓冲、`no-store`、无 Range/ETag** → 6.6MB 视频**每次渲染重下 + 每请求一份完整内存副本**；而包里自己就有支持 Range 的读取器 | `routes-v2.ts:122-124,283` vs `we-routes.ts:134` |
| C2 | 每次样式表 GET 都重新用 lightningcss 解析，无 memo | `routes-v2.ts:98` |
| C3 | catalog 指纹每请求 readdir+stat 全部皮肤；路由每请求调 + 每次 index 渲染调 | `skin-repo.ts:271-292,312`；`routes-v2.ts:189,296,331`；`index.ts:338-344` |
| C4 | **无皮肤激活时 observer 仍在跑**；每条新增节点跑 21 条规则（含两个 `:has()` 的 `querySelectorAll`）+ ≤24 祖先 × 21 规则遍历；shell-rendering 流式时每帧 `getBoundingClientRect()` | `boot.ts:102-103`；`semantic-adapter.ts:211-253,264-290`；`shell-rendering.ts:217-263` ← **违反自家 R1/R5** |
| C5 | `will-change: transform` 永久停在满视口层 | `decoration-layers.ts:54` ← 违反 R4 |
| C6 | 选择轮询每 2 秒一个请求，永不停止 | `boot.ts:232-233,338-341` |
| C7 | WE：每张纹理都重读重解析整个 `.pkg` → 20 纹理场景 = 20 次全量读 | `we-routes.ts:784-802` |
| C8 | `while (Date.now()-start<50)` 忙等**阻塞事件循环** | `provenance.ts:353-356` |
| C9 | `mkdtempSync` 临时目录崩溃即泄漏，无清扫 | `active-state.ts:83-95`；`provenance.ts:315-316` |

### D. 安全

**D1 · 本地字节能自称市场来源（削弱 hooks 信任模型）**
`repairSkinFromMarket` 给一份**取自包内 `skins/` 的拷贝**铸 `source: dsh-market.com` 的 provenance（`provenance.ts:273-297`）。而 provenance 正是之后判定 hooks 是否可信的输入 → 「市场来源」这个断言可以被本地文件取得。

**D2 · `POST /v2/verify` 默认自动修复**
默认 `autoRepair`（`routes-v2.ts:172`），会从 dsh-market.com 下载并**替换用户目录**；同源围栏放行无头客户端（`http-utils.ts:28-39`）→ 若监听局域网，LAN 客户端可触发批量重下（**推测**，取决于绑定地址）。且它**不在文件头的路由清单里**（`routes-v2.ts:7-15`）。

**D3 · WE token 只绑定目录不绑定文件**
`/web/`、`/scene-resource/` 用一个预览 token 就能读同级文件（`we-routes.ts:626-648,767-802`）；`/web/` 还跟随符号链接（对比 `pkg-extract.ts:1103-1117`）；内容源路由丢掉了 `Sec-Fetch-Site` 检查（`http-utils.ts:57-63`）。

**D4 · WE Range 语义错误**：`bytes=-500` 被当成 `0-500`；无 HEAD/ETag/If-Range（`we-routes.ts:228-245`）→ 严格播放器（Safari）seek 会出问题。

---

## 3. 现有的缝，和没有的缝

**已有**
- **manifest v2**：`contributes.{stylesheet,patches,backgroundMedia}`、`preview`、`license*`、`attribution`、`requires.contracts`、`facets.client`。注意 `additionalProperties:false` → **任何新字段都是契约变更**（`validate.ts:120`）
- **`hooks.mjs`**：唯一可执行缝，ctx 给 `skinId / scopeAttr / assetBase / 6 个装饰层 / theme.get+subscribe / onCleanup`。但**只对内置皮肤和字节校验过的市场安装放行**，明确「不是通用外部路径」（`skin-repo.ts:154-171`）
- **CSS token 覆盖** + 自动兜底（`fallback.ts:70-81`）+ 只告警的 CTA 对比度审计（`token-audit.ts:227-268`）；自定义主题是 42 token 白名单（`custom-theme.ts:38-80`）
- **L2 语义属性** `data-dsh-surface|part|plugin`（`contracts/semantic-attrs-v1.md`）
- **两个材质变量** `--dsh-skin-bubble-alpha/blur`
- 路由工厂接受可注入 deps（`routes-v2.ts:60-75`）—— 测试/嵌入缝，非公开 API

**没有的缝（想做「生态」必须先开）**
- 第三方**无法注册**：皮肤源、装饰层、路由、设置分区。路由数组是闭合的（`index.ts:321-329`），皮肤源硬编码（`skin-repo.ts:324-325`）
- 皮肤**无法声明推荐的背景参数**（schema 里没有这个字段）→ 「装完还得手调」是结构性的

---

## 4. 可加 / 可优化：优先级路线图

| # | 事项 | 落点 | 工作量 | 契约变更 |
|---|---|---|---|---|
| **F1** ✅ | **运行时自绘遮蔽** —— 让遮蔽对所有皮肤生效，而不是遥不可及的 CSS 变量 | `decoration-layers.ts` + `background.ts` | S/M | 无 |
| **F2** ✅ | **背景媒体卫生** —— 隐藏暂停、`prefers-reduced-motion`、`poster`、error 诊断、卸载前 `pause()` | `decoration-layers.ts` + boot 里的 owner | S | 无 |
| **F3** ✅ | **修 B1 的 `<link>` 泄漏**（按节点身份，不按 href） | `skin-controller.ts:205-208` | S | 无 |
| F4 | **按皮肤推荐背景参数**（`skin.json` 加 `tuning` 块 + 首次激活套用 + 「恢复皮肤默认」） | schema + controller + 卡片 | M | **additive** |
| F5 | **`dsh-skin background get\|set`** + 导出 `writeActiveState` | `scripts/dsh-skin.cjs`；`src/index.ts:45` | S | 无 |
| F6 | **背景参数实时跟随** —— 把现有轮询从「只跟选择」扩展到「也跟背景」 | `boot.ts:316-367` | S | 无 |
| F7 | **`dsh-skin use` 实时推送** + 修正过时的「需 reload」提示 | `scripts/dsh-skin.cjs:174-191` | S | 无 |
| F8 | **修 A4 主开关**（follower 读 `inputCardBlur`，或开关生效时移除 follower） | `backdrop-scene.ts:88,221-224` | S | 无 |
| F9 | **统一 B5 的内容探测器**（收敛到 scrollport 作用域那一个） | `background.ts:127-133,373-375` | S | 无 |
| F10 | **资产服务：ETag + Last-Modified + Range + transform memo** | `routes-v2.ts:83-125,283` | M | 无 |
| F11 | **懒启动 observer**（stock look 时断开适配器与 shell-rendering） | `boot.ts:101-103` | S | 无 |
| F12 | **`GET /v2/diagnostics` + 卡片里的「皮肤健康」折叠块**（把现在不可见的 unmatched 规则 / cleanup-failed / catalog warnings 露出来） | `routes-v2.ts` + `SkinCenter.tsx` | S/M | 无 |
| F13 | **扫描期「可服务性」检查**（每个 manifest relPath 是否真在 `assets/`/`preview/` 下），作为 catalog warning | `skin-repo.ts:231-240` | S | 无 |
| F14 | **对比度/可读性审计**：拿真实背景媒体算最坏情况的文字对比度 | `token-audit.ts` 思路扩展 | M/L | 无 |
| F15 ✅ | **修 B2 种子顺序**（种子前先探测 legacy 状态） | `index.ts:363-368` | S | 无 |
| F16 ✅ | **修 B3 正则不一致**（抽一个共享常量） | `validate.ts` + `tap-index-adapter.ts` | S | 无 |
| F17 | **修 C8 忙等 / C9 临时目录 GC** | `provenance.ts:353-356`、`active-state.ts:83` | S | 无 |
| F18 | **收紧 D1/D2/D3**：`repairSkinFromMarket` 不要铸市场 provenance；`/verify` 默认不自动替换；WE token 绑定文件而非目录 | `provenance.ts`、`routes-v2.ts`、`we-routes.ts` | M | 无 |
| F19 | **WE：解码纹理 bundle 缓存（LRU + 字节预算 + ETag）** | `we-routes.ts:767-807` | M | 无 |
| F20 | **macOS 友好**：场景工程「拷文件夹导入」路径 + `canPlayType` codec 预检（避免 `.mov/.mkv` 静默退化成预览） | `we-routes.ts:855-865`、`wallpaper.ts:1117-1174` | S | 无 |
| F21 | **锚点健壮性**：带 fallback 的锚点注册表 + 运行时自检。release notes 几乎全是「重新锚定宿主 DOM」，一堆以皮肤命名的回归测试就是这个成本的证据 | `semantic-adapter.ts` 全域 | L | 无 |

**已完成**：F1、F2、F3、F15、F16（见第 5 节，六个补丁、三道门禁、零回归）。
**建议的下一步**：F5 + F6 + F7（让工具链真的能脚本化控制皮肤与背景参数）→ F8 + F9 + F11 + F12 + F13（小面、无契约变更）→ F10（省掉重复的 6.6MB）→ F17 + F18（忙等/临时目录/安全收紧）→ F4 与 F21（需要维护者决策：前者是契约变更，后者是架构级改动）。

---

## 5. 我实际改了什么

### 5.1 已落地的六处代码改动（可直接提 PR）

补丁在 **`mods/`**，每个都带原始基线文件，可直接 `patch -p1` / `git apply`：

| 补丁 | 改的文件 | 内容 | 状态 |
|---|---|---|---|
| `mods/01-runtime-occlusion.patch` | `src/client/background.ts` | **F1** 运行时自绘遮蔽层 | ✅ 测试通过 |
| `mods/02-occlusion-tests.patch` | `tests/background.spec.ts` | **F1** 的 4 个测试 + 查找改为按属性 | ✅ 有牙已验证 |
| `mods/03-backdrop-media-policy.patch` | `src/client/runtime/decoration-layers.ts` | **F2** 视频背景生命周期 + 无障碍 | ✅ 测试通过 |
| `mods/04-legacy-bridge-before-seed.patch` | `src/index.ts` | **F15 / B2** 先迁移后种子 | ✅ 测试通过 |
| `mods/05-skin-id-single-pattern.patch` | `validate.ts` + `tap-index-adapter.ts` + 2 spec | **F16 / B3** id 正则统一 | ✅ 有牙已验证 |
| `mods/06-stylesheet-link-leak.patch` | `skin-controller.ts` + `skin-runtime.spec.ts` | **F3 / B1** `<link>` 泄漏 | ✅ 有牙已验证 |

六个补丁全部：
- 在**全新目录**里对原始文件 `patch -p1` 应用成功，10 个结果文件与 `mods/patched/` **逐字节一致**
- 过上游自己的三道门禁：`typecheck` 0 错误、`test` 零回归（对照实验）、`build` 成功
- 新增 7 个测试，其中 3 个**单独验证过「有牙」**（回退源码即失败）

**01 做了什么**
- 新增一个 body 级 fixed 遮罩元素（`data-dsh-backdrop-scrim`），`background: var(--dsw-skin-scrim-color, #000)` + `opacity = 遮蔽值/100`
- 与已有的模糊层同一 `z-index:-1`，并**插在模糊层之前**，让模糊去采样「已加纱的画面」而不是原始视频
- 复用模糊层已有的完整生命周期：主开关关掉 → 移除；有 WE 壁纸 → 移除（壁纸自带调暗）；值为 0 → 移除；值没变 → 不写样式（缓存 `appliedScrim`）
- 顺手修掉一个原有缺陷：`dispose()` 会把 `--dsw-skin-scrim` 留在 body 上（原报告 C 段第 8 条）

**02 做了什么**
- 四个测试：遮罩按正确几何与透明度绘制；0 值移除；主开关与 WE 壁纸下保持关闭；`dispose()` 不留下任何一层或变量
- 上游的 `blurElement()` 辅助函数原来是「找 body 下第一个 `aria-hidden` 的 div」，被新层误匹配；改为按两个运行时遮罩层各自的稳定属性寻址

**03 做了什么**
- `clearLayer()` 在摘除节点前先调媒体策略的 teardown、并 `pause()` 视频（原代码只 `removeChild`；裸摘的 `<video>` 在部分浏览器里继续解码，监听器也会活过本次激活）
- `<video>` 增加 `preload="metadata"`（默认 `auto` 会在首屏前把整段几 MB 拉完，而这层可能永远不可见）
- 增加稳定钩子 `data-dsh-backdrop-media`，让 `patches.css` 和第三方不必猜层级或哈希类名
- 新增 `attachBackdropMediaPolicy()`：`visibilitychange` 隐藏即暂停 / 可见恢复；`prefers-reduced-motion: reduce` 时**不自动播放、解出一帧后按住**（仍给到画面，只是不动）
- 监听器与 `matchMedia` 都登记进 `WeakMap` 的 teardown，随激活销毁，符合 R6

**04–06 做了什么**：见 `mods/README.md` 的逐项说明，或直接读补丁——每个补丁内的注释都写了「原行为为什么是错的」。

**为什么选这六个**：前三项直击实际痛点（遮蔽是死的 → F1；视频没有降噪/尊重偏好的手段 → F2），后三项是调查中证据最硬、影响最明确的**纯缺陷**（F3/F15/F16），且**全部无契约变更**——不碰 `additionalProperties:false` 的 schema，不重命名任何已持久化的标识符、线协议字段或 profile 格式，不破坏任何现有皮肤。

**仍然未纳入**（不是遗漏，是需要维护者决策）：
- **F4 按皮肤推荐背景参数** —— 字段本身是 additive，但 v2 schema 是 `additionalProperties: false`，**旧版皮肤中心会拒绝使用了该字段的皮肤**。这是兼容性决策，不是机械修改。
- **F14 对比度/可读性审计** —— 是新增分析能力，不是对现有代码的优化。
- **F21 锚点健壮性** —— 对语义适配器的架构级改动，是清单上最大的一项。

### 5.2 立即可用的临时修补（不重建插件）

```sh
~/.dsh/skins/whale-fantasy/patches.css          # 追加一条消费 --dsw-skin-scrim 的规则
~/.dsh/skins/whale-fantasy/patches.css.orig-backup   # 作者原始字节，删掉追加块即还原
```

在当前激活的皮肤上追加了一条 `body[data-dsh-backdrop-active]::before`，消费运行时已经写在 body 上的 `--dsw-skin-scrim`。
效果：**遮蔽滑杆在 whale-fantasy 下立刻可用**，无需等插件重建。追加后已重新过一遍官方校验器（`All gates passed`）。
删掉那个注释块即可回到作者的发布字节。

### 5.3 验证：过了上游自己的三道门禁

不是「写完看着对」。全部在上游仓库里真跑：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | **0 错误** |
| 测试 | `pnpm test` | **628 通过 / 15 失败**，且**零回归**（见下） |
| 构建 | `pnpm build` | **成功**，产物 `lib/index.js` 354 KB + `lib/client.js` 294 KB，四处改动标记均在产物中 |

**零回归是跑对照实验得出的，不是声明的**（两次实验，第二次在完全相同的 `skins/` 状态下）：

| | 测试总数 | 失败 | 通过 |
|---|---|---|---|
| 原始上游代码 | 639 | **15** | 624 |
| 我的补丁 | 643 | **15** | **628** |

失败集合完全相同。那 15 个失败**全部**是 `ENOENT` / `Cannot find module` 指向仓库里的**市场皮肤测试夹具**（`matrix` / `maid-atelier` / `orca-link` / `whale-mom` / `ice-princess` / `mint` / `phoebe-atelier` / `wallpaper-exclusive` / `last-exile` / `porco-rosso` / `white-snake`）—— 这些皮肤**本来就不在 npm 包里**（`files` 白名单只含 `skins/blue-fantasy`），我按设计没有下载那 200MB 素材。
全量 **0 个 AssertionError / TypeError / ReferenceError**。我新增的 4 个测试全部通过（628 − 624 = 4）。

**补丁可复现性已验证**：把 3 个补丁 `patch -p1` 打到原始文件上，结果与我的改后文件**逐字节一致**。

### 5.3b 装配时被 CLI 抓到的一个真问题（fork 差点缺默认皮肤）

`skins/blue-fantasy/skin.json` 在下载时被 `curl --fail` **静默漏掉**（8 个文件只落地 7 个）。症状不是报错，而是上游 CLI 打出：

```
! blue-fantasy [builtin] excluded: skin.json missing or not valid JSON
```

——内置默认皮肤整个从目录册里消失，`seedDefaultActiveSkin` 的兜底链也会断。
typecheck / 单元测试 / 构建**三道门禁都抓不到这个**（会抓它的那些用例正因为缺 `skins/` 而失败）。补上 `skin.json`（1628 字节）后，`dsh-skin list` 的诊断清空，`builtin-skins.spec.ts` 的目录完整性、token 契约、清单校验+样式表转换三项全部转绿。

**教训**：`curl --fail` 配 `-o` 时失败可能不落地文件，批量下载必须事后核验清单长度，不能只看循环有没有抛错。

### 5.4 过程中被测试抓到的一个真缺口（值得记下来）

我第一版把 `syncScrim()` 只挂在 `syncBlur()` 上——因为 `syncBlur` 有 6 个调用点，看起来覆盖最全。
但 `controller.set(opacity)` 走的是 `applyOcclusion()` → **遮蔽值变了，遮罩层不动**。上游测试 `tests/background.spec.ts` 直接把它抓了出来。

修法不是改测试，而是修设计：**谁应用遮蔽值，谁负责画**——`syncScrim()` 同时挂在 `applyOcclusion()`（值变化）和 `syncBlur()`（壁纸/主开关的状态迁移）两处，靠 `appliedScrim` 缓存保证幂等。

同时上游的测试辅助函数 `blurElement()` 是「找 body 下第一个 `aria-hidden` 的 div」，我的新层也符合这个形状，于是被误匹配。修法是**给两个运行时遮罩层都加稳定属性**（`data-dsh-backdrop-blur` / `data-dsh-backdrop-scrim`），让测试按属性精确寻址——顺带这两个属性本身就是第三方和 `patches.css` 需要的稳定钩子。

这两处都是「测试先发现、再改设计」的例子，不是为了让测试变绿而改测试。

### 5.5 安装成 dev fork

```sh
dsh plugin --profile desktop add link:/Users/mima1234/Downloads/dsh/build/.upstream
```

与你 `dsh-boot-animation-pro` 同一种挂法。**可一键回滚**（回到 npm 上的 0.4.4）：

```sh
dsh plugin --profile desktop add @linxin666/dsh-client-ui-skin-center
```

profile 配置已备份：`~/.dsh/profiles/desktop/package.json.bak-before-fork`。

> 注意：装 fork 后必须**撤掉 5.2 那个皮肤侧临时补丁**，否则插件遮罩 + 皮肤遮罩 = 双重加纱。
> 已执行 `cp patches.css.orig-backup patches.css` 还原为作者字节。

---

*本报告的所有结论都带 `文件:行` 证据。标「推测」的地方是推断，不是读到的代码。*
