import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CATS,
    defaultSettings,
    normalizeSettings,
    hexToRgb,
    isVertical,
    gradientT,
    lerpColor,
    cssColor,
    haloLayers,
    splitDialogue,
    settingsFp,
} from '../engine.js';

test('默认配置包含三类文本且默认跟随酒馆', () => {
    assert.deepEqual(CATS, ['main', 'italic', 'quote']);
    for (const cat of CATS) {
        assert.equal(defaultSettings[cat].mode, 'follow');
        assert.equal(defaultSettings[cat].glow, false);
    }
});

test('normalizeSettings 合并默认并容错', () => {
    const s = normalizeSettings({ enabled: false, main: { mode: 'gradient', angle: 999, glowStrength: -5 } });
    assert.equal(s.enabled, false);
    assert.equal(s.main.mode, 'gradient');
    assert.equal(s.main.angle, 360);
    assert.equal(s.main.glowStrength, 0);
    assert.equal(s.main.c1, defaultSettings.main.c1);
    assert.equal(s.italic.mode, 'follow');
    const empty = normalizeSettings(undefined);
    assert.equal(empty.enabled, true);
    assert.equal(empty.quote.mode, 'follow');
});

test('hexToRgb 支持 #rrggbb 与 #rgb，非法输入返回 null', () => {
    assert.deepEqual(hexToRgb('#7fc1ff'), { r: 127, g: 193, b: 255 });
    assert.deepEqual(hexToRgb('abc'), { r: 170, g: 187, b: 204 });
    assert.equal(hexToRgb('nope'), null);
    assert.equal(hexToRgb('#12345'), null);
});

test('isVertical 判定（±22.5° 视为垂直走向）', () => {
    for (const a of [0, 180, 360, 22, 158, 202, 338]) assert.ok(isVertical(a), `${a}° 应为垂直`);
    for (const a of [23, 90, 135, 270, 337]) assert.ok(!isVertical(a), `${a}° 应为水平`);
});

test('gradientT 90° 从左到右，270° 反向，单字符取中间', () => {
    const n = 5;
    assert.equal(gradientT(0, n, 90), 0);
    assert.equal(gradientT(2, n, 90), 0.5);
    assert.equal(gradientT(4, n, 90), 1);
    assert.equal(gradientT(0, 4, 270), 1);
    assert.equal(gradientT(3, 4, 270), 0);
    assert.equal(gradientT(0, 1, 90), 0.5);
});

test('lerpColor 与 cssColor', () => {
    const c = lerpColor({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 255 }, 0.5);
    assert.deepEqual(c, { r: 50, g: 100, b: 128 });
    assert.equal(cssColor(c), 'rgb(50,100,128)');
    assert.equal(cssColor(c, '0.5'), 'rgba(50,100,128,0.5)');
});

test('haloLayers：三层结构、满强度外层 16px、零强度返回 none', () => {
    const rgb = { r: 0, g: 0, b: 255 };
    const full = haloLayers(rgb, 1);
    const layers = full.match(/0 0 [\d.]+px rgba\(/g) || [];
    assert.equal(layers.length, 3);
    assert.ok(full.includes('2.50px'), '满强度近层 2.50px');
    assert.ok(full.includes('6.00px'), '满强度中层 6.00px');
    assert.ok(full.includes('16.00px'), '满强度外层 16.00px');
    assert.ok(full.includes('rgba(0,0,255,0.950)'), '近层高饱和亮边');
    assert.ok(full.includes('rgba(0,0,255,0.500)'), '中层柔晕');
    assert.ok(full.includes('rgba(0,0,255,0.300)'), '外层扩散');
    assert.equal(haloLayers(rgb, 0), 'none');
    const mid = haloLayers(rgb, 0.5);
    assert.ok(mid.includes('8.00px'), '半强度外层 8.00px');
    assert.ok(mid.includes('3.00px'), '半强度中层 3.00px');
});

test('splitDialogue：成对中英文双引号切分为引用段，引号计入引用', () => {
    const segs = splitDialogue('他说“你好”，然后走了');
    assert.equal(segs.length, 3);
    assert.deepEqual(segs.map(s => s.quote), [false, true, false]);
    assert.equal(segs[1].text, '“你好”');
    const en = splitDialogue('He said "hi" today');
    assert.equal(en.length, 3);
    assert.equal(en[1].quote, true);
    assert.equal(en[1].text, '"hi"');
    const none = splitDialogue('没有引号的一段话');
    assert.equal(none.length, 1);
    assert.equal(none[0].quote, false);
    const loose = splitDialogue('只有一个“半引号');
    assert.equal(loose.length, 1);
    assert.equal(loose[0].quote, false);
});

test('settingsFp 随关键字段变化', () => {
    const base = { mode: 'gradient', solid: '#fff', c1: '#111', c2: '#222', angle: 90, glow: false, glowStrength: 60 };
    const fp1 = settingsFp(base);
    const fp2 = settingsFp({ ...base, angle: 120 });
    const fp3 = settingsFp({ ...base, glow: true });
    assert.notEqual(fp1, fp2);
    assert.notEqual(fp1, fp3);
    assert.equal(fp1, settingsFp({ ...base }));
});
