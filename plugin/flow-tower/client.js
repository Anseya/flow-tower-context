/**
 * --- module contract ---
 * purpose: Native React overlay (launcher + panel) for browsing, search, tasks, graph and settings.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] react
 * usedBy: [generated] (none)
 * publicApi: [generated] (none)
 * risk: High: loaded as one ModuleLoader bundle with no local imports; splitting it would change the client contract, so it stays one file with a contract header.
 * --- end module contract ---
 */
window.__ModuleLoader__.load({
  id: '@local/flow-tower',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const PANEL_KEY = 'flow-tower.panel.native';
    const LAUNCHER_KEY = 'flow-tower.launcher.native';
    const API = '/flow-tower/api/';

    const readLocale = () => {
      try {
        const stored = window.localStorage.getItem('flow-tower.locale');
        if (stored === 'zh' || stored === 'en') return stored;
      } catch (_) { /* ignore */ }
      return 'zh';
    };
    const loadJson = (key, fallback) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || 'null');
        if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed };
      } catch (_) { /* ignore */ }
      return fallback;
    };
    const saveJson = (key, value) => {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    async function api(path, params = {}) {
      const qs = new URLSearchParams(params);
      const response = await fetch(`${API}${path}?${qs.toString()}`, { headers: { accept: 'application/json' } });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`);
      return json;
    }

    /** Keep a render error inside the panel instead of unmounting the overlay. */
    class OverlayBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        try { console.error('[flow-tower] UI error', error); } catch (_) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          return h('div', {
            style: {
              position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000,
              maxWidth: '420px', padding: '10px 12px', borderRadius: '8px',
              background: '#2a1d1d', color: '#ffd2c2', border: '1px solid #7a3b3b',
              font: '12px/1.5 system-ui,sans-serif',
            },
          }, 'Context Flow Tower UI error: ' + String(this.state.error?.message ?? this.state.error));
        }
        return this.props.children;
      }
    }

    function FlowTowerLauncher(props) {
      const [locale, setLocale] = useState(readLocale);
      const [status, setStatus] = useState(null);
      const [tab, setTab] = useState('browse');
      const [catalog, setCatalog] = useState(null);
      const [projectsInfo, setProjectsInfo] = useState(null);
      const [project, setProject] = useState('');
      const [volume, setVolume] = useState('');
      const [bodyText, setBodyText] = useState('');
      const [tasks, setTasks] = useState(null);
      const [graph, setGraph] = useState(null);
      const [settings, setSettings] = useState(null);
      const [settingsDraft, setSettingsDraft] = useState({});
      const [message, setMessage] = useState('');
      const [searchQ, setSearchQ] = useState('');
      const [scope, setScope] = useState('entries');
      const [semantic, setSemantic] = useState(false);
      const [smart, setSmart] = useState(false);
      const [searchData, setSearchData] = useState(null);
      const [lookupData, setLookupData] = useState(null);
      const [citeText, setCiteText] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [guideSeen, setGuideSeen] = useState(() => {        try { return window.localStorage.getItem('flow-tower.guideSeen') === '1' } catch (_) { return true }
      });
      const [refreshTick, setRefreshTick] = useState(0);
      const [pos, setPos] = useState(() => loadJson(LAUNCHER_KEY, {
        x: Math.max(16, window.innerWidth - 220),
        y: Math.max(16, window.innerHeight - 96),
      }));
      const [panel, setPanel] = useState(() => loadJson(PANEL_KEY, {
        open: false, minimized: false,
        x: Math.max(16, Math.round((window.innerWidth - 900) / 2)),
        y: 56, width: Math.min(900, window.innerWidth - 32), height: Math.min(640, window.innerHeight - 100),
      }));
      const drag = useRef(null);
      const moved = useRef(0);
      const suppressClick = useRef(false);
      const launcherRef = useRef(null);

      const zh = locale === 'zh';
      const L = (cn, en) => (zh ? cn : en);
      const version = status?.version ?? '…';

      useEffect(() => {
        let cancelled = false;
        Promise.all([api('status'), api('catalog'), api('projects')]).then(([s, c, p]) => {
          if (cancelled) return;
          setStatus(s);
          setCatalog(c);
          setProjectsInfo(p);
          const first = (c.projects ?? []).find((item) => item.volumes.length > 0) ?? (c.projects ?? [])[0];
          if (first) {
            setProject(first.project ?? '');
            setVolume(first.volumes?.[0]?.volumeId ?? '');
          }
        }).catch((err) => { if (!cancelled) setError(String(err.message ?? err)) });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        const onStorage = (event) => { if (event.key === 'flow-tower.locale') setLocale(readLocale()); };
        const onMessage = (event) => {
          if (event?.data?.type === 'flow-tower:locale' && (event.data.locale === 'zh' || event.data.locale === 'en')) {
            setLocale(event.data.locale);
            try { window.localStorage.setItem('flow-tower.locale', event.data.locale); } catch (_) { /* ignore */ }
          }
        };
        window.addEventListener('storage', onStorage);
        window.addEventListener('message', onMessage);
        return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('message', onMessage); };
      }, []);

      useEffect(() => {
        if (!panel.open) return;
        let cancelled = false;
        setBusy(true); setError('');
        (async () => {
          try {
            if (tab === 'browse' || tab === 'tree' || tab === 'timeline') {
              const path = tab === 'browse' ? 'browse' : tab;
              const params = {
                limit: tab === 'browse' ? 200 : (tab === 'tree' ? 30 : 60),
                ...(project ? { project } : {}),
                ...(volume ? { volume } : {}),
              };
              const d = await api(path, params);
              if (!cancelled) setBodyText(d.text ?? d.error ?? '');
            } else if (tab === 'tasks') {
              const d = await api('tasks', { ...(project ? { project } : {}), ...(volume ? { volume } : {}) });
              if (!cancelled) setTasks(d);
            } else if (tab === 'graph') {
              const d = await api('graph', { format: 'json', scope: 'all', ...(project ? { project } : {}), ...(volume ? { volume } : {}) });
              if (!cancelled) setGraph(d.graph);
            } else if (tab === 'settings') {
              const d = await api('settings', { ...(project ? { project } : {}) });
              if (!cancelled) {
                setSettings(d);
                const draft = {};
                for (const key of d.editable ?? []) draft[key] = d.effective?.[key] ?? '';
                setSettingsDraft(draft);
              }
            }
          } catch (err) {
            if (!cancelled) setError(String(err.message ?? err));
          } finally {
            if (!cancelled) setBusy(false);
          }
        })();
        return () => { cancelled = true; };
      }, [panel.open, tab, project, volume, refreshTick]);

      const openPanel = (nextTab) => {
        try { window.localStorage.setItem('flow-tower.guideSeen', '1'); } catch (_) { /* ignore */ }
        setGuideSeen(true);
        setPanel((current) => {
          const next = { ...current, open: true, minimized: false };
          saveJson(PANEL_KEY, next);
          return next;
        });
        if (nextTab) setTab(nextTab);
      };
      const closePanel = () => setPanel((current) => { const next = { ...current, open: false }; saveJson(PANEL_KEY, next); return next; });
      const refreshData = () => {
        setBodyText(''); setSearchData(null); setLookupData(null); setTasks(null); setGraph(null); setSettings(null);
        setRefreshTick((value) => value + 1);
        api('status').then(setStatus).catch(() => {});
        setMessage(L('已刷新', 'refreshed'));
        setTimeout(() => setMessage(''), 1500);
      };
      const reloadUi = () => { try { window.location.reload(); } catch (_) { /* ignore */ } };
      const switchLocale = (next) => {
        const target = next === 'en' ? 'en' : 'zh';
        setLocale(target);
        try { window.localStorage.setItem('flow-tower.locale', target); } catch (_) { /* ignore */ }
      };

      const doSearch = async () => {
        const q = searchQ.trim();
        if (!q) return;
        setBusy(true); setError(''); setLookupData(null); setCiteText('');
        try {
          const params = {
            q, limit: 20, scope,
            ...(project ? { project } : {}),
            ...(volume ? { volume } : {}),
            ...(semantic ? { semantic: 'true' } : {}),
          };
          const data = smart ? await api('smart-search', { ...params }) : await api('search', params);
          setSearchData(data);
        } catch (err) {
          setError(String(err.message ?? err));
        } finally { setBusy(false); }
      };
      const openLookup = async (headword) => {
        setBusy(true); setError('');
        try { setLookupData(await api('lookup', { term: headword, ...(project ? { project } : {}), ...(volume ? { volume } : {}) })); }
        catch (err) { setError(String(err.message ?? err)); }
        finally { setBusy(false); }
      };
      const replayCitation = async (citeId) => {
        setCiteText(L('加载中…', 'loading…'));
        try { const d = await api('cite', { cite_id: citeId }); setCiteText(d.text ?? d.error ?? ''); }
        catch (err) { setCiteText(String(err.message ?? err)); }
      };
      const saveSettings = async () => {
        if (!settings) return;
        setBusy(true); setError('');
        try {
          const numericKeys = new Set(['maxEntries', 'digestBudgetTokens', 'rawBudgetTokens', 'maxTopicsPerRound', 'glossTokens', 'nodeBudgetTokens', 'llmMaxTokens', 'llmTimeoutMs', 'embeddingTimeoutMs', 'maxCitationsPerEntry', 'maxCiteExcerptChars', 'tierHotDays', 'tierWarmDays', 'summaryMemoryChars', 'mapThresholdEntries']);
          const normalized = { ...settingsDraft };
          for (const key of numericKeys) {
            if (normalized[key] !== undefined && normalized[key] !== '') normalized[key] = Number(normalized[key]);
          }
          if (normalized.projectMode === 'allowlist' && (!Array.isArray(normalized.projectAllowlist) || normalized.projectAllowlist.length === 0) && projectsInfo?.current) {
            normalized.projectAllowlist = [projectsInfo.current];
          }
          if (normalized.storageMode === 'custom' && String(normalized.storagePath ?? '').trim().length === 0) {
            setError(L('自定义存储需要填写目录路径', 'Custom storage needs a directory path'));
            setBusy(false);
            return;
          }
          const payload = { settings: normalized, scope: 'global', project };
          const response = await fetch(`${API}settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const saved = await response.json();
          if (!saved?.ok) {
            setError(String(saved?.error ?? JSON.stringify(saved)));
            return;
          }
          const fresh = await api('settings', { ...(project ? { project } : {}) });
          setSettings(fresh);
          const draft = {};
          for (const key of fresh.editable ?? []) draft[key] = fresh.effective?.[key] ?? '';
          setSettingsDraft(draft);
          setMessage(saved.migration?.migrated > 0
            ? L(`已保存，迁移 ${saved.migration.migrated} 个卷`, `saved; migrated ${saved.migration.migrated} volume(s)`)
            : L('已保存', 'saved'));
          setTimeout(() => setMessage(''), 3000);
        } catch (err) { setError(String(err.message ?? err)); }
        finally { setBusy(false); }
      };
      const closeTask = async (task) => {
        try {
          await fetch(`${API}task/close`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project, entryId: task.entryId }),
          });
          const d = await api('tasks', { ...(project ? { project } : {}), ...(volume ? { volume } : {}) });
          setTasks(d);
        } catch (err) { setError(String(err.message ?? err)); }
      };

      const beginDrag = (event, kind) => {
        if (event.button !== 0) return;
        const start = kind === 'launcher' ? { x: pos.x, y: pos.y } : { x: panel.x, y: panel.y };
        drag.current = { kind, startX: event.clientX, startY: event.clientY, start };
        moved.current = 0;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      };
      const onDragMove = (event) => {
        if (drag.current === null) return;
        const dx = event.clientX - drag.current.startX;
        const dy = event.clientY - drag.current.startY;
        moved.current = Math.max(moved.current, Math.abs(dx) + Math.abs(dy));
        if (moved.current < 3) return;
        const next = {
          x: clamp(drag.current.start.x + dx, 8, Math.max(8, window.innerWidth - (drag.current.kind === 'launcher' ? 170 : 240))),
          y: clamp(drag.current.start.y + dy, 8, Math.max(8, window.innerHeight - (drag.current.kind === 'launcher' ? 52 : 80))),
        };
        if (drag.current.kind === 'launcher') setPos(next);
        else setPanel((current) => ({ ...current, ...next }));
      };
      const endDrag = () => {
        if (drag.current === null) return;
        const kind = drag.current.kind;
        drag.current = null;
        suppressClick.current = moved.current >= 3;
        if (kind === 'launcher') saveJson(LAUNCHER_KEY, pos);
        else saveJson(PANEL_KEY, panel);
      };
      const onClick = () => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        if (!panel.open) openPanel('browse');
      };

      const tabs = [
        ['browse', L('浏览', 'Browse')],
        ['tree', L('树', 'Tree')],
        ['timeline', L('时间线', 'Timeline')],
        ['tasks', L('任务', 'Tasks')],
        ['graph', L('关系图', 'Graph')],
        ['settings', L('设置', 'Settings')],
        ['about', L('关于', 'About')],
      ];
      const fieldLabels = {
        zh: { contextRole: '上下文角色', maxEntries: '每卷词条上限', resourceProfile: '资源档', digestMode: '摘要注入', digestStrategy: '注入策略', digestBudgetTokens: '摘要预算', rawBudgetTokens: '原文回放预算', maxTopicsPerRound: '每轮主题数', glossTokens: '释义上限', relationsMode: '关系图模式', llmCompiler: 'LLM 编纂', proposalMode: 'LLM 提案', llmTimeoutMs: 'LLM 超时(ms)', embeddingEndpoint: 'Embedding 地址', embeddingModel: 'Embedding 模型', uiLocale: '界面语言', storageMode: '存储位置', storagePath: '自定义目录', summaryMemoryChars: '压缩写记忆上限(字符)', mapThresholdEntries: '大项目地图阈值(条)' },
        en: { contextRole: 'Context role', maxEntries: 'Entries per volume', resourceProfile: 'Resource profile', digestMode: 'Digest mode', digestStrategy: 'Injection strategy', digestBudgetTokens: 'Digest budget', rawBudgetTokens: 'Raw replay budget', maxTopicsPerRound: 'Topics per round', glossTokens: 'Gloss cap', relationsMode: 'Relation mode', llmCompiler: 'LLM compiler', proposalMode: 'LLM proposals', llmTimeoutMs: 'LLM timeout (ms)', embeddingEndpoint: 'Embedding endpoint', embeddingModel: 'Embedding model', uiLocale: 'UI language', storageMode: 'Storage location', storagePath: 'Custom directory', summaryMemoryChars: 'Summary memory chars', mapThresholdEntries: 'Map threshold entries' },
      }[locale];

      const panelStyle = {
        position: 'fixed', left: `${panel.x}px`, top: `${panel.y}px`,
        width: `${panel.width}px`, height: `${panel.height}px`,
        zIndex: 2147482001, background: '#151922', border: '1px solid #2b3240',
        borderRadius: '12px', boxShadow: '0 18px 60px rgba(0,0,0,.5)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto',
        resize: 'both', minWidth: '460px', minHeight: '280px',
        font: '12px/1.5 system-ui,"Segoe UI",sans-serif', color: '#d7dbe2',
      };
      const headerStyle = {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px',
        background: '#1d222c', borderBottom: '1px solid #2b3240', cursor: 'grab',
        touchAction: 'none', userSelect: 'none',
      };
      const buttonStyle = {
        background: 'transparent', color: '#cfd6e4', border: '1px solid #394154',
        borderRadius: '6px', padding: '2px 8px', cursor: 'pointer', font: 'inherit',
      };
      const inputStyle = {
        background: '#0f1115', color: '#d7dbe2', border: '1px solid #2b3240',
        borderRadius: '6px', padding: '4px 7px', font: 'inherit',
      };

      const renderBody = () => {
        if (busy) return h('div', { style: { padding: '16px', opacity: 0.7 } }, L('加载中…', 'loading…'));
        if (tab === 'about') {
          return h('div', { style: { padding: '16px', overflow: 'auto' } },
            h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start' } },
              h('img', { src: '/flow-tower/assets/ok.jpg', alt: '', style: { width: '86px', height: '86px', borderRadius: '12px', objectFit: 'cover' } }),
              h('div', null,
                h('h2', { style: { margin: '0 0 4px', fontSize: '17px' } }, 'Context Flow Tower' + (zh ? '（上下文流动塔）' : '')),
                h('div', { style: { opacity: 0.8, lineHeight: 1.7 } }, L(
                  'DSH 的项目上下文记忆层与可选压缩层：把宿主 compaction 覆盖的原始区间编译成可回放词典，再把项目记忆注入 digest 和 compaction summary。不是通用聊天记录，也不是向量库。',
                  'Project-context memory and optional compaction layer for DSH: compile the raw span covered by host compaction into a replayable dictionary, then inject project memory into the digest and compaction summary. It is not a chat log or a vector store.',
                )),
                h('div', { style: { opacity: 0.7, marginTop: '4px' } }, L(
                  '当前角色 primary；压缩 provider 由 flow-tower-compaction 接管（继承并委托 BasicCompactionEngine）。',
                  'Current role: primary; the compaction provider is flow-tower-compaction (extends and delegates to BasicCompactionEngine).',
                )),
                h('div', { style: { opacity: 0.6, marginTop: '6px' } }, L('版本 ', 'Version ') + version + ' · ' + L('界面双语；内容保留原文', 'bilingual UI; content stays in source language')),
              )),
            h('h3', { style: { margin: '14px 0 4px' } }, L('上下文处理链路', 'Context pipeline')),
            h('ul', { style: { margin: 0, paddingLeft: '18px', opacity: 0.85, lineHeight: 1.8 } },
              (zh ? [
                '编译入口：订阅 session/event 的 compaction/summary，读取被压缩覆盖的原始消息 seq 区间。',
                '幂等采样：用 compactionId + delta hash 去重；重复 compaction/重放不会重复入库。',
                '确定性抽取：规则先产出候选（decision/task/feature/file/api-symbol/error/command/topic/chapter/person），再按 kind/module/project/time/叙事归档。',
                '证据优先：每条词条保存 session + seq 区间 + 摘录；citation 是事实来源，词条只是索引。',
                '存储位置可选：默认项目内 .flow-tower/flow_tower.db；也可全局 ~/.dsh/flow-tower 或自定义目录；切换时迁移当前项目。',
                '按需注入：小项目用 brief（摘要全貌+进度+改动日志）；大项目自动切 Project map（Goal/Open/模块塔尖+塔高层+完成度+cite+rels+explore/skip），细节用字典/引用回查。',
                '检索：BM25 + 稀疏/同义词扩展 + 关系邻近；DeepSeek smart 只做查询改写/重排，不接 embedding。',
                '压缩：flow-tower-compaction 替换 compaction-basic；token 压力/区间/replay/checkpoint 委托 Basic，summarize 注入项目记忆并写运行记录。',
                '项目策略：current 只启用当前项目；allowlist/denylist 多选；禁用项目回退 DSH 默认上下文。',
                '保留：任务/决定/章节优先；hot/warm/cold 分层淘汰，淘汰前归档。',
              ] : [
                'Ingest: subscribe to session/event compaction/summary and read the raw seq span covered by the compaction.',
                'Idempotent sampling: dedupe by compactionId + delta hash, so replayed compactions never duplicate entries.',
                'Deterministic extraction: rules first produce candidates (decision/task/feature/file/api-symbol/error/command/topic/chapter/person), then bucket by kind/module/project/time/narrative.',
                'Evidence first: every entry keeps session + seq ranges + excerpt; citations are the source of truth and entries are only an index.',
                'Selectable storage: project-local .flow-tower/flow_tower.db by default, global ~/.dsh/flow-tower or a custom directory; switching migrates the current project.',
                'Bounded injection: small projects use brief (summary overview + progress + change log); large projects switch to Project map (Goal/Open/module tower tip+upper+completion+cite+rels+explore/skip), with the dictionary as drill-down.',
                'Retrieval: BM25 + sparse/synonym expansion + relation proximity; DeepSeek smart only rewrites/reranks, no embedding.',
                'Compaction: flow-tower-compaction replaces compaction-basic; pressure/range/replay/checkpoint delegate to Basic, summarize adds project memory and writes a run record.',
                'Project policy: current enables only this project; allowlist/denylist are multi-select; disabled projects use DSH default context.',
                'Retention: tasks/decisions/chapters protected; hot/warm/cold eviction archives before removal.',
              ]).map((text) => h('li', { key: text }, text)),
            ),
            h('h3', { style: { margin: '14px 0 4px' } }, L('当前运行参数', 'Current runtime defaults')),
            h('div', { style: { opacity: 0.8, lineHeight: 1.9, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11.5px' } },
              L(
                `role=${status?.contextRole ?? 'primary'} · project=${status?.projectMode ?? 'current'} · backend=${status?.compactionBackend ?? 'FlowTowerCompactionEngine'}\n` +
                `maxEntries=${status?.maxEntries ?? 6000} · digest=${status?.digestStrategy ?? 'brief'}/${status?.digestBudgetTokens ?? 2000} · summaryMemory=${status?.summaryMemoryChars ?? 1800}c\n` +
                `storage=${status?.storage?.mode ?? 'project'} · ${status?.storage?.dbPath ?? '<project>/.flow-tower/flow_tower.db'}\n` +
                `embedding=off · smart=DeepSeek-only · aliases=${status?.semantic?.entriesWithAliases ?? 0}`,
                `role=${status?.contextRole ?? 'primary'} · project=${status?.projectMode ?? 'current'} · backend=${status?.compactionBackend ?? 'FlowTowerCompactionEngine'}\n` +
                `maxEntries=${status?.maxEntries ?? 6000} · digest=${status?.digestStrategy ?? 'brief'}/${status?.digestBudgetTokens ?? 2000} · summaryMemory=${status?.summaryMemoryChars ?? 1800}c\n` +
                `storage=${status?.storage?.mode ?? 'project'} · ${status?.storage?.dbPath ?? '<project>/.flow-tower/flow_tower.db'}\n` +
                `embedding=off · smart=DeepSeek-only · aliases=${status?.semantic?.entriesWithAliases ?? 0}`,
              )),
            h('h3', { style: { margin: '14px 0 4px' } }, L('已验证 / 未验证', 'Verified / not yet verified')),
            h('ul', { style: { margin: 0, paddingLeft: '18px', opacity: 0.8, lineHeight: 1.8 } },
              (zh ? [
                '已验证：compaction provider 名称为 FlowTowerCompactionEngine；compaction-basic 已 disabled；单测全部通过。',
                '已验证：真实长会话 /compact — 659 项 / 334,883 tokens，summary 27.1s；compile_runs 与 compactionId 精确对齐，entries 2,543→2,896。',
                '已验证：压缩后首步 prompt ~25.5k tokens，压缩前 ~389k tokens；/compact 命令路径（含 busy 并发锁）已实测。',
                '已验证：存储位置 project/global/custom 三种模式；切换时迁移当前项目词典（旧库保留）。',
                '未验证：context overflow、崩溃恢复；summarize 的 memoryChars 需下一次真实 /compact 的运行记录确认。',
                '未验证：Phase 2 自定义 token 策略与 summary 存储；aliases 100 条与 BM25/smart 对比。',
                '限制：Desktop 通过 app.asar 绝对路径加载 Basic；CLI 环境需要 vendored copy 或构建方案。',
              ] : [
                'Verified: provider name is FlowTowerCompactionEngine; compaction-basic is disabled; all tests pass.',
                'Verified: real long-session /compact — 659 items / 334,883 tokens, summary in 27.1s; compile_runs matches the compactionId exactly, entries 2,543→2,896.',
                'Verified: post-compaction first-step prompt ~25.5k tokens vs ~389k before; the command path including the concurrent busy lock was exercised.',
                'Verified: project/global/custom storage modes; switching migrates the current project dictionary (old database kept).',
                'Not verified: context overflow, crash recovery; the summarize memoryChars evidence lands with the next real /compact run log.',
                'Not verified: Phase 2 custom token policy/summary store; 100 aliases and BM25/smart comparison.',
                'Limit: Desktop loads Basic through an absolute app.asar path; a CLI install needs a vendored copy or build path.',
              ]).map((text) => h('li', { key: text }, text)),
            ),
            h('h3', { style: { margin: '14px 0 4px' } }, L('参考与致敬', 'References')),
            h('ul', { style: { margin: 0, paddingLeft: '18px', opacity: 0.82, lineHeight: 1.8 } },
              [
                { text: 'DeepSeek. DeepSeek Harness[EB/OL]. [2026-11-15]. https://www.deepseek.com/en/harness/.', url: 'https://www.deepseek.com/en/harness/' },
                { text: 'DeepSeek-AI. A Programming Paradigm for Spatiotemporal Composability[EB/OL]. arXiv:2608.25512, 2026[2026-11-15].', url: 'https://arxiv.org/abs/2608.25512' },
                { text: 'Pack Light, CarryOn: Building Object-Oriented Context for Long-Horizon Agents[EB/OL]. arXiv:2610.18784, 2026[2026-11-15].', url: 'https://arxiv.org/abs/2610.18784' },
                { text: 'PACKER C, WOODERS S, LIN K, et al. MemGPT: Towards LLMs as Operating Systems[EB/OL]. arXiv:2310.08560, 2023[2026-11-15].', url: 'https://arxiv.org/abs/2310.08560' },
                { text: 'SARTHI P, ABDULLAH S, TULI A, et al. RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval[EB/OL]. arXiv:2401.18059, 2024[2026-11-15].', url: 'https://arxiv.org/abs/2401.18059' },
                { text: 'EDGE D, TRINH H, CHENG N, et al. From Local to Global: A Graph RAG Approach to Query-Focused Summarization[EB/OL]. arXiv:2404.16130, 2024[2026-11-15].', url: 'https://arxiv.org/abs/2404.16130' },
                { text: 'MemTree: Dynamic Tree Memory for LLM Agents[EB/OL]. arXiv:2410.14052, 2024[2026-11-15].', url: 'https://arxiv.org/abs/2410.14052' },
                { text: 'MemWalker: Interactive Reading with Memory Trees[EB/OL]. arXiv:2310.05029, 2023[2026-11-15].', url: 'https://arxiv.org/abs/2310.05029' },
                { text: 'ReadAgent: Gist-based Reading for Long Documents[EB/OL]. arXiv:2402.09727, 2024[2026-11-15].', url: 'https://arxiv.org/abs/2402.09727' },
                { text: 'RASMUSSEN P, et al. Zep: A Temporal Knowledge Graph Architecture for Agent Memory[EB/OL]. arXiv:2501.13956, 2025[2026-11-15].', url: 'https://arxiv.org/abs/2501.13956' },
                { text: 'CHHIKARA P, et al. Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory[EB/OL]. arXiv:2504.19413, 2025[2026-11-15].', url: 'https://arxiv.org/abs/2504.19413' },
                { text: 'DeepSeek-AI. dsh-superagent-prototype[EB/OL]. https://github.com/deepseek-ai/dsh-superagent-prototype.', url: 'https://github.com/deepseek-ai/dsh-superagent-prototype' },
                { text: 'bgx666. dsh-memory-tree[EB/OL]. https://github.com/bgx666/dsh-memory-tree.', url: 'https://github.com/bgx666/dsh-memory-tree' },
              ].map((item) => h('li', { key: item.url ?? item.text },
                item.url
                  ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', style: { color: '#6ea8fe' } }, item.text)
                  : item.text,
              )),
            ),
            h('div', { style: { marginTop: '6px', opacity: 0.55, fontSize: '11px' } },
              L('仅作设计参考，非代码依赖；正文引用可点击核验。', 'Design references only, not code dependencies; citations are clickable.'),
            ),
            h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #2b3240', opacity: 0.85 } },
              L('开发：', 'Built by: ') + '广州天权智能科技有限公司',
              h('br'),
              h('a', { href: 'https://www.tianquanzhineng.com', target: '_blank', rel: 'noopener noreferrer', style: { color: '#6ea8fe' } }, 'www.tianquanzhineng.com'),
            ),
          );
        }
        if (tab === 'settings') {
          if (!settings) return error ? h('div', { style: { padding: '16px', color: '#f5a97f' } }, error) : h('div', { style: { padding: '16px' } }, L('加载中…', 'loading…'));
          return h('div', { style: { padding: '14px', overflow: 'auto' } },
            h('h3', { style: { margin: '0 0 6px', fontSize: '14px' } }, L('Context Flow Tower 设置', 'Context Flow Tower settings')),
            h('div', { style: { opacity: 0.65, marginBottom: '8px' } }, L('保存后多数设置即时生效；LLM/资源档建议重载插件。', 'Most settings apply immediately; LLM/resource profile may need a plugin reload.')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
              (settings.editable ?? []).filter((key) => key !== 'uiLocale' && key !== 'projectMode' && key !== 'projectAllowlist' && key !== 'projectDenylist' && key !== 'storageMode' && key !== 'storagePath').map((key) => h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '180px' } },
                h('span', { style: { opacity: 0.7 } }, (fieldLabels?.[key] ?? key)),
                key === 'resourceProfile' || key === 'digestMode' || key === 'digestStrategy' || key === 'relationsMode' || key === 'llmCompiler' || key === 'proposalMode' || key === 'contextRole' || key === 'projectMode'
                  ? h('select', {
                    value: String(settingsDraft[key] ?? ''),
                    onChange: (event) => setSettingsDraft((current) => ({ ...current, [key]: event.target.value })),
                    style: inputStyle,
                  }, (key === 'resourceProfile' ? ['auto', 'off'] : key === 'digestMode' ? ['on-change', 'off'] : key === 'digestStrategy' ? ['brief', 'focus', 'balanced', 'full'] : key === 'contextRole' ? ['primary', 'companion'] : key === 'projectMode' ? ['all', 'allowlist', 'denylist'] : ['off', 'shadow', 'on']).map((option) => h('option', { key: option, value: option }, option)))
                  : h('input', {
                    value: settingsDraft[key] ?? '',
                    onChange: (event) => setSettingsDraft((current) => ({ ...current, [key]: event.target.value })),
                    style: inputStyle,
                  }),
              ))),
            h('h4', { style: { margin: '14px 0 6px', fontSize: '13px' } }, L('存储位置', 'Storage location')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '180px' } },
                h('span', { style: { opacity: 0.7 } }, fieldLabels?.storageMode ?? 'storageMode'),
                h('select', {
                  value: String(settingsDraft.storageMode ?? settings.effective?.storageMode ?? 'project'),
                  onChange: (event) => setSettingsDraft((current) => ({ ...current, storageMode: event.target.value })),
                  style: inputStyle,
                },
                h('option', { value: 'project' }, L('项目内（默认）', 'inside the project (default)')),
                h('option', { value: 'global' }, L('全局 ~/.dsh/flow-tower', 'global ~/.dsh/flow-tower')),
                h('option', { value: 'custom' }, L('自定义目录', 'custom directory')),
                ),
              ),
              (settingsDraft.storageMode ?? settings.effective?.storageMode ?? 'project') === 'custom'
                ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 320px' } },
                    h('span', { style: { opacity: 0.7 } }, fieldLabels?.storagePath ?? 'storagePath'),
                    h('input', {
                      value: settingsDraft.storagePath ?? '',
                      placeholder: 'D:\\flow-tower-memory  /  ~/flow-tower-memory',
                      onChange: (event) => setSettingsDraft((current) => ({ ...current, storagePath: event.target.value })),
                      style: inputStyle,
                    }),
                  )
                : null,
            ),
            h('div', { style: { marginTop: '6px', opacity: 0.68, wordBreak: 'break-all' } },
              L('当前数据库：', 'Current database: '),
              (settings.storage?.dbPath ?? '…'),
              settings.storage?.exists ? L('（已存在）', ' (exists)') : L('（首次写入时创建）', ' (created on first write)'),
            ),
            h('div', { style: { marginTop: '3px', opacity: 0.55 } },
              L('默认保存在当前项目 .flow-tower/flow_tower.db；切换位置时会自动迁移当前项目的词典（旧库保留）。压缩运行记录随数据库目录一起迁移。',
                'Default: .flow-tower/flow_tower.db inside the current project. Switching locations migrates the current project dictionary automatically (old database kept); the compaction run log moves with it.'),
            ),
            h('div', { style: { marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px' } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '180px' } },
                h('span', { style: { opacity: 0.7 } }, fieldLabels?.projectMode ?? 'projectMode'),
                h('select', {
                  value: String(settingsDraft.projectMode ?? settings.effective?.projectMode ?? 'all'),
                  onChange: (event) => setSettingsDraft((current) => ({ ...current, projectMode: event.target.value })),
                  style: inputStyle,
                },
                h('option', { value: 'current' }, L('仅当前项目', 'current project only')),
                h('option', { value: 'all' }, L('所有项目都用', 'all projects')),
                h('option', { value: 'allowlist' }, L('仅白名单项目', 'allowlist only')),
                h('option', { value: 'denylist' }, L('除黑名单项目外', 'denylist except')),
                ),
              ),
            ),
            h('div', { style: { marginTop: '6px', opacity: 0.65 } }, L('未启用的项目自动使用 DSH 默认上下文。', 'Projects not enabled fall back to DSH default context.')),
            (() => {
              const mode = settingsDraft.projectMode ?? settings.effective?.projectMode ?? 'current';
              const listKey = mode === 'allowlist' ? 'projectAllowlist' : 'projectDenylist';
              const selected = Array.isArray(settingsDraft[listKey]) ? settingsDraft[listKey] : [];
              const effectiveSelected = selected.length === 0 && projectsInfo?.current ? [projectsInfo.current] : selected;
              const paths = [...new Set([...(projectsInfo?.projects ?? []).map((item) => item.path), ...(catalog?.projects ?? []).map((item) => item.project), project].filter(Boolean))];
              return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' } },
                mode === 'current' ? h('span', { style: { opacity: 0.65 } }, L('当前模式只启用这个 DSH 会话所在的项目；其他项目回退 DSH 默认。', 'Current mode enables only this DSH session project; others fall back to DSH default.')) : null,
                paths.length === 0 ? h('span', { style: { opacity: 0.6 } }, L('暂无可选项目（先打开项目产生词典）', 'No projects yet (open a project to create a dictionary)')) : null,
                paths.map((path) => h('label', {
                  key: path,
                  style: { display: 'flex', gap: '4px', alignItems: 'center', border: '1px solid #2b3240', borderRadius: '6px', padding: '3px 7px', opacity: mode === 'current' || mode === 'all' ? 0.45 : 1 },
                  title: path,
                },
                h('input', {
                  type: 'checkbox',
                  disabled: mode === 'current' || mode === 'all',
                  checked: effectiveSelected.some((item) => String(item).toLowerCase() === path.toLowerCase()),
                  onChange: (event) => setSettingsDraft((current) => {
                    const key = mode === 'allowlist' ? 'projectAllowlist' : 'projectDenylist';
                    const existing = Array.isArray(current[key]) ? current[key] : [];
                    const next = event.target.checked
                      ? [...new Set([...existing, path])]
                      : existing.filter((item) => String(item).toLowerCase() !== path.toLowerCase());
                    return { ...current, [key]: next };
                  }),
                }),
                h('span', { style: { maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, path.split(/[\\/]/).pop() || path),
                )),
              );
            })(),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
              h('button', { style: buttonStyle, onClick: saveSettings }, L('保存', 'Save')),
              h('button', {
                style: buttonStyle,
                onClick: async () => {
                  try {
                    const payload = await api('export', { ...(project ? { project } : {}) });
                    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'flow-tower-export.json'; link.click();
                    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                  } catch (err) { setError(String(err.message ?? err)); }
                },
              }, L('导出 JSON', 'Export JSON')),
            ),
            h('pre', { style: { marginTop: '10px', opacity: 0.6, whiteSpace: 'pre-wrap' } },
              `embedding=${status?.semantic?.embeddingConfigured ? 'configured' : 'off'} · vectors=${status?.semantic?.vectorCount ?? 0} · aliases=${status?.semantic?.entriesWithAliases ?? 0} · llmCompiler=${status?.semantic?.llmCompiler ?? 'off'}\n` +
              `storage=${status?.storage?.mode ?? '?'} · ${status?.storage?.dbPath ?? '?'} · exists=${status?.storage?.exists ? 'yes' : 'no'}\n` +
              `backend=${status?.compactionBackend ?? '?'} · threshold=${status?.compactionPolicy?.thresholdRatio ?? '?'} · retain=${status?.compactionPolicy?.retainRatio ?? '?'} · headroom=${status?.compactionPolicy?.headroomTokens ?? '?'}\n` +
              `lastSummarize=${status?.lastSummarize === null || status?.lastSummarize === undefined ? 'none' : `${status.lastSummarize.ok ? 'ok' : 'error'} · memoryChars=${status.lastSummarize.memoryChars ?? '?'} · ${status.lastSummarize.ms ?? '?'}ms`}\n` +
              `memoryGuard=${status?.memoryGuard?.enabled === false ? 'off' : status?.memoryGuard?.pressured ? 'PRESSURED' : 'ok'} · rss=${Math.round((status?.memoryGuard?.rssBytes ?? 0) / 1024 / 1024)}MB/${Math.round((status?.memoryGuard?.maxRssBytes ?? 0) / 1024 / 1024)}MB · deferred=${status?.deferredSeqs ?? 0}`),
          );
        }
        if (tab === 'tasks') {
          if (!tasks) return h('div', { style: { padding: '16px' } }, L('加载中…', 'loading…'));
          return h('div', { style: { padding: '14px', overflow: 'auto' } },
            tasks.focus ? h('div', { style: { border: '1px solid #3d5a86', borderRadius: '8px', padding: '10px', marginBottom: '10px' } },
              h('b', null, L('当前焦点：', 'Current focus: ') + tasks.focus.headword),
              h('div', { style: { opacity: 0.65, marginTop: '3px' } }, (tasks.focus.module || '—') + ' · ' + (zh ? tasks.focus.contextCount + ' 条上下文' : tasks.focus.contextCount + ' context entries')),
            ) : null,
            (tasks.tasks ?? []).map((task) => h('div', { key: task.entryId, style: { border: '1px solid #2b3240', borderRadius: '8px', padding: '8px', marginBottom: '6px', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('span', { style: { flex: 1 } }, task.headword + ' [' + (zh ? (task.status === 'open' ? '进行中' : task.status === 'done' ? '已完成' : task.status) : task.status) + ']' + (task.module ? ' · ' + task.module : '') + (zh ? ' · 上下文 ' + task.contextCount + ' 条' : ' · ' + task.contextCount + ' context')),
              h('button', { style: buttonStyle, onClick: () => closeTask(task) }, L('关闭', 'Close')),
            )),
          );
        }
        if (tab === 'graph') {
          const nodes = graph?.nodes ?? [];
          const edges = graph?.edges ?? [];
          return h('div', { style: { padding: '14px', overflow: 'auto' } },
            h('div', { style: { opacity: 0.75, marginBottom: '8px' } }, `${nodes.length} nodes · ${edges.length} edges`),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              nodes.slice(0, 120).map((node) => h('span', { key: node.id, style: { border: '1px solid #2b3240', borderRadius: '6px', padding: '3px 7px', opacity: 0.85 } }, node.label ?? node.id)),
            ),
            h('div', { style: { opacity: 0.6, marginTop: '10px' } }, L('完整交互式关系图请打开网页版导出。', 'Open the web export for the full interactive graph.')),
          );
        }
        return h('pre', { style: { margin: 0, padding: '14px', overflow: 'auto', whiteSpace: 'pre-wrap', flex: 1 } }, bodyText || L('暂无内容', 'No content yet.'));
      };

      const launcher = h('button', {
        ref: launcherRef,
        type: 'button',
        title: 'Context Flow Tower · ' + (status?.entries ?? 0) + ' entries',
        onClick,
        onDoubleClick: () => openPanel('settings'),
        onPointerDown: (event) => beginDrag(event, 'launcher'),
        onPointerMove: onDragMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        style: {
          position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px`, zIndex: 2147482000,
          display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
          borderRadius: '10px', border: '1px solid rgba(110,168,254,.6)',
          background: 'rgba(23,26,33,.94)', color: '#d7dbe2', cursor: 'grab',
          font: '12px/18px system-ui,sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
          touchAction: 'none', pointerEvents: 'auto', userSelect: 'none',
        },
      },
      h('span', { 'aria-hidden': true, style: { fontSize: '14px' } }, '▦'),
      h('span', { style: { display: 'flex', flexDirection: 'column', lineHeight: '14px' } },
        h('span', { style: { fontWeight: 600 } }, 'Context Flow Tower'),
        h('span', { style: { fontSize: '10px', opacity: 0.7 } }, `${status?.entries ?? 0} ${zh ? '条记忆' : 'entries'} · v${version}`),
      ));

      const guide = (!guideSeen && !panel.open) ? h('div', {
        style: {
          position: 'fixed', left: `${Math.max(12, Math.min(pos.x - 268, window.innerWidth - 292))}px`,
          top: `${Math.max(12, pos.y - 154)}px`, zIndex: 2147482000, width: '272px',
          display: 'flex', gap: '8px', padding: '10px', background: 'rgba(23,26,33,.97)',
          border: '1px solid rgba(110,168,254,.55)', borderRadius: '12px', color: '#d7dbe2',
          boxShadow: '0 12px 36px rgba(0,0,0,.4)', pointerEvents: 'auto',
        },
      },
      h('img', { src: '/flow-tower/assets/ok.jpg', alt: '', style: { width: '56px', height: '56px', borderRadius: '10px', objectFit: 'cover' } }),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('b', null, L('大肥鱼：点我打开上下文词典', 'Dafeiyu: tap to open your context memory')),
        h('span', { style: { opacity: 0.7 } }, L('拖动可移动；双击设置。', 'Drag to move; double-click for settings.')),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { style: buttonStyle, onClick: () => openPanel('browse') }, L('打开', 'Open')),
          h('button', { style: buttonStyle, onClick: () => { setGuideSeen(true); try { window.localStorage.setItem('flow-tower.guideSeen', '1'); } catch (_) {} } }, L('稍后', 'Later')),
        ),
      )) : null;

      const minimizedNode = panel.open && panel.minimized ? h('button', {
        type: 'button',
        title: L('还原面板', 'Restore panel'),
        onClick: () => setPanel((current) => { const next = { ...current, minimized: false }; saveJson(PANEL_KEY, next); return next; }),
        style: {
          position: 'fixed', left: `${panel.x}px`, top: `${panel.y}px`, zIndex: 2147482001,
          display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '7px 12px',
          borderRadius: '10px', border: '1px solid rgba(110,168,254,.45)',
          background: 'rgba(23,26,33,.96)', color: '#d7dbe2', cursor: 'pointer',
          font: '12px/18px system-ui,sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        },
      }, '▦ Context Flow Tower · ', L('还原', 'Restore')) : null;

      const panelNode = panel.open && !panel.minimized ? h('div', { style: panelStyle },
        h('div', {
          onPointerDown: (event) => { if (event.target?.closest?.('button')) return; beginDrag(event, 'panel'); },
          onPointerMove: onDragMove, onPointerUp: endDrag, onPointerCancel: endDrag,
          style: headerStyle,
        },
        h('span', { style: { fontWeight: 600 } }, 'Context Flow Tower ', h('span', { style: { opacity: 0.55, fontWeight: 400 } }, 'v' + version)),
        h('span', { style: { flex: 1 } }),
        h('button', { style: buttonStyle, title: L('刷新数据', 'Refresh data'), onClick: refreshData }, '↻'),
        h('button', { style: buttonStyle, title: L('重载界面', 'Reload UI'), onClick: reloadUi }, '⟳'),
        h('div', { style: { display: 'flex', border: '1px solid #394154', borderRadius: '6px', overflow: 'hidden' } },
          h('button', { type: 'button', onClick: () => switchLocale('zh'), style: { ...buttonStyle, border: 0, borderRadius: 0, background: zh ? '#2b4a72' : 'transparent', color: zh ? '#cfe3ff' : '#8f98a8' } }, '中文'),
          h('button', { type: 'button', onClick: () => switchLocale('en'), style: { ...buttonStyle, border: 0, borderRadius: 0, background: !zh ? '#2b4a72' : 'transparent', color: !zh ? '#cfe3ff' : '#8f98a8' } }, 'English'),
        ),
        h('button', { style: buttonStyle, title: L('最小化', 'Minimize'), onClick: () => setPanel((current) => { const next = { ...current, minimized: !current.minimized }; saveJson(PANEL_KEY, next); return next; }) }, panel.minimized ? L('还原', 'Expand') : '—'),
        h('button', { style: buttonStyle, title: L('关闭', 'Close'), onClick: closePanel }, '×'),
        ),
        panel.minimized ? null : h('div', { style: { display: 'flex', gap: '4px', padding: '6px 8px', borderBottom: '1px solid #2b3240', flexWrap: 'wrap' } },
          tabs.map(([key, label]) => h('button', {
            key, style: { ...buttonStyle, background: tab === key ? '#25314a' : 'transparent', color: tab === key ? '#9ecbff' : '#cfd6e4' },
            onClick: () => setTab(key),
          }, label)),
        ),
        panel.minimized ? null : h('div', { style: { display: 'flex', gap: '6px', padding: '8px', borderBottom: '1px solid #2b3240', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { value: searchQ, onChange: (event) => setSearchQ(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') doSearch(); }, placeholder: L('搜索词条', 'Search headwords'), style: { ...inputStyle, flex: 1, minWidth: '160px' } }),
          h('select', { value: scope, onChange: (event) => setScope(event.target.value), style: inputStyle, title: L('搜索范围', 'Search scope') },
            h('option', { value: 'entries' }, L('词条', 'entries')),
            h('option', { value: 'summaries' }, L('摘要', 'summaries')),
            h('option', { value: 'both' }, L('两者', 'both')),
          ),
          h('label', { title: L('稀疏语义', 'sparse semantic'), style: { display: 'flex', gap: '3px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: semantic, onChange: (event) => setSemantic(event.target.checked) }), L('语义', 'semantic')),
          h('label', { title: L('DeepSeek 改写+重排，不接 embedding 模型', 'DeepSeek rewrite + rerank, no embedding model'), style: { display: 'flex', gap: '3px', alignItems: 'center' } }, h('input', { type: 'checkbox', checked: smart, onChange: (event) => setSmart(event.target.checked) }), L('智能', 'smart')),
          h('button', { style: buttonStyle, onClick: doSearch }, L('搜索', 'Search')),
        ),
        panel.minimized ? null : h('div', { style: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' } },
          error ? h('div', { style: { color: '#f5a97f', padding: '10px' } }, error) : null,
          searchData ? h('div', { style: { padding: '10px' } },
            (searchData.smart?.expandedQueries?.length ?? 0) > 0 ? h('div', { style: { opacity: 0.6, marginBottom: '6px' } }, L('DeepSeek 改写：', 'DeepSeek rewrote: ') + searchData.smart.expandedQueries.slice(0, 6).join(' | ')) : null,
            (searchData.results ?? []).map((hit) => h('div', {
              key: hit.entryId,
              style: { border: '1px solid #2b3240', borderRadius: '8px', padding: '8px', marginBottom: '6px', cursor: 'pointer' },
              onClick: () => openLookup(hit.headword),
            },
            h('b', null, hit.headword), h('span', { style: { opacity: 0.55, marginLeft: '6px' } }, '[' + hit.kind + '] score ' + hit.score),
            h('div', { style: { opacity: 0.7, marginTop: '2px' } }, hit.gloss ?? ''),
            )),
            lookupData ? h('div', { style: { marginTop: '10px', borderTop: '1px solid #2b3240', paddingTop: '8px' } },
              h('pre', { style: { whiteSpace: 'pre-wrap', opacity: 0.9 } }, lookupData.text ?? ''),
              (lookupData.citations ?? []).map((citation) => h('button', { key: citation.citeId, style: buttonStyle, onClick: () => replayCitation(citation.citeId) }, '▶ ' + citation.citeId)),
              citeText ? h('pre', { style: { whiteSpace: 'pre-wrap', marginTop: '6px', opacity: 0.85 } }, citeText) : null,
            ) : null,
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
              h('button', { style: buttonStyle, onClick: () => { setSearchData(null); setLookupData(null); setCiteText(''); } }, L('清空结果', 'Clear results')),
            ),
          ) : renderBody(),
        ),
      ) : null;

      return h(OverlayBoundary, null, h(React.Fragment, null, panel.open ? null : launcher, guide, minimizedNode, panelNode));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'flow-tower',
          order: 70,
        }, FlowTowerLauncher));
      },
    };
  },
});
