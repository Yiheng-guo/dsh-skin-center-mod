# 扒 dsh-trading 的「循环视频背景」——结论 + 给你做的同款皮肤

---

## 一、你问的那个项目

你给的链接 `github.com/zhu1090093659/dshtrading` **是 404 的**，真名是
[**dsh-trading**](https://github.com/zhu1090093659/dsh-trading)（220 star / 22 fork / TypeScript /
PolyForm 非商用许可，主页 dsh-trading.win）。

它是**建在 DeepSeek Harness 上的「AI 原生交易终端」插件**：

- **四市场一套界面** —— 加密货币 / 美股 / A 股 / 港股
- **19+ 可热插拔连接器** —— Binance、OKX、Bybit、CCXT；Yahoo、Alpaca、FMP、Polygon、IBKR；
  腾讯财经、东方财富、Tushare、AkShare、MiniQMT；长桥、富途、老虎
- **三栏 GUI** —— 自选股 ｜ K 线主舞台（Lightweight Charts v5 + MA/EMA/BOLL/MACD/RSI/KDJ/SuperTrend
  + 真盘口 + 衍生品面板）｜ Agent
- **纪律写进代码** —— 下单默认 **dry-run 模拟**；实盘要显式 `liveTrading: true`，
  而且**每一笔实盘单都要你手点审批**；无人值守环境直接 fail-closed
- **四个角色 Agent** —— `master` 大师（总调度）／`trader` 交易员／
  `instrument-researcher` 研究员／`risk-reviewer` 风险审查员
- BYOK，密钥只在你本机；行情**不转售、不缓存**

一句话：**不是自动交易机器人，是「你手动按下去之前，思考已经发生完了」的 AI 辅助研究 + 受控执行终端。**

---

## 二、那个「像循环视频一样的背景」是什么

**不是 DeepSeek 官方素材**，是一款社区皮肤：**`whale-fantasy`（鲸鱼娘 · 未至之境）**，
作者 `stushansusu`，来自 [zhu1090093659/dsh-skins](https://github.com/zhu1090093659/dsh-skins)，
在 dsh-market.com 上架。

我把你截图和它的预览图逐项对上了——蓝发、大白蝴蝶结、眼里淌代码、青色数据雨，**完全一致**。
你截图里其实是三层东西叠在一起：

| 你看到的 | 实际是什么 |
|---|---|
| 蓝发少女循环背景 | `whale-fantasy` 皮肤的**视频背景** |
| 中间「探索未至之境」+ 鲸鱼 logo | DSH 中文欢迎页（该皮肤还把左上角品牌行换成「鲸鱼娘 · 未至之境」） |
| 右下角 Q 版小人 | 另一个插件 `dsh-pet` |

**机制**：皮肤是**纯资产目录**，靠 `skin.json` 的一个字段声明视频背景：

```json
"contributes": {
  "backgroundMedia": {
    "dark": { "type": "video", "src": "assets/whale-fantasy-loop.mp4", "scrim": "linear-gradient(...)" }
  }
}
```

真正渲染它的是 **`@linxin666/dsh-client-ui-skin-center`**（皮肤中心插件，Apache-2.0，
npm 最新 0.4.4）。它那条视频是作者自己烘的 25.46 秒无缝循环
（裁掉上下各 46px 黑边 → 1664 宽 / CRF 28 → 尾部 1.2s 与头部 1.2s 交叉淡入）。

> 那个仓库 50+ 款皮肤里，**只有 2 款用视频背景**：`whale-fantasy` 和它的姊妹款 `rainy-night`。

---

## 三、三个选择长什么样

![A B C 对比](build/comparison.jpg)

| | 皮肤 | 底片 | 循环 | 长相 |
|---|---|---|---|---|
| **A** | `whale-fantasy`（社区，作者 stushansusu） | 作者自备的循环动画 | **25.5s** | 电光蓝 + 青，极近距离的眼睛特写 + 代码雨；饱和、抢眼 |
| **B** | `cyber-maiden`（你的） | `media/deepseek-brand-intro.mp4` | **13.6s** | 冷钢蓝灰，女仆少女，左半屏留空给侧栏；安静、克制 |
| **C** | `cyber-abyss`（你的） | `media/deepseek-startup-intro.mp4` | **16.6s** | 鲜蓝 + 电光青，放射状数据流 + 骷髅；**调性最接近 A**，但是抽象画面不抢戏 |

三张图的界面部分，B 和 C 是我用皮肤中心的**真实 CSS 输出**渲染的；
A 是作者自己发布的预览图。对比图在 `build/comparison.jpg`。

**怎么选**：

- 就想要截图里那个观感 → **A**，一条命令（见下）
- 想要安静、能长时间盯着看、中文界面协调 → **B**
- 想要接近 A 的鲜艳电光感，又不想被一张脸盯着 → **C**

---

## 四、A：想要他那一款？一条命令

**这不叫「我不行所以用他的」——这是两条都能要的事。**
走官方市场装，最省事也最合规（作者署名、作者拿安装计数）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add @linxin666/dsh-client-ui-skin-center
# 然后 Cmd+Q 重开 DSH → 设置 → 皮肤中心 → 从市场安装「鲸鱼娘 · 未至之境」
```

装完它落在 `~/.dsh/skins/whale-fantasy/`，和你自己的 B / C **在同一个列表里**，
可以随时切换对比。

---

## 五、B & C：你自己的两款，也已经做好了

两款都是**原创 v2 皮肤，闸门各 16 项全 PASS**。

### 它们共用同一套工程

这是这次重构的重点：`skin.css` / `patches.css` **两个皮肤逐字节共用**，
差别只有**调色板 JSON** 和**背景资产**。也就是说——

> **加一个皮肤 = 一个调色板文件 + 一段视频，不用写 CSS。**

材质变量改成中性的 `--skin-*`，所以 `patches.css` 不认识具体皮肤也能工作。

| | B `cyber-maiden` | C `cyber-abyss` |
|---|---|---|
| 底片 | `media/deepseek-brand-intro.mp4`（1280x720） | `media/deepseek-startup-intro.mp4`（1280x720） |
| 干净窗口 | 0.10 – 2.40s（2.3s） | **0.05 – 4.25s（4.2s）** |
| 慢放 | `interp 90` = 3 倍运动插值 | `interp 60` = 2 倍运动插值 |
| 循环 | **13.57s** / 1600x900 / 1.03 MiB | **16.57s** / 1600x900 / 4.26 MiB |
| 边界拼接 PSNR | 55.3 / 51.4 dB | 34.6 / 32.3 dB |
| 色相分布 | 83.4% 钢蓝 + 15.5% 冷青 | 71.2% 钢蓝 + 28.7% 冷青 |
| 画面明度 | 77% 像素亮度 <25（近黑） | 38% 亮度 <25（**亮**） |
| scrim | 薄纱（底部 16–26%） | **重纱（整体 40–60% + 中心径向）** |

> 两组 PSNR 不可直接比：C 的画面每帧都在动，相邻帧本身就差得多，
> 所以绝对值低是正常的，判据（端点 vs 邻居）才是一致的。

**C 为什么需要重纱**：C 的底片是鲜蓝的（中间调 `#1054B2`），
不加纱的话鲜艳的背景会把同样鲜艳的按钮吞掉，欢迎语也读不清。
这跟 B 的底片（77% 近黑）是完全相反的处境，所以面板层次也压得更深。

---

## 六、底片审计：6 条里只有 2 条能直接用

**两条 1080p 宣传版是开机动画播放界面的录屏**——画面里烧进了播放器自己的 UI
（左上「已选片头」、右上**「跳过」按钮**、底部「点击开启声音 · 全屏」、左下进度条）。

| 文件 | 播放器 UI | 烘焙品牌 | 结论 |
|---|---|---|---|
| **`media/deepseek-brand-intro.mp4`** | 无 | 无 | ✅ **B 用它**（窗口 2.3s） |
| **`media/deepseek-startup-intro.mp4`** | 无 | 无（骷髅 + 数据流） | ✅ **C 用它**（窗口 4.2s） |
| `media/deepseek-cyberpunk-intro.mp4` | 无 | 左上 DeepSeek 大字标 | 字标去不掉 |
| `media/deepseek-awakening-intro.mp4` | 无 | 左上 DeepSeek 字标（从第 0 帧起） | 字标去不掉 |
| `promo/dsh-intro-brand-1080p.mp4` | ❌ 跳过 + 进度条 | 无 | ✗ 录屏 |
| `promo/dsh-intro-cyberpunk-1080p.mp4` | ❌ 跳过 + 进度条 | DeepSeek 大字标 | ✗ 录屏 |

6 张全尺寸证据留在 `build/source-audit/`（第 1.0 秒各抽一帧）。

**「跳过」按钮那个坑值得单独说**：我第一版选了 `promo/dsh-intro-brand-1080p.mp4`，
因为它分辨率最高、画面最好看。直到把插值后的一帧放大到全屏，才看见右上角那个
「跳过」按钮和左下进度条——**在缩略图上看根本发现不了**。

---

## 七、怎么验证的

不是「写完看着像就对」。`build/validate-skin.mjs` **直接跑皮肤中心的真校验器**
（`build/validator/` 下是从 `dsh-skins` 仓库拉下来的逐字节源码拷贝）：

```
cyber-maiden   16 PASS / 0 FAIL
cyber-abyss    16 PASS / 0 FAIL
```

四项闸门 × 两个皮肤：`validateSkinManifestV2` → `transformSkinCss(skin.css, deriveFallbacks)`
→ `transformSkinCss(patches.css)` → 清单文件引用存在，并断言加载器的三处改写真的生效。

两个皮肤都是 **112/112 官方颜色 token 全覆盖，零遗漏**，所以皮肤中心的自动兜底
一个都不触发。校验器本身还拿**官方已上架的 `whale-fantasy`** 做过对照，那份也全绿。

`bake-loop.sh` 每次烤完会自动量四个数并给判决：

```
first/last: mean luma 33.90 / 33.96   (limited-range black is Y=16, not 0)
seam PSNR : 40.27 dB   (first frame vs last frame)
head splice: 55.32 dB   (frame 0 vs frame 1)
tail splice: 51.43 dB   (last frame vs its neighbour)
verdict   : seamless
```

> 途中抓到四个真问题，都固化成守卫了：
> ① 底片**第 0 帧是黑帧** → 我又用「首末帧平均差」验出 0.008 假阳性，
> 真正抓到它的是**端点硬切检测**；
> ② 有限范围 YUV 下**黑的 Y 是 16 不是 0**；
> ③ `promo/*-1080p` 是**播放器录屏**，缩略图上看不出来；
> ④ `setpts=PTS*30/90` 是**加速**不是减速（PTS 乘法方向）。
>
> 坏窗口会被判 `REJECTED`，好窗口判 `seamless`——两条路径都实测过。

---

## 八、安装（我没动你的 DSH）

你选的是「做皮肤」不是「装到我 DSH」，所以我没改你的安装。要装就三步：

```sh
# ① 装皮肤中心插件（你的 GUI 跑在 desktop profile）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add @linxin666/dsh-client-ui-skin-center

# ② 把皮肤放进用户皮肤目录（B、C 都装，或只装一个）
mkdir -p ~/.dsh/skins
cp -R cyber-maiden cyber-abyss ~/.dsh/skins/

# ③ 完全退出 DSH（Cmd+Q）再打开
#    桌面版没绑 Cmd+Shift+R，要换进程才会重新取 bundle
```

然后 **设置 → 皮肤中心 → 选「赛博少女 · 冷钢之夜」或「深蓝深渊 · 数据流」**。

> ① 需要重启 DSH 才生效（插件是启动时装配的）；② 不需要，重开卡片或刷新页面就收录。

---

## 九、换一条片子重烤

```sh
# usage: bake-loop.sh <source> [start] [duration] [mode] [width] [speed] [interp]
SKIN_ID=cyber-abyss bash build/bake-loop.sh "<media 目录>/deepseek-startup-intro.mp4" 0.05 4.2 pingpong 1600 1 60
python3 build/build-skin.py cyber-abyss     # 只有改了调色板才需要
node build/validate-skin.mjs cyber-abyss
node build/render-preview.mjs cyber-abyss
```

---

## 目录

```
├── cyber-maiden/          ← B，cp 到 ~/.dsh/skins/ 就能用
│   ├── skin.json / skin.css / patches.css
│   ├── assets/cyber-maiden-loop.mp4   (13.57s / 1600x900 / 1.03 MiB)
│   ├── preview/{dark,light}.jpg
│   └── README.md          ← 工程细节、量色数据、踩坑记录
├── cyber-abyss/           ← C
│   ├── skin.json / skin.css / patches.css   (patches.css 与 B 逐字节相同)
│   ├── assets/cyber-abyss-loop.mp4    (16.57s / 1600x900 / 4.26 MiB)
│   ├── preview/{dark,light}.jpg
│   └── README.md          ← C 特有的：为什么这条要重纱、亮底片怎么处理
└── build/                 ← 工具链（不装进 DSH）
    ├── palettes/{cyber-maiden,cyber-abyss}.json   ← 唯一真相源：一个皮肤一个文件
    ├── build-skin.py         调色板 → skin.css（N 个皮肤共用）
    ├── bake-loop.sh          任何视频 → 无缝循环 + 自动无缝判定（SKIN_ID= 指定皮肤）
    ├── validate-skin.mjs     跑皮肤中心的真校验器
    ├── render-preview.mjs    headless Chrome 渲染预览（走真实 transform 输出）
    ├── make-comparison.py    拼 A/B/C 对比图
    ├── validator/            皮肤中心校验源码的逐字节拷贝
    ├── source-audit/         6 条底片的全尺寸审计截图
    ├── official-tokens-v1.json
    └── bin/ffmpeg            静态 ffmpeg 7.1 (arm64)，脚本自带
```
