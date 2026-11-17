(function(){

const N = (v) => (v === null || v === undefined || v === '' ? null : +v);
const ASOF = window.ASOF || new Date().toISOString().slice(0, 10);
const _m = (k) => d3.utcMonth.offset(new Date(ASOF.slice(0, 7) + '-01T00:00:00Z'), k).toISOString().slice(0, 7);
const CUR = _m(0), PREV = _m(-1), PREV2 = _m(-2);
const MONTHS3 = [PREV2, PREV, CUR];
const WEEK0 = d3.utcMonday.floor(new Date(ASOF + 'T00:00:00Z'));
window.ASOF = ASOF; window.CUR = CUR; window.PREV = PREV; window.PREV2 = PREV2; window.WEEK0 = WEEK0;
window.MONTHS3 = MONTHS3;
const r2 = (x) => Math.round(x * 100) / 100;

dash.calc('logs_all', {
  title: 'Time logs in the current region and account',
  description: 'Monthly time logs joined to their project, account and region, kept to the region and account picked at the top (all teams).',
  inputs: ['monthly', 'projects'],
  fn: (monthly, projects) => {
    const pr = new Map(projects.map((p) => [p.po_id, p]));
    const { region = '', account = '' } = dash.params();
    return monthly.map((r) => { const p = pr.get(r.po_id) || {}; return { ...r, hours: +r.hours, project: p.project, account: p.account, region: p.region }; })
      .filter((r) => (!region || r.region === region) && (!account || r.account === account));
  },
});

dash.calc('logs', {
  title: 'Time logs in the current filter',
  description: 'The time logs above, tagged with each person\'s Wrike team and kept to the team picked at the top.',
  inputs: ['logs_all', 'teams'],
  fn: (logs, teams) => {
    const tm = new Map(teams.map((t) => [t.person, t.team]));
    const team = dash.params().team || '';
    return logs.map((r) => ({ ...r, team: tm.get(r.person) || 'Other' })).filter((r) => !team || r.team === team);
  },
});

dash.calc('po_summary', {
  title: 'Budget and burn by PO',
  description: 'Each PO\'s Wrike budget fields beside the hours logged on it and its use cases, in the current filter.',
  inputs: ['projects', 'logs_all', 'logs'],
  fn: (projects, logs, teamLogs) => {
    const { region = '', account = '', team = '' } = dash.params();
    const by = d3.group(logs, (r) => r.po_id);
    const th = d3.rollup(teamLogs, (v) => d3.sum(v, (r) => r.hours), (r) => r.po_id);
    return projects.filter((p) => (!region || p.region === region) && (!account || p.account === account)).map((p) => {
      const rows = by.get(p.po_id) || [];
      const logged = d3.sum(rows, (r) => r.hours);
      const bh = N(p.budget_hours), be = N(p.budget_eur);
      const months = rows.map((r) => r.month).sort();
      let flag = '';
      if (!/^\W*PO$/.test(p.item_type)) flag = '';
      else if (bh === null || bh === 0) flag = 'No hours budget in Wrike';
      else if (bh < 50 && be !== null && be > 10000) flag = 'Hours budget looks incomplete';
      else if (logged > bh) flag = 'Over hours budget';
      return {
        po_id: p.po_id, project: p.project, account: p.account, region: p.region, item_type: p.item_type, status: p.status,
        po_type: p.po_type || (!/^\W*PO$/.test(p.item_type) ? p.item_type.replace(/^\W+/, '') : ''), budget_eur: be, current_budget_eur: N(p.current_budget_eur), budget_hours: bh,
        logged_hours: r2(logged), team_hours: r2(th.get(p.po_id) || 0), billable_hours: r2(d3.sum(rows.filter((r) => r.billable === 'Billable'), (r) => r.hours)),
        burn_pct: bh ? Math.round((logged / bh) * 1000) / 10 : null,
        eur_per_hour: be && logged ? Math.round(be / logged) : null,
        people: new Set(rows.map((r) => r.person)).size,
        hours_3m: r2(d3.sum(rows.filter((r) => MONTHS3.includes(r.month)), (r) => r.hours)),
        first_month: months[0] || null, last_month: months[months.length - 1] || null,
        flag, link: p.wrike_link,
      };
    }).filter((r) => (team ? r.team_hours > 0 : (r.logged_hours > 0 || r.budget_eur))).sort((a, b) => (team ? b.team_hours - a.team_hours : b.logged_hours - a.logged_hours));
  },
});

dash.calc('kpis', {
  title: 'Headline figures',
  description: 'Totals over the time logs in the current filter, monthly comparison and PO budget counts.',
  inputs: ['logs', 'po_summary'],
  fn: (logs, pos) => {
    const tot = d3.sum(logs, (r) => r.hours);
    const bill = d3.sum(logs.filter((r) => r.billable === 'Billable'), (r) => r.hours);
    const m = (k) => d3.sum(logs.filter((r) => r.month === k), (r) => r.hours);
    const budgeted = pos.filter((p) => p.budget_hours && p.flag !== 'Hours budget looks incomplete');
    const accs = d3.rollups(logs, (v) => d3.sum(v, (r) => r.hours), (r) => r.account).sort((a, b) => b[1] - a[1]);
    return [{
      total_hours: Math.round(tot), billable_pct: tot ? Math.round((bill / tot) * 1000) / 10 : null,
      people_3m: new Set(logs.filter((r) => MONTHS3.includes(r.month)).map((r) => r.person)).size,
      hours_oct: Math.round(m(PREV)), hours_sep: Math.round(m(PREV2)),
      oct_vs_sep_pct: m(PREV2) ? Math.round(((m(PREV) - m(PREV2)) / m(PREV2)) * 1000) / 10 : null,
      pos_budgeted: budgeted.length, pos_over: budgeted.filter((p) => p.logged_hours > p.budget_hours).length,
      accounts: accs.length, top_account: accs[0] ? accs[0][0] : '', top_account_hours: accs[0] ? Math.round(accs[0][1]) : 0,
      top_project: pos[0] ? pos[0].project : '', top_project_hours: pos[0] ? Math.round(pos[0].logged_hours) : 0,
    }];
  },
});

const rollPos = (ps, logs, keyFn) => {
  const b = ps.filter((p) => p.budget_hours && p.flag !== 'Hours budget looks incomplete');
  const bh = d3.sum(b, (p) => p.budget_hours), lb = d3.sum(b, (p) => p.logged_hours);
  return { projects: ps.length, budget_eur: d3.sum(ps, (p) => p.budget_eur || 0), budget_hours: bh, logged_budgeted: r2(lb),
    burn_pct: bh ? Math.round((lb / bh) * 1000) / 10 : null, logged_hours: r2(d3.sum(ps, (p) => p.logged_hours)), team_hours: r2(d3.sum(ps, (p) => p.team_hours)),
    people: new Set(logs.filter(keyFn).map((r) => r.person)).size };
};
window.rollPos = rollPos;

dash.calc('region_summary', {
  title: 'Budget and burn by region',
  description: 'PO summary rolled up by Celonis Region.',
  inputs: ['po_summary', 'logs'],
  fn: (pos, logs) => d3.groups(pos, (p) => p.region).map(([region, ps]) => ({ region, ...rollPos(ps, logs, (r) => r.region === region) }))
    .sort((a, b) => b.team_hours - a.team_hours),
});

dash.calc('account_summary', {
  title: 'Budget and burn by account',
  description: 'PO summary rolled up by client account.',
  inputs: ['po_summary', 'logs'],
  fn: (pos, logs) => d3.groups(pos, (p) => p.account).map(([account, ps]) => ({ account, region: ps[0].region, ...rollPos(ps, logs, (r) => r.account === account) }))
    .sort((a, b) => b.team_hours - a.team_hours),
});

dash.calc('usecase_summary', {
  title: 'Hours by use case',
  description: 'Hours per use case (sub-project) and their share of the parent PO, for the project picked above the table.',
  inputs: ['logs'],
  fn: (logs) => {
    const pick = dash.params().uc_po || '';
    const poTot = d3.rollup(logs, (v) => d3.sum(v, (r) => r.hours), (r) => r.po_id);
    const rows = logs.filter((r) => !pick || r.po_id === pick);
    return d3.groups(rows, (r) => r.po_id + ' › ' + r.use_case).map(([k, v]) => {
      const ms = v.map((r) => r.month).sort(); const h = d3.sum(v, (r) => r.hours);
      return { uc_key: k, po_id: v[0].po_id, project: v[0].project, account: v[0].account, use_case: v[0].use_case, hours: r2(h),
        share_of_po: Math.round((h / poTot.get(v[0].po_id)) * 1000) / 10,
        hours_3m: r2(d3.sum(v.filter((r) => MONTHS3.includes(r.month)), (r) => r.hours)),
        people: new Set(v.map((r) => r.person)).size, first_month: ms[0], last_month: ms[ms.length - 1] };
    }).filter((r) => r.hours >= 1).sort((a, b) => b.hours - a.hours).slice(0, 300);
  },
});

dash.calc('month_project', {
  title: 'Monthly hours by account or project',
  description: 'Hours per month for the 7 largest accounts (or, with one account picked, its 7 largest projects); the rest grouped as Other.',
  inputs: ['logs'],
  fn: (logs) => {
    const key = dash.params().account ? (r) => r.project : (r) => r.account;
    const top = d3.rollups(logs, (v) => d3.sum(v, (r) => r.hours), key).sort((a, b) => b[1] - a[1]).slice(0, 7).map((d) => d[0]);
    return d3.rollups(logs, (v) => d3.sum(v, (r) => r.hours), (r) => r.month, (r) => (top.includes(key(r)) ? key(r) : 'Other'))
      .flatMap(([month, g]) => g.map(([series, hours]) => ({ month, series, hours: r2(hours), rank: series === 'Other' ? 99 : top.indexOf(series) })));
  },
});

dash.calc('person_util', {
  title: 'Utilisation by person and month',
  description: 'Hours a person logged in the current filter in a month ÷ that month\'s working-day capacity.',
  inputs: ['logs', 'calendar'],
  fn: (logs, calendar) => {
    const cap = new Map(calendar.map((c) => [c.month, +c.capacity_hours]));
    return d3.rollups(logs.filter((r) => cap.get(r.month) > 0), (v) => d3.sum(v, (r) => r.hours), (r) => r.person, (r) => r.month)
      .flatMap(([person, g]) => g.map(([month, h]) => ({ key: person + '|' + month, person, month, hours: r2(h),
        capacity: cap.get(month), util_pct: Math.round((h / cap.get(month)) * 1000) / 10 })));
  },
});

const pickPo = (pos) => { const id = dash.params().po; return pos.some((p) => p.po_id === id) ? id : (pos[0] ? pos[0].po_id : null); };
window.pickPo = pickPo;

dash.calc('drill_head', {
  title: 'Selected project summary',
  description: 'Budget and burn for the project picked in the project dashboard.',
  inputs: ['po_summary'],
  fn: (pos) => { const id = pickPo(pos); const r = pos.find((p) => p.po_id === id); return r ? [r] : []; },
});

dash.calc('drill_people', {
  title: 'People on the selected project',
  description: 'Hours per person on the picked project, overall and recently.',
  inputs: ['po_summary', 'logs'],
  fn: (pos, logs) => {
    const id = pickPo(pos); const rows = logs.filter((r) => r.po_id === id);
    const tot = d3.sum(rows, (r) => r.hours);
    return d3.groups(rows, (r) => r.person).map(([person, v]) => {
      const h = d3.sum(v, (r) => r.hours); const ms = v.map((r) => r.month).sort();
      return { person, team: v[0].team, hours: r2(h), share_pct: Math.round((h / tot) * 1000) / 10,
        hours_3m: r2(d3.sum(v.filter((r) => MONTHS3.includes(r.month)), (r) => r.hours)),
        hours_nov: r2(d3.sum(v.filter((r) => r.month === CUR), (r) => r.hours)),
        billable_pct: Math.round((d3.sum(v.filter((r) => r.billable === 'Billable'), (r) => r.hours) / h) * 1000) / 10,
        last_month: ms[ms.length - 1] };
    }).sort((a, b) => b.hours_3m - a.hours_3m || b.hours - a.hours);
  },
});

dash.calc('drill_months', {
  title: 'Selected project hours by month and person',
  description: 'Monthly hours per person on the picked project.',
  inputs: ['po_summary', 'logs'],
  fn: (pos, logs) => {
    const id = pickPo(pos);
    return d3.rollups(logs.filter((r) => r.po_id === id), (v) => d3.sum(v, (r) => r.hours), (r) => r.month, (r) => r.person)
      .flatMap(([month, g]) => g.map(([person, hours]) => ({ month, person, hours: r2(hours) })));
  },
});

dash.calc('drill_weekly', {
  title: 'Selected project hours by week and person',
  description: 'Weekly hours per person on the picked project, last 12 weeks up to the refresh date.',
  inputs: ['po_summary', 'weekly', 'teams'],
  fn: (pos, weekly, teams) => {
    const id = pickPo(pos); const team = dash.params().team || '';
    const tm = new Map(teams.map((t) => [t.person, t.team])); weekly = weekly.filter((r) => !team || (tm.get(r.person) || 'Other') === team);
    const weeks = d3.utcMondays(d3.utcDay.offset(WEEK0, -77), d3.utcDay.offset(WEEK0, 1)).map((d) => d.toISOString().slice(0, 10));
    return d3.rollups(weekly.filter((r) => r.po_id === id && weeks.includes(r.week)), (v) => d3.sum(v, (r) => +r.hours), (r) => r.person, (r) => r.week)
      .flatMap(([person, g]) => g.map(([week, hours]) => ({ key: person + '|' + week, person, week, hours: r2(hours) })));
  },
});

dash.calc('drill_tasks', {
  title: 'Selected project hours by task',
  description: 'Hours per Wrike task on the picked project.',
  inputs: ['po_summary', 'tasks', 'teams'],
  fn: (pos, tasks, teams) => {
    const id = pickPo(pos); const team = dash.params().team || '';
    const tm = new Map(teams.map((t) => [t.person, t.team])); tasks = tasks.filter((r) => !team || (tm.get(r.person) || 'Other') === team);
    return d3.groups(tasks.filter((r) => r.po_id === id), (r) => r.use_case + ' › ' + r.task).map(([k, v]) => {
      const byP = d3.rollups(v, (x) => d3.sum(x, (r) => +r.hours), (r) => r.person).sort((a, b) => b[1] - a[1]);
      return { task_key: k, use_case: v[0].use_case, task: v[0].task, hours: r2(d3.sum(v, (r) => +r.hours)),
        hours_3m: r2(d3.sum(v.filter((r) => MONTHS3.includes(r.month)), (r) => +r.hours)),
        people: byP.length, top_person: byP[0][0] };
    }).sort((a, b) => b.hours - a.hours);
  },
});

dash.calc('filter_options', {
  title: 'Regions and accounts',
  description: 'Regions and accounts that have logged hours, for the filters at the top.',
  inputs: ['monthly', 'projects'],
  fn: (monthly, projects) => {
    const h = d3.rollup(monthly, (v) => d3.sum(v, (r) => +r.hours), (r) => r.po_id);
    return d3.rollups(projects, (v) => d3.sum(v, (p) => h.get(p.po_id) || 0), (p) => p.region, (p) => p.account)
      .flatMap(([region, g]) => g.map(([account, hours]) => ({ key: region + '|' + account, region, account, hours: r2(hours) })))
      .filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours);
  },
});

})();
;
(function(){

const MONTHS3 = window.MONTHS3; const pickPo = window.pickPo; const CUR = window.CUR; const WEEK0 = window.WEEK0;
const _ml = (k, f) => d3.utcFormat(f)(new Date(k + '-01T00:00:00Z'));
document.querySelectorAll('.lbl-asof').forEach((e) => { e.textContent = d3.utcFormat('%d %b %Y')(new Date(window.ASOF + 'T00:00:00Z')); });
document.querySelectorAll('.lbl-3m').forEach((e) => { e.textContent = `${_ml(MONTHS3[0], '%b')} – ${_ml(CUR, '%b %Y')}`; });
document.querySelectorAll('.lbl-3m-short').forEach((e) => { e.textContent = `${_ml(MONTHS3[0], '%b')}–${_ml(CUR, '%b')}`; });
document.querySelectorAll('.lbl-prev').forEach((e) => { e.textContent = _ml(window.PREV, '%B'); });
document.querySelectorAll('.lbl-prev2').forEach((e) => { e.textContent = _ml(window.PREV2, '%B'); });
document.querySelectorAll('.lbl-cur').forEach((e) => { e.textContent = _ml(CUR, '%b'); });
const fN = d3.format(',.0f'), fE = (v) => (v === null || v === undefined ? '' : '€' + d3.format(',.0f')(v));
const fP = (v) => (v === null || v === undefined ? '' : d3.format(',.0f')(v) + '%');
const fM = (m) => (m ? d3.utcFormat('%b %Y')(new Date(m + '-01T00:00:00Z')) : '');
const burnClass = (p) => (p === null || p === undefined ? '' : p > 100 ? 'bad' : p >= 80 ? 'warn' : 'ok');
const burnColor = (p) => (p > 100 ? 'var(--cds-chart-status-critical)' : p >= 80 ? 'var(--color-warn)' : 'var(--color-ok)');
const ok = (id) => dash.data(id).status === 'ok';
window.wdTip = (host) => {
  let t = host.querySelector(':scope > .tip');
  if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; host.appendChild(t); }
  return {
    show(ev, lines) {
      t.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); if (i) d.className = 's'; d.textContent = l; return d; }));
      t.hidden = false; const r = host.getBoundingClientRect();
      let x = ev.clientX - r.left + 12, y = ev.clientY - r.top + 12;
      if (x + t.offsetWidth > host.clientWidth) x = Math.max(0, ev.clientX - r.left - t.offsetWidth - 12);
      t.style.left = x + 'px'; t.style.top = y + 'px';
    },
    hide() { t.hidden = true; },
  };
};


