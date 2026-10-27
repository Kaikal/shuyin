# Lumen Music — 设计规范与交付说明

> 轻量、克制、有质感的第三方音乐客户端。数据层兼容洛雪音乐（LX Music）自定义音源。
> 画布文件：`Lumen Music — 动效驱动音乐播放器`（6 个桌面页 + 3 个移动页）

---

## 1. 画布清单

| # | 页面 | 尺寸 | 关键状态 |
|---|---|---|---|
| 01 | 搜索 | 1440×900 | 输入聚焦态（焦点环）、结果分组 Tab、悬停行操作、降级失败行 |
| 02 | 播放器主界面 | 1440×900 | 播放中封面、当前歌词行、音源链（kw 可用 / tx 无版权） |
| 03 | 点赞收藏 | 1440×900 | 排序分段控件、来源筛选、卡片悬停抬升 |
| 04 | 歌单详情 | 1440×900 | 封面色模糊延展、表头对齐、2% 明度斑马纹、当前行高亮 |
| 05 | 评论抽屉 | 1440×900 | 右侧玻璃抽屉滑入、播放条保持可操作、底部输入条 |
| 06 | 设置 | 1440×900 | 子导航选中、减弱动效开关、音源授权状态、主题分段 |
| 07 | 播放列表（队列） | 1440×900 | 播放条入口按钮激活态、队列抽屉、悬停行露出拖拽手柄与移除 |
| 08 | 队列交互状态 | 560×~470 | 默认 / 悬停 / 拖起 / 插入线四种行状态拆解 |
| M1 | 移动端播放 | 390×844 | 单行歌词、进度、情感操作；底部操作行第 5 位为「播放列表」入口 |
| M2 | 移动端搜索 | 390×844 | 玻璃搜索胶囊 + 迷你播放条（含进度条与单行歌词）+ 胶囊 Tab |
| M3 | 移动端收藏 | 390×844 | 双列卡片、Tab 选中态切换、迷你播放条 |
| M4 | 移动端播放列表 | 390×844 | 底部 sheet、编辑态（⊖ 移除 / ≡ 拖动）、拖起行 + 插入线 |

---

## 2. Design Tokens

### 2.1 颜色

| Token | 值 | 用途 |
|---|---|---|
| `bg.top` | `#0A0B0F` | 页面渐变起点 |
| `bg.bottom` | `#14161C` | 页面渐变终点（不用纯黑） |
| `surface.card` | `rgba(255,255,255,0.028)` + 1px `rgba(255,255,255,0.055)` 描边 | 实体磨砂卡片 |
| `surface.rowHover` | `rgba(255,255,255,0.045)` | 列表行悬停 |
| `surface.zebra` | `rgba(255,255,255,0.015)` | 斑马纹（2% 明度差，不用色块） |
| `text.primary` | `#EAEBF1`（92% 带蓝调） | 标题 / 主文本 |
| `text.secondary` | `#9B9EAE`（60%） | 歌手、次要信息 |
| `text.tertiary` | `#5F6272`（38%） | 时长、辅助、占位 |
| `text.quaternary` | `#4C4F5C` | 表头、索引 |
| `accent` | `#6E8BFF` | **仅**：当前播放、点赞激活、进度条、焦点环 |
| `accent.soft` | `#8FA4FF` | 强调色文字（保证 AA 对比度） |
| `semantic.error` | `#E08A72` | 仅 Toast 与错误态（无版权、未授权） |

### 2.2 圆角

| Token | 值 | 用途 |
|---|---|---|
| `radius.container` | 20–24 | 播放条 20、大封面 24、抽屉 24 |
| `radius.card` | 14–16 | 卡片、设置分组 |
| `radius.pill` | 999 | 胶囊、标签、Tab |
| `radius.small` | 8–10 | 封面缩略、图标按钮、行 |

### 2.3 阴影

| Token | 值 |
|---|---|
| `shadow.glass` | `0 8px 32px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.10)` |
| `shadow.cardHover` | `0 16px 38px rgba(0,0,0,.55)` |
| `shadow.coverLg` | `0 24px 60px rgba(0,0,0,.5)` + `inset 0 1px 0 rgba(255,255,255,.14)` |
| `shadow.accent` | `0 8px 22px rgba(110,139,255,.40)`（仅播放键） |

### 2.4 间距 / 栅格

8pt 栅格：`4 / 8 / 10 / 14 / 16 / 22 / 26 / 32 / 40`

