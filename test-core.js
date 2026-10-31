'use strict'

/*
 * 离线测试：不依赖 VS Code，也不需要 API Key。
 * 覆盖后处理、写作准则、上下文识别、缓存，以及流式 HTTP 解析。
 *
 *   node test-core.js
 */

const http = require('http')

const pp = require('./src/postprocess')
const guidelines = require('./src/guidelines')
const context = require('./src/context')
const fixes = require('./src/fix')
const { diffSegments } = require('./src/diff')
const { LruCache, hashKey } = require('./src/cache')
const {
  postJson,
  completionUrl,
  chatEndpoint,
  retryTokenBudget,
  describeEmptyResult
} = require('./src/client')

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    return
  }
  failed++
  console.log(`❌ ${name}`)
  console.log(`   actual:   ${a}`)
  console.log(`   expected: ${e}`)
}

function ok(name, condition) {
  if (condition) passed++
  else {
    failed++
    console.log(`❌ ${name}`)
  }
}

function group(title) {
  console.log(`\n===== ${title} =====`)
}

function applyHunks(text, hunks) {
  let out = ''
  let cursor = 0
  for (const hunk of hunks) {
    out += text.slice(cursor, hunk.start) + hunk.replacement
    cursor = hunk.end
  }
  return out + text.slice(cursor)
}

/* ------------------------------------------------------------------ */
/*  前缀去重                                                          */
/* ------------------------------------------------------------------ */

group('前缀去重')
check(
  '复述诗句片段',
  pp.stripEchoedPrefix('些小吾曹州县吏，一枝一叶总关情。', '些小吾'),
  '曹州县吏，一枝一叶总关情。'
)
check(
  '正常续写不去重',
  pp.stripEchoedPrefix('，只看你干什么。', '群众不看你说什么'),
  '，只看你干什么。'
)
check(
  '复述整行',
  pp.stripEchoedPrefix('第二行内容补充的后续。', '第一行\n第二行内容'),
  '补充的后续。'
)
check(
  '单字重叠应保留',
  pp.stripEchoedPrefix('好的准备，才能应对。', '我们要做好'),
  '好的准备，才能应对。'
)
check(
  '两字重叠应去重',
  pp.stripEchoedPrefix('一叶总关情', '一枝一叶'),
  '总关情'
)
check(
  'prompt 末尾空白',
  pp.stripEchoedPrefix('补全的内容', '这是一段话   '),
  '补全的内容'
)
check('整段只复述前缀则丢弃', pp.stripEchoedPrefix('我认为', '我认为'), '')
check('整段复述末行则丢弃', pp.stripEchoedPrefix('第二行内容', '第一行\n第二行内容'), '')
check('复述后仍有正文则保留正文', pp.stripEchoedPrefix('我认为，事情还没结束。', '我认为'), '，事情还没结束。')

/* ------------------------------------------------------------------ */
/*  准则残留清理                                                      */
/* ------------------------------------------------------------------ */

group('准则残留清理')
check(
  '去掉写作设定',
  pp.stripInstructionEcho('（写作设定：通用。紧接上文续写；只输出正文。）他走了。'),
  '他走了。'
)
check(
  '去掉文档位置',
  pp.stripInstructionEcho('（文档位置：标题 > 第一节）他走了。'),
  '他走了。'
)
check('去掉续写标签', pp.stripInstructionEcho('续写：他走了。'), '他走了。')
check(
  '去掉 Chat 开场白',
  pp.stripInstructionEcho('好的，以下是续写内容：\n他走了。'),
  '他走了。'
)
check(
  '去掉简短开场白',
  pp.stripInstructionEcho('以下是续写：\n他走了。'),
  '他走了。'
)
check(
  '去掉代码围栏',
  pp.stripInstructionEcho('```markdown\n他走了。\n```'),
  '他走了。'
)

/* ------------------------------------------------------------------ */
/*  句数 / 长度控制                                                   */
/* ------------------------------------------------------------------ */

group('句数 / 长度控制')
check('截到一句', pp.limitSentences('他走了。天亮了。', 1, 220), '他走了。')
check('保留两句', pp.limitSentences('他走了。天亮了。', 2, 220), '他走了。天亮了。')
check('英文句号', pp.limitSentences('Hello world. Another sentence.', 1, 220), 'Hello world.')
check(
  '小数点不截断',
  pp.limitSentences('Version 1.2 is out. Next.', 1, 220),
  'Version 1.2 is out.'
)
check('超长按句截断', pp.limitSentences('第一句。第二句。第三句。', 2, 5), '第一句。')
check('空行算结束', pp.limitSentences('第一段\n\n第二段', 1, 220), '第一段\n\n')
check('提前结束-完整句', pp.shouldStop('他走了。', 1, 220), true)
check('提前结束-未完整', pp.shouldStop('他走', 1, 220), false)
check('长续写截断回退', pp.ensureCompleteEnding('他走了。天亮了。接着'), '他走了。天亮了。')
check('长续写完整句保留', pp.ensureCompleteEnding('他走了。'), '他走了。')
check('长续写引号结尾', pp.ensureCompleteEnding('他说：“走吧。”'), '他说：“走吧。”')
check('长续写省略号结尾', pp.ensureCompleteEnding('他愣在原地……'), '他愣在原地……')
check('长续写无句末可退', pp.ensureCompleteEnding('一个没有句号的句子'), '一个没有句号的句子')

