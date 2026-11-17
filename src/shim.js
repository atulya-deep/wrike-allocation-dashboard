// Minimal stand-in for the Claude dashboard runtime, so the same page code runs as a static site.
(function () {
  const files = {};          // dataset id -> rows
  const calcs = {};          // calc id -> {inputs, fn}
  const draws = [];          // [name, fn]
  const dataFns = [];
  let cache = {};
  let params = {};

  function compute(id) {
    if (id in cache) return cache[id];
    let v;
    if (files[id]) v = files[id];
    else if (calcs[id]) v = calcs[id].fn(...calcs[id].inputs.map(compute));
    else v = [];
    cache[id] = v;
    return v;
  }

  let scheduled = false;
  function render() {
    scheduled = false;
    dataFns.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    draws.forEach(([name, fn]) => {
      document.querySelectorAll(`[data-draw="${name}"]`).forEach((el) => {
        try { fn(el); } catch (e) { console.error('draw ' + name, e); }
      });
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(render); } }

  window.dash = {
    _load(datasets, defaults) {
      for (const [id, text] of Object.entries(datasets)) files[id] = d3.csvParse(text);
      params = { ...defaults };
    },
    _start() {
      render();
      let w = document.body.clientWidth;
      new ResizeObserver(() => { if (Math.abs(document.body.clientWidth - w) > 4) { w = document.body.clientWidth; schedule(); } }).observe(document.body);
    },
    data(id) {
      try { const d = compute(id); return { status: 'ok', data: d, columns: d.columns || [], refreshing: false, truncated: false }; }
      catch (e) { console.error(e); return { status: 'error', data: [], message: String(e) }; }
    },
    calc(id, o) { calcs[id] = o; },
    loader() {},
    draw(name, fn) { if (fn) draws.push([name, fn]); else schedule(); },
    onData(fn) { dataFns.push(fn); },
    params() { return { ...params }; },
    setParams(o) {
      for (const [k, v] of Object.entries(o)) { if (v === null) delete params[k]; else params[k] = v; }
      cache = {}; schedule();
    },
    resetParams() { cache = {}; schedule(); },
    refresh() {},
    setLink() {},
    colors: ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'],
  };
})();