| 场景 | 值 |
|---|---|
| 桌面页面左右留白 | 32 |
| 移动页面左右留白 | 16 |
| 桌面侧栏宽 | 240（可折叠至 64） |
| 播放条 | 高 72，距底 16，圆角 20，左右各距侧栏/边缘 16 |
| 移动 Tab 胶囊 | 高 62，圆角 36，容器内边距 12/21/21/21 |
| 迷你播放条 | 高 64（含顶部 2px 进度线），圆角 18，距 Tab 上方 5 |
| 队列底部 sheet | 高 78vh（390×600），圆角 24 24 0 0，底部预留 34 安全区 |

### 2.5 字体

| 角色 | 字体 | 字号 / 字重 |
|---|---|---|
| 页面标题 | Noto Sans SC | 20–22 / SemiBold |
| 歌单大标题 | Noto Sans SC | 32 / SemiBold |
| 区块标题 | Noto Sans SC | 12.5–15 / Medium |
| 正文 | Noto Sans SC | 12.5–13.5 / Regular |
| 次要信息 | Noto Sans SC | 10.5–11.5 / Regular |
| 数字（时长、播放量、计数） | Inter | 10–11 / Regular，`font-variant-numeric: tabular-nums` |
| 歌词当前行 | Noto Sans SC | 20 / SemiBold（1.08×） |
| 歌词非当前行 | Noto Sans SC | 17 / Regular @ 40% |

图标：线性 1.5px 描边、圆头端点（18/20 网格）；播放/暂停等高频图标用实心。

---

## 3. 液态玻璃（Liquid Glass）

三层结构，缺一不可：

```
折射层  backdrop-filter: blur(20px) saturate(180%) brightness(1.05)
高光层  linear-gradient(135deg, rgba(255,255,255,.10), rgba(255,255,255,.02))
        + 1px 内描边 rgba(255,255,255,.18)
实体感  box-shadow: 0 8px 32px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.12)
```

硬性约束：

- 同屏玻璃层 **≤ 3 层**（播放条 / 导航 / 一个弹出面）。列表卡片一律实体磨砂，不叠加 `backdrop-filter`。
- 模糊半径严格 12–24px；玻璃只用于悬浮于内容之上的元素，不做整页玻璃背景。
- 高光随滚动/悬停位移 **≤ 2px**，不做鼠标视差。
- 降级：`@supports not (backdrop-filter: blur(1px))` 或 `prefers-reduced-transparency: reduce` → `background: rgba(20,22,28,.92)`，无模糊；移动端与低性能设备默认走降级分支。
- 玻璃上的文字额外加 **20% 暗色底衬**（或 `text-shadow: 0 1px 2px rgba(0,0,0,.5)`）保证 AA。

---

## 4. 动效清单

统一曲线：`ease-out-soft = cubic-bezier(.2,.8,.2,1)`、`ease-panel = cubic-bezier(.32,.72,0,1)`、spring `stiffness 260 / damping 30 / mass .8`。

