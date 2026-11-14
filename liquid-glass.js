/*!
 * LiquidGlass v1.0.0
 * Apple-style "Liquid Glass" refraction for the web — zero dependencies.
 * https://github.com/Pi-zzy/liquid-glass
 *
 * How it works:
 *   1. A rounded-rect signed distance field (SDF) is rasterized to a canvas,
 *      encoding an outward-pointing displacement vector into the R/G channels
 *      (128 = neutral). Near the rim the vector is strongest, which makes
 *      feDisplacementMap pull background content from *outside* the element
 *      into the rim — the "refraction ring" you see on Apple's Liquid Glass.
 *   2. That PNG is fed to an inline SVG <feImage> → <feDisplacementMap> filter.
 *      Optional chromatic aberration runs three displacement passes with
 *      slightly different scales and recombines them channel-by-channel.
 *   3. The filter is applied through CSS `backdrop-filter: url(#…)`, so the
 *      element refracts whatever is behind it — no canvas copies, no WebGL,
 *      everything runs on the compositor.
 *
 * Chromium-based browsers (Chrome, Edge, Arc, Brave, Opera) support SVG
 * filters inside backdrop-filter. Firefox/Safari fall back to plain
 * blur + saturate glassmorphism automatically.
 *
 * License: MIT
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Displacement map                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Rasterize a rounded-rect "lens" displacement map.
   *
   * For every pixel we compute the signed distance to the rounded-rect edge
   * (negative inside) and its outward normal. The displacement magnitude
   * follows a smoothstep profile that peaks at the rim and fades to zero
   * `edgeWidth` pixels inside, so the center of the glass stays undistorted.
   *
   * Encoding (what feDisplacementMap expects):
   *   R = 128 + nx · 127  ·  profile      G = 128 + ny · 127  ·  profile
   *
   * @returns {HTMLCanvasElement}
   */
  function generateDisplacementMap(width, height, radius, edgeWidth) {
    radius = Math.max(0, Math.min(radius, width / 2, height / 2));
    edgeWidth = Math.max(1, edgeWidth);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);
    const data = image.data;
    const halfW = canvas.width / 2;
    const halfH = canvas.height / 2;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const px = x + 0.5 - halfW;
        const py = y + 0.5 - halfH;

        // Signed distance field of a rounded rectangle (negative inside).
        const qx = Math.abs(px) - (halfW - radius);
        const qy = Math.abs(py) - (halfH - radius);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const inside = Math.min(Math.max(qx, qy), 0);
        const sdf = outside + inside - radius;

        // Outward unit normal of the SDF (0,0 deep inside / far outside).
        let nx = 0, ny = 0;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          nx = (Math.sign(px) * qx) / len;
          ny = (Math.sign(py) * qy) / len;
        } else if (qx > 0) {
          nx = Math.sign(px) || 1;
        } else if (qy > 0) {
          ny = Math.sign(py) || 1;
        }

        // Profile: full strength at the rim, smoothstepping to 0 inside.
        const depth = Math.max(-sdf, 0);            // distance from the rim, inward
        let t = 1 - Math.min(depth / edgeWidth, 1); // 1 at rim → 0 inside
        t = t * t * (3 - 2 * t);
        // Also fade out on pixels slightly outside the shape, so the rim of
        // the map doesn't hard-clip when the element radius differs a hair.
        const over = Math.max(sdf, 0);
        t *= Math.max(0, 1 - over / 2);

        const mag = t * 127;
        const i = (y * canvas.width + x) * 4;
        data[i]     = 128 + nx * mag;
        data[i + 1] = 128 + ny * mag;
        data[i + 2] = 128; // unused
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /* ------------------------------------------------------------------ */
  /*  SVG filter factory                                                 */
  /* ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createFilterDef(id, mapURI, width, height, opts) {
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    // sRGB keeps the per-channel screen() recombination from shifting
    // brightness (the default linearRGB would wash it out).
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    const image = document.createElementNS(SVG_NS, 'feImage');
    image.setAttribute('href', mapURI);
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', width);
    image.setAttribute('height', height);
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('result', 'map');
    filter.appendChild(image);

    // Displace the backdrop. Positive scale + outward vectors = background
    // content from beyond the rim is pulled into the edge (convex lens feel).
    const scale = Math.max(0, opts.refraction);
    const chroma = Math.max(0, opts.chromatic);
    const channels = chroma > 0
      ? [['R', scale * (1 + chroma)], ['G', scale], ['B', scale * (1 - chroma)]]
      : [['R', scale]];

    const blends = [];
    channels.forEach(function (ch, idx) {
      const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
      disp.setAttribute('in', 'SourceGraphic');
      disp.setAttribute('in2', 'map');
      disp.setAttribute('scale', ch[1]);
      disp.setAttribute('xChannelSelector', 'R');
      disp.setAttribute('yChannelSelector', 'G');
      disp.setAttribute('result', 'disp' + idx);
      filter.appendChild(disp);

      if (channels.length === 1) return; // single pass, nothing to split

      // Isolate one color channel of this pass. The matrix is 4 rows × 5
      // cols (R,G,B,A out), so channel `idx` lives at row idx, col idx
      // = flat position idx*6; the last row keeps alpha intact (18 = A·A).
      const keep = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
      keep[idx * 6] = 1;
      const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
      matrix.setAttribute('in', 'disp' + idx);
      matrix.setAttribute('type', 'matrix');
      matrix.setAttribute('values', keep.join(' '));
      matrix.setAttribute('result', 'chan' + idx);
      filter.appendChild(matrix);
      blends.push('chan' + idx);
    });

    if (channels.length > 1) {
      // Recombine the three passes. Screen() on disjoint channels is additive.
      let last = blends[0];
      for (let i = 1; i < blends.length; i++) {
        const blend = document.createElementNS(SVG_NS, 'feBlend');
        blend.setAttribute('in', last);
        blend.setAttribute('in2', blends[i]);
        blend.setAttribute('mode', 'screen');
        if (i < blends.length - 1) blend.setAttribute('result', 'mix' + i);
        filter.appendChild(blend);
        last = i < blends.length - 1 ? 'mix' + i : last;
      }
    }
    return filter;
  }

  /* ------------------------------------------------------------------ */
  /*  Spring physics (damped harmonic oscillator)                        */
  /* ------------------------------------------------------------------ */

  function createSpring(stiffness, damping) {
    return {
      x: 0, y: 0, vx: 0, vy: 0,
      stiffness: stiffness, damping: damping,
      /** Integrate toward a target. `dt` in seconds (clamped for stability). */
      step: function (tx, ty, dt) {
        dt = Math.min(dt, 1 / 30);
        this.vx += (tx - this.x) * this.stiffness * dt;
        this.vy += (ty - this.y) * this.stiffness * dt;
        const decay = Math.exp(-this.damping * dt);
        this.vx *= decay;
        this.vy *= decay;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        return Math.hypot(this.vx, this.vy);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /*  LiquidGlass                                                        */
  /* ------------------------------------------------------------------ */

  const instances = new Map(); // element → LiquidGlass
  let uid = 0;

  const DEFAULTS = {
    radius: 'auto',    // corner radius in px, 'auto' reads the CSS border-radius
    refraction: 34,    // max edge displacement, px (feDisplacementMap scale)
    edgeWidth: 30,     // rim band where refraction happens, px
    blur: 2,           // backdrop blur, px
    saturate: 1.5,     // backdrop saturation multiplier
    brightness: 1.04,  // backdrop brightness multiplier
    chromatic: 0.02,   // per-channel scale spread (0 = off) → RGB fringing
    tint: null,        // overlay color, e.g. 'rgba(255,255,255,0.10)'
    sheen: true,       // specular highlight that follows the pointer
    draggable: false,  // spring-physics drag with elastic snap-back
    stiffness: 220,    // spring stiffness (lower = softer, jelly-ier)
    damping: 24        // spring damping (lower = more bounce)
  };

  const MAP_KEYS = ['radius', 'edgeWidth'];       // changing these → new map
  const SCALE_KEYS = ['refraction', 'chromatic']; // changing these → filter attr
  const CSS_KEYS = ['blur', 'saturate', 'brightness', 'tint', 'sheen'];

  function isHTMLElement(el) {
    return el && el.nodeType === 1;
  }

  function readRadius(el, fallback) {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
    if (!isFinite(r) || r <= 0) return fallback;
    return Math.min(r, el.offsetWidth / 2, el.offsetHeight / 2);
  }

  class LiquidGlass {
    /**
     * @param {HTMLElement} el host element. Existing children are wrapped
     *        into an inner content layer automatically.
     * @param {object} options see DEFAULTS
     */
    constructor(el, options) {
      if (!isHTMLElement(el)) throw new TypeError('LiquidGlass: expected an element');
      if (instances.has(el)) return instances.get(el);

      this.el = el;
      this.id = 'lg-' + (++uid);
      this.options = Object.assign({}, DEFAULTS, options || {});
      this._spring = createSpring(this.options.stiffness, this.options.damping);
      this._raf = 0;
      this._lastT = 0;
      this._destroyed = false;

      this._buildDom();
      this._mountFilter();
      this._observe();
      // Bind interaction listeners unconditionally; they check the option at
      // event time, so `set({ draggable: true })` works at any moment and
      // auto-init can reconcile late-applied data attributes.
      this._bindDrag();
      this._bindSheen();

      instances.set(el, this);
    }

    /* ---------------- DOM ---------------- */

    _buildDom() {
      const el = this.el;
      el.classList.add('liquid-glass');
      if (this.options.draggable) el.classList.add('lg-draggable');

      // Move existing children into a content layer.
      const content = document.createElement('div');
      content.className = 'lg-content';
      while (el.firstChild) content.appendChild(el.firstChild);
      el.appendChild(content);
      this._content = content;

      // Backdrop layer: the one that actually carries backdrop-filter.
      const backdrop = document.createElement('div');
      backdrop.className = 'lg-backdrop';
      el.insertBefore(backdrop, content);
      this._backdrop = backdrop;

      // Optional tint + sheen overlays.
      const tint = document.createElement('div');
      tint.className = 'lg-tint';
      el.insertBefore(tint, content);
      this._tint = tint;

      const sheen = document.createElement('div');
      sheen.className = 'lg-sheen';
      el.insertBefore(sheen, content);
      this._sheen = sheen;
    }

    /* ---------------- filter ---------------- */

    _mountFilter() {
      if (this._filterEl && this._filterEl.parentNode) this._filterEl.remove();
      const el = this.el;
      const w = el.offsetWidth || 1;
      const h = el.offsetHeight || 1;
      const radius = this.options.radius === 'auto'
        ? readRadius(el, Math.min(w, h) / 2)
        : Math.min(this.options.radius, w / 2, h / 2);
      this._mapSize = { w: w, h: h, r: radius };

      const map = generateDisplacementMap(w, h, radius, this.options.edgeWidth);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'lg-svg-defs');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.position = 'absolute';
      const defs = document.createElementNS(SVG_NS, 'defs');
      this._filterEl = createFilterDef(this.id, map.toDataURL('image/png'), w, h, this.options);
      defs.appendChild(this._filterEl);
      svg.appendChild(defs);
      document.body.appendChild(svg);
      this._svg = svg;

      this._applyBackdropFilter();
    }

    _applyBackdropFilter() {
      const o = this.options;
      const base = 'url(#' + this.id + ')';
      const rest = [
        o.blur > 0 ? 'blur(' + o.blur + 'px)' : null,
        'saturate(' + o.saturate + ')',
        o.brightness !== 1 ? 'brightness(' + o.brightness + ')' : null
      ].filter(Boolean).join(' ');
      // Chrome accepts url() in backdrop-filter; Firefox/Safari don't →
      // the .no-svg-backdrop-filter class below degrades to blur+saturate.
      this._backdrop.style.backdropFilter = base + ' ' + rest;
      this._backdrop.style.webkitBackdropFilter = base + ' ' + rest;
    }

    _observe() {
      // Rebuild the map when the element is resized (the SDF is baked at
      // pixel resolution, so it must match the box).
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._scheduleRebuild());
        this._ro.observe(this.el);
      } else {
        window.addEventListener('resize', () => this._scheduleRebuild());
      }
    }

    _scheduleRebuild() {
      if (this._rebuildRaf || this._destroyed) return;
      this._rebuildRaf = requestAnimationFrame(() => {
        this._rebuildRaf = 0;
        this._mountFilter();
      });
    }

    /* ---------------- sheen ---------------- */

    _bindSheen() {
      this.el.addEventListener('pointermove', (e) => {
        if (!this.options.sheen || this._destroyed) return;
        const rect = this.el.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        this.el.style.setProperty('--lg-mx', x.toFixed(2) + '%');
        this.el.style.setProperty('--lg-my', y.toFixed(2) + '%');
        this.el.classList.add('lg-hover');
      });
      this.el.addEventListener('pointerleave', () => this.el.classList.remove('lg-hover'));
    }

    /* ---------------- drag physics ---------------- */

    _bindDrag() {
      const el = this.el;
      el.style.touchAction = 'none';

      el.addEventListener('pointerdown', (e) => {
        if (this._destroyed || !this.options.draggable) return;
        if (e.button !== undefined && e.button !== 0) return;
        // Don't hijack interactive controls living inside the glass.
        if (e.target.closest('button, a, input, select, textarea, label, [data-no-drag]')) return;

        this._dragging = true;
        this._origin = { x: e.clientX - this._spring.x, y: e.clientY - this._spring.y };
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
        el.classList.add('lg-dragging');

        const move = (ev) => {
          let tx = ev.clientX - this._origin.x;
          let ty = ev.clientY - this._origin.y;
          // Keep the card on screen (16px margin).
          const r = el.getBoundingClientRect();
          const dx = this._spring.x, dy = this._spring.y;
          const minX = 16 - (r.left - dx), maxX = window.innerWidth - 16 - (r.right - dx);
          const minY = 16 - (r.top - dy), maxY = window.innerHeight - 16 - (r.bottom - dy);
          this._target = {
            x: Math.min(Math.max(tx, minX), maxX),
            y: Math.min(Math.max(ty, minY), maxY)
          };
        };
        const up = () => {
          this._dragging = false;
          el.classList.remove('lg-dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          // Snap back home with the spring — fling velocity carries over,
          // producing the elastic overshoot.
          this._target = { x: 0, y: 0 };
          this._emit('release');
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        this._target = { x: this._spring.x, y: this._spring.y };
        this._startLoop();
      });
    }

    _startLoop() {
      if (this._raf || this._destroyed) return;
      this._lastT = performance.now();
      const tick = (t) => {
        if (this._destroyed) return;
        const dt = (t - this._lastT) / 1000;
        this._lastT = t;
        const target = this._target || { x: 0, y: 0 };
        const speed = this._spring.step(target.x, target.y, dt);

        if (!this._dragging && speed < 12 && Math.abs(target.x - this._spring.x) < 0.6) {
          // Settled — park it and stop burning frames.
          this._spring.x = target.x; this._spring.y = target.y;
          this._spring.vx = 0; this._spring.vy = 0;
          this.el.style.transform = '';
          this._raf = 0;
          return;
        }
        // Squash & stretch: grow with speed, lean into the motion.
        const stretch = Math.min(speed / 2400, 0.12);
        const tilt = Math.max(-4, Math.min(4, this._spring.vx * 0.012));
        this.el.style.transform =
          'translate3d(' + this._spring.x.toFixed(2) + 'px,' + this._spring.y.toFixed(2) + 'px,0) ' +
          'scale(' + (1 + stretch).toFixed(4) + ') rotate(' + tilt.toFixed(3) + 'deg)';
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    /** Snap the element back to its home position right now. */
    reset() {
      this._target = { x: 0, y: 0 };
      this._startLoop();
    }

    _emit(type) {
      this.el.dispatchEvent(new CustomEvent('lg:' + type, { bubbles: true }));
    }

    /* ---------------- public API ---------------- */

    /**
     * Update options at runtime. Cheap keys (blur, saturate, chromatic…)
     * take effect immediately; geometry keys (radius, edgeWidth) rebuild
     * the displacement map on the next animation frame.
     */
    set(options) {
      const o = this.options;
      const patch = {};
      const src = options || {};
      for (const k in src) if (src[k] !== undefined) patch[k] = src[k];
      Object.assign(o, patch);
      this._spring.stiffness = o.stiffness;
      this._spring.damping = o.damping;

      const geomChanged = MAP_KEYS.some((k) => k in patch);
      if (geomChanged) this._scheduleRebuild();
      else this._applyBackdropFilter();

      if ('refraction' in patch || 'chromatic' in patch) {
        // Scale lives on the displacement primitives — patch them in place.
        const disps = this._filterEl.querySelectorAll('feDisplacementMap');
        const scale = Math.max(0, o.refraction);
        if (o.chromatic > 0 && disps.length === 3) {
          disps[0].setAttribute('scale', scale * (1 + o.chromatic));
          disps[1].setAttribute('scale', scale);
          disps[2].setAttribute('scale', scale * (1 - o.chromatic));
        } else if (disps.length) {
          disps[0].setAttribute('scale', scale);
        }
      }
      this._tint.style.background = o.tint || 'none';
      this._sheen.style.display = o.sheen ? '' : 'none';
      return this;
    }

    /** Force a full rebuild (after programmatic size changes etc.). */
    refresh() { this._mountFilter(); return this; }

    destroy() {
      this._destroyed = true;
      instances.delete(this.el);
      if (this._ro) this._ro.disconnect();
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._rebuildRaf) cancelAnimationFrame(this._rebuildRaf);
      if (this._svg) this._svg.remove();
      this.el.classList.remove('liquid-glass', 'lg-draggable', 'lg-hover', 'lg-dragging');
      this.el.style.transform = '';
      this.el.style.touchAction = '';
      // Unwrap the content layer back out.
      const content = this._content;
      while (content.firstChild) this.el.appendChild(content.firstChild);
      ['lg-backdrop', 'lg-tint', 'lg-sheen'].forEach((c) => {
        const n = this.el.querySelector(':scope > .' + c);
        if (n) n.remove();
      });
      content.remove();
    }

    /** The LiquidGlass instance backing an element, if any. */
    static for(el) { return instances.get(el) || null; }

    static get version() { return '1.0.0'; }
  }

  /* ------------------------------------------------------------------ */
  /*  Capability probe + auto-init                                       */
  /* ------------------------------------------------------------------ */

  // True when the browser supports SVG filters inside backdrop-filter
  // (Chromium today). Otherwise CSS degrades to blur + saturate.
  const supportsSvgBackdrop = (() => {
    try {
      return CSS.supports('backdrop-filter', 'url(#f)') ||
             CSS.supports('-webkit-backdrop-filter', 'url(#f)');
    } catch (e) { return false; }
  })();
  if (!supportsSvgBackdrop) document.documentElement.classList.add('no-svg-backdrop-filter');

  function autoInit() {
    document.querySelectorAll('[data-liquid-glass]').forEach((el) => {
      const d = el.dataset;
      const opts = {
        radius: d.radius === 'auto' || !d.radius ? 'auto' : parseFloat(d.radius),
        refraction: d.refraction !== undefined ? parseFloat(d.refraction) : undefined,
        edgeWidth: d.edgeWidth !== undefined ? parseFloat(d.edgeWidth) : undefined,
        blur: d.blur !== undefined ? parseFloat(d.blur) : undefined,
        saturate: d.saturate !== undefined ? parseFloat(d.saturate) : undefined,
        chromatic: d.chromatic !== undefined ? parseFloat(d.chromatic) : undefined,
        draggable: d.draggable !== undefined ? d.draggable !== 'false' : undefined
      };
      const existing = instances.get(el);
      if (existing) {
        // An app script constructed this instance before auto-init ran
        // (script order). Reconcile the data attributes onto it.
        existing.set(opts);
      } else {
        new LiquidGlass(el, opts);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  global.LiquidGlass = LiquidGlass;
})(typeof window !== 'undefined' ? window : this);
