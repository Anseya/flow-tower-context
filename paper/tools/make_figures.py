# -*- coding: utf-8 -*-
"""Generate the paper figures: five 2D SVGs and one 3D SVG (matplotlib).

Every figure is written twice: `figures/figN_name.svg` (vector source) and
`figures/figN_name.png` (300 dpi raster embedded into the DOCX).
"""
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "paper", "figures")
os.makedirs(OUT, exist_ok=True)

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "SimSun"]
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["font.size"] = 9

INK = "#1f2937"
BLUE = "#1f4e79"
BLUE_L = "#dce9f5"
TEAL = "#1f6f6b"
TEAL_L = "#d9efec"
AMBER = "#a8641b"
AMBER_L = "#f7ecd7"
PURPLE = "#5b3f8c"
PURPLE_L = "#e9e1f4"
GREY = "#6b7280"
GREY_L = "#f2f3f5"
RED = "#a63d3d"
RED_L = "#f6dede"


def save(fig, name, pad=0.05):
    fig.savefig(os.path.join(OUT, f"{name}.svg"), bbox_inches="tight", pad_inches=pad)
    fig.savefig(os.path.join(OUT, f"{name}.png"), dpi=300, bbox_inches="tight", pad_inches=pad)
    plt.close(fig)
    print("wrote", name)


def panel(ax, x, y, w, h, title, face, edge, title_color=None, ls="-", lw=1.1):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.4",
        linewidth=lw, edgecolor=edge, facecolor=face, linestyle=ls, zorder=1))
    ax.text(x + 1.2, y + h - 1.9, title, fontsize=9.5, color=title_color or edge,
            fontweight="bold", va="top", ha="left", zorder=5)


def box(ax, x, y, w, h, text, face="white", edge=GREY, fontsize=7.8, color=INK,
        weight="normal", zorder=3, ls="-"):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.45,rounding_size=1.0",
        linewidth=0.9, edgecolor=edge, facecolor=face, linestyle=ls, zorder=zorder))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fontsize,
            color=color, fontweight=weight, zorder=zorder + 1, linespacing=1.35)


def arrow(ax, xy1, xy2, text="", color=BLUE, style="-|>", lw=1.2, ls="-",
          rad=0.0, fontsize=7.2, toff=(0, 0), ha="center", va="center", bbox_face="white"):
    ax.add_patch(FancyArrowPatch(
        xy1, xy2, arrowstyle=style, mutation_scale=11, linewidth=lw, color=color,
        linestyle=ls, connectionstyle=f"arc3,rad={rad}", zorder=4,
        shrinkA=2, shrinkB=2))
    if text:
        mx, my = (xy1[0] + xy2[0]) / 2 + toff[0], (xy1[1] + xy2[1]) / 2 + toff[1]
        ax.text(mx, my, text, fontsize=fontsize, color=color, ha=ha, va=va, zorder=6,
                bbox=dict(boxstyle="round,pad=0.18", fc=bbox_face, ec="none", alpha=0.92))


