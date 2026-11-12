# Direct Skill

把 TXT、Markdown 或 Excel 脚本整理成人物、场景、分镜与完整 Prompt，交付可编辑的 `<片名>_分镜脚本.xlsx`。需要跑图或制作 LibTV 画布时，可以在同一个项目中继续完成你指定的步骤。

## 1. 安装

需要 Node.js 20+、Python 3.10+ 和 openpyxl。自动配置 LibTV MCP 还需要 PATH 中可用的 Codex CLI。

~~~text
node --version
python --version
python -m pip install openpyxl
codex --version
~~~

Windows 在 PowerShell 执行：

~~~powershell
irm https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python -
~~~

macOS / Linux 执行；其他 Python 命令也相应使用 `python3`：

~~~sh
curl -fsSL https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python3 -
~~~

安装器会下载 `direct-skill.zip`，校验 ZIP 和逐文件 SHA-256，将 Skill 安装到 `$CODEX_HOME/skills/direct-skill`；未设置 `CODEX_HOME` 时使用 `~/.codex/skills/direct-skill`。随后自动注册 LibTV MCP，并按需打开浏览器，由你使用自己的 LibTV 账号完成授权。已有相同地址的 Codex MCP 配置会复用；名称冲突或禁用状态会保留并报告。安装过程不生成图片或视频。

安装完成后重启 Codex 或开启新会话。首次使用 LibTV 时，Agent 会通过 `doctor` 检查当前连接和权限。

只做文字和 Excel，或为已有安装补配 MCP，可[下载 install.py](https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py) 后选择相应命令：

~~~text
python install.py --skip-mcp
python install.py --mcp-only
~~~

已有同名安装不会被覆盖。MCP 配置失败时已安装文件保留，可用 `--mcp-only` 重试；文件安装失败的退出码为 1，MCP 未完成的退出码为 2。旧版 `storyboard-workbench` 安装保留原样，新版使用 `$direct-skill`。

