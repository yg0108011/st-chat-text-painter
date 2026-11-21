/**
 * st-chat-text-painter · 聊天文字调色（SillyTavern UI 扩展）
 *
 * 功能：仅作用于酒馆聊天消息正文（#chat .mes .mes_text），
 * 对「主要文本 / 斜体文本 / 引用文本（含成对双引号对话）」三类文本分别调色：
 *   - 跟随酒馆：不覆盖，交给主题
 *   - 纯色：自定义颜色（CSS 覆盖，不拆 DOM）
 *   - 渐变：自定义起止色与角度；光晕开关 + 强度 0–100
 *
 * 光晕实现：渐变开光晕时逐字按角度取色，每个字符挂「跟随字色」的三层
 * text-shadow（近层亮边 + 中层柔晕 + 外层扩散）；接近垂直的角度取渐变
 * 中间色整段着色。性能策略：离屏消息通过 IntersectionObserver 门控关闭
 * 光晕、进入视口自动恢复；流式生成期间以 rAF + 40ms 节流实时重绘。
 */
import {
    CATS,
    normalizeSettings,
    hexToRgb,
    lerpColor,
    cssColor,
    haloLayers,
    gradientT,
    isVertical,
    splitDialogue,
    settingsFp,
} from './engine.js';

(() => {
    'use strict';

    const MODULE_NAME = 'st_chat_text_painter';
    const CAT_LABELS = { main: '主要文本', italic: '斜体文本', quote: '引用文本' };
    const CHAT_MES_SEL = '#chat .mes .mes_text';
    const PREVIEW_TEXT = '山有木兮木有枝，心悦君兮君不知';
    const FB1 = { r: 127, g: 193, b: 255 };
    const FB2 = { r: 255, g: 210, b: 127 };

    let settings = null;
    let prevCfg = {};              // 每类文本上一次配置，用于判断全量重绘还是原地刷新
    let internal = 0;              // 自身 DOM 变更计数，观察器据此跳过
    let streaming = false;
    let lastLivePaint = 0;
    let queue = [];
    let queuedSet = new Set();
    let observedMes = new WeakSet();
    let loopScheduled = false;
    let dynStyle = null;
    let observer = null;
    let io = null;
    let chatEl = null;
    let refreshPending = new Set();
    let refreshScheduled = false;

    /* ================= 设置 ================= */

    function getSettings() {
        if (settings) return settings;
        const ctx = SillyTavern.getContext();
        settings = normalizeSettings(ctx.extensionSettings[MODULE_NAME]);
        ctx.extensionSettings[MODULE_NAME] = settings;
        ctx.saveSettingsDebounced();
        return settings;
    }

    function save() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    /* ================= 动态 CSS（纯色模式，不拆 DOM） ================= */

    function rebuildDynamicCss() {
        const s = getSettings();
        let css = '';
        if (s.enabled) {
            const m = s.main, it = s.italic, q = s.quote;
            if (m.mode === 'solid') {
                css += `${CHAT_MES_SEL}{color:${m.solid}!important;-webkit-text-fill-color:currentColor!important;}`;
            }
            if (it.mode === 'solid') {
                css += `${CHAT_MES_SEL} em,${CHAT_MES_SEL} i{color:${it.solid}!important;-webkit-text-fill-color:currentColor!important;}`;
            }
            if (q.mode === 'solid') {
                css += `${CHAT_MES_SEL} blockquote,${CHAT_MES_SEL} q{color:${q.solid}!important;-webkit-text-fill-color:currentColor!important;}`;
            }
        }
        dynStyle.textContent = css;
    }

    /* ================= DOM 染色引擎 ================= */

    /**
     * 逐字符构建 span。
     * useVars=true 时（聊天正文）颜色/光晕写入 CSS 变量，由 style.css 的
     * 高特异性 !important 规则兜底，防御主题自带 !important 文字阴影与
     * -webkit-text-fill-color；useVars=false 时（设置面板预览）直接内联。
     */
    function appendChars(wrap, text, cfg, s, c1, c2, useVars) {
        const chars = [...text].filter(ch => ch !== '\n');
        const n = chars.length;
        let idx = 0;
        for (const ch of text) {
            if (ch === '\n') {
                wrap.appendChild(document.createTextNode('\n'));
                continue;
            }
            const t = gradientT(idx, n, cfg.angle);
            idx++;
            const col = lerpColor(c1, c2, t);
            const sp = document.createElement('span');
            sp.className = 'ctp-ch';
            if (useVars) {
                sp.style.setProperty('--ctp-color', cssColor(col));
                sp.style.setProperty('--ctp-halo', haloLayers(col, s));
            } else {
                sp.style.color = cssColor(col);
                sp.style.textShadow = haloLayers(col, s);
                sp.style.webkitTextFillColor = cssColor(col);
            }
            sp.textContent = ch;
            wrap.appendChild(sp);
        }
    }

    /** 为一段文本构建运行时 span；无需渲染时返回 null */
    function buildRunSpan(text, kind, force = false) {
        const cfg = getSettings()[kind];
        if (cfg.mode === 'follow') return null;
        if (cfg.mode === 'solid') {
            // 纯色模式：blockquote / em / 主要文本走动态 CSS；成对双引号对话
            // 无法用 CSS 选择器命中，仅在 force 时（对话段）内联着色
            if (kind === 'quote' && force) {
                const span = document.createElement('span');
                span.className = 'ctp-run ctp-quote-solid';
                span.dataset.cat = kind;
                span.dataset.fp = settingsFp(cfg);
                span.style.setProperty('--ctp-color', cfg.solid);
                span.textContent = text;
                return span;
            }
            return null;
        }
        // 渐变模式
        const c1 = hexToRgb(cfg.c1) || FB1;
        const c2 = hexToRgb(cfg.c2) || FB2;
        const s = cfg.glowStrength / 100;
        const fp = settingsFp(cfg);
        if (!cfg.glow) {
            // 光晕关闭：纯 CSS 渐变裁切，最平滑、最轻量
            const span = document.createElement('span');
            span.className = 'ctp-run ctp-grad';
            span.dataset.cat = kind;
            span.dataset.fp = fp;
            span.style.setProperty('--ctp-c1', cfg.c1);
            span.style.setProperty('--ctp-c2', cfg.c2);
            span.style.setProperty('--ctp-ang', `${cfg.angle}deg`);
            span.textContent = text;
            return span;
        }
        if (isVertical(cfg.angle)) {
            // 接近垂直的角度：整段取渐变中间色 + 三层光晕（不拆字符）
            const mid = lerpColor(c1, c2, 0.5);
            const span = document.createElement('span');
            span.className = 'ctp-run ctp-vert';
            span.dataset.cat = kind;
            span.dataset.fp = fp;
            span.style.setProperty('--ctp-color', cssColor(mid));
            span.style.setProperty('--ctp-halo', haloLayers(mid, s));
            span.textContent = text;
            return span;
        }
        // 水平走向 + 光晕：逐字符按角度投影取色，光晕逐字跟随字色
        const wrap = document.createElement('span');
        wrap.className = 'ctp-run ctp-chars';
        wrap.dataset.cat = kind;
        wrap.dataset.fp = fp;
        appendChars(wrap, text, cfg, s, c1, c2, true);
        return wrap;
    }

    /** 给一个文本节点上色；与左邻同类别同配置的 span 自动合并（流式追加友好） */
    function paintRun(node, kind, force = false) {
        const text = node.data;
        if (!text || !text.trim()) return;
        const cfg = getSettings()[kind];
        if (cfg.mode === 'follow') return;
        if (cfg.mode === 'solid' && !(kind === 'quote' && force)) return;
        const fp = settingsFp(cfg);
        const prev = node.previousSibling;
        if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.classList.contains('ctp-run')
            && prev.dataset.cat === kind && prev.dataset.fp === fp) {
            if (prev.classList.contains('ctp-chars')) {
                appendChars(prev, text, cfg, cfg.glowStrength / 100,
                    hexToRgb(cfg.c1) || FB1, hexToRgb(cfg.c2) || FB2, true);
            } else {
                prev.textContent += text;
            }
            node.remove();
            return;
        }
        const span = buildRunSpan(text, kind, force);
        if (!span) return;
        internal++;
        try { node.replaceWith(span); } finally { internal--; }
    }

    /** 主要文本中的成对双引号对话切出来按「引用」类别上色 */
    function paintText(node, kind) {
        const data = node.data;
        if (!data || !data.trim()) return;
        if (kind === 'main' && getSettings().quote.mode !== 'follow') {
            const segs = splitDialogue(data);
            if (segs.some(x => x.quote)) {
                const frag = document.createDocumentFragment();
                for (const seg of segs) {
                    const tn = document.createTextNode(seg.text);
                    frag.appendChild(tn);
                    paintRun(tn, seg.quote ? 'quote' : 'main', seg.quote);
                }
                internal++;
                try { node.replaceWith(frag); } finally { internal--; }
                return;
            }
        }
        paintRun(node, kind, false);
    }

    /** 递归遍历消息正文：em/i → 斜体类别，blockquote/q → 引用类别，其余 → 主文本 */
    function walkNode(node, kind) {
        if (node.nodeType === Node.TEXT_NODE) {
            paintText(node, kind);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName;
        if (tag === 'BR' || tag === 'HR' || tag === 'SCRIPT' || tag === 'STYLE') return;
        if (node.classList && node.classList.contains('ctp-run')) return; // 已染色
        if (tag === 'EM' || tag === 'I') {
            for (const child of Array.from(node.childNodes)) walkNode(child, 'italic');
            return;
        }
        if (tag === 'BLOCKQUOTE' || tag === 'Q') {
            for (const child of Array.from(node.childNodes)) walkNode(child, 'quote');
            return;
        }
        for (const child of Array.from(node.childNodes)) walkNode(child, kind);
    }

    function paintTree(root) {
        for (const node of Array.from(root.childNodes)) walkNode(node, 'main');
    }

    /** 拆掉本条消息内所有染色 span，恢复原始文本节点（幂等） */
    function unwrapRuns(mt) {
        const runs = mt.querySelectorAll('.ctp-run');
        for (const span of runs) {
            const parent = span.parentNode;
            if (!parent) continue;
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            parent.removeChild(span);
        }
    }

    /* ================= 调度 / 队列 / 观察器 ================= */

    function needsPaint() {
        const s = getSettings();
        if (!s.enabled) return false;
        return CATS.some(c => s[c].mode === 'gradient') || s.quote.mode !== 'follow';
    }

    function isLiveMes(mt) {
        if (!chatEl) return false;
        const last = chatEl.lastElementChild;
        return !!(last && last.classList.contains('mes') && mt.closest('.mes') === last);
    }

    function paintMessage(mt) {
        const s = getSettings();
        if (!s.enabled || !needsPaint()) {
            mt.dataset.ctpDone = '1';
            return;
        }
        // 流式生成中的最后一条消息：40ms 节流，避免每 token 全量重绘
        if (streaming && isLiveMes(mt)) {
            const now = performance.now();
            if (now - lastLivePaint < 40) {
                requeue(mt);
                return;
            }
            lastLivePaint = now;
        }
        internal++;
        try {
            unwrapRuns(mt);
            paintTree(mt);
            mt.dataset.ctpDone = '1';
        } finally {
            internal--;
        }
    }

    function requeue(mt) {
        if (queuedSet.has(mt)) return;
        queuedSet.add(mt);
        queue.push(mt);
        scheduleLoop();
    }

    function enqueuePaint(mt) {
        observeMes(mt);
        if (queuedSet.has(mt)) return;
        queuedSet.add(mt);
        queue.push(mt);
        scheduleLoop();
    }

    function observeMes(mt) {
        if (io && !observedMes.has(mt)) {
            observedMes.add(mt);
            io.observe(mt);
        }
    }

    function scheduleLoop() {
        if (loopScheduled) return;
        loopScheduled = true;
        requestAnimationFrame(loopTick);
    }

    /** 每帧最多用 12ms 处理消息，长聊天分批重绘不卡 UI */
    function loopTick() {
        loopScheduled = false;
        const start = performance.now();
        while (queue.length) {
            const mt = queue.shift();
            queuedSet.delete(mt);
            if (!mt.isConnected) continue;
            paintMessage(mt);
            if (performance.now() - start > 12) {
                scheduleLoop();
                break;
            }
        }
    }

    function invalidateAll() {
        if (!chatEl) return;
        chatEl.querySelectorAll('.mes .mes_text').forEach(mt => {
            delete mt.dataset.ctpDone;
            if (!mt.classList.contains('ctp-out')) enqueuePaint(mt);
        });
    }

    function initObserver() {
        chatEl = document.getElementById('chat');
        if (!chatEl) {
            setTimeout(initObserver, 300);
            return;
        }
        if (!observer) {
            observer = new MutationObserver(muts => {
                if (internal > 0) return;
                for (const m of muts) {
                    let el = m.type === 'characterData' ? m.target.parentElement
                        : (m.target.nodeType === 1 ? m.target : m.target.parentElement);
                    if (!el || !el.closest) continue;
                    const mt = el.closest('.mes_text');
                    if (mt && chatEl.contains(mt)) enqueuePaint(mt);
                }
            });
        }
        observer.observe(chatEl, { childList: true, subtree: true, characterData: true });
        if (!io) {
            // 离屏光晕门控：视口外 600px 余量内的消息关闭逐字光晕，回到视口自动恢复
            io = new IntersectionObserver(entries => {
                for (const e of entries) {
                    const mt = e.target;
                    if (e.isIntersecting) {
                        mt.classList.remove('ctp-out');
                        if (!mt.dataset.ctpDone) enqueuePaint(mt);
                    } else {
                        mt.classList.add('ctp-out');
                    }
                }
            }, { rootMargin: '600px 0px 600px 0px' });
        }
        invalidateAll();
    }

    /* ================= 配置变更 ================= */

    function scheduleRefresh(cat) {
        refreshPending.add(cat);
        if (refreshScheduled) return;
        refreshScheduled = true;
        requestAnimationFrame(() => {
            refreshScheduled = false;
            const cats = [...refreshPending];
            refreshPending.clear();
            for (const c of cats) refreshInPlace(c);
        });
    }

    /** 模式与光晕开关未变时，原地更新颜色 / 角度 / 强度，不重拆 DOM */
    function refreshInPlace(kind) {
        const cfg = getSettings()[kind];
        const s = cfg.glowStrength / 100;
        const c1 = hexToRgb(cfg.c1) || FB1;
        const c2 = hexToRgb(cfg.c2) || FB2;
        document.querySelectorAll(`${CHAT_MES_SEL} .ctp-run[data-cat="${kind}"]`).forEach(run => {
            if (run.classList.contains('ctp-grad')) {
                run.style.setProperty('--ctp-c1', cfg.c1);
                run.style.setProperty('--ctp-c2', cfg.c2);
                run.style.setProperty('--ctp-ang', `${cfg.angle}deg`);
            } else if (run.classList.contains('ctp-chars')) {
                const spans = run.querySelectorAll('span.ctp-ch');
                const n = spans.length;
                let i = 0;
                for (const sp of spans) {
                    const col = lerpColor(c1, c2, gradientT(i, n, cfg.angle));
                    sp.style.setProperty('--ctp-color', cssColor(col));
                    sp.style.setProperty('--ctp-halo', haloLayers(col, s));
                    i++;
                }
            } else if (run.classList.contains('ctp-vert')) {
                const mid = lerpColor(c1, c2, 0.5);
                run.style.setProperty('--ctp-color', cssColor(mid));
                run.style.setProperty('--ctp-halo', haloLayers(mid, s));
            } else if (run.classList.contains('ctp-quote-solid')) {
                run.style.setProperty('--ctp-color', cfg.solid);
            }
        });
    }

    function applyChange(cat) {
        rebuildDynamicCss();
        const cfg = getSettings()[cat];
        const prev = prevCfg[cat];
        const repaint = !prev || prev.mode !== cfg.mode || prev.glow !== cfg.glow;
        prevCfg[cat] = { ...cfg };
        if (repaint) {
            invalidateAll();
        } else {
            scheduleRefresh(cat);
        }
    }

    function applyEnabled() {
        const s = getSettings();
        if (!s.enabled && chatEl) {
            chatEl.querySelectorAll('.mes .mes_text').forEach(mt => {
                unwrapRuns(mt);
                delete mt.dataset.ctpDone;
            });
        }
        rebuildDynamicCss();
        invalidateAll();
    }

    /* ================= 设置面板 ================= */

    function validHex(v) {
        return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim());
    }

    function updatePreview(card, cat) {
        const cfg = getSettings()[cat];
        const pv = card.querySelector('.ctp-preview');
        if (!pv) return;
        pv.style.cssText = '';
        pv.textContent = '';
        if (cfg.mode === 'solid') {
            pv.textContent = PREVIEW_TEXT;
            pv.style.color = cfg.solid;
            pv.style.webkitTextFillColor = cfg.solid;
            return;
        }
        if (cfg.mode !== 'gradient') {
            pv.textContent = PREVIEW_TEXT;
            return;
        }
        const c1 = hexToRgb(cfg.c1) || FB1;
        const c2 = hexToRgb(cfg.c2) || FB2;
        const s = cfg.glowStrength / 100;
        if (cfg.glow && !isVertical(cfg.angle)) {
            // 与聊天正文一致的逐字取色 + 三层光晕
            appendChars(pv, PREVIEW_TEXT, cfg, s, c1, c2, false);
            return;
        }
        pv.textContent = PREVIEW_TEXT;
        pv.style.backgroundImage = `linear-gradient(${cfg.angle}deg, ${cfg.c1}, ${cfg.c2})`;
        pv.style.webkitBackgroundClip = 'text';
        pv.style.backgroundClip = 'text';
        pv.style.color = 'transparent';
        pv.style.webkitTextFillColor = 'transparent';
        if (cfg.glow) {
            const mid = lerpColor(c1, c2, 0.5);
            pv.style.textShadow = haloLayers(mid, s);
        } else {
            pv.style.textShadow = 'none';
        }
    }

    function syncCard(card, cat) {
        const cfg = getSettings()[cat];
        card.dataset.mode = cfg.mode;
        card.querySelector('select[data-key="mode"]').value = cfg.mode;
        const solidColor = card.querySelector('input[data-key="solid"][type="color"]');
        const solidHex = card.querySelector('input[data-key="solid"][type="text"]');
        solidColor.value = validHex(cfg.solid) ? cfg.solid.toLowerCase() : '#e8e8e8';
        solidHex.value = cfg.solid;
        card.querySelector('input[data-key="c1"]').value = validHex(cfg.c1) ? cfg.c1.toLowerCase() : '#7fc1ff';
        card.querySelector('input[data-key="c2"]').value = validHex(cfg.c2) ? cfg.c2.toLowerCase() : '#ffd27f';
        const aR = card.querySelector('input[data-key="angle"][type="range"]');
        const aN = card.querySelector('input[data-key="angle"][type="number"]');
        aR.value = cfg.angle;
        aN.value = cfg.angle;
        const g = card.querySelector('input[data-key="glow"]');
        g.checked = cfg.glow;
        const sR = card.querySelector('input[data-key="glowStrength"][type="range"]');
        const sN = card.querySelector('input[data-key="glowStrength"][type="number"]');
        sR.value = cfg.glowStrength;
        sN.value = cfg.glowStrength;
        sR.disabled = !cfg.glow;
        sN.disabled = !cfg.glow;
        updatePreview(card, cat);
    }

    function onCardInput(cat, card, ev) {
        const t = ev.target;
        if (!t.dataset || !t.dataset.key) return;
        const key = t.dataset.key;
        const s = getSettings();
        let val;
        if (key === 'glow') {
            val = t.checked;
        } else if (key === 'mode') {
            val = t.value;
        } else if (key === 'angle' || key === 'glowStrength') {
            val = Number(t.value);
            if (!Number.isFinite(val)) return;
            val = key === 'angle'
                ? Math.min(360, Math.max(0, val))
                : Math.min(100, Math.max(0, val));
        } else {
            val = t.value.trim();
            if (key === 'solid' || key === 'c1' || key === 'c2') {
                if (t.type === 'text' && !validHex(val)) {
                    syncCard(card, cat);
                    return;
                }
                if (t.type === 'text') val = val.toLowerCase();
            }
        }
        if (s[cat][key] === val) {
            syncCard(card, cat);
            return;
        }
        s[cat][key] = val;
        save();
        syncCard(card, cat);
        applyChange(cat);
    }

    function bindSettingsUi() {
        const panel = document.getElementById('ctp-settings');
        if (!panel) return;
        const s = getSettings();
        const master = document.getElementById('ctp-enabled');
        if (master) {
            master.checked = s.enabled;
            master.addEventListener('change', () => {
                s.enabled = master.checked;
                save();
                applyEnabled();
            });
        }
        const repaintBtn = document.getElementById('ctp-repaint');
        if (repaintBtn) {
            repaintBtn.addEventListener('click', () => invalidateAll());
        }
        for (const cat of CATS) {
            const card = panel.querySelector(`.ctp-card[data-cat="${cat}"]`);
            if (!card) continue;
            card.addEventListener('input', ev => onCardInput(cat, card, ev));
            card.addEventListener('change', ev => onCardInput(cat, card, ev));
            syncCard(card, cat);
        }
    }

    async function renderSettingsUi() {
        const ctx = SillyTavern.getContext();
        const data = { cats: CATS.map(k => ({ key: k, label: CAT_LABELS[k] })) };
        let html = null;
        try {
            html = await ctx.renderExtensionTemplateAsync('third-party/st-chat-text-painter', 'settings', data);
        } catch (e) {
            console.warn('[ctp] 设置模板渲染失败，尝试兜底加载', e);
        }
        if (!html) {
            try {
                let resp = await fetch('/scripts/extensions/third-party/st-chat-text-painter/settings.html');
                if (!resp.ok) resp = await fetch('/extensions/st-chat-text-painter/settings.html');
                if (resp.ok) {
                    const raw = await resp.text();
                    const compiled = SillyTavern.libs.Handlebars.compile(raw);
                    let out = compiled(data);
                    if (SillyTavern.libs.DOMPurify) out = SillyTavern.libs.DOMPurify.sanitize(out);
                    html = out;
                }
            } catch (e2) {
                console.warn('[ctp] 设置面板加载失败', e2);
            }
        }
        if (!html) return;
        const host = document.getElementById('extensions_settings2');
        if (!host) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        host.appendChild(tmp.firstElementChild);
        bindSettingsUi();
    }

    /* ================= 启动 ================= */

    function bindEvents() {
        const ctx = SillyTavern.getContext();
        ctx.eventSource.on(ctx.event_types.STREAM_TOKEN_RECEIVED, () => { streaming = true; });
        ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, () => { streaming = true; });
        ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
            streaming = false;
            setTimeout(() => invalidateAll(), 50);
        });
        ctx.eventSource.on(ctx.event_types.GENERATION_STOPPED, () => {
            streaming = false;
            setTimeout(() => invalidateAll(), 50);
        });
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            setTimeout(() => invalidateAll(), 50);
        });
    }

    async function start() {
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
            setTimeout(start, 300);
            return;
        }
        getSettings();
        dynStyle = document.createElement('style');
        dynStyle.id = 'ctp-dynamic-css';
        document.head.appendChild(dynStyle);
        rebuildDynamicCss();
        await renderSettingsUi();
        bindEvents();
        initObserver();
    }

    (function boot() {
        const ready = () => start().catch(err => console.error('[ctp] 初始化失败', err));
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            if (window.SillyTavern && SillyTavern.getContext) {
                SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, ready);
            } else {
                ready();
            }
        } else {
            window.addEventListener('DOMContentLoaded', () => {
                if (window.SillyTavern && SillyTavern.getContext) {
                    SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, ready);
                } else {
                    ready();
                }
            });
        }
    })();
})();