# --------------------------------------------------------------------------- fig1
def fig_architecture():
    fig, ax = plt.subplots(figsize=(7.6, 6.35))
    ax.set_xlim(0, 104)
    ax.set_ylim(26, 114)
    ax.axis("off")

    panel(ax, 2, 86, 54, 24, "DSH 宿主平面（Host）", GREY_L, GREY)
    panel(ax, 60, 86, 42, 24, "会话 Preset（isolate 组）", AMBER_L, AMBER)
    panel(ax, 2, 54, 100, 26, "Flow Tower 插件平面", BLUE_L, BLUE)

    box(ax, 4, 95.5, 24, 6.8,
        "会话事件总线\ncompaction/summary 等", edge=GREY, fontsize=6.4)
    box(ax, 30, 95.5, 24, 6.8, "tokenMeter\n压力 tokens / window", edge=GREY, fontsize=6.4)
    box(ax, 4, 88, 24, 6.2, "systemPrompt 段\nlegend 检索协议", edge=GREY, fontsize=6.4)
    box(ax, 30, 88, 24, 6.2, "webServer\n/flow-tower/api/*", edge=GREY, fontsize=6.4)

    box(ax, 62, 95, 38, 9.2,
        "compaction 服务：FlowTowerCompactionEngine\n（extends BasicCompactionEngine）\n"
        "+ command-compact · tool-result-pruner",
        edge=AMBER, fontsize=6.3, weight="bold")
    ax.text(62, 89.2, "注意：隔离边界——宿主平面补丁不进入此组（§5.1 根因）",
            fontsize=6.6, color=RED, ha="left", va="center")

    box(ax, 4, 59.5, 23, 14.5,
        "事件观察 + 版本游标\ncompaction/summary\n→ 增量 / 去重", edge=BLUE, fontsize=6.8)
    box(ax, 28, 59.5, 23, 14.5,
        "确定性编译器\n词条 · 关系 · seq 引文\n摘要树 / 检索索引", edge=BLUE, fontsize=6.8)
    box(ax, 52, 59.5, 23, 14.5,
        "注入器\n4 模式策略决策\n+ digest 生成", edge=BLUE, fontsize=6.8)
    box(ax, 76, 59.5, 23, 14.5,
        "工具与面板\n6 × dict_* · HTTP API\n只读 Web UI", edge=BLUE, fontsize=6.8)

    ax.add_patch(FancyBboxPatch((2, 28), 48, 22, boxstyle="round,pad=0.7,rounding_size=1.6",
                                linewidth=1.1, edgecolor=TEAL, facecolor=TEAL_L, zorder=2))
    ax.text(4, 47.6, "项目本地库  .flow-tower/flow_tower.db", fontsize=7.8, color=TEAL,
            fontweight="bold", ha="left", va="center", zorder=3)
    ax.text(4, 43.4, "SQLite + WAL + 项目写锁（单写者）", fontsize=6.6, color=INK, ha="left", va="center", zorder=3)
    ax.text(4, 39.2, "entries · relations · citations", fontsize=6.6, color=INK, ha="left", va="center", zorder=3)
    ax.text(4, 35.0, "summary_nodes · groups · metrics", fontsize=6.6, color=INK, ha="left", va="center", zorder=3)
    ax.text(4, 30.8, "压缩时供 summarize() 读取 ≤1800 字符", fontsize=6.3, color=AMBER, ha="left", va="center", zorder=3)

    ax.add_patch(FancyBboxPatch((52, 28), 50, 22, boxstyle="round,pad=0.7,rounding_size=1.6",
                                linewidth=1.1, edgecolor=PURPLE, facecolor=PURPLE_L, zorder=2))
    ax.text(54, 47.6, "Agent 上下文（注入目标）", fontsize=7.8, color=PURPLE,
            fontweight="bold", ha="left", va="center", zorder=3)
    box(ax, 54, 31.5, 23, 12, "短程（权威）\n<compacted-summary>\n8 节 checkpoint",
        edge=PURPLE, fontsize=6.5)
    box(ax, 79, 31.5, 21, 12, "长程（定向）\n[flow-tower] digest / map\n≤900 token/次",
        edge=PURPLE, fontsize=6.5)

    arrow(ax, (15, 86), (15, 80.4), "", color=GREY, lw=1.3)
    arrow(ax, (42, 86), (42, 80.4), "", color=GREY, lw=1.3)
    arrow(ax, (81, 86), (81, 80.4), "", color=AMBER, lw=1.3)
    ax.text(16.3, 83.1, "事件 / 压力 / 系统提示段", fontsize=6.2, color=GREY, ha="left", va="center")
    ax.text(82.3, 83.1, "压缩结果", fontsize=6.2, color=AMBER, ha="left", va="center")

    arrow(ax, (39.5, 59.5), (39.5, 50.5), "编译写入（毫秒级、零 LLM）", color=TEAL, fontsize=6.3, toff=(22, 0))
    arrow(ax, (63.5, 59.5), (63.5, 50.5), "注入（版本变化时）", color=PURPLE, fontsize=6.3, toff=(17, 0))

    ax.plot([58.5, 58.5], [86.4, 109.6], color=RED, lw=0.9, ls=(0, (4, 3)), zorder=2)
    ax.text(36, 112.6, "隔离边界：宿主平面补丁 ≠ 会话 isolate 组",
            ha="center", va="center", fontsize=7.0, color=RED, style="italic")
    save(fig, "fig1_architecture")