dash.draw('f_region', (sel) => {
  const d = dash.data('filter_options');
  const regs = d.status === 'ok' ? d3.rollups(d.data, (v) => d3.sum(v, (r) => r.hours), (r) => r.region).sort((a, b) => b[1] - a[1]).map((x) => x[0]) : [];
  sel.replaceChildren(new Option('All regions', ''), ...regs.map((r) => new Option(r, r)));
  sel.value = dash.params().region || '';
  sel.onchange = () => dash.setParams({ region: sel.value, account: '', uc_po: '' });
});
dash.draw('f_account', (sel) => {
  const d = dash.data('filter_options'); const reg = dash.params().region || '';
  const accs = d.status === 'ok' ? d.data.filter((r) => !reg || r.region === reg).map((r) => r.account) : [];
  sel.replaceChildren(new Option('All accounts', ''), ...[...new Set(accs)].map((a) => new Option(a, a)));
  sel.value = dash.params().account || '';
  sel.onchange = () => dash.setParams({ account: sel.value, uc_po: '' });
});

dash.draw('f_team', (sel) => {
  const d = dash.data('teams');
  const order = ['India', 'LATAM', 'EUR', 'Other', 'Former staff'];
  const teams = d.status === 'ok' ? [...new Set([...d.data.map((r) => r.team), 'Other'])].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99) : [];
  sel.replaceChildren(new Option('All teams', ''), ...teams.map((t) => new Option(t === 'India' ? 'India team' : t === 'LATAM' ? 'LATAM team' : t === 'EUR' ? 'EUR team' : t, t)));
  sel.value = dash.params().team || '';
  sel.onchange = () => dash.setParams({ team: sel.value });
});

