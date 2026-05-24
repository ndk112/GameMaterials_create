import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Icon from "./components/Icon";
import ToolSidebar from "./components/ToolSidebar";
import StatusBar from "./components/StatusBar";
import ShortcutHints from "./components/ShortcutHints";

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ─────────────────────── 精灵表生成器 ─────────────────────── */

async function generateSpriteSheetDataURL(assets, layout, cols) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const n = assets.length;
  if (!n) return "";
  const sw = Math.max(...assets.map((a) => a.width));
  const sh = Math.max(...assets.map((a) => a.height));

  let totalW, totalH;
  if (layout === "horizontal" || n === 1) { totalW = sw * n; totalH = sh; }
  else { const rows = Math.ceil(n / cols); totalW = sw * cols; totalH = sh * rows; }

  canvas.width = totalW; canvas.height = totalH;

  const images = await Promise.all(assets.map((a) => loadImageElement(a.url)));
  images.forEach((img, i) => {
    let x, y;
    if (layout === "horizontal" || n === 1) { x = i * sw + (sw - assets[i].width) / 2; y = (sh - assets[i].height) / 2; }
    else { x = (i % cols) * sw + (sw - assets[i].width) / 2; y = Math.floor(i / cols) * sh + (sh - assets[i].height) / 2; }
    ctx.drawImage(img, Math.round(x), Math.round(y));
  });
  return canvas.toDataURL("image/png");
}