# --------------------------------------------------------------------------- fig2
def fig_sequence():
    fig, ax = plt.subplots(figsize=(7.6, 4.6))
    ax.set_xlim(0, 108)
    ax.set_ylim(0, 96)
    ax.axis("off")

    lifes = [
        (10, "会话 Agent\n（turn / step）", BLUE),
        (34, "DSH 压缩服务\n（compaction）", AMBER),
        (57, "Flow Tower\n插件", PURPLE),
        (78, "项目库\n（SQLite）", TEAL),
        (98, "模型上下文", INK),
    ]
    for x, name, color in lifes:
        ax.add_patch(FancyBboxPatch((x - 8.6, 86.5), 17.2, 8, boxstyle="round,pad=0.4,rounding_size=1.1",
                                    facecolor="white", edgecolor=color, lw=1.0, zorder=3))
        ax.text(x, 90.5, name, ha="center", va="center", fontsize=7.3, color=color,
                fontweight="bold", zorder=4, linespacing=1.25)
        ax.plot([x, x], [10.5, 86], color=color, lw=0.8, ls=(0, (2, 2.4)), alpha=0.55, zorder=1)

    rows = [
        (80.0, 10, 57, "step=1：pre-step", BLUE, 0),
        (72.5, 57, 98, "注入 digest（665–829 t）或按策略跳过", PURPLE, 0),
        (66.0, 10, 98, "LLM 推理 + 工具调用（产生新消息）", INK, 0),
        (58.5, 10, 34, "压力达阈值：compaction/start", AMBER, 0),
        (51.5, 57, 78, "loadProjectMemory(≤1800c)", AMBER, 0),
        (44.5, 34, 98, "summarize：8 节 checkpoint（33.7 s / 9,998 字符）", AMBER, 0),
        (37.0, 34, 57, "compaction/summary 事件", AMBER, 0),
        (30.0, 57, 78, "确定性编译：Δ词条 / 关系 / 引文 / 摘要树", TEAL, 0),
        (23.0, 34, 98, "替换历史：<compacted-summary> 进入保留区头部", AMBER, 0),
        (15.5, 57, 98, "下一轮按 version/mode 重新注入", PURPLE, 0),
    ]
    for y, x1, x2, text, color, rad in rows:
        arrow(ax, (x1, y), (x2, y), "", color=color, fontsize=7.0)
        ax.text((x1 + x2) / 2, y + 1.6, text, ha="center", va="bottom", fontsize=6.9,
                color=color, bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.9))

    ax.text(2, 4.6, "短程：原生 checkpoint（权威近期状态）　　长程：digest / map（项目全貌与可回溯索引）\n"
                    "两者只在“信息不重复”时同时注入（dual / dual-lite），否则单注入或跳过（long-only / short-only）",
            ha="left", va="bottom", fontsize=7.0, color=GREY, linespacing=1.6)
    save(fig, "fig2_sequence")


# --------------------------------------------------------------------------- fig3
def fig_policy():
    fig, ax = plt.subplots(figsize=(7.3, 3.9))
    ax.set_xlim(0, 100)
    ax.set_ylim(-20, 100)
    ax.axis("off")

    cols = ["无 checkpoint\n（新会话/未压缩）", "新鲜（≤2 轮）", "陈旧（>2 轮）", "新鲜且压力≥0.85"]
    rows = ["coding\n（编辑/修复）", "research/\nhistory", "planning", "general", "任意任务\n（压力优先）"]
    col_x = [27, 47, 67, 87]
    row_y = [64, 49, 34, 19, 4]
    cell_w, cell_h = 19.0, 12.6

    mode_style = {
        "long-only": (TEAL_L, TEAL),
        "dual-lite": (BLUE_L, BLUE),
        "dual": (PURPLE_L, PURPLE),
        "short-only": (GREY_L, GREY),
    }
    cells = [
        [("long-only", "长程单注入", 0), ("dual-lite", "去重 · 预算×0.6", 0), ("dual", "完整双注入", 0), ("short-only", "跳过", 0)],
        [("long-only", "长程单注入", 0), ("dual-lite", "去重 · 预算×0.6", 0), ("dual", "完整双注入", 0), ("short-only", "跳过", 0)],
        [("long-only", "长程单注入", 0), ("dual", "规划需完整上下文", 0), ("dual", "完整双注入", 0), ("short-only", "跳过", 0)],
        [("long-only", "长程单注入", 0), ("short-only", "原生 checkpoint 已够", 0), ("dual", "完整双注入", 0), ("short-only", "跳过", 0)],
        [("long-only", "长程单注入", 0), ("short-only", "压力优先", 0), ("dual", "完整双注入", 0), ("short-only", "压力优先", 0)],
    ]
    for ci, cx in enumerate(col_x):
        ax.add_patch(FancyBboxPatch((cx - cell_w / 2, 80), cell_w, 8.4,
                                    boxstyle="round,pad=0.4,rounding_size=1.0",
                                    facecolor="white", edgecolor=GREY, lw=0.9))
        ax.text(cx, 84.2, cols[ci], ha="center", va="center", fontsize=7.2, color=INK)
    for ri, ry in enumerate(row_y):
        ax.add_patch(FancyBboxPatch((0.5, ry), 15.5, cell_h,
                                    boxstyle="round,pad=0.4,rounding_size=1.0",
                                    facecolor="white", edgecolor=GREY, lw=0.9))
        ax.text(8.2, ry + cell_h / 2, rows[ri], ha="center", va="center", fontsize=6.9, color=INK)
        for ci, cx in enumerate(col_x):
            mode, note, _ = cells[ri][ci]
            face, edge = mode_style[mode]
            ax.add_patch(FancyBboxPatch((cx - cell_w / 2, ry), cell_w, cell_h,
                                        boxstyle="round,pad=0.4,rounding_size=1.0",
                                        facecolor=face, edgecolor=edge, lw=1.0))
            ax.text(cx, ry + cell_h / 2 + 2.1, mode, ha="center", va="center",
                    fontsize=8.0, color=edge, fontweight="bold")
            ax.text(cx, ry + cell_h / 2 - 3.0, note, ha="center", va="center",
                    fontsize=6.5, color=INK, linespacing=1.2)

    handles = [
        Rectangle((0, 0), 1, 1, facecolor=TEAL_L, edgecolor=TEAL, label="long-only：无短程，长程唯一连续源"),
        Rectangle((0, 0), 1, 1, facecolor=BLUE_L, edgecolor=BLUE, label="dual-lite：去重双注入，预算×0.6"),
        Rectangle((0, 0), 1, 1, facecolor=PURPLE_L, edgecolor=PURPLE, label="dual：完整双注入"),
        Rectangle((0, 0), 1, 1, facecolor=GREY_L, edgecolor=GREY, label="short-only：只用原生 checkpoint"),
    ]
    ax.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=4,
              frameon=False, fontsize=6.4, handlelength=1.1, columnspacing=1.0,
              handletextpad=0.4)
    save(fig, "fig3_policy")


