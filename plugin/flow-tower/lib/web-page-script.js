/**
 * --- module contract ---
 * purpose: Client-side script for the read-only Flow Tower panel (fetch, render, locale, graph views).
 * dependsOn: [generated] lib/web-common.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/web-page.js
 * publicApi: [generated] SCRIPT
 * risk: Low-medium: browser-only code; the page version is interpolated at module load.
 * --- end module contract ---
 */

import { PLUGIN_VERSION } from './web-common.js'

/** Panel script, injected into the page <script> block. */
export const SCRIPT = `
const state = { project: '', volume: '', tab: 'browse', search: { limit: 20 } };
const VERSION = '${PLUGIN_VERSION}';
const $ = (id) => document.getElementById(id);
const I18N = {
  zh: {
    readOnly: '只读 · 项目本地', searchPh: '搜索词条', search: '搜索', semantic: '语义', smart: '智能', allProjects: '全部项目', strong: '强关系≥0.8',
    projects: '项目', openTasks: '未完成任务', tabs: { browse: '浏览', tree: '树', timeline: '时间线', tasks: '任务', graph: '关系图', settings: '设置', about: '关于' },
    loading: '加载中…', entries: '条', volumes: '卷', noTasks: '没有未完成任务。', close: '关闭',
    graphNone: '暂无关系——先编译内容或运行 tools/relations.mjs --sync。', graphInfo: '点击节点查看关系。颜色：蓝=卷，紫=摘要，黄=组，绿=词条，灰=host。', mermaid: 'Mermaid 导出（点击展开）',
    settings: '设置', resources: '资源', settingsFile: '设置文件', scope: '作用域', save: '保存', language: '语言', reloadNote: '保存到本地；重载插件后生效。',
    smartTip: 'DeepSeek 智能检索：先改写查询，再对候选重排（不需要 embedding 模型，较慢）',
    zhName: '中文', enName: 'English', summaryMatches: '摘要匹配', treeHint: '用 dict_browse({tree:true}) 展开摘要节点。',
    langButton: '中文', langTip: '切换到 English', searchTip: '搜索词条/释义/模块，中英文都可以',
    noResult: '没有匹配结果', searching: '搜索中…', loadMore: '加载更多', hits: '条结果',
    kindFilter: '按类型筛选', sortFilter: '排序方式', moduleFilter: '按模块前缀筛选',
    modeHybrid: '混合检索', modeSemantic: '语义检索', modeLexical: '词法检索', modeSmart: '智能检索',
    semanticTip: '稀疏向量 + 共现扩展；配置 embedding 后也会走向量检索',
    allTip: '关系图包含其他项目的词典', strongTip: '只显示置信度 ≥0.8 的关系',
    tabTips: { browse: '按分类浏览词条', tree: '摘要树（先看层级再下钻）', timeline: '按时间顺序看最近发生的事', tasks: '未完成的任务，可关闭', graph: '类型化关系图，可拖拽节点', settings: '上下文/性能/关系/语言设置' },
    settingsHelp: '作用域：全局影响所有项目；当前项目只影响这个项目。大部分设置保存后立即生效。',
    fieldLabels: {
      maxEntries: '每卷词条上限', resourceProfile: '资源档', digestMode: '摘要注入', digestBudgetTokens: '摘要预算',
      rawBudgetTokens: '原文回放预算', maxTopicsPerRound: '每轮主题数', glossTokens: '释义长度上限',
      relationsMode: '关系图模式', llmCompiler: 'LLM 编纂', proposalMode: 'LLM 提案',
    },
    fieldTips: {
      maxEntries: '每个卷最多保留的词条数；超限按优先级归档淘汰',
      resourceProfile: 'auto=按内存自动限制容量与 SQLite 缓存；off=不限制',
      digestMode: 'on-change=词典内容变化时注入摘要；off=不注入',
      digestBudgetTokens: '每轮注入给模型的摘要 token 预算',
      rawBudgetTokens: '回放原文证据时的 token 预算',
      maxTopicsPerRound: '每轮最多生成多少主题词条',
      glossTokens: '单条释义的长度上限',
      relationsMode: '关系图的构建/使用模式（off/shadow/on）',
      llmCompiler: 'LLM 编纂模式；建议先用 shadow 评估，再开 on',
      proposalMode: 'LLM 提案的落盘模式；off 不保留',
    },
  },
  en: {
    readOnly: 'read-only · project-local', searchPh: 'Search headwords', search: 'Search', semantic: 'semantic', smart: 'smart', allProjects: 'all projects', strong: 'strong ≥0.8',
    projects: 'Projects', openTasks: 'Open tasks', tabs: { browse: 'Browse', tree: 'Tree', timeline: 'Timeline', tasks: 'Tasks', graph: 'Graph', settings: 'Settings', about: 'About' },
    loading: 'loading…', entries: 'entries', volumes: 'volume(s)', noTasks: 'No open tasks.', close: 'close',
    graphNone: 'No relations yet — compile content or run tools/relations.mjs --sync.', graphInfo: 'Click a node for its relations. Colors: blue=volume, purple=summary, yellow=group, green=entry, grey=host.', mermaid: 'Mermaid export (click to open)',
    settings: 'Settings', resources: 'Resources', settingsFile: 'Settings file', scope: 'scope', save: 'Save', language: 'Language', reloadNote: 'Saved locally; applies after the plugin reloads.',
    smartTip: 'DeepSeek smart search: rewrite the query, then rerank candidates (no embedding model; slower)',
    zhName: '中文', enName: 'English', summaryMatches: 'Summary matches', treeHint: 'Use dict_browse({tree:true}) to expand a summary node.',
    langButton: 'English', langTip: '切换到中文', searchTip: 'Search headwords, glosses and modules; Chinese or English',
    noResult: 'No matching results', searching: 'searching…', loadMore: 'load more', hits: 'hits',
    kindFilter: 'Filter by kind', sortFilter: 'Sort order', moduleFilter: 'Filter by module prefix',
    modeHybrid: 'hybrid', modeSemantic: 'semantic', modeLexical: 'lexical', modeSmart: 'smart',
    semanticTip: 'Sparse vectors + co-occurrence; real vector search when an embedding provider is configured',
    allTip: 'Include other project dictionaries in the graph', strongTip: 'Only show relation edges with confidence ≥0.8',
    tabTips: { browse: 'Browse entries by kind', tree: 'Summary tree (drill down from the top)', timeline: 'What happened recently, in time order', tasks: 'Open tasks; click close to finish one', graph: 'Typed relation graph with draggable nodes', settings: 'Context, performance, relations and language settings' },
    settingsHelp: 'Scope: global affects all projects; this project affects only the current one. Most settings apply immediately.',
    fieldLabels: {
      maxEntries: 'Entries per volume', resourceProfile: 'Resource profile', digestMode: 'Digest mode',
      digestBudgetTokens: 'Digest budget', rawBudgetTokens: 'Raw replay budget', maxTopicsPerRound: 'Topics per round',
      glossTokens: 'Gloss cap', relationsMode: 'Relation mode', llmCompiler: 'LLM compiler', proposalMode: 'LLM proposals',
    },
    fieldTips: {
      maxEntries: 'Maximum entries per volume; lowest-priority ones are archived on overflow',
      resourceProfile: 'auto = cap volume + SQLite cache from installed RAM; off = no cap',
      digestMode: 'on-change injects a digest when the dictionary changes; off disables injection',
      digestBudgetTokens: 'Token budget for the injected digest',
      rawBudgetTokens: 'Token budget when replaying raw evidence',
      maxTopicsPerRound: 'Maximum topic entries generated per round',
      glossTokens: 'Maximum gloss length per entry',
      relationsMode: 'Relation graph build/use mode (off/shadow/on)',
      llmCompiler: 'LLM compilation mode; evaluate in shadow before enabling on',
      proposalMode: 'Persistence mode for LLM proposals; off keeps nothing',
    },
  },
};
let locale = (() => {
  try {
    const requested = new URLSearchParams(location.search).get('lang');
    if (requested === 'zh' || requested === 'en') return requested;
    const stored = localStorage.getItem('flow-tower.locale'); if (stored === 'zh' || stored === 'en') return stored;
  } catch (_) { /* ignore */ }
  return 'zh';
})();
const t = (key) => I18N[locale]?.[key] ?? I18N.zh[key] ?? key;
const KIND_LABELS = {
  zh: { file: '文件', feature: '功能', 'api-symbol': 'API 符号', decision: '决策', task: '任务', command: '命令', error: '错误', topic: '主题', chapter: '章节', person: '人物' },
  en: { file: 'file', feature: 'feature', 'api-symbol': 'api-symbol', decision: 'decision', task: 'task', command: 'command', error: 'error', topic: 'topic', chapter: 'chapter', person: 'person' },
};
const kindLabel = (kind) => KIND_LABELS[locale]?.[kind] ?? kind;
const statusLabel = (status) => locale === 'zh'
  ? ({ open: '进行中', done: '已完成', blocked: '受阻' }[status] ?? status)
  : status;
const applyLocale = () => {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = TITLE + (locale === 'zh' ? ' · 项目上下文记忆' : ' · project context memory');
  const headerSpan = document.querySelector('header h1 span'); if (headerSpan) headerSpan.textContent = t('readOnly') + ' · v' + VERSION;
  $('q').placeholder = t('searchPh');
  $('q').title = t('searchTip');
  $('go').textContent = t('search');
  $('go').title = t('searchTip');
  const langButton = $('lang-toggle');
  if (langButton) { langButton.textContent = t('langButton'); langButton.title = t('langTip'); }
  const refreshButton = $('refresh');
  if (refreshButton) refreshButton.title = locale === 'zh' ? '刷新数据' : 'Refresh data';
  const projectsBox = $('projects');
  if (projectsBox && projectsBox.textContent.trim() === 'loading…') projectsBox.textContent = t('loading');
  const outBox = $('out');
  if (outBox && outBox.textContent.trim() === 'loading…') outBox.textContent = t('loading');
  const scopeSel = $('scope');
  if (scopeSel) {
    scopeSel.title = locale === 'zh' ? '搜索范围' : 'Search scope';
    const options = scopeSel.options;
    if (options[0]) options[0].textContent = locale === 'zh' ? '词条' : 'entries';
    if (options[1]) options[1].textContent = locale === 'zh' ? '摘要' : 'summaries';
    if (options[2]) options[2].textContent = locale === 'zh' ? '两者' : 'both';
  }
  const kindSel = $('kind');
  if (kindSel) kindSel.title = t('kindFilter');
  const sortSel = $('sort');
  if (sortSel) {
    sortSel.title = t('sortFilter');
    if (sortSel.options[0]) sortSel.options[0].textContent = locale === 'zh' ? '相关度' : 'relevance';
    if (sortSel.options[1]) sortSel.options[1].textContent = locale === 'zh' ? '最近' : 'recent';
  }
  const moduleInput = $('module');
  if (moduleInput) {
    moduleInput.title = t('moduleFilter');
    moduleInput.placeholder = locale === 'zh' ? '模块' : 'module';
  }
  $('btn-catalog').textContent = t('projects');
  $('btn-tasks').textContent = t('openTasks');
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.textContent = t('tabs')[button.dataset.tab] ?? button.dataset.tab;
    button.title = t('tabTips')?.[button.dataset.tab] ?? button.dataset.tab;
  });
  document.querySelectorAll('label.tag').forEach((label) => {
    const input = label.querySelector('input[type=checkbox]');
    if (input?.id === 'semantic') { label.childNodes[label.childNodes.length - 1].textContent = ' ' + t('semantic'); label.title = t('semanticTip'); }
    if (input?.id === 'smart') { label.childNodes[label.childNodes.length - 1].textContent = ' ' + t('smart'); label.title = t('smartTip'); }
    if (input?.id === 'allprojects') { label.childNodes[label.childNodes.length - 1].textContent = ' ' + t('allProjects'); label.title = t('allTip'); }
    if (input?.id === 'strongonly') { label.childNodes[label.childNodes.length - 1].textContent = ' ' + t('strong'); label.title = t('strongTip'); }
  });
};
const switchLocale = () => {
  locale = locale === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('flow-tower.locale', locale); } catch (_) { /* ignore */ }
  applyLocale();
  try { window.parent?.postMessage({ type: 'flow-tower:locale', locale }, '*'); } catch (_) { /* ignore */ }
  try {
    const next = new URL(location.href);
    next.searchParams.set('lang', locale);
    history.replaceState(null, '', next.toString());
  } catch (_) { /* ignore */ }
  loadTab();
};
applyLocale();
const api = async (path, params = {}) => {
  const qs = new URLSearchParams(params);
  if (state.project) qs.set('project', state.project);
  if (state.volume) qs.set('volume', state.volume);
  qs.set('lang', locale);
  const res = await fetch('api/' + path + '?' + qs.toString());
  return res.json();
};
const show = (text) => { $('out').innerHTML = '<pre></pre>'; $('out').firstChild.textContent = text; };
const renderCatalog = async () => {
  const data = await api('catalog');
  const box = $('projects'); box.innerHTML = '';
  for (const project of data.projects ?? []) {
    const title = document.createElement('div');
    title.className = 'muted'; title.textContent = project.project || (locale === 'zh' ? '(全局)' : '(global)');
    box.appendChild(title);
    for (const volume of project.volumes) {
      if (!state.volume) { state.project = project.project; state.volume = volume.volumeId; }
      const item = document.createElement('div');
      item.className = 'vol' + (state.volume === volume.volumeId ? ' active' : '');
      item.textContent = volume.volumeId.slice(0, 18) + '… · ' + volume.entryCount + ' ' + t('entries');
      item.title = volume.volumeId;
      item.onclick = () => {
        state.project = project.project; state.volume = volume.volumeId;
        renderCatalog(); loadTab();
      };
      box.appendChild(item);
    }
  }
  $('status').textContent = (data.projects ?? []).reduce((n, p) => n + p.volumes.length, 0) + ' ' + t('volumes') + ' · v' + VERSION;
};
const loadTab = async () => {
  if (state.tab === 'browse') { const d = await api('browse', { limit: 100 }); show(d.text ?? d.error); }
  else if (state.tab === 'tree') { const d = await api('tree'); show(d.text ?? d.error); }
  else if (state.tab === 'timeline') { const d = await api('timeline', { limit: 60 }); show(d.text ?? d.error); }
  else if (state.tab === 'graph') {
    const scope = $('allprojects').checked ? 'all' : 'project';
    const strong = $('strongonly').checked ? { minConfidence: 0.8 } : {};
    const d = await api('graph', { format: 'json', scope, ...strong });
    const m = await api('graph', { format: 'mermaid', scope, ...strong });
    renderGraph(d.graph, m.text);
  }
  else if (state.tab === 'settings') {
    const d = await api('settings');
    const box = $('out'); box.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = locale === 'zh' ? 'Context Flow Tower 设置' : 'Context Flow Tower settings';
    heading.style.cssText = 'margin:0 0 8px;font-size:15px';
    const help = document.createElement('div');
    help.className = 'muted';
    help.textContent = t('settingsHelp');
    help.style.cssText = 'margin-bottom:8px';
    const groups = [
      { title: locale === 'zh' ? '性能 / 内存' : 'Performance / memory', keys: [['maxEntries', 'number'], ['resourceProfile', 'select', ['auto', 'off']]] },
      { title: locale === 'zh' ? '记忆与注入' : 'Memory & digest', keys: [['contextRole', 'select', ['primary', 'companion']], ['digestMode', 'select', ['on-change', 'off']], ['digestBudgetTokens', 'number'], ['rawBudgetTokens', 'number'], ['maxTopicsPerRound', 'number'], ['glossTokens', 'number']] },
      { title: locale === 'zh' ? '关系图' : 'Relation graph', keys: [['relationsMode', 'select', ['off', 'shadow', 'on']]] },
      { title: locale === 'zh' ? '自动化 / LLM' : 'Automation / LLM', keys: [['llmCompiler', 'select', ['off', 'shadow', 'on']], ['proposalMode', 'select', ['off', 'shadow', 'on']], ['llmTimeoutMs', 'number']] },
      { title: locale === 'zh' ? '语义 / embedding（可选）' : 'Semantics / embeddings (optional)', keys: [['embeddingEndpoint', 'text'], ['embeddingModel', 'text']] },
    ];
    for (const group of groups) {
      const section = document.createElement('div');
      section.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:10px';
      const title = document.createElement('div');
      title.textContent = group.title;
      title.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:6px;color:var(--dim)';
      section.appendChild(title);
      const row = document.createElement('div'); row.className = 'row';
      for (const [key, kind, options] of group.keys) {
        const wrap = document.createElement('label'); wrap.className = 'tag';
        wrap.textContent = (t('fieldLabels')?.[key] ?? key) + ' ';
        wrap.title = t('fieldTips')?.[key] ?? key;
        let control;
        if (kind === 'select') {
          control = document.createElement('select');
          for (const option of options) { const el = document.createElement('option'); el.value = option; el.textContent = option; control.appendChild(el); }
          control.value = String(d.effective[key] ?? options[0]);
        } else if (kind === 'text') {
          control = document.createElement('input');
          control.type = 'text';
          control.style.width = '240px';
          control.value = d.effective[key] === null || d.effective[key] === undefined ? '' : String(d.effective[key]);
        } else {
          control = document.createElement('input');
          control.type = 'number';
          control.style.width = '90px';
          control.value = d.effective[key] === null || d.effective[key] === undefined ? '' : String(d.effective[key]);
        }
        control.id = 'set-' + key;
        wrap.appendChild(control); row.appendChild(wrap);
      }
      section.appendChild(row); box.appendChild(section);
    }
    const footer = document.createElement('div'); footer.className = 'row';
    const scopeSel = document.createElement('select'); scopeSel.id = 'set-scope';
    scopeSel.innerHTML = '<option value="global">' + (locale === 'zh' ? '全局（所有项目）' : 'global (all projects)') + '</option><option value="project">' + (locale === 'zh' ? '当前项目' : 'this project') + '</option>';
    const scopeLabel = document.createElement('label'); scopeLabel.className = 'tag'; scopeLabel.textContent = t('scope') + ' ';
    scopeLabel.appendChild(scopeSel); footer.appendChild(scopeLabel);
    const langWrap = document.createElement('label'); langWrap.className = 'tag'; langWrap.textContent = t('language') + ' ';
    const langSel = document.createElement('select'); langSel.id = 'set-uiLocale';
    langSel.innerHTML = '<option value="zh">' + t('zhName') + '</option><option value="en">' + t('enName') + '</option>';
    langSel.value = d.effective.uiLocale === 'en' ? 'en' : 'zh';
    langWrap.appendChild(langSel); footer.appendChild(langWrap);
    const save = document.createElement('button'); save.textContent = t('save');
    const info = document.createElement('pre'); info.className = 'muted';
    info.textContent = (locale === 'zh'
      ? '保存到本地；大部分设置立即生效，llmCompiler/资源档重载插件后完全生效。\\n'
      : 'Saved locally; most settings apply immediately, llmCompiler/resource profile after plugin reload.\\n')
      + t('resources') + ': ' + JSON.stringify(d.resources) + '\\n' + t('settingsFile') + ': ' + d.path;
    const semanticInfo = document.createElement('pre');
    semanticInfo.className = 'muted';
    try {
      const status = await api('status');
      const semantic = status.semantic ?? {};
      semanticInfo.textContent = (locale === 'zh' ? '语义状态：embedding ' : 'Semantic status: embedding ')
        + (semantic.embeddingConfigured ? 'configured' : 'off')
        + ' · vectors=' + (semantic.vectorCount ?? 0)
        + ' · aliases=' + (semantic.entriesWithAliases ?? 0)
        + ' · llmCompiler=' + (semantic.llmCompiler ?? 'off')
        + (locale === 'zh' ? '\\n启用 LLM 后需重载插件；embedding 配置后需运行 tools/embed.mjs 回填。' : '\\nReload the plugin after enabling LLM; run tools/embed.mjs after configuring embeddings.');
    } catch {
      semanticInfo.textContent = '';
    }
    save.onclick = async () => {
      const settings = {};
      for (const group of groups) {
        for (const [key] of group.keys) {
          const el = document.getElementById('set-' + key);
          if (el === null) continue;
          settings[key] = el.tagName === 'SELECT' ? el.value : (/^\d+$/.test(el.value) ? Number(el.value) : el.value);
        }
      }
      settings.uiLocale = langSel.value;
      const res = await fetch('api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings, scope: scopeSel.value, project: state.project }) }).then((r) => r.json());
      try { localStorage.setItem('flow-tower.locale', langSel.value); } catch (_) { /* ignore */ }
      locale = langSel.value; applyLocale();
      info.textContent = JSON.stringify(res, null, 2) + '\\n' + (locale === 'zh' ? '已保存；多数设置即时生效。' : 'Saved; most settings apply immediately.');
    };
    const exportButton = document.createElement('button');
    exportButton.textContent = locale === 'zh' ? '导出 JSON' : 'Export JSON';
    exportButton.title = locale === 'zh' ? '导出当前项目词典（卷/词条/引文/关系图）' : 'Export this project dictionary (volumes/entries/citations/relations)';
    exportButton.onclick = async () => {
      const payload = await api('export');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'flow-tower-export.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    footer.appendChild(exportButton);
    footer.appendChild(save);
    box.appendChild(heading); box.appendChild(help); box.appendChild(footer); box.appendChild(semanticInfo); box.appendChild(info);
  }
  else if (state.tab === 'about') {
    const box = $('out'); box.innerHTML = '';
    const zh = locale === 'zh';
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--panel);max-width:860px;margin-bottom:12px';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:14px;align-items:flex-start';
    const img = document.createElement('img');
    img.src = 'assets/ok.jpg'; img.alt = '';
    img.style.cssText = 'width:92px;height:92px;border-radius:12px;object-fit:cover;flex:0 0 auto';
    const headBody = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = 'Context Flow Tower' + (zh ? '（上下文流动塔）' : '');
    title.style.cssText = 'margin:0 0 4px;font-size:18px';
    const tagline = document.createElement('div');
    tagline.className = 'muted';
    tagline.textContent = zh
      ? 'DSH 的自动化项目上下文记忆层：只观察压缩，不改变宿主；词典、摘要树、时间线、任务与类型化关系图都留在项目本地。'
      : 'An automatic project-context memory layer for DSH: observe compaction without changing the host; dictionary, summary tree, timeline, tasks and a typed relation graph stay local to the project.';
    const versionLine = document.createElement('div');
    versionLine.className = 'muted'; versionLine.style.marginTop = '6px';
    versionLine.textContent = (zh ? '版本 ' : 'Version ') + VERSION + ' · ' + (zh ? '界面双语；内容保留原文，不翻译' : 'Bilingual UI; content stays in its source language');
    headBody.appendChild(title); headBody.appendChild(tagline); headBody.appendChild(versionLine);
    head.appendChild(img); head.appendChild(headBody); card.appendChild(head);

    const section = (headingText, items) => {
      const h = document.createElement('h3');
      h.textContent = headingText; h.style.cssText = 'margin:14px 0 4px;font-size:14px';
      const list = document.createElement('ul');
      list.style.cssText = 'margin:0;padding-left:18px;font-size:12px;line-height:1.8;opacity:.9';
      for (const item of items) {
        const li = document.createElement('li');
        if (item instanceof Node) li.appendChild(item); else li.textContent = item;
        list.appendChild(li);
      }
      card.appendChild(h); card.appendChild(list);
    };
    section(zh ? '基本原理' : 'How it works', zh ? [
      '旁路观察：监听宿主 compression/compaction 事件，不替换压缩引擎、不注入隐藏 prompt。',
      '自动编纂：把摘要/片段按 kind、module、project、时间与叙事维度抽成词条，任务/决定/章节优先保留。',
      '证据优先：每条词条保存 session_id + seq 区间，dict_cite 可逐字回放原文；记忆是不可信上下文。',
      '项目本地：每个项目一个 SQLite（<project>/.flow-tower），WAL + 文件锁；默认不上传、不依赖外部服务。',
      '检索：BM25-lite + 稀疏向量/共现扩展 + 类型化关系邻近；可选 OpenAI-compatible embedding。',
      '策略：bundle 默认 → 全局 settings → 项目 settings，三层覆盖；大部分设置即时生效。',
    ] : [
      'Observation-only: listens to host compression/compaction events; never replaces the engine or injects hidden prompts.',
      'Automatic compilation: extracts entries by kind, module, project, time and narrative; tasks/decisions/chapters are protected.',
      'Evidence first: every entry stores session_id + seq ranges; dict_cite replays the exact source. Memory is untrusted context.',
      'Project-local: one SQLite per project (<project>/.flow-tower), WAL + file locks; no upload and no external service by default.',
      'Retrieval: BM25-lite + sparse/co-occurrence expansion + typed relation proximity; optional OpenAI-compatible embeddings.',
      'Policy: bundle defaults → global settings → project settings; most changes apply immediately.',
    ]);
    section(zh ? '优势' : 'Advantages', zh ? [
      '零人工：压缩发生即自动沉淀，不需要标注或手动整理。',
      '可追溯：逐字证据回放，而不是只给一句 LLM 摘要。',
      '项目本地、随代码走：换机器/备份/共享项目目录即可带走记忆。',
      '零依赖 Host-only：纯 JS、无外部服务；容量、缓存、内存按硬件自适应。',
      '多维检索：项目/模块/任务/时间/叙事 + 类型化关系图（十万边实测）。',
    ] : [
      'Zero manual work: compiles automatically when compaction happens; no labeling or manual curation.',
      'Traceable: verbatim evidence replay, not just an LLM summary sentence.',
      'Project-local: memory travels with the project folder for backup/sharing.',
      'Zero-dependency Host-only: pure JS, no external service; capacity/cache/memory adapt to hardware.',
      'Multi-dimensional retrieval: project/module/task/time/narrative + typed relation graph (100k-edge benchmark).',
    ]);
    const refs = [
      ['DeepSeek Harness / Cordis', 'https://github.com/deepseek-ai'],
      ['Super-Agent (Cordis prototype)', ''],
      ['Context Folding / CarryOn', ''],
      ['MemGPT (arXiv:2310.08560)', 'https://arxiv.org/abs/2310.08560'],
      ['RAPTOR (arXiv:2401.18059)', 'https://arxiv.org/abs/2401.18059'],
      ['Graphiti', 'https://github.com/getzep/graphiti'],
      ['mem0', 'https://github.com/mem0ai/mem0'],
      ['Letta', 'https://github.com/letta-ai/letta'],
      ['bgx666 / qinghuaju (DSH context plugins)', ''],
    ];
    const refList = document.createElement('ul');
    refList.style.cssText = 'margin:0;padding-left:18px;font-size:12px;line-height:1.8;opacity:.85';
    for (const [name, url] of refs) {
      const li = document.createElement('li');
      if (url.length > 0) {
        const a = document.createElement('a');
        a.textContent = name; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.style.color = 'var(--acc)';
        li.appendChild(a);
      } else li.textContent = name;
      refList.appendChild(li);
    }
    const refH = document.createElement('h3');
    refH.textContent = zh ? '参考与致敬' : 'References';
    refH.style.cssText = 'margin:14px 0 4px;font-size:14px';
    const refNote = document.createElement('div');
    refNote.className = 'muted';
    refNote.textContent = zh ? '仅作设计参考，非代码依赖；竞品对比见 design/flow-tower/17。' : 'Design references only, not code dependencies; see design/flow-tower/17 for the comparison.';
    card.appendChild(refH); card.appendChild(refList); card.appendChild(refNote);

    const company = document.createElement('div');
    company.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;line-height:1.7';
    company.appendChild(document.createTextNode((zh ? '开发：' : 'Built by: ') + '广州天权智能科技有限公司'));
    company.appendChild(document.createElement('br'));
    const link = document.createElement('a');
    link.href = 'https://www.tianquanzhineng.com'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = 'www.tianquanzhineng.com'; link.style.color = 'var(--acc)';
    company.appendChild(link);
    card.appendChild(company);
    box.appendChild(card);
  }
  else if (state.tab === 'tasks') {
    const d = await api('tasks');
    const box = $('out'); box.innerHTML = '';
    if (d.focus) {
      const focus = document.createElement('div');
      focus.className = 'hit';
      focus.style.borderColor = 'var(--acc)';
      const b = document.createElement('b'); b.textContent = (locale === 'zh' ? '当前焦点：' : 'Current focus: ') + d.focus.headword;
      const meta = document.createElement('div'); meta.className = 'muted';
      meta.textContent = (d.focus.module || '—') + ' · ' + (locale === 'zh' ? d.focus.contextCount + ' 条同模块上下文' : d.focus.contextCount + ' related context entries');
      focus.appendChild(b); focus.appendChild(meta); box.appendChild(focus);
    }
    if (!d.tasks || d.tasks.length === 0) { const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = t('noTasks'); box.appendChild(empty); return; }
    for (const task of d.tasks) {
      const row = document.createElement('div'); row.className = 'hit';
      row.innerHTML = '<span></span><button style="margin-left:8px"></button>';
      row.querySelector('button').textContent = t('close');
      row.firstChild.textContent = task.headword + '  [' + (locale === 'zh' ? '任务:' + statusLabel(task.status) : task.status) + ']' + (task.module ? '  · ' + task.module : '') + (locale === 'zh' ? '  · 上下文 ' + task.contextCount + ' 条' : '  · ' + task.contextCount + ' context');
      row.querySelector('button').onclick = async () => {
        await fetch('api/task/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: task.volumeId === state.volume ? state.project : state.project, entryId: task.entryId }) });
        loadTab();
      };
      box.appendChild(row);
    }
  }
};
const renderGraph = (graph, mermaidText) => {
  const box = $('out');
  const allNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const allEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (allNodes.length === 0) { show(t('graphNone')); return; }
  const degree = new Map();
  for (const edge of allEdges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }
  const pick = (family, max) => allNodes.filter((node) => node.family === family)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, max);
  const families = [
    ['volume', 4, 0, 0],
    ['summary', 12, 140, 120],
    ['group', 24, 250, 200],
    ['entry', 80, 350, 280],
    ['host', 30, 440, 360],
  ];
  const chosen = [];
  for (const [family, max, radius, startAngle] of families) {
    const nodes = pick(family, max);
    nodes.forEach((node, index) => {
      const angle = (startAngle * Math.PI) / 180 + (Math.PI * 2 * index) / Math.max(1, nodes.length);
      chosen.push({ node, x: 450 + Math.cos(angle) * radius, y: 300 + Math.sin(angle) * radius });
    });
  }
  // forceLayout: dependency-free spring/repulsion layout (seed = family rings).
  const positions = new Map(chosen.map((item) => [item.node.id, { x: item.x, y: item.y }]));
  const layoutEdges = allEdges.filter((edge) => positions.has(edge.fromId) && positions.has(edge.toId)).slice(0, 600);
  const ids = [...positions.keys()];
  for (let iteration = 0; iteration < 140; iteration += 1) {
    const forces = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i]); const b = positions.get(ids[j]);
        let dx = a.x - b.x; let dy = a.y - b.y;
        let distance2 = dx * dx + dy * dy;
        if (distance2 < 1) { dx = 0.6; dy = 0.6; distance2 = 1; }
        const force = 2200 / distance2;
        const distance = Math.sqrt(distance2);
        const fx = (dx / distance) * force; const fy = (dy / distance) * force;
        forces.get(ids[i]).x += fx; forces.get(ids[i]).y += fy;
        forces.get(ids[j]).x -= fx; forces.get(ids[j]).y -= fy;
      }
    }
    for (const edge of layoutEdges) {
      const a = positions.get(edge.fromId); const b = positions.get(edge.toId);
      const dx = b.x - a.x; const dy = b.y - a.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const spring = 0.015 * (distance - 110);
      const fx = (dx / distance) * spring; const fy = (dy / distance) * spring;
      forces.get(edge.fromId).x += fx; forces.get(edge.fromId).y += fy;
      forces.get(edge.toId).x -= fx; forces.get(edge.toId).y -= fy;
    }
    for (const id of ids) {
      const point = positions.get(id); const force = forces.get(id);
      point.x = Math.max(25, Math.min(875, point.x + force.x * 0.6 + (450 - point.x) * 0.002));
      point.y = Math.max(25, Math.min(575, point.y + force.y * 0.6 + (300 - point.y) * 0.002));
    }
  }
  for (const item of chosen) {
    const point = positions.get(item.node.id);
    item.x = point.x; item.y = point.y;
  }
  const pos = new Map(chosen.map((item) => [item.node.id, item]));
  const visible = new Set(pos.keys());
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 900 600');
  svg.setAttribute('width', '100%');
  svg.style.background = '#0f1115';
  svg.style.borderRadius = '8px';
  const colors = { volume: '#6ea8fe', summary: '#c792ea', group: '#ffd166', entry: '#8ce99a', host: '#8b93a3' };
  const lines = [];
  for (const edge of allEdges) {
    if (!visible.has(edge.fromId) || !visible.has(edge.toId)) continue;
    const a = pos.get(edge.fromId).node;
    const b = pos.get(edge.toId).node;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pos.get(edge.fromId).x);
    line.setAttribute('y1', pos.get(edge.fromId).y);
    line.setAttribute('x2', pos.get(edge.toId).x);
    line.setAttribute('y2', pos.get(edge.toId).y);
    line.setAttribute('stroke', '#2c3442');
    line.setAttribute('stroke-width', '0.8');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = a.label + ' → ' + edge.type + ' → ' + b.label;
    line.appendChild(title);
    svg.appendChild(line);
    lines.push({ line, fromId: edge.fromId, toId: edge.toId });
  }
  for (const item of chosen) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', item.x);
    circle.setAttribute('cy', item.y);
    circle.setAttribute('r', item.node.family === 'volume' ? '7' : '4');
    circle.setAttribute('fill', colors[item.node.family] ?? '#8b93a3');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = item.node.label + ' [' + item.node.kind + ']';
    circle.appendChild(title);
    circle.style.cursor = 'pointer';
    circle.addEventListener('click', async () => {
      const r = await api('relate', { node: item.node.id });
      info.textContent = r.text ?? r.error ?? 'no relations';
    });
    circle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const toSvg = (ev) => {
        const point = svg.createSVGPoint();
        point.x = ev.clientX; point.y = ev.clientY;
        return point.matrixTransform(svg.getScreenCTM().inverse());
      };
      const move = (ev) => {
        const point = toSvg(ev);
        item.x = point.x; item.y = point.y;
        circle.setAttribute('cx', point.x); circle.setAttribute('cy', point.y);
        for (const entry of lines) {
          if (entry.fromId === item.node.id) { entry.line.setAttribute('x1', point.x); entry.line.setAttribute('y1', point.y); }
          if (entry.toId === item.node.id) { entry.line.setAttribute('x2', point.x); entry.line.setAttribute('y2', point.y); }
        }
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    svg.appendChild(circle);
    if (item.node.family === 'volume') {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', item.x + 10);
      text.setAttribute('y', item.y + 4);
      text.setAttribute('fill', '#8b93a3');
      text.setAttribute('font-size', '10');
      text.textContent = 'volume';
      svg.appendChild(text);
    }
  }
  box.innerHTML = '';
  const info = document.createElement('pre');
  info.className = 'muted';
  info.textContent = t('graphInfo');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'tag';
  summary.textContent = t('mermaid');
  const pre = document.createElement('pre');
  pre.textContent = mermaidText ?? '';
  details.appendChild(summary);
  details.appendChild(pre);
  box.appendChild(svg);
  box.appendChild(info);
  box.appendChild(details);
};
const clearBox = (box) => { while (box.firstChild) box.removeChild(box.firstChild); };
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
};
const modeText = (mode) => {
  if (mode === 'smart') return t('modeSmart');
  if (mode === 'semantic') return t('modeSemantic');
  if (mode === 'lexical') return t('modeLexical');
  return t('modeHybrid');
};
const openDetail = async (hit) => {
  const r = await api('lookup', { term: hit.headword });
  const holder = make('div', 'detail');
  holder.appendChild(make('pre', '', r.text ?? r.error ?? ''));
  for (const cite of r.citations ?? []) {
    const button = make('button', '', '▶ ' + (locale === 'zh' ? '回放 ' : 'replay ') + cite.citeId);
    button.title = locale === 'zh' ? '回放原文 / replay source' : 'replay source';
    button.style.cssText = 'margin:4px 6px 0 0;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer';
    button.onclick = async () => {
      const source = await api('cite', { cite_id: cite.citeId });
      holder.appendChild(make('pre', '', source.text ?? source.error ?? ''));
    };
    holder.appendChild(button);
  }
  const box = $('out'); clearBox(box); box.appendChild(holder);
};
const renderHit = (hit) => {
  const card = make('div', 'hit');
  card.tabIndex = 0;
  const head = make('div');
  head.appendChild(make('b', '', hit.headword || '(untitled)'));
  const status = hit.status ? ' · ' + statusLabel(hit.status) : '';
  head.appendChild(make('span', 'k', '[' + kindLabel(hit.kind) + status + ']'));
  if (typeof hit.score === 'number') head.appendChild(make('span', 'score', String(hit.score)));
  card.appendChild(head);
  if (hit.module) card.appendChild(make('div', 'module', hit.module));
  if (hit.gloss) card.appendChild(make('div', 'gloss', hit.gloss));
  const badges = make('div', 'badges');
  const matched = Array.isArray(hit.matched) ? hit.matched.slice(0, 6) : [];
  for (const term of matched) badges.appendChild(make('span', 'badge', 'match: ' + term));
  for (const source of hit.sources ?? []) badges.appendChild(make('span', 'badge', source));
  for (const reason of hit.reasons ?? []) badges.appendChild(make('span', 'badge reason', reason));
  if (badges.childNodes.length > 0) card.appendChild(badges);
  card.onclick = () => openDetail(hit);
  card.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); openDetail(hit); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const cards = Array.from(document.querySelectorAll('#out .hit'));
    const index = cards.indexOf(card);
    const next = event.key === 'ArrowDown' ? cards[index + 1] : cards[index - 1];
    if (next) next.focus();
  };
  return card;
};
const renderResults = (data, append) => {
  const box = $('out');
  if (!append) clearBox(box);
  if (data.error) {
    box.appendChild(make('div', 'searchEmpty', String(data.error)));
    return;
  }
  const results = data.results ?? [];
  const meta = make('div', 'searchMeta');
  const label = results.length + ' ' + t('hits') + ' · ' + modeText(data.mode) + (data.timingMs ? ' · ' + data.timingMs + 'ms' : '');
  meta.appendChild(make('span', '', label));
  if (data.smart && (data.smart.expandedQueries ?? []).length > 0) {
    meta.appendChild(make('span', '', (locale === 'zh' ? '改写：' : 'rewritten: ') + data.smart.expandedQueries.slice(0, 3).join(' | ')));
  }
  if (!$('smart').checked) {
    const smartButton = make('button', '', locale === 'zh' ? '智能重排' : 'smart rerank');
    smartButton.title = t('smartTip');
    smartButton.onclick = () => { $('smart').checked = true; search(false); };
    meta.appendChild(smartButton);
  }
  box.appendChild(meta);
  if (results.length === 0) {
    box.appendChild(make('div', 'searchEmpty', locale === 'zh'
      ? '没有匹配；试试更短的关键词、换 kind/模块过滤，或点“智能重排”。'
      : 'No matches; try shorter keywords, another kind/module filter, or smart rerank.'));
    return;
  }
  for (const hit of results) box.appendChild(renderHit(hit));
  if ((data.summaries ?? []).length > 0) {
    box.appendChild(make('h3', '', t('summaryMatches')));
    for (const summary of data.summaries) {
      const card = make('div', 'hit');
      card.appendChild(make('b', '', summary.node?.label ?? summary.nodeId ?? 'summary'));
      card.appendChild(make('span', 'k', '[' + (locale === 'zh' ? '摘要 · 得分 ' : 'summary · score ') + summary.score + ']'));
      card.appendChild(make('div', 'gloss', summary.node?.summary ?? ''));
      box.appendChild(card);
    }
  }
  if (results.length >= state.search.limit) {
    const more = make('button', '', t('loadMore'));
    more.onclick = () => { state.search.limit += 20; search(true); };
    box.appendChild(more);
  }
};
const search = async (append) => {
  const q = $('q').value.trim();
  if (!q) { clearBox($('out')); return; }
  if (!append) state.search.limit = 20;
  const box = $('out');
  if (!append) {
    clearBox(box);
    box.appendChild(make('div', 'searchEmpty', t('searching')));
  }
  const kind = $('kind') ? $('kind').value : '';
  const sort = $('sort') ? $('sort').value : 'relevance';
  const module = $('module') ? $('module').value.trim() : '';
  try {
    if ($('smart').checked) {
      const data = await api('smart-search', { q, limit: state.search.limit, scope: $('scope').value, ...(kind ? { kind } : {}) });
      data.mode = 'smart';
      renderResults(data, append);
      return;
    }
    const data = await api('search', {
      q,
      limit: state.search.limit,
      scope: $('scope').value,
      mode: $('semantic').checked ? 'semantic' : 'hybrid',
      sort,
      ...(kind ? { kind } : {}),
      ...(module ? { module } : {}),
    });
    renderResults(data, append);
  } catch (error) {
    clearBox(box);
    box.appendChild(make('div', 'searchEmpty', String(error && error.message ? error.message : error)));
  }
};
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active'); state.tab = btn.dataset.tab; loadTab();
  };
});
$('go').onclick = () => search(false);
let searchTimer = null;
const scheduleSearch = () => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    search(false);
  }, 320);
};
$('q').addEventListener('input', scheduleSearch);
$('q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
    search(false);
  } else if (event.key === 'Escape') {
    $('q').value = '';
    clearBox($('out'));
  }
});
['kind', 'sort', 'module'].forEach((id) => {
  const element = $(id);
  if (element) element.addEventListener('change', () => { if ($('q').value.trim()) search(false); });
});
['semantic', 'smart'].forEach((id) => {
  const element = $(id);
  if (element) element.addEventListener('change', () => { if ($('q').value.trim()) search(false); });
});
$('btn-catalog').onclick = renderCatalog;
$('btn-tasks').onclick = () => { state.tab = 'tasks'; loadTab(); };
$('refresh').onclick = () => { renderCatalog().then(loadTab); };
$('lang-toggle').onclick = switchLocale;
const initialTab = new URLSearchParams(location.search).get('tab') || location.hash.replace('#', '');
if (['browse', 'tree', 'timeline', 'tasks', 'graph', 'settings', 'about'].includes(initialTab)) {
  state.tab = initialTab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === initialTab));
}
renderCatalog().then(loadTab);
`
