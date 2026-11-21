/**
 * st-chat-text-painter · 聊天文字调色
 * 纯逻辑引擎：无 DOM 依赖，浏览器与 Node 通用，可独立单测。
 *
 * 约定：
 *  - 三类文本：main 主要 / italic 斜体 / quote 引用（含成对双引号对话）
 *  - mode: 'follow' 跟随酒馆（不覆盖） / 'solid' 纯色 / 'gradient' 渐变
 *  - 渐变角度与 CSS linear-gradient 角度一致：0° 自下而上、90° 自左向右
 *  - 光晕：逐字跟随字色的三层 text-shadow（近层亮边 + 中层柔晕 + 外层扩散），
 *    强度 0–1 联动模糊半径与不透明度；接近垂直（0°/180° 附近）的角度按
 *    约定取渐变中间色整段着色并挂三层光晕，不逐字拆包
 */

export const CATS = ['main', 'italic', 'quote'];

export const defaultSettings = Object.freeze({
    enabled: true,
    main: { mode: 'follow', solid: '#e8e8e8', c1: '#7fc1ff', c2: '#ffd27f', angle: 90, glow: false, glowStrength: 60 },
    italic: { mode: 'follow', solid: '#e8e8e8', c1: '#7fc1ff', c2: '#ffd27f', angle: 90, glow: false, glowStrength: 60 },
    quote: { mode: 'follow', solid: '#e8e8e8', c1: '#7fc1ff', c2: '#ffd27f', angle: 90, glow: false, glowStrength: 60 },
});

export function clamp(v, min, max) {
    if (Number.isNaN(v)) return min;
    return Math.min(max, Math.max(min, v));
}

/** 合并历史设置与默认值，容忍缺字段 / 非法值 */
export function normalizeSettings(saved) {
    const out = {};
    out.enabled = !(saved && saved.enabled === false);
    for (const cat of CATS) {
        const d = defaultSettings[cat];
        const p = saved && saved[cat] ? saved[cat] : {};
        const angle = Number(p.angle);
        const strength = Number(p.glowStrength);
        out[cat] = {
            mode: ['follow', 'solid', 'gradient'].includes(p.mode) ? p.mode : d.mode,
            solid: typeof p.solid === 'string' ? p.solid : d.solid,
            c1: typeof p.c1 === 'string' ? p.c1 : d.c1,
            c2: typeof p.c2 === 'string' ? p.c2 : d.c2,
            angle: Number.isFinite(angle) ? clamp(angle, 0, 360) : d.angle,
            glow: Boolean(p.glow),
            glowStrength: Number.isFinite(strength) ? clamp(strength, 0, 100) : d.glowStrength,
        };
    }
    return out;
}

/** '#rgb' / '#rrggbb' → {r,g,b}；非法输入返回 null */
export function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

/** 角度是否接近垂直（±22.5° 内视为垂直走向） */
export function isVertical(angle) {
    const a = ((angle % 360) + 360) % 360;
    return a <= 22.5 || a >= 337.5 || (a >= 157.5 && a <= 202.5);
}

/** 第 i 个字符（共 n 个）在渐变上的位置 t ∈ [0,1]；水平分量向左时自动反向 */
export function gradientT(i, n, angle) {
    if (!Number.isFinite(n) || n <= 1) return 0.5;
    const a = ((angle % 360) + 360) % 360;
    const dx = Math.cos((a * Math.PI) / 180);
    const t = i / (n - 1);
    return clamp(dx < 0 ? 1 - t : t, 0, 1);
}

export function lerpColor(c1, c2, t) {
    const f = clamp(t, 0, 1);
    return {
        r: Math.round(c1.r + (c2.r - c1.r) * f),
        g: Math.round(c1.g + (c2.g - c1.g) * f),
        b: Math.round(c1.b + (c2.b - c1.b) * f),
    };
}

export function cssColor(c, alpha) {
    if (alpha === undefined || alpha === null) return `rgb(${c.r},${c.g},${c.b})`;
    return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/**
 * 三层霓虹光晕（text-shadow 片段）：
 * 近层小半径高亮边 + 中层柔晕 + 外层大半径扩散。
 * 模糊半径与不透明度随强度 s（0–1）联动；s=0 返回 'none'。
 */
export function haloLayers(rgb, strength) {
    const s = clamp(strength, 0, 1);
    if (s <= 0) return 'none';
    const nearR = 0.5 + 2 * s;
    const midR = 6 * s;
    const farR = 16 * s;
    const a1 = (0.55 + 0.4 * s).toFixed(3);
    const a2 = (0.15 + 0.35 * s).toFixed(3);
    const a3 = (0.04 + 0.26 * s).toFixed(3);
    return [
        `0 0 ${nearR.toFixed(2)}px ${cssColor(rgb, a1)}`,
        `0 0 ${midR.toFixed(2)}px ${cssColor(rgb, a2)}`,
        `0 0 ${farR.toFixed(2)}px ${cssColor(rgb, a3)}`,
    ].join(', ');
}

/** 渐变中间色（接近垂直角度整段着色用） */
export function midColor(c1Hex, c2Hex) {
    const c1 = hexToRgb(c1Hex) || { r: 127, g: 193, b: 255 };
    const c2 = hexToRgb(c2Hex) || { r: 255, g: 210, b: 127 };
    return lerpColor(c1, c2, 0.5);
}

/** 把一段文本按成对中英文双引号切分为「引用 / 普通」段；引号本身计入引用段 */
export function splitDialogue(text) {
    const out = [];
    const re = /“[^”\n]*”|"[^"\n]*"/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push({ text: text.slice(last, m.index), quote: false });
        out.push({ text: m[0], quote: true });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), quote: false });
    return out;
}

/** 配置指纹：用于判断相邻文本段是否可合并进同一个渲染 span */
export function settingsFp(cfg) {
    return [cfg.mode, cfg.solid, cfg.c1, cfg.c2, cfg.angle, cfg.glow ? 1 : 0, cfg.glowStrength].join('|');
}
