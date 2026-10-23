'use strict';

/* ═══════════════════════════════════════════════════════════════
   VectorCore High-Speed Client Controller
   Bypasses heavy client-side processing by loading pre-computed summaries.
   ═══════════════════════════════════════════════════════════════ */

let modelData = null;
let currentTab = 'overview';
let simState = { irt: 0.92, reopen: 0.14, esc_rate: 0.012 };
let threeScene = null;
let canvas2DAnimation = null;

// Pagination state for Tab 4
let cldCurrentPage = 1;
const cldPageSize = 25;

const $ = id => document.getElementById(id);
const setTxt = (id, v) => { const el = $(id); if (el) el.innerText = v; };

/* ── DOM RENDERING ── */
function renderDashboard(data) {
  if (!data || !data.kpis) return;
  modelData = data;
  const k = data.kpis;

  // 1. North Star Hero Card
  const nsHost = $('ov-northstar');
  if (nsHost) {
    const sPct = (k.sentiment * 100).toFixed(1) + '%';
    const isGood = k.sentiment >= 0.70;
    nsHost.innerHTML = `
      <div class="ns-card ${isGood ? 'is-good' : 'is-bad'}">
        <div class="ns-eyebrow">🌙 Moonshot · North Star</div>
        <div class="ns-row">
          <div>
            <div class="ns-title">Sentiment %</div>
            <div class="ns-value font-mono">${sPct}</div>
          </div>
        </div>
        <div class="ns-meta">
          <span>🎯 Target <b>70.0%</b></span>
          <span class="${isGood ? 'text-emerald-400' : 'text-rose-400'}">Gap <b>${((k.sentiment - 0.7) * 100).toFixed(1)} pp</b></span>
          <span>Cases Closed <b>${k.cases_closed.toLocaleString()}</b></span>
        </div>
      </div>
    `;
  }

  // 2. Steering Vehicle Cards
  const vHost = $('ov-vehicles');
  if (vHost) {
    const vehicles = [
      { label: 'IRT Within 24h', val: (k.irt * 100).toFixed(1) + '%', tgt: '≥ 92.0%', ok: k.irt >= 0.92 },
      { label: 'Reopen Rate', val: (k.reopen * 100).toFixed(1) + '%', tgt: '≤ 14.0%', ok: k.reopen <= 0.14 },
      { label: 'Escalation Rate', val: (k.esc_rate * 100).toFixed(2) + '%', tgt: '≤ 1.20%', ok: k.esc_rate <= 0.012 },
      { label: 'Handle Time (CHT)', val: k.cht.toFixed(1) + 'm', tgt: 'N/A', ok: true },
      { label: 'Time in Assigned', val: k.time_assigned.toFixed(1) + 'h', tgt: 'N/A', ok: true }
    ];

    vHost.innerHTML = vehicles.map(v => `
      <div class="veh-card ${v.ok ? 'is-good' : 'is-bad'}">
        <div class="veh-head">
          <span class="veh-role">Vehicle</span>
          <span class="veh-r font-mono">🎯 ${v.tgt}</span>
        </div>
        <div class="veh-label">${v.label}</div>
        <div class="veh-value font-mono">${v.val}</div>
      </div>
    `).join('');
  }

  // 3. Monthly Trends Matrix Table
  const tbody = $('kpiSummaryBody');
  const thead = $('kpiHeaderRow');
  if (tbody && thead && data.trends) {
    thead.innerHTML = '<th class="py-3 px-4 text-left">Period</th><th class="py-3 px-4 text-right">Sentiment</th><th class="py-3 px-4 text-right">IRT 24h</th><th class="py-3 px-4 text-right">Reopen</th><th class="py-3 px-4 text-right">Esc Rate</th><th class="py-3 px-4 text-right">Closed</th>';
    tbody.innerHTML = data.trends.map(t => `
      <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 font-mono">
        <td class="py-2.5 px-4 text-left font-sans font-semibold text-white">${t.period}</td>
        <td class="py-2.5 px-4 text-right ${t.sentiment >= 0.7 ? 'text-emerald-400' : 'text-rose-400'}">${(t.sentiment * 100).toFixed(1)}%</td>
        <td class="py-2.5 px-4 text-right ${t.irt >= 0.92 ? 'text-emerald-400' : 'text-rose-400'}">${(t.irt * 100).toFixed(1)}%</td>
        <td class="py-2.5 px-4 text-right ${t.reopen <= 0.14 ? 'text-emerald-400' : 'text-rose-400'}">${(t.reopen * 100).toFixed(1)}%</td>
        <td class="py-2.5 px-4 text-right">${(t.esc_rate * 100).toFixed(2)}%</td>
        <td class="py-2.5 px-4 text-right text-slate-400">${t.cases_closed.toLocaleString()}</td>
      </tr>
    `).join('');
  }

  // 4. Detractor Hierarchy Table
  const matBody = $('matrixBody');
  const matHead = ['matrixHeaderRow'];
  if (matBody && data.cat_tree) {
    matBody.innerHTML = data.cat_tree.map(node => `
      <tr class="tree-row-l1 border-b border-slate-800/60 font-mono">
        <td class="py-2.5 px-4 text-left font-sans">${node.name}</td>
        <td class="py-2.5 px-4 text-right text-rose-400">${node.total}</td>
        <td class="py-2.5 px-4 text-right text-slate-400">${(node.share * 100).toFixed(1)}%</td>
      </tr>
    `).join('');
  }

  // 5. Correlation Strip
  const stripHost = $('corr-strip');
  if (stripHost && data.correlations) {
    stripHost.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        ${data.correlations.strip.map(s => `
          <div class="p-3 bg-slate-900 border border-slate-800 rounded-xl font-mono">
            <div class="text-[10px] text-slate-400 uppercase font-sans font-semibold">${s.label}</div>
            <div class="text-xl font-bold ${s.aligned ? 'text-emerald-400' : 'text-rose-400'}">r = ${s.r > 0 ? '+' : ''}${s.r.toFixed(2)}</div>
            <div class="text-[10px] text-slate-500 font-sans mt-1">${s.aligned ? '✓ Expected direction' : '⚠ Counter-intuitive'}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // 6. Build Simulator Controls
  buildSimulator(data.simulator);
}

/* ── WHAT-IF SIMULATOR ── */
function buildSimulator(sim) {
  if (!sim) return;
  simState.irt = sim.ranges.irt.base;
  simState.reopen = sim.ranges.reopen.base;
  simState.esc_rate = sim.ranges.esc_rate.base;

  const sHost = $('sim-sliders');
  if (sHost) {
    sHost.innerHTML = `
      <div class="sim-row">
        <div class="flex justify-between text-xs text-slate-200">
          <span>IRT 24h %</span><span id="sim-val-irt" class="font-mono">${(simState.irt * 100).toFixed(1)}%</span>
        </div>
        <input type="range" id="sim-in-irt" min="0.5" max="1.0" step="0.005" value="${simState.irt}" oninput="onSimInput('irt', this.value)">
      </div>
      <div class="sim-row">
        <div class="flex justify-between text-xs text-slate-200">
          <span>Reopen %</span><span id="sim-val-reopen" class="font-mono">${(simState.reopen * 100).toFixed(1)}%</span>
        </div>
        <input type="range" id="sim-in-reopen" min="0.0" max="0.35" step="0.005" value="${simState.reopen}" oninput="onSimInput('reopen', this.value)">
      </div>
      <div class="sim-row">
        <div class="flex justify-between text-xs text-slate-200">
          <span>Esc Rate %</span><span id="sim-val-esc" class="font-mono">${(simState.esc_rate * 100).toFixed(2)}%</span>
        </div>
        <input type="range" id="sim-in-esc" min="0.0" max="0.04" step="0.001" value="${simState.esc_rate}" oninput="onSimInput('esc_rate', this.value)">
      </div>
    `;
  }
  updateSimPrediction();
  initReactorCanvas();
}

window.onSimInput = function(key, val) {
  simState[key] = parseFloat(val);
  if (key === 'irt') setTxt('sim-val-irt', (simState.irt * 100).toFixed(1) + '%');
  if (key === 'reopen') setTxt('sim-val-reopen', (simState.reopen * 100).toFixed(1) + '%');
  if (key === 'esc_rate') setTxt('sim-val-esc', (simState.esc_rate * 100).toFixed(2) + '%');
  updateSimPrediction();
};

function updateSimPrediction() {
  if (!modelData || !modelData.simulator) return;
  const sim = modelData.simulator;
  const dIrt = simState.irt - sim.ranges.irt.base;
  const dReo = simState.reopen - sim.ranges.reopen.base;
  const dEsc = simState.esc_rate - sim.ranges.esc_rate.base;

  const pred = Math.max(0, Math.min(1.0,
    sim.base_sentiment + (sim.beta.irt * dIrt) + (sim.beta.reopen * dReo) + (sim.beta.esc_rate * dEsc)
  ));

  const readout = $('sim-readout');
  if (readout) {
    readout.innerHTML = `
      <div class="sim-pred-label">Predicted Sentiment %</div>
      <div class="sim-pred ${pred >= 0.70 ? 'text-emerald-400' : 'text-rose-400'} font-mono">${(pred * 100).toFixed(1)}%</div>
      <div class="sim-pred-meta">
        <span>Current: <b>${(sim.base_sentiment * 100).toFixed(1)}%</b></span>
        <span>Delta: <b>${((pred - sim.base_sentiment) * 100).toFixed(1)} pp</b></span>
      </div>
    `;
  }
}

/* ── RESILIENT REACTOR ── */
function initReactorCanvas() {
  const host = $('sim-canvas');
  if (!host) return;
  init2DReactorFallback(host);
}

function init2DReactorFallback(host) {
  host.innerHTML = '';
  const canvas = document.createElement('canvas');
  const w = (canvas.width = host.clientWidth || 500);
  const h = (canvas.height = host.clientHeight || 420);
  host.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let angle = 0;

  function draw2DCore() {
    if (currentTab !== 'simulator') {
      canvas2DAnimation = requestAnimationFrame(draw2DCore);
      return;
    }

    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // Glowing outer halo
    const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 140);
    grad.addColorStop(0, 'rgba(0, 229, 212, 0.45)');
    grad.addColorStop(0.5, 'rgba(0, 102, 255, 0.20)');
    grad.addColorStop(1, 'rgba(2, 6, 23, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 140, 0, Math.PI * 2);
    ctx.fill();

    // Orbiting rings
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = '#00E5D4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 75, 30, Math.PI / 4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.rotate(Math.PI / 2);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 75, 30, -Math.PI / 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Center reactor core
    const coreGrad = ctx.createRadialGradient(cx - 10, cy - 10, 5, cx, cy, 45);
    coreGrad.addColorStop(0, '#FFFFFF');
    coreGrad.addColorStop(0.3, '#00E5D4');
    coreGrad.addColorStop(1, '#0F172A');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 45, 0, Math.PI * 2);
    ctx.fill();

    angle += 0.015;
    canvas2DAnimation = requestAnimationFrame(draw2DCore);
  }

  draw2DCore();
}

/* ── TAB NAVIGATION ── */
window.switchTab = function(tabKey) {
  currentTab = tabKey;
  ['overview', 'correlation', 'simulator', 'cases'].forEach(t => {
    const pane = $('tab-' + t);
    const btn = $('btn-tab-' + t);
    if (pane) pane.classList.toggle('hidden', t !== tabKey);
    if (btn) btn.classList.toggle('active', t !== tabKey);
  });
  if (tabKey === 'cases') loadCaseDrilldowns(cldCurrentPage);
};

function loadCaseDrilldowns(page) {
  const cldBody = $('cld-body');
  if (!cldBody) return;
  
  cldBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500">Retrieving page data...</td></tr>';
  
  fetch(`/api/v1/cases/drilldown?page=${page}&page_size=${cldPageSize}`)
    .then(r => r.json())
    .then(data => {
      $('cld-head-row').innerHTML = '<th class="py-2.5 px-3">Case ID</th><th class="py-2.5 px-3">Month</th><th class="py-2.5 px-3">Pod</th><th class="py-2.5 px-3">Assignee</th><th class="py-2.5 px-3 text-right">Score</th>';
      
      cldBody.innerHTML = data.records.map(r => `
        <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 font-mono">
          <td class="py-2 px-3 text-cyan-400 font-semibold">${r.caseId}</td>
          <td class="py-2 px-3">${r.month}</td>
          <td class="py-2 px-3">${r.sub_pod || r.pod}</td>
          <td class="py-2 px-3">${r.ldap}</td>
          <td class="py-2 px-3 text-right">${r.sentimentScore}</td>
        </tr>
      `).join('');
      
      renderCasePager(data.total);
    });
}

function renderCasePager(totalRecords) {
  const pager = $('cld-pager') || document.querySelector('[data-pager="cld"]');
  if (!pager) return;

  const totalPages = Math.ceil(totalRecords / cldPageSize);
  pager.className = "p-3.5 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400";
  pager.innerHTML = `
    <span>Showing ${(cldCurrentPage - 1) * cldPageSize + 1}–${Math.min(cldCurrentPage * cldPageSize, totalRecords)} of ${totalRecords.toLocaleString()}</span>
    <div class="flex space-x-1.5">
      <button type="button" class="pg-btn" ${cldCurrentPage === 1 ? 'disabled' : ''} onclick="changeCasePage(-1)">‹ Prev</button>
      <span class="px-3 py-1 font-mono text-cyan-400 rounded border border-slate-800">${cldCurrentPage} / ${totalPages}</span>
      <button type="button" class="pg-btn" ${cldCurrentPage === totalPages ? 'disabled' : ''} onclick="changeCasePage(1)">Next ›</button>
    </div>
  `;
}

window.changeCasePage = function(delta) {
  cldCurrentPage += delta;
  loadCaseDrilldowns(cldCurrentPage);
};

/* ── GLOBAL EVENT ROUTER ── */
function bindGlobalEvents() {
  document.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }

    const themeOpt = e.target.closest('#segToggleTheme .seg-opt');
    if (themeOpt) {
      const mode = themeOpt.innerText.toLowerCase();
      document.documentElement.setAttribute('data-theme', mode === 'auto' ? 'dark' : mode);
      document.querySelectorAll('#segToggleTheme .seg-opt').forEach(b => b.classList.toggle('active', b === themeOpt));
      return;
    }
  });
}

/* ── APP BOOTSTRAP ── */
window.boot = function() {
  bindGlobalEvents();

  window.__dataPromise
    .then(data => {
      renderDashboard(data);
      // Dissolve loader
      const loader = $('tesseract-loader');
      if (loader) loader.classList.add('hidden');
      window.__booted = true;
    })
    .catch(err => {
      console.error("[Boot Error]", err);
      const q = $('loader-quote');
      if (q) q.innerText = "Error: " + err.message;
    });
};

document.addEventListener('DOMContentLoaded', window.boot);