| # | 动效 | 触发条件 | 时长 | 曲线 | 属性 | 可关闭 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 按钮/行悬停反馈 | hover / press | 140ms | ease-out-soft | background, transform | 否 | 只改透明度与 1px 位移 |
| 2 | 卡片悬停抬升 | hover 卡片 | 160ms | ease-out-soft | transform: translateY(-4px), box-shadow | 是（减弱动效时取消位移） | 阴影加深一档 |
| 3 | 搜索框聚焦 | focus | 160ms | ease-out-soft | transform: translateY(-2px), box-shadow | 是 | 焦点环 2px + 2px offset |
| 4 | Tab 指示条切换 | 点击 Tab | 220ms | ease-out-soft | transform: scaleX / translateX | 是 | 共享元素位移，不做淡入 |
| 5 | 抽屉进出（评论 / 正在播放） | 打开 / 关闭 | 280ms | ease-panel | transform: translateX, opacity | 是 | 内容区 dim 160ms |
| 6 | 页面切换 | 路由变化 | 300ms | ease-panel | transform(共享轴), opacity | 是 | 只做单轴位移 + 淡入 |
| 7 | 点赞情感反馈 | 点击心形 | 380ms | spring(1, 90, 12) | transform: scale 1→1.25→1 | 是（降级为 100ms 淡入） | 环形扩散**单次播放**，不复用循环 |
| 8 | 取消点赞 | 再次点击 | 260ms | spring | scale 1→0.85→1 + 颜色回落 | 是 | 反向 |
| 9 | 封面旋转 | 播放中 | 20s/圈，linear | linear | transform: rotate | 是 | 暂停即冻结；切歌立即复位 0° |
| 10 | 封面环境光交叉淡入 | 切歌 | 600ms | ease-out-soft | opacity（静态径向渐变换色） | 是 | 不跟随节拍闪烁 |
| 11 | 歌词行跟随滚动 | 播放进度 / 手动滚动 | 320ms | spring | transform: translateY + scale(1.08) | 是 | 拖动进度条时暂停跟随，松手 200ms 内恢复 |
| 12 | 进度条加粗 + 时间气泡 | hover 进度条 | 140ms | ease-out-soft | transform: scaleY(4→6px), opacity | 是 | 不做 width 动画 |
| 13 | 加载三点跳动 | 拉取播放链接 | 800ms 循环，**仅加载中** | ease-in-out | opacity + translateY | 是 | 拿到 URL 立即停止并移除节点 |
| 14 | 评论展开/收起 | 点击「展开」 | 240ms | ease-panel | grid-template-rows 0fr→1fr | 是 | 高度动画用 grid 技巧 |
| 15 | 歌单拖拽排序 | 拖拽中 | 140ms | ease-out-soft | transform: scale(1.02) + 阴影 | 是 | 其余项用 FLIP 位移 |
| 16 | Toast 进出 | 操作反馈 | 200ms / 180ms | ease-panel | transform: translateY, opacity | 否 | 语义色仅在此出现 |
| 17 | 队列面板进出 | 点播放条队列按钮 / `Q` | 280ms | ease-panel | transform: translateX(24px→0), opacity | 是 | 与评论抽屉互斥，同屏只开一个 |
| 18 | 队列行移除 | 点 ✕ / `Delete` | 180ms 淡出 + 240ms FLIP | ease-out-soft / ease-panel | opacity, transform | 是 | 其余行补位用 FLIP，不触发重排抖动 |
| 19 | 移动队列 sheet | 拉起 / 收起 | 320ms | ease-panel | transform: translateY, opacity | 是 | 遮罩同步 200ms；跟手阶段不做过渡，松手才归位 |

**反审美疲劳红线**

- 禁止无限循环动效（常驻呼吸光、常驻粒子、常驻波纹）。唯一例外：加载三点（有明确结束条件）、封面旋转（有明确开关）。
- 单次交互内动效元素 ≤ 3 个；同屏不同时出现两种以上运动方向。
- 背景不做漂移光斑；氛围只用静态极低透明度径向渐变（≤ 8%）。
- 长列表不做视差、不做逐项 stagger > 40ms。
- `prefers-reduced-motion: reduce` 或「减弱动效」开启 → 全部降为 100ms 淡入淡出，封面旋转与环形扩散直接关闭。

---

## 5. 组件清单

| 组件 | 职责 | 关键 props / 状态 |
|---|---|---|
| `GlassPanel` | 液态玻璃容器（三层结构 + 降级） | `level: nav \| bar \| overlay`、`blur`、`tone`；内部用 Context 计数，超过 3 层自动降级 |
| `SongRow` | 单曲行（列表 / 搜索结果通用） | `song`、`playing`、`dense`、`showActions`、`state: idle \| loading \| noLicense \| failed` |
| `SongCard` | 网格卡片（收藏 / 歌单） | `song`、`hovered`、`onLike` |
| `PlayBar` | 底部悬浮播放条 | `song`、`progress`、`quality`、`onSeek`、`compact`（移动端迷你条复用同一状态源） |
| `LyricView` | 歌词滚动区 | `lines`、`activeIndex`、`follow`（拖拽时置 false）、`translation` |
| `CommentDrawer` | 右侧评论抽屉 | `open`、`songId`、`tab: hot \| latest`、`onClose`；不阻断播放条交互 |
| `QueuePanel` | 右侧队列抽屉 | `open`、`queue`、`currentIndex`、`onReorder(from,to)`、`onRemove(index)`、`onClear`；与评论抽屉互斥 |
| `QueueRow` | 队列行（可拖动） | `song`、`index`、`dragging`、`dropBefore`、`onRemove`；悬停出手柄、拖起加投影、`Alt+↑↓` 可调序 |
| `QueueSheet` | 移动端队列底部 sheet | `open`、`editing`、`queue`、`onReorder`、`onRemove`、`onDismiss`；下滑关闭、长按拖动、⊖ 移除 |
| `MiniBar` | 移动端迷你播放条 | `song`、`progress`、`lyricLine`、`onExpand`、`onQueue`；顶部 2px 进度线 + 单行歌词 |
| `PlaylistCard` | 歌单卡片 / 侧栏歌单项 | `playlist`、`layout: card \| row`、`draggable` |
| `Toggle` | 开关 | `checked`、`onChange`、`disabled`；mono 白系，不使用强调色 |
| `Segmented` | 分段控件（排序 / 主题） | `options`、`value`、`onChange`；指示块用共享元素位移 |
| `SourceTag` | 音源标签 | `source: kw\|wy\|tx\|kg\|mg\|local`、`available` |
| `QualityPicker` | 音质下拉胶囊 | `options`、`current`、`disabledReason`（不可用项置灰 + tooltip） |
| `EmptyState` | 空态 | `kind: noComment \| noResult \| noPlaylist`；插画式，不留白板 |
| `Skeleton` | 首屏骨架 | `variant: list \| grid \| lyric` |
| `Toast` | 轻提示 | `tone: success \| warning \| error`；唯一允许出现语义色的地方 |