/* ------------------------------------------------------------------ */
/*  引号 / 空格 / 质量                                                */
/* ------------------------------------------------------------------ */

group('引号 / 空格 / 质量')
check('中文引号剥离', pp.unwrapQuotes('“他走了。”'), '他走了。')
check('英文引号剥离', pp.unwrapQuotes('"Hello there"'), 'Hello there')
check('中文之间不加空格', pp.ensureSpacing('继续走', '他'), '继续走')
check('中文后接英文加空格', pp.ensureSpacing('API 很好用', '用'), ' API 很好用')
check('英文之间加空格', pp.ensureSpacing('world', 'hello'), ' world')
check('中文标点后不加空格', pp.ensureSpacing('，继续', '，'), '，继续')
check('中文标点后接英文不加空格', pp.ensureSpacing('Apple 很好用', '，'), 'Apple 很好用')
check('中文句号后接英文不加空格', pp.ensureSpacing('Apple很好', '。'), 'Apple很好')
check('中文半角标点修正', pp.normalizePunctuation('他说,你好.'), '他说，你好。')
check('英文标点不动', pp.normalizePunctuation('Hello, world.'), 'Hello, world.')
check('省略号修正', pp.normalizePunctuation('这是一个测试...'), '这是一个测试……')
check('小数点保护', pp.normalizePunctuation('这是1.5倍,对吧?'), '这是1.5倍，对吧？')

ok('纯标点判为低质量', pp.isLowQuality('。。。', { pre: '', suffix: '' }))
ok('准则残留判为低质量', pp.isLowQuality('（写作设定：通用）', { pre: '', suffix: '' }))
ok('代码块判为低质量', pp.isLowQuality('```js\nx\n```', { pre: '', suffix: '' }))
ok('正常句子可用', !pp.isLowQuality('他走了。', { pre: '天亮了，', suffix: '' }))

check(
  '完整后处理',
  pp.finalize(
    '些小吾曹州县吏，一枝一叶总关情。',
    { pre: '些小吾', suffix: '', prevChar: '吾' },
    { maxSentences: 2, maxChars: 220 }
  ),
  '曹州县吏，一枝一叶总关情。'
)

/* ------------------------------------------------------------------ */
/*  suffix 去重                                                       */
/* ------------------------------------------------------------------ */

group('suffix 去重')
check('复述后文则丢弃', pp.reconcileSuffix('看你干什么。后面', '看你干什么。'), '')
check('结尾重叠则裁剪', pp.reconcileSuffix('他转身离开', '离开了。'), '他转身')
check('无重叠保持原样', pp.reconcileSuffix('他转身', '离开了。'), '他转身')
check(
  '仅前 3 字巧合不算复述',
  pp.reconcileSuffix('，而系统需要重新设计', '，而最后的正确约束校验'),
  '，而系统需要重新设计'
)
check(
  '连续 6 字复述才丢弃',
  pp.reconcileSuffix('，而最后的正确约束校验则像一道安全阀', '，而最后的正确约束校验'),
  ''
)

/* ------------------------------------------------------------------ */
/*  写作准则                                                          */
/* ------------------------------------------------------------------ */

group('写作准则')
check(
  '识别公文',
  guidelines.detectGenre('根据上级通知要求，各乡镇、各部门要抓紧落实相关工作。'),
  '公文'
)
check(
  '识别学术',
  guidelines.detectGenre('本文通过实验与数据分析，检验了研究假设。'),
  '学术'
)
check('普通文本回退通用', guidelines.detectGenre('今天天气不错。'), '通用')
check('手动指定优先', guidelines.resolveGenre('小说', '根据通知要求'), '小说')
ok(
  '准则包含文体与句数',
  guidelines
    .buildGuidelineLine({ genre: '公文', maxSentences: 2, maxChars: 200, custom: '不要用第一人称' })
    .includes('公文') &&
    guidelines
      .buildGuidelineLine({ genre: '公文', maxSentences: 2, maxChars: 200, custom: '不要用第一人称' })
      .includes('2 句') &&
    guidelines
      .buildGuidelineLine({ genre: '公文', maxSentences: 2, maxChars: 200, custom: '不要用第一人称' })
      .includes('不要用第一人称')
)
const longRule = guidelines.buildGuidelineLine({
  genre: '学术',
  maxSentences: 3,
  maxChars: 300,
  custom: '甲'.repeat(120)
})
ok('超长自定义准则不挤掉句数规则', longRule.includes('3 句') && longRule.length <= 340)
const punctuated = guidelines.buildGuidelineLine({
  genre: '通用',
  maxSentences: 2,
  maxChars: 220,
  custom: '不要使用第一人称；避免感叹号。'
})
ok('自定义准则结尾标点不重复', !punctuated.includes('。。') && punctuated.includes('避免感叹号。）'))
ok('准则包含不编造约束', guidelines.COMMON.includes('不编造事实、数据与引文'))

