/**
 * --- module contract ---
 * purpose: CSS for the read-only Flow Tower panel page.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] lib/web-page.js
 * publicApi: [generated] STYLE
 * risk: Low: presentation-only string; no logic or data access.
 * --- end module contract ---
 */

/** Panel CSS, injected into the page <style> block. */
export const STYLE = `
:root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#d7dbe2; --dim:#8b93a3; --acc:#6ea8fe; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 "Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  h1 span { color:var(--dim); font-weight:400; font-size:12px; margin-left:8px; }
  main { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 60px); }
  aside { border-right:1px solid var(--line); padding:12px; overflow:auto; }
  section { padding:12px 18px; overflow:auto; }
  input, select, button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
  button { cursor:pointer; } button:hover { border-color:var(--acc); }
  .row { display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
  .vol { padding:6px 8px; border-radius:6px; cursor:pointer; color:var(--dim); }
  .vol:hover, .vol.active { background:var(--panel); color:var(--fg); }
  .tabs { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
  .tabs button.active { border-color:var(--acc); color:var(--acc); }
  pre { white-space:pre-wrap; word-break:break-word; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; margin:0; }
  .detail pre { margin-top:8px; }
  .muted { color:var(--dim); font-size:12px; }
  .hit { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; background:var(--panel); cursor:pointer; }
  .hit:hover, .hit:focus { border-color:var(--acc); outline:none; }
  .hit b { color:var(--acc); font-size:14px; }
  .hit .k { color:var(--dim); font-size:12px; margin-left:6px; }
  .hit .score { float:right; color:var(--dim); font-size:11px; }
  .hit .gloss { margin:4px 0 6px; color:var(--fg); opacity:.9; }
  .hit .module { color:var(--dim); font-size:11px; margin-right:8px; }
  .hit .badges { display:flex; gap:4px; flex-wrap:wrap; }
  .badge { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:1px 7px; }
  .badge.reason { color:var(--acc); border-color:rgba(110,168,254,.45); }
  .searchMeta { display:flex; align-items:center; gap:10px; margin:4px 0 10px; color:var(--dim); font-size:12px; flex-wrap:wrap; }
  .searchMeta button { padding:3px 8px; font-size:12px; }
  .searchEmpty { color:var(--dim); padding:18px; text-align:center; }
  .tag { font-size:12px; color:var(--dim); }
  @media (max-width: 760px) {
    header { padding:10px 12px; gap:8px; }
    header h1 { width:100%; }
    #q { min-width:0; flex:1; }
    main { grid-template-columns:1fr; }
    aside { border-right:0; border-bottom:1px solid var(--line); max-height:34vh; }
    .tabs { gap:4px; }
    .tabs button { padding:4px 7px; }
    section { padding:10px 12px; }
  }
`
