# 疏音官网

纯静态单页，零依赖。**页面和安装包分开托管**：页面几十 KB 放静态托管，安装包十几 MB 放代码托管平台的发行版。

## 目录

```
site/
├── index.html          # 全部内容与样式（46 KB，不含任何安装包）
├── downloads.json      # 下载地址与版本号，唯一要改的配置
├── build-site.mjs      # 构建脚本：产出两份可上传的产物
└── assets/
    ├── icon.png        # 站点图标 / 页头 logo
    └── icon-32.png     # favicon
```

部署产物（脚本生成，不手工维护）：

```
dist/site/       46 KB   → 传到静态托管（index.html + assets + downloads.json）
dist/release/    12.6 MB → 传到 Gitee / GitHub 的 Releases
```

## 为什么要分开

安装包 3.5 MB ×2 + 5.6 MB，放进站点里，任何有流量计费的托管都会很快撞额度：

| 托管方 | 计量方式 | 页面（46 KB） | 带安装包（12.6 MB） |
|---|---|---|---|
| CloudBase 免费版 | 3000 资源点/月，CDN 210 点/GB | 3000 点 ≈ **14 万次**页面访问 | 3000 点 ≈ **1150 次**下载，用完整个环境停服（连云同步一起停） |
| Cloudflare Pages | 带宽不计费 | 无所谓 | 无所谓，但国内下载慢 |
| GitHub Releases | 流量不计费，单文件 2 GB | — | 13 MB/版本，**不限版本数**，国内速度一般 |
| Gitee Releases | 单个附件 100 MB，仓库附件总量 1 GB | — | 13 MB/版本，国内直链更快，但总量只有 1 GB |

分开之后，静态托管只承担 HTML 的流量，安装包流量走代码托管平台，互不挤占。

⚠️ **放安装包的那个仓库必须是公开的**。Gitee 和 GitHub 都一样：私有仓库的 Release 附件
匿名下载会返回 403 / 要求登录，官网的下载按钮点了就废。代码可以继续留在私有仓库，
安装包单独放一个只建 Release 的公开仓库即可。

## 本地预览

```bash
node tmp/site-serve.mjs        # 仓库根目录跑，http://127.0.0.1:5301
```

`downloads.json` 用 `fetch` 读取，`file://` 直接双击打开会被 CORS 拦掉，页面会显示「下载地址尚未配置」。看效果请用上面的本地服务。

## 构建

```bash
cd code/apps/site
node build-site.mjs --github <你的账号>/<仓库名>
```

用 Gitee 或别的同构平台就换完整前缀：

```bash
node build-site.mjs --base https://gitee.com/<账号>/<仓库名>/releases/download
```

脚本做四件事：

1. 从 `dist/` 挑出最新的三个包（按文件修改时间），读出真实体积；
2. 重写 `downloads.json`：版本号、tag、文件名、体积全部对齐，首屏那行小字的版本号也跟着走；
3. 把包按 ASCII 名拷进 `dist/release/`（`疏音_0.6.104_android_phone.apk` → `shuyin-android-0.6.104.apk`）；
4. 把页面文件拷进 `dist/site/`。

`--base` / `--github` 省略时沿用 `downloads.json` 里已有的值，不会清空。

## 发版流程

1. 编译，产物落在 `dist/`（安卓两个 apk、桌面一个 exe）；
2. 跑 `node build-site.mjs`，看 `dist/release/` 里的文件名；
3. 到 GitHub 仓库 → Releases → Draft a new release，tag 填 `v0.6.104`，把 `dist/release/` 里的三个包拖进去发布；
4. **只把 `dist/site/downloads.json` 覆盖上去**——版本号变了，但 `index.html` 不用重传。

第 4 步是这套结构最省事的地方：发版只动一个 300 字节的 json。

> GitHub 的附件下载会 302 跳到 `objects.githubusercontent.com`，国内多数网络能下但偏慢。
> 如果以后觉得慢，把 `downloads.json` 里对应条目的 `mirror` 填上一个国内直链，
> 下载卡里会多一行「换备用线路」，页面不用改。

## 部署

### 方案 A：腾讯云 CloudBase 静态托管（推荐，你现在就有）

免费体验版环境、国内节点、默认域名 `*.tcloudbaseapp.com` **免备案**、地址长期有效。

1. 控制台 → 云开发 → 你的环境 → 静态网站托管 → 开启；
2. 上传 `dist/site/` 里的全部文件（保持目录结构，`assets/` 要一起传）；
3. 访问 `https://<环境 ID>.tcloudbaseapp.com`。

⚠️ 这个环境和云同步共用同一份 3000 资源点/月。页面只有 46 KB，1 GB 流量能撑一万多次访问，
**但别把安装包放回来**——那会直接吃掉同步的额度，额度耗尽时整个环境停服。

⚠️ 免费版**不支持自定义域名**（个人版 19.9 元/月才有 1 个），所以地址是 `tcloudbaseapp.com`
的子域。要用自己的域名，两条路：升级个人版 + 备案，或者看下面的方案 C。

### 方案 B：Cloudflare Pages（免备案，最省事）

1. 登录 dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**；
2. 把 `dist/site/` 目录拖进去；
3. 拿到 `xxx.pages.dev`，长期有效，不用买域名。

带宽不计费、单文件 25 MB、每月 500 次部署。国内访问时好时慢，这是免备案的代价。

### 方案 C：备案后挂国内节点

域名（.com 约 60~80 元/年）+ ICP 备案（免费，需名下有一台境内云服务器，审核 1~3 周）。
备案通过后可以 CNAME 到 EdgeOne 大陆节点，或在自己的服务器上用 Nginx 指向 `dist/site/`。

### 为什么不推荐另外两家

**EdgeOne Pages**：平台分配的项目域名 / 部署域名（`*.edgeone.dev`、`*.edgeone.cool`）在中国大陆
**一律返回 401**，控制台**没有**关闭鉴权的开关，含大陆的区域只有 3 小时有效的预览链接。
想拿到长期地址必须绑自有域名。三条加速区域的差异：

| 区域 | 大陆访问 | 备案 |
|---|---|---|
| 中国大陆可用区 | 需绑自定义域名 | **必须 ICP 备案** |
| 全球（含中国大陆） | 需绑自定义域名 | **必须 ICP 备案** |
| 全球（不含中国大陆） | 需绑自定义域名 | 不要求备案，节点在境外 |

**阿里云 ESA Pages**：公共域名「仅供测试使用，使用该域名访问需添加 token 进行鉴权，token 有效期为
60 分钟」；而且控制台**没有本地目录上传入口**，只能 GitHub 导入或 CLI（要 AK/SK）。

## 内容上要注意的两条红线

1. **不要写「免费听全网」「破解会员」这类话术**。页面现有措辞是「你自己的账号」「以各平台服务条款为准」，
   页脚有完整免责声明，别删。
2. **不要放带平台 VIP 标识的截图**。真机截图请用本地音乐的界面。

## 还没做的

- **产品截图**：首屏现在是唱片视觉，没有真实界面。补 3~4 张真机截图（首页、播放页、音效弹窗、车机横屏）。
- **更新日志**：`<section>` 结构留好了，加一个 `#changelog` 区块即可。
- **备案号**：备案下来后要加到页脚，否则会被抽查。