/* ------------------------------------------------------------------ */
/*  上下文识别                                                        */
/* ------------------------------------------------------------------ */

group('上下文识别')

const baseCfg = {
  minPromptChars: 6,
  prefixChars: 2400,
  longPrefixChars: 6000,
  suffixChars: 200,
  proseOnly: true
}

ok('代码围栏内', context.fenceState('文字\n```js\nconst a = 1\n', 20))
ok('代码围栏外', !context.fenceState('```js\ncode\n```\n文字', 22))
ok('frontmatter 内', context.inFrontmatter('---\ntitle: x\n---\n正文', 5))
ok('frontmatter 外', !context.inFrontmatter('---\ntitle: x\n---\n正文', 20))
ok(
  '更长的横线不是 frontmatter',
  !context.inFrontmatter('---\ntitle: x\n----\n正文', 20)
)
ok('CRLF frontmatter 内', context.inFrontmatter('---\r\ntitle: x\r\n---\r\n正文', 7))
check('suffix 不切断代理对', context.takeSuffix('前😀', 1, 1), '')
check('suffix 保留完整 emoji', context.takeSuffix('前😀后', 1, 2), '😀')

const insideFence = context.buildContext({
  text: '前面的一些文字\n```js\nconst a = 1\n',
  offset: '前面的一些文字\n```js\nconst a = 1\n'.length,
  languageId: 'markdown',
  cfg: baseCfg
})
check('代码块应跳过', insideFence.skip, '光标在代码块中')

const plain = context.buildContext({
  text: '群众不看你说什么，只看',
  offset: '群众不看你说什么，只看'.length,
  languageId: 'plaintext',
  cfg: baseCfg
})
check('普通文本可用', plain.skip, null)
check('普通文本上下文', plain.pre, '群众不看你说什么，只看')
check('前一个字符', plain.prevChar, '看')

const afterCursor = context.buildContext({
  text: '前文内容。光标\n\n' + '后文'.repeat(300),
  offset: '前文内容。光标'.length,
  languageId: 'plaintext',
  cfg: Object.assign({}, baseCfg, { suffixChars: 500 })
})
check('光标后取 500 字', afterCursor.suffix.length, 500)
ok('光标后不按空行截断', afterCursor.suffix.startsWith('\n\n后文'))

const md = context.buildContext({
  text: '# 标题\n\n## 第一节\n\n正文内容还在继续',
  offset: '# 标题\n\n## 第一节\n\n正文内容还在继续'.length,
  languageId: 'markdown',
  cfg: baseCfg
})
check('Markdown 标题路径', md.metaLine, '（文档位置：标题 > 第一节）')

const url = context.buildContext({
  text: '请访问 https://example.com/path',
  offset: '请访问 https://example.com/path'.length,
  languageId: 'markdown',
  cfg: baseCfg
})
ok('URL 中跳过', Boolean(url.skip))

/* 场景保护的边界：这些位置必须静默，正文必须照常触发。 */
const guardCfg = Object.assign({}, baseCfg, { minPromptChars: 1 })

function guardSkip(text, languageId, marker, cfg) {
  const index = marker ? text.indexOf(marker) + marker.length : text.length
  return context.buildContext({
    text,
    offset: index,
    languageId,
    cfg: cfg || guardCfg
  }).skip
}

check(
  'LaTeX 行间公式（多行）',
  guardSkip('设总量为\n$$\nE = mc^2\n$$\n继续写', 'latex', 'E = mc^2'),
  '光标在公式中'
)
check(
  'LaTeX 行间公式（单行）',
  guardSkip('设总量为 $$ E = mc^2 $$ 继续', 'latex', 'E = mc^2'),
  '光标在公式中'
)
check(
  'LaTeX \\[ \\] 公式',
  guardSkip('设总量为 \\[ E = mc^2 \\] 继续', 'latex', 'E = mc^2'),
  '光标在公式中'
)
check(
  'LaTeX \\( \\) 公式',
  guardSkip('设总量为 \\( E = mc^2 \\) 继续', 'latex', 'E = mc^2'),
  '光标在公式中'
)
check(
  'LaTeX 跨行 \\( 公式',
  guardSkip('\\( E = mc^2\n继续写', 'latex', 'E = mc^2'),
  '光标在公式中'
)
check(
  'LaTeX equation 环境',
  guardSkip('\\begin{equation}\nE = mc^2\n\\end{equation}\n继续', 'latex', 'E = mc^2'),
  '光标在公式环境中'
)
check(
  'LaTeX cases 环境',
  guardSkip('\\begin{cases}\nx，y\n\\end{cases}', 'latex', 'x，y'),
  '光标在公式环境中'
)
check(
  'tex 语言 ID 的注释不开启公式',
  guardSkip('% $x\n中文,测试', 'tex', '中文'),
  null
)
check(
  'LaTeX verbatim 环境',
  guardSkip('\\begin{verbatim}\nprint(1)\n\\end{verbatim}', 'latex', 'print(1)'),
  '光标在代码环境中'
)
check('LaTeX 公式之后的正文', guardSkip('设 $x$ 为总量，继续写正文', 'latex'), null)
check(
  'LaTeX 环境之后的正文',
  guardSkip('\\begin{equation}\nE = mc^2\n\\end{equation}\n继续写正文', 'latex'),
  null
)
check(
  'Typst 跨行公式',
  guardSkip('设总量为\n$ E = mc^2\n继续写', 'typst', 'E = mc^2'),
  '光标在公式中'
)