# --------------------------------------------------------------------------- fig4
def fig_recall():
    fig, ax = plt.subplots(figsize=(7.0, 3.4))
    cats = ["精确词条", "截断词", "释义片段", "跨语言", "总体"]
    data = {
        "词法（lexical）": [1.0, 0.917, 0.917, 0.929, 0.94],
        "稀疏语义（semantic）": [1.0, 0.917, 0.667, 0.143, 0.66],
        "混合（hybrid，默认）": [1.0, 0.917, 0.917, 0.929, 0.94],
    }
    colors = ["#8fa8c2", "#c9a25a", BLUE]
    width = 0.26
    x = np.arange(len(cats))
    for i, (name, values) in enumerate(data.items()):
        offset = (i - 1) * width
        bars = ax.bar(x + offset, values, width, label=name, color=colors[i],
                      edgecolor="white", linewidth=0.6, zorder=3)
        for rect, value in zip(bars, values):
            ax.text(rect.get_x() + rect.get_width() / 2, value + 0.025, f"{value:.3f}",
                    ha="center", va="bottom", fontsize=6.3, color=INK, rotation=90)
    ax.set_xticks(x, cats, fontsize=8.2)
    ax.set_ylim(0, 1.16)
    ax.set_ylabel("召回率 Recall@5", fontsize=8.4)
    ax.grid(axis="y", color="#e5e7eb", lw=0.7, zorder=0)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.legend(fontsize=7.2, frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.14))
    ax.set_title("查询类型 × 检索通道（12 词条 / 50 查询）", fontsize=9, color=INK, pad=26)
    save(fig, "fig4_recall")


# --------------------------------------------------------------------------- fig5
def fig_cost():
    fig, ax = plt.subplots(figsize=(7.0, 3.3))
    labels = [
        "单轮上下文窗口",
        "工具输出（可裁剪上限）",
        "压缩摘要（8 次合计）",
        "单次 digest 注入",
        "token 目标线（900）",
    ]
    values = [1048576, 315033, 26002, 767, 900]
    colors = ["#b9c6d6", "#e0b46a", "#8fbfb8", BLUE, RED]
    y = np.arange(len(labels))
    bars = ax.barh(y, values, color=colors, height=0.58, edgecolor="white", zorder=3)
    ax.set_xscale("log")
    ax.set_xlim(300, 3_000_000)
    ax.set_yticks(y, labels, fontsize=8.2)
    ax.invert_yaxis()
    ax.grid(axis="x", color="#e5e7eb", lw=0.7, zorder=0)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for rect, value in zip(bars, values):
        ax.text(value * 1.12, rect.get_y() + rect.get_height() / 2,
                f"{value:,} tokens", va="center", ha="left", fontsize=7.2, color=INK)
    ax.set_xlabel("token 数（对数轴，CJK 约 3.6 字符/token 口径）", fontsize=8.2)
    ax.set_title("上下文成本构成：压缩摘要与工具输出远大于长程注入", fontsize=9, color=INK)
    save(fig, "fig5_cost")


