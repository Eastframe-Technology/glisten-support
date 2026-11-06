// Star filter and glitter effect on a plain RGBA pixel buffer. This is a port
// to the CPU of the Glisten app's renderer (android/.../SparkleGl.kt, the same
// steps as its iOS kernels), with the same numbers wherever they carry over:
//   1. bright pass at quarter size, keeping spots that stand out from a ring
//      around them, so white walls and skies do not flare;
//   2. rays: each highlight is streaked along each direction, a fine pass that
//      fills the gaps of a coarse pass with a falling-off weight;
//   3. a soft gaussian glow;
//   4. glitter stars drawn on the local maxima of a 160-pixel highlight map;
//   5. a screen-like blend with a soft shoulder: 1 - (1 - base) * exp(-added).
// The shaders gather samples per pixel; here each highlight scatters along its
// line instead, which is the same kernel and much faster when highlights are
// few. Two choices differ on purpose, because a photo does not move: every
// star keeps some of its light instead of being caught at a dark moment of its
// twinkle, and six and eight point rays are scaled down so they do not clip
// where highlights crowd together. The style values below start softer than
// the app's, since this tool has one look per photo and no video to carry it.
// Runs in a browser (as window.StarFilter) and under node (require). It only
// reads and writes the arrays it is given. Nothing here touches the network.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StarFilter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_STARS = 96;

  var DEFAULTS = {
    threshold: 0.78, rays: 4, angle: 45, length: 0.35, rayStrength: 1.0, rainbow: 0,
    tint: [1, 1, 1], glow: 0.3, glitter: 0.4, sparkleSize: 0.45, twinkle: 0.5,
    glitterRays: 4, glitterHue: 0, glitterColor: 0, time: 0
  };

  // Based on the app's four free styles (lib/logic/effect.dart).
  var STYLES = {
    cross: { rays: 4, angle: 45, length: 0.35, rayStrength: 0.6, threshold: 0.82, glow: 0.2, glitter: 0.5, sparkleSize: 0.45, twinkle: 0.5, glitterRays: 4 },
    twinkle: { rays: 0, angle: 45, length: 0.35, rayStrength: 0.6, threshold: 0.74, glow: 0.25, glitter: 0.75, sparkleSize: 0.85, twinkle: 0.6, glitterRays: 4 },
    starburst: { rays: 8, angle: 0, length: 0.28, rayStrength: 0.6, threshold: 0.82, glow: 0.2, glitter: 0.3, sparkleSize: 0.45, twinkle: 0.5, glitterRays: 8 },
    glow: { rays: 0, angle: 45, length: 0.35, rayStrength: 0.6, threshold: 0.7, glow: 0.9, glitter: 0.15, sparkleSize: 0.35, twinkle: 0.3, glitterRays: 4 }
  };

  function params(p) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = p && p[k] !== undefined ? p[k] : DEFAULTS[k]; });
    return out;
  }

  /** "Sensitivity" as shown to the user: higher picks up dimmer highlights. */
  function thresholdFor(sensitivity) { return 0.95 - sensitivity * 0.4; }
  function sensitivityFor(threshold) { return Math.min(1, Math.max(0, (0.95 - threshold) / 0.4)); }

  function hash(x) {
    var s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  function twinkle(time, speed, h1, h2) {
    if (speed <= 0.001) return 1;
    return 0.5 + 0.5 * Math.sin(2 * Math.PI * (time * speed * 2.5 * (0.7 + 0.6 * h2) + h1));
  }

  /** Local maxima of a luminance map whose row 0 is the top, strongest first. */
  function findMaxima(lum, w, h, minValue) {
    if (minValue === undefined) minValue = 0.04;
    var res = [];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var v = lum[y * w + x];
        if (v < minValue) continue;
        var isMax = true, dx, dy, n;
        for (dy = -1; dy <= 1 && isMax; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            n = lum[(y + dy) * w + x + dx];
            if (n > v || (n === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        var sx = 0, sy = 0, sw = 0;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            n = lum[(y + dy) * w + x + dx];
            sx += dx * n; sy += dy * n; sw += n;
          }
        }
        res.push({ x: (x + 0.5 + sx / sw) / w, y: (y + 0.5 + sy / sw) / h, value: v, cell: y * 997 + x });
      }
    }
    res.sort(function (a, b) { return b.value - a.value; });
    return res;
  }

  function hue(t, out) {
    out[0] = 0.5 + 0.5 * Math.cos(6.2831853 * t);
    out[1] = 0.5 + 0.5 * Math.cos(6.2831853 * (t + 0.33));
    out[2] = 0.5 + 0.5 * Math.cos(6.2831853 * (t + 0.67));
  }

  /** The blend, on a 0 to 255 channel: 255 - (255 - base) * exp(-added). */
  function blend8(base, added) { return added > 0 ? 255 - (255 - base) * Math.exp(-added) : base; }

  var L = 1 / 255;
  function luma8(src, i) { return (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) * L; }

  // Step 1. Returns an RGB float buffer at quarter size, zero except on highlights.
  function brightPass(src, w, h, qw, qh, th) {
    var out = new Float32Array(qw * qh * 3);
    var ring = Math.min(w, h) * 0.02;
    var cos = [], sin = [];
    for (var k = 0; k < 8; k++) { cos.push(Math.cos(0.785398 * k)); sin.push(Math.sin(0.785398 * k)); }
    var sxs = w / qw, sys = h / qh;
    function at(x, y) {
      x = x < 0 ? 0 : x >= w ? w - 1 : x;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
      return (y * w + x) * 4;
    }
    for (var qy = 0; qy < qh; qy++) {
      var cy = Math.floor((qy + 0.5) * sys);
      for (var qx = 0; qx < qw; qx++) {
        var cx = Math.floor((qx + 0.5) * sxs);
        // The brightest of four samples around the centre.
        var best = -1, m = 0;
        for (var c = 0; c < 4; c++) {
          var i = at(cx + (c & 1 ? 1 : -1), cy + (c & 2 ? 1 : -1));
          var v = luma8(src, i);
          if (v > best) { best = v; m = i; }
        }
        if (best <= th) continue;
        var around = 0;
        for (k = 0; k < 8; k++) around += luma8(src, at(Math.round(cx + ring * cos[k]), Math.round(cy + ring * sin[k])));
        var spot = (best - around / 8) / 0.25;
        if (spot <= 0) continue;
        if (spot > 1) spot = 1;
        var bk = (best - th) / Math.max(1 - th, 0.02);
        if (bk > 1) bk = 1;
        var f = bk * bk * spot * L;
        var o = (qy * qw + qx) * 3;
        out[o] = src[m] * f; out[o + 1] = src[m + 1] * f; out[o + 2] = src[m + 2] * f;
      }
    }
    to8Bit(out);
    return out;
  }

  // Adds [src] scattered along (dx, dy) to [dst]. kernel[j] holds an RGB weight
  // for each tap from -half to +half; bilinear splats match texture sampling.
  function scatter(src, dst, qw, qh, dx, dy, step, kernel) {
    var half = (kernel.length / 3 - 1) / 2;
    var tapX = [], tapY = [];
    for (var j = -half; j <= half; j++) { tapX.push(dx * step * j); tapY.push(dy * step * j); }
    var n = tapX.length;
    for (var y = 0; y < qh; y++) {
      for (var x = 0; x < qw; x++) {
        var o = (y * qw + x) * 3;
        var r = src[o], g = src[o + 1], b = src[o + 2];
        if (r + g + b < 1e-4) continue;
        for (var t = 0; t < n; t++) {
          var fx = x + tapX[t], fy = y + tapY[t];
          var ix = Math.floor(fx), iy = Math.floor(fy);
          if (ix < 0 || iy < 0 || ix >= qw - 1 || iy >= qh - 1) continue;
          var ax = fx - ix, ay = fy - iy;
          var w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          var kr = kernel[t * 3] * r, kg = kernel[t * 3 + 1] * g, kb = kernel[t * 3 + 2] * b;
          var p = (iy * qw + ix) * 3, q = p + 3, s = p + qw * 3, u = s + 3;
          dst[p] += kr * w00; dst[p + 1] += kg * w00; dst[p + 2] += kb * w00;
          dst[q] += kr * w10; dst[q + 1] += kg * w10; dst[q + 2] += kb * w10;
          dst[s] += kr * w01; dst[s + 1] += kg * w01; dst[s + 2] += kb * w01;
          dst[u] += kr * w11; dst[u + 1] += kg * w11; dst[u + 2] += kb * w11;
        }
      }
    }
  }

  // The app's render targets are 8 bits per channel, which drops very faint
  // light and clips at 1. That keeps rays crisp, so the same happens here.
  function to8Bit(buf) {
    for (var i = 0; i < buf.length; i++) {
      var v = buf[i];
      if (v !== 0) buf[i] = v >= 1 ? 1 : Math.round(v * 255) / 255;
    }
  }

  // Weights for a streak: 17 taps, exp(-decay * t), rainbow and tint, normalised.
  function streakKernel(decay, rainbow, tint) {
    var k = new Float32Array(17 * 3), sum = 0, col = [0, 0, 0];
    for (var j = -8; j <= 8; j++) {
      var t = Math.abs(j) / 8, w = Math.exp(-decay * t);
      hue(0.1 + t * 0.85, col);
      var i = (j + 8) * 3;
      for (var c = 0; c < 3; c++) k[i + c] = w * ((1 - rainbow) + rainbow * col[c]) * tint[c];
      sum += w;
    }
    for (j = 0; j < k.length; j++) k[j] /= sum;
    return k;
  }

  // Weights for one blur direction: 25 gaussian taps.
  function blurKernel(spacing, sigma) {
    var k = new Float32Array(25 * 3), sum = 0;
    for (var i = -12; i <= 12; i++) {
      var x = i * spacing, w = Math.exp(-x * x / (2 * sigma * sigma));
      for (var c = 0; c < 3; c++) k[(i + 12) * 3 + c] = w;
      sum += w;
    }
    for (i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }

  // Step 2.
  function raysPass(bq, qw, qh, short, p) {
    var out = new Float32Array(qw * qh * 3);
    var len = p.length * 0.45 * short / 4;
    if (p.rays < 2 || p.rayStrength <= 0 || len < 1) return out;
    var dirs = Math.floor(p.rays / 2);
    var coarse = len / 8, fine = coarse / 16;
    var fineK = streakKernel(0, 0, [1, 1, 1]);
    var coarseK = streakKernel(3, p.rainbow, p.tint);
    var tmp = new Float32Array(qw * qh * 3), one = new Float32Array(qw * qh * 3);
    for (var k = 0; k < dirs; k++) {
      var a = p.angle * Math.PI / 180 + Math.PI * k / dirs;
      var dx = Math.cos(a), dy = Math.sin(a); // clockwise on screen, y down
      tmp.fill(0);
      one.fill(0);
      scatter(bq, tmp, qw, qh, dx, dy, fine, fineK);
      to8Bit(tmp);
      scatter(tmp, one, qw, qh, dx, dy, coarse, coarseK);
      to8Bit(one);
      for (var i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] + one[i]);
    }
    return out;
  }

  // Step 3.
  function glowPass(bq, qw, qh, short, p) {
    var out = new Float32Array(qw * qh * 3);
    if (p.glow <= 0) return out;
    var sigma = short / 4 * 0.012;
    var spacing = Math.max(1, sigma / 4);
    var k = blurKernel(spacing, sigma);
    var tmp = new Float32Array(qw * qh * 3);
    scatter(bq, tmp, qw, qh, 1, 0, spacing, k);
    to8Bit(tmp);
    scatter(tmp, out, qw, qh, 0, 1, spacing, k);
    to8Bit(out);
    return out;
  }

  // Step 4: the highlight map the glitter stars sit on.
  function highlightMap(bq, qw, qh) {
    var s = Math.min(1, 160 / Math.max(qw, qh));
    var w = Math.max(3, Math.floor(qw * s)), h = Math.max(3, Math.floor(qh * s));
    var lum = new Float64Array(w * h);
    var fx = qw / w, fy = qh / h;
    function sample(x, y) {
      var ix = x < 0 ? 0 : x >= qw ? qw - 1 : Math.floor(x), iy = y < 0 ? 0 : y >= qh ? qh - 1 : Math.floor(y);
      var o = (iy * qw + ix) * 3;
      return 0.2126 * bq[o] + 0.7152 * bq[o + 1] + 0.0722 * bq[o + 2];
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var cx = (x + 0.5) * fx, cy = (y + 0.5) * fy, ox = fx * 0.25, oy = fy * 0.25;
        var v = (sample(cx - ox, cy - oy) + sample(cx + ox, cy - oy) + sample(cx - ox, cy + oy) + sample(cx + ox, cy + oy)) * 0.25;
        lum[y * w + x] = Math.min(1, v);
      }
    }
    return { lum: lum, w: w, h: h };
  }

  function buildStars(bq, qw, qh, w, h, p) {
    var stars = [];
    var wanted = Math.min(Math.round(p.glitter * 48), MAX_STARS);
    if (wanted <= 0) return stars;
    var short = Math.min(w, h);
    var map = highlightMap(bq, qw, qh);
    var found = findMaxima(map.lum, map.w, map.h);
    var sizeBase = short * (0.02 + 0.10 * p.sparkleSize);
    var baseAngle = (p.angle + 45 / Math.max(Math.floor(p.glitterRays / 2), 1)) * Math.PI / 180;
    var dirs = Math.max(1, Math.floor(p.glitterRays / 2));
    for (var i = 0; i < found.length && stars.length < wanted; i++) {
      var hl = found[i];
      var h1 = hash(hl.cell), h2 = hash(hl.cell + 17.3);
      var tw = 0.5 + 0.5 * twinkle(p.time, p.twinkle, h1, h2);
      var value = Math.min(1, 0.35 + hl.value) * Math.pow(tw, 1.5);
      if (value < 0.01) continue;
      var r = sizeBase * (0.55 + 0.45 * hl.value) * (0.4 + 0.6 * tw);
      var col = [1, 1, 1];
      if (p.glitterColor > 0) {
        var hc = [0, 0, 0];
        hue(p.glitterHue + h2 * 0.25, hc);
        for (var c = 0; c < 3; c++) col[c] = 1 + (hc[c] - 1) * p.glitterColor;
      }
      var angle = baseAngle + (h1 - 0.5) * 0.35;
      var spokes = [];
      for (var k = 0; k < dirs * 2; k++) {
        var ang = angle + Math.PI * k / (dirs * 2);
        spokes.push({ cx: Math.cos(ang), cy: Math.sin(ang), len: k % 2 === 0 ? r : 0.4 * r, gain: k % 2 === 0 ? 1 : 0.6 });
      }
      stars.push({ x: hl.x * w, y: hl.y * h, r: r, value: value, col: col, spokes: spokes, width: 0.012 * r + 0.7 });
    }
    return stars;
  }

  // The analytic star shape, added to one row of the composite buffer.
  function addStarRow(row, s, y, w) {
    var dy = y + 0.5 - s.y, r = s.r;
    var span = r * r - dy * dy;
    if (span <= 0) return;
    span = Math.sqrt(span);
    var x0 = Math.max(0, Math.floor(s.x - span)), x1 = Math.min(w - 1, Math.ceil(s.x + span));
    var core = 0.06 * r, halo = 0.2 * r;
    var spokes = s.spokes, ns = spokes.length;
    for (var x = x0; x <= x1; x++) {
      var dx = x + 0.5 - s.x;
      var d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      var shape = 1.3 * Math.exp(-d2 / (core * core)) + 0.35 * Math.exp(-d2 / (halo * halo));
      for (var k = 0; k < ns; k++) {
        var sp = spokes[k];
        var along = dx * sp.cx + dy * sp.cy; if (along < 0) along = -along;
        if (along >= sp.len) continue;
        var perp = -dx * sp.cy + dy * sp.cx; if (perp < 0) perp = -perp;
        var fall = 1 - along / sp.len;
        var wd = s.width * (0.3 + fall);
        var e = perp / wd;
        if (e > 3) continue;
        shape += Math.exp(-e * e) * fall * fall * sp.gain;
      }
      var a = shape * s.value, o = x * 3;
      row[o] += s.col[0] * a; row[o + 1] += s.col[1] * a; row[o + 2] += s.col[2] * a;
    }
  }

  /**
   * Renders the effect. src is RGBA bytes, w by h; dst may be the same length,
   * and may be src itself. Returns {highlights, stars}: how many quarter-size
   * pixels counted as highlights, and how many glitter stars were drawn.
   */
  function render(src, w, h, opts, dst) {
    var p = params(opts);
    var out = dst || new Uint8ClampedArray(w * h * 4);
    var short = Math.min(w, h);
    var qw = Math.floor((w + 3) / 4), qh = Math.floor((h + 3) / 4);
    var bq = brightPass(src, w, h, qw, qh, p.threshold);
    var highlights = 0;
    for (var i = 0; i < bq.length; i += 3) if (bq[i] + bq[i + 1] + bq[i + 2] > 1e-4) highlights++;

    var streak = raysPass(bq, qw, qh, short, p);
    var glow = glowPass(bq, qw, qh, short, p);
    var stars = buildStars(bq, qw, qh, w, h, p);

    // One buffer of everything that is added smoothly, at quarter size.
    var gainR = p.rayStrength * 7 * Math.pow(2 / Math.max(2, Math.floor(p.rays / 2)), 0.7), gainG = p.glow * 1.6;
    var add = new Float32Array(qw * qh * 3);
    for (i = 0; i < add.length; i++) add[i] = streak[i] * gainR + glow[i] * gainG;

    // Composite row by row, so a large photo needs no full-size float buffer.
    var row = new Float32Array(w * 3);
    var byTop = stars.map(function (s) { return { s: s, y0: Math.floor(s.y - s.r), y1: Math.ceil(s.y + s.r) }; });
    for (var y = 0; y < h; y++) {
      row.fill(0);
      var fy = (y + 0.5) / h * qh - 0.5;
      var iy = Math.floor(fy), ay = fy - iy;
      if (iy < 0) { iy = 0; ay = 0; }
      if (iy >= qh - 1) { iy = qh - 2 < 0 ? 0 : qh - 2; ay = qh < 2 ? 0 : 1; }
      var r0 = iy * qw * 3, r1 = (iy + (qh > 1 ? 1 : 0)) * qw * 3;
      for (var x = 0; x < w; x++) {
        var fx = (x + 0.5) / w * qw - 0.5;
        var ix = Math.floor(fx), ax = fx - ix;
        if (ix < 0) { ix = 0; ax = 0; }
        if (ix >= qw - 1) { ix = qw - 2 < 0 ? 0 : qw - 2; ax = qw < 2 ? 0 : 1; }
        var ni = qw > 1 ? 3 : 0;
        var a00 = r0 + ix * 3, a10 = a00 + ni, a01 = r1 + ix * 3, a11 = a01 + ni;
        for (var c = 0; c < 3; c++) {
          row[x * 3 + c] = (add[a00 + c] * (1 - ax) + add[a10 + c] * ax) * (1 - ay) + (add[a01 + c] * (1 - ax) + add[a11 + c] * ax) * ay;
        }
      }
      for (var t = 0; t < byTop.length; t++) {
        if (y >= byTop[t].y0 && y <= byTop[t].y1) addStarRow(row, byTop[t].s, y, w);
      }
      var off = y * w * 4;
      for (x = 0; x < w; x++) {
        var o4 = off + x * 4, o3 = x * 3;
        var ar = row[o3], ag = row[o3 + 1], ab = row[o3 + 2];
        out[o4] = blend8(src[o4], ar);
        out[o4 + 1] = blend8(src[o4 + 1], ag);
        out[o4 + 2] = blend8(src[o4 + 2], ab);
        out[o4 + 3] = 255;
      }
    }
    return { highlights: highlights, stars: stars.length };
  }

  return {
    DEFAULTS: DEFAULTS, STYLES: STYLES, MAX_STARS: MAX_STARS, thresholdFor: thresholdFor, sensitivityFor: sensitivityFor,
    hash: hash, twinkle: twinkle, findMaxima: findMaxima, blend8: blend8, render: render
  };
});