check(
  'HTML script 内部',
  guardSkip('<script>\nconst a = 1\n</script>\n<p>正文</p>', 'html', 'const a = 1'),
  '光标在 HTML 脚本/样式/注释中'
)
check(
  'HTML style 内部',
  guardSkip('<style>\np { color: red }\n</style>', 'html', 'p { color'),
  '光标在 HTML 脚本/样式/注释中'
)
check(
  'HTML 注释内部',
  guardSkip('<!-- 这是一段注释\n继续注释 -->\n<p>正文</p>', 'html', '继续注释'),
  '光标在 HTML 脚本/样式/注释中'
)
check('HTML 标签内部', guardSkip('<div class="box', 'html'), '光标在 HTML 标签中')
check(
  'HTML 正文照常触发',
  guardSkip('<script>\nconst a = 1\n</script>\n<p>正文继续</p>', 'html'),
  null
)
check(
  'Markdown 内嵌 HTML 标签',
  guardSkip('<div class="box', 'markdown'),
  '光标在 HTML 标签中'
)

check(
  '双反引号行内代码',
  guardSkip('他说 ``map`` 就是映射', 'markdown', '``map'),
  '光标在行内代码中'
)
check('双反引号闭合后恢复', guardSkip('他说 ``map`` 就是映射', 'markdown'), null)
check(
  '四反引号围栏包住三反引号',
  guardSkip('````md\n```js\ncode\n```\n````\n正文', 'markdown', 'code'),
  '光标在代码块中'
)
check(
  '四反引号围栏之后恢复',
  guardSkip('````md\n```js\ncode\n```\n````\n正文继续', 'markdown'),
  null
)

const noGuardCfg = Object.assign({}, guardCfg, { proseOnly: false })
check(
  '关闭 proseOnly 后公式也触发',
  guardSkip('设总量为\n$$\nE = mc^2\n$$\n继续写', 'latex', 'E = mc^2', noGuardCfg),
  null
)

/* ------------------------------------------------------------------ */
/*  本地修正（L1）                                                    */
/* ------------------------------------------------------------------ */

group('本地修正 · Markdown')

function fixedMd(line, options) {
  const result = fixes.fixMarkdownLine(line, options)
  return result ? result.newText : null
}

function fixedTex(line, options) {
  const result = fixes.fixLatexLine(line, options)
  return result ? result.newText : null
}

function detectFix(text, marker, languageId, cfg) {
  const index = marker ? text.indexOf(marker) + marker.length : text.length
  const result = fixes.detectLocalFix({
    text,
    offset: index,
    languageId,
    cfg: Object.assign(
      { autoFix: true, fixCjkLatinSpacing: true },
      cfg || {}
    )
  })
  return result ? result.newText : null
}

check('标题缺空格', fixedMd('##3.内容'), '## 3.内容')
check('三级标题缺空格', fixedMd('###1.1 背景'), '### 1.1 背景')
check('标题前缩进保留', fixedMd('  ##3.内容'), '  ## 3.内容')
check('标题已有空格', fixedMd('## 3.内容'), null)
check('Obsidian 标签不误改', fixedMd('#tag'), null)
check('单井号数字标题', fixedMd('#1.标题'), '# 1.标题')
check('单井号中文数字标题', fixedMd('#一、总则'), '# 一、总则')
check('七个井号不是标题', fixedMd('#######内容'), null)
check('四空格缩进不是标题', fixedMd('    ##3.内容'), null)
check('标题后是制表符', fixedMd('##\t3.内容'), null)

check('无序列表缺空格', fixedMd('-内容'), '- 内容')
check('加号列表缺空格', fixedMd('+内容'), '+ 内容')
check('负数开头的句子不是列表', fixedMd('-1.5倍增长'), null)
check('正数开头的句子不是列表', fixedMd('+3%增长'), null)
check('星号列表不冒险修改', fixedMd('*内容*'), null)
check('分隔线不修改', fixedMd('---'), null)
check('有序列表缺空格', fixedMd('1.内容'), '1. 内容')
check('括号有序列表缺空格', fixedMd('1)内容'), '1) 内容')
check('小数不是列表', fixedMd('1.5倍增长'), null)
check('十位数字不是列表', fixedMd('1234567890.内容'), null)
check('缩进列表缺空格', fixedMd('  -内容'), '  - 内容')