# --------------------------------------------------------------------------- fig6 (3D)
def effective_budget(age, pressure, task="coding"):
    """Re-implementation of resolveInjectionPlan + adaptDigestBudget for the figure."""
    base = 2000.0
    ratio = pressure

    def adaptive(budget):
        scale = 1.0 if ratio < 0.55 else 0.7 if ratio < 0.7 else 0.5 if ratio < 0.85 else 0.3
        floor = min(budget, max(400.0, round(budget * 0.2)))
        return max(floor, min(budget, round(budget * scale)))

    if age > 2:
        return adaptive(base), "dual"
    if ratio >= 0.85:
        return 0.0, "short-only"
    if task in ("coding", "research", "history"):
        return max(400.0, round(adaptive(base) * 0.6)), "dual-lite"
    if task == "planning":
        return adaptive(base), "dual"
    return 0.0, "short-only"


def fig_budget_surface():
    from matplotlib.lines import Line2D

    ages = np.arange(0, 12.001, 0.25)
    pressures = np.arange(0.30, 1.0001, 0.01)
    mode_color = {
        "dual": np.array([0.357, 0.247, 0.549]),
        "dual-lite": np.array([0.122, 0.306, 0.475]),
        "short-only": np.array([0.42, 0.44, 0.47]),
    }
    Z = np.zeros((len(pressures), len(ages)))
    C = np.zeros((len(pressures), len(ages), 4))
    for i, p in enumerate(pressures):
        for j, a in enumerate(ages):
            value, mode = effective_budget(a, p)
            Z[i, j] = value
            C[i, j, :3] = mode_color[mode]
            C[i, j, 3] = 0.96
    X, Y = np.meshgrid(ages, pressures)

    fig = plt.figure(figsize=(6.9, 5.1))
    ax = fig.add_subplot(111, projection="3d")
    ax.plot_surface(X, Y, Z, facecolors=C, rstride=1, cstride=1, linewidth=0,
                    antialiased=True, shade=False)
    ax.plot([2, 2], [0.30, 1.0], [0, 0], color="#9ca3af", lw=0.8, ls=(0, (3, 3)))
    ax.set_xlabel("checkpoint 年龄 / 轮", fontsize=8.6, labelpad=7)
    ax.set_ylabel("上下文压力比", fontsize=8.6, labelpad=7)
    ax.set_zlabel("有效注入预算 / token", fontsize=8.6, labelpad=6)
    ax.set_xlim(0, 12)
    ax.set_ylim(0.30, 1.0)
    ax.set_zlim(0, 2300)
    ax.set_yticks([0.3, 0.5, 0.7, 0.85, 1.0])
    ax.tick_params(labelsize=7.0)
    ax.set_box_aspect((1.35, 0.85, 0.85))
    ax.view_init(elev=26, azim=-116)
    label_box = dict(boxstyle="round,pad=0.22", fc="white", ec="none", alpha=0.88)
    ax.text(9.0, 0.40, 2150, "dual\n（完整长程）", fontsize=6.8, color=PURPLE, zorder=10,
            bbox=label_box, ha="center", va="center")
    ax.text(1.2, 0.62, 1480, "dual-lite\n（去重 ×0.6）", fontsize=6.8, color=BLUE, zorder=10,
            bbox=label_box, ha="center", va="center")
    ax.text(1.2, 0.93, 720, "short-only\n（跳过）", fontsize=6.8, color=GREY, zorder=10,
            bbox=label_box, ha="center", va="center")
    ax.text(3.2, 0.305, 40, "年龄 = 2 轮阈值", fontsize=6.2, color="#6b7280", zorder=10)
    handles = [
        Line2D([0], [0], marker="s", linestyle="", markersize=7, color=PURPLE, label="dual：完整双注入"),
        Line2D([0], [0], marker="s", linestyle="", markersize=7, color=BLUE, label="dual-lite：去重双注入（×0.6）"),
        Line2D([0], [0], marker="s", linestyle="", markersize=7, color=GREY, label="short-only：跳过注入"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=3, fontsize=6.4, frameon=False,
               bbox_to_anchor=(0.5, 0.005), handletextpad=0.4, columnspacing=1.2)
    ax.set_title("注入预算决策面（coding 任务：自适应预算 × 计划系数）", fontsize=9, color=INK, pad=0)
    save(fig, "fig6_budget_surface_3d", pad=0.12)


def main():
    fig_architecture()
    fig_sequence()
    fig_policy()
    fig_recall()
    fig_cost()
    fig_budget_surface()


if __name__ == "__main__":
    main()
