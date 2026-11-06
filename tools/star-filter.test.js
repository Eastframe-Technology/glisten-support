// Run with: node --test tools/star-filter.test.js
// The formulas come from the Glisten app (lib/logic/effect.dart and
// android/.../SparkleGl.kt). The app has no vectors for the renderer, which it
// checks by decoding exported files, so these test what the effect must do on
// small synthetic pictures. Nothing here needs a browser.
const test = require('node:test');
const assert = require('node:assert');
const F = require('./star-filter.js');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `got ${a}, expected ${b} +/- ${tol}`);

function picture(w, h, fill) {
  const p = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < p.length; i += 4) { p[i] = p[i + 1] = p[i + 2] = fill; p[i + 3] = 255; }
  return p;
}
function dot(p, w, h, cx, cy, r, v = 255) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    const i = (y * w + x) * 4;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
}
const at = (out, w, x, y) => out[(Math.round(y) * w + Math.round(x)) * 4];
const NO_GLITTER = { glitter: 0, glow: 0, rayStrength: 1, threshold: 0.78 };

test('sensitivity maps both ways, as in the app', () => {
  for (const v of [0, 0.25, 0.5, 1]) close(F.sensitivityFor(F.thresholdFor(v)), v);
  close(F.thresholdFor(0), 0.95);
  close(F.thresholdFor(1), 0.55);
  close(F.sensitivityFor(0.78), 0.425);
});

test('the same four styles as the free version of the app', () => {
  assert.deepStrictEqual(Object.keys(F.STYLES), ['cross', 'twinkle', 'starburst', 'glow']);
  assert.strictEqual(F.STYLES.cross.rays, 4);
  assert.strictEqual(F.STYLES.cross.angle, 45);
  assert.strictEqual(F.STYLES.twinkle.rays, 0);
  assert.strictEqual(F.STYLES.starburst.rays, 8);
  assert.strictEqual(F.STYLES.glow.rays, 0);
  for (const s of Object.values(F.STYLES)) {
    assert.ok([0, 2, 4, 6, 8].includes(s.rays));
    assert.ok([4, 6, 8].includes(s.glitterRays));
  }
});

test('the blend: worked example on the page, and it can only brighten', () => {
  close(F.blend8(153, 0.5), 255 - 102 * Math.exp(-0.5));
  close(F.blend8(153, 0.5), 193.1, 0.05);
  assert.strictEqual(F.blend8(153, 0), 153);
  assert.strictEqual(F.blend8(255, 3), 255);
  assert.ok(F.blend8(0, 100) > 254.9);
});

test('twinkle: range and a stopped twinkle', () => {
  assert.strictEqual(F.twinkle(1.3, 0, 0.2, 0.7), 1);
  for (let t = 0; t < 5; t += 0.37) {
    const v = F.twinkle(t, 0.5, F.hash(t), F.hash(t + 17.3));
    assert.ok(v >= 0 && v <= 1);
  }
  for (const x of [0, 1, 7.77, 1000.5]) {
    const h = F.hash(x);
    assert.ok(h >= 0 && h < 1);
    assert.strictEqual(h, F.hash(x));
  }
});

test('findMaxima: one peak, centroid, strongest first, minimum value', () => {
  const w = 7, h = 7, lum = new Float64Array(w * h);
  lum[3 * w + 3] = 0.8;
  let r = F.findMaxima(lum, w, h);
  assert.strictEqual(r.length, 1);
  close(r[0].x, 3.5 / 7);
  close(r[0].y, 3.5 / 7);
  assert.strictEqual(r[0].cell, 3 * 997 + 3);
  lum[1 * w + 1] = 0.9;
  lum[5 * w + 5] = 0.03; // under the 0.04 floor
  r = F.findMaxima(lum, w, h);
  assert.deepStrictEqual(r.map((m) => m.value), [0.9, 0.8]);
});

test('findMaxima: a plateau gives one peak, not two', () => {
  const w = 6, h = 5, lum = new Float64Array(w * h);
  lum[2 * w + 2] = 0.5;
  lum[2 * w + 3] = 0.5;
  assert.strictEqual(F.findMaxima(lum, w, h).length, 1);
});

test('a white wall does not flare', () => {
  const w = 200, h = 150;
  const src = picture(w, h, 245);
  const res = F.render(src, w, h, F.STYLES.cross);
  assert.strictEqual(res.highlights, 0);
  assert.strictEqual(res.stars, 0);
});

test('a dark picture is left exactly as it was', () => {
  const w = 120, h = 90, src = picture(w, h, 40);
  const out = new Uint8ClampedArray(w * h * 4);
  F.render(src, w, h, F.STYLES.cross, out);
  assert.deepStrictEqual(out, src);
});

test('no rays, no glow, no glitter: the picture is unchanged', () => {
  const w = 300, h = 200, src = picture(w, h, 30);
  dot(src, w, h, 150, 100, 4);
  const out = new Uint8ClampedArray(w * h * 4);
  F.render(src, w, h, { rays: 0, glow: 0, glitter: 0 }, out);
  assert.deepStrictEqual(out, src);
});

