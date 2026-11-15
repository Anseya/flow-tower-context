/**
 * --- module contract ---
 * purpose: Reject process-noise proposals while keeping durable extraction candidates.
 * dependsOn: [generated] (none)
 * externalDeps: [generated] (none)
 * usedBy: [generated] eval/shadow-report.mjs, lib/llm.js, test/flow-tower.test.js
 * publicApi: [generated] filterMetaProposals, isMetaProposal
 * risk: Low: heuristic filter; conservative behavior is intentional.
 * --- end module contract ---
 */

const META_PATTERNS = [
  /updated successfully/i,
  /was (updated|created|deleted|modified) successfully/i,
  /file .{0,80}(was|is) (updated|created|deleted|modified)/i,
  /test (passed|failed|result|succeeded)/i,
  /tests? (pass|fail)/i,
  /command (succeeded|failed|returned|ran)/i,
  /tool .{0,40}(was )?called/i,
  /was called with/i,
  /patch (applied|succeeded)/i,
  /(installed|linked|merged) successfully/i,
  /successfully (installed|linked|updated|created|deleted|applied)/i,
  /pnpm (output|exit|install|link)/i,
  /npm (install|output)/i,
  /bundle .{0,40}applied/i,
  /更新成功|创建成功|删除成功|安装成功|链接成功|应用成功/,
  /已(更新|创建|删除|调用|执行|安装|链接|应用)/,
  /测试(通过|失败|结果)/,
  /命令(已)?执行/,
  /补丁(已)?应用/,
  /工具.{0,20}调用/,
]

/**
 * @param {{ kind?: string, headword?: string, gloss?: string }} entry
 * @returns {boolean}
 */
export function isMetaProposal(entry) {
  const text = `${entry?.headword ?? ''} ${entry?.gloss ?? ''}`
  if (text.trim().length === 0) return false
  return META_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * @param {readonly any[]} entries
 * @returns {{ kept: any[], filtered: any[] }}
 */
export function filterMetaProposals(entries) {
  const kept = []
  const filtered = []
  for (const entry of entries) {
    if (isMetaProposal(entry)) filtered.push(entry)
    else kept.push(entry)
  }
  return { kept, filtered }
}
