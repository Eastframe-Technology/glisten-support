// Page code for the star filter tool. The photo is read into a canvas in this
// tab and never sent anywhere; this file makes no network requests of its own.
(function () {
  'use strict';
  var F = window.StarFilter;
  var PREVIEW_LONG = 1280, EXPORT_LONG = 4096;
  var $ = function (id) { return document.getElementById(id); };
  var view = $('view'), ctx = view.getContext('2d', { willReadFrequently: true });
  var status = $('status'), hint = $('hint');
  var image = null, baseName = 'photo';
  var srcData = null, outData = null;
  var comparing = false, queued = false;
  var p = Object.assign({}, F.DEFAULTS, F.STYLES.cross);

  function say(text) { status.textContent = text || ''; }

  function fit(w, h, long) {
    var s = Math.min(1, long / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  function loadPreview() {
    var size = fit(image.naturalWidth, image.naturalHeight, PREVIEW_LONG);
    view.width = size.w;
    view.height = size.h;
    ctx.drawImage(image, 0, 0, size.w, size.h);
    srcData = ctx.getImageData(0, 0, size.w, size.h);
    outData = ctx.createImageData(size.w, size.h);
    $('download').disabled = false;
    $('compare').disabled = false;
    draw();
  }

  function draw() {
    if (!srcData) return;
    if (comparing) { ctx.putImageData(srcData, 0, 0); return; }
    var res = F.render(srcData.data, srcData.width, srcData.height, p, outData.data);
    ctx.putImageData(outData, 0, 0);
    hint.hidden = !(res.highlights === 0 && res.stars === 0 && (p.rays > 0 || p.glow > 0 || p.glitter > 0));
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; draw(); });
  }

  function openImage(url, name, revoke) {
    var img = new Image();
    say('Opening…');
    img.onload = function () {
      image = img;
      baseName = name;
      say('');
      loadPreview();
      if (revoke) URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      say('This browser could not open that file. Try a JPEG, PNG or WebP.');
      if (revoke) URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function openFile(file) {
    if (!file) return;
    openImage(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, '') || 'photo', true);
  }

  $('file').addEventListener('change', function () { openFile(this.files[0]); this.value = ''; });
  $('sample').addEventListener('click', function () { openImage('../img/sample.jpg', 'chandelier', false); });

  var stage = $('stage');
  ['dragenter', 'dragover'].forEach(function (t) {
    stage.addEventListener(t, function (e) { e.preventDefault(); stage.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    stage.addEventListener(t, function (e) { e.preventDefault(); stage.classList.remove('over'); });
  });
  stage.addEventListener('drop', function (e) { openFile(e.dataTransfer.files[0]); });

  // Sliders. Each one names a parameter; sensitivity is shown the app's way.
  var sliders = Array.prototype.slice.call(document.querySelectorAll('input[type=range]'));
  function toSliders() {
    sliders.forEach(function (s) {
      var key = s.getAttribute('data-p');
      s.value = key === 'sensitivity' ? F.sensitivityFor(p.threshold) : p[key];
    });
    Array.prototype.forEach.call(document.querySelectorAll('#points button'), function (b) {
      b.setAttribute('aria-pressed', String(+b.getAttribute('data-n') === p.rays));
    });
  }
  sliders.forEach(function (s) {
    s.addEventListener('input', function () {
      var key = s.getAttribute('data-p'), v = parseFloat(s.value);
      if (key === 'sensitivity') p.threshold = F.thresholdFor(v);
      else p[key] = v;
      schedule();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#points button'), function (b) {
    b.addEventListener('click', function () {
      p.rays = +b.getAttribute('data-n');
      toSliders();
      schedule();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#styles button'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('#styles button'), function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      p = Object.assign({}, F.DEFAULTS, F.STYLES[b.getAttribute('data-s')]);
      toSliders();
      schedule();
    });
  });

  // Hold to see the original.
  var cmp = $('compare');
  function setCompare(on) { comparing = on; draw(); }
  cmp.addEventListener('pointerdown', function (e) { e.preventDefault(); setCompare(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) {
    cmp.addEventListener(t, function () { if (comparing) setCompare(false); });
  });
  cmp.addEventListener('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setCompare(true); } });
  cmp.addEventListener('keyup', function () { if (comparing) setCompare(false); });

  // Download: the same effect run again at full size, in memory, then saved locally.
  $('download').addEventListener('click', function () {
    if (!image) return;
    var btn = this;
    btn.disabled = true;
    say('Rendering full size…');
    setTimeout(function () {
      try {
        var size = fit(image.naturalWidth, image.naturalHeight, EXPORT_LONG);
        var c = document.createElement('canvas');
        c.width = size.w;
        c.height = size.h;
        var x = c.getContext('2d');
        x.drawImage(image, 0, 0, size.w, size.h);
        var data = x.getImageData(0, 0, size.w, size.h);
        F.render(data.data, size.w, size.h, p, data.data);
        x.putImageData(data, 0, 0);
        c.toBlob(function (blob) {
          btn.disabled = false;
          if (!blob) { say('Your browser ran out of memory. Try a smaller photo.'); return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = baseName + '-star-filter.jpg';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          say('Saved ' + size.w + ' × ' + size.h + ' pixels.');
        }, 'image/jpeg', 0.92);
      } catch (err) {
        btn.disabled = false;
        say('Your browser ran out of memory. Try a smaller photo.');
      }
    }, 30);
  });

  toSliders();
  openImage('../img/sample.jpg', 'chandelier', false);
})();