/* ─────────────────────── 工具函数 ─────────────────────── */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function generateId(prefix = "asset") { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function batchDownloadAll(list, interval = 180) {
  list.forEach((item, i) => {
    window.setTimeout(() => {
      const a = document.createElement("a");
      a.href = item.url; a.download = item.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }, i * interval);
  });
}
function formatTimelineDuration(clips) {
  const total = clips.reduce((s, c) => s + (c.durationMs || 0), 0);
  return `${clips.length} 段 · 总时长 ${total >= 1000 ? (total / 1000).toFixed(1) + "s" : total + "ms"}`;
}

// Canvas 通用：裁切 + 缩放图片，返回 data URL
function applyCropAndScale(img, srcX, srcY, srcW, srcH, outW, outH) {
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  return canvas.toDataURL("image/png");
}

/* ─── 样式常量 ─── */
const CHECKERBOARD_STYLE = (size = 10) => ({
  backgroundImage: `linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%),linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%)`,
  backgroundSize: `${size}px ${size}px`,
  backgroundPosition: "0 0, 5px 5px",
});

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

const MIN_CLIP_MS = 50;

/* ─────────────────────── 通用 Button ─────────────────────── */
function Button({ children, disabled, className = "", variant = "default", ...props }) {
  return (
    <button
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 select-none
        ${disabled ? "cursor-not-allowed opacity-40 pointer-events-none" : "cursor-pointer"}
        ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/* ─────────────────────── 主组件 ─────────────────────── */
export default function GameAssetProcessingWebsite() {
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);

  const [imageUrl, setImageUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [assets, setAssets] = useState([]);
  const [processMessage, setProcessMessage] = useState("等待上传图片");
  const [processStatus, setProcessStatus] = useState("idle"); // idle | loading | success | error
  const [bgTolerance, setBgTolerance] = useState(70);
  const [edgeFeather, setEdgeFeather] = useState(2);
  const [despill, setDespill] = useState(true);
  const [scale, setScale] = useState(100);        // 预览缩放 (20-200%)
  const [resizeScale, setResizeScale] = useState(100); // 输出缩放系数 (10-500%)
  const [cropW, setCropW] = useState(0);   // 0 = 未启用裁切
  const [cropH, setCropH] = useState(0);
  const [cropX, setCropX] = useState(0);   // 裁切起始坐标
  const [cropY, setCropY] = useState(0);
  const [zipDownloadUrl, setZipDownloadUrl] = useState("");
  const [zipBlobUrl, setZipBlobUrl] = useState("");
  const [zipDownloadName, setZipDownloadName] = useState("game_assets.zip");
  const [zipBase64, setZipBase64] = useState("");
  const [showBase64, setShowBase64] = useState(false);
  const [activeTool, setActiveTool] = useState("cutout");
  const [isDragOver, setIsDragOver] = useState(false);

  /* ── 动画拼接状态 ── */
  const animationCanvasRef = useRef(null);
  const zipInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const timelineTrackRef = useRef(null);
  const playheadLineRef = useRef(null);
  const timelineScrollRef = useRef(null);
  const timelineRulerInnerRef = useRef(null);
  const timelineUndoRef = useRef([]);            // 时间轴撤销历史
  const resizePreStateRef = useRef(null);         // 拖拽时长前状态（撤销用）
  const timelineClipsRef = useRef([]);            // 时间轴快照（键盘事件用）
  // 素材库：集中存放所有素材（来自抠图分割、ZIP导入）
  const [assetLibrary, setAssetLibrary] = useState([]);
  // 成品库：尺寸调整确认后的最终素材
  const [finishedLibrary, setFinishedLibrary] = useState([]);
  // 尺寸调整素材库选中项
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  // 时间轴片段：从素材库添加，每段独立设置播放时长（ms）
  const [timelineClips, setTimelineClips] = useState([]);
  const [animFPS, setAnimFPS] = useState(12);       // 仅用于 MP4 导出帧率
  const [animPlaying, setAnimPlaying] = useState(true);
  const [animLoopCount, setAnimLoopCount] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(150);     // px/s
  const [currentTimeMs, setCurrentTimeMs] = useState(0);     // 播放头位置
  const [selectedClips, setSelectedClips] = useState([]);
  const timelineZoomRef = useRef(150); // 同步 ref 供 rAF 循环读取
  useEffect(() => { timelineZoomRef.current = timelineZoom; }, [timelineZoom]);
  // 时间轴拖拽调整片段时长
  const [resizingClip, setResizingClip] = useState(null); // { index, edge:'left'|'right', startX, startDuration, startPrevDuration }
  const resizingRef = useRef(null); // 同步 ref 供 mousemove 读取
  // 缩放变化时同步标尺滚动位置
  useEffect(() => {
    const ruler = timelineRulerInnerRef.current;
    const track = timelineScrollRef.current;
    if (ruler && track) {
      ruler.style.transform = `translateX(${-track.scrollLeft}px)`;
    }
  }, [timelineZoom]);
  // 选中片段时自动滚动到可视区域
  useEffect(() => {
    if (selectedClips.length === 0) return;
    const track = timelineScrollRef.current;
    if (!track || !timelineClips.length) return;
    const idx = selectedClips[0];
    let leftPx = 0;
    for (let i = 0; i < idx; i++) {
      leftPx += Math.max(24, (timelineClips[i].durationMs / 1000) * timelineZoom);
    }
    const clipW = Math.max(24, (timelineClips[idx].durationMs / 1000) * timelineZoom);
    const targetScroll = leftPx - (track.clientWidth - clipW) / 2;
    track.scrollTo({ left: Math.max(0, targetScroll), behavior: "smooth" });
  }, [selectedClips, timelineZoom, timelineClips]);
  const [spriteLayout, setSpriteLayout] = useState("horizontal");
  const [spriteCols, setSpriteCols] = useState(4);

  /* ── 手动框选状态 ── */
  const [manualBoxes, setManualBoxes] = useState([]);
  const [selectedBoxIndex, setSelectedBoxIndex] = useState(null);
  const [selectionMode, setSelectionMode] = useState(true);
  const [showBoxHint, setShowBoxHint] = useState(true);
  const [imgNaturalW, setImgNaturalW] = useState(0);
  const [imgNaturalH, setImgNaturalH] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState(null);
  const [drawEnd, setDrawEnd] = useState(null);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveStart, setMoveStart] = useState(null);
  const [moveBoxOriginal, setMoveBoxOriginal] = useState(null);
  const [showSmartDialog, setShowSmartDialog] = useState(false);
  const [smartDetectCount, setSmartDetectCount] = useState(4);
  const [hoverCursor, setHoverCursor] = useState("crosshair");
  const [showContextMenu, setShowContextMenu] = useState(null);

  /* ── 裁切框选状态 ── */
  const [cropSelectionMode, setCropSelectionMode] = useState(true);
  const [isCropDrawing, setIsCropDrawing] = useState(false);
  const [cropDrawStart, setCropDrawStart] = useState(null);
  const [cropDrawEnd, setCropDrawEnd] = useState(null);
  const [isCropResizing, setIsCropResizing] = useState(false);
  const [cropResizeHandle, setCropResizeHandle] = useState(null);
  const [isCropMoving, setIsCropMoving] = useState(false);
  const [cropMoveStart, setCropMoveStart] = useState(null);
  const [cropMoveOriginal, setCropMoveOriginal] = useState(null);
  const [cropHoverCursor, setCropHoverCursor] = useState("crosshair");
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState(null);
  const [showShortcutHints, setShowShortcutHints] = useState(true);
  const historyStackRef = useRef([]);
  const prevBoxesRef = useRef([]);
  const skipHistoryRef = useRef(false);
  const isSpaceHeldRef = useRef(false);
  const isTransformingRef = useRef(false);

  const crcTable = useMemo(() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  }, []);

  const timelineStats = useMemo(() => {
    const total = timelineClips.reduce((s, c) => s + c.durationMs, 0);
    const pps = timelineZoom > 0 ? timelineZoom : 150;
    return `${formatTimelineDuration(timelineClips)} · ${Math.round((total / 1000) * pps)}px`;
  }, [timelineClips, timelineZoom]);

  const animTotalDuration = useMemo(() => {
    return timelineClips.reduce((s, c) => s + c.durationMs, 0);
  }, [timelineClips]);

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function baseName(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name || "game_assets";
  }

  function resetZipExport() {
    if (zipBlobUrl) URL.revokeObjectURL(zipBlobUrl);
    setZipBlobUrl("");
    setZipDownloadUrl("");
    setZipBase64("");
    setShowBase64(false);
  }

  function processFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("请选择 PNG、JPG 或 WebP 图片文件");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resetZipExport();
      setImageUrl(dataUrl);
      setFileName(file.name);
      setAssets([]);
      setManualBoxes([]);
      setSelectedBoxIndex(null);
      setCropW(0); setCropH(0); setCropX(0); setCropY(0); setResizeScale(100);
      setSelectionMode(true);
      setShowBoxHint(true);
      setSelectedAssetId(null);
      setProcessMessage('图片已导入，默认进入框选模式');
      setProcessStatus("success");

      // 尺寸调整模式：同时将导入图片加入素材库
      if (activeTool === "resize") {
        const img = new Image();
        img.onload = () => {
          setAssetLibrary((prev) => [...prev, {
            id: generateId("lib"),
            name: file.name,
            url: dataUrl,
            width: img.naturalWidth,
            height: img.naturalHeight,
            source: "image",
          }]);
        };
        img.src = dataUrl;
      }
    };
    reader.onerror = () => alert("图片读取失败，请换一张图片再试");
    reader.readAsDataURL(file);
  }

  function handleUpload(event) {
    processFile(event.target.files && event.target.files[0]);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    processFile(file);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  /* ─────────────────────── 手动框选系统 ─────────────────────── */

  // 将鼠标事件坐标转换为图片自然坐标
  // 使用 overlay 自身的 bounding rect 而非 img，避免因 overflow-hidden 裁剪 / CSS transform 缩放
  // 导致的视觉可见区域与 getBoundingClientRect 返回值不一致问题
  function mouseToImageCoords(e) {
    const overlay = e.currentTarget;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height || !imgNaturalW || !imgNaturalH) return { x: 0, y: 0 };
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * imgNaturalW),
      y: Math.round(((e.clientY - rect.top) / rect.height) * imgNaturalH),
    };
  }

  // 判断坐标是否在某个框内
  function hitTest(box, px, py) {
    return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
  }

  // 判断坐标是否在手柄上（返回 handle 名称或 null）
  // handleSize 按图片宽度自适应：取 max(6, 图片宽度 * 0.008)
  function hitTestHandle(box, px, py, imgW) {
    const handleSize = Math.max(6, Math.round((imgW || 512) * 0.008));
    const handles = {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      sw: { x: box.x, y: box.y + box.height },
      se: { x: box.x + box.width, y: box.y + box.height },
      n:  { x: box.x + box.width / 2, y: box.y },
      s:  { x: box.x + box.width / 2, y: box.y + box.height },
      e:  { x: box.x + box.width, y: box.y + box.height / 2 },
      w:  { x: box.x, y: box.y + box.height / 2 },
    };
    for (const [name, pt] of Object.entries(handles)) {
      if (Math.abs(px - pt.x) <= handleSize && Math.abs(py - pt.y) <= handleSize) return name;
    }
    return null;
  }

  // 框选 overlay mouseDown
  function handleOverlayMouseDown(e) {
    if (!selectionMode || !imageUrl) return;

    // 中键或空格+左键 = 画布平移
    if (e.button === 1 || (e.button === 0 && isSpaceHeldRef.current)) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      setHoverCursor("grabbing");
      return;
    }
    
    e.preventDefault();
    const pt = mouseToImageCoords(e);

    // 检查是否点击了选中框的手柄
    if (selectedBoxIndex !== null && manualBoxes[selectedBoxIndex]) {
      const sel = manualBoxes[selectedBoxIndex];
      const h = hitTestHandle(sel, pt.x, pt.y, imgNaturalW);
      if (h) {
        historyStackRef.current.push(prevBoxesRef.current.map((b) => ({ ...b })));
        if (historyStackRef.current.length > 50) historyStackRef.current.shift();
        isTransformingRef.current = true;
        setIsResizing(true);
        setResizeHandle(h);
        setMoveStart(pt);
        setMoveBoxOriginal({ ...sel });
        return;
      }
      // 检查是否点击了选中框内部（移动）
      if (hitTest(sel, pt.x, pt.y)) {
        historyStackRef.current.push(prevBoxesRef.current.map((b) => ({ ...b })));
        if (historyStackRef.current.length > 50) historyStackRef.current.shift();
        isTransformingRef.current = true;
        setIsMoving(true);
        setMoveStart(pt);
        setMoveBoxOriginal({ ...sel });
        return;
      }
    }

    // 检查是否点击了其他框（选中）
    for (let i = manualBoxes.length - 1; i >= 0; i -= 1) {
      if (hitTest(manualBoxes[i], pt.x, pt.y)) {
        setSelectedBoxIndex(i);
        // 也启动移动
        historyStackRef.current.push(prevBoxesRef.current.map((b) => ({ ...b })));
        if (historyStackRef.current.length > 50) historyStackRef.current.shift();
        isTransformingRef.current = true;
        setIsMoving(true);
        setMoveStart(pt);
        setMoveBoxOriginal({ ...manualBoxes[i] });
        return;
      }
    }

    // 点击空白区域 — 取消选中，开始绘制新框
    setSelectedBoxIndex(null);
    setIsDrawing(true);
    setDrawStart(pt);
    setDrawEnd(pt);
  }

  function handleOverlayMouseMove(e) {
    if (!selectionMode) return;
    
    // 画布平移
    if (isPanning && panStart) {
      setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }
    
    const pt = mouseToImageCoords(e);

    if (isDrawing) {
      setDrawEnd(pt);
    } else if (isResizing && moveBoxOriginal && moveStart) {
      const dx = pt.x - moveStart.x;
      const dy = pt.y - moveStart.y;
      const orig = moveBoxOriginal;
      let newBox = { ...orig };

      // Shift 等比缩放：按原始宽高比约束
      if (e.shiftKey && (resizeHandle === "nw" || resizeHandle === "ne" || resizeHandle === "sw" || resizeHandle === "se")) {
        const ratio = orig.width / Math.max(1, orig.height);
        const maxDim = Math.max(Math.abs(dx), Math.abs(dy));
        const sd = Math.sign(dx || dy || 1) * Math.max(1, maxDim);
        const adjustedDx = resizeHandle.includes('e') ? sd : -sd;
        const adjustedDy = resizeHandle.includes('s')
          ? Math.round(Math.abs(adjustedDx) / ratio) * (adjustedDx >= 0 ? 1 : -1)
          : -Math.round(Math.abs(adjustedDx) / ratio) * (adjustedDx >= 0 ? 1 : -1);

        if (resizeHandle.includes('e')) { newBox.width = Math.max(10, orig.width + adjustedDx); }
        if (resizeHandle.includes('w')) { newBox.x = Math.min(orig.x + orig.width - 10, orig.x + adjustedDx); newBox.width = orig.width + orig.x - newBox.x; }
        if (resizeHandle.includes('s')) { newBox.height = Math.max(10, orig.height + adjustedDy); }
        if (resizeHandle.includes('n')) { newBox.y = Math.min(orig.y + orig.height - 10, orig.y + adjustedDy); newBox.height = orig.height + orig.y - newBox.y; }
      } else {
        const h = resizeHandle;
        if (h.includes('e')) { newBox.width = Math.max(10, orig.width + dx); }
        if (h.includes('w')) { newBox.x = Math.min(orig.x + orig.width - 10, orig.x + dx); newBox.width = orig.width + orig.x - newBox.x; }
        if (h.includes('s')) { newBox.height = Math.max(10, orig.height + dy); }
        if (h.includes('n')) { newBox.y = Math.min(orig.y + orig.height - 10, orig.y + dy); newBox.height = orig.height + orig.y - newBox.y; }
      }

      // 边界约束
      newBox.x = Math.max(0, newBox.x);
      newBox.y = Math.max(0, newBox.y);
      newBox.width = Math.min(imgNaturalW - newBox.x, newBox.width);
      newBox.height = Math.min(imgNaturalH - newBox.y, newBox.height);

      setManualBoxes((prev) => {
        const next = [...prev];
        next[selectedBoxIndex] = { ...next[selectedBoxIndex], ...newBox };
        return next;
      });
    } else if (isMoving && moveBoxOriginal && moveStart) {
      const dx = pt.x - moveStart.x;
      const dy = pt.y - moveStart.y;
      const box = manualBoxes[selectedBoxIndex];
      const newX = moveBoxOriginal.x + dx;
      const newY = moveBoxOriginal.y + dy;
      setManualBoxes((prev) => {
        const next = [...prev];
        next[selectedBoxIndex] = {
          ...next[selectedBoxIndex],
          x: Math.max(0, Math.min(imgNaturalW - (box?.width || 1), newX)),
          y: Math.max(0, Math.min(imgNaturalH - (box?.height || 1), newY)),
        };
        return next;
      });
    } else {
      // 悬停光标检测
      let cursor = "crosshair";
      if (selectedBoxIndex !== null && manualBoxes[selectedBoxIndex]) {
        const sel = manualBoxes[selectedBoxIndex];
        const h = hitTestHandle(sel, pt.x, pt.y, imgNaturalW);
        const handleCursors = { nw:"nwse-resize", ne:"nesw-resize", sw:"nesw-resize", se:"nwse-resize", n:"n-resize", s:"s-resize", e:"e-resize", w:"w-resize" };
        if (h) {
          cursor = handleCursors[h];
        } else if (hitTest(sel, pt.x, pt.y)) {
          cursor = "move";
        }
      }
      if (cursor !== hoverCursor) setHoverCursor(cursor);
    }
  }

  function handleOverlayMouseUp(e) {
    if (isPanning) {
      setIsPanning(false);
      setPanStart(null);
      setHoverCursor(isSpaceHeldRef.current ? "grab" : "crosshair");
      return;
    }
    if (isDrawing && drawStart && drawEnd) {
      const x = Math.min(drawStart.x, drawEnd.x);
      const y = Math.min(drawStart.y, drawEnd.y);
      const w = Math.abs(drawEnd.x - drawStart.x);
      const h = Math.abs(drawEnd.y - drawStart.y);
      if (w > 5 && h > 5) {
        const newBox = { id: generateId("box"), x, y, width: w, height: h };
        setManualBoxes((prev) => [...prev, newBox]);
        setSelectedBoxIndex(null);
      }
    }
    setIsDrawing(false);
    setDrawStart(null);
    setDrawEnd(null);
    setIsResizing(false);
    setResizeHandle(null);
    setIsMoving(false);
    setMoveStart(null);
    setMoveBoxOriginal(null);
    isTransformingRef.current = false;
  }


  /* ── 裁切框选处理函数 ── */
  function handleCropOverlayMouseDown(e) {
    if (!cropSelectionMode || !imageUrl) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = cropMouseToImageCoords(e);

    // 已有确认裁切框时，检查手柄和内部点击
    if (cropW > 0 && cropH > 0) {
      const h = cropHitTestHandle(cropX, cropY, cropW, cropH, pt.x, pt.y);
      if (h) {
        setIsCropResizing(true);
        setCropResizeHandle(h);
        setCropMoveStart(pt);
        setCropMoveOriginal({ x: cropX, y: cropY, w: cropW, h: cropH });
        return;
      }
      if (cropHitTest(cropX, cropY, cropW, cropH, pt.x, pt.y)) {
        setIsCropMoving(true);
        setCropMoveStart(pt);
        setCropMoveOriginal({ x: cropX, y: cropY, w: cropW, h: cropH });
        return;
      }
    }

    // 空白区域开始新绘制
    setIsCropDrawing(true);
    setCropDrawStart(pt);
    setCropDrawEnd(pt);
  }

  function handleCropOverlayMouseMove(e) {
    if (!cropSelectionMode) return;
    const pt = cropMouseToImageCoords(e);

    if (isCropDrawing) {
      setCropDrawEnd(pt);
    } else if (isCropResizing && cropMoveOriginal && cropMoveStart) {
      const dx = pt.x - cropMoveStart.x;
      const dy = pt.y - cropMoveStart.y;
      const orig = cropMoveOriginal;
      let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;

      // Shift 等比缩放
      if (e.shiftKey && (cropResizeHandle === "nw" || cropResizeHandle === "ne" || cropResizeHandle === "sw" || cropResizeHandle === "se")) {
        const ratio = orig.w / Math.max(1, orig.h);
        const maxDim = Math.max(Math.abs(dx), Math.abs(dy));
        const sd = Math.sign(dx || dy || 1) * Math.max(1, maxDim);
        const adjustedDx = cropResizeHandle.includes('e') ? sd : -sd;
        const adjustedDy = cropResizeHandle.includes('s')
          ? Math.round(Math.abs(adjustedDx) / ratio) * (adjustedDx >= 0 ? 1 : -1)
          : -Math.round(Math.abs(adjustedDx) / ratio) * (adjustedDx >= 0 ? 1 : -1);

        if (cropResizeHandle.includes('e')) nw = Math.max(10, orig.w + adjustedDx);
        if (cropResizeHandle.includes('w')) { nx = Math.min(orig.x + orig.w - 10, orig.x + adjustedDx); nw = orig.w + orig.x - nx; }
        if (cropResizeHandle.includes('s')) nh = Math.max(10, orig.h + adjustedDy);
        if (cropResizeHandle.includes('n')) { ny = Math.min(orig.y + orig.h - 10, orig.y + adjustedDy); nh = orig.h + orig.y - ny; }
      } else {
        const h = cropResizeHandle;
        if (h.includes('e')) nw = Math.max(10, orig.w + dx);
        if (h.includes('w')) { nx = Math.min(orig.x + orig.w - 10, orig.x + dx); nw = orig.w + orig.x - nx; }
        if (h.includes('s')) nh = Math.max(10, orig.h + dy);
        if (h.includes('n')) { ny = Math.min(orig.y + orig.h - 10, orig.y + dy); nh = orig.h + orig.y - ny; }
      }

      // 边界约束
      nx = Math.max(0, nx);
      ny = Math.max(0, ny);
      nw = Math.min(imgNaturalW - nx, nw);
      nh = Math.min(imgNaturalH - ny, nh);

      setCropX(nx);
      setCropY(ny);
      setCropW(nw);
      setCropH(nh);
    } else if (isCropMoving && cropMoveOriginal && cropMoveStart) {
      const dx = pt.x - cropMoveStart.x;
      const dy = pt.y - cropMoveStart.y;
      const nx = Math.max(0, Math.min(imgNaturalW - cropMoveOriginal.w, cropMoveOriginal.x + dx));
      const ny = Math.max(0, Math.min(imgNaturalH - cropMoveOriginal.h, cropMoveOriginal.y + dy));
      setCropX(nx);
      setCropY(ny);
    } else {
      // 悬停光标检测
      let cursor = "crosshair";
      if (cropW > 0 && cropH > 0) {
        const h = cropHitTestHandle(cropX, cropY, cropW, cropH, pt.x, pt.y);
        const handleCursors = { nw:"nwse-resize", ne:"nesw-resize", sw:"nesw-resize", se:"nwse-resize", n:"n-resize", s:"s-resize", e:"e-resize", w:"w-resize" };
        if (h) {
          cursor = handleCursors[h];
        } else if (cropHitTest(cropX, cropY, cropW, cropH, pt.x, pt.y)) {
          cursor = "move";
        }
      }
      if (cursor !== cropHoverCursor) setCropHoverCursor(cursor);
    }
  }

  function handleCropOverlayMouseUp(e) {
    if (isCropDrawing) {
      if (cropDrawStart && cropDrawEnd) {
        const x = Math.min(cropDrawStart.x, cropDrawEnd.x);
        const y = Math.min(cropDrawStart.y, cropDrawEnd.y);
        const w = Math.abs(cropDrawEnd.x - cropDrawStart.x);
        const h = Math.abs(cropDrawEnd.y - cropDrawStart.y);
        if (w > 5 && h > 5) {
          setCropW(w);
          setCropH(h);
          setCropX(x);
          setCropY(y);
        }
      }
    }
    setIsCropDrawing(false);
    setCropDrawStart(null);
    setCropDrawEnd(null);
    setIsCropResizing(false);
    setCropResizeHandle(null);
    setIsCropMoving(false);
    setCropMoveStart(null);
    setCropMoveOriginal(null);
  }

  function cropMouseToImageCoords(e) {
    const overlay = e.currentTarget;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height || !imgNaturalW || !imgNaturalH) return { x: 0, y: 0 };
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * imgNaturalW),
      y: Math.round(((e.clientY - rect.top) / rect.height) * imgNaturalH),
    };
  }

  /* ── 裁切框碰撞检测 ── */
  function cropHitTest(cx, cy, cw, ch, px, py) {
    return px >= cx && px <= cx + cw && py >= cy && py <= cy + ch;
  }

  function cropHitTestHandle(cx, cy, cw, ch, px, py) {
    const handleSize = Math.max(6, Math.round((imgNaturalW || 512) * 0.008));
    const handles = {
      nw: { x: cx, y: cy },
      ne: { x: cx + cw, y: cy },
      sw: { x: cx, y: cy + ch },
      se: { x: cx + cw, y: cy + ch },
      n:  { x: cx + cw / 2, y: cy },
      s:  { x: cx + cw / 2, y: cy + ch },
      e:  { x: cx + cw, y: cy + ch / 2 },
      w:  { x: cx, y: cy + ch / 2 },
    };
    for (const [name, pt] of Object.entries(handles)) {
      if (Math.abs(px - pt.x) <= handleSize && Math.abs(py - pt.y) <= handleSize) return name;
    }
    return null;
  }

  function handleDeleteSelectedBox() {
    if (selectedBoxIndex === null) return;
    setManualBoxes((prev) => prev.filter((_, i) => i !== selectedBoxIndex));
    setSelectedBoxIndex(null);
  }

  function handleDuplicateSelectedBox() {
    if (selectedBoxIndex === null) return;
    setManualBoxes((prev) => {
      const box = prev[selectedBoxIndex];
      const dup = { ...box, id: generateId("box"), x: Math.min(imgNaturalW - box.width, box.x + 20), y: Math.min(imgNaturalH - box.height, box.y + 20) };
      const next = [...prev];
      next.splice(selectedBoxIndex + 1, 0, dup);
      return next;
    });
    setSelectedBoxIndex((prev) => prev + 1);
    setShowContextMenu(null);
  }

  function handleUndo() {
    if (historyStackRef.current.length === 0) return;
    skipHistoryRef.current = true;
    const prev = historyStackRef.current.pop();
    setManualBoxes(prev);
    prevBoxesRef.current = prev.map((b) => ({ ...b }));
    setSelectedBoxIndex(null);
  }

  // 撤回历史追踪
  useEffect(() => {
    if (selectionMode && !skipHistoryRef.current && !isTransformingRef.current && manualBoxes !== prevBoxesRef.current) {
      historyStackRef.current.push(prevBoxesRef.current.map((b) => ({ ...b })));
      if (historyStackRef.current.length > 50) historyStackRef.current.shift();
    }
    prevBoxesRef.current = manualBoxes.map((b) => ({ ...b }));
    skipHistoryRef.current = false;
  }, [manualBoxes, selectionMode]);

  // 框选提示 5 秒后自动消失
  useEffect(() => {
    if (!showBoxHint) return;
    const timer = setTimeout(() => setShowBoxHint(false), 5000);
    return () => clearTimeout(timer);
  }, [showBoxHint]);

  // 空格键画布平移 + 快捷键（仅抠图模式）
  useEffect(() => {
    function onKeyDown(e) {
      if (!selectionMode || activeTool !== "cutout") return;
      if (e.code === "Space" && !e.repeat && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        isSpaceHeldRef.current = true;
        if (!isPanning) setHoverCursor("grab");
      }
    }
    function onKeyUp(e) {
      if (e.code === "Space") {
        isSpaceHeldRef.current = false;
        if (!isPanning) setHoverCursor("crosshair");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [selectionMode, isPanning, activeTool]);

  // 键盘事件（Delete 删除选中框 / Ctrl+D 复制 / Ctrl+Z 撤回）
  useEffect(() => {
    if (!selectionMode) return;
    function onKey(e) {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement && document.activeElement.tagName === "INPUT") return;
        handleDeleteSelectedBox();
      }
      if (e.key === "Escape") {
        if (cropSelectionMode) {
          setCropSelectionMode(false);
          setCropW(0); setCropH(0); setCropX(0); setCropY(0);
          return;
        }
        setSelectedBoxIndex(null);
        setIsDrawing(false);
        setDrawStart(null);
        setDrawEnd(null);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement && document.activeElement.tagName === "INPUT") return;
        if (cropW > 0 && cropH > 0) {
          setCropW(0); setCropH(0); setCropX(0); setCropY(0);
        } else {
          handleDeleteSelectedBox();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        e.preventDefault();
        if (document.activeElement && document.activeElement.tagName === "INPUT") return;
        handleDuplicateSelectedBox();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (document.activeElement && document.activeElement.tagName === "INPUT") return;
        handleUndo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, selectedBoxIndex, manualBoxes]);

  // 尺寸调整模式快捷键：Delete 清除裁切 / WASD 微调裁切框
  useEffect(() => {
    if (activeTool !== "resize" || !cropSelectionMode) return;
    function onKey(e) {
      if (document.activeElement && document.activeElement.tagName === "INPUT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (cropW > 0 || cropH > 0) {
          setCropW(0); setCropH(0); setCropX(0); setCropY(0);
        }
        return;
      }

      if (e.key === "Escape") {
        if (cropW > 0 || cropH > 0) {
          setCropW(0); setCropH(0); setCropX(0); setCropY(0);
          return;
        }
        setCropSelectionMode(false);
        return;
      }

      // WASD 微调裁切框位置
      if (cropW > 0 && cropH > 0) {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "a" || e.key === "A") { e.preventDefault(); setCropX((x) => Math.max(0, x - step)); }
        if (e.key === "d" || e.key === "D") { e.preventDefault(); setCropX((x) => Math.min(imgNaturalW - cropW, x + step)); }
        if (e.key === "w" || e.key === "W") { e.preventDefault(); setCropY((y) => Math.max(0, y - step)); }
        if (e.key === "s" || e.key === "S") { e.preventDefault(); setCropY((y) => Math.min(imgNaturalH - cropH, y + step)); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, cropSelectionMode, cropW, cropH, imgNaturalW, imgNaturalH]);

  // 同步 timelineClipsRef（供撤销和键盘事件使用）
  useEffect(() => {
    timelineClipsRef.current = timelineClips;
  }, [timelineClips]);

  // 动画模式快捷键：Space 暂停/播放、Delete 删除、A 前移、D 后移、Ctrl+Z 撤回、Ctrl+A 全选
  useEffect(() => {
    if (activeTool !== "animation") return;
    function onKey(e) {
      if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT")) return;

      // Ctrl+Z 撤回
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleTimelineUndo();
        return;
      }

      // Ctrl+A 全选
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSelectedClips(timelineClipsRef.current.map((_, i) => i));
        return;
      }

      // Ctrl+S 导出
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (timelineClipsRef.current.length > 0) downloadAllAnimFrames();
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        setAnimPlaying((p) => !p);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const clips = timelineClipsRef.current;
        if (selectedClips.length > 0) {
          const toDelete = new Set(selectedClips);
          pushTimelineUndo();
          setSelectedClips([]);
          setTimelineClips(clips.filter((_, i) => !toDelete.has(i)));
        }
        return;
      }

      if (e.key === "a" || e.key === "A") {
        if (selectedClips.length > 0) {
          const first = Math.min(...selectedClips);
          if (first > 0) moveClipUp(first);
        }
      }

      if (e.key === "d" || e.key === "D") {
        if (selectedClips.length > 0) {
          const first = Math.min(...selectedClips);
          if (first < timelineClipsRef.current.length - 1) moveClipDown(first);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, selectedClips]);

  // 右键菜单点击外部关闭
  useEffect(() => {
    if (!showContextMenu) return;
    function onClick() { setShowContextMenu(null); }
    window.addEventListener("click", onClick);
    window.addEventListener("contextmenu", onClick);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onClick);
    };
  }, [showContextMenu]);

  // 智能识别对话框键盘事件
  useEffect(() => {
    if (!showSmartDialog) return;
    function onKey(e) {
      if (e.key === "Escape") setShowSmartDialog(false);
      if (e.key === "Enter" && document.activeElement?.tagName !== "INPUT") {
        smartDetectBoxes(smartDetectCount);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSmartDialog, smartDetectCount]);

  // 智能框选：基于内容包围盒 + 用户指定数量做均匀网格切割
  // 对规则排列精灵表（扑克牌、图标等）稳定可靠
  function smartDetectBoxes(count = 4) {
    if (!imageUrl) { alert("请先上传图片"); return; }
    setShowSmartDialog(false);
    setProcessMessage(`正在智能识别素材区域（目标 ${count} 个）...`);
    setProcessStatus("loading");

    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w <= 0 || h <= 0) { setProcessStatus("error"); return; }

      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const total = w * h;

      // === 步骤1：二值化 + 找内容包围盒 ===
      let useAlpha = false;
      for (let p = 0; p < total; p += 1) {
        if (data[p * 4 + 3] < 250) { useAlpha = true; break; }
      }
      let bgR = 255, bgG = 255, bgB = 255;
      if (!useAlpha) {
        const sample = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i+1], data[i+2]]; };
        const corners = [sample(0,0), sample(w-1,0), sample(0,h-1), sample(w-1,h-1)];
        const cTotal = corners.reduce((a, c) => [a[0]+c[0], a[1]+c[1], a[2]+c[2]], [0,0,0]);
        bgR = Math.round(cTotal[0] / 4); bgG = Math.round(cTotal[1] / 4); bgB = Math.round(cTotal[2] / 4);
      }
      const BG_TOL = 35;

      let minX = w, minY = h, maxX = 0, maxY = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          let isContent;
          if (useAlpha) {
            isContent = data[i + 3] > 30;
          } else {
            const dr = data[i] - bgR, dg = data[i+1] - bgG, db = data[i+2] - bgB;
            isContent = (dr*dr + dg*dg + db*db) > BG_TOL * BG_TOL;
          }
          if (isContent) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }

      if (minX > maxX || minY > maxY) {
        setProcessMessage("未检测到内容区域，请手动框选");
        setProcessStatus("error");
        return;
      }

      // 扩展边界：给内容包围盒加 2px padding，确保边缘不被裁剪
      const pad = 2;
      const leftX = Math.max(0, minX - pad);
      const topY = Math.max(0, minY - pad);
      const rightX = Math.min(w - 1, maxX + pad);
      const bottomY = Math.min(h - 1, maxY + pad);
      const contentW = rightX - leftX + 1;
      const contentH = bottomY - topY + 1;

      // === 步骤2：根据 count 推算最优行列数 ===
      const ratio = contentW / Math.max(1, contentH);
      let bestCols = 1, bestRows = 1, bestScore = Infinity;
      for (let cols = 1; cols <= count; cols += 1) {
        if (count % cols !== 0) continue; // 优先精确整除
        const rows = count / cols;
        const score = Math.abs(cols / rows - ratio);
        if (score < bestScore) { bestScore = score; bestCols = cols; bestRows = rows; }
      }
      // 如果无法整除，放宽条件
      if (bestCols === 1 && bestRows === 1) {
        bestScore = Infinity;
        for (let cols = 1; cols <= count; cols += 1) {
          const rows = Math.ceil(count / cols);
          const totalCells = cols * rows;
          const score = Math.abs(totalCells - count) * 3 + Math.abs(cols / rows - ratio) * 1;
          if (score < bestScore) { bestScore = score; bestCols = cols; bestRows = rows; }
        }
      }

      // === 步骤3：均匀网格切割 ===
      const cellW = contentW / bestCols;
      const cellH = contentH / bestRows;
      const boxes = [];
      for (let r = 0; r < bestRows; r += 1) {
        for (let c = 0; c < bestCols; c += 1) {
          if (boxes.length >= count) break;
          const bx = Math.round(leftX + c * cellW);
          const by = Math.round(topY + r * cellH);
          const bw = Math.round((c === bestCols - 1) ? rightX - bx + 1 : cellW);
          const bh = Math.round((r === bestRows - 1) ? bottomY - by + 1 : cellH);
          boxes.push({
            id: generateId("box"),
            x: bx, y: by,
            width: Math.max(1, bw), height: Math.max(1, bh),
          });
        }
      }

      setManualBoxes(boxes);
      setSelectedBoxIndex(null);
      setProcessMessage(`智能识别完成：网格切割 ${boxes.length} 个素材（${bestCols}×${bestRows}），可手动调整`);
      setProcessStatus("success");
    };
    img.onerror = () => {
      setProcessStatus("error");
      setProcessMessage("图片处理失败");
    };
    img.src = imageUrl;
  }

  // 从框选区域生成素材
  function generateAssetsFromBoxes() {
    if (!imageUrl) { alert("请先上传图片"); return; }
    if (!manualBoxes.length) { alert("请先在图片上框选素材区域"); return; }
    setProcessMessage("正在生成素材...");
    setProcessStatus("loading");
    resetZipExport();

    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const result = [];
      for (let i = 0; i < manualBoxes.length; i += 1) {
        const box = manualBoxes[i];
        const sw = Math.max(1, box.width);
        const sh = Math.max(1, box.height);
        const sx = Math.max(0, box.x);
        const sy = Math.max(0, box.y);

        const temp = document.createElement("canvas");
        temp.width = sw;
        temp.height = sh;
        const tctx = temp.getContext("2d");
        tctx.clearRect(0, 0, sw, sh);
        tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        removeBackgroundFromCanvas(temp, bgTolerance, edgeFeather, despill);

        result.push({
          id: `box-${box.id}`,
          box: { x: sx, y: sy, width: sw, height: sh },
          name: `asset_${String(i + 1).padStart(3, "0")}.png`,
          url: temp.toDataURL("image/png"),
          width: sw,
          height: sh,
        });
      }

      setAssets(result);
      // 同时写入素材库
      setAssetLibrary((prev) => [...prev, ...result.map((a) => ({ ...a, source: "cutout" }))]);
      setProcessMessage(`素材生成完成：${result.length} 个素材`);
      setProcessStatus("success");
    };
    img.onerror = () => {
      alert("图片处理失败");
      setProcessStatus("error");
    };
    img.src = imageUrl;
  }

  // ── 尺寸调整：生成裁切缩放后的素材 ──
  function generateResizeAsset() {
    if (!imageUrl) { alert("请先上传图片"); return; }
    if (!imgNaturalW || !imgNaturalH) { alert("图片尚未加载"); return; }

    const img = new Image();
    img.onload = () => {
      // 确定来源区域
      const srcX = cropW > 0 ? cropX : 0;
      const srcY = cropH > 0 ? cropY : 0;
      const srcW = cropW > 0 ? cropW : imgNaturalW;
      const srcH = cropH > 0 ? cropH : imgNaturalH;

      // 输出尺寸 = 来源尺寸 × 缩放系数
      const outW = Math.max(1, Math.round(srcW * resizeScale / 100));
      const outH = Math.max(1, Math.round(srcH * resizeScale / 100));

      const url = applyCropAndScale(img, srcX, srcY, srcW, srcH, outW, outH);
      const name = `resized_${outW}x${outH}.png`;
      const asset = { id: generateId("resize"), name, url, width: outW, height: outH, source: "resize" };

      setAssetLibrary((prev) => [...prev, asset]);
      setSelectedAssetId(asset.id);
      setProcessMessage(`尺寸调整完成：${outW} × ${outH} px`);
      setProcessStatus("success");
    };
    img.onerror = () => {
      alert("图片处理失败");
      setProcessStatus("error");
    };
    setProcessMessage("正在生成裁切素材...");
    setProcessStatus("loading");
    img.src = imageUrl;
  }

  // ── 一键生成素材：素材库所有素材 → 裁切+缩放 → 成品库 ──
  async function batchGenerateToFinished() {
    if (!assetLibrary.length) { alert("素材库为空，请先生成或导入素材"); return; }
    setProcessMessage(`正在一键处理 ${assetLibrary.length} 个素材...`);
    setProcessStatus("loading");

    const finished = [];
    const lib = [...assetLibrary]; // 快照

    for (const asset of lib) {
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error(`加载失败: ${asset.name}`));
          i.src = asset.url;
        });

        // 裁切区域（相对于素材自身尺寸）
        const srcX = cropW > 0 ? Math.min(cropX, img.naturalWidth) : 0;
        const srcY = cropH > 0 ? Math.min(cropY, img.naturalHeight) : 0;
        const srcW = cropW > 0 ? Math.min(cropW, img.naturalWidth - srcX) : img.naturalWidth;
        const srcH = cropH > 0 ? Math.min(cropH, img.naturalHeight - srcY) : img.naturalHeight;

        const outW = Math.max(1, Math.round(srcW * resizeScale / 100));
        const outH = Math.max(1, Math.round(srcH * resizeScale / 100));

        const url = applyCropAndScale(img, srcX, srcY, srcW, srcH, outW, outH);
        const name = asset.name.replace(/\.(png|jpe?g|webp)$/i, `_${outW}x${outH}.png`);
        finished.push({ id: generateId("finished"), name, url, width: outW, height: outH, source: "resize" });
      } catch (err) {
        console.error(err);
      }
    }

    if (finished.length) {
      setAssetLibrary([]);
      setSelectedAssetId(null);
      setFinishedLibrary((prev) => [...prev, ...finished]);
      setProcessMessage(`一键生成完成：${finished.length} 个素材已进入成品库`);
      setProcessStatus("success");
    } else {
      setProcessMessage("处理失败，请检查素材是否有效");
      setProcessStatus("error");
    }
  }

  // ── 素材移入裁切预览 ──
  function moveAssetToCrop(asset) {
    setImageUrl(asset.url);
    setFileName(asset.name);
    setCropW(0); setCropH(0); setCropX(0); setCropY(0);
    setResizeScale(100);
    setCropSelectionMode(true);
    setSelectedAssetId(asset.id);
    const img = new Image();
    img.onload = () => {
      setImgNaturalW(img.naturalWidth);
      setImgNaturalH(img.naturalHeight);
    };
    img.src = asset.url;
    setProcessMessage(`"${asset.name}" 已移入裁切预览`);
    setProcessStatus("success");
  }

  // ── 成品库返回素材库 ──
  function returnToAssetLibrary(asset) {
    setFinishedLibrary((prev) => prev.filter((a) => a.id !== asset.id));
    setAssetLibrary((prev) => [...prev, { ...asset, source: asset.source === "finished" ? "cutout" : (asset.source || "cutout") }]);
    setProcessMessage(`"${asset.name}" 已返回素材库`);
    setProcessStatus("success");
  }

  // ── 尺寸调整：确认选中素材进入成品库 ──
  function confirmToFinished() {
    if (!selectedAssetId) { alert("请先在素材库中选择一个素材"); return; }
    const asset = assetLibrary.find((a) => a.id === selectedAssetId);
    if (!asset) { setSelectedAssetId(null); return; }
    // 从素材库移除
    setAssetLibrary((prev) => prev.filter((a) => a.id !== asset.id));
    // 加入成品库（标记为 finished + 时间戳）
    const finishedAsset = { ...asset, source: "finished", finishedAt: Date.now() };
    setFinishedLibrary((prev) => [...prev, finishedAsset]);
    setSelectedAssetId(null);
    setProcessMessage(`素材已确认：${asset.name} → 成品库`);
    setProcessStatus("success");
  }

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function removeBackgroundFromCanvas(canvas, tolerance, feather, enableDespill) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;
    if (width <= 0 || height <= 0) return;

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // 从四条边的所有像素采样背景色（比仅采四角更可靠）
    const edgeSamples = [];
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 20))) {
      edgeSamples.push([data[(x) * 4], data[(x) * 4 + 1], data[(x) * 4 + 2]]);
      edgeSamples.push([data[((height - 1) * width + x) * 4], data[((height - 1) * width + x) * 4 + 1], data[((height - 1) * width + x) * 4 + 2]]);
    }
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 20))) {
      edgeSamples.push([data[(y * width) * 4], data[(y * width) * 4 + 1], data[(y * width) * 4 + 2]]);
      edgeSamples.push([data[(y * width + width - 1) * 4], data[(y * width + width - 1) * 4 + 1], data[(y * width + width - 1) * 4 + 2]]);
    }
    const bg = edgeSamples.reduce((acc, c) => [acc[0] + c[0] / edgeSamples.length, acc[1] + c[1] / edgeSamples.length, acc[2] + c[2] / edgeSamples.length], [0, 0, 0]);

    // 逐像素阈值判断：每个像素独立与背景色比较，不依赖泛洪填充
    // 这样不会出现"沿边缘泄漏进素材内部"的问题
    const alphaMap = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const dr = data[i] - bg[0];
        const dg = data[i + 1] - bg[1];
        const db = data[i + 2] - bg[2];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);

        // 平滑过渡：dist <= tolerance 完全透明，dist >= tolerance*1.4 完全不透明
        const tLow = tolerance;
        const tHigh = tolerance * 1.4;
        if (dist <= tLow) {
          alphaMap[y * width + x] = 0;
        } else if (dist >= tHigh) {
          alphaMap[y * width + x] = 1;
        } else {
          alphaMap[y * width + x] = (dist - tLow) / (tHigh - tLow);
        }
      }
    }

    // 边缘羽化：对 alpha 通道做均值模糊
    if (feather > 0) {
      const blurred = new Float32Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let sum = 0, count = 0;
          const r = feather;
          for (let dy = -r; dy <= r; dy += 1) {
            for (let dx = -r; dx <= r; dx += 1) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                sum += alphaMap[ny * width + nx];
                count += 1;
              }
            }
          }
          blurred[y * width + x] = sum / count;
        }
      }
      for (let p = 0; p < width * height; p += 1) {
        alphaMap[p] = blurred[p];
      }
    }

    // 应用 alpha
    for (let p = 0; p < width * height; p += 1) {
      const alpha = alphaMap[p];
      const i = p * 4;
      data[i + 3] = clampByte(data[i + 3] * alpha);
      if (enableDespill && alpha < 1) {
        const spill = 1 - alpha;
        data[i] = clampByte(data[i] - bg[0] * spill * 0.18);
        data[i + 1] = clampByte(data[i + 1] - bg[1] * spill * 0.18);
        data[i + 2] = clampByte(data[i + 2] - bg[2] * spill * 0.18);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function downloadAsset(asset) {
    if (!asset || !asset.url) return;
    const link = document.createElement("a");
    link.href = asset.url;
    link.download = asset.name || "asset.png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ── 通用 ZIP 导出 ──
  function createZipExport(sourceList, zipName, emptyMsg, successMsg) {
    const list = safeArray(sourceList).filter((item) => item && item.url);
    if (!list.length) { alert(emptyMsg); return; }
    try {
      setProcessMessage("正在生成 ZIP 文件...");
      setProcessStatus("loading");
      resetZipExport();
      const files = list.map((asset, i) => ({
        name: asset.name || `asset_${String(i + 1).padStart(3, "0")}.png`,
        data: dataUrlToUint8Array(asset.url),
      }));
      runZipTests(files);
      const zipBytes = createZipBytes(files);
      const base64 = uint8ArrayToBase64(zipBytes);
      const blobUrl = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
      setZipBlobUrl(blobUrl);
      setZipDownloadUrl(`data:application/zip;base64,${base64}`);
      setZipDownloadName(zipName);
      setZipBase64(base64);
      setProcessMessage(successMsg(list.length, zipName));
      setProcessStatus("success");
    } catch (error) {
      console.error(error);
      alert("批量导出失败，请尝试单个下载");
      setProcessStatus("error");
    }
  }

  function generateZip() {
    createZipExport(assets, `${baseName(fileName)}.zip`,
      "请先框选素材区域并生成素材，生成 PNG 后再批量导出",
      (n, name) => `ZIP 已就绪：${name}（共 ${n} 个文件）`);
  }

  function generateLibraryZip() {
    createZipExport(assetLibrary, "素材库导出.zip",
      "素材库为空，请先生成或导入素材",
      (n) => `ZIP 已就绪：素材库导出.zip（共 ${n} 个文件）`);
  }

  function generateFinishedZip() {
    createZipExport(finishedLibrary, "成品库导出.zip",
      "成品库为空，请先确认素材",
      (n) => `ZIP 已就绪：成品库导出.zip（共 ${n} 个文件）`);
  }

  // ── 批量下载（复用 batchDownloadAll） ──
  function downloadAllPngOneByOne() {
    const list = safeArray(assets).filter((asset) => asset && asset.url);
    if (!list.length) { alert("请先框选素材区域并生成素材，生成 PNG 后再批量导出"); return; }
    batchDownloadAll(list);
    setProcessMessage(`已开始逐个下载 ${list.length} 个 PNG，如浏览器拦截请允许多文件下载`);
  }

  function downloadAllLibraryPngs() {
    const list = safeArray(assetLibrary).filter((a) => a && a.url);
    if (!list.length) { alert("素材库为空"); return; }
    batchDownloadAll(list);
    setProcessMessage(`已开始逐个下载 ${list.length} 个 PNG，如浏览器拦截请允许多文件下载`);
  }

  function downloadAllFinishedPngs() {
    const list = safeArray(finishedLibrary).filter((a) => a && a.url);
    if (!list.length) { alert("成品库为空"); return; }
    batchDownloadAll(list);
    setProcessMessage(`已开始逐个下载 ${list.length} 个成品 PNG，如浏览器拦截请允许多文件下载`);
  }

  function dataUrlToUint8Array(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) throw new Error("无效的图片数据");
    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function stringToUtf8(str) { return new TextEncoder().encode(str); }

  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  function createZipBytes(files) {
    const localParts = [], centralParts = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = stringToUtf8(file.name);
      const data = file.data;
      const crc = crc32(data);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);

    const parts = [...localParts, ...centralParts, end];
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(totalLength);
    let position = 0;
    parts.forEach((part) => { output.set(part, position); position += part.length; });
    return output;
  }

  function uint8ArrayToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
    }
    return btoa(binary);
  }

  function runZipTests(files) {
    console.assert(Array.isArray(files), "ZIP test: files must be an array");
    console.assert(files.length > 0, "ZIP test: files should not be empty");
    console.assert(files.every((f) => f.name && f.data instanceof Uint8Array), "ZIP test: each file needs name and Uint8Array data");
    const testZip = createZipBytes([{ name: "test.txt", data: stringToUtf8("ok") }]);
    console.assert(testZip instanceof Uint8Array && testZip.length > 0, "ZIP test: generated zip should be non-empty");
    console.assert(crc32(stringToUtf8("123456789")) === 0xcbf43926, "ZIP test: CRC32 known vector should match");
  }

  function forceDownloadZip() {
    if (!zipDownloadUrl) { alert('请先点击「生成 ZIP」'); return; }
    const link = document.createElement("a");
    link.href = zipDownloadUrl;
    link.download = zipDownloadName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function openZipInNewTab() {
    const url = zipBlobUrl || zipDownloadUrl;
    if (!url) { alert('请先点击「生成 ZIP」'); return; }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function copyZipBase64() {
    if (!zipBase64) { alert('请先点击「生成 ZIP」'); return; }
    setShowBase64(true);
    setProcessMessage('预览环境禁止自动复制，请手动复制下方 Base64 文本。');
  }

  function clearProject() {
    resetZipExport();
    setImageUrl(""); setFileName("");
    setAssets([]); setDetectedBoxes([]); setAssetLibrary([]); setFinishedLibrary([]); setSelectedAssetId(null);
    setCropW(0); setCropH(0); setCropX(0); setCropY(0);
    setProcessMessage("等待上传图片");
    setProcessStatus("idle");
    setTimelineClips([]);
    setSelectedClips([]);
    setCurrentTimeMs(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /* ─────────────────────── 动画拼接函数 ─────────────────────── */

  // 从 ZIP 文件导入帧序列
  async function handleZipImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessMessage("正在解析 ZIP 文件...");
    setProcessStatus("loading");
    try {
      const zip = await JSZip.loadAsync(file);
      // 过滤出 PNG 文件并按文件名排序
      const pngFiles = Object.keys(zip.files)
        .filter((name) => /\.png$/i.test(name) && !zip.files[name].dir)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      if (!pngFiles.length) {
        setProcessMessage("ZIP 文件中未找到 PNG 图片");
        setProcessStatus("error");
        return;
      }

      const imported = [];
      for (const name of pngFiles) {
        const blob = await zip.files[name].async("blob");
        const url = URL.createObjectURL(blob);
        const dims = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve({ width: 64, height: 64 });
          img.src = url;
        });
        imported.push({
          id: generateId("lib"),
          name,
          url,
          width: dims.width,
          height: dims.height,
          source: "zip",
        });
      }

      setAssetLibrary((prev) => [...prev, ...imported]);
      setProcessMessage(`已导入 ${imported.length} 个素材到素材库（来自 ${file.name}）`);
      setProcessStatus("success");
    } catch (err) {
      console.error(err);
      setProcessMessage("ZIP 文件解析失败");
      setProcessStatus("error");
    }
    // 清空 input 以允许重复选择同一文件
    e.target.value = "";
  }

  // 导入单张/多张图片到素材库
  async function handleImageImport(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setProcessMessage(`正在导入 ${files.length} 张图片...`);
    setProcessStatus("loading");
    try {
      const imported = [];
      for (const file of files) {
        const url = URL.createObjectURL(file);
        const dims = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve({ width: 64, height: 64 });
          img.src = url;
        });
        imported.push({
          id: generateId("lib"),
          name: file.name,
          url,
          width: dims.width,
          height: dims.height,
          source: "image",
        });
      }
      setAssetLibrary((prev) => [...prev, ...imported]);
      setProcessMessage(`已导入 ${imported.length} 张图片到素材库`);
      setProcessStatus("success");
    } catch (err) {
      console.error(err);
      setProcessMessage("图片导入失败");
      setProcessStatus("error");
    }
    e.target.value = "";
  }

  function addFrameToAnimation(asset) {
    if (!asset || !asset.url) return;
    const newClip = {
      id: generateId("clip"),
      assetUrl: asset.url,
      assetName: asset.name,
      assetWidth: asset.width || 64,
      assetHeight: asset.height || 64,
      durationMs: 500,
    };
    setTimelineClips((prev) => [...prev, newClip]);
    setProcessMessage(`已添加 "${asset.name}" 到时间轴（共 ${timelineClips.length + 1} 段）`);
    setProcessStatus("success");
  }

  // ── 时间轴撤回 ──
  function pushTimelineUndo() {
    timelineUndoRef.current.push(timelineClipsRef.current.map((c) => ({ ...c })));
    if (timelineUndoRef.current.length > 80) timelineUndoRef.current.shift();
  }
  function handleTimelineUndo() {
    const stack = timelineUndoRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop();
    setTimelineClips(prev);
    setSelectedClips([]);
  }

  function removeClipFromTimeline(index) {
    pushTimelineUndo();
    setTimelineClips((prev) => prev.filter((_, i) => i !== index));
  }

  function moveClipUp(index) {
    if (index <= 0) return;
    pushTimelineUndo();
    setTimelineClips((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
    setSelectedClips((prev) => {
      if (!prev.includes(index)) return prev;
      return prev.map((i) => i === index ? index - 1 : i);
    });
  }

  function moveClipDown(index) {
    pushTimelineUndo();
    setTimelineClips((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
    setSelectedClips((prev) => {
      if (!prev.includes(index)) return prev;
      return prev.map((i) => i === index ? index + 1 : i);
    });
  }

  // 时间轴拖拽调整片段时长
  function handleResizeStart(e, index, edge, currentDuration, prevDuration) {
    e.preventDefault();
    e.stopPropagation();
    resizePreStateRef.current = timelineClipsRef.current.map((c) => ({ ...c }));
    const info = {
      index,
      edge,
      startX: e.clientX,
      startDuration: currentDuration,
      startPrevDuration: edge === "left" && index > 0 ? prevDuration : null,
    };
    setResizingClip(info);
    resizingRef.current = info;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    if (!resizingClip) return;
    const handleMove = (e) => {
      const info = resizingRef.current;
      if (!info) return;
      const deltaX = e.clientX - info.startX;
      const deltaMs = Math.round(deltaX * (1000 / timelineZoomRef.current));
      const snapMs = Math.round(deltaMs / 50) * 50; // 50ms 对齐

      setTimelineClips((prev) => {
        const next = [...prev];
        if (info.edge === "right") {
          // 拖动右边缘：调整当前片段时长
          const newDur = Math.max(MIN_CLIP_MS, info.startDuration + snapMs);
          next[info.index] = { ...next[info.index], durationMs: newDur };
        } else if (info.edge === "left" && info.index > 0) {
          // 拖动左边缘：调整前一个片段和当前片段的时长（总量不变）
          const prevNew = Math.max(MIN_CLIP_MS, info.startPrevDuration + snapMs);
          const currNew = Math.max(MIN_CLIP_MS, info.startDuration - snapMs);
          // 确保总量不变：一增一减
          const actualDelta = prevNew - info.startPrevDuration;
          next[info.index - 1] = { ...next[info.index - 1], durationMs: info.startPrevDuration + actualDelta };
          next[info.index] = { ...next[info.index], durationMs: info.startDuration - actualDelta };
        }
        return next;
      });
    };
    const handleUp = () => {
      if (resizePreStateRef.current) {
        timelineUndoRef.current.push(resizePreStateRef.current);
        if (timelineUndoRef.current.length > 80) timelineUndoRef.current.shift();
        resizePreStateRef.current = null;
      }
      setResizingClip(null);
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizingClip]);


  async function exportSpriteSheet() {
    if (!timelineClips.length) { alert('请先添加片段到时间轴'); return; }
    setProcessMessage("正在生成精灵表...");
    setProcessStatus("loading");
    try {
      // 精灵表只取每段的静态图
      const frames = timelineClips.map((c) => ({ url: c.assetUrl, width: c.assetWidth, height: c.assetHeight }));
      const url = await generateSpriteSheetDataURL(frames, spriteLayout, spriteCols);
      const link = document.createElement("a");
      link.href = url; link.download = `${baseName(fileName)}_spritesheet.png`;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setProcessMessage("精灵表已导出");
      setProcessStatus("success");
    } catch (e) {
      console.error(e);
      setProcessMessage("精灵表生成失败");
      setProcessStatus("error");
    }
  }

  function downloadAllAnimFrames() {
    if (!timelineClips.length) { alert('请先添加片段到时间轴'); return; }
    timelineClips.forEach((clip, i) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = clip.assetUrl;
        link.download = clip.assetName || `frame_${String(i + 1).padStart(3, "0")}.png`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
      }, i * 180);
    });
    setProcessMessage(`已开始逐个下载 ${timelineClips.length} 个帧 PNG`);
  }

  async function exportMP4() {
    if (!timelineClips.length) { alert('请先添加片段到时间轴'); return; }
    setProcessMessage("正在生成 MP4 视频...");
    setProcessStatus("loading");
    try {
      const maxW = Math.max(...timelineClips.map((c) => c.assetWidth || 64));
      const maxH = Math.max(...timelineClips.map((c) => c.assetHeight || 64));
      const w = maxW % 2 ? maxW + 1 : maxW;
      const h = maxH % 2 ? maxH + 1 : maxH;

      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");

      const imgs = await Promise.all(timelineClips.map((c) => loadImageElement(c.assetUrl)));

      const stream = canvas.captureStream(animFPS);
      const mimeTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      let mime = "";
      for (const mt of mimeTypes) { if (MediaRecorder.isTypeSupported(mt)) { mime = mt; break; } }
      if (!mime) { throw new Error("浏览器不支持视频录制"); }

      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      const recorderDone = new Promise((resolve) => { recorder.onstop = resolve; });

      recorder.start();

      // 根据时间轴片段生成视频帧
      const frameMs = 1000 / animFPS;
      for (let ci = 0; ci < timelineClips.length; ci++) {
        const clip = timelineClips[ci];
        const totalFrames = Math.max(1, Math.round(clip.durationMs / frameMs));
        for (let fi = 0; fi < totalFrames; fi++) {
          ctx.fillStyle = "#080c14"; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(imgs[ci], (w - (clip.assetWidth || w)) / 2, (h - (clip.assetHeight || h)) / 2);
          await new Promise((r) => setTimeout(r, frameMs));
        }
      }
      // 多持最后一帧
      await new Promise((r) => setTimeout(r, frameMs));

      recorder.stop();
      await recorderDone;

      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const totalDuration = animTotalDuration;
      const link = document.createElement("a");
      link.href = url; link.download = `${baseName(fileName)}_anim.${ext}`;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setProcessMessage(`视频已导出（${ext.toUpperCase()}）：${w}×${h}，${timelineClips.length} 段，总时长 ${(totalDuration / 1000).toFixed(1)}s，${animFPS} FPS`);
      setProcessStatus("success");
    } catch (e) {
      console.error(e);
      setProcessMessage("视频生成失败：" + (e.message || "未知错误"));
      setProcessStatus("error");
    }
  }

  /* ── 动画预览播放器（时间驱动）── */
  const totalElapsedRef = useRef(0);
  const lastTimestampRef = useRef(0);
  const animRafRef = useRef(null);
  const loopCounterRef = useRef(0);
  const [currentClipIndex, setCurrentClipIndex] = useState(-1);

  // 播放/暂停切换时重置计时
  useEffect(() => {
    if (animPlaying && timelineClips.length) {
      totalElapsedRef.current = 0;
      lastTimestampRef.current = 0;
      loopCounterRef.current = 0;
      setCurrentClipIndex(0);
      setCurrentTimeMs(0);
    }
  }, [animPlaying, timelineClips]);

  useEffect(() => {
    if (activeTool !== "animation" || !animPlaying || !timelineClips.length) {
      if (animRafRef.current) { cancelAnimationFrame(animRafRef.current); animRafRef.current = null; }
      return;
    }
    const canvas = animationCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const imgs = timelineClips.map((c) => {
      const img = new Image(); img.src = c.assetUrl; return img;
    });
    const maxW = Math.max(...timelineClips.map((c) => c.assetWidth || 64));
    const maxH = Math.max(...timelineClips.map((c) => c.assetHeight || 64));
    canvas.width = maxW; canvas.height = maxH;

    // 计算累计时长数组，用于查找当前片段
    const cumulativeDurations = [];
    let cum = 0;
    for (const clip of timelineClips) {
      cum += clip.durationMs;
      cumulativeDurations.push(cum);
    }
    const totalDuration = cumulativeDurations[cumulativeDurations.length - 1] || 0;
    lastTimestampRef.current = 0;

    const render = (timestamp) => {
      if (!lastTimestampRef.current) lastTimestampRef.current = timestamp;
      const delta = timestamp - lastTimestampRef.current;
      lastTimestampRef.current = timestamp;
      totalElapsedRef.current += delta;

      // 循环/停止逻辑
      if (totalElapsedRef.current >= totalDuration) {
        if (animLoopCount === 0) {
          // 无限循环
          totalElapsedRef.current = totalElapsedRef.current % totalDuration;
          loopCounterRef.current += 1;
        } else {
          loopCounterRef.current += 1;
          if (loopCounterRef.current >= animLoopCount) {
            setAnimPlaying(false);
            setCurrentClipIndex(timelineClips.length - 1);
            return;
          }
          totalElapsedRef.current = totalElapsedRef.current % totalDuration;
        }
      }

      // 根据累计时间找到当前应显示的片段
      const t = totalElapsedRef.current;
      let ci = 0;
      while (ci < cumulativeDurations.length && cumulativeDurations[ci] < t) {
        ci += 1;
      }
      ci = Math.min(ci, timelineClips.length - 1);

      const img = imgs[ci];
      const clip = timelineClips[ci];
      if (img && img.complete) {
        ctx.clearRect(0, 0, maxW, maxH);
        ctx.drawImage(img, (maxW - (clip.assetWidth || maxW)) / 2, (maxH - (clip.assetHeight || maxH)) / 2);
      }
      setCurrentClipIndex(ci);

      // 更新播放头位置（直接操作 DOM 避免每帧触发 React 重渲染）
      const ph = playheadLineRef.current;
      if (ph) {
        const px = (totalElapsedRef.current / 1000) * timelineZoomRef.current;
        ph.style.transform = `translateX(${px}px)`;
      }
      // 用 state 更新 currentTimeMs（大约 10fps 就够 UI 显示了）
      setCurrentTimeMs((prev) => {
        const now = totalElapsedRef.current;
        return Math.abs(now - prev) > 60 ? now : prev;
      });

      // 自动滚动保持播放头可见
      const track = timelineTrackRef.current;
      if (track) {
        const px = (totalElapsedRef.current / 1000) * timelineZoomRef.current;
        const trackWidth = track.scrollWidth;
        const viewWidth = track.clientWidth;
        if (trackWidth > viewWidth) {
          const targetScroll = px - viewWidth * 0.3;
          if (targetScroll > 0 && targetScroll < trackWidth - viewWidth) {
            track.scrollLeft = Math.max(0, targetScroll);
          }
        }
      }

      animRafRef.current = requestAnimationFrame(render);
    };
    animRafRef.current = requestAnimationFrame(render);
    return () => { if (animRafRef.current) cancelAnimationFrame(animRafRef.current); };
  }, [activeTool, animPlaying, timelineClips, animLoopCount]);

  /* ─────────────────────── 预览数据 ─────────────────────── */



  return (
    <div className="min-h-screen bg-[#080c14] text-white">
      {/* 全局动效样式 */}
      <style>{`
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeIn .3s ease-out forwards}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        .shimmer-text{background:linear-gradient(90deg,#67e8f9,#a78bfa,#67e8f9);background-size:200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 4s linear infinite}
        .glass{background:rgba(255,255,255,0.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
        .glow-cyan{box-shadow:0 0 40px rgba(34,211,238,0.08),inset 0 1px 0 rgba(255,255,255,0.05)}
        .glow-violet{box-shadow:0 0 40px rgba(167,139,250,0.08),inset 0 1px 0 rgba(255,255,255,0.05)}
        input[type=range]{-webkit-appearance:none;height:4px;border-radius:9999px;background:rgba(255,255,255,0.1);outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:9999px;background:#22d3ee;cursor:pointer;box-shadow:0 0 8px rgba(34,211,238,0.5)}
        input[type=range]:hover::-webkit-slider-thumb{background:#67e8f9}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:9999px}
        ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.2)}
        .drag-over{border-color:rgba(34,211,238,0.6)!important;background:rgba(34,211,238,0.05)!important}
        .card-hover{transition:transform 0.2s ease,box-shadow 0.2s ease}
        .card-hover:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(0,0,0,0.3)}
        .custom-scroll::-webkit-scrollbar{height:6px}
        .custom-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,0.02);border-radius:9999px}
        .custom-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:9999px}
        .custom-scroll::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.15)}
      `}</style>

      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={animationCanvasRef} className="hidden" />
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleUpload} className="hidden" />

      {/* ── 顶部渐变装饰 ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl" />
        <div className="absolute -top-20 -right-20 w-80 h-80 bg-violet-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-slate-900/20 rounded-full blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-[1440px] px-5 py-5">
        {/* ──────── Header ──────── */}
        <header className="flex flex-col gap-4 border-b border-white/[0.06] pb-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            {/* Logo */}
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500 shadow-lg shadow-cyan-500/20">
              <Icon name="magic" size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight shimmer-text">游戏素材处理工作台</h1>
                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300">Beta</span>
              </div>
              <p className="text-[13px] text-slate-400">上传 Sprite Sheet，智能切割 · 抠透明背景 · 批量导出 PNG / ZIP</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {imageUrl && (
              <Button
                onClick={clearProject}
                className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-slate-300 hover:bg-white/10 hover:text-white"
              >
                <Icon name="trash" size={14} />
                清空项目
              </Button>
            )}
            <Button
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              className="rounded-xl bg-gradient-to-r from-cyan-400 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-cyan-300 hover:to-cyan-400"
            >
              <Icon name="upload" size={14} />
              上传图片
            </Button>
          </div>
        </header>

        {/* ──────── Main Grid ──────── */}
        <main className="grid gap-5 pt-5 lg:grid-cols-[260px_1fr_320px]">

          {/* ── 左侧：工具 & 参数 ── */}
          <aside className="space-y-3">
            {/* 工具列表 */}
            <ToolSidebar activeTool={activeTool} onSelect={setActiveTool} />

            {/* 参数面板 */}
            <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-cyan">
              <div className="mb-4 flex items-center gap-2">
                <Icon name="sliders" size={14} />
                <span className="text-[13px] font-semibold text-white">处理参数</span>
              </div>

              {/* 缩放 */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] text-slate-400">预览缩放</label>
                  <span className="text-[12px] font-mono text-cyan-300">{scale}%</span>
                </div>
                {activeTool === "resize" && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <button onClick={() => setScale((p) => Math.max(20, p - 10))} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-400 hover:bg-white/10 hover:text-white transition">−</button>
                    <input
                      type="number"
                      min="20" max="200"
                      value={scale}
                      onChange={(e) => { const v = Number(e.target.value); if (v >= 20 && v <= 200) setScale(v); }}
                      className="h-7 w-14 rounded-lg border border-white/[0.08] bg-black/30 text-center text-[12px] font-mono text-cyan-300 outline-none focus:border-cyan-400/40 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <button onClick={() => setScale((p) => Math.min(200, p + 10))} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-400 hover:bg-white/10 hover:text-white transition">+</button>
                  </div>
                )}
                <input type="range" min="20" max="200" value={scale} onChange={(e) => setScale(Number(e.target.value))} className="w-full" />
              </div>

              {/* 高级参数 */}
              <div className="space-y-3 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">高级参数</p>
                {[
                  { label: "抠图容差", value: bgTolerance, min: 10, max: 160, setter: setBgTolerance },
                  { label: "边缘羽化", value: edgeFeather, min: 0, max: 6, setter: setEdgeFeather, unit: "px" },
                ].map(({ label, value, min, max, setter, unit }) => (
                  <div key={label}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[12px] text-slate-400">{label}</label>
                      <span className="text-[12px] font-mono text-cyan-300">{value}{unit || ""}</span>
                    </div>
                    <input type="range" min={min} max={max} value={value} onChange={(e) => setter(Number(e.target.value))} className="w-full" />
                  </div>
                ))}
                <label className="flex cursor-pointer items-center gap-2.5 mt-1">
                  <div
                    onClick={() => setDespill(!despill)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${despill ? "bg-cyan-400" : "bg-white/10"}`}
                  >
                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${despill ? "left-4" : "left-0.5"}`} />
                  </div>
                  <span className="text-[12px] text-slate-400">去除背景色边</span>
                </label>
              </div>
            </div>
          </aside>

          {/* ── 中央：主预览区 ── */}
          {activeTool === "animation" ? (
            /* ═══════════ 帧动画拼接编辑器 ═══════════ */
            <section className="space-y-4 min-w-0">
              {/* 动画信息栏 */}
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] glass px-4 py-3 glow-violet">
                <div className="flex items-center gap-3">
                  <span className="text-[13px] font-semibold text-white">动画预览</span>
                  <span className="rounded-full bg-violet-400/20 px-2 py-0.5 text-[11px] font-semibold text-violet-300">
                    {timelineClips.length} 段
                  </span>
                  <span className="text-[12px] text-slate-400">|</span>
                  <span className="text-[12px] text-slate-400">总时长 {formatTimelineDuration(timelineClips).split(" · ")[1]}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={downloadAllAnimFrames}
                    disabled={!timelineClips.length}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold transition ${timelineClips.length ? "bg-gradient-to-r from-violet-400 to-violet-500 text-white shadow-lg shadow-violet-500/20 hover:from-violet-300 hover:to-violet-400" : "bg-white/[0.06] text-slate-600 cursor-not-allowed"}`}
                  >
                    <Icon name="download" size={12} />
                    导出 (Ctrl+S)
                  </button>
                  <button
                    onClick={() => setShowShortcutHints(!showShortcutHints)}
                    title="快捷键"
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold transition ${
                      showShortcutHints
                        ? "border border-violet-400/40 bg-violet-400/10 text-violet-300"
                        : "border border-white/[0.08] bg-white/[0.06] text-slate-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                    快捷键
                  </button>
                </div>
              </div>

              {/* 动画预览 Canvas */}
              <div className="rounded-3xl border border-violet-400/10 glass overflow-hidden glow-violet">
                <div
                  className="min-h-[320px] p-6 grid place-items-center"
                  style={{
                    backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.03) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.03) 75%),linear-gradient(45deg,rgba(255,255,255,.03) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.03) 75%)",
                    backgroundSize: "24px 24px", backgroundPosition: "0 0, 12px 12px",
                  }}
                >
                  {!timelineClips.length ? (
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-400/10 text-violet-300">
                        <Icon name="film" size={24} />
                      </div>
                      <div className="text-[13px] text-slate-400">
                        时间轴为空
                      </div>
                      <p className="text-[11px] text-slate-500 max-w-[260px]">
                        从右侧「素材库」点击「添加到时间轴」来构建动画序列
                      </p>
                    </div>
                  ) : (
                    <canvas ref={animationCanvasRef} className="max-w-full rounded-xl shadow-2xl" />
                  )}
                </div>
              </div>

              {/* 播放控制 */}
              <div className="flex justify-center">
                <button
                  onClick={() => setAnimPlaying(!animPlaying)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-violet-400/30 bg-violet-400/10 text-violet-300 hover:bg-violet-400/20 transition"
                >
                  <Icon name={animPlaying ? "pause" : "play"} size={16} />
                </button>
              </div>

              {/* 时间轴 */}
              <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-violet">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon name="film" size={14} />
                    <span className="text-[13px] font-semibold text-white">时间轴</span>
                    <span className="text-[11px] text-slate-400">
                      {timelineStats}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedClips.length === 1 && timelineClips[selectedClips[0]] && (() => {
                      const idx = selectedClips[0];
                      return (
                        <>
                          <span className="text-[11px] text-slate-400">#{idx + 1}</span>
                          <button
                            onClick={() => moveClipUp(idx)}
                            disabled={idx === 0}
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium transition ${idx === 0 ? "text-slate-600 cursor-not-allowed" : "text-slate-400 hover:text-white hover:bg-white/[0.08]"}`}
                            title="上移"
                          >↑</button>
                          <button
                            onClick={() => moveClipDown(idx)}
                            disabled={idx === timelineClips.length - 1}
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium transition ${idx === timelineClips.length - 1 ? "text-slate-600 cursor-not-allowed" : "text-slate-400 hover:text-white hover:bg-white/[0.08]"}`}
                            title="下移"
                          >↓</button>
                          <button
                            onClick={() => { removeClipFromTimeline(idx); setSelectedClips([]); }}
                            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-red-400 hover:text-red-300 hover:bg-red-400/10 transition"
                            title="删除"
                          >✕</button>
                          <span className="text-[11px] text-slate-400">|</span>
                          <span className="text-[11px] text-slate-400">时长</span>
                          <select
                            value={timelineClips[idx].durationMs}
                            onChange={(e) => {
                              const newDuration = Number(e.target.value);
                              pushTimelineUndo();
                              setTimelineClips((prev) => {
                                const next = [...prev];
                                next[idx] = { ...next[idx], durationMs: newDuration };
                                return next;
                              });
                            }}
                            className="rounded-lg border border-white/[0.08] bg-slate-900/80 px-2 py-1 text-[11px] text-violet-300 text-center outline-none focus:border-violet-400/40 transition w-16"
                          >
                            <option value={100}>100ms</option>
                            <option value={200}>200ms</option>
                            <option value={300}>300ms</option>
                            <option value={500}>500ms</option>
                            <option value={750}>750ms</option>
                            <option value={1000}>1s</option>
                            <option value={1500}>1.5s</option>
                            <option value={2000}>2s</option>
                            <option value={3000}>3s</option>
                            <option value={5000}>5s</option>
                          </select>
                        </>
                      );
                    })()}
                    {selectedClips.length > 1 && (
                      <>
                        <span className="text-[11px] text-blue-400 font-semibold">已选 {selectedClips.length} 段</span>
                        <button
                          onClick={() => {
                            pushTimelineUndo();
                            const toDelete = new Set(selectedClips);
                            setSelectedClips([]);
                            setTimelineClips((prev) => prev.filter((_, i) => !toDelete.has(i)));
                          }}
                          className="rounded-md px-2 py-1 text-[10px] font-medium text-red-400 hover:text-red-300 hover:bg-red-400/10 transition"
                          title="删除选中"
                        >删除选中</button>
                      </>
                    )}
                    {timelineClips.length > 0 && (
                      <button
                        onClick={() => { setTimelineClips([]); setCurrentClipIndex(-1); setSelectedClips([]); setCurrentTimeMs(0); }}
                        className="rounded-lg border border-white/[0.08] bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-white hover:bg-white/10 transition"
                      >
                        <Icon name="trash" size={11} />
                        <span className="ml-1">清空</span>
                      </button>
                    )}
                  </div>
                </div>
                {!timelineClips.length ? (
                  <div className="rounded-xl border border-dashed border-white/[0.06] py-6 text-center">
                    <p className="text-[12px] text-slate-500">时间轴为空</p>
                    <p className="mt-1 text-[11px] text-slate-600">从右侧素材库添加素材到时间轴</p>
                  </div>
                ) : (
                  <div>
                    {/* 时间标尺 */}
                    <div className="overflow-hidden rounded-t-xl border border-white/[0.04] bg-black/20 mb-px">
                      <div className="relative" style={{ width: "100%", height: "24px" }}>
                        <div
                          ref={timelineRulerInnerRef}
                          className="absolute top-0 left-0 h-full"
                          style={{
                            width: `${Math.max(100, (animTotalDuration / 1000) * timelineZoom)}px`,
                          }}
                        >
                          {(() => {
                            const total = animTotalDuration;
                            const pps = timelineZoom;
                            const interval = pps >= 200 ? 200 : pps >= 100 ? 500 : 1000;
                            const ticks = [];
                            const endMs = Math.max(total, 1000);
                            for (let ms = 0; ms <= endMs; ms += interval) {
                              const px = (ms / 1000) * pps;
                              const isSecond = ms % 1000 === 0;
                              ticks.push(
                                <div key={ms} className="absolute top-0" style={{ left: `${px}px`, height: "100%" }}>
                                  <div className={`absolute top-0 ${isSecond ? "w-px h-full bg-white/15" : "w-px h-3 bg-white/[0.06]"}`} style={{ left: 0 }} />
                                  {isSecond && (
                                    <span className="absolute top-1 left-1.5 text-[10px] text-slate-500 whitespace-nowrap select-none">
                                      {ms / 1000}s
                                    </span>
                                  )}
                                </div>
                              );
                            }
                            return ticks;
                          })()}
                        </div>
                      </div>
                    </div>
                    {/* 轨道 */}
                    <div
                      ref={(el) => { timelineTrackRef.current = el; timelineScrollRef.current = el; }}
                      className="overflow-x-auto rounded-b-xl border border-white/[0.04] bg-black/20 custom-scroll"
                      style={{ height: "106px", position: "relative" }}
                      onScroll={() => {
                        const ruler = timelineRulerInnerRef.current;
                        const track = timelineScrollRef.current;
                        if (ruler && track) {
                          ruler.style.transform = `translateX(${-track.scrollLeft}px)`;
                        }
                      }}
                    >
                      <div
                        className="relative"
                        onClick={() => setSelectedClips([])}
                        style={{
                          width: `${Math.max(100, (animTotalDuration / 1000) * timelineZoom)}px`,
                          height: "96px",
                        }}
                      >
                        {/* 播放头 */}
                        <div
                          ref={playheadLineRef}
                          className="absolute top-0 z-20 pointer-events-none"
                          style={{
                            left: "0px",
                            width: "2px",
                            height: "96px",
                            background: "#ef4444",
                            boxShadow: "0 0 6px rgba(239,68,68,0.6)",
                            transition: "none",
                          }}
                        >
                          <div
                            className="absolute -top-px left-1/2 -translate-x-1/2"
                            style={{
                              width: 0, height: 0,
                              borderLeft: "5px solid transparent",
                              borderRight: "5px solid transparent",
                              borderTop: "6px solid #ef4444",
                            }}
                          />
                        </div>
                        {/* 片段 */}
                        {(() => {
                          let left = 0;
                          return timelineClips.map((clip, index) => {
                            const w = Math.max(8, (clip.durationMs / 1000) * timelineZoom);
                            const isCurrent = index === currentClipIndex && animPlaying;
                            const isSelected = selectedClips.includes(index);
                            const isBeingResized = resizingClip && resizingClip.index === index;
                            const prevDurationMs = index > 0 && timelineClips[index - 1] ? timelineClips[index - 1].durationMs : null;
                            const clipLeft = left;
                            left += w;
                            return (
                              <div
                                key={clip.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedClips((prev) => prev.includes(index) ? [] : [index]);
                                }}
                                className="absolute top-0.5 rounded-lg overflow-hidden cursor-pointer group transition-all"
                                style={{
                                  left: `${clipLeft}px`,
                                  width: `${w}px`,
                                  height: "88px",
                                  border: isSelected ? "2px solid #60a5fa" : isCurrent ? "2px solid #a78bfa" : "2px solid rgba(255,255,255,0.08)",
                                  boxShadow: isSelected ? "0 0 12px rgba(96,165,250,0.3)" : isCurrent ? "0 0 12px rgba(167,139,250,0.3)" : "none",
                                }}
                              >
                                {/* 缩略图背景 */}
                                <div className="absolute inset-0 flex items-center justify-center bg-white/[0.03]">
                                  <img
                                    src={clip.assetUrl}
                                    alt={clip.assetName}
                                    className="max-w-full max-h-full object-contain opacity-80"
                                    draggable={false}
                                  />
                                </div>
                                {/* 底部名称 */}
                                <div className="absolute bottom-0 left-0 right-0 h-5 flex items-center px-1.5 bg-black/60 backdrop-blur-sm">
                                  <span className="text-[9px] text-slate-300 truncate w-full leading-none">{clip.assetName}</span>
                                </div>
                                {/* 索引角标 */}
                                <div className="absolute top-0.5 left-0.5 rounded-full bg-violet-500/80 text-[8px] font-bold text-white w-3.5 h-3.5 flex items-center justify-center z-10">
                                  {index + 1}
                                </div>
                                {/* 拖拽时长浮标 */}
                                {isBeingResized && (
                                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 z-20 rounded-md bg-blue-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white whitespace-nowrap shadow-lg pointer-events-none">
                                    {clip.durationMs >= 1000 ? `${(clip.durationMs / 1000).toFixed(2)}s` : `${clip.durationMs}ms`}
                                  </div>
                                )}
                                {/* 左边缘拖拽手柄 */}
                                {w > 12 && (
                                  <div
                                    className="absolute top-0 left-0 h-full z-10 opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity flex items-center justify-center"
                                    style={{ width: "6px", cursor: "ew-resize", background: "rgba(96,165,250,0.25)" }}
                                    onMouseDown={(e) => handleResizeStart(e, index, "left", clip.durationMs, prevDurationMs)}
                                  >
                                    <div className="w-px h-8 rounded-full bg-blue-400/60" />
                                  </div>
                                )}
                                {/* 右边缘拖拽手柄 */}
                                {w > 12 && (
                                  <div
                                    className="absolute top-0 right-0 h-full z-10 opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity flex items-center justify-center"
                                    style={{ width: "6px", cursor: "ew-resize", background: "rgba(96,165,250,0.25)" }}
                                    onMouseDown={(e) => handleResizeStart(e, index, "right", clip.durationMs, prevDurationMs)}
                                  >
                                    <div className="w-px h-8 rounded-full bg-blue-400/60" />
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </section>
          ) : (
            /* ═══════════ 原有素材切割面板 ═══════════ */
            <section className="space-y-4 min-w-0">
            {/* 控制栏 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.06] glass px-4 py-3 glow-cyan">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBar message={processMessage} status={processStatus} />
                </div>
                {fileName && <p className="mt-0.5 text-[11px] text-slate-500 truncate">{fileName}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {activeTool === "cutout" && (
                  <Button
                    onClick={() => setSelectionMode(!selectionMode)}
                    disabled={!imageUrl}
                    className={`rounded-xl border px-4 py-2 text-[13px] transition ${
                      selectionMode
                        ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-300"
                        : "border-white/[0.08] bg-white/[0.06] text-white hover:bg-white/[0.1]"
                    }`}
                  >
                    <Icon name="scissors" size={13} />
                    {selectionMode ? "退出框选" : "框选模式"}
                  </Button>
                )}
                {activeTool === "cutout" && selectionMode && (
                  <Button
                    onClick={() => setShowSmartDialog(true)}
                    disabled={!imageUrl}
                    className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-[13px] text-amber-300 hover:bg-amber-400/20 transition"
                  >
                    <Icon name="scissors" size={13} />
                    智能识别
                  </Button>
                )}
                {activeTool === "cutout" && selectionMode && (
                  <Button
                    onClick={handleUndo}
                    disabled={historyStackRef.current.length === 0}
                    title="撤回 (Ctrl+Z)"
                    className={`rounded-xl border px-3 py-2 text-[12px] transition ${
                      historyStackRef.current.length > 0
                        ? "border-white/[0.12] bg-white/[0.06] text-slate-300 hover:bg-white/10 hover:text-white"
                        : "border-white/[0.04] bg-white/[0.02] text-slate-600 cursor-not-allowed"
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                    <span className="ml-1">撤回</span>
                    {historyStackRef.current.length > 0 && (
                      <span className="ml-1 rounded-full bg-white/10 px-1.5 py-0 text-[10px]">{historyStackRef.current.length}</span>
                    )}
                  </Button>
                )}
                {activeTool === "cutout" && selectionMode && manualBoxes.length > 0 && (
                  <Button
                    onClick={generateAssetsFromBoxes}
                    className="rounded-xl bg-gradient-to-r from-violet-400 to-violet-500 px-4 py-2 text-[13px] font-semibold text-white shadow-md shadow-violet-500/20 hover:from-violet-300 hover:to-violet-400"
                  >
                    <Icon name="grid" size={13} />
                    生成素材
                  </Button>
                )}
                {activeTool === "cutout" && selectionMode && selectedBoxIndex !== null && (
                  <Button
                    onClick={handleDeleteSelectedBox}
                    className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12px] text-red-300 hover:bg-red-400/20"
                  >
                    ✕ 删除选中
                  </Button>
                )}
                {assets.length > 0 && (
                  <Button
                    onClick={generateZip}
                    disabled={!assets.length}
                    className="rounded-xl bg-gradient-to-r from-cyan-400 to-cyan-500 px-4 py-2 text-[13px] font-semibold text-slate-950 shadow-md shadow-cyan-500/20 hover:from-cyan-300 hover:to-cyan-400"
                  >
                    <Icon name="archive" size={13} />
                    生成 ZIP
                  </Button>
                )}
                {assets.length > 0 && (
                  <Button
                    onClick={downloadAllPngOneByOne}
                    disabled={!assets.length}
                    className="rounded-xl bg-amber-400/90 px-4 py-2 text-[13px] font-semibold text-slate-950 hover:bg-amber-300"
                  >
                    <Icon name="download" size={13} />
                    逐个下载
                  </Button>
                )}
                {/* 尺寸调整：确认按钮 */}
                {activeTool === "resize" && (
                  <Button
                    onClick={confirmToFinished}
                    disabled={!selectedAssetId}
                    title={selectedAssetId ? "将选中素材移入成品库" : "请先在素材库中选择一个素材"}
                    className={`rounded-xl border px-4 py-2 text-[13px] font-semibold transition ${
                      selectedAssetId
                        ? "border-emerald-400/40 bg-emerald-400/20 text-emerald-300 hover:bg-emerald-400/30 shadow-md shadow-emerald-500/10"
                        : "border-white/[0.04] bg-white/[0.02] text-slate-600 cursor-not-allowed"
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <span className="ml-1">确定</span>
                  </Button>
                )}
                {/* 快捷键切换 */}
                <Button
                  onClick={() => setShowShortcutHints(!showShortcutHints)}
                  title="快捷键"
                  className={`rounded-xl border px-3 py-2 text-[12px] transition ${
                    showShortcutHints
                      ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
                      : "border-white/[0.08] bg-white/[0.06] text-slate-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                  <span className="ml-1">快捷键</span>
                </Button>
              </div>
            </div>

            {/* ZIP 下载面板 */}
            {zipDownloadUrl && (
              <div className="fade-in rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-slate-950">
                    <Icon name="check" size={12} />
                  </div>
                  <span className="text-[13px] font-semibold text-emerald-300">ZIP 已就绪</span>
                  <span className="text-[12px] text-slate-400">{zipDownloadName}</span>
                </div>
                <ZipDownloadPanel
                  zipDownloadUrl={zipDownloadUrl} zipBlobUrl={zipBlobUrl}
                  zipDownloadName={zipDownloadName} zipBase64={zipBase64}
                  showBase64={showBase64} setShowBase64={setShowBase64}
                  forceDownloadZip={forceDownloadZip} openZipInNewTab={openZipInNewTab}
                  copyZipBase64={copyZipBase64}
                />
              </div>
            )}

            {/* 图片预览区 */}
            <div
              className={`rounded-3xl border ${isDragOver ? "drag-over border-cyan-400/40" : "border-white/[0.06]"} glass overflow-auto glow-cyan transition-all duration-200`}
            style={{ maxHeight: '70vh' }}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              {/* 棋盘格背景 */}
              <div
                className="min-h-[320px] p-6 grid place-items-center"
                style={{
                  backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.03) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.03) 75%),linear-gradient(45deg,rgba(255,255,255,.03) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.03) 75%)",
                  backgroundSize: "24px 24px",
                  backgroundPosition: "0 0, 12px 12px",
                }}
              >
                {!imageUrl ? (
                  <button
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    className="group flex flex-col items-center gap-4 rounded-2xl border border-dashed border-white/10 bg-black/20 p-12 text-center transition-all hover:border-cyan-400/30 hover:bg-black/30 hover:shadow-lg hover:shadow-cyan-500/5"
                  >
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-slate-400 group-hover:bg-cyan-400/10 group-hover:text-cyan-300 transition-all">
                      <Icon name="upload" size={24} />
                    </div>
                    <div>
                      <div className="text-base font-semibold text-white">拖放或点击上传</div>
                      <div className="mt-1 text-[13px] text-slate-400">支持 PNG · JPG · WebP</div>
                    </div>
                  </button>
                ) : (
                  <div className="relative w-full flex justify-center overflow-hidden">
                    <div style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}>
                    {(() => {
                      const maxH = 400;
                      const dispW = imgNaturalH > maxH ? Math.round(imgNaturalW * maxH / imgNaturalH) : imgNaturalW;
                      const dispH = Math.min(imgNaturalH, maxH);
                      return (
                        <div
                          className="relative rounded-2xl shadow-2xl overflow-hidden"
                          style={{ width: dispW, height: dispH, transform: `scale(${scale / 100})`, transformOrigin: "center" }}
                          onWheel={(e) => {
                            if (e.shiftKey) {
                              e.preventDefault();
                              const delta = e.deltaY > 0 ? -10 : 10;
                              setScale((prev) => Math.max(20, Math.min(200, prev + delta)));
                            }
                          }}
                        >
                          <img
                            src={imageUrl}
                            alt="uploaded"
                            data-preview="true"
                            className="block w-full h-full"
                            style={{ objectFit: "contain" }}
                            onLoad={(e) => { setImgNaturalW(e.target.naturalWidth); setImgNaturalH(e.target.naturalHeight); }}
                          />
                      {imageUrl && imgNaturalW > 0 && activeTool === "cutout" && selectionMode && (
                        <div
                          className="absolute inset-0"
                          style={{ cursor: isDrawing || isResizing || isMoving ? undefined : hoverCursor }}
                          onMouseDown={handleOverlayMouseDown}
                          onMouseMove={handleOverlayMouseMove}
                          onMouseUp={handleOverlayMouseUp}
                          onMouseLeave={handleOverlayMouseUp}
                        >
                          {/* 已确认的框（百分比定位） */}
                          {manualBoxes.map((box, index) => {
                            const isSelected = index === selectedBoxIndex;
                            return (
                              <div
                                key={box.id}
                                className={`absolute transition-colors ${
                                  isSelected
                                    ? "ring-2 ring-violet-400 bg-violet-400/10 z-10"
                                    : "ring-2 ring-cyan-400/60 bg-cyan-400/[0.04]"
                                }`}
                                style={{
                                  left: `${(box.x / imgNaturalW) * 100}%`,
                                  top: `${(box.y / imgNaturalH) * 100}%`,
                                  width: `${(box.width / imgNaturalW) * 100}%`,
                                  height: `${(box.height / imgNaturalH) * 100}%`,
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSelectedBoxIndex(index);
                                  setShowContextMenu({ x: e.clientX, y: e.clientY, boxIndex: index });
                                }}
                              >
                                {/* 标签 */}
                                <div className={`absolute -top-5 left-0 rounded-md px-1.5 py-0.5 text-[9px] font-bold leading-4 whitespace-nowrap ${
                                  isSelected ? "bg-violet-400 text-white" : "bg-cyan-400 text-slate-950"
                                }`}>
                                  #{index + 1} {box.width}×{box.height}
                                </div>
                                {/* 手柄已移除 */}
                              </div>
                            );
                          })}
                          {/* 正在绘制的框（虚线预览，百分比定位） */}
                          {isDrawing && drawStart && drawEnd && (
                            <div
                              className="absolute border-2 border-dashed border-amber-400 bg-amber-400/[0.06]"
                              style={{
                                left: `${(Math.min(drawStart.x, drawEnd.x) / imgNaturalW) * 100}%`,
                                top: `${(Math.min(drawStart.y, drawEnd.y) / imgNaturalH) * 100}%`,
                                width: `${(Math.abs(drawEnd.x - drawStart.x) / imgNaturalW) * 100}%`,
                                height: `${(Math.abs(drawEnd.y - drawStart.y) / imgNaturalH) * 100}%`,
                              }}
                            >
                              <div className="absolute -top-5 left-0 rounded-md bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-950 leading-4 whitespace-nowrap">
                                {Math.abs(drawEnd.x - drawStart.x)}×{Math.abs(drawEnd.y - drawStart.y)}
                              </div>
                            </div>
                          )}
                          {/* 框选提示 */}
                          {showBoxHint && manualBoxes.length === 0 && !isDrawing && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <div className="rounded-xl bg-black/60 px-4 py-2 text-[12px] text-slate-300 backdrop-blur-sm">
                                在图片上按住鼠标拖拽来框选素材区域
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {/* 裁切框选 overlay — 仅尺寸调整模式 */}
                      {activeTool === "resize" && imageUrl && imgNaturalW > 0 && cropSelectionMode && (
                        <div
                          className="absolute inset-0"
                          style={{ cursor: cropHoverCursor }}
                          onMouseDown={handleCropOverlayMouseDown}
                          onMouseMove={handleCropOverlayMouseMove}
                          onMouseUp={handleCropOverlayMouseUp}
                          onMouseLeave={handleCropOverlayMouseUp}
                        >
                          {/* 已确认的裁切框（含 8 个调整手柄） */}
                          {cropW > 0 && cropH > 0 && (
                            <div
                              className="absolute border-[3px] border-dashed border-amber-400 bg-amber-400/[0.06]"
                              style={{
                                left: `${(cropX / imgNaturalW) * 100}%`,
                                top: `${(cropY / imgNaturalH) * 100}%`,
                                width: `${(cropW / imgNaturalW) * 100}%`,
                                height: `${(cropH / imgNaturalH) * 100}%`,
                              }}
                            >
                              <div className="absolute -top-5 left-0 rounded-md bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-950 leading-4 whitespace-nowrap">
                                {cropW}×{cropH}
                              </div>
                              {/* 8 个调整手柄 */}
                              {["nw","ne","sw","se","n","s","e","w"].map((pos) => {
                                const posMap = {
                                  nw: { top:"0%", left:"0%", x:"0%", y:"0%" },
                                  ne: { top:"0%", left:"100%", x:"-100%", y:"0%" },
                                  sw: { top:"100%", left:"0%", x:"0%", y:"-100%" },
                                  se: { top:"100%", left:"100%", x:"-100%", y:"-100%" },
                                  n:  { top:"0%", left:"50%", x:"-50%", y:"0%" },
                                  s:  { top:"100%", left:"50%", x:"-50%", y:"-100%" },
                                  e:  { top:"50%", left:"100%", x:"-100%", y:"-50%" },
                                  w:  { top:"50%", left:"0%", x:"0%", y:"-50%" },
                                };
                                const curMap = {
                                  nw:"nwse-resize", ne:"nesw-resize", sw:"nesw-resize", se:"nwse-resize",
                                  n:"n-resize", s:"s-resize", e:"e-resize", w:"w-resize",
                                };
                                return (
                                  <div
                                    key={pos}
                                    className="absolute h-3 w-3 rounded-sm border-2 border-amber-400 bg-slate-900 hover:bg-amber-400 transition-colors"
                                    style={{
                                      top: posMap[pos].top, left: posMap[pos].left,
                                      transform: `translate(${posMap[pos].x}, ${posMap[pos].y})`,
                                      cursor: curMap[pos],
                                    }}
                                  />
                                );
                              })}
                            </div>
                          )}
                          {/* 正在绘制的裁切框 */}
                          {isCropDrawing && cropDrawStart && cropDrawEnd && (
                            <div
                              className="absolute border-2 border-dashed border-amber-400 bg-amber-400/[0.06]"
                              style={{
                                left: `${(Math.min(cropDrawStart.x, cropDrawEnd.x) / imgNaturalW) * 100}%`,
                                top: `${(Math.min(cropDrawStart.y, cropDrawEnd.y) / imgNaturalH) * 100}%`,
                                width: `${(Math.abs(cropDrawEnd.x - cropDrawStart.x) / imgNaturalW) * 100}%`,
                                height: `${(Math.abs(cropDrawEnd.y - cropDrawStart.y) / imgNaturalH) * 100}%`,
                              }}
                            >
                              <div className="absolute -top-5 left-0 rounded-md bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-950 leading-4 whitespace-nowrap">
                                {Math.abs(cropDrawEnd.x - cropDrawStart.x)}×{Math.abs(cropDrawEnd.y - cropDrawStart.y)}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {/* 右键菜单 */}
                      {showContextMenu && (
                        <div
                          className="fixed z-50 rounded-lg border border-white/[0.08] bg-slate-800 shadow-xl py-1 min-w-[120px]"
                          style={{ left: showContextMenu.x, top: showContextMenu.y }}
                        >
                          <button
                            className="w-full text-left px-3 py-2 text-[13px] text-slate-300 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
                            onClick={() => {
                              handleDuplicateSelectedBox();
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            复制框 Ctrl+D
                          </button>
                          <button
                            className="w-full text-left px-3 py-2 text-[13px] text-red-400 hover:bg-red-400/10 transition-colors flex items-center gap-2"
                            onClick={() => {
                              handleDeleteSelectedBox();
                              setShowContextMenu(null);
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            删除框 Delete
                          </button>
                        </div>
                      )}
                      {/* 非框选模式下的只读预览框 */}
                      {imageUrl && imgNaturalW > 0 && activeTool === "cutout" && !selectionMode && manualBoxes.length > 0 && (
                        <div className="absolute inset-0 pointer-events-none">
                          {manualBoxes.map((box, index) => (
                            <div
                              key={box.id}
                              className="absolute ring-1 ring-cyan-400/50 bg-cyan-400/[0.03]"
                              style={{
                                left: `${(box.x / imgNaturalW) * 100}%`,
                                top: `${(box.y / imgNaturalH) * 100}%`,
                                width: `${(box.width / imgNaturalW) * 100}%`,
                                height: `${(box.height / imgNaturalH) * 100}%`,
                              }}
                            >
                              <div className="absolute -top-5 left-0 rounded-md bg-cyan-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-950 leading-4 whitespace-nowrap">
                                #{index + 1}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* 裁切框叠加 */}
                      {cropW > 0 && cropH > 0 && (
                        <div className="absolute inset-0 pointer-events-none" style={{ mixBlendMode: "difference" }}>
                          {/* 外部暗遮罩 */}
                          <div
                            className="absolute inset-0 bg-black/50"
                            style={{
                              clipPath: `polygon(0% 0%, 0% 100%, 100% 100%, 100% 0%, ${(cropX / imgNaturalW) * 100}% ${(cropY / imgNaturalH) * 100}%, ${((cropX + cropW) / imgNaturalW) * 100}% ${(cropY / imgNaturalH) * 100}%, ${((cropX + cropW) / imgNaturalW) * 100}% ${((cropY + cropH) / imgNaturalH) * 100}%, ${(cropX / imgNaturalW) * 100}% ${((cropY + cropH) / imgNaturalH) * 100}%)`,
                            }}
                          />
                          {/* 裁切框虚线 */}
                          <div
                            className="absolute border-[3px] border-dashed border-amber-400"
                            style={{
                              left: `${(cropX / imgNaturalW) * 100}%`,
                              top: `${(cropY / imgNaturalH) * 100}%`,
                              width: `${(cropW / imgNaturalW) * 100}%`,
                              height: `${(cropH / imgNaturalH) * 100}%`,
                            }}
                          >
                            <div className="absolute -top-5 left-0 rounded-md bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-950 leading-4 whitespace-nowrap">
                              {cropW}×{cropH}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 尺寸信息 & 裁切 — 仅尺寸调整工具 */}
            {activeTool === "resize" && imageUrl && imgNaturalW > 0 && (
              <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-amber space-y-4">
                {/* 尺寸信息 */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">尺寸信息</p>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">原始尺寸</span>
                    <span className="font-mono text-cyan-300">{imgNaturalW} × {imgNaturalH} px</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">预览尺寸</span>
                    <span className="font-mono text-cyan-300">{Math.round(imgNaturalW * scale / 100)} × {Math.round(imgNaturalH * scale / 100)} px</span>
                  </div>
                  {cropW > 0 && cropH > 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-amber-400">裁切尺寸</span>
                      <span className="font-mono text-amber-300">{cropW} × {cropH} px</span>
                    </div>
                  )}
                </div>

                {/* 缩放系数 */}
                <div className="rounded-xl border border-cyan-400/10 bg-cyan-400/[0.04] p-3 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">缩放系数</p>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setResizeScale((p) => Math.max(10, p - 10))} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-400 hover:bg-white/10 hover:text-white transition">−</button>
                    <input
                      type="number"
                      min="10" max="500"
                      value={resizeScale}
                      onChange={(e) => { const v = Number(e.target.value); if (v >= 10 && v <= 500) setResizeScale(v); }}
                      className="h-7 w-14 rounded-lg border border-white/[0.08] bg-black/30 text-center text-[12px] font-mono text-cyan-300 outline-none focus:border-cyan-400/40 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-[12px] text-slate-400">%</span>
                    <button onClick={() => setResizeScale((p) => Math.min(500, p + 10))} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-400 hover:bg-white/10 hover:text-white transition">+</button>
                  </div>
                  {resizeScale !== 100 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">输出尺寸</span>
                      <span className="font-mono text-emerald-300">
                        {(() => {
                          const bw = cropW > 0 ? cropW : imgNaturalW;
                          const bh = cropH > 0 ? cropH : imgNaturalH;
                          return `${Math.round(bw * resizeScale / 100)} × ${Math.round(bh * resizeScale / 100)} px`;
                        })()}
                      </span>
                    </div>
                  )}
                </div>

                {/* 裁切状态 */}
                {cropW > 0 && cropH > 0 && (
                  <div className="rounded-xl border border-amber-400/10 bg-amber-400/[0.04] p-3 space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">裁切区域</p>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">裁切尺寸</span>
                      <span className="font-mono text-amber-300">{cropW} × {cropH} px</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">起始坐标</span>
                      <span className="font-mono text-amber-300">X:{cropX} Y:{cropY}</span>
                    </div>
                    <button
                      onClick={() => { setCropW(0); setCropH(0); setCropX(0); setCropY(0); }}
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-1 text-[10px] text-slate-400 hover:bg-white/10 hover:text-white transition"
                    >重置裁切</button>
                  </div>
                )}
              </div>
            )}

            {/* 统计信息卡片 */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { icon: "layers", label: "批量导出", value: assets.length ? `${assets.length} 个` : "—", desc: "生成 ZIP 或逐个 PNG" },
                { icon: "grid", label: "框选区域", value: manualBoxes.length ? `${manualBoxes.length} 个` : "—", desc: "待生成素材的选区" },
                { icon: "resize", label: "尺寸预览", value: `${scale}%`, desc: "浏览器内实时缩放" },
              ].map(({ icon, label, value, desc }) => (
                <div key={label} className="rounded-2xl border border-white/[0.06] glass p-4 card-hover">
                  <div className="mb-2 flex items-center gap-2 text-slate-400">
                    <Icon name={icon} size={14} />
                    <span className="text-[12px]">{label}</span>
                  </div>
                  <div className="text-lg font-bold text-white">{value}</div>
                  <p className="mt-1 text-[11px] text-slate-500">{desc}</p>
                </div>
              ))}
            </div>
          </section>
          )}

          {/* ── 右侧：快捷键 + 素材列表 ── */}
          <aside className="space-y-4">
            {/* 快捷键卡片 */}
            {showShortcutHints && (
              <ShortcutHints activeTool={activeTool} />
            )}

            {/* 素材库 or 已分割素材 —— 根据工具模式切换 */}
            {activeTool === "animation" ? (
              /* ── 动画模式：素材库 ── */
              <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-violet">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon name="layers" size={14} />
                    <span className="text-[13px] font-semibold text-white">素材库</span>
                    {assetLibrary.length > 0 && (
                      <span className="rounded-full bg-violet-400/20 px-2 py-0.5 text-[11px] font-semibold text-violet-300">{assetLibrary.length}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={handleImageImport}
                      className="hidden"
                    />
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-violet-400/20 px-3 py-1.5 text-[11px] font-medium text-violet-300 hover:bg-violet-400/30 transition"
                    >
                      <Icon name="upload" size={11} />
                      导入图片
                    </button>
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip"
                      onChange={handleZipImport}
                      className="hidden"
                    />
                    <button
                      onClick={() => zipInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-violet-400/90 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-violet-300 transition shadow-md shadow-violet-500/20"
                    >
                      <Icon name="archive" size={11} />
                      导入 ZIP
                    </button>
                  </div>
                </div>

                {!assetLibrary.length ? (
                  <div className="rounded-xl border border-dashed border-white/[0.06] py-8 text-center">
                    <div className="mb-2 flex justify-center text-slate-600">
                      <Icon name="layers" size={28} />
                    </div>
                    <p className="text-[12px] text-slate-500">素材库为空</p>
                    <p className="text-[11px] text-slate-600">导入图片或 ZIP 文件，或在抠图工具中分割素材</p>
                  </div>
                ) : (
                  <div className="grid max-h-[460px] grid-cols-2 gap-2.5 overflow-auto pr-0.5">
                    {assetLibrary.map((asset, index) => (
                      <div
                        key={asset.id}
                        className="group relative rounded-xl border border-white/[0.06] bg-black/30 p-2 transition-all hover:border-violet-400/20 hover:bg-black/50 card-hover"
                      >
                        <div className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/90 text-[9px] font-bold text-white shadow-md">
                          {index + 1}
                        </div>
                        <div className="grid aspect-square place-items-center rounded-lg bg-white/[0.03] overflow-hidden"
                          style={{
                            backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%),linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%)",
                            backgroundSize: "10px 10px",
                            backgroundPosition: "0 0, 5px 5px",
                          }}
                        >
                          <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
                        </div>
                        <div className="mt-1.5 truncate text-[10px] text-slate-500">{asset.name}</div>
                        <div className="mt-0.5 text-[10px] text-slate-600">{asset.width}×{asset.height}</div>
                        <div className="mt-1">
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${asset.source === "zip" ? "bg-amber-400/20 text-amber-300" : asset.source === "image" ? "bg-emerald-400/20 text-emerald-300" : asset.source === "resize" ? "bg-amber-400/20 text-amber-300" : "bg-cyan-400/20 text-cyan-300"}`}>
                            {asset.source === "zip" ? "ZIP" : asset.source === "image" ? "图片" : asset.source === "resize" ? "裁切" : "抠图"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <button
                            onClick={() => addFrameToAnimation(asset)}
                            className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-violet-400/10 py-1.5 text-[11px] font-medium text-violet-300 transition hover:bg-violet-400/20"
                          >
                            <Icon name="film" size={11} />
                            添加
                          </button>
                          <button
                            onClick={() => setAssetLibrary((prev) => prev.filter((a) => a.id !== asset.id))}
                            className="flex items-center justify-center gap-1 rounded-lg bg-red-400/[0.08] px-2 py-1.5 text-[11px] font-medium text-red-400/60 transition hover:bg-red-400/15 hover:text-red-300"
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : activeTool === "resize" ? (
              <>
              {/* ── 尺寸调整模式：素材库 ── */}
              <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-amber">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon name="layers" size={14} />
                    <span className="text-[13px] font-semibold text-white">素材库</span>
                    {assetLibrary.length > 0 && (
                      <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-semibold text-amber-300">{assetLibrary.length}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={batchGenerateToFinished}
                      disabled={!assetLibrary.length}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400/90 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-amber-300 transition shadow-md shadow-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Icon name="scissors" size={11} />
                      一键生成素材
                    </button>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={handleImageImport}
                      className="hidden"
                    />
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400/20 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-400/30 transition"
                    >
                      <Icon name="upload" size={11} />
                      导入图片
                    </button>
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip"
                      onChange={handleZipImport}
                      className="hidden"
                    />
                    <button
                      onClick={() => zipInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400/90 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-amber-300 transition shadow-md shadow-amber-500/20"
                    >
                      <Icon name="archive" size={11} />
                      导入 ZIP
                    </button>
                  </div>
                </div>

                {!assetLibrary.length ? (
                  <div className="rounded-xl border border-dashed border-white/[0.06] py-8 text-center">
                    <div className="mb-2 flex justify-center text-slate-600">
                      <Icon name="layers" size={28} />
                    </div>
                    <p className="text-[12px] text-slate-500">素材库为空</p>
                    <p className="text-[11px] text-slate-600">导入图片/ZIP 后素材自动进入素材库</p>
                  </div>
                ) : (
                  <div className="grid max-h-[460px] grid-cols-2 gap-2.5 overflow-auto pr-0.5">
                    {assetLibrary.map((asset, index) => {
                      const isSelected = selectedAssetId === asset.id;
                      return (
                      <div
                        key={asset.id}
                        onClick={() => setSelectedAssetId(isSelected ? null : asset.id)}
                        className={`group relative rounded-xl border p-2 transition-all cursor-pointer card-hover ${
                          isSelected
                            ? "border-emerald-400/50 bg-emerald-400/[0.08] ring-2 ring-emerald-400/30"
                            : "border-white/[0.06] bg-black/30 hover:border-amber-400/20 hover:bg-black/50"
                        }`}
                      >
                        <div className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold shadow-md ${
                          isSelected ? "bg-emerald-500/90 text-slate-950" : "bg-amber-500/90 text-slate-950"
                        }`}>
                          {isSelected ? "✓" : index + 1}
                        </div>
                        <div className="grid aspect-square place-items-center rounded-lg bg-white/[0.03] overflow-hidden"
                          style={{
                            backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%),linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%)",
                            backgroundSize: "10px 10px",
                            backgroundPosition: "0 0, 5px 5px",
                          }}
                        >
                          <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
                        </div>
                        <div className="mt-1.5 truncate text-[10px] text-slate-500">{asset.name}</div>
                        <div className="mt-0.5 text-[10px] text-slate-600">{asset.width}×{asset.height}</div>
                        <div className="mt-1">
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${asset.source === "zip" ? "bg-amber-400/20 text-amber-300" : asset.source === "image" ? "bg-emerald-400/20 text-emerald-300" : asset.source === "resize" ? "bg-amber-400/20 text-amber-300" : "bg-cyan-400/20 text-cyan-300"}`}>
                            {asset.source === "zip" ? "ZIP" : asset.source === "image" ? "图片" : asset.source === "resize" ? "裁切" : "抠图"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); moveAssetToCrop(asset); }}
                            className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-amber-400/[0.08] py-1.5 text-[11px] font-medium text-amber-400/60 transition hover:bg-amber-400/15 hover:text-amber-300"
                            title="移入裁切预览"
                          >
                            <Icon name="scissors" size={11} />
                            裁切
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setAssetLibrary((prev) => prev.filter((a) => a.id !== asset.id)); if (isSelected) setSelectedAssetId(null); }}
                            className="flex items-center justify-center gap-1 rounded-lg bg-red-400/[0.08] px-2 py-1.5 text-[11px] font-medium text-red-400/60 transition hover:bg-red-400/15 hover:text-red-300"
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )})}
                  </div>
                )}

                {/* ZIP 导出 */}
                {assetLibrary.length > 0 && (
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={generateLibraryZip}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-400/90 px-3 py-2 text-[11px] font-bold text-slate-950 hover:bg-amber-300 transition shadow-md shadow-amber-500/20"
                    >
                      <Icon name="archive" size={11} />
                      导出 ZIP
                    </button>
                    <button
                      onClick={downloadAllLibraryPngs}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] px-3 py-2 text-[11px] font-medium text-slate-300 hover:bg-white/10 transition"
                    >
                      <Icon name="download" size={11} />
                      逐个下载
                    </button>
                  </div>
                )}
              </div>

              {/* ── 尺寸调整模式：成品库 ── */}
              <div className="rounded-2xl border border-white/[0.06] glass p-4 glow-emerald">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon name="archive" size={14} />
                    <span className="text-[13px] font-semibold text-white">成品库</span>
                    {finishedLibrary.length > 0 && (
                      <span className="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">{finishedLibrary.length}</span>
                    )}
                  </div>
                </div>

                {!finishedLibrary.length ? (
                  <div className="rounded-xl border border-dashed border-white/[0.06] py-8 text-center">
                    <div className="mb-2 flex justify-center text-slate-600">
                      <Icon name="archive" size={28} />
                    </div>
                    <p className="text-[12px] text-slate-500">成品库为空</p>
                    <p className="text-[11px] text-slate-600">在素材库中点击「确定」将素材移入成品库</p>
                  </div>
                ) : (
                  <div className="grid max-h-[460px] grid-cols-2 gap-2.5 overflow-auto pr-0.5">
                    {finishedLibrary.map((asset, index) => (
                      <div
                        key={asset.id}
                        className="group relative rounded-xl border border-emerald-400/10 bg-emerald-400/[0.03] p-2 transition-all hover:border-emerald-400/30 hover:bg-emerald-400/[0.06] card-hover"
                      >
                        <div className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/90 text-[9px] font-bold text-slate-950 shadow-md">
                          {index + 1}
                        </div>
                        <div className="grid aspect-square place-items-center rounded-lg bg-white/[0.03] overflow-hidden"
                          style={{
                            backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%),linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%)",
                            backgroundSize: "10px 10px",
                            backgroundPosition: "0 0, 5px 5px",
                          }}
                        >
                          <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
                        </div>
                        <div className="mt-1.5 truncate text-[10px] text-slate-500">{asset.name}</div>
                        <div className="mt-0.5 text-[10px] text-slate-600">{asset.width}×{asset.height}</div>
                        <div className="mt-1">
                          <span className="rounded-full bg-emerald-400/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                            成品
                          </span>
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <button
                            onClick={() => returnToAssetLibrary(asset)}
                            className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-amber-400/[0.08] py-1.5 text-[11px] font-medium text-amber-400/60 transition hover:bg-amber-400/15 hover:text-amber-300"
                            title="返回素材库"
                          >
                            <Icon name="layers" size={11} />
                            返回
                          </button>
                          <button
                            onClick={() => downloadAsset(asset)}
                            className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-white/[0.06] py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-emerald-400/10 hover:text-emerald-300"
                          >
                            <Icon name="download" size={11} />
                            下载
                          </button>
                          <button
                            onClick={() => setFinishedLibrary((prev) => prev.filter((a) => a.id !== asset.id))}
                            className="flex items-center justify-center gap-1 rounded-lg bg-red-400/[0.08] px-2 py-1.5 text-[11px] font-medium text-red-400/60 transition hover:bg-red-400/15 hover:text-red-300"
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 成品库导出 */}
                {finishedLibrary.length > 0 && (
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={generateFinishedZip}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-400/90 px-3 py-2 text-[11px] font-bold text-slate-950 hover:bg-emerald-300 transition shadow-md shadow-emerald-500/20"
                    >
                      <Icon name="archive" size={11} />
                      导出 ZIP
                    </button>
                    <button
                      onClick={downloadAllFinishedPngs}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] px-3 py-2 text-[11px] font-medium text-slate-300 hover:bg-white/10 transition"
                    >
                      <Icon name="download" size={11} />
                      逐个下载
                    </button>
                  </div>
                )}
              </div>
              </>
            ) : (
              /* ── 抠图模式：已分割素材 ── */
              <div className="rounded-2xl border border-white/[0.06] glass p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon name="grid" size={14} />
                  <span className="text-[13px] font-semibold text-white">已分割素材</span>
                  {assets.length > 0 && (
                    <span className="rounded-full bg-cyan-400/20 px-2 py-0.5 text-[11px] font-semibold text-cyan-300">{assets.length}</span>
                  )}
                </div>
                {assets.length > 0 && (
                  <button
                    onClick={generateZip}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/90 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-cyan-300 transition shadow-md shadow-cyan-500/20"
                  >
                    <Icon name="archive" size={11} />
                    ZIP
                  </button>
                )}
              </div>

              {!assets.length ? (
                <div className="rounded-xl border border-dashed border-white/[0.06] py-8 text-center">
                  <div className="mb-2 flex justify-center text-slate-600">
                    <Icon name="layers" size={28} />
                  </div>
                  <p className="text-[12px] text-slate-500">尚无素材</p>
                  <p className="text-[11px] text-slate-600">先上传图片并点击分割</p>
                </div>
              ) : (
                <div className="grid max-h-[460px] grid-cols-2 gap-2.5 overflow-auto pr-0.5">
                  {assets.map((asset) => (
                    <div
                      key={asset.id}
                      className="group rounded-xl border border-white/[0.06] bg-black/30 p-2 transition-all hover:border-cyan-400/20 hover:bg-black/50 card-hover"
                    >
                      <div className="grid aspect-square place-items-center rounded-lg bg-white/[0.03] overflow-hidden"
                        style={{
                          backgroundImage: "linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%),linear-gradient(45deg,rgba(255,255,255,.04) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.04) 75%)",
                          backgroundSize: "10px 10px",
                          backgroundPosition: "0 0, 5px 5px",
                        }}
                      >
                        <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
                      </div>
                      <div className="mt-1.5 truncate text-[10px] text-slate-500">{asset.name}</div>
                      <div className="mt-0.5 text-[10px] text-slate-600">{asset.width}×{asset.height}</div>
                      <button
                        onClick={() => downloadAsset(asset)}
                        className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-white/[0.06] py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-cyan-400/10 hover:text-cyan-300 group-hover:border-cyan-400/10"
                      >
                        <Icon name="download" size={11} />
                        下载
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </aside>

          {/* 智能识别对话框 */}
          {showSmartDialog && (
            <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowSmartDialog(false)}>
              {/* 遮罩 */}
              <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
              {/* 弹窗 */}
              <div
                className="relative z-10 w-full max-w-sm rounded-2xl border border-white/[0.08] bg-slate-900 p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="mb-1 text-lg font-bold text-white">智能识别素材区域</h2>
                <p className="mb-5 text-[13px] text-slate-400">
                  指定期望检测的素材数量，算法会按面积从大到小选取最优区域。
                </p>

                {/* 数量选择 */}
                <div className="mb-5 flex items-center justify-between">
                  <span className="text-[13px] text-slate-300">素材数量</span>
                  <input
                    type="number"
                    min="0"
                    max="200"
                    value={smartDetectCount}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v >= 0 && v <= 200) setSmartDetectCount(v);
                      else if (e.target.value === "") setSmartDetectCount(0);
                    }}
                    className="w-20 rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-center text-sm font-bold text-amber-300 focus:border-amber-400/50 focus:outline-none focus:ring-1 focus:ring-amber-400/30"
                  />
                </div>

                {/* 按钮组 */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowSmartDialog(false)}
                    className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.06] px-4 py-2.5 text-[13px] font-medium text-slate-300 hover:bg-white/[0.1] transition"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => smartDetectBoxes(smartDetectCount)}
                    className="flex-1 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 px-4 py-2.5 text-[13px] font-semibold text-slate-950 shadow-md shadow-amber-500/20 hover:from-amber-300 hover:to-amber-400 transition"
                  >
                    开始识别
                  </button>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

/* ─────────────────────── ZIP 下载面板 ─────────────────────── */
function ZipDownloadPanel({ zipDownloadUrl, zipBlobUrl, zipDownloadName, zipBase64, showBase64, setShowBase64, forceDownloadZip, openZipInNewTab, copyZipBase64 }) {
  return (
    <div className="space-y-2">
      <a
        href={zipBlobUrl || zipDownloadUrl}
        download={zipDownloadName}
        className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-500 px-4 py-2.5 text-[13px] font-bold text-slate-950 hover:from-emerald-300 hover:to-emerald-400 transition shadow-md shadow-emerald-500/20"
      >
        <Icon name="download" size={13} />
        下载 {zipDownloadName}
      </a>
      <div className="grid grid-cols-3 gap-2">
        <button onClick={forceDownloadZip} className="rounded-xl border border-white/[0.08] bg-white/[0.06] py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.1] hover:text-white transition">备用下载</button>
        <button onClick={openZipInNewTab} className="rounded-xl border border-white/[0.08] bg-white/[0.06] py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.1] hover:text-white transition">新窗口</button>
        <button onClick={() => setShowBase64(!showBase64)} className="rounded-xl border border-white/[0.08] bg-white/[0.06] py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.1] hover:text-white transition">
          {showBase64 ? "隐藏" : "Base64"}
        </button>
      </div>
      <button
        onClick={copyZipBase64}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.06] py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.1] hover:text-white transition"
      >
        <Icon name="copy" size={11} />
        复制 Base64（沙盒兜底方案）
      </button>
      <p className="text-[11px] leading-5 text-slate-500">
        预览沙盒可能限制直接下载 ZIP。部署至 Vercel / Netlify / localhost 后可正常下载。沙盒环境请使用「逐个下载 PNG」或复制 Base64。
      </p>
      {showBase64 && (
        <textarea
          readOnly
          value={`data:application/zip;base64,${zipBase64}`}
          className="h-28 w-full rounded-xl border border-white/[0.06] bg-black/40 p-2.5 text-[11px] text-emerald-300 outline-none resize-none font-mono"
        />
      )}
    </div>
  );
}
