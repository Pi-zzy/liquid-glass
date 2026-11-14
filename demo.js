/* Liquid Glass demo wiring: wallpaper, live clock, calendar, controls, dock. */
(function () {
  'use strict';

  /* ---------------- animated mesh-gradient wallpaper ---------------- */

  const canvas = document.getElementById('wallpaper');
  const ctx = canvas.getContext('2d');

  // Low-res offscreen buffer — the gradients are soft, so 1/6 scale is
  // invisible and keeps the fill ~36× cheaper.
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d');

  const PALETTES = {
    light: {
      base: ['#f0f4fa', '#e8effc', '#fbf3ee'],
      blobs: [
        ['#ff9fbd', '#ff629e'],
        ['#8fd4ff', '#4f7cff'],
        ['#ffe09a', '#ffb35c'],
        ['#a9ffd4', '#2fd0a0'],
        ['#cdb4ff', '#8a5cff'],
        ['#9ad2ff', '#4aa8ff']
      ]
    },
    dark: {
      base: ['#0a0e1a', '#0d1226', '#101028'],
      blobs: [
        ['#b83280', '#3a1030'],
        ['#2b4bd8', '#101c4d'],
        ['#c26a1f', '#3d1c08'],
        ['#0f9d76', '#062e24'],
        ['#6d3ad6', '#1e1140'],
        ['#1f6fd0', '#0a1f42']
      ]
    }
  };

  // Six soft blobs spread evenly so no single color dominates the wash.
  const BLOBS = [
    { x: 0.14, y: 0.20, r: 0.34, ph: 0.0, sx: 0.9, sy: 0.7 },
    { x: 0.68, y: 0.14, r: 0.36, ph: 1.4, sx: 0.7, sy: 0.9 },
    { x: 0.42, y: 0.52, r: 0.30, ph: 2.8, sx: 0.8, sy: 0.6 },
    { x: 0.84, y: 0.62, r: 0.33, ph: 4.0, sx: 0.6, sy: 0.8 },
    { x: 0.18, y: 0.72, r: 0.30, ph: 5.2, sx: 0.7, sy: 0.7 },
    { x: 0.56, y: 0.88, r: 0.28, ph: 6.3, sx: 0.75, sy: 0.65 }
  ];

  let motionPaused = false;

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    buf.width = Math.max(2, Math.round(innerWidth / 6));
    buf.height = Math.max(2, Math.round(innerHeight / 6));
  }
  addEventListener('resize', resize);
  resize();

  let theme = 'light';
  let time = 0;
  let last = performance.now();

  function paintWallpaper(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!motionPaused) time += dt;

    const palette = PALETTES[theme];
    const w = buf.width, h = buf.height;

    const g = bctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, palette.base[0]);
    g.addColorStop(0.5 + 0.1 * Math.sin(time * 0.1), palette.base[1]);
    g.addColorStop(1, palette.base[2]);
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, w, h);

    BLOBS.forEach((b, i) => {
      const cx = (b.x + 0.06 * Math.sin(time * b.sx * 0.35 + b.ph)) * w;
      const cy = (b.y + 0.07 * Math.cos(time * b.sy * 0.3 + b.ph * 1.3)) * h;
      const r = b.r * w * (1 + 0.06 * Math.sin(time * 0.25 + b.ph));
      const [c0, c1] = palette.blobs[i];
      const rg = bctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, c1);
      rg.addColorStop(1, 'transparent');
      bctx.globalAlpha = 0.62;
      bctx.fillStyle = rg;
      bctx.beginPath();
      bctx.arc(cx, cy, r, 0, Math.PI * 2);
      bctx.fill();
    });
    bctx.globalAlpha = 1;

    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
  }

  function frame(now) {
    paintWallpaper(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------------- glass instances ---------------- */

  const all = [];
  document.querySelectorAll('[data-liquid-glass]').forEach((el) => {
    const g = LiquidGlass.for(el) || new LiquidGlass(el);
    all.push(g);
  });
  const setAll = (opts) => all.forEach((inst) => inst.set(opts));

  /* ---------------- live clock ---------------- */

  const handHour = document.getElementById('handHour');
  const handMinute = document.getElementById('handMinute');
  const handSecond = document.getElementById('handSecond');
  const clockDigital = document.getElementById('clockDigital');
  const clockDate = document.getElementById('clockDate');

  function tickClock() {
    const now = new Date();
    const h = now.getHours() % 12;
    const m = now.getMinutes();
    const s = now.getSeconds() + now.getMilliseconds() / 1000;

    handHour.setAttribute('transform', `rotate(${(h + m / 60) * 30} 60 60)`);
    handMinute.setAttribute('transform', `rotate(${(m + s / 60) * 6} 60 60)`);
    handSecond.setAttribute('transform', `rotate(${s * 6} 60 60)`);

    clockDigital.textContent =
      String(now.getHours()).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  const DATE_FMT = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  clockDate.textContent = DATE_FMT.format(new Date());
  tickClock();
  (function clockLoop() {
    tickClock();
    requestAnimationFrame(clockLoop);
  })();

  /* ---------------- real calendar ---------------- */

  (function buildCalendar() {
    const grid = document.getElementById('calGrid');
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();

    document.getElementById('calMonth').textContent =
      today.toLocaleString('en-US', { month: 'long' });
    document.getElementById('calYear').textContent = String(year);

    const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    dows.forEach((d) => {
      const el = document.createElement('span');
      el.className = 'dow';
      el.textContent = d;
      grid.appendChild(el);
    });

    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();
    const leading = firstDow; // grid header runs Sunday-first

    const cells = [];
    for (let i = leading - 1; i >= 0; i--) {
      cells.push({ d: daysInPrev - i, dim: true });
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push({ d, dim: false });
    while (cells.length % 7 !== 0 || cells.length < 35) {
      cells.push({ d: cells.length - leading - daysInMonth + 1, dim: true });
    }

    cells.forEach((c) => {
      const el = document.createElement('span');
      el.className = 'day' + (c.dim ? ' dim' : '');
      if (!c.dim && c.d === today.getDate()) el.classList.add('today');
      el.textContent = c.d;
      grid.appendChild(el);
    });
  })();

  /* ---------------- material lab controls ---------------- */

  const sliders = {
    refraction: document.getElementById('rRefraction'),
    edge: document.getElementById('rEdge'),
    blur: document.getElementById('rBlur'),
    saturate: document.getElementById('rSaturate'),
    chroma: document.getElementById('rChroma'),
    spring: document.getElementById('rSpring')
  };

  function syncSliders(p) {
    sliders.refraction.value = p.refraction;
    sliders.edge.value = p.edgeWidth;
    sliders.blur.value = p.blur;
    sliders.saturate.value = p.saturate * 100;
    sliders.chroma.value = Math.round(p.chromatic * 1000);
    sliders.spring.value = p.stiffness;
    document.getElementById('oRefraction').textContent = p.refraction + 'px';
    document.getElementById('oEdge').textContent = p.edgeWidth + 'px';
    document.getElementById('oBlur').textContent = p.blur + 'px';
    document.getElementById('oSaturate').textContent = Math.round(p.saturate * 100) + '%';
    document.getElementById('oChroma').textContent = (p.chromatic * 100).toFixed(1) + '%';
    document.getElementById('oSpring').textContent = p.stiffness;
  }

  function bindRange(input, out, fmt, apply) {
    const update = () => {
      const v = parseFloat(input.value);
      out.textContent = fmt(v);
      apply(v);
    };
    input.addEventListener('input', update);
  }

  bindRange(sliders.refraction, document.getElementById('oRefraction'),
    (v) => v + 'px', (v) => setAll({ refraction: v }));
  bindRange(sliders.edge, document.getElementById('oEdge'),
    (v) => v + 'px', (v) => setAll({ edgeWidth: v }));
  bindRange(sliders.blur, document.getElementById('oBlur'),
    (v) => v + 'px', (v) => setAll({ blur: v }));
  bindRange(sliders.saturate, document.getElementById('oSaturate'),
    (v) => v + '%', (v) => setAll({ saturate: v / 100 }));
  bindRange(sliders.chroma, document.getElementById('oChroma'),
    (v) => (v / 10).toFixed(1) + '%', (v) => setAll({ chromatic: v / 1000 }));
  bindRange(sliders.spring, document.getElementById('oSpring'),
    (v) => String(v), (v) => setAll({ stiffness: v }));

  document.getElementById('resetBtn').addEventListener('click', () => {
    all.forEach((inst) => inst.reset());
  });

  /* ---------------- toast ---------------- */

  const toast = document.getElementById('toast');
  let toastTimer = 0;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
  }

  /* ---------------- dock actions ---------------- */

  // theme
  document.getElementById('dockTheme').addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  });

  // background motion
  const motionBtn = document.getElementById('dockMotion');
  motionBtn.addEventListener('click', () => {
    motionPaused = !motionPaused;
    document.documentElement.classList.toggle('reduce-motion', motionPaused);
    motionBtn.classList.toggle('pressed', motionPaused);
    showToast(motionPaused ? 'Background paused' : 'Background motion');
  });

  // material presets
  const PRESETS = [
    { name: 'Crisp',   refraction: 34, edgeWidth: 30, blur: 2,  saturate: 1.5,  chromatic: 0.02 },
    { name: 'Frosted', refraction: 24, edgeWidth: 36, blur: 11, saturate: 1.8,  chromatic: 0 },
    { name: 'Lens',    refraction: 52, edgeWidth: 26, blur: 0,  saturate: 1.35, chromatic: 0.05 }
  ];
  let presetIdx = 0;
  document.getElementById('dockPreset').addEventListener('click', () => {
    presetIdx = (presetIdx + 1) % PRESETS.length;
    const p = PRESETS[presetIdx];
    setAll(p);
    syncSliders(p);
    showToast(p.name);
  });

  // fullscreen
  document.getElementById('dockFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  /* ---------------- dock magnification ---------------- */

  const dock = document.getElementById('dock');
  const items = [...dock.querySelectorAll('.dock-item')];

  dock.addEventListener('pointermove', (e) => {
    items.forEach((item) => {
      const r = item.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - e.clientX);
      const s = 1 + 0.42 * Math.max(0, 1 - d / 150);
      item.style.transform = `scale(${s.toFixed(3)}) translateY(${(-(s - 1) * 13).toFixed(1)}px)`;
    });
  });
  dock.addEventListener('pointerleave', () => {
    items.forEach((item) => (item.style.transform = ''));
  });
})();