const one = (id, field, fmt) => (el) => {
  const d = dash.data(id);
  el.classList.toggle('dash-skeleton', d.status === 'loading');
  el.textContent = d.status === 'ok' && d.data[0] && d.data[0][field] !== null && d.data[0][field] !== undefined ? fmt(d.data[0][field]) : '—';
};
dash.draw('k_total', one('kpis', 'total_hours', fN));
dash.draw('k_bill', one('kpis', 'billable_pct', (v) => d3.format('.1f')(v) + '%'));
dash.draw('k_people', one('kpis', 'people_3m', fN));
dash.draw('k_oct', one('kpis', 'hours_oct', fN));
dash.draw('k_oct_chg', one('kpis', 'oct_vs_sep_pct', (v) => (v > 0 ? '+' : '') + d3.format('.1f')(v) + '%'));
dash.draw('k_over', one('kpis', 'pos_over', fN));
dash.draw('k_budgeted', one('kpis', 'pos_budgeted', fN));

dash.draw('lede', (el) => {
  const k = dash.data('kpis');
  if (k.status !== 'ok' || !k.data[0]) { el.textContent = ''; return; }
  const r = k.data[0];
  el.textContent = r.total_hours ? `${fN(r.total_hours)} hours are logged across ${fN(r.accounts)} account${r.accounts === 1 ? '' : 's'} in this view. ${r.top_account} carries the most (${fN(r.top_account_hours)} h), and ${r.pos_over} of the ${r.pos_budgeted} POs with a usable hours budget have already logged more than it.` : 'No time is logged in this view.';
});

