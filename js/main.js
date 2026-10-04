/* ===========================================================================
   Penthouse 3B — page behaviour
   Mobile nav, headline reveal, gallery carousel, property film, tour request form.
   =========================================================================== */

(function () {
  'use strict';

  /* --- Mobile nav ---------------------------------------------------------- */
  var nav = document.querySelector('.nav');
  var toggle = nav && nav.querySelector('.nav__toggle');

  function setNav(open) {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  }

  // Pin the nav to the top once the hero has scrolled out of view
  var hero = document.querySelector('.hero');

  function updateStuck() {
    nav.classList.toggle('is-stuck', hero.getBoundingClientRect().bottom <= 72);
  }

  // Scroll cue: 0 at the top of the page, 1 once the visitor is a quarter of the hero down
  function updateScrollCue() {
    var p = Math.min(1, Math.max(0, window.scrollY / (hero.offsetHeight * 0.25)));
    hero.style.setProperty('--scroll-p', p.toFixed(3));
  }

  if (nav && hero) {
    window.addEventListener('scroll', updateStuck, { passive: true });
    window.addEventListener('scroll', updateScrollCue, { passive: true });
    window.addEventListener('resize', updateStuck);
    window.addEventListener('resize', updateScrollCue);
    updateStuck();
    updateScrollCue();
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      setNav(!nav.classList.contains('is-open'));
    });
    nav.querySelectorAll('.nav__links a').forEach(function (link) {
      link.addEventListener('click', function () { setNav(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) setNav(false);
    });
  }

  /* --- Headline reveal ---------------------------------------------------- */
  // Each headline is split into its rendered lines; every line sits in a
  // clipping mask and slides up into view, staggered, when the headline enters
  // the viewport (the hero title plays on load). Skipped for reduced motion.
  var REVEAL_SELECTOR = '.hero__title, .headline, .overview__lead, .plan__title, .inquire__title';
  var revealTargets = Array.prototype.slice.call(document.querySelectorAll(REVEAL_SELECTOR));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Rebuild el as one masked block per rendered line
  function splitLines(el) {
    var text = el.dataset.revealText || el.textContent.trim().replace(/\s+/g, ' ');
    el.dataset.revealText = text;
    el.setAttribute('aria-label', text);

    // Lay the words out as spans so the browser's own wrapping tells us the lines
    el.textContent = '';
    var words = text.split(' ').map(function (word, i) {
      if (i) el.appendChild(document.createTextNode(' '));
      var span = document.createElement('span');
      span.textContent = word;
      span.style.whiteSpace = 'nowrap'; // hyphenated words must measure and wrap as one unit
      el.appendChild(span);
      return span;
    });

    var lines = [];
    var top = null;
    words.forEach(function (span) {
      if (span.offsetTop !== top) { lines.push([]); top = span.offsetTop; }
      lines[lines.length - 1].push(span.textContent);
    });

    el.textContent = '';
    lines.forEach(function (line, i) {
      var mask = document.createElement('span');
      mask.className = 'reveal-line';
      mask.setAttribute('aria-hidden', 'true');
      var inner = document.createElement('span');
      inner.className = 'reveal-line__inner';
      inner.style.whiteSpace = 'nowrap'; // lines were measured; don't let the browser re-wrap them
      inner.style.setProperty('--line', i);
      inner.textContent = line.join(' ');
      mask.appendChild(inner);
      el.appendChild(mask);
    });
    el.classList.add('is-split');
  }

  if (revealTargets.length && !reduceMotion) {
    var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();

    // Split only after the web fonts load, since they decide where lines break
    fontsReady.then(function () {
      revealTargets.forEach(splitLines);

      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -12% 0px' });

      revealTargets.forEach(function (el) { observer.observe(el); });

      // Re-split when the width changes, since the line breaks move
      var lastWidth = window.innerWidth;
      var resizeTimer;
      window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          if (window.innerWidth === lastWidth) return;
          lastWidth = window.innerWidth;
          revealTargets.forEach(splitLines);
        }, 200);
      });
    });
  }

  /* --- Event modal: Turtle Creek Tour of Homes ----------------------------- */
  // One-time event. Opens once per visitor after they scroll past the hero or
  // spend a few seconds on the page; the nav link reopens it. Everything
  // switches off after the event ends (data-ends on the dialog).
  var eventModal = document.querySelector('.event-modal');

  if (eventModal && eventModal.showModal && Date.now() < Date.parse(eventModal.dataset.ends)) {
    var EVENT_KEY = 'p3b-tour-of-homes-2026';
    var EVENT_DELAY = 8000; // ms
    // Nav link and hero button — hidden in the markup so they vanish after the event
    document.querySelectorAll('[data-event-only]').forEach(function (el) { el.hidden = false; });

    function seenEvent() {
      try { return localStorage.getItem(EVENT_KEY); } catch (e) { return 'unavailable'; }
    }
    function rememberEvent(value) {
      try { localStorage.setItem(EVENT_KEY, value); } catch (e) { /* ignore */ }
    }
    function track(name) {
      if (typeof window.gtag === 'function') window.gtag('event', name, { event_category: 'tour_of_homes' });
    }

    function openEvent(source) { // 'auto' | 'click' | 'link'
      if (eventModal.open) return;
      // Never interrupt the menu, the photo viewer or someone filling in the form
      if (source === 'auto' && (document.querySelector('dialog[open]') || (nav && nav.classList.contains('is-open')) ||
          (document.activeElement && document.activeElement.closest('#tour-form')))) return;
      if (nav && nav.classList.contains('is-open')) setNav(false);
      eventModal.showModal();
      if (!seenEvent() || seenEvent() === 'unavailable') rememberEvent('seen');
      track({ auto: 'tour_modal_auto_open', click: 'tour_modal_open', link: 'tour_modal_link_open' }[source]);
    }

    document.querySelectorAll('[data-open-event]').forEach(function (btn) {
      btn.addEventListener('click', function () { openEvent('click'); });
    });
    eventModal.querySelectorAll('[data-close-event]').forEach(function (btn) {
      btn.addEventListener('click', function () { eventModal.close(); track('tour_modal_dismiss'); });
    });
    // Click on the dimmed backdrop (the dialog element itself) closes it
    eventModal.addEventListener('click', function (e) {
      if (e.target === eventModal) { eventModal.close(); track('tour_modal_dismiss'); }
    });
    eventModal.querySelector('[data-event-tickets]').addEventListener('click', function () {
      rememberEvent('tickets');
      track('tour_tickets_click');
    });

    // Shareable link: ?tour always opens the modal (e.g. from Instagram or email)
    if (new URLSearchParams(location.search).has('tour')) {
      setTimeout(function () { openEvent('link'); }, 600);
    } else if (!seenEvent()) {
      // Auto-open once, on whichever comes first: scrolled past the hero, or the delay
      var autoTimer = setTimeout(function () { triggerAuto(); }, EVENT_DELAY);
      var onScroll = function () {
        if (hero && hero.getBoundingClientRect().bottom < window.innerHeight * 0.5) triggerAuto();
      };
      var triggerAuto = function () {
        clearTimeout(autoTimer);
        window.removeEventListener('scroll', onScroll);
        if (!seenEvent()) openEvent('auto');
      };
      window.addEventListener('scroll', onScroll, { passive: true });
    }
  }

  /* --- Gallery carousel ---------------------------------------------------- */
  var gallery = document.querySelector('.gallery');

  if (gallery) {
    var slides = Array.prototype.slice.call(gallery.querySelectorAll('.gallery__slide'));
    var count = gallery.querySelector('.gallery__count');
    var title = gallery.querySelector('.gallery__title');
    var progress = gallery.querySelector('.gallery__progress');
    var n = slides.length;
    var current = 0;
    var pad = function (i) { return String(i).padStart(2, '0'); };

    slides.forEach(function (slide, i) {
      progress.appendChild(document.createElement('span'));
      slide.setAttribute('aria-label', (i + 1) + ' of ' + n);
      // Side slides bring themselves to the centre; the centre slide opens full screen
      slide.addEventListener('click', function () {
        if (i !== current) go(i);
        else openLightbox();
      });
      slide.addEventListener('keydown', function (e) {
        if (i === current && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          openLightbox();
        }
      });
    });
    var ticks = progress.children;

    // Position of slide i relative to the current one: 0 = current,
    // 1 = next (peeking right), -1 = previous (peeking left), wrapping around.
    function relative(i) {
      var d = ((i - current) % n + n) % n;
      return d > n / 2 ? d - n : d;
    }

    function render(first) {
      slides.forEach(function (slide, i) {
        var rel = relative(i);
        var prev = Number(slide.style.getPropertyValue('--rel') || rel);
        // A slide wrapping from one side to the other jumps without animating
        var jump = first || Math.abs(rel - prev) > 1;
        slide.classList.toggle('no-anim', jump);
        slide.style.setProperty('--rel', rel);
        slide.classList.toggle('is-current', rel === 0);
        slide.classList.toggle('is-next', rel === 1);
        slide.setAttribute('aria-hidden', String(rel !== 0));
        slide.tabIndex = rel === 0 ? 0 : -1;
        if (jump) {
          void slide.offsetWidth;
          slide.classList.remove('no-anim');
        }
        ticks[i].classList.toggle('is-current', rel === 0);
      });
      count.textContent = pad(current + 1) + ' / ' + pad(n);
      title.textContent = slides[current].dataset.caption;
      if (lightbox && lightbox.open) renderLightbox();
    }

    function go(i) {
      current = (i + n) % n;
      render(false);
    }

    gallery.querySelectorAll('.gallery__arrow').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go(current + Number(btn.dataset.dir));
      });
    });

    gallery.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') go(current - 1);
      if (e.key === 'ArrowRight') go(current + 1);
    });

    // Swipe
    var startX = null;
    var viewport = gallery.querySelector('.gallery__viewport');
    viewport.addEventListener('touchstart', function (e) {
      startX = e.touches[0].clientX;
    }, { passive: true });
    viewport.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) go(current + (dx < 0 ? 1 : -1));
      startX = null;
    });

    /* Full-screen viewer — a <dialog> gives Esc-to-close and focus trapping */
    var lightbox = document.querySelector('.lightbox');
    var lbImg = lightbox && lightbox.querySelector('.lightbox__img');

    function renderLightbox() {
      var img = slides[current].querySelector('img');
      lbImg.src = img.currentSrc || img.src;
      lbImg.alt = img.alt;
      lightbox.querySelector('.lightbox__count').textContent = pad(current + 1) + ' / ' + pad(n);
      lightbox.querySelector('.lightbox__title').textContent = slides[current].dataset.caption;
    }

    function openLightbox() {
      if (!lightbox || !lightbox.showModal) return;
      renderLightbox();
      lightbox.showModal();
    }

    if (lightbox) {
      lightbox.addEventListener('close', function () {
        slides[current].focus({ preventScroll: true });
      });
      lightbox.querySelector('.lightbox__close').addEventListener('click', function () {
        lightbox.close();
      });
      lightbox.querySelectorAll('.lightbox__arrow').forEach(function (btn) {
        btn.addEventListener('click', function () { go(current + Number(btn.dataset.dir)); });
      });
      // Clicking the dark area around the photo closes the viewer
      lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox || e.target.classList.contains('lightbox__figure')) lightbox.close();
      });
      lightbox.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') go(current - 1);
        if (e.key === 'ArrowRight') go(current + 1);
      });

      var lbStartX = null;
      lightbox.addEventListener('touchstart', function (e) {
        lbStartX = e.touches[0].clientX;
      }, { passive: true });
      lightbox.addEventListener('touchend', function (e) {
        if (lbStartX === null) return;
        var dx = e.changedTouches[0].clientX - lbStartX;
        if (Math.abs(dx) > 40) go(current + (dx < 0 ? 1 : -1));
        lbStartX = null;
      });
    }

    render(true);
  }

  /* --- Property film ------------------------------------------------------- */
  var play = document.querySelector('.film__play');

  if (play) {
    play.addEventListener('click', function () {
      var video = document.createElement('video');
      video.src = play.dataset.videoSrc;
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      video.addEventListener('error', function () {
        video.remove();
        play.hidden = false;
        play.querySelector('.film__caption').textContent = 'Property film coming soon';
      });
      play.hidden = true;
      play.parentNode.appendChild(video);
    });
  }

  /* --- Date field: text placeholder until focused -------------------------- */
  document.querySelectorAll('[data-date-field]').forEach(function (input) {
    input.addEventListener('focus', function () { input.type = 'date'; });
    input.addEventListener('blur', function () { if (!input.value) input.type = 'text'; });
  });

  /* --- Lead source --------------------------------------------------------- */
  // Remember how the visitor first arrived this session (external referrer and
  // landing URL with any utm_* tags) so the tour request can report it.
  var FIRST_TOUCH_KEY = 'p3b-first-touch';

  function firstTouch() {
    try {
      var saved = sessionStorage.getItem(FIRST_TOUCH_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* storage unavailable */ }

    var referrer = document.referrer;
    try {
      if (referrer && new URL(referrer).host === location.host) referrer = '';
    } catch (e) { referrer = ''; }

    var touch = { referrer: referrer, landingUrl: location.href };
    try { sessionStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(touch)); } catch (e) { /* ignore */ }
    return touch;
  }

  var arrival = firstTouch();

  /* --- Tour request form --------------------------------------------------- */
  // Posts to /api/tour-request (api/tour-request/index.js), which files the
  // lead in HubSpot with a note for the tour details and emails the agent.
  var form = document.getElementById('tour-form');

  if (form) {
    var note = form.querySelector('.form__note');
    var submit = form.querySelector('.form__submit');
    var FALLBACK = 'Something went wrong. Please call Jeanne at 214-649-4375.';

    function cookie(name) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : undefined;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var valid = true;
      form.querySelectorAll('input[required]').forEach(function (input) {
        var ok = input.checkValidity() && input.value.trim() !== '';
        input.closest('.field').classList.toggle('is-invalid', !ok);
        if (!ok && valid) { input.focus(); valid = false; }
      });
      if (!valid) {
        note.textContent = 'Please add your name and a valid email address.';
        return;
      }

      var data = {};
      new FormData(form).forEach(function (value, name) { data[name] = String(value); });
      data.hutk = cookie('hubspotutk');
      data.pageUri = location.href;
      data.pageName = document.title;
      data.referrer = arrival.referrer;
      data.landingUrl = arrival.landingUrl;

      submit.disabled = true;
      note.textContent = 'Sending…';
      fetch('/api/tour-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok || !body.ok) throw new Error(body.error || res.status);
          });
        })
        .then(function () {
          form.reset();
          form.querySelectorAll('[data-date-field]').forEach(function (input) { input.type = 'text'; });
          note.textContent = 'Thank you — Jeanne will be in touch shortly to arrange your private tour.';
        })
        .catch(function () {
          note.textContent = FALLBACK;
        })
        .then(function () { submit.disabled = false; });
    });

    form.addEventListener('input', function (e) {
      var field = e.target.closest('.field');
      if (field) field.classList.remove('is-invalid');
    });
  }
})();
