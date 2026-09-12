// ── Ticketdash Date Picker — standalone module ────────────────────────────────
// TDP.open(anchorEl, currentIsoStr, onConfirm)
//   currentIsoStr : stored value — always UTC ISO "YYYY-MM-DDTHH:MMZ" or ""
//   onConfirm(isoStr) : called with UTC ISO string or "" (clear)
//
// Timezone preference: localStorage 'td_tz' = "UTC" | "MTY"  (MTY = UTC-6)

const TDP = (() => {
  const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  // UTC-6 offset in minutes
  const MTY_OFFSET = -6 * 60;

  let overlay = null, popup = null;
  let _year, _month, _day, _hour, _min;
  let _tz;          // "UTC" or "MTY"
  let _onConfirm = null;
  let _anchor    = null;

  function pad(n) { return String(n).padStart(2,'0'); }

  // ── Timezone helpers ─────────────────────────────────────────────────────────
  function getTz()      { return localStorage.getItem('td_tz') || 'UTC'; }
  function setTz(tz)    { localStorage.setItem('td_tz', tz); }
  function tzOffset()   { return _tz === 'MTY' ? MTY_OFFSET : 0; } // minutes from UTC
  function tzLabel()    { return _tz === 'MTY' ? 'UTC-6 MTY' : 'UTC'; }
  function tzShort()    { return _tz === 'MTY' ? 'MTY' : 'UTC'; }

  // Convert UTC Date → local Date object in chosen tz (for display)
  function utcToLocal(d) {
    return new Date(d.getTime() + tzOffset() * 60000);
  }
  // Convert local fields back to UTC ms
  function localFieldsToUtcMs() {
    // Build a Date treating fields as UTC, then subtract the tz offset
    const localMs = Date.UTC(_year, _month, _day, _hour, _min);
    return localMs - tzOffset() * 60000;
  }

  // Parse stored ISO string (always UTC) → Date
  function parseStoredUtc(s) {
    if (!s) return null;
    // "YYYY-MM-DDTHH:MMZ" or "YYYY-MM-DDTHH:MM" (treat bare as UTC)
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]));
    return null;
  }

  // ── Open ──────────────────────────────────────────────────────────────────────
  function open(anchorEl, currentVal, onConfirm) {
    close();
    _anchor    = anchorEl;
    _onConfirm = onConfirm;
    _tz        = localStorage.getItem('td_tz') || 'UTC';

    const nowUtc = new Date();
    let initUtc  = parseStoredUtc(currentVal);
    if (!initUtc) initUtc = nowUtc;

    // Display in chosen timezone
    const initLocal = utcToLocal(initUtc);
    _year  = initLocal.getUTCFullYear();
    _month = initLocal.getUTCMonth();
    _day   = initLocal.getUTCDate();
    _hour  = initLocal.getUTCHours();
    _min   = initLocal.getUTCMinutes();

    overlay = document.createElement('div');
    overlay.className = 'tdp-overlay';
    overlay.addEventListener('click', () => close());

    popup = document.createElement('div');
    popup.className = 'tdp-popup';
    popup.addEventListener('click', e => e.stopPropagation());

    document.body.appendChild(overlay);
    document.body.appendChild(popup);

    render();
    position();
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    if (popup)   { popup.remove();   popup   = null; }
  }

  function confirm() {
    const utcMs  = localFieldsToUtcMs();
    const utcD   = new Date(utcMs);
    const iso    = `${utcD.getUTCFullYear()}-${pad(utcD.getUTCMonth()+1)}-${pad(utcD.getUTCDate())}T${pad(utcD.getUTCHours())}:${pad(utcD.getUTCMinutes())}Z`;
    _onConfirm(iso);
    close();
  }

  function clearDate() { _onConfirm(''); close(); }

  // ── Render ────────────────────────────────────────────────────────────────────
  function render() {
    if (!popup) return;
    popup.innerHTML = '';

    // ── Month header ──
    const hdr = document.createElement('div');
    hdr.className = 'tdp-header';

    const prev = document.createElement('button');
    prev.className = 'tdp-nav'; prev.textContent = '‹';
    prev.addEventListener('click', () => {
      _month--; if (_month < 0) { _month = 11; _year--; } render();
    });

    const lbl = document.createElement('span');
    lbl.className = 'tdp-month-label';
    lbl.textContent = `${MONTHS[_month]} ${_year}`;

    const next = document.createElement('button');
    next.className = 'tdp-nav'; next.textContent = '›';
    next.addEventListener('click', () => {
      _month++; if (_month > 11) { _month = 0; _year++; } render();
    });

    hdr.appendChild(prev); hdr.appendChild(lbl); hdr.appendChild(next);
    popup.appendChild(hdr);

    // ── Weekday row ──
    const wds = document.createElement('div');
    wds.className = 'tdp-weekdays';
    DAYS.forEach(d => {
      const wd = document.createElement('div');
      wd.className = 'tdp-wd'; wd.textContent = d;
      wds.appendChild(wd);
    });
    popup.appendChild(wds);

    // ── Day grid ──
    const grid = document.createElement('div');
    grid.className = 'tdp-days';

    // "today" in chosen tz
    const nowLocal = utcToLocal(new Date());
    const todayD = nowLocal.getUTCDate(), todayM = nowLocal.getUTCMonth(), todayY = nowLocal.getUTCFullYear();

    const firstDow    = new Date(_year, _month, 1).getDay();
    const daysInMonth = new Date(_year, _month + 1, 0).getDate();

    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div');
      e.className = 'tdp-day tdp-day-empty';
      grid.appendChild(e);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      cell.className = 'tdp-day';
      cell.textContent = d;
      if (d === todayD && _month === todayM && _year === todayY) cell.classList.add('tdp-day-today');
      if (d === _day) cell.classList.add('tdp-day-selected');
      cell.addEventListener('click', () => { _day = d; render(); });
      grid.appendChild(cell);
    }
    popup.appendChild(grid);
    popup.appendChild(makeSep());

    // ── Time row ──
    const timeRow = document.createElement('div');
    timeRow.className = 'tdp-time';

    // TZ toggle pill
    const tzToggle = document.createElement('button');
    tzToggle.className = 'tdp-tz-toggle';
    tzToggle.title = 'Switch timezone';
    tzToggle.textContent = _tz === 'MTY' ? 'UTC-6' : 'UTC';
    tzToggle.addEventListener('click', () => {
      // Convert current local fields to UTC ms, then re-display in new tz
      const utcMs = localFieldsToUtcMs();
      _tz = _tz === 'MTY' ? 'UTC' : 'MTY';
      setTz(_tz);
      const newLocal = utcToLocal(new Date(utcMs));
      _year  = newLocal.getUTCFullYear();
      _month = newLocal.getUTCMonth();
      _day   = newLocal.getUTCDate();
      _hour  = newLocal.getUTCHours();
      _min   = newLocal.getUTCMinutes();
      render();
    });
    timeRow.appendChild(tzToggle);

    timeRow.appendChild(makeSpinner(
      () => _hour,
      v  => { _hour = ((v % 24) + 24) % 24; render(); },
      1, 0, 23, 'HH'
    ));

    const colon = document.createElement('span');
    colon.className = 'tdp-time-colon'; colon.textContent = ':';
    timeRow.appendChild(colon);

    timeRow.appendChild(makeSpinner(
      () => _min,
      v  => { _min = ((v % 60) + 60) % 60; render(); },
      5, 0, 59, 'MM'
    ));

    // Live UTC preview when in MTY mode
    if (_tz === 'MTY') {
      const utcMs  = localFieldsToUtcMs();
      const utcD   = new Date(utcMs);
      const utcStr = `${pad(utcD.getUTCHours())}:${pad(utcD.getUTCMinutes())} UTC`;
      const preview = document.createElement('span');
      preview.className = 'tdp-utc-preview';
      preview.textContent = `= ${utcStr}`;
      timeRow.appendChild(preview);
    }

    popup.appendChild(timeRow);

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = 'tdp-footer';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tdp-btn tdp-btn-clear'; clearBtn.textContent = '✕ Clear';
    clearBtn.addEventListener('click', clearDate);

    const okBtn = document.createElement('button');
    okBtn.className = 'tdp-btn tdp-btn-ok';
    okBtn.textContent = '✓ Set';
    okBtn.addEventListener('click', confirm);

    footer.appendChild(clearBtn); footer.appendChild(okBtn);
    popup.appendChild(footer);
  }

  // ── Spinner with keyboard input ───────────────────────────────────────────────
  function makeSpinner(getVal, setVal, step, min, max, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'tdp-spinner';

    const up = document.createElement('button');
    up.className = 'tdp-spin-btn'; up.textContent = '▲';
    up.addEventListener('click', () => setVal(getVal() + step));

    // Editable input (not a div)
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'tdp-spin-val';
    inp.value = pad(getVal());
    inp.maxLength = 2;
    inp.placeholder = placeholder || '00';

    // Select all on focus for quick overwrite
    inp.addEventListener('focus', () => inp.select());

    // Live: only allow digits
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 2);
    });

    // Commit on Enter or blur
    function commit() {
      let v = parseInt(inp.value, 10);
      if (isNaN(v)) v = getVal();
      setVal(v); // setVal already wraps the value
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')     { e.preventDefault(); commit(); inp.blur(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setVal(getVal() + step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setVal(getVal() - step); }
    });

    // Scroll wheel
    inp.addEventListener('wheel', e => {
      e.preventDefault();
      setVal(getVal() + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    const down = document.createElement('button');
    down.className = 'tdp-spin-btn'; down.textContent = '▼';
    down.addEventListener('click', () => setVal(getVal() - step));

    wrap.appendChild(up); wrap.appendChild(inp); wrap.appendChild(down);
    return wrap;
  }

  function makeSep() {
    const hr = document.createElement('hr'); hr.className = 'tdp-sep'; return hr;
  }

  function position() {
    if (!popup || !_anchor) return;
    const rect = _anchor.getBoundingClientRect();
    const pw = popup.offsetWidth || 268;
    const ph = popup.offsetHeight || 400;
    let top  = rect.bottom + 4;
    let left = rect.left;
    if (left + pw > window.innerWidth  - 8) left = window.innerWidth  - pw - 8;
    if (left < 8)  left = 8;
    if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 4;
    if (top  < 8)  top  = 8;
    popup.style.top  = `${top}px`;
    popup.style.left = `${left}px`;
  }

  return { open, close, getTz };
})();
