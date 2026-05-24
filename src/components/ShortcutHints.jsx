import { memo } from "react";
import Icon from "./Icon";

const SHORTCUTS = {
  animation: [
    { keys: "Space", desc: "暂停 / 播放" },
    { keys: "Ctrl+Z", desc: "撤回" },
    { keys: "Ctrl+S", desc: "导出帧 PNG" },
    { keys: "Ctrl+A", desc: "全选片段" },
    { keys: "Delete", desc: "删除选中片段" },
    { keys: "A", desc: "片段前移" },
    { keys: "D", desc: "片段后移" },
  ],
  resize: [
    { keys: "拖拽框体", desc: "移动裁切框" },
    { keys: "拖拽边角", desc: "调整裁切大小" },
    { keys: "Shift+拖角", desc: "等比缩放裁切" },
    { keys: "W A S D", desc: "微调裁切位置" },
    { keys: "Shift+W/A/S/D", desc: "快速微调(10px)" },
    { keys: "Delete", desc: "清除裁切框" },
    { keys: "Esc", desc: "退出裁切" },
    { keys: "Shift+滚轮", desc: "画布缩放" },
  ],
  cutout: [
    { keys: "Ctrl+Z", desc: "撤回" },
    { keys: "Ctrl+D", desc: "复制选中框" },
    { keys: "Delete", desc: "删除选中框" },
    { keys: "Esc", desc: "取消选中" },
    { keys: "Shift+滚轮", desc: "画布缩放" },
    { keys: "Space+拖拽", desc: "平移画布" },
    { keys: "中键拖拽", desc: "平移画布" },
    { keys: "Shift+拖角", desc: "等比缩放" },
    { keys: "右键", desc: "上下文菜单" },
  ],
};

function ShortcutHints({ activeTool }) {
  const shortcuts = SHORTCUTS[activeTool] || SHORTCUTS.cutout;
  return (
    <div className="rounded-2xl border border-white/[0.06] glass p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="film" size={14} />
        <span className="text-[13px] font-semibold text-white">快捷键</span>
      </div>
      <div className="space-y-1.5">
        {shortcuts.map((s) => (
          <div key={s.keys} className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-slate-300">{s.desc}</span>
            <kbd className="rounded-md border border-white/[0.1] bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400 font-mono whitespace-nowrap">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(ShortcutHints);