check('引用块标题缺空格', fixedMd('> ##3.内容'), '> ## 3.内容')
check('嵌套引用块标题', fixedMd('>> ##3.内容'), '>> ## 3.内容')
check('引用块列表缺空格', fixedMd('> -内容'), '> - 内容')
check('引用块正文标点', fixedMd('> 我们认为,这个问题很重要'), '> 我们认为，这个问题很重要')
check('任务列表缺空格', fixedMd('- [ ]任务'), '- [ ] 任务')
check('已完成任务列表缺空格', fixedMd('- [x]完成'), '- [x] 完成')
check('星号任务列表缺空格', fixedMd('* [ ]任务'), '* [ ] 任务')
check('任务列表已有空格', fixedMd('- [ ] 任务'), null)

check(
  '中文半角标点与重复标点',
  fixedMd('我们认为,这个问题非常重要。。'),
  '我们认为，这个问题非常重要。'
)
check('中文冒号与感叹号', fixedMd('注意:这里有问题!'), '注意：这里有问题！')
check('小数逗号保留', fixedMd('版本1.5,增长'), '版本1.5，增长')
check(
  '中英文之间补空格',
  fixedMd('使用VS Code写作,真的'),
  '使用 VS Code 写作，真的'
)
check('英文标点不动', fixedMd('Hello, world'), null)
check('英文为主时不改中文标点', fixedMd('The word 中文, means'), null)
check('行内代码保护', fixedMd('`代码,不要改`'), null)
check(
  'URL 后的中文逗号',
  fixedMd('请访问 https://example.com/a,b,然后继续'),
  '请访问 https://example.com/a,b，然后继续'
)
check('金额里的逗号不动', fixedMd('价格$5,000'), null)
check('行内公式保护', fixedMd('中文$math,内容$中文'), null)
check('引号后的逗号', fixedMd('他说：“你好”,然后走了。'), '他说：“你好”，然后走了。')
check('混合重复标点', fixedMd('好的,,继续'), '好的，继续')
check('不同标点不合并', fixedMd('真的！？'), null)
check('中文省略号', fixedMd('中文...'), '中文……')
check('英文省略号不动', fixedMd('English...'), null)
check('行内代码后的正文', fixedMd('`code`中文,测试'), '`code`中文，测试')
check(
  'HTML 标签保护的正文',
  fixedMd('<span>中文,测试</span>'),
  '<span>中文，测试</span>'
)
check(
  '关闭中英文空格',
  fixedMd('使用VS Code写作', { fixCjkLatinSpacing: false }),
  null
)

function detectFixAt(text, index, languageId, extra) {
  return fixes.detectLocalFix(
    Object.assign(
      {
        text,
        offset: index,
        languageId,
        cfg: { autoFix: true, fixCjkLatinSpacing: true }
      },
      extra || {}
    )
  )
}

// 输入法拼音 / 正在敲的英文单词：光标贴着字母时不能触发中英文空格修正，
// 否则预览会打断 AI 续写，还会把未输完的拼音当成正文。
check(
  '拼音输入中不触发空格修正',
  detectFix('我们yinci讨论', 'yinci', 'markdown'),
  null
)
check(
  '拼音输入中 LaTeX 也不触发',
  detectFix('中文yinci内容', 'yinci', 'latex'),
  null
)
check(
  '光标停在拼音中间不触发',
  (() => {
    const text = '我们yinci讨论'
    const result = detectFixAt(text, text.indexOf('yinci') + 2, 'markdown')
    return result ? result.newText : null
  })(),
  null
)
check(
  '光标离开字母后正常补空格',
  detectFix('我们yinci讨论', null, 'markdown'),
  '我们 yinci 讨论'
)
check(
  '手动快速修复不受输入保护影响',
  (() => {
    const text = '我们yinci讨论'
    const result = detectFixAt(text, text.indexOf('yinci') + 'yinci'.length, 'markdown', {
      manual: true
    })
    return result ? result.newText : null
  })(),
  '我们 yinci 讨论'
)
check(
  '拼音旁同时有标点错误时仍然修正',
  detectFix('我们yinci讨论,,继续', 'yinci', 'markdown'),
  '我们 yinci 讨论，继续'
)

check(
  'Markdown 围栏内不修正',
  detectFix('```js\n##3.内容\n```', '##3', 'markdown'),
  null
)
check(
  'frontmatter 内不修正',
  detectFix('---\ntitle: ##3.内容\n---\n正文', '##3', 'markdown'),
  null
)
check(
  '行内代码内不修正',
  detectFix('他说 `##3.内容` 结束', '##3', 'markdown'),
  null
)
check(
  '公式内不修正',
  detectFix('公式 $##3.内容$ 结束', '##3', 'markdown'),
  null
)
check(
  'HTML 属性内不修正',
  detectFix('<div title="##3.内容">正文</div>', '##3', 'markdown'),
  null
)
check(
  'script 内不修正',
  detectFix('<script>\n##3.内容\n</script>', '##3', 'markdown'),
  null
)
check('关闭 autoFix 不修正', detectFix('##3.内容', '##3', 'markdown', { autoFix: false }), null)

