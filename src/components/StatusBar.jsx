import { memo } from "react";
import Icon from "./Icon";

const statusVariants = {
  idle: "bg-white/[0.06] text-slate-400",
  loading: "bg-amber-400/10 text-amber-300",
  success: "bg-emerald-400/10 text-emerald-300",
  error: "bg-red-400/10 text-red-300",
};

const statusIcons = {
  idle: "info",
  loading: "refresh",
  success: "check",
  error: "alert",
};

function StatusBar({ message, status = "idle" }) {
  return (
    <div className={`rounded-2xl border border-white/[0.06] glass px-4 py-2.5 ${statusVariants[status] || statusVariants.idle}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center">
          <Icon name={statusIcons[status] || "info"} size={12} />
        </span>
        <span className="text-[11px] font-medium truncate">{message}</span>
      </div>
    </div>
  );
}

export default memo(StatusBar);