dash.draw('po_table', (tb) => {
  const d = dash.data('po_summary');
  if (d.status !== 'ok') { tb.replaceChildren(); return; }
  tb.replaceChildren(...d.data.map((r) => {
    const tr = document.createElement('tr'); tr.dataset.key = r.po_id;
    const td = (txt, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = txt; tr.appendChild(c); return c; };
    const a = document.createElement('a'); a.href = r.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = r.project;
    const c0 = document.createElement('td'); if (r.link) c0.appendChild(a); else c0.textContent = r.project; tr.appendChild(c0);
    td(r.account); td(r.status); td(r.po_type); td(fE(r.budget_eur), 'n'); td(fE(r.current_budget_eur), 'n');
    td(r.budget_hours ? fN(r.budget_hours) : '', 'n'); td(fN(r.logged_hours), 'n'); td(fN(r.team_hours), 'n');
    const cb = document.createElement('td');
    if (r.burn_pct !== null && r.flag !== 'Hours budget looks incomplete') {
      const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:8px';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.flex = '1';
      const i = document.createElement('i'); i.style.width = Math.min(r.burn_pct, 200) / 2 + '%'; i.style.background = burnColor(r.burn_pct);
      const b = document.createElement('b'); b.style.left = '50%'; bar.append(i, b);
      const s = document.createElement('span'); s.className = burnClass(r.burn_pct); s.textContent = fP(r.burn_pct); s.style.minWidth = '48px'; s.style.textAlign = 'right';
      wrap.append(bar, s); cb.appendChild(wrap);
    } else if (r.burn_pct !== null) { cb.textContent = fP(r.burn_pct); cb.style.color = 'var(--color-fg-muted)'; }
    tr.appendChild(cb);
    td(r.eur_per_hour ? '€' + fN(r.eur_per_hour) : '', 'n'); td(fN(r.people), 'n'); td(fN(r.hours_3m), 'n');
    td(r.flag === 'Over hours budget' ? '' : r.flag, 'flag');
    return tr;
  }));
});