group('本地修正 · LaTeX')

check('环境名去空格', fixedTex('\\begin{ equation }'), '\\begin{equation}')
check('带星号环境名去空格', fixedTex('\\end{ align* }'), '\\end{align*}')
check('行首漏写反斜杠', fixedTex('  begin{equation}'), '  \\begin{equation}')
check('行尾漏写反斜杠', fixedTex('end{equation}'), '\\end{equation}')
check('环境名与花括号之间有空格', fixedTex('\\begin {equation}'), null)
check(
  '同一行起止环境不匹配',
  fixedTex('\\begin{equation} E=mc^2 \\end{align}'),
  '\\begin{equation} E=mc^2 \\end{equation}'
)
check(
  '嵌套环境不冒险修改',
  fixedTex('\\begin{itemize} \\item 内容 \\end{itemize}'),
  null
)
check('注释内不修改', fixedTex('% \\begin{ equation }'), null)
check('verb 内不修改', fixedTex('\\verb|\\begin{ equation }|'), null)
check('lstinline 内不修改', fixedTex('\\lstinline[language=TeX]|\\begin{ equation }|'), null)
check('intertext 内不修改', fixedTex('\\intertext{中文，保留}'), null)
check('LaTeX 正文半角标点', fixedTex('中文,测试'), '中文，测试')
check(
  'LaTeX 正文中英文空格',
  fixedTex('使用VS Code写作,真的'),
  '使用 VS Code 写作，真的'
)
check(
  'section 参数标点',
  fixedTex('\\section{标题,副标题}'),
  '\\section{标题，副标题}'
)
check(
  'section 参数中英文空格',
  fixedTex('\\section{使用VS Code写作}'),
  '\\section{使用 VS Code 写作}'
)
check('label 参数不修改', fixedTex('\\label{sec:intro}'), null)
check('cite 参数不修改', fixedTex('\\cite{张三,2020}'), null)
check('frac 参数不修改', fixedTex('\\frac{a,b}{c}'), null)
check(
  'newcommand 定义不修改',
  fixedTex('\\newcommand{\\foo}{中文,测试}'),
  null
)
check('def 定义不修改', fixedTex('\\def\\foo{中文,测试}'), null)
check('text 参数按正文修改', fixedTex('\\text{中文,测试}'), '\\text{中文，测试}')
check(
  'itemize 正文修改',
  fixedTex('\\begin{itemize} \\item 中文,测试 \\end{itemize}'),
  '\\begin{itemize} \\item 中文，测试 \\end{itemize}'
)
check(
  '公式与正文同时修改',
  fixedTex('$a，b$ 正文,测试'),
  '$a,b$ 正文，测试'
)
check(
  'href 参数不修改',
  fixedTex('\\href{https://example.com/a,b}{链接,文字}'),
  null
)
check(
  '未闭合公式环境也修正',
  fixedTex('\\begin{equation} E=mc^2，'),
  '\\begin{equation} E=mc^2,'
)
check('未闭合行间公式也修正', fixedTex('\\[ a，b'), '\\[ a,b')
check(
  '关闭公式环境后的正文',
  fixedTex('\\end{equation} 正文,测试', {
    inMath: true,
    mathKind: '光标在公式环境中'
  }),
  '\\end{equation} 正文，测试'
)
check('LaTeX 正文检测', detectFix('中文,测试', '中文', 'latex'), '中文，测试')
check('R Markdown 标题检测', detectFix('##3.内容', '##3', 'rmd'), '## 3.内容')
check('行内公式全角逗号', fixedTex('$a，b$'), '$a,b$')
check('行内公式全角括号', fixedTex('$a（b）$'), '$a(b)$')
check('text 内不修改', fixedTex('$x\\text{中文，保留}$'), null)
check('行间公式全角逗号', fixedTex('\\[ a，b \\]'), '\\[ a,b \\]')
check('圆括号公式全角分号', fixedTex('\\(a；b\\)'), '\\(a;b\\)')
check('注释内标点不动', fixedTex('$a，b$ % 注释，不动'), '$a,b$ % 注释，不动')
check(
  '同一行公式环境标点',
  fixedTex('\\begin{equation} E=mc^2，\\end{equation}'),
  '\\begin{equation} E=mc^2,\\end{equation}'
)
check(
  'cases 环境公式标点',
  fixedTex('\\begin{cases} x， & y \\end{cases}'),
  '\\begin{cases} x, & y \\end{cases}'
)
check(
  '未闭合 cases 环境也修正',
  fixedTex('\\begin{cases} x，'),
  '\\begin{cases} x,'
)
check('光标在公式中', fixedTex('E = mc^2，', { inMath: true }), 'E = mc^2,')
check(
  '关闭环境后的正文不按公式改',
  fixedTex('E=mc^2， \\end{equation} 正文，', { inMath: true }),
  'E=mc^2, \\end{equation} 正文，'
)
check(
  '跨行行内公式的收尾',
  fixedTex('b，c$ 正文，', {
    inMath: true,
    mathKind: '光标在公式中'
  }),
  'b,c$ 正文，'
)
check(
  '跨行行间公式的收尾',
  fixedTex('a，b \\] 正文，', {
    inMath: true,
    mathKind: '光标在公式中'
  }),
  'a,b \\] 正文，'
)
check(
  '跨行公式收尾后的正文',
  detectFix('前文 $a\nb，c$ 正文，', 'b，c', 'latex'),
  'b,c$ 正文，'
)
check(
  'LaTeX 代码环境内不修正',
  detectFix(
    '\\begin{verbatim}\n$a，b$\n\\end{verbatim}',
    'a，b',
    'latex'
  ),
  null
)
check(
  'LaTeX 注释内不修正',
  detectFix('% \\begin{ equation }', 'equation', 'latex'),
  null
)
check(
  'LaTeX 公式内可修正',
  detectFix('$a，b$', 'a，b', 'latex'),
  '$a,b$'
)