其他宿主可使用 `python install.py --dest "<宿主的skills目录>"`。目标不是 Codex 默认目录时只安装文件，MCP 通过该宿主的入口连接。也可[下载独立 ZIP](https://github.com/K1ngq1/Direct-skill/releases/latest/download/direct-skill.zip)，将 `direct-skill` 文件夹放入对应 skills 目录；手动解压后，Codex 用户可用 `--mcp-only` 补配连接。

[查看最新 Release](https://github.com/K1ngq1/Direct-skill/releases/latest)。具体源码版本与文件清单记录在安装包的 `package-manifest.json` 中。

## 2. 第一次使用

在新会话中调用 `$direct-skill`，附上脚本或提供可读取的文件路径。下面的 Prompt 可直接修改，方括号中的内容按你的实际工作填写；目标时长未定时，可以让 Agent 根据脚本估算。

~~~text
使用 $direct-skill 处理附件脚本，生成完整的分镜 Excel。

项目保存位置：[本地项目目录]。
制作场景：[广告 / 剧情短片 / 产品演示 / 其他]。
目标时长：[填写时长，或根据脚本估算]。
画幅与视觉风格：[填写画幅、画风和其他制作要求]。
已有参考：[说明人物、场景、产品等参考的对应关系；没有则从文字设定开始]。

请先检查运行环境并读取本次需要的规则，再完成人物与场景设定、分镜、完整 Prompt、核对和正式 Excel 导出验收。
本次只完成文字与 Excel。
~~~

自动发现不可用时，要求 Agent 读取安装目录 `direct-skill/SKILL.md`。参考图请说明对应的人物、场景或产品；后续修改时，继续提供同一个项目目录与当前工作簿。

## 3. 参考 Prompt：跑图与 LibTV 画布

需要继续跑图时，可使用下面的参考 Prompt。时长、画幅、风格、工具、图片数量和交付范围均可按实际场景调整；先确认所选图片工具可用，并完成安装器引导的 LibTV 账号授权。

~~~text
使用 $direct-skill，按单次自动制作流程处理附件脚本。

项目保存位置：[本地项目目录]。
制作目标、时长、画幅与风格：[填写本次要求]。
已有参考：[说明附件用途及已确认设定]。
图片工具：[填写本次使用的工具]。
本次图片生成范围与数量：[填写需要生成的人物、场景、分镜及数量]。
LibTV 目标画布：[填写画布名称或链接，或要求新建]。

先完成文字规划、Prompt 和检查，再按依赖生成人物、场景和分镜图。
由你实际看图并采用合格图，继续依赖已就绪的后续步骤。
将本轮图片上传 LibTV，连接对应的视频 Prompt，所有视频节点使用 run:false。
本次完成图片制作和待运行视频节点，不运行视频生成。

最后交付分镜 Excel、画布链接和具体待处理项，连续完成上述已授权步骤。
~~~

该示例包含图片生成及由 Agent 采用合格图的授权，具体数量以你填写的范围为准。实际视频生成需另行说明工具、镜头、数量与执行范围。[单次制作流程](storyboard-workbench/references/single-run.md)

继续已有项目时，也可以直接使用下面的简短要求，并替换其中的对象：

| 工作场景 | 参考要求 |
|---|---|
| 只连接画布 | 使用本项目已封存的 Prompt 和已有图片，回读画布后补齐节点与引用边；全部 `run:false`，完成回读验收。 |
| 修改脚本或 Excel | 只修改 `[镜头 / 内容]`，先读取 Excel 用户意见，核对受影响的连续性，更新正式文件并保留排版、图片、意见与历史。 |
| 中断后继续 | 从本项目原检查点继续，先核对已完成、待运行和未知任务，沿用原任务身份与回执恢复，完成剩余已授权步骤。 |

提供原项目目录、当前工作簿或目标画布即可继续。[媒体操作与恢复](storyboard-workbench/references/media-execution.md) · [Excel 交付与反馈](storyboard-workbench/references/visual-workflow.md)

## 4. 交付内容与内置规则

| 工作表 | 内容 |
|---|---|
| 分镜脚本 | 镜头顺序、预计时长、画面、动作、对白、摄影、衔接和用户意见 |
| 生成Prompt | 完整人物、场景和分镜 Prompt，按任务加入视频正文与参数 |
| 人物与场景 | 共用造型、布景设定、参考图及关联镜头 |

原稿、正文版本、核对记录和制作日志保存在本地项目目录。Excel 与工具请求复用同一版正文，后续修改保留用户意见与历史。

| 随包内容 | 用途 |
|---|---|
| Humanizer-zh 中文润色规则 | 按需润色表达，保留事实、关系与确定程度 |
| 本项目适配的导演规则 | 人物、场景美术、摄影和跨镜连续性 |
| ExcelJS | 导出可编辑 Excel，无需另装该依赖 |

这些内容已随包提供，无需另装上游项目。Humanizer-zh 作为内部规则使用，不单独注册全局 Skill。安装包仅收录[公开运行文件清单](distribution/public-files.json)中的资源，不携带作者电脑上的其他 Skill、插件、账号或私有素材。

## 5. 宿主与验证范围

| 使用方式 | 入口 |
|---|---|
| 独立包 | 安装目录中的 `SKILL.md`，在宿主中调用 `direct-skill` |
| Codex 开发仓库 | `.agents/skills/direct-skill/` |
| Claude Code 开发仓库 | `.claude/skills/direct-skill/` |
| WorkBuddy 开发仓库 | `.codebuddy/skills/direct-skill/` |
| 其他宿主 | 显式读取[共用 Skill](storyboard-workbench/SKILL.md)，选择 default 适配 |

自动配置 LibTV MCP 目前覆盖 Codex。其他宿主的 MCP 与图片工具通过各自入口连接；账户、密钥、额度和媒体授权由使用环境提供。[平台适配说明](storyboard-workbench/adapters/README.md)

本地已检查安装器分支、打包安装、凭据状态处理和配置冲突保护；真实 LibTV 登录仍需由用户完成授权后验证。Claude Code、WorkBuddy 客户端及跨模型端到端效果需在对应环境实测。节点存在或任务受理不代表媒体质量合格，图片和视频仍需检查实际产物；中文字体与 Excel 排版在交付环境核对。

<details>
<summary>开发与发布维护</summary>

内部运行代码继续使用 `storyboard-workbench/` 路径，保留已有项目与脚本兼容。

~~~text
python distribution/public_files.py
node storyboard-workbench/scripts/runtime.mjs doctor
python distribution/build.py --output release/direct-skill.zip
~~~

构建从已提交的公开运行文件取值。推送 `skill-v*` 标签后，GitHub Actions 验证并发布 ZIP、SHA-256 和安装器；普通源码 push 不更新 Release 下载。用户项目、素材、测试和历史人评保留在本地。

执行约束见 [AGENTS.md](AGENTS.md)，业务规则从唯一 [Skill](storyboard-workbench/SKILL.md) 读取，宿主与模型差异在[适配注册表](storyboard-workbench/adapters/manifest.json)维护。

</details>

项目采用 [MIT](LICENSE)。随包第三方材料保留各自许可证：[ExcelJS](storyboard-workbench/scripts/vendor/LICENSE-exceljs)、[Humanizer-zh](storyboard-workbench/references/humanizer-zh/LICENSE)、[导演规则来源](storyboard-workbench/references/director-license.txt)。
