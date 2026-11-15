/**
 * --- module contract ---
 * purpose: HTML shell composing the panel stylesheet and client script.
 * dependsOn: [generated] lib/web-common.js, lib/web-page-script.js, lib/web-page-style.js
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/web.js
 * publicApi: [generated] PAGE, TITLE
 * risk: Low: composition only; the extracted STYLE/SCRIPT modules are served unchanged.
 * --- end module contract ---
 */

import { PLUGIN_VERSION } from './web-common.js'
import { STYLE } from './web-page-style.js'
import { SCRIPT } from './web-page-script.js'

/** Public page title. */
export const TITLE = 'Context Flow Tower'

/** Single-page read-only browser (no external assets, no write calls). */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${TITLE}</title>
<style>
${STYLE}
</style>
</head>
<body>
<header>
  <img src="assets/ok.jpg" alt="Context Flow Tower mascot" title="大肥鱼 / Dafeiyu" style="width:30px;height:30px;border-radius:8px;object-fit:cover" />
  <h1>${TITLE}<span>read-only · project-local · v${PLUGIN_VERSION}</span></h1>
  <input id="q" placeholder="搜索词条 / search" style="min-width:200px" />
  <select id="scope" title="搜索范围 / search scope">
    <option value="entries">词条 / entries</option>
    <option value="summaries">摘要 / summaries</option>
    <option value="both">两者 / both</option>
  </select>
  <select id="kind" title="类型筛选 / kind filter">
    <option value="">all kinds</option>
    <option value="file">file</option>
    <option value="feature">feature</option>
    <option value="decision">decision</option>
    <option value="task">task</option>
    <option value="error">error</option>
    <option value="command">command</option>
    <option value="api-symbol">api-symbol</option>
    <option value="topic">topic</option>
    <option value="chapter">chapter</option>
    <option value="person">person</option>
  </select>
  <select id="sort" title="排序 / sort">
    <option value="relevance">relevance</option>
    <option value="recent">recent</option>
  </select>
  <input id="module" placeholder="module" title="模块前缀筛选 / module filter" style="width:120px" />
  <label class="tag"><input type="checkbox" id="semantic" /> semantic</label>
  <label class="tag"><input type="checkbox" id="smart" title="DeepSeek smart search"> smart</label>
  <label class="tag"><input type="checkbox" id="allprojects" /> all projects</label>
  <label class="tag"><input type="checkbox" id="strongonly" /> strong ≥0.8</label>
  <button id="go">Search</button>
  <button id="lang-toggle" class="tag" type="button" title="Switch language">EN</button>
  <button id="refresh" class="tag" type="button" title="刷新数据 / refresh data">↻</button>
  <span id="status" class="tag"></span>
</header>
<main>
  <aside>
    <div class="row"><button id="btn-catalog">Projects</button><button id="btn-tasks">Open tasks</button></div>
    <div id="projects" class="muted">loading…</div>
  </aside>
  <section>
    <div class="tabs">
      <button data-tab="browse" class="active">Browse</button>
      <button data-tab="tree">Tree</button>
      <button data-tab="timeline">Timeline</button>
      <button data-tab="tasks">Tasks</button>
      <button data-tab="graph">Graph</button>
      <button data-tab="settings">Settings</button>
<button data-tab="about">About</button>
    </div>
    <div id="out"><pre>loading…</pre></div>
  </section>
</main>
<script>
${SCRIPT}
</script>
</body>
</html>`

export { PAGE }

