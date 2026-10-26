/*
 * The ASCII portrait: a face made of characters that looks toward the
 * cursor, scatters when you push through it, falls asleep when left alone,
 * and plays short reactions (wave, nod, startled).
 *
 *   const p = AsciiPortrait.mount(canvas, window.PORTRAIT, { maxHeight: () => 700 });
 *   p.density            // "fine" | "medium" | "coarse": which clip file to load
 *   p.setClips(density, window.PORTRAIT_CLIPS)
 *   p.play("wave")
 *   p.collapse(3000)     // everything falls to the floor, then flies back
 *
 * Every cell of the grid is a particle, even the blank ones, so changing
 * frames (a new pose, a clip frame) only changes which character each
 * particle shows; anything scattered stays scattered.
 *
 * Characters at rest are drawn a whole row per fillText call (about 70
 * calls). Only characters out of place are drawn one by one, from a glyph
 * atlas, so the cost follows how many are moving, not how many there are.
 */
window.AsciiPortrait = (() => {
  const INK = "#0b0b0b";
  const FAMILY = '"JetBrains Mono", Consolas, monospace';
  const SCRAMBLE = "!#$%&*+=?/\\|<>{}[]~^01";
  const RAMP = " .,:;-=+*#%@";
  // Smallest size at which a character still reads as a character. The
  // finest grid that stays above it wins.
  const MIN_FONT = 7;
  const DENSITIES = ["fine", "medium", "coarse"];
  // Where the face is, as a fraction of the grid. Matches the crop in
  // pipeline/make_portrait.py (head starts 0.35 head-widths down, crop is
  // 2.55 head-widths tall).
  const FACE = { x: 0.5, y: 0.37 };
  const SLEEP_AFTER = 15000;
  const POSE = {
    "-1,-1": "top-left", "0,-1": "top", "1,-1": "top-right",
    "-1,0": "left", "0,0": "center", "1,0": "right",
    "-1,1": "bottom-left", "0,1": "bottom", "1,1": "bottom-right",
  };

  function mount(canvas, data, opts = {}) {
    const maxHeight = opts.maxHeight || (() => window.innerHeight * 0.8);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d");

    let advance = 0.6;
    {
      const m = document.createElement("canvas").getContext("2d");
      m.font = `700 100px ${FAMILY}`;
      advance = m.measureText("M").width / 100;
    }

    const api = { density: null };
    const clipsByDensity = {};

    let d, cols, nRows, n = 0;
    let hx, hy, x, y, vx, vy, scr, moving, appear, settle, flipUntil;
    let grid, rowText, dirty;
    let cellW, cellH, fontSize, dpr, W, H, PAD, offX;
    let atlas, aw, ah, glyphIndex, scrambleGlyph;
    let introStart = 0, introEnd = 0, frame = 0, raf = 0, gravityUntil = 0, flipEnd = 0;

    // What is showing: a pose, or a clip frame on top of it.
    let pose = "center", rows = null, prevRows = null;
    let clip = null; // { name, frames, start }
    let sleeping = false, lastActive = performance.now();
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, inside: false };
    const look = { h: 0, v: 0 };

    // ---------- layout ----------

    function pickDensity(stageW, maxH) {
      for (const name of DENSITIES) {
        const g = data.densities[name];
        const size = Math.min((stageW - PAD * 2) / (g.cols * advance), (maxH - PAD * 2) / g.rows);
        if (size >= MIN_FONT) return name;
      }
      return "coarse";
    }

    function buildAtlas() {
      const chars = [...new Set(RAMP + SCRAMBLE)].filter(c => c !== " ");
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
      api.density = pickDensity(stageW, maxH);
      d = data.densities[api.density];
      cols = d.cols;
      nRows = d.rows;
      fontSize = Math.min((stageW - PAD * 2) / (cols * advance), (maxH - PAD * 2) / nRows);
      cellW = fontSize * advance;
      cellH = fontSize;
      W = Math.floor(stageW);
      H = Math.ceil(nRows * cellH + PAD * 2);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      offX = (W - cols * cellW) / 2;
      buildAtlas();

      n = cols * nRows;
      hx = new Float32Array(n); hy = new Float32Array(n);
      x = new Float32Array(n); y = new Float32Array(n);
      vx = new Float32Array(n); vy = new Float32Array(n);
      scr = new Uint8Array(n); moving = new Uint8Array(n);
      appear = new Float32Array(n); settle = new Float32Array(n); flipUntil = new Float32Array(n);
      grid = Array.from({ length: nRows }, () => new Array(cols).fill(" "));
      rowText = new Array(nRows).fill("");
      dirty = new Uint8Array(nRows).fill(1);

      const ms = reduceMotion ? 0 : introMs;
      for (let r = 0, i = 0; r < nRows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          hx[i] = x[i] = offX + (c + 0.5) * cellW;
          hy[i] = y[i] = PAD + (r + 0.5) * cellH;
          scr[i] = (Math.random() * SCRAMBLE.length) | 0;
          // The intro decodes top to bottom: each cell turns up as noise,
          // then resolves into its real character a moment later.
          appear[i] = (r / nRows) * ms * 0.55 + Math.random() * ms * 0.2;
          settle[i] = appear[i] + ms * 0.08 + Math.random() * ms * 0.25;
        }
      }
      clip = null; // its frames belong to the old grid
      rows = currentRows();
      prevRows = rows;
      introStart = performance.now();
      introEnd = introStart + ms;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(introStart);
      wake();
    }

    // ---------- what to show ----------

    function currentRows() {
      if (clip) return clip.frames[Math.max(0, clipFrame(performance.now()))];
      return d.frames[sleeping ? "eyes-closed" : pose] || d.frames.center;
    }

    // A clip plays forward, holds a beat, then plays backward, so it ends
    // exactly where it began. -1 once it is over.
    const HOLD = 3;
    function clipFrame(now) {
      const k = Math.floor((now - clip.start) / 1000 * data.fps);
      const len = clip.frames.length;
      if (k < len) return k;
      if (k < len + HOLD) return len - 1;
      return Math.max(-1, 2 * len + HOLD - 2 - k);
    }

    // Swapping frames: every cell that changes flickers through noise for a
    // moment before landing, which covers the jump between two photos.
    function show(next, now, scramble = true) {
      if (next === rows) return;
      prevRows = rows;
      rows = next;
      if (scramble && !reduceMotion) {
        for (let r = 0, i = 0; r < nRows; r++) {
          const a = prevRows[r], b = rows[r];
          if (a === b) { i += cols; continue; }
          for (let c = 0; c < cols; c++, i++) {
            if (a[c] !== b[c]) flipUntil[i] = now + 40 + Math.random() * 140;
          }
        }
        flipEnd = now + 180;
      }
      dirty.fill(1);
      wake();
    }

    function setPose(next) {
      if (next === pose) return;
      pose = next;
      if (!clip && !sleeping) show(currentRows(), performance.now());
    }

    function play(name) {
      const frames = clipsByDensity[api.density]?.[name];
      if (!frames || reduceMotion) return false;
      sleeping = false;
      clip = { name, frames, start: performance.now() };
      show(frames[0], performance.now());
      return true;
    }

    // ---------- the loop ----------

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
            const dd = Math.sqrt(d2) || 1;
            const f = 1 - dd / R;
            const push = f * f * 2.4;
            // Pushed away from the cursor, and dragged a little along its path,
            // so a fast swipe smears the face instead of just denting it.
            vx[i] += (dx / dd) * push + pointer.vx * f * 0.06;
            vy[i] += (dy / dd) * push + pointer.vy * f * 0.06;
          }
        }
        if (!moving[i] && vx[i] === 0 && vy[i] === 0) continue;
        const r = (i / cols) | 0;
        if (falling) {
          vy[i] += 0.55;
          vx[i] *= 0.99;
          x[i] += vx[i];
          y[i] += vy[i];
          if (y[i] > floor) { y[i] = floor; vy[i] *= -0.3; vx[i] *= 0.8; }
          if (x[i] < cellW || x[i] > W - cellW) vx[i] *= -0.5;
          if (!moving[i]) { moving[i] = 1; dirty[r] = 1; }
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
          if (moving[i]) { moving[i] = 0; dirty[r] = 1; }
        } else {
          if (!moving[i]) { moving[i] = 1; dirty[r] = 1; }
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
      const flipping = now < flipEnd;
      if (frame % 4 === 0) {
        for (let i = 0; i < n; i++) if (moving[i] || intro || flipping) scr[i] = (Math.random() * SCRAMBLE.length) | 0;
      }

      for (let r = 0, i = 0; r < nRows; r++) {
        const row = rows[r], prev = prevRows[r], g = grid[r];
        for (let c = 0; c < cols; c++, i++) {
          const home = row[c];
          let ch;
          if (moving[i]) ch = " ";
          else if (intro && t < appear[i]) ch = " ";
          else if (intro && t < settle[i]) ch = home === " " ? " " : SCRAMBLE[scr[i]];
          else if (flipping && now < flipUntil[i]) ch = home === " " && prev[c] === " " ? " " : SCRAMBLE[scr[i]];
          else ch = home;
          if (g[c] !== ch) { g[c] = ch; dirty[r] = 1; }
        }
      }

      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.font = `700 ${fontSize}px ${FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = INK;
      for (let r = 0; r < nRows; r++) {
        if (dirty[r]) { rowText[r] = grid[r].join(""); dirty[r] = 0; }
        ctx.fillText(rowText[r], offX, PAD + (r + 0.5) * cellH);
      }

      const gw = aw / dpr, gh = ah / dpr;
      for (let i = 0; i < n; i++) {
        if (!moving[i]) continue;
        const home = rows[(i / cols) | 0][i % cols];
        if (home === " ") continue; // a blank cell knocked loose stays invisible
        const far = Math.abs(x[i] - hx[i]) + Math.abs(y[i] - hy[i]) > cellW * 0.8;
        const g = far ? scrambleGlyph[scr[i]] : glyphIndex.get(home);
        ctx.drawImage(atlas, g * aw, 0, aw, ah, x[i] - gw / 2, y[i] - gh / 2, gw, gh);
      }

      if (sleeping) drawZs(now);
    }

    // Three letters drifting up off the top of the head while asleep.
    function drawZs(now) {
      const fx = offX + cols * cellW * (FACE.x + 0.14);
      const fy = PAD + nRows * cellH * 0.16;
      for (let k = 0; k < 3; k++) {
        const p = (now / 2200 + k / 3) % 1;
        ctx.globalAlpha = Math.sin(p * Math.PI);
        ctx.font = `700 ${cellH * (1.6 + p * 1.6)}px ${FAMILY}`;
        ctx.fillText(k === 1 ? "Z" : "z", fx + p * cellW * 7, fy - p * cellH * 9);
      }
      ctx.globalAlpha = 1;
    }

    function tick(now) {
      if (clip) {
        const i = clipFrame(now);
        if (i < 0) {
          clip = null;
          show(currentRows(), now);
        } else {
          show(clip.frames[i], now, false);
        }
      } else if (!sleeping && !reduceMotion && now - lastActive > SLEEP_AFTER && now > introEnd && onScreen()) {
        sleeping = true;
        show(currentRows(), now);
      }

      const count = step(now);
      render(now);
      // Sleep the loop once nothing is moving, changing or animating. The
      // floating Zs are the one endless animation; they pause off screen.
      const busy = pointer.inside || count > 0 || now < introEnd || now < flipEnd || clip || (sleeping && onScreen());
      if (!busy) { raf = 0; return; }
      raf = requestAnimationFrame(tick);
    }

    function wake() {
      if (!reduceMotion && !raf) raf = requestAnimationFrame(tick);
    }

    function onScreen() {
      const r = canvas.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    }

    // ---------- looking at the cursor ----------

    // -1, 0 or 1 along one axis, with a margin around each boundary so the
    // head does not flick back and forth when the cursor sits on the line.
    function axis(v, lo, hi, cur) {
      const m = (hi - lo) * 0.12;
      if (cur === -1) return v < lo + m ? -1 : v > hi ? 1 : 0;
      if (cur === 1) return v > hi - m ? 1 : v < lo ? -1 : 0;
      return v < lo - m ? -1 : v > hi + m ? 1 : 0;
    }

    function lookAt(px, py) {
      const r = canvas.getBoundingClientRect();
      const fw = cols * cellW, fh = nRows * cellH;
      const fx = r.left + offX + fw * FACE.x;
      const fy = r.top + PAD + fh * FACE.y;
      look.h = axis(px - fx, -fw * 0.2, fw * 0.2, look.h);
      look.v = axis(py - fy, -fh * 0.16, fh * 0.2, look.v);
      setPose(POSE[`${look.h},${look.v}`]);
    }

    // Any sign of life: if asleep, wake up startled.
    function active() {
      lastActive = performance.now();
      if (sleeping) {
        sleeping = false;
        if (!play("startled")) show(currentRows(), performance.now());
      }
    }

    // ---------- input ----------

    function local(e) {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    function knock(px, py) {
      const reach = Math.max(W, H) * 0.35;
      for (let i = 0; i < n; i++) {
        if (rows[(i / cols) | 0][i % cols] === " ") continue;
        const dx = x[i] - px, dy = y[i] - py;
        const dd = Math.hypot(dx, dy) || 1;
        if (dd > reach) continue;
        const kick = (1 - dd / reach) * 24;
        vx[i] += (dx / dd) * kick;
        vy[i] += (dy / dd) * kick - Math.random() * 4;
      }
      wake();
    }

    function release() { pointer.inside = false; pointer.x = pointer.y = -1e4; }

    if (!reduceMotion) {
      // The loop stops itself when nothing moves, so falling asleep (and
      // resuming the Zs after scrolling back) needs something outside it.
      setInterval(() => {
        const due = !sleeping && performance.now() - lastActive > SLEEP_AFTER;
        if ((due || sleeping) && onScreen()) wake();
      }, 1000);

      // The head follows the cursor anywhere on the page, not only over the canvas.
      window.addEventListener("pointermove", e => {
        active();
        if (e.pointerType === "mouse" || e.buttons) lookAt(e.clientX, e.clientY);
      }, { passive: true });
      document.documentElement.addEventListener("pointerleave", () => setPose("center"));
      for (const type of ["scroll", "keydown", "pointerdown"]) {
        window.addEventListener(type, active, { passive: true });
      }

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
      canvas.addEventListener("pointerup", e => {
        if (e.pointerType !== "mouse") { release(); setPose("center"); }
      });
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
      opts.onDensity?.(api.density);
    });
    ro.observe(canvas.parentElement);

    return Object.assign(api, {
      introEnd: () => introEnd,
      setClips(density, clips) { clipsByDensity[density] = clips; },
      play,
      collapse(ms = 3000) {
        if (reduceMotion) return;
        gravityUntil = performance.now() + ms;
        for (let i = 0; i < n; i++) {
          if (rows[(i / cols) | 0][i % cols] === " ") continue;
          moving[i] = 1;
          vx[i] += (Math.random() - 0.5) * 3;
          vy[i] += Math.random() * -2;
        }
        dirty.fill(1);
        wake();
      },
    });
  }

  return { mount };
})();