check('中文标点直接调用', fixes.fixPunctuation('他说,你好.'), '他说，你好。')
check('英文标点直接调用', fixes.fixPunctuation('Hello, world.'), 'Hello, world.')
check('中英文空格直接调用', fixes.fixCjkLatinSpacing('用VS Code写作'), '用 VS Code 写作')

/* ------------------------------------------------------------------ */
/*  最小差异                                                          */
/* ------------------------------------------------------------------ */

group('最小差异')

check('无变化不产生片段', diffSegments('正文', '正文'), [])
check(
  '标题空格只插入一个位置',
  diffSegments('##3.内容', '## 3.内容'),
  [{ start: 2, end: 2, replacement: ' ' }]
)
check(
  '单个标点只替换该标点',
  diffSegments('中文,测试', '中文，测试'),
  [{ start: 2, end: 3, replacement: '，' }]
)
check(
  '相邻重复标点合并为一段',
  diffSegments('好的,,继续', '好的，继续'),
  [{ start: 2, end: 4, replacement: '，' }]
)
check(
  '两个空格插入分别定位',
  diffSegments('使用VS Code写作', '使用 VS Code 写作'),
  [
    { start: 2, end: 2, replacement: ' ' },
    { start: 9, end: 9, replacement: ' ' }
  ]
)
check(
  '省略号三换二',
  diffSegments('中文...测试', '中文……测试'),
  [{ start: 2, end: 5, replacement: '……' }]
)
check(
  '删除重复句号只删多余字符',
  diffSegments('好的。。继续', '好的。继续'),
  [{ start: 3, end: 4, replacement: '' }]
)
check(
  'emoji 后的标点位置不拆分代理对',
  diffSegments('😀,测试', '😀，测试'),
  [{ start: 2, end: 3, replacement: '，' }]
)
check(
  '跨过一个相同字符的删除',
  diffSegments('aXbXc', 'aXc'),
  [{ start: 2, end: 4, replacement: '' }]
)
check(
  '环境名替换可重建且不吞掉后文',
  applyHunks(
    '\\begin{align}x\\end{align}',
    diffSegments('\\begin{align}x\\end{align}', '\\begin{equation}x\\end{equation}')
  ),
  '\\begin{equation}x\\end{equation}'
)

/* ------------------------------------------------------------------ */
/*  缓存                                                              */
/* ------------------------------------------------------------------ */

group('缓存')
const cache = new LruCache(2)
cache.set('a', 1)
cache.set('b', 2)
check('命中 a', cache.get('a'), 1)
cache.set('c', 3)
check('LRU 淘汰 b', cache.get('b'), undefined)
check('保留 c', cache.get('c'), 3)
check('哈希稳定', hashKey(['x', 'y']), hashKey(['x', 'y']))
ok('哈希区分', hashKey(['x', 'y']) !== hashKey(['x', 'z']))

/* ------------------------------------------------------------------ */
/*  流式 HTTP                                                         */
/* ------------------------------------------------------------------ */