---

## 6. 洛雪音乐（LX Music）兼容层

UI 不感知具体音源，所有数据经 Provider 归一化。

```ts
type SourceCode = 'kw' | 'wy' | 'tx' | 'kg' | 'mg' | 'local'

interface Song {
  id: string
  source: SourceCode
  name: string
  singer: string[]
  albumName: string
  albumId: string
  interval: number        // 秒
  img: string
  songmid: string
  copyright: boolean
}

interface MusicProvider {
  search(keyword: string, page: number, type: 'song' | 'singer' | 'album' | 'playlist'):
    Promise<{ list: Song[]; total: number }>
  getSongUrl(song: Song, quality: Quality): Promise<{ url: string; quality: string } | null>
  getLyric(song: Song): Promise<{ lyric: string; tlyric?: string }>
  getPic(song: Song): Promise<string>
  getPlaylist(id: string): Promise<Playlist>
}
```

**自定义源脚本适配**

- 搜索：脚本 `music.search` 返回的 `list[]` 逐项过 `normalizeSong()`，补齐 `source` 与 `copyright`。
- 播放链接：从脚本 `musicUrl` 回调取，**必须按 Promise 包装**并设超时（建议 8s），回调可能异步、可能只回调 error。
- 单一 provider 抛错不冒泡到 UI，统一包装为 `Result<SongUrl, ProviderError>`。

**降级链**

```
点击播放
  → 首选音源（当前展示的 source）取值
      ├─ 成功 → 播放
      └─ 失败/超时/无版权
          → 并发竞速同名歌曲的其余 source（kw → wy → tx → kg → mg）
              ├─ 命中 → 播放，并 Toast「已切换到 wy 音源」
              └─ 全失败 → 行内显示「5 个音源均无版权」+「换源」按钮
                          （播放器不卡死、不静默失败、不弹阻塞弹窗）
```

**加载 / 状态**

- 请求中：行右侧 3 点跳动（800ms，仅加载期），已有播放不中断。
- 音质：标准 / 高品 / 无损 / 超品；不可用项置灰并挂 tooltip 说明原因（如「该音源无版权」）。
- 播放中降级不打断当前音频，仅在切换歌曲时生效。

---

## 7. 播放列表（队列）

播放条原来只有上一首/播放/下一首，**队列入口缺失**。补充一个入口 + 一个可排序、可移除的队列面板。

### 7.1 入口

| 项 | 规格 |
|---|---|
| 位置 | 播放条右侧按钮组最末位（高品 → 喜欢 → 评论 → 加入歌单 → 更多 → **播放列表**），视觉上与「对单曲的操作」分离 |
| 尺寸 | 26×26 命中区，圆角 8；图标 18×18，1.5px 线性（三条列表线 + 播放三角） |
| 默认 | 图标 `#9B9EAE`；悬停 `rgba(255,255,255,.06)` 底 + 图标转 `#EAEBF1`，140ms |
| 打开态 | `rgba(255,255,255,.08)` 底 + 1px `rgba(255,255,255,.07)` 描边，图标 `#EAEBF1`。**不用强调色**（强调色只留给当前播放 / 点赞 / 进度 / 焦点环） |
| 快捷 | `Q` 开关队列；`Esc` 关闭 |