const simpleTable = (id, cols) => (tb) => {
  const d = dash.data(id);
  if (d.status !== 'ok') { tb.replaceChildren(); return; }
  const key = tb.closest('table').dataset.rowKey;
  tb.replaceChildren(...d.data.map((r) => {
    const tr = document.createElement('tr'); tr.dataset.key = r[key];
    cols.forEach(([f, fmt, cls]) => { const c = document.createElement('td'); if (cls) c.className = cls; const v = fmt ? fmt(r[f], r) : r[f]; c.textContent = v === null || v === undefined ? '' : v; if (f === 'burn_pct' && burnClass(r[f])) c.classList.add(burnClass(r[f])); tr.appendChild(c); });
    return tr;
  }));
};
dash.draw('region_table', simpleTable('region_summary', [['region'], ['projects', fN, 'n'], ['budget_eur', fE, 'n'], ['budget_hours', fN, 'n'], ['logged_budgeted', fN, 'n'], ['burn_pct', fP, 'n'], ['logged_hours', fN, 'n'], ['team_hours', fN, 'n'], ['people', fN, 'n']]));
dash.draw('account_table', simpleTable('account_summary', [['account'], ['region'], ['projects', fN, 'n'], ['budget_eur', fE, 'n'], ['burn_pct', fP, 'n'], ['logged_hours', fN, 'n'], ['team_hours', fN, 'n'], ['people', fN, 'n']]));

