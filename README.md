# 文脉 Wenmai · 智能写作续写

> 停笔的一瞬间，下一句已经在等你。

**项目地址：[github.com/QuniteZone/WenMai](https://github.com/QuniteZone/WenMai)** · License: MIT

文脉是一个**为中文内容写作设计**的 VS Code 幽灵文本扩展。它不要求你按快捷键：正常写作，停下来约 0.2 秒，灰色续写就会出现在光标后；按 `Tab` 接受，继续打字则自动重新生成。

它不是代码补全的换皮版。上下文挑选、写作准则、断句方式、重复过滤，全部按"写文章"这件事重新设计。

---

## 为什么是"文脉"

VS Code 里的 AI 补全大多为代码服务：补全整行、补全函数、补全括号。写文章时，你需要的是另一套东西：

- **接得住文气**：延续你的人称、时态、语气和用词习惯，而不是突然换成 AI 腔。
- **只写一句**：幽灵文本一出现就是半屏，反而打断思路。文脉默认最多两句。
- **不重复**：不能把你刚写的话再写一遍，也不能把提示词、写作准则当成正文吐出来。
- **不编造**：没有依据的数字、人名、引文，宁可不写。
- **不打扰**：正文里才出现，代码块、URL、公式、frontmatter 里保持安静。

---

## 核心特性

| 能力 | 说明 |
|---|---|
| 自动幽灵文本 | 输入停顿即请求；仅移动光标（行首/行中/行尾）停顿后也会主动请求，无需快捷键；`Tab` 接受，`Esc` 忽略 |
| 内置写作准则 | 10 条通用准则 + 6 种文体画像，随每次请求发送 |
| 上下文感知 | 行内续写（FIM）发送光标前 1500 字；Chat 兜底与长续写另按需参考光标后 500 字；附带 Markdown 标题路径与智能行首截断 |
| 低延迟 | keep-alive 连接池、流式响应、写完一句立刻停止、防抖、结果缓存 |
| 重复过滤 | 前缀复述、准则泄漏、suffix 重叠、整句重复，四道闸门 |
| 中文标点修正 | 自动把中文语境里的半角 `, . ? ! ; :` 修正为全角，保护 `1.5` 与英文 |
| 本地格式修正 | 标题/列表/任务列表/引用块缺空格、中文半角标点、重复标点、中英文空格、LaTeX 环境/公式/正文标点；只在差异字符上画删除线并就地显示幽灵文本，`Tab` 应用（与 AI 续写一致），不请求 API |
| 写作场景保护 | 围栏代码块、行内代码、frontmatter、URL、HTML 标签/script/style/注释、LaTeX 行内与行间公式、Typst 公式内不触发；正文照常触发 |
| 密钥安全 | API Key 存在 VS Code `SecretStorage`，不落明文文件 |
| 长续写 | `Ctrl+Alt+Enter` 用 Chat 模型补 2~4 句，适合"先写一段再看看" |
| 提示词透明 | `文脉: 查看当前提示词` 预览实际发送的 prompt、请求参数与长续写消息 |

### 写作场景保护到底管什么

| 光标位置 | 是否触发 |
|---|---|
| Markdown / 纯文本正文 | ✅ |
| Markdown 围栏代码块、行内代码（含 ```` 与 `` `` ` `` ``） | ❌ |
| frontmatter | ❌ |
| 行尾 URL、Markdown 链接地址 | ❌ |
| HTML 正文（如 `<p>正文`） | ✅ |
| HTML 标签/属性、`<script>`、`<style>`、`<!-- 注释 -->` | ❌ |
| LaTeX 正文 | ✅ |
| LaTeX `$...$`、`$$...$$`、`\[...\]`、`equation/align` 等环境、`verbatim/lstlisting/minted` | ❌ |
| Typst 正文 | ✅ |
| Typst `$...$`（含跨行） | ❌ |

这些判断只影响"光标本位置是否请求"，不会影响文件其他位置的正常续写。想全部放开（包括代码块和公式），把 `wenmai.proseOnly` 设为 `false` 即可。

---

## 安装

### 方式 A：克隆后脚本安装（推荐）

```powershell
git clone https://github.com/QuniteZone/WenMai.git
cd WenMai
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

然后重启 VS Code，或在命令面板执行 `Developer: Reload Window`。

脚本会安装到：

```
%USERPROFILE%\.vscode\extensions\QuniteZone.wenmai-1.0.0
```

并自动清理同名的旧版本。如果扩展目录里还留着开发调试用的 `wenmai` 文件夹，脚本会提示你删除，避免 VS Code 同时加载两份、重复发起请求。

### 方式 B：开发调试

用 VS Code 打开 `wenmai` 文件夹，按 `F5`，会启动 Extension Development Host。在新窗口里写作即可。

### 方式 C：打包 vsix

```powershell
npm install -g @vscode/vsce
vsce package
code --install-extension wenmai-1.0.0.vsix
```

---

## 第一次使用

1. `Ctrl+Shift+P` → `文脉: 设置 API Key`，粘贴 `sk-...`。
2. 打开一个 `.md` 或 `.txt` 文件，写几句话。
3. 停笔约 0.2 秒，光标后出现灰色文字。
4. 按 `Tab` 接受；按 `Esc` 忽略；继续打字会重新生成。

> 如果没有任何反应，先确认 VS Code 设置里 `editor.inlineSuggest.enabled` 为 `true`（默认就是 true），再看 `文脉: 打开日志`。

---

## 写作准则

文脉把写作准则压缩成一段约 150 字的"写作设定"，放在每次请求的最前面。它约束的是续写，不会改动你已经写下的内容。

### 内置通用准则

1. 紧接上文续写，不另起炉灶。
2. 不重复已经写过的文字。
3. 延续上文的人称、时态、语气与术语。
4. 每句都要带来新信息，不重复同义表达。
5. 优先写具体的动作、场景与细节。
6. 不突然总结，不强行升华。
7. 避免"非常重要""具有重要意义""首先其次最后"一类空话套话。
8. 中文使用全角标点；中英文之间加空格。
9. 不编造事实、数据、人名与引文。
10. 只输出正文，不加解释、不加标题、不使用代码块。
11. 一次最多续写 1~2 句，话说完就停。
12. 与光标前的标点自然衔接，不重复衔接处的字词。

### 文体画像

| 文体 | 续写取向 |
|---|---|
| 通用 | 保持原文节奏，长短句错落 |
| 公文 | 规范庄重，多用动宾结构，层次清楚，不口语化 |
| 学术 | 论点与论据衔接，术语准确，表述克制，避免绝对化 |
| 小说 | 用动作、对话与感官细节推进，保持视角统一 |
| 新媒体 | 短句、具体场景、有节奏感，少说教，不用营销套话 |
| 商务 | 结论先行，信息密度高，动词明确，少堆形容词 |

默认是「自动」：根据最近 3000 字里的关键词判断文体，判断不出来就回退到「通用」。也可以在状态栏菜单里手动固定。

### 自定义准则

`文脉: 设置写作准则` 里可以追加最多 300 字，例如：

```
不要使用第一人称；每段不超过三句；避免感叹号；不要出现"我们"。
```

自定义准则会接在内置准则之后，一起发给模型。

### 提示词是怎么拼的

自动续写每次发送的 `prompt` 只有三段，按顺序用换行拼接：

1. **写作设定**：文体画像 + 通用准则 + 句数上限 + 你的自定义准则（可用 `wenmai.useGuidelines` 关闭）
2. **文档位置**：Markdown 的标题路径，例如 `（文档位置：数字化转型 > 一、问题）`
3. **光标前文本**：默认最近 1500 字，尽量从行首开始截断（光标后文本默认不发送，见下文 `useSuffix`）

一个真实例子：

```
（写作设定：通用。紧接上文续写；不重复已写文字；只顺着已有内容往下写，不点评、不改写上文；……本次最多续写 2 句，话说完就停。）
（文档位置：数字化转型 > 一、问题）
# 数字化转型

## 一、问题

很多单位把数字化理解成把纸质表格搬进电脑。……
群众不看你说什么，只看
```

请求体只带这些字段：

```json
{
  "model": "deepseek-flash",
  "prompt": "上面那三段拼起来的完整文本",
  "max_tokens": 384,
  "temperature": 0.3,
  "stream": true
}
```

**关于 `suffix`（实测定论）**：FIM 的 `suffix` 是“填空”语义——模型要把光标处补成能与后文衔接的文字。当光标后的原文本身已经是完整句子（写作时最常见），模型会判断“无需插入”，直接返回 `finish_reason=stop`、`completion_tokens=0` 的空结果。实测 DeepSeek `/beta/completions` 带完整句子 suffix 时稳定为空，去掉 suffix 立刻正常输出。因此**行内续写（FIM）的请求永远不带 `suffix`**，只依据光标前的文本；光标后的文字只在 Chat（自动兜底与长续写）里作为参考，且要显式开启 `wenmai.useSuffix` 才会带上。整篇文档、文件路径、文件名都不会发送，API Key 只放在 `Authorization` 请求头里。

想看你**当前光标位置**实际会发什么：命令面板执行 `文脉: 查看当前提示词`，会打开一个临时预览文档，包含 FIM prompt、请求参数，以及长续写的 system/user 消息。不会发请求，也不会保存文件。

---

## 本地格式修正（L1）

除了续写，文脉还会检查光标所在行的"确定是错"的格式问题。它不请求模型、不消耗 token，也不需要 API Key。

命中时，文脉会先算出旧行与修正行的**最小字符差异**，只做三件事：

- 在真正出错的字符上画**删除线**（未变化的文字完全不动）；
- 在差异位置就地显示斜体、幽灵配色的替换文本（`⟶` 后跟新字符，空格显示为 `␣`）；
- 应用时只提交这些差异范围，撤销粒度就是一次标点修改。

例如 `中文,测试` → `中文，测试` 只标记第 3 个字符；`##3.内容` → `## 3.内容` 是纯插入，没有删除线，只在 `##` 后显示 `⟶ ␣`。光标在行内任何位置都可以触发。应用方式：

- 快捷键 `Tab`，与接受 AI 续写完全一致；
- 备用快捷键 `Ctrl+Alt+.`（macOS：`Cmd+Alt+.`）；
- 鼠标悬停到删除线或幽灵文本上，点击“应用修正”；
- `Ctrl+.` 打开快速修复（Code Action），选择“文脉：应用本地修正”；
- 命令面板执行 `文脉: 应用本地格式修正`。

> `Tab` 只在本地修正预览存在时才会接管；如果 VS Code 开启了“Tab 移动焦点”，或当前有 AI 续写、补全列表、代码片段会话，`Tab` 仍优先处理这些原有目标，可用悬停点击或 `Ctrl+Alt+.` 应用。

> **不打断输入法**：提示出现前会等约 0.45 秒；如果光标正贴着英文字母（例如正在用拼音输入 `yinci`，或英文单词还没敲完），并且整行只有“中英文之间补空格”这一种差异，文脉会跳过本次修正，AI 续写照常提供。光标离开字母、或行内还有真实标点错误时才显示预览。手动快速修复不受此限制。

> 这里没有使用 VS Code 原生的行内建议，而是使用装饰器预览。原因是 VS Code 1.144 的行内建议可见性判定会过滤掉“在光标前插入空格/替换标点”的替换，`filterText` 也没有被扩展宿主传入内部模型；标准 `InlineCompletionItem` 对 `##3.内容 → ## 3.内容` 这类修正不会显示。装饰器方案不依赖这个限制，也不会自动改文件，必须明确应用后才写入。

### Markdown

| 规则 | 例子 |
|---|---|
| 标题缺空格 | `##3.内容` → `## 3.内容` |
| 单井号数字/中文数字标题 | `#1.标题` → `# 1.标题`；`#一、总则` → `# 一、总则` |
| 无序列表缺空格 | `-内容` → `- 内容`；`+内容` → `+ 内容` |
| 有序列表缺空格 | `1.内容` → `1. 内容`；`1)内容` → `1) 内容` |
| 任务列表缺空格 | `- [ ]任务` → `- [ ] 任务`；`- [x]完成` → `- [x] 完成` |
| 引用块内标题/列表 | `> ##3.内容` → `> ## 3.内容`；`> -内容` → `> - 内容` |
| 中文半角标点 | `我们认为,这个问题` → `我们认为，这个问题` |
| 重复标点 | `非常重要。。` → `非常重要。`；`好的,,继续` → `好的，继续` |
| 中英文空格 | `使用VS Code写作` → `使用 VS Code 写作` |
| 省略号 | `中文...` → `中文……` |

### LaTeX

| 规则 | 例子 |
|---|---|
| 环境名去空格 | `\begin{ equation }` → `\begin{equation}` |
| 行首漏写反斜杠 | `begin{equation}` → `\begin{equation}` |
| 同一行起止环境不匹配 | `\begin{equation}...\end{align}` → `\begin{equation}...\end{equation}` |
| 公式内全角标点 | `$a，b$` → `$a,b$`；`\[ a（b） \]` → `\[ a(b) \]`；`equation` / `align` / `cases` / `matrix` 等环境同样处理 |
| 正文半角标点 | `中文,测试` → `中文，测试` |
| 正文中英文空格 | `使用VS Code写作` → `使用 VS Code 写作` |
| 正文命令参数 | `\section{标题,副标题}` → `\section{标题，副标题}` |

### 不修改什么

- Markdown 的 `#tag`（Obsidian 标签）、`*内容*`（强调与列表有歧义）、四空格缩进、代码围栏、frontmatter、行内代码、URL、HTML 标签/script/style/注释、`$...$` 公式。
- LaTeX 的注释、`\verb` / `\lstinline` / `\mintinline`、`verbatim` / `lstlisting` / `minted` 代码环境，以及公式内容（公式内全角标点除外）。
- LaTeX 的 `\label` / `\ref` / `\cite` / `\url` / `\href` / `\includegraphics` 等标签、路径、URL 参数整段保护；`\section` / `\caption` / `\textbf` / `\text` 等正文命令的参数按正文修正。
- 拿不准的就不改：同一行有多个 `\begin` / `\end` 时不做环境名纠正；英文为主的句子里不把半角逗号改成全角；`1.5` 不会被当成有序列表。
- 这一版只做 L1 的确定性规则，不做语义改写。L2 的 AI 句子修正（显式快捷键触发）会作为下一步。

配置：

| 配置 | 默认 | 说明 |
|---|---|---|
| `wenmai.autoFix` | `true` | 本地修正总开关 |
| `wenmai.fixCjkLatinSpacing` | `true` | 是否在中文与英文字母之间补空格 |

> 本地修正的代码/公式保护独立于 `wenmai.proseOnly`。`proseOnly` 控制的是"是否向模型发请求"，不会让本地规则去改代码块或公式。

---

## 使用方式

### 自动续写（主路径）

正常输入即可。文脉内部做了防抖：每次按键 VS Code 都会调用 provider，但只有你停下来的那一次会真正发请求。

- `Tab`：接受 AI 续写；本地修正预览存在时也用于应用修正
- `Esc`：忽略 AI 续写建议
- 继续输入：旧建议自动作废，重新生成
- 光标移到别处：旧建议消失，停稳约 0.3 秒后自动为新位置生成（`wenmai.triggerOnCursorMove`，默认开启）

### 光标移动也会触发

VS Code 自带的 inline suggestion 只在输入/删除后请求；仅移动光标时，扩展的 provider 根本不会被调用。文脉监听选区变化，在光标停稳后执行官方命令 `editor.action.inlineSuggest.trigger`（等同于手动按 `Ctrl+Alt+Space`），所以把光标放到开头、段中或结尾，等一会儿就会出现建议，不需要先敲一个字。

- 输入引起的移动仍交给 VS Code 原生触发，不会重复发请求；
- 选中文字、出现多光标、只读文档、语言未启用时跳过；
- 快速连按方向键只会触发最后一次（防抖 + 冷却）；
- 想省调用可关闭 `wenmai.triggerOnCursorMove`，关闭后只在输入或手动触发时出现建议。

### 手动立即生成

`Ctrl+Alt+Space`。用于想跳过停顿、立刻要建议，或临时关闭了 `wenmai.triggerOnCursorMove` 的场景。

### 长续写

`Ctrl+Alt+Enter` 或状态栏菜单 → `长续写`。使用 Chat Completions 端点生成 2~4 句并直接插入，按 `Ctrl+Z` 可撤销。适合写段落开头、换段、卡壳时"先要一段看看"。

### 状态栏

右侧 `✦ 文脉`：

- `✦` 空闲
- `⟳` 正在生成
- `⊘` 已关闭

悬停可看模型、文体、上次首字/总耗时、本次会话统计。点击打开设置菜单。

---

## 配置

在设置里搜索 `wenmai`。

### 体验

| 配置 | 默认 | 说明 |
|---|---|---|
| `wenmai.enabled` | `true` | 自动续写总开关 |
| `wenmai.triggerOnCursorMove` | `true` | 只移动光标并停顿后也主动请求；关闭后仅在输入或手动触发时出现建议 |
| `wenmai.maxSentences` | `2` | 单次最多几句；`1` 最快 |
| `wenmai.maxChars` | `220` | 单次最大字符数，超出后截到最近完整句 |
| `wenmai.debounceMs` | `220` | 停笔多久后请求；越大越省调用 |
| `wenmai.minIntervalMs` | `120` | 两次真实请求的最小间隔 |
| `wenmai.stream` | `true` | 流式响应 + 写完一句提前结束 |
| `wenmai.cacheSize` | `40` | 相同上下文的缓存条数；`0` 关闭 |

### 模型与端点

| 配置 | 默认 | 说明 |
|---|---|---|
| `wenmai.model` | `deepseek-flash` | FIM 补全模型 |
| `wenmai.baseUrl` | `https://api.deepseek.com/beta` | 请求 `{baseUrl}/completions` |
| `wenmai.chatUrl` | `https://api.deepseek.com/chat/completions` | 长续写端点 |
| `wenmai.chatModel` | 空（同补全模型） | 长续写模型；FIM 模型不支持 Chat 时单独指定 |
| `wenmai.maxTokens` | `384` | 单次生成上限；`deepseek-flash` 会先消耗隐藏推理 token，建议 256~512 |
| `wenmai.temperature` | `0.3` | 越低越稳、越贴原文 |
| `wenmai.timeoutMs` | `12000` | 单次请求超时 |

### 上下文

| 配置 | 默认 | 说明 |
|---|---|---|
| `wenmai.prefixChars` | `1500` | 光标前上下文长度 |
| `wenmai.longPrefixChars` | `6000` | 长续写上下文长度 |
| `wenmai.useSuffix` | `false` | 是否在 Chat 兜底与长续写时把光标后的文字作为参考上下文。FIM 请求永远不带 suffix。只认你在设置里显式写的值，扩展清单的默认值不参与 |
| `wenmai.suffixChars` | `500` | 启用时取光标后多少字 |
| `wenmai.proseOnly` | `true` | 代码块/行内代码/frontmatter/URL/HTML 脚本/LaTeX·Typst 公式内不触发；设为 `false` 全部放开 |
| `wenmai.languages` | Markdown 等 10 种 | 启用自动续写的语言；留空表示全部 |

### 写作准则

| 配置 | 默认 | 说明 |
|---|---|---|
| `wenmai.genre` | `自动` | 自动/通用/公文/学术/小说/新媒体/商务 |
| `wenmai.writingRules` | 空 | 追加的自定义准则，最多 300 字 |
| `wenmai.useGuidelines` | `true` | 关闭后更接近原始 FIM，速度略快 |

---

## 延迟是怎么压下来的

写作补全和代码补全不同：你必须**在用户还没意识到等待时就给出结果**。文脉做了五层优化：

1. **防抖**：VS Code 每次按键都会调用 provider 并取消上一次。文脉等 220ms，只有最后一次真正发请求。连打十个字不会产生十次调用。
2. **keep-alive 连接池**：复用 TLS 连接，省掉每次请求几百毫秒的握手。
3. **流式 + 提前结束**：不等模型写完，凑够 1~2 个完整句就断开连接。等待时间从"整段生成"降到"首字 + 一句"。
4. **上下文预算**：默认只发光标前 1500 字 + 光标后 500 字，且尽量从行首截断；标题信息压缩成一行「文档位置」。
5. **结果缓存**：光标位置、上下文、配置完全相同（比如撤销后重写）时直接复用，0ms 返回。

日志里会记录每次的 `首字` 和 `总` 耗时，方便你按自己的网络与模型调整参数。

---

## 与原 `deepseek-fim-helper` 的关系

文脉是重写版，不是改名版。

| | deepseek-fim-helper | 文脉 Wenmai |
|---|---|---|
| 目标 | 任意位置触发 FIM | 中文写作自动续写 |
| 触发 | 必须按 `Ctrl+Alt+Space` | 停笔或移动光标后自动出现 |
| 写作准则 | 无 | 10 条通用 + 6 种文体 + 自定义 |
| 上下文 | 裸切片 | 标题路径 + 预算 + 行首对齐 |
| 延迟 | 每次新建连接、等完整响应 | keep-alive + 流式提前结束 + 缓存 |
| 结果清洗 | 仅前缀去重 | 前缀/准则/suffix/质量四道闸门 |
| 代码保护 | 无 | 代码块、URL、公式内不触发 |

- **API Key 自动迁移**：首次读取时会从旧扩展的加密存储复制到 `wenmai.apiKey`。
- **旧配置兼容**：`model`、`baseUrl`、`maxTokens`、`temperature`、`prefixChars`、`suffixChars`、`useSuffix` 会读取旧的 `deepseekFim.*` 值。
- **请卸载旧扩展**。两个扩展同时启用会各发一次请求，且旧扩展的 provider 可能先返回。

---

## 排错

**没有幽灵文本**

1. 确认 `editor.inlineSuggest.enabled` 为 `true`。
2. 确认当前文件语言在 `wenmai.languages` 里（Markdown / 纯文本默认支持）。
3. `文脉: 打开日志`，看是否有 `跳过：...` 或 `HTTP 401`。
4. 用状态栏菜单确认自动续写是开启状态。

**本地修正没有出现删除线 / 幽灵文本**

1. 确认 `wenmai.autoFix` 为 `true`。
2. 确认光标停在一行确实有格式问题的 Markdown / LaTeX 文本上，而不是代码块、frontmatter 或公式里。
3. 本地修正使用装饰器预览，不受 `editor.inlineSuggest.enabled` 影响；如果仍不显示，执行 `文脉: 打开日志`，把 `wenmai.logLevel` 设为 `debug`，看是否有“本地修正候选”。
4. 应用方式与 AI 续写一致：按 `Tab`。如果 `Tab` 被补全列表、代码片段或“Tab 移动焦点”占用，可用 `Ctrl+Alt+.` 或鼠标悬停点击。

**很慢**

1. 保持 `wenmai.stream` 开启。
2. 把 `wenmai.prefixChars` 降到 1200；`maxTokens` 不要低于 256（推理模型会先消耗隐藏 token，降得太低会直接没有正文）。
3. 换更快的 FIM 模型（修改 `wenmai.model`）。
4. 看日志里的"首字"耗时：首字慢通常是网络或模型排队，总耗时慢则多半是生成太长。

**续写跑题，或开始点评上文**

1. 多写一两句再停顿，6 个字的上下文很难判断意图。
2. 手动锁定 `wenmai.genre`，不要让「自动」猜。
3. 在自定义准则里加：`只承接内容往下写，不评论、不改写上文`。
4. 模型仍可能编造具体数字或案例，正式文稿请核对后再采用。

**出现重复**

- 保持 `wenmai.useSuffix` 关闭（默认就是关闭）。
- 缩短 `wenmai.maxSentences`。
- 在自定义准则里加一句：`不要重复上文出现的短语`。

**句子被截断**

`maxTokens` 太小。中文大约 1 字 ≈ 1~1.5 token，正文两句通常需要 80~120 token；但 `deepseek-flash` 等推理模型还会先消耗隐藏推理 token，所以默认留到 384。长续写会自动退回最后一个完整句，不会插入半句话；如果经常发生，可在日志里搜索「达到 token 上限」。

**幽灵文本时有时无，日志出现「流式响应为空」**

分三种情况处理，文脉会自动降级，不需要手动操作：

1. **预算被隐藏推理吃光**（`finish_reason=length`）：用放大后的预算（至少 400 token）做一次非流式重试。
2. **端点正常结束却没有正文**（`finish_reason=stop`、`completion_tokens=0`）：行内续写请求已经不带 suffix，这通常是模型判断“这句话已经写完了”。此时不再浪费一次预算重试。
3. **改用 `wenmai.chatUrl` 的 Chat 端点兜底**，生成 1~2 句后照常以幽灵文本显示。日志会写「FIM 连续返回空，改用 Chat 端点兜底」。

如果 Chat 兜底也失败，日志会写明原因。`wenmai.chatModel` 为空时沿用补全模型；如果 FIM 模型不支持 Chat，单独指定一个可用的 Chat 模型即可。`HTTP 429` 属于限流，调大 `wenmai.debounceMs` 或降低触发频率。

**日志出现「补全结果被去重逻辑过滤（原始 N 字）」**

模型确实返回了内容，但后处理把它整段判为复述。最常见的是模型把光标前的最后一句又抄了一遍——前缀去重会剥掉重叠部分，整段只有复述时直接丢弃；如果开启了 `wenmai.useSuffix` 且请求走了 Chat 兜底/长续写，模型也可能直接抄光标后的文字。另一种是返回内容只有“续写如下：”这类开场白或写作准则本身，被清理后不剩正文。可以多写几个字再试，或在自定义准则里强调“不要重复上文”。后文去重要求连续命中 6 个字，3 个字的巧合不会误伤。

**移动光标后不自动触发**

1. 确认 `wenmai.enabled` 和 `wenmai.triggerOnCursorMove` 都为 `true`。
2. 光标停稳后需要约 0.3 秒（停顿 80ms + 防抖 220ms）才开始请求，再等模型首字。
3. 如果文档刚被改动不到 200ms，文脉会让给 VS Code 原生触发；稍等或手动按 `Ctrl+Alt+Space`。
4. 选中的文字不为空、或当前语言不在 `wenmai.languages` 时不会触发。
5. 本地修正预览存在的行会抑制 AI 建议，按 `Esc` 或移开光标即可。

---

## 测试

离线测试不需要 API Key：

```powershell
cd WenMai
node test-core.js        # 243 项单元测试
node test-provider.js    # provider 全链路冒烟测试（本地 mock，不联网）
```

`test-core.js` 覆盖前缀去重、准则残留、断句、引号与空格、中文标点修正、质量闸门、suffix 去重、文体识别、Markdown 上下文识别、光标后 500 字预算、LRU 缓存、写作场景保护（LaTeX 行内/行间公式与 `cases`/`matrix` 等环境、HTML 标签/script/style/注释、双反引号行内代码、四反引号围栏）、本地修正（Markdown 标题/列表/任务列表/引用块/标点/中英文空格，LaTeX 环境名/漏写反斜杠/环境不匹配/公式标点/正文与正文命令参数，以及注释、`\verb`、`\lstinline`、标签/路径/URL 保护），以及本地模拟 SSE 的流式解析与提前结束。

`test-provider.js` 用最小 vscode mock + 本地 SSE 服务器跑通 `provider → 上下文 → 请求 → 流式解析 → 后处理 → InlineCompletionItem` 全链路，验证 FIM 请求无论光标后有没有文字都不带 `suffix` 且后文不混入 prompt、Chat 兜底按 `useSuffix` 决定是否参考后文、代码块内会跳过、本地修正命中后不返回原生行内建议且零 HTTP 请求，并验证最小差异删除线、就地幽灵文本装饰器、可点击悬停、Code Action 与应用命令；同时覆盖长续写命令的 Chat 请求与插入位置。当前全部通过。

真实 API 联调（会消耗额度，不计入默认测试）：

```powershell
$env:WENMAI_API_KEY = 'sk-...'
node test-live.js                    # 全量：模型列表、FIM、provider、取消、长续写
node test-live.js --provider-only    # 只跑 provider 全链路，约 2 次请求
```

`--provider-only` 会分别验证「光标在文末」和「光标在段中、后面已有完整句子」两种情况，后者正是 `suffix` 语义导致空结果的真实场景。

2026-10-31 实测 `deepseek-flash`：FIM 首字 500~830ms、总 650~1030ms；provider 全链路（含上下文与后处理）约 780ms；长续写 Chat 约 3.4s；请求取消可在 250ms 内真正中断连接。三种中文上文均生成了可用续写，质量闸门通过。

---

## 隐私

- 只在触发补全时，把光标附近的文本发送到你配置的端点。
- 不发送文件路径、文件名、工作区结构。
- 扩展没有遥测、没有统计上报。
- API Key 仅存于 VS Code `SecretStorage`。

---

## 文件结构

```
wenmai/
├── package.json          扩展清单：命令、快捷键、29 项配置
├── extension.js          激活、状态栏、命令、密钥管理
├── src/
│   ├── logger.js         输出面板日志
│   ├── config.js         配置读取、旧配置兼容、数值夹取
│   ├── guidelines.js     写作准则、文体画像、文体识别
│   ├── context.js        上下文预算、Markdown 标题、场景保护
│   ├── fix.js            本地修正：Markdown / LaTeX 规则与保护
│   ├── diff.js            行内最小差异（只保留真正变化的字符片段）
│   ├── localFixPreview.js 本地修正的差异删除线 + 就地幽灵文本预览与应用命令
│   ├── autoTrigger.js    光标移动停顿后主动触发行内建议
│   ├── postprocess.js    去重、断句、空格、质量闸门
│   ├── client.js         keep-alive + 流式 SSE + 提前结束
│   ├── cache.js          LRU + 哈希
│   └── provider.js       InlineCompletionItemProvider
├── test-core.js          离线单元测试（243 项）
├── test-provider.js      provider 全链路冒烟测试（mock vscode + 本地 SSE）
├── test-live.js          真实 API 联调（需 WENMAI_API_KEY）
├── install.ps1           复制安装到扩展目录
├── .gitignore
├── .vscodeignore
├── LICENSE
└── README.md
```

---

## License

MIT © 2026 QuniteZone

项目地址：[https://github.com/QuniteZone/WenMai](https://github.com/QuniteZone/WenMai)