### 7.2 面板

复用评论抽屉的位置与玻璃规格（同一套「右侧抽屉」语言，两者互斥，同时只开一个）：

- 尺寸 400×800，`x=1040, y=0`（底部让出播放条），圆角 `24 0 0 24`。
- 三层玻璃：`blur(20px)` + `#0F1217 @ .72` + `135° 白 .09→.02` + 1px 白 `.14` 内描边；投影 `-16px 0 48px rgba(0,0,0,.40)`。
- 进出：280ms `ease-panel`，`translateX(24px)→0` + opacity；关闭不阻断播放。

内部结构与高度：

| 区块 | 高 | 内容 |
|---|---|---|
| Header | 44 | 「播放列表」15/600 + 「12 首」10.5 38%；右侧「清空」11.5 + 关闭 14 |
| 正在播放 | 66 | 封面 40 r10 + 曲名 13/500 **强调色** + 「陈默 · 正在播放」10.5 + 右侧 3 柱 EQ（静态示意） |
| 分隔线 | 1 | `rgba(255,255,255,.06)` |
| Section | 30 | 「接下来 · 11 首」10.5 38% |
| 列表 | 48×12 | 行内边距 12，列表左右再内缩 8（悬停底色不贴边） |
| Footer | 40 | 「拖动排序 · 点 ✕ 移除」10 38% ＋ 「总时长 48:32」10 tabular |

### 7.3 队列行

`序号 16 · 封面 28 r6 · 曲名 12/500 + 歌手 10 · 时长 10.5 tabular · 移除 14`

| 状态 | 表现 |
|---|---|
| 默认 | 序号 `#5C6070` tabular；曲名 `#DCDEE6`；行背景透明 |
| 悬停 | 120ms：行底 `rgba(255,255,255,.055)`、圆角 10；**序号原地换成六点拖拽手柄**（不新增占位，避免行内容左右跳动）；曲名提亮到 `#EAEBF1`；右侧出现 ✕ |
| 拖起 | 160ms：白 `.12` 叠在不透明底 `#1C1F29` 上 + 1px 白 `.18` 内描边 + `0 12px 28px rgba(0,0,0,.5)`，`scale(1.006)` 轻微放大；**不改行高，避免整列重排** |
| 插入位置 | 目标间隙出现 2px 强调色线（左右内缩 8），原位置不留空洞 |
| 移除 | 行 180ms 淡出下沉，其余行 FLIP 240ms 补位；Toast「已从队列移除 · 撤销」5s |

### 7.4 交互与工程

- **拖动阈值 4px**：未过阈值视为点击（点行即播）。仅纵向位移；`transform` 驱动，绝不改 `top`。
- 其余行用 **FLIP**（先读 rect，后写 transform，再过渡到 0），240ms `cubic-bezier(.32,.72,0,1)`。
- 自动滚动：指针距列表上下边缘 < 40px 时按 8px/帧滚动，滚动时同步补偿 translate。
- 拖到列表外 24px → 取消并归位；`Esc` 同样取消。
- 松手即写入顺序，持久化到 `localStorage.queue.order`（按 song.id + source）。
- 移除**正在播放**的那一行：不中断音频，仅把队列指针后移；队列清空 → 面板内空态「队列空了，去搜一首」，播放条保持当前歌曲。
- 键盘：`Tab` 进列表 → `↑ ↓` 移动焦点 → `Alt + ↑ ↓` 调序（同一个 FLIP）→ `Delete` 移除 → `Esc` 取消拖拽/关闭面板。焦点环 2px 强调色 + 2px offset。
- 触屏：长按 320ms 进入拖起并轻震；桌面悬停手柄可直接拖。
- 性能：只对 `transform / opacity` 动画；拖动期间给列表加 `will-change: transform`、`contain: layout paint`；>200 首启用虚拟滚动；拖动时不触发图片解码 / 布局读取（rect 一次性快照）。

```ts
// 排序落库（顺序即真相，不依赖数组下标）
function move(queue: Song[], from: number, to: number): Song[] {
  const next = queue.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  persist('queue.order', next.map(s => `${s.source}:${s.id}`))
  return next
}
```

### 7.5 移动端

**入口（两处，同一动作）**

- 播放页底部操作行第 5 位（20px 线性图标，与喜欢 / 评论 / 加入 / 分享同排），点击从底部推起队列 sheet。
- 迷你播放条最右（18px）。任何带迷你条的页面都能拉起同一个 sheet。