dash.draw('uc_select', (sel) => {
  const d = dash.data('po_summary');
  const opts = d.status === 'ok' ? d.data.filter((p) => p.logged_hours > 0).map((p) => new Option(`${p.project} (${p.account})`, p.po_id)) : [];
  sel.replaceChildren(new Option('All projects', ''), ...opts);
  sel.value = dash.params().uc_po || '';
  sel.onchange = () => dash.setParams({ uc_po: sel.value || '' });
});
dash.draw('uc_table', (tb) => {
  const d = dash.data('usecase_summary');
  if (d.status !== 'ok') { tb.replaceChildren(); return; }
  tb.replaceChildren(...d.data.map((r) => {
    const tr = document.createElement('tr'); tr.dataset.key = r.uc_key;
    const td = (txt, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = txt; tr.appendChild(c); return c; };
    td(`${r.project} (${r.account})`); td(r.use_case); td(fN(r.hours), 'n');
    const c = document.createElement('td'); const w = document.createElement('div'); w.style.cssText = 'display:flex;align-items:center;gap:8px';
    const bar = document.createElement('div'); bar.className = 'bar'; bar.style.flex = '1'; const i = document.createElement('i'); i.style.width = r.share_of_po + '%'; i.style.background = dash.colors[0]; bar.appendChild(i);
    const s = document.createElement('span'); s.textContent = fP(r.share_of_po); s.style.minWidth = '40px'; s.style.textAlign = 'right';
    w.append(bar, s); c.appendChild(w); tr.appendChild(c);
    td(fN(r.hours_3m), 'n'); td(fN(r.people), 'n'); td(fM(r.first_month)); td(fM(r.last_month));
    return tr;
  }));
});

// stacked monthly bars (generic)
window.wdStack = (el, rows, keyField, months, order, unitLabel) => {
  el.replaceChildren();
  const W = el.clientWidth || 600, H = 260, m = { t: 8, r: 8, b: 26, l: 44 };
  const keys = order; const color = (k) => (k === 'Other' ? 'var(--cds-chart-muted)' : dash.colors[keys.indexOf(k) % dash.colors.length]);
  const byM = new Map(months.map((mm) => [mm, Object.fromEntries(keys.map((k) => [k, 0]))]));
  rows.forEach((r) => { const o = byM.get(r.month); if (o && r[keyField] in o) o[r[keyField]] += r.hours; });
  const data = months.map((mm) => ({ month: mm, ...byM.get(mm) }));
  const series = d3.stack().keys(keys)(data);
  const x = d3.scaleBand().domain(months).range([m.l, W - m.r]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d3.sum(keys, (k) => d[k])) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('height', H).attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Stacked bar chart of hours per month');
  const grid = svg.append('g'); y.ticks(5).forEach((t) => grid.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(t)).attr('y2', y(t)).style('stroke', 'var(--cds-chart-grid)'));
  const ya = svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('~s')).tickSize(0)); ya.select('.domain').remove();
  const every = Math.ceil(months.length / Math.max(1, Math.floor((W - m.l) / 60)));
  const xa = svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(months.filter((_, i) => i % every === 0)).tickFormat((mm) => d3.utcFormat('%b %y')(new Date(mm + '-01T00:00:00Z'))).tickSize(0));
  xa.select('.domain').style('stroke', 'var(--cds-chart-axis)'); xa.selectAll('text').attr('dy', '1em');
  const tip = wdTip(el);
  svg.append('g').selectAll('g').data(series).join('g').style('fill', (s) => color(s.key)).selectAll('rect').data((s) => s.map((d) => ((d.key = s.key), d))).join('rect')
    .attr('x', (d) => x(d.data.month)).attr('width', x.bandwidth()).attr('y', (d) => y(d[1])).attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])))
    .on('pointermove', (ev, d) => tip.show(ev, [`${d.key}: ${fN(d[1] - d[0])} h`, `${fM(d.data.month)} · total ${fN(d3.sum(keys, (k) => d.data[k]))} h`]))
    .on('pointerleave', () => tip.hide());
  const lg = document.createElement('div'); lg.className = 'legend';
  keys.forEach((k) => { const s = document.createElement('span'); const i = document.createElement('i'); i.style.background = color(k); s.append(i, document.createTextNode(k)); lg.appendChild(s); });
  el.appendChild(lg);
};

