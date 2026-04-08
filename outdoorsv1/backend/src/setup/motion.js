// ============================================================
// Outdoors — Ambient Motion System
// Custom cursor, parallax grain, kinetic wordmark, scroll reveals,
// button press physics. Self-initializing on DOMContentLoaded.
//
// Every feature individually checks prefers-reduced-motion and
// bails cleanly if the user wants less motion. Never assume.
// ============================================================

(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isElectron = !!window.electronAPI;

  // Lerp helper — used everywhere for smooth interpolation
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── 1. Custom cursor ─────────────────────────────────────
  // A pixelated Windows-style NW-pointing arrow. Drawn with
  // shape-rendering="crispEdges" so diagonal edges stay blocky,
  // not antialiased. The hotspot is the top-left tip of the arrow
  // (not the SVG center) — offset is 2px so the tip sits on the
  // real pointer position.
  //
  // No hover scaling, no click scaling — pixel cursors shouldn't
  // smoothly deform. Only a subtle pointer-lag via lerp.
  function initCustomCursor() {
    if (reducedMotion) return;

    const cursor = document.createElement('div');
    cursor.className = 'of-cursor';
    // Pixel-art arrow — each "pixel" is 1 SVG unit, arrow is drawn
    // as chunky polygons. Outline then fill. shape-rendering kills
    // the diagonal smoothing so stair-steps are visible.
    cursor.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 22 22" shape-rendering="crispEdges" aria-hidden="true">
        <!-- Black outline, 1px chunky -->
        <path d="M2 1 L2 17 L6 13 L8 19 L11 18 L9 12 L14 12 Z" fill="#111111"/>
        <!-- White fill, inset by 1px -->
        <path d="M3 3 L3 14 L6 11 L8 17 L10 16.4 L8 11 L12 11 Z" fill="#F5EFE0"/>
      </svg>
    `;
    document.body.appendChild(cursor);
    document.body.classList.add('of-cursor-on');

    // 1:1 pointer tracking — no interpolation, no rAF loop.
    // The cursor transform updates directly on every pointermove
    // so the arrow tip is locked to the real OS pointer position.
    window.addEventListener('pointermove', (e) => {
      // Hotspot at the arrow tip (SVG coord ~2,1).
      cursor.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 1}px)`;
    });

    // Hide on window blur, show on focus
    window.addEventListener('blur',  () => cursor.style.opacity = '0');
    window.addEventListener('focus', () => cursor.style.opacity = '1');
  }

  // ── 2. Parallax grain ────────────────────────────────────
  // Shifts the fixed body::before grain layer by a few pixels
  // based on pointer position. So subtle you only notice if it's
  // gone — but that's the point. Makes the paper feel reactive.
  function initParallaxGrain() {
    if (reducedMotion) return;

    let tx = 0, ty = 0;
    let cx = 0, cy = 0;

    window.addEventListener('pointermove', (e) => {
      const nx = (e.clientX / window.innerWidth  - 0.5) * 2; // -1 .. 1
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      tx = nx * 6;  // max 6px drift
      ty = ny * 6;
    });

    function raf() {
      cx = lerp(cx, tx, 0.05);  // slow follow — not nausea-inducing
      cy = lerp(cy, ty, 0.05);
      document.body.style.setProperty('--grain-x', `${cx}px`);
      document.body.style.setProperty('--grain-y', `${cy}px`);
      requestAnimationFrame(raf);
    }
    raf();
  }

  // ── 3. Kinetic wordmark ──────────────────────────────────
  // Split the "Outdoors" brand wordmark into individual letter
  // spans and animate them in with a staggered spring.
  // On hover, each letter gets a small random offset that smoothly
  // settles back. The effect: the word feels organic and alive.
  function initKineticWordmark() {
    const brand = document.querySelector('.titlebar-brand, .brand-title, .wizard-brand');
    if (!brand || brand.dataset.kinetic) return;
    brand.dataset.kinetic = '1';

    const text = brand.textContent;
    brand.textContent = '';
    brand.setAttribute('aria-label', text);

    const letters = [];
    Array.from(text).forEach((ch, i) => {
      const span = document.createElement('span');
      span.className = 'of-letter';
      span.textContent = ch === ' ' ? '\u00a0' : ch;
      span.style.setProperty('--i', i);
      // Staggered entry animation delay, bail to 0 on reduced motion
      span.style.animationDelay = reducedMotion ? '0ms' : `${i * 45}ms`;
      brand.appendChild(span);
      letters.push(span);
    });

    if (reducedMotion) return;

    // Subtle hover wave: each letter gets a small y offset when the
    // cursor passes near it horizontally. Distance-based falloff.
    brand.addEventListener('pointermove', (e) => {
      const rect = brand.getBoundingClientRect();
      const px = e.clientX - rect.left;
      letters.forEach((span, i) => {
        const sr = span.getBoundingClientRect();
        const sx = sr.left - rect.left + sr.width / 2;
        const dist = Math.abs(px - sx);
        const influence = Math.max(0, 1 - dist / 80);
        const dy = -4 * influence;
        span.style.transform = `translateY(${dy}px)`;
      });
    });

    brand.addEventListener('pointerleave', () => {
      letters.forEach(span => { span.style.transform = ''; });
    });
  }

  // ── 4. Scroll-triggered reveals ──────────────────────────
  // New feed entries, cards, and sections fade up into view as
  // they enter the viewport. Uses IntersectionObserver — fires
  // once per element. Respects reduced motion.
  function initScrollReveals() {
    if (reducedMotion) {
      // Make sure nothing is stuck invisible — add the revealed class
      // to everything up front so content is never hidden.
      document.querySelectorAll('.of-reveal').forEach(el => el.classList.add('of-revealed'));
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('of-revealed');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    // Observe everything with the opt-in class
    document.querySelectorAll('.of-reveal').forEach(el => io.observe(el));

    // Watch for new feed entries via a MutationObserver — the feed
    // appends entries dynamically, so we need to catch those as they
    // arrive and mark them for reveal.
    const feed = document.getElementById('feed');
    if (feed) {
      const mo = new MutationObserver((muts) => {
        muts.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.classList && node.classList.contains('feed-entry')) {
              node.classList.add('of-reveal');
              io.observe(node);
            }
          });
        });
      });
      mo.observe(feed, { childList: true });
    }
  }

  // ── 5. Button press physics ──────────────────────────────
  // Every button gets a uniform tactile press animation: scale
  // down on pointerdown, spring back on pointerup. Implemented
  // purely with a single class toggle + CSS transitions, no
  // per-frame work. Works regardless of reduced motion (the
  // feedback is important; only the overshoot is subtle).
  function initButtonPhysics() {
    const buttons = document.querySelectorAll(
      'button, .btn, .btn-primary, .btn-secondary, .invite-btn, [role="button"]'
    );
    buttons.forEach(btn => {
      btn.addEventListener('pointerdown', () => btn.classList.add('of-pressing'));
      const release = () => btn.classList.remove('of-pressing');
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('pointercancel', release);
    });

    // Also catch dynamically-added buttons via event delegation
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest && e.target.closest('button, .btn, [role="button"]');
      if (btn && !btn.dataset.ofBtn) {
        btn.dataset.ofBtn = '1';
        btn.classList.add('of-pressing');
        const release = () => btn.classList.remove('of-pressing');
        btn.addEventListener('pointerup', release, { once: true });
        btn.addEventListener('pointerleave', release, { once: true });
      }
    });
  }

  // ── 6. Page-load choreography ────────────────────────────
  // Dashboard + wizard both get a staggered "settle in" on first
  // paint. Elements with .of-stage get a delay based on their
  // --stage-idx variable.
  function initPageChoreography() {
    document.body.classList.add('of-loaded');
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    initCustomCursor();
    initParallaxGrain();
    initKineticWordmark();
    initScrollReveals();
    initButtonPhysics();
    initPageChoreography();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