group('流式 HTTP')

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        if (req.url === '/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: '你好，世界。' } }] }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const deltas = ['他走', '了。', '天亮了。', '第三句。']
        let index = 0
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer)
            return
          }
          if (index < deltas.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ text: deltas[index] }] })}\n\n`)
            index++
          } else {
            res.write('data: [DONE]\n\n')
            res.end()
            clearInterval(timer)
          }
        }, 10)
        res.on('error', () => clearInterval(timer))
      })
    })
    server.on('clientError', (error, socket) => {
      try {
        socket.destroy()
      } catch (_) {}
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

async function runStreamingTests() {
  const { server, base } = await startServer()

  try {
    const streamed = await postJson(
      `${base}/completions`,
      { model: 'test', prompt: 'x', stream: true },
      {
        stream: true,
        timeoutMs: 5000,
        shouldStop: (text) => pp.shouldStop(text, 1, 220)
      }
    )
    check('流式提前结束内容', streamed.text, '他走了。')
    check('流式提前结束标记', streamed.earlyStop, true)

    const full = await postJson(
      `${base}/completions`,
      { model: 'test', prompt: 'x', stream: true },
      { stream: true, timeoutMs: 5000 }
    )
    check('流式完整内容', full.text, '他走了。天亮了。第三句。')

    const chat = await postJson(
      `${base}/chat`,
      { model: 'test', messages: [], stream: false },
      { stream: false, timeoutMs: 5000 }
    )
    check('非流式解析', chat.text, '你好，世界。')
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

/* ------------------------------------------------------------------ */
/*  端点拼接                                                          */
/* ------------------------------------------------------------------ */

group('端点拼接')

check(
  'baseUrl 补 /completions',
  completionUrl('https://api.deepseek.com/beta'),
  'https://api.deepseek.com/beta/completions'
)
check(
  'baseUrl 末尾斜杠',
  completionUrl('https://api.deepseek.com/beta///'),
  'https://api.deepseek.com/beta/completions'
)
check(
  'baseUrl 已是完整地址',
  completionUrl('https://api.deepseek.com/beta/completions'),
  'https://api.deepseek.com/beta/completions'
)
check(
  'chatUrl 只填域名时补路径',
  chatEndpoint('https://api.deepseek.com'),
  'https://api.deepseek.com/chat/completions'
)
check(
  'chatUrl 已有路径保持原样',
  chatEndpoint('https://proxy.example.com/v1/chat/completions'),
  'https://proxy.example.com/v1/chat/completions'
)

/* ------------------------------------------------------------------ */
/*  空响应重试                                                        */
/* ------------------------------------------------------------------ */

group('空响应重试')

check('96 token 重试预算', retryTokenBudget(96), 400)
check('64 token 重试预算', retryTokenBudget(64), 400)
check('384 token 重试预算', retryTokenBudget(384), 1024)
check('超大预算不越界', retryTokenBudget(1024), 1024)
ok(
  '空响应日志包含推理 token',
  describeEmptyResult({
    text: '',
    finishReason: 'length',
    usage: {
      completion_tokens: 96,
      completion_tokens_details: { reasoning_tokens: 96 }
    }
  }).includes('reasoning_tokens=96')
)
ok(
  '空响应日志包含字数',
  describeEmptyResult({ text: '' }).includes('收到 0 字')
)

/* ------------------------------------------------------------------ */
/*  配置读取：useSuffix 只认用户显式设置                              */
/* ------------------------------------------------------------------ */

const Module = require('module')
const originalModuleLoad = Module._load

function configModuleStub(values) {
  const conf = {
    get: (key, fallback) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
    inspect: (key) => ({
      key,
      // 故意把清单默认值设为 true：模拟 VS Code 缓存了旧的 package.json。
      defaultValue: true,
      globalValue: Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : undefined,
      workspaceValue: undefined,
      workspaceFolderValue: undefined
    })
  }
  return { workspace: { getConfiguration: () => conf } }
}

function loadConfigWith(values) {
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return configModuleStub(values)
    return originalModuleLoad.call(this, request, parent, isMain)
  }
  try {
    const path = require.resolve('./src/config')
    delete require.cache[path]
    return require('./src/config')
  } finally {
    Module._load = originalModuleLoad
    delete require.cache[require.resolve('./src/config')]
  }
}

group('配置读取')
check('清单默认 true 也不生效', loadConfigWith({}).readConfig().useSuffix, false)
check('用户显式开启才生效', loadConfigWith({ useSuffix: true }).readConfig().useSuffix, true)
check(
  '空 baseUrl 回退官方地址',
  loadConfigWith({ baseUrl: '' }).readConfig().baseUrl,
  'https://api.deepseek.com/beta'
)
check(
  '非法协议回退官方地址',
  loadConfigWith({ baseUrl: 'ftp://example.com' }).readConfig().baseUrl,
  'https://api.deepseek.com/beta'
)
check('字符串 false 关闭开关', loadConfigWith({ enabled: 'false' }).readConfig().enabled, false)
check(
  '字符串 languages 视为单项',
  loadConfigWith({ languages: 'markdown' }).readConfig().languages,
  ['markdown']
)
check('非法日志级别回退 info', loadConfigWith({ logLevel: 'verbose' }).readConfig().logLevel, 'info')

/* ------------------------------------------------------------------ */

async function main() {
  await runStreamingTests()

  console.log(`\n===== 结果 =====`)
  console.log(`通过 ${passed} · 失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('测试异常：', error)
  process.exitCode = 1
})