dash.draw('trend', (el) => {
  const d = dash.data('month_project');
  if (d.status !== 'ok') { el.replaceChildren(); el.textContent = d.status === 'error' ? 'Failed to load' : ''; return; }
  const _all = d.data.map((r) => r.month).sort(); const months = d3.utcMonths(new Date(_all[0] + '-01T00:00:00Z'), d3.utcMonth.offset(new Date(CUR + '-01T00:00:00Z'), 1)).map((x) => x.toISOString().slice(0, 7));
  const order = [...new Map(d.data.slice().sort((a, b) => a.rank - b.rank).map((r) => [r.series, 1])).keys()];
  wdStack(el, d.data, 'series', months, order);
});
dash.draw('trend_hint', (el) => { el.textContent = dash.params().account ? 'Top 7 projects of this account by hours; the rest are grouped.' : 'Top 7 accounts by hours; the rest are grouped.'; });

// Drilldown
dash.draw('drill_select', (sel) => {
  const d = dash.data('po_summary');
  const opts = d.status === 'ok' ? d.data.filter((p) => p.logged_hours > 0).map((p) => new Option(`${p.project} (${p.account})`, p.po_id)) : [];
  sel.replaceChildren(...opts);
  sel.value = d.status === 'ok' ? (pickPo(d.data) || '') : '';
  sel.onchange = () => dash.setParams({ po: sel.value });
});
dash.draw('drill_link', (a) => { const d = dash.data('drill_head'); a.href = d.status === 'ok' && d.data[0] ? d.data[0].link : '#'; a.textContent = 'Open in Wrike ↗'; });
dash.draw('d_budget', one('drill_head', 'budget_eur', fE));
dash.draw('d_type', (el) => { const d = dash.data('drill_head'); el.textContent = d.status === 'ok' && d.data[0] ? [d.data[0].po_type || 'No PO type', d.data[0].status].join(' · ') : '—'; });
dash.draw('d_logged', one('drill_head', 'logged_hours', fN));
dash.draw('d_bhrs', one('drill_head', 'budget_hours', fN));
dash.draw('d_burn', (el) => { one('drill_head', 'burn_pct', fP)(el); const d = dash.data('drill_head'); ['ok', 'warn', 'bad'].forEach((c) => el.classList.remove(c)); const c = d.status === 'ok' && d.data[0] ? burnClass(d.data[0].burn_pct) : ''; if (c) el.classList.add(c); });
dash.draw('d_people', one('drill_head', 'people', fN));
dash.draw('drill_people_t', simpleTable('drill_people', [['person'], ['team'], ['hours', fN, 'n'], ['share_pct', fP, 'n'], ['hours_3m', fN, 'n'], ['hours_nov', fN, 'n'], ['billable_pct', fP, 'n'], ['last_month', fM]]));
dash.draw('drill_tasks_t', simpleTable('drill_tasks', [['use_case'], ['task'], ['hours', fN, 'n'], ['hours_3m', fN, 'n'], ['people', fN, 'n'], ['top_person']]));
dash.draw('drill_bars', (el) => {
  const d = dash.data('drill_months');
  if (d.status !== 'ok') { el.replaceChildren(); el.textContent = d.status === 'error' ? 'Failed to load' : ''; return; }
  if (!d.data.length) { el.replaceChildren(); el.textContent = 'No time logged on this project.'; return; }
  const ms = d.data.map((r) => r.month).sort();
  const months = d3.utcMonths(new Date(ms[0] + '-01T00:00:00Z'), d3.utcMonth.offset(new Date(ms[ms.length - 1] + '-01T00:00:00Z'), 1)).map((x) => x.toISOString().slice(0, 7));
  const tot = d3.rollups(d.data, (v) => d3.sum(v, (r) => r.hours), (r) => r.person).sort((a, b) => b[1] - a[1]);
  const top = tot.slice(0, 8).map((t) => t[0]);
  const rows = d.data.map((r) => ({ ...r, grp: top.includes(r.person) ? r.person : 'Other' }));
  wdStack(el, rows, 'grp', months, tot.length > 8 ? [...top, 'Other'] : top);
});

