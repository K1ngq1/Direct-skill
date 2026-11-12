# Direct Skill

把 TXT、Markdown 或 Excel 粗脚本整理成人物、场景、分镜和完整 Prompt，交付可编辑的 `<片名>_分镜脚本.xlsx`。需要图片或 LibTV 画布时，在同一任务中接着完成已授权的媒体步骤。

你提供脚本、目标时长和已有参考，Agent 负责创作、摄影、连续性与视觉判断。本地程序负责归档、版本、校验和 Excel；媒体由当前宿主连接的工具执行。

## 1. 安装

先在终端确认 Node.js 20+ 和 Python 3.10+ 可用，再安装 Excel 依赖。

~~~text
node --version
python --version
python -m pip install openpyxl
~~~

macOS / Linux 通常使用 `python3`，将上面的 Python 命令相应替换。

Windows 在 PowerShell 执行安装命令。

~~~powershell
irm https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python -
~~~

macOS / Linux 使用以下命令。

~~~sh
curl -fsSL https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python3 -
~~~

安装器会下载独立运行包，校验 ZIP 和逐文件 SHA-256，安装到 $CODEX_HOME/skills/storyboard-workbench；未设置 CODEX_HOME 时使用 ~/.codex/skills/storyboard-workbench。ExcelJS 已随包提供。已有同名安装会保留，并提示安装路径冲突。

默认安装随后调用 PATH 中的 Codex CLI，将 `https://mcp.liblib.tv/mcp` 注册为 LibTV MCP，并按需打开浏览器登录。用户使用自己的 LibTV 账号完成授权；安装器不携带账号或令牌，不运行媒体生成。已连接相同地址时复用原配置，名称冲突或禁用状态保留原样并报告。CLI 报告已保存凭据后，重启 Codex 或开启新会话；首次实际使用仍由 LibTV `doctor` 核对连接与当前权限。

只需文字与 Excel 时，可跳过 MCP。已经装好 Skill 的用户可单独补配 MCP，连接失败也用此命令重试，不必覆盖已有 Skill。[下载 install.py](https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py) 后运行：

~~~text
python install.py --skip-mcp
python install.py --mcp-only
~~~

默认 MCP 配置需要 Codex CLI 可用。MCP 配置或登录失败时，已安装文件保留，安装器退出码为 2；Skill 文件安装失败时退出码为 1。其他宿主可用 --dest 指定其 skills 父目录；目标不是 Codex 默认目录时只安装文件，不修改 Codex 配置。

~~~text
python install.py --dest "<宿主的skills目录>"
~~~