**队列 sheet**

| 项 | 规格 |
|---|---|
| 形态 | 底部 sheet，390×600（78vh），圆角 `24 24 0 0`，玻璃三层（blur 16–20，移动端默认走降级底色） |
| 遮罩 | 只压暗 sheet 之上部分 `rgba(0,0,0,.34)`，不整屏压黑 |
| 抓取条 | 36×4 r2 白 `.18`，距顶 10 |
| 头部 | 48：「播放列表」16/600 + 「12 首」10.5 38%；右侧「编辑 / 完成」13 60% |
| 行 | 56：⊖ 18 · 封面 36 r8 · 曲名 13/500 + 歌手 10.5 · 时长 10.5 tabular · ≡ 16 |
| 列表内缩 | 左右 8，行内再加 8（内容距屏 16）；拖动时行底不贴边 |
| 底部 | 分隔线 + 「长按 ≡ 拖动 · 点 ⊖ 移除」9.5 38% ＋ 总时长；Home Indicator 134×5 |

**交互**

- 上下滑：上滑展开 / 下滑收起，阈值 `96px` 或速度 `> 400px/s`；仅当 sheet 内部滚动已到顶时，下滑手势才交给「关闭」。
- 进入拖动：行内**长按 320ms** 轻震后抬升（底色 + 1px 描边 + `0 12px 28px`），插入位画 2px 强调线；拖动期间禁止 sheet 的下滑关闭手势。
- 移除：浏览态左滑露出「移除」，或进入「编辑」后点左侧 ⊖，两者共用同一个 5s 撤销 Toast。
- 点行即播并**保持 sheet 打开**（继续挑歌不必重开）；「完成」只退出编辑态，不关面板；下滑或点遮罩关闭。
- 队列为空：sheet 内空态「队列空了，去搜一首」，不自动关闭。
- 触觉：进入拖动 / 落位各一次轻震（`impact-light`），移除不震。

**迷你播放条 v2（已替换 M2 / M3 的旧版）**

| 项 | 规格 |
|---|---|
| 尺寸 | 358×64，圆角 18，左右各距屏 16 |
| 进度 | 顶部 2px 进度线，左右内缩 12；轨道白 `.10`，已播 `#6E8BFF`。**不放时间数字**，小尺寸不塞数据 |
| 文本 | ① 曲名 12.5/500 `#EAEBF1`；② 单行歌词 10/400 `#9B9EAE`（取代原来的「歌手 · 音源 · 音质」） |
| 回落 | 无歌词 / 纯音乐 → 第二行回落成「歌手 · 音源」，不留空行 |
| 右侧 | 播放暂停 18 · 下一首 16 · 播放列表 18，间距 11 |
| 手势 | 点条体展开播放页；点播放列表**直接**拉起 sheet（不先跳播放页） |

> 取舍：64px 高的迷你条只有两行文本，歌词与「歌手 / 音源」只能二选一。选歌词，因为它是「活着」的信息；音源与音质在播放页、队列行里仍然可见。

---

## 8. 性能与可访问性

- 目标 60fps：只对 `transform / opacity / filter` 做动画；列表用 FLIP 或 transform 位移。
- 玻璃 > 3 层、移动端、`prefers-reduced-transparency` 自动降级。
- 首屏骨架屏；图片 `loading="lazy"` + blurhash 占位。
- 虚拟滚动：所有歌曲列表，1000+ 条不卡顿。
- 键盘：`Space` 播放/暂停、`← →` 快退/快进、`/` 聚焦搜索、`Esc` 关闭抽屉；所有可交互元素有可见焦点环（2px 强调色 + 2px offset）。
- 对比度：正文 ≥ 4.5:1（`#9B9EAE` on `#0A0B0F` ≈ 7.2:1；强调色文字统一用 `#8FA4FF` 以满足 AA）。
- 响应式：≥1280 三栏 / 768–1279 两栏 / <768 单栏 + 底部 Tab。侧栏 < 1024 自动折叠为 64px 图标栏。

---

## 9. 交付说明

- 本文件的配色 / 圆角 / 间距 / 阴影与画布一致，可直接转为 `tokens.css` 或 Tailwind `@theme`。
- 画布中的专辑封面使用**渐变占位**（统一的多段线性渐变语言），接入真实数据后替换为 `song.img` + blurhash。
- 文案中的歌曲 / 歌手 / 歌单均为虚构示例，仅用于版式演示。
