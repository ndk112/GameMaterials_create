import { memo } from "react";
import Icon from "./Icon";

const tools = [
  { id: "cutout", name: "素材抠图与切割", icon: "scissors", desc: "手动框选素材区域，抠透明背景，批量导出 PNG / ZIP。", color: "cyan" },
  { id: "animation", name: "帧动画拼接", icon: "film", desc: "连续帧可导出 MP4 / 精灵表。", color: "violet" },
  { id: "resize", name: "尺寸调整", icon: "resize", desc: "浏览器内缩放预览与尺寸检查。", color: "amber" },
];

const toolColorMap = {
  cyan: { bg: "bg-cyan-400/10 border-cyan-400/20", icon: "bg-cyan-400/20 text-cyan-300", active: "border-cyan-400/50 bg-cyan-400/10" },
  violet: { bg: "bg-violet-400/10 border-violet-400/20", icon: "bg-violet-400/20 text-violet-300", active: "border-violet-400/50 bg-violet-400/10" },
  amber: { bg: "bg-amber-400/10 border-amber-400/20", icon: "bg-amber-400/20 text-amber-300", active: "border-amber-400/50 bg-amber-400/10" },
};

function ToolSidebar({ activeTool, onSelect }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] glass p-3 space-y-1.5 glow-cyan">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-widest text-slate-500">工具</p>
      {tools.map((tool) => {
        const colors = toolColorMap[tool.color];
        const isActive = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            onClick={() => onSelect(tool.id)}
            className={`w-full rounded-xl border p-3 text-left transition-all duration-200 ${
              isActive ? colors.active + " shadow-lg" : "border-transparent hover:border-white/[0.08] hover:bg-white/[0.04]"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${colors.icon}`}>
                <Icon name={tool.icon} size={14} />
              </div>
              <div>
                <div className="text-[13px] font-semibold text-white">{tool.name}</div>
              </div>
            </div>
            <p className="mt-2 pl-[42px] text-[12px] leading-5 text-slate-400">{tool.desc}</p>
          </button>
        );
      })}
    </div>
  );
}

export default memo(ToolSidebar);