也可下载[独立 ZIP](https://github.com/K1ngq1/Direct-skill/releases/latest/download/storyboard-workbench.zip)，将其中的 storyboard-workbench 文件夹放入对应 skills 目录。手动解压不会配置 MCP；Codex 用户再运行 `python install.py --mcp-only`，其他宿主按自己的 MCP 入口连接。[安装器与全部发布文件](https://github.com/K1ngq1/Direct-skill/releases/latest)

**版本请以安装包的 `package-manifest.json` 为准。** 当前安装器的 LibTV 自动配置改动尚待发布，Release 安装命令取得的是已发布版本。

## 2. 第一次使用

在 Codex 的下一次会话中调用 `$storyboard-workbench`，附上脚本文件并发送下面的要求。自动发现不可用时，直接要求 Agent 读取安装目录中的 SKILL.md。

~~~text
使用 storyboard-workbench 处理附件脚本，生成完整分镜 Excel。
目标时长约 45 秒，横屏 16:9，写实生活喜剧。
目前没有角色或场景参考图，请从文字设定开始。
请先检查运行环境，再完成创作、核对、导出和正式文件验收。
本次只完成文字与 Excel。
~~~

已有确定参考图时，附上图片并说明对应的人物、场景和用途。未指定时长时，Agent 根据脚本的动作与衔接估算。首次检查会确认运行环境和输入可读性，工具或依赖缺失时给出具体位置与处理办法。

| 工作表 | 你可以查看或使用的内容 |
|---|---|
| 分镜脚本 | 镜头顺序、预计时长、画面、动作、对白、摄影、衔接和用户意见 |
| 生成Prompt | 完整人物、场景和分镜 Prompt，按任务加入视频正文与参数 |
| 人物与场景 | 共用造型、布景设定、参考图及关联镜头 |

原稿、正文版本、核对记录和制作日志保存在本地项目目录。后续可继续修改同一个项目，意见与历史随版本保留。

## 3. 全流程与架构

默认走文本与 Excel 路径。媒体分支由你选择，Agent 按当前步骤读取必要规则，并调用本地程序或已连接的工具。

~~~mermaid
flowchart TD
    A["用户提供脚本、目标时长与参考"] --> B["宿主 Agent<br/>读取 Skill 入口与本次必要规则"]
    B --> C["归档原稿，统一人物、场景与全片连续性"]
    C --> D["创作人物、场景、静帧与所需视频 Prompt"]
    D --> J["本地 JSON<br/>正文、来源与版本"]
    J --> E["程序硬校验与 Agent 语义核对<br/>具体问题局部修复"]
    E --> F["集中导出并回读正式 Excel"]
    F --> G["用户取得三表工作簿与制作日志"]
    E --> H{"本次媒体授权"}
    H -->|"仅配置画布"| I["MCP 创建或更新节点与引用边<br/>全部 run:false"]
    I --> K["回读 Prompt、模型、参数与连线"]
    H -->|"生成图片并准备视频节点"| L["图片工具生成资产<br/>保存原件并看图采用或确认"]
    L --> M["依赖就绪后生成分镜图<br/>逐张保存与检查"]
    M --> N["LibTV 上传、审核与挂图<br/>配置待运行视频节点"]
    N --> K
    H -->|"明确授权视频生成"| O["MCP 按原任务身份执行<br/>查询结果并检查实际媒体"]
    O --> P["保存回执、产物与验收结论"]
    K --> P
    P --> J
    P --> Q["按本次交付范围更新 Excel 和日志"]
    Q --> G
~~~

Agent 负责创作与视觉判断，本地脚本负责确定性的文件、版本和检查操作，图片工具或 LibTV MCP 负责媒体执行。正文以同一版 JSON 为准，Excel 和工具请求从该版本取值。完整的十一维画面要求、摄影、事实保护和连续性要求由共享 Skill 维护。[规则与操作入口](storyboard-workbench/SKILL.md)

## 4. 按任务选择用法

### 一次完成图片制作和视频节点准备

先确认宿主中的图片工具可用，且已通过安装器或宿主完成 LibTV MCP 账号授权，再提供脚本。

~~~text
按单次自动制作模式处理这份脚本。
生成必要的人物、场景和分镜图片，实际看图后由你检查并采用合格图。
将本轮图片上传 LibTV，连接对应的视频 Prompt，所有视频节点使用 run:false。
最后交付 Excel、画布链接和具体待处理项，连续完成已授权步骤。
~~~

这项指令授权 Agent 采用本轮检查合格的图片并推进依赖。图片数量和工具按本次要求确定，失败或未知项保留原回执，实际付费重试仍按授权处理。[单次自动制作流程](storyboard-workbench/references/single-run.md)

### 已有 Prompt，只接好 MCP 链路

~~~text
使用这个项目已封存的 Prompt，连接人物、场景、分镜图片到视频节点的完整链路。
先回读现有画布，再复用或补齐节点和引用边。
所有节点使用 run:false，只完成配置和回读验收。
~~~

此路径交付的是待运行节点。后续需要执行某些节点时，再明确给出工具、数量与生成范围。已有图片和待生成节点的引用状态会分别记录，节点连接成功后仍需通过实际媒体检查。[媒体操作索引](storyboard-workbench/references/media-execution.md)

### 接着修改脚本或 Excel

~~~text
继续这个项目。只修改第 5 镜的动作与对应 Prompt，保留其余已确认设定。
先读取我在 Excel 用户意见栏填写的反馈，核对受影响的连续性，更新正式文件并保留历史。
~~~

提供项目目录与当前工作簿。新会话接手时，Agent 从项目文件核对正文版本、反馈和未完成项。Excel 更新保留用户排版、图片与意见；同格冲突会指出具体位置。[交付与反馈合同](storyboard-workbench/references/visual-workflow.md)

### 中断后继续

~~~text
从这个项目的原检查点继续，先核对已完成、待运行和未知任务。
沿用原任务身份与回执恢复，继续尚未提交且依赖已就绪的已授权项。
告诉我具体阻塞和已完成交付。
~~~

同时提供原项目目录或原画布。连接中断、令牌过期、回执保存失败和内容问题有各自的恢复路径。已经提交但状态未知的任务须先回读确认。[恢复操作索引](storyboard-workbench/references/media-execution.md)

## 5. 宿主与版本选择

| 使用方式 | 入口 |
|---|---|
| 独立包安装 | 安装目录中的 SKILL.md，在宿主中调用 storyboard-workbench |
| Codex 开发仓库 | .agents/skills/storyboard-workbench/ |
| Claude Code 开发仓库 | .claude/skills/storyboard-workbench/，CLAUDE.md 提供兼容入口 |
| WorkBuddy 开发仓库 | .codebuddy/skills/storyboard-workbench/ |
| 其他宿主 | 显式读取共用 Skill，选择 default 适配 |

开发仓库的薄入口依赖完整目录，独立 ZIP 包已包含其运行资源。安装器默认自动配置 Codex 的 LibTV MCP；其他宿主的 MCP 及图片工具仍通过各自入口连接。宿主使用已有模型配置，账户、密钥、额度与媒体授权由使用环境提供。[平台适配说明](storyboard-workbench/adapters/README.md)

包内已包含 Humanizer-zh 中文润色规则、适配后的导演规则和 ExcelJS，并保留其许可证；分镜流程按需读取，无需用户另装这些上游项目。安装包只收录明确列入发布清单的文件，不会复制作者电脑上的其他全局 Skill、插件、账号配置或私有素材。Humanizer-zh 在本包中是共用规则资源，不会另行注册为全局 Skill。

## 范围与验证状态

- 新任务使用 v2 合同，历史项目继续按原合同读取。实际宿主能力以本次运行观察为准。
- 交付验收分别记录程序检查、正文核对、画面检查与用户确认。节点存在、任务接受或规则哈希均不足以证明实际画面质量。
- 本地装载、链接、数据合同和执行恢复有程序测试。Claude Code、WorkBuddy 客户端及跨模型端到端效果仍需实际验证。
- 规则精简的收益需通过真实任务测量；模型遵循规则的效果与媒体生成质量仍需验收。历史验收记录与测试材料保留在本地。
- 中文字体与排版需在交付目标环境核对。安装和本地项目使用说明以本 README 为入口，Agent 执行约束见 [AGENTS.md](AGENTS.md)，业务规则按 [Skill](storyboard-workbench/SKILL.md) 路由读取。

<details>
<summary>开发与发布维护</summary>

从完整仓库运行与改动范围相称的检查。

~~~text
python distribution/public_files.py
node storyboard-workbench/scripts/runtime.mjs doctor
~~~

使用 `python distribution/build.py --output <新文件.zip>` 从已提交的公开运行文件构建独立包。推送 `skill-v*` 标签后由 GitHub Actions 验证并发布 ZIP、校验文件和安装器。包内 package-manifest.json 记录源码提交及文件清单，用户项目、素材、凭据和历史人评保存在本地。

新增宿主或模型在[适配注册表](storyboard-workbench/adapters/manifest.json)登记，复用共享规则加载器。测试使用合成输入，实际平台验证记录保留版本、输入、工具条件与结果。

</details>

项目采用 [MIT](LICENSE)。随包第三方材料保留各自许可证：[ExcelJS](storyboard-workbench/scripts/vendor/LICENSE-exceljs)、[Humanizer-zh](storyboard-workbench/references/humanizer-zh/LICENSE)、[导演规则来源](storyboard-workbench/references/director-license.txt)。
