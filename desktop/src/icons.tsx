// Pi Desktop 自绘图标体系（不依赖第三方图标库的造型）
// 设计规范：
//   · 24×24 网格，可视区域留 2px 安全边
//   · 描边统一 1.7px，圆角端点与圆角连接
//   · 只用直线、圆、弧，圆角半径 2px；同族图标共享同一套比例
//   · 一律 currentColor，尺寸由 size 属性控制（默认 16）
// 未自绘的图标暂时从 lucide 转出，便于逐个替换（见文件末尾）。
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

const draw = (children: ReactNode) => {
  const Icon = ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
  return Icon;
};

/* ── 会话与导航 ─────────────────────────────────────────────────────────── */
// 新建：一方框 + 居中加号
export const Plus = draw(<><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" /><path d="M12 8.5v7M8.5 12h7" /></>);
// 搜索：圆 + 手柄
export const Search = draw(<><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l4.5 4.5" /></>);
// 侧栏收起 / 展开：框 + 竖分隔 + 方向
export const PanelLeftClose = draw(<><rect x="3" y="4" width="18" height="16" rx="3.5" /><path d="M9.5 4v16" /><path d="M15.5 10l-2.5 2 2.5 2" /></>);
export const PanelRight = draw(<><rect x="3" y="4" width="18" height="16" rx="3.5" /><path d="M14.5 4v16" /><path d="M7 10l2.5 2L7 14" /></>);
export const ChevronDown = draw(<path d="M7 10l5 5 5-5" />);
export const ChevronRight = draw(<path d="M10 6.5l5.5 5.5L10 17.5" />);
export const MoreHorizontal = draw(<><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>);

/* ── 工作区与文件 ───────────────────────────────────────────────────────── */
export const Folder = draw(<path d="M4 8.5a3 3 0 013-3h2.6l1.9 2.2H17a3 3 0 013 3v5.8a3 3 0 01-3 3H7a3 3 0 01-3-3V8.5z" />);
export const FolderOpen = draw(<><path d="M4 8.5a3 3 0 013-3h2.6l1.9 2.2H16a2.6 2.6 0 012.6 2.6" /><path d="M4 9.6l1.5 8.2A2.5 2.5 0 008 19.8h8.6a2.5 2.5 0 002.4-1.9l1.5-6.3H6.2A2.4 2.4 0 014 9.6z" /></>);
export const GitBranch = draw(<><circle cx="7" cy="6.5" r="2.5" /><circle cx="7" cy="17.5" r="2.5" /><circle cx="17" cy="10" r="2.5" /><path d="M7 9v6M9.5 6.5h2A3 3 0 0114.5 10" /></>);
export const Paperclip = draw(<path d="M17.5 11.5l-5.6 5.6a4 4 0 11-5.7-5.7l6-6a2.9 2.9 0 014.1 4.1l-6 6a1.8 1.8 0 11-2.6-2.6l5.4-5.4" />);

/* ── 对话操作 ───────────────────────────────────────────────────────────── */
export const ArrowUp = draw(<><path d="M12 19.5V5" /><path d="M6 11l6-6 6 6" /></>);
export const Square = draw(<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />);
export const Copy = draw(<><rect x="9" y="9" width="11.5" height="11.5" rx="3" /><path d="M15.5 6.5A2.5 2.5 0 0013 4H7a3 3 0 00-3 3v6a2.5 2.5 0 002.5 2.5" /></>);
export const X = draw(<><path d="M6.5 6.5l11 11" /><path d="M17.5 6.5l-11 11" /></>);
export const Maximize2 = draw(<><path d="M14 4.5h5.5V10" /><path d="M10 19.5H4.5V14" /><path d="M19.5 4.5l-6 6" /><path d="M4.5 19.5l6-6" /></>);

/* ── 功能入口（左侧轨道与面板） ─────────────────────────────────────────── */
// 上下文：环形刻度 + 中轴，表达"用量"
export const Brain = draw(<><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3" /><circle cx="12" cy="12" r="2" /></>);
// 子代理：三个节点互连
export const Users = draw(<><circle cx="12" cy="6.5" r="2.6" /><circle cx="6.5" cy="17" r="2.6" /><circle cx="17.5" cy="17" r="2.6" /><path d="M10.6 8.6l-2.7 6M13.4 8.6l2.7 6M9.1 17h5.8" /></>);
// 终端：框 + 提示符 + 光标线
export const Terminal = draw(<><rect x="3" y="4.5" width="18" height="15" rx="3.5" /><path d="M7 10l2.5 2L7 14" /><path d="M12.5 15h4.5" /></>);
// MCP：插头
export const Plug = draw(<><path d="M9 4.5v5M15 4.5v5" /><path d="M6.5 9.5h11v2.2a5.5 5.5 0 01-11 0V9.5z" /><path d="M12 17.2v2.8" /></>);
export const Unplug = draw(<><path d="M9 4.5v4M15 4.5v4M6.5 8.5h11v2a5.5 5.5 0 01-11 0v-2z" /><path d="M12 16v2.5" /><path d="M18.5 18.5l3 3M21.5 18.5l-3 3" /></>);
// 扩展：拼图块
export const Layers = draw(<><path d="M12 3.5l7.5 4-7.5 4-7.5-4 7.5-4z" /><path d="M4.5 12.5l7.5 4 7.5-4" /><path d="M4.5 16.8l7.5 4 7.5-4" /></>);
// 更新：圆 + 向下箭头
export const Download = draw(<><path d="M12 4.5v9" /><path d="M8 10l4 4 4-4" /><path d="M5 17.5h14" /></>);
// 索引：数据库桶
export const Database = draw(<><ellipse cx="12" cy="6.5" rx="7" ry="2.8" /><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11" /><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></>);

/* ── 状态与动作 ─────────────────────────────────────────────────────────── */
export const RefreshCw = draw(<><path d="M20 12a8 8 0 01-13.7 5.6" /><path d="M4 12a8 8 0 0113.7-5.6" /><path d="M20 5.5V12h-6.2" /><path d="M4 18.5V12h6.2" /></>);
export const Check = draw(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const CircleAlert = draw(<><circle cx="12" cy="12" r="8" /><path d="M12 7.8v5" /><circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" /></>);
export const LoaderCircle = draw(<><circle cx="12" cy="12" r="7.5" opacity="0.28" /><path d="M19.5 12a7.5 7.5 0 00-7.5-7.5" /></>);
export const Ban = draw(<><circle cx="12" cy="12" r="7.5" /><path d="M6.7 6.7l10.6 10.6" /></>);
export const Play = draw(<path d="M8.5 5.8l9 6.2-9 6.2V5.8z" />);
export const Eraser = draw(<><path d="M8 19.5H19" /><path d="M15.5 4.8l3.7 3.7a2 2 0 010 2.8l-7 7a2 2 0 01-2.8 0l-3.7-3.7a2 2 0 010-2.8l7-7a2 2 0 012.8 0z" /><path d="M10 9.5l5.5 5.5" /></>);
export const Sparkles = draw(<><path d="M12 4.5l1.6 4.1 4.1 1.6-4.1 1.6L12 15.9l-1.6-4.1L6.3 10.2l4.1-1.6L12 4.5z" /><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" /></>);
// 设置：滑杆
// 键盘：方框 + 两排按键点
export const Keyboard = draw(<><rect x="2.5" y="6.5" width="19" height="11" rx="3" /><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M8 13.8h8" /></>);
export const Settings2 = draw(<><path d="M4.5 7.5h5M13.5 7.5h6" /><circle cx="11" cy="7.5" r="2.2" /><path d="M4.5 16.5h6M17 16.5h2.5" /><circle cx="14.5" cy="16.5" r="2.2" /></>);
export const Minus = draw(<path d="M6 12h12" />);
export const CheckCheck = draw(<><path d="M4 12.5l3.8 3.8L15 9" /><path d="M11 15.8l1.2 1.2L20 9.5" /></>);
export const FilePlus2 = draw(<><path d="M13.5 3.5H8a3 3 0 00-3 3v11a3 3 0 003 3h8a3 3 0 003-3v-8" /><path d="M13.5 3.5l4.5 4.5h-3.5a1 1 0 01-1-1V3.5z" /><path d="M12 12v6M9 15h6" /></>);
export const ExternalLink = draw(<><path d="M13.5 5.5H18.5V10.5" /><path d="M18.5 5.5l-7 7" /><path d="M17 14v3.5a2.5 2.5 0 01-2.5 2.5H7a2.5 2.5 0 01-2.5-2.5V10A2.5 2.5 0 017 7.5h3.5" /></>);
export const ShieldAlert = draw(<><path d="M12 3.8l6.5 2.4v5.3c0 3.7-2.6 6.9-6.5 8.7-3.9-1.8-6.5-5-6.5-8.7V6.2L12 3.8z" /><path d="M12 9v3.4" /><circle cx="12" cy="15.4" r="0.9" fill="currentColor" stroke="none" /></>);
export const ShieldCheck = draw(<><path d="M12 3.8l6.5 2.4v5.3c0 3.7-2.6 6.9-6.5 8.7-3.9-1.8-6.5-5-6.5-8.7V6.2L12 3.8z" /><path d="M9 12.2l2.2 2.2 4-4.4" /></>);
export const Zap = draw(<path d="M13.5 3.5L6.5 13h4.6l-.6 7.5L17.5 11h-4.6l.6-7.5z" />);

/* ── 队列与代码 ─────────────────────────────────────────────────────────── */
export const ArrowDown = draw(<><path d="M12 4.5V19" /><path d="M6 13l6 6 6-6" /></>);
export const ArrowUpRight = draw(<><path d="M7 17L16.5 7.5" /><path d="M9.5 7.5h7v7" /></>);
// 代码：一对尖括号 + 中间斜杠
export const Code2 = draw(<><path d="M9 8.5L5.5 12 9 15.5" /><path d="M15 8.5L18.5 12 15 15.5" /><path d="M13 6.5l-2 11" /></>);
export const FileCode2 = draw(<><path d="M13.5 3.5H8a3 3 0 00-3 3v11a3 3 0 003 3h8a3 3 0 003-3V8" /><path d="M13.5 3.5L18 8h-3.5a1 1 0 01-1-1V3.5z" /><path d="M10 12.5l-1.8 2 1.8 2M14 12.5l1.8 2L14 16.5" /></>);
// 对话气泡（方角）
export const MessageSquare = draw(<path d="M4.5 7a3 3 0 013-3h9a3 3 0 013 3v6a3 3 0 01-3 3H9.5L5.7 19.4a.6.6 0 01-1-.5V16a3 3 0 01-.2-1V7z" />);
// 回转：逆时针 / 顺时针
export const RotateCcw = draw(<><path d="M4.5 12a7.5 7.5 0 1112.9 5.2" /><path d="M4.5 7.5V12h4.5" /></>);
export const RotateCw = draw(<><path d="M19.5 12a7.5 7.5 0 10-12.9 5.2" /><path d="M19.5 7.5V12H15" /></>);
// 终端面板与终端同一造型，保留两个名字便于调用方语义化
export const TerminalSquare = Terminal;
export const Computer = draw(<><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M2.5 19h19M9 16v3M15 16v3" /></>);