window.wdHeat = (el, rows, people, cols, colLabel, valFn, tipFn, maxV, scheme) => {
  el.replaceChildren();
  if (!people.length) { el.textContent = 'No time logged in this window.'; return; }
  const W = el.clientWidth || 600; const cell = 24;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('role', 'img').attr('aria-label', 'Heatmap of hours by person and period');
  const probe = svg.append('g'); let lw = 0;
  people.forEach((p) => { const t = probe.append('text').text(p); lw = Math.max(lw, t.node().getComputedTextLength()); }); probe.remove();
  const ml = Math.min(lw + 10, W * 0.45), mt = 22;
  const cw = Math.max(16, (W - ml - 4) / cols.length);
  const H = mt + people.length * cell + 4;
  svg.attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
  const col = d3.scaleSequential([0, maxV], scheme);
  const map = new Map(rows.map((r) => [r.person + '|' + r.col, r]));
  const every = Math.ceil(cols.length / Math.max(1, Math.floor((W - ml) / 46)));
  cols.forEach((c, i) => { if (i % every === 0) svg.append('text').attr('x', ml + i * cw + cw / 2).attr('y', 14).attr('text-anchor', 'middle').text(colLabel(c)); });
  const tip = wdTip(el);
  people.forEach((p, j) => {
    const lbl = svg.append('text').attr('x', ml - 8).attr('y', mt + j * cell + cell / 2 + 4).attr('text-anchor', 'end').text(p);
    let s = p; while (lbl.node().getComputedTextLength() > ml - 12 && s.length > 4) { s = s.slice(0, -1); lbl.text(s + '…'); }
    cols.forEach((c, i) => {
      const r = map.get(p + '|' + c); const v = r ? valFn(r) : null;
      const g = svg.append('g');
      g.append('rect').attr('x', ml + i * cw + 1).attr('y', mt + j * cell + 1).attr('width', cw - 2).attr('height', cell - 2).attr('rx', 3)
        .style('fill', v === null ? 'var(--cds-chart-grid)' : col(Math.min(v, maxV))).style('opacity', v === null ? 0.35 : 1)
        .on('pointermove', (ev) => tip.show(ev, tipFn(p, c, r))).on('pointerleave', () => tip.hide());
      if (r && cw >= 30) g.append('text').attr('x', ml + i * cw + cw / 2).attr('y', mt + j * cell + cell / 2 + 4).attr('text-anchor', 'middle').style('pointer-events', 'none')
        .style('fill', Math.min(v, maxV) > maxV * 0.55 ? '#fff' : '#222').text(d3.format('.0f')(v));
    });
  });
};

dash.draw('drill_heat', (el) => {
  const d = dash.data('drill_weekly');
  if (d.status !== 'ok') { el.replaceChildren(); el.textContent = d.status === 'error' ? 'Failed to load' : ''; return; }
  const weeks = d3.utcMondays(d3.utcDay.offset(WEEK0, -77), d3.utcDay.offset(WEEK0, 1)).map((x) => x.toISOString().slice(0, 10));
  const people = d3.rollups(d.data, (v) => d3.sum(v, (r) => r.hours), (r) => r.person).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  wdHeat(el, d.data.map((r) => ({ ...r, col: r.week })), people, weeks, (w) => d3.utcFormat('%d %b')(new Date(w + 'T00:00:00Z')), (r) => r.hours,
    (p, w, r) => [`${p}`, `Week of ${d3.utcFormat('%d %b %Y')(new Date(w + 'T00:00:00Z'))}: ${r ? d3.format(',.1f')(r.hours) + ' h' : 'nothing logged'}`], 40, d3.interpolateBlues);
});

document.querySelectorAll('#pplf').forEach((sel) => { sel.value = dash.params().ppl || 'active'; sel.addEventListener('change', () => dash.setParams({ ppl: sel.value })); });
dash.draw('ppl_heat', (el) => {
  const d = dash.data('person_util'), c = dash.data('calendar');
  if (d.status !== 'ok' || c.status !== 'ok') { el.replaceChildren(); el.textContent = d.status === 'error' ? 'Failed to load' : ''; return; }
  const cols = c.data.map((x) => x.month).filter((mm) => mm > d3.utcMonth.offset(new Date(CUR + '-01T00:00:00Z'), -9).toISOString().slice(0, 7) && mm <= CUR);
  const mode = dash.params().ppl || 'active';
  let rows = d.data.filter((r) => cols.includes(r.month));
  const active = new Set(d.data.filter((r) => MONTHS3.includes(r.month)).map((r) => r.person));
  if (mode === 'active') rows = rows.filter((r) => active.has(r.person));
  const people = d3.rollups(rows.filter((r) => MONTHS3.includes(r.month)), (v) => d3.sum(v, (r) => r.hours), (r) => r.person).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const rest = [...new Set(rows.map((r) => r.person))].filter((p) => !people.includes(p)).sort();
  wdHeat(el, rows.map((r) => ({ ...r, col: r.month })), [...people, ...rest], cols, (mm) => d3.utcFormat('%b %y')(new Date(mm + '-01T00:00:00Z')), (r) => r.util_pct,
    (p, mm, r) => [`${p}`, `${fM(mm)}: ${r ? `${fN(r.util_pct)}% · ${d3.format(',.1f')(r.hours)} of ${fN(r.capacity)} h` : 'nothing logged'}`], 110, d3.interpolateGreens);
});

})();