test('the effect only adds light, keeps alpha opaque and repeats exactly', () => {
  const w = 300, h = 200, src = picture(w, h, 60);
  dot(src, w, h, 80, 60, 3);
  dot(src, w, h, 220, 140, 5);
  const a = new Uint8ClampedArray(w * h * 4), b = new Uint8ClampedArray(w * h * 4);
  F.render(src, w, h, F.STYLES.starburst, a);
  F.render(src, w, h, F.STYLES.starburst, b);
  assert.deepStrictEqual(a, b);
  for (let i = 0; i < a.length; i += 4) {
    assert.ok(a[i] >= src[i]);
    assert.strictEqual(a[i + 3], 255);
  }
});

test('four rays at 45 degrees light the diagonals, not the axes', () => {
  const w = 400, h = 400, src = picture(w, h, 10);
  dot(src, w, h, 200, 200, 6);
  const out = new Uint8ClampedArray(w * h * 4);
  F.render(src, w, h, Object.assign({}, NO_GLITTER, { rays: 4, angle: 45, length: 0.5 }), out);
  const d = 40, k = d * Math.SQRT1_2;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) assert.ok(at(out, w, 200 + sx * k, 200 + sy * k) > 40, 'diagonal');
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.ok(at(out, w, 200 + sx * d, 200 + sy * d) < 20, 'axis');
});

test('the angle turns clockwise on screen, as in the app', () => {
  const w = 400, h = 400, src = picture(w, h, 10);
  dot(src, w, h, 200, 200, 6);
  const out = new Uint8ClampedArray(w * h * 4);
  F.render(src, w, h, Object.assign({}, NO_GLITTER, { rays: 2, angle: 30, length: 0.5 }), out);
  const d = 40, c = d * Math.cos(Math.PI / 6), s = d * Math.sin(Math.PI / 6);
  assert.ok(at(out, w, 200 + c, 200 + s) > 40, 'down and to the right');
  assert.ok(at(out, w, 200 - c, 200 - s) > 40, 'and its opposite');
  assert.ok(at(out, w, 200 + c, 200 - s) < 20, 'not the mirror image');
});

test('a longer ray setting reaches further', () => {
  const w = 400, h = 400, src = picture(w, h, 10);
  dot(src, w, h, 200, 200, 6);
  const reach = (length) => {
    const out = new Uint8ClampedArray(w * h * 4);
    F.render(src, w, h, Object.assign({}, NO_GLITTER, { rays: 2, angle: 0, length }), out);
    let x = 399;
    while (x > 200 && at(out, w, x, 200) < 20) x--;
    return x - 200;
  };
  assert.ok(reach(0.8) > reach(0.3) * 1.5);
});

test('rays scale with the picture: twice the size, twice the reach', () => {
  const reach = (n) => {
    const src = picture(n, n, 10);
    dot(src, n, n, n / 2, n / 2, Math.round(n / 60));
    const out = new Uint8ClampedArray(n * n * 4);
    F.render(src, n, n, Object.assign({}, NO_GLITTER, { rays: 2, angle: 0, length: 0.5 }), out);
    let x = n - 1;
    while (x > n / 2 && at(out, n, x, n / 2) < 20) x--;
    return (x - n / 2) / n;
  };
  close(reach(800), reach(400), 0.04);
});

test('sensitivity decides which lights count', () => {
  const w = 300, h = 300, src = picture(w, h, 10);
  dot(src, w, h, 150, 150, 6, 190); // about 0.75 luminance
  assert.strictEqual(F.render(src, w, h, { threshold: F.thresholdFor(0), glitter: 0 }).highlights, 0);
  assert.ok(F.render(src, w, h, { threshold: F.thresholdFor(1), glitter: 0 }).highlights > 0);
});

test('glitter puts a star on each light, up to the amount asked for', () => {
  const w = 600, h = 400, src = picture(w, h, 10);
  for (let i = 0; i < 5; i++) dot(src, w, h, 80 + i * 110, 200, 5);
  const res = F.render(src, w, h, { rays: 0, glow: 0, glitter: 1, threshold: 0.78 });
  assert.strictEqual(res.stars, 5);
  assert.strictEqual(F.render(src, w, h, { rays: 0, glow: 0, glitter: 2 / 48, threshold: 0.78 }).stars, 2);
  assert.strictEqual(F.render(src, w, h, { rays: 0, glow: 0, glitter: 0, threshold: 0.78 }).stars, 0);
});

test('tiny and awkward sizes do not throw', () => {
  for (const [w, h] of [[1, 1], [2, 3], [5, 5], [640, 1], [1, 640]]) {
    const src = picture(w, h, 250);
    assert.doesNotThrow(() => F.render(src, w, h, F.STYLES.starburst));
  }
});
