/*
 * The ASCII portrait: characters that scatter from the cursor and spring home.
 *
 *   const p = AsciiPortrait.mount(canvas, window.PORTRAIT, { maxHeight: () => 700 });
 *   p.collapse(3000);   // everything falls to the floor, then flies back
 *
 * Characters at rest are drawn a whole row per fillText call (about 90 calls).
 * Only characters that are out of place are drawn one by one from a glyph
 * atlas, so the cost follows how many are moving, not how many there are.
 * Drawing all ~9k individually ran at 7 fps in a GPU-less browser; this runs
 * at 40-55.
 */
window.AsciiPortrait = (() => {
  const INK = "#0b0b0b";
  const FAMILY = '"JetBrains Mono", Consolas, monospace';
  const SCRAMBLE = "!#$%&*+=?/\\|<>{}[]~^01";
  // Smallest size at which a character still reads as a character. The
  // finest grid that stays above it wins.
  const MIN_FONT = 7;
  const DENSITIES = ["fine", "medium", "coarse"];

  function mount(canvas, data, opts = {}) {
    const style = opts.style || "tone";
    const maxHeight = opts.maxHeight || (() => window.innerHeight * 0.8);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d");

    let advance = 0.6;
    {
      const m = document.createElement("canvas").getContext("2d");
      m.font = `700 100px ${FAMILY}`;
      advance = m.measureText("M").width / 100;
    }

    let rows, grid, rowText, dirty, nRows;
    let n = 0, pr, pc, hx, hy, x, y, vx, vy, home, scr, moving, appear, settle;
    let cellW, cellH, fontSize, dpr, W, H, PAD, offX;
    let atlas, aw, ah, glyphIndex, scrambleGlyph;
    let introStart = 0, introEnd = 0, frame = 0, raf = 0, gravityUntil = 0;
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, inside: false };

    function pickDensity(stageW, maxH) {
      for (const name of DENSITIES) {
        const d = data[name];
        const size = Math.min((stageW - PAD * 2) / (d.cols * advance), (maxH - PAD * 2) / d.rows);
        if (size >= MIN_FONT) return name;
      }
      return "coarse";
    }

    function buildAtlas(chars) {
      aw = Math.ceil(cellW * dpr) + 4;
      ah = Math.ceil(cellH * dpr) + 4;
      atlas = document.createElement("canvas");
      atlas.width = aw * chars.length;
      atlas.height = ah;
      const a = atlas.getContext("2d");
      // Bold: at 7-8px a regular stroke antialiases to grey and the face washes out.
      a.font = `700 ${fontSize * dpr}px ${FAMILY}`;
      a.textAlign = "center";
      a.textBaseline = "middle";
      a.fillStyle = INK;
      chars.forEach((c, i) => a.fillText(c, i * aw + aw / 2, ah / 2));
      glyphIndex = new Map(chars.map((c, i) => [c, i]));
      scrambleGlyph = [...SCRAMBLE].map(c => glyphIndex.get(c));
    }

    function build(introMs) {
      const stageW = canvas.parentElement.getBoundingClientRect().width;
      const maxH = maxHeight();
      PAD = stageW < 480 ? 8 : 24;  // room around the portrait for characters to fly into
      const d = data[pickDensity(stageW, maxH)];
      rows = d[style];
      nRows = d.rows;
      fontSize = Math.min((stageW - PAD * 2) / (d.cols * advance), (maxH - PAD * 2) / nRows);
      cellW = fontSize * advance;
      cellH = fontSize;
      W = Math.floor(stageW);
      H = Math.ceil(nRows * cellH + PAD * 2);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      offX = (W - d.cols * cellW) / 2;

      buildAtlas([...new Set(rows.join("") + SCRAMBLE)].filter(c => c !== " "));

      grid = rows.map(r => [...r]);
      rowText = rows.slice();
      dirty = new Uint8Array(nRows);

      n = 0;
      for (const r of rows) for (const c of r) if (c !== " ") n++;
      pr = new Uint16Array(n); pc = new Uint16Array(n);
      hx = new Float32Array(n); hy = new Float32Array(n);
      x = new Float32Array(n); y = new Float32Array(n);
      vx = new Float32Array(n); vy = new Float32Array(n);
      home = new Uint8Array(n); scr = new Uint8Array(n); moving = new Uint8Array(n);
      appear = new Float32Array(n); settle = new Float32Array(n);

      const ms = reduceMotion ? 0 : introMs;
      let i = 0;
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
          if (row[c] === " ") continue;
          pr[i] = r; pc[i] = c;
          hx[i] = x[i] = offX + (c + 0.5) * cellW;
          hy[i] = y[i] = PAD + (r + 0.5) * cellH;
          home[i] = glyphIndex.get(row[c]);
          scr[i] = (Math.random() * SCRAMBLE.length) | 0;
          // The intro decodes top to bottom: each cell turns up as noise,
          // then resolves into its real character a moment later.
          appear[i] = (r / nRows) * ms * 0.55 + Math.random() * ms * 0.2;
          settle[i] = appear[i] + ms * 0.08 + Math.random() * ms * 0.25;
          i++;
        }
      });
      introStart = performance.now();
      introEnd = introStart + ms;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(introStart);
      wake();
    }

    function step(now) {
      const R = Math.max(56, cellW * 13);
      const R2 = R * R;
      const near = pointer.inside;
      const falling = now < gravityUntil;
      const floor = H - cellH / 2;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (near) {
          const dx = x[i] - pointer.x, dy = y[i] - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2) {
            const d = Math.sqrt(d2) || 1;
            const f = 1 - d / R;
            const push = f * f * 2.4;
            // Pushed away from the cursor, and dragged a little along its path,
            // so a fast swipe smears the face instead of just denting it.
            vx[i] += (dx / d) * push + pointer.vx * f * 0.06;
            vy[i] += (dy / d) * push + pointer.vy * f * 0.06;
          }
        }
        if (!moving[i] && vx[i] === 0 && vy[i] === 0) continue;
        if (falling) {
          vy[i] += 0.55;
          vx[i] *= 0.99;
          x[i] += vx[i];
          y[i] += vy[i];
          if (y[i] > floor) { y[i] = floor; vy[i] *= -0.3; vx[i] *= 0.8; }
          if (x[i] < cellW || x[i] > W - cellW) vx[i] *= -0.5;
          count++;
          continue;
        }
        vx[i] = (vx[i] + (hx[i] - x[i]) * 0.05) * 0.87;
        vy[i] = (vy[i] + (hy[i] - y[i]) * 0.05) * 0.87;
        x[i] += vx[i];
        y[i] += vy[i];
        const off = Math.abs(x[i] - hx[i]) + Math.abs(y[i] - hy[i]);
        if (off < 0.3 && Math.abs(vx[i]) + Math.abs(vy[i]) < 0.05) {
          x[i] = hx[i]; y[i] = hy[i]; vx[i] = vy[i] = 0;
          if (moving[i]) { moving[i] = 0; dirty[pr[i]] = 1; }
        } else {
          if (!moving[i]) { moving[i] = 1; dirty[pr[i]] = 1; }
          count++;
        }
      }
      pointer.vx *= 0.8;
      pointer.vy *= 0.8;
      frame++;
      return count;
    }

    function render(now) {
      const t = now - introStart;
      const intro = now < introEnd;
      // Out of place, a character loses its identity and flickers; it gets
      // its real glyph back once it is home.
      if (frame % 4 === 0) {
        for (let i = 0; i < n; i++) if (moving[i] || intro) scr[i] = (Math.random() * SCRAMBLE.length) | 0;
      }

      for (let i = 0; i < n; i++) {
        let ch;
        if (moving[i]) ch = " ";
        else if (intro && t < appear[i]) ch = " ";
        else if (intro && t < settle[i]) ch = SCRAMBLE[scr[i]];
        else ch = rows[pr[i]][pc[i]];
        if (grid[pr[i]][pc[i]] !== ch) { grid[pr[i]][pc[i]] = ch; dirty[pr[i]] = 1; }
      }

      ctx.clearRect(0, 0, W, H);
      ctx.font = `700 ${fontSize}px ${FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.fillStyle = INK;
      for (let r = 0; r < nRows; r++) {
        if (dirty[r]) { rowText[r] = grid[r].join(""); dirty[r] = 0; }
        ctx.fillText(rowText[r], offX, PAD + (r + 0.5) * cellH);
      }

      const gw = aw / dpr, gh = ah / dpr;
      for (let i = 0; i < n; i++) {
        if (!moving[i]) continue;
        const far = Math.abs(x[i] - hx[i]) + Math.abs(y[i] - hy[i]) > cellW * 0.8;
        const g = far ? scrambleGlyph[scr[i]] : home[i];
        ctx.drawImage(atlas, g * aw, 0, aw, ah, x[i] - gw / 2, y[i] - gh / 2, gw, gh);
      }
    }

    function tick(now) {
      const count = step(now);
      render(now);
      // Sleep once everything is home, the intro is done and nobody is touching it.
      if (!pointer.inside && count === 0 && now >= introEnd) { raf = 0; return; }
      raf = requestAnimationFrame(tick);
    }

    function wake() {
      if (!reduceMotion && !raf) raf = requestAnimationFrame(tick);
    }

    function local(e) {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    function knock(px, py) {
      const reach = Math.max(W, H) * 0.35;
      for (let i = 0; i < n; i++) {
        const dx = x[i] - px, dy = y[i] - py;
        const d = Math.hypot(dx, dy) || 1;
        if (d > reach) continue;
        const kick = (1 - d / reach) * 24;
        vx[i] += (dx / d) * kick;
        vy[i] += (dy / d) * kick - Math.random() * 4;
      }
      wake();
    }

    function release() { pointer.inside = false; pointer.x = pointer.y = -1e4; }

    if (!reduceMotion) {
      canvas.addEventListener("pointermove", e => {
        // A finger only moves the portrait while it is down; a vertical drag
        // is the page scrolling (touch-action: pan-y) and ends in pointercancel.
        if (e.pointerType !== "mouse" && e.buttons === 0) return;
        const [px, py] = local(e);
        if (pointer.inside) { pointer.vx = px - pointer.x; pointer.vy = py - pointer.y; }
        pointer.x = px; pointer.y = py; pointer.inside = true;
        wake();
      });
      canvas.addEventListener("pointerleave", release);
      canvas.addEventListener("pointercancel", release);
      canvas.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") release(); });
      canvas.addEventListener("pointerdown", e => knock(...local(e)));
    }

    let lastWidth = 0;
    const ro = new ResizeObserver(([entry]) => {
      // Watch the parent, not the canvas: the canvas's own size is what build() sets.
      const w = Math.round(entry.contentRect.width);
      if (w === lastWidth) return;
      const first = lastWidth === 0;
      lastWidth = w;
      build(first ? (opts.introMs ?? 1600) : 0);
    });
    ro.observe(canvas.parentElement);

    return {
      collapse(ms = 3000) {
        if (reduceMotion) return;
        gravityUntil = performance.now() + ms;
        for (let i = 0; i < n; i++) {
          moving[i] = 1;
          dirty[pr[i]] = 1;
          vx[i] += (Math.random() - 0.5) * 3;
          vy[i] += Math.random() * -2;
        }
        wake();
      },
    };
  }

  return { mount };
})();
