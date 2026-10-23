'use strict';
/* ══════════════════════════════════════════
   VectorCore · static/js/app.js  (v3 — full redraft, single source of truth)
   Contract: GET /api/v1/vectors/summary  →  aggregator v2 payload
     metadata.dims {dim: [labels]} · cube {rows, columns {dim: int idx[], measure: float[]}}
     cat_tree [] · correlations {strip[], n_agents} · simulator {beta {irt, reopen, esc_rate}}
   Every number is recomputed here as ratio-of-sums over cube rows → exact under any filter.
   No CDN, no WebGL, no Tailwind dependency (styles injected below).
   ══════════════════════════════════════ */

/* ═══ 1. CONSTANTS ═══ */
const API_SUMMARY = '/api/v1/vectors/summary';
const API_CASES   = '/api/v1/cases/drilldown';
const THEME_KEY   = 'vectorcore.themeMode';
const LIGHT_FROM = 6, DARK_FROM = 18;
const TABS = ['overview', 'correlation', 'simulator', 'cases'];

const DIMS = ['month', 'week', 'sub_pod', 'region', 'market', 'segment'];
const DIM_LABEL = { month: 'Month', week: 'Week', sub_pod: 'Sub Pod', region: 'Region', market: 'Market', segment: 'Segment' };
const MS_MAP = { months: 'month', month: 'month', weeks: 'week', week: 'week', pods: 'sub_pod', pod: 'sub_pod', subpods: 'sub_pod', sub_pod: 'sub_pod', regions: 'region', region: 'region', markets: 'market', market: 'market', segments: 'segment', segment: 'segment' };
const MEAS = ['sent_num', 'sent_den', 'closed', 'reo_num', 'reo_den', 'cht_num', 'cht_den', 'asg_num', 'asg_den',
              'tfr_num', 'tfr_den', 'tta_num', 'tta_den', 'con_num', 'con_den', 'irt_num', 'irt_den', 'esc_num'];
const NA_LABELS = new Set(['(n/a)']);
const BLANK_LABELS = new Set(['(blank)', '(n/a)']);

const ratio = (n, d) => (d > 0 ? n / d : null);
const KPIS = [
  { key: 'sentiment',      label: 'Sentiment %',      role: 'northstar', fmt: 'pct',  hib: true,  target: 0.70,  f: s => ratio(s.sent_num, s.sent_den), w: s => s.sent_den },
  { key: 'irt',            label: 'IRT 24h %',        role: 'vehicle',   fmt: 'pct',  hib: true,  target: 0.92,  f: s => ratio(s.irt_num, s.irt_den),   w: s => s.irt_den },
  { key: 'reopen',         label: 'Reopen %',         role: 'vehicle',   fmt: 'pct',  hib: false, target: 0.14,  f: s => ratio(s.reo_num, s.reo_den),   w: s => s.reo_den },
  { key: 'consult',        label: 'Consult Rate 1.5', role: 'vehicle',   fmt: 'pct',  hib: false, target: null,  f: s => ratio(s.con_num, s.con_den),   w: s => s.con_den },
  { key: 'escalations',    label: 'Escalations',      role: 'vehicle',   fmt: 'int',  hib: false, target: null,  f: s => s.esc_num,                      w: s => s.closed },
  { key: 'escRate',        label: 'Esc Rate',         role: 'vehicle',   fmt: 'pct2', hib: false, target: 0.012, f: s => ratio(s.esc_num, s.closed),    w: s => s.closed },
  { key: 'cht',            label: 'CHT',              role: 'vehicle',   fmt: 'num',  hib: false, target: null,  unit: 'min', f: s => ratio(s.cht_num, s.cht_den), w: s => s.cht_den },
  { key: 'tta',            label: 'TTA',              role: 'vehicle',   fmt: 'num',  hib: false, target: null,  unit: 'h',   f: s => ratio(s.tta_num, s.tta_den), w: s => s.tta_den },
  { key: 'timeInAssigned', label: 'Time in Assigned', role: 'vehicle',   fmt: 'num',  hib: false, target: null,  unit: 'h',   f: s => ratio(s.asg_num, s.asg_den), w: s => s.asg_den },
  { key: 'tfr',            label: 'TFR (Email)',      role: 'context',   fmt: 'num',  hib: false, target: null,  unit: 'h',   f: s => ratio(s.tfr_num, s.tfr_den), w: s => s.tfr_den },
  { key: 'casesClosed',    label: 'Cases Closed',     role: 'context',   fmt: 'int',  hib: true,  target: null,  f: s => s.closed,                       w: s => s.closed }
];
const DEF = Object.fromEntries(KPIS.map(k => [k.key, k]));
const VEHICLES = KPIS.filter(k => k.role === 'vehicle').map(k => k.key);
const CORR_KEYS = ['sentiment', 'irt', 'reopen', 'consult', 'escRate', 'cht', 'tta', 'timeInAssigned'];

const SIM_LEVERS = [
  { key: 'irt',     beta: 'irt',      lo: 0.50, hi: 1.00, step: 0.005 },
  { key: 'reopen',  beta: 'reopen',   lo: 0.00, hi: 0.50, step: 0.005 },
  { key: 'escRate', beta: 'esc_rate', lo: 0.00, hi: 0.03, step: 0.0005 }
];

/* ═══ 2. STATE ═══ */
const S = {
  booted: false, payload: null, C: null, view: null,
  filters: Object.fromEntries(DIMS.map(d => [d, new Set()])),
  unit: 'month', tab: 'overview', xKpi: 'sentiment', theme: 'auto',
  corr: { unit: 'sub_pod', minVol: 30, pair: ['irt', 'sentiment'] }, corrCache: null,
  sim: { levers: [], baseSent: null, pred: null, canvas: null, anim: null },
  cases: { page: 1, size: 25, mode: 'scored', total: 0, rows: [], ctl: null },
  raf: null,
  dirty: { overview: true, correlation: true, simulator: true, cases: true }
};

/* ═══ 3. INJECTED STYLES ═══ */
const VC_CSS = `
.hidden{display:none!important}
.vc-good{color:var(--cz-good,#10B981)!important}.vc-bad{color:var(--cz-bad,#F43F5E)!important}
.vc-muted{color:var(--cz-text-muted,#94A3B8)!important}.vc-warn{color:var(--cz-warn,#F59E0B)!important}
.vc-mono{font-family:var(--cz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}
.vc-card{background:linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)));border:1px solid var(--cz-border,rgba(24,40,72,.7));border-radius:16px;box-shadow:var(--cz-card-shadow,0 10px 30px -10px rgba(0,0,0,.5))}
.vc-section{padding:16px;margin-bottom:20px}
.vc-sec-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cz-text-primary,#F8FAFC)}
.vc-sub{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--cz-text-muted,#94A3B8)}
.vc-empty{padding:28px;text-align:center;font-size:12px;color:var(--cz-text-muted,#94A3B8)}
.vc-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid var(--cz-input-border,#334155);background:var(--cz-input-bg,#1E293B);color:var(--cz-text-primary,#F8FAFC);cursor:pointer}
.vc-btn:hover:not(:disabled){border-color:var(--cz-cyan,#00E5D4);color:var(--cz-cyan,#00E5D4)}
.vc-btn:disabled{opacity:.45;cursor:not-allowed}
.vc-btn.is-on{background:var(--cz-cyan,#00E5D4);color:#041018;border-color:transparent}
.vc-select,.vc-input{background:var(--cz-input-bg,#1E293B);border:1px solid var(--cz-input-border,#334155);color:var(--cz-text-primary,#F8FAFC);border-radius:8px;padding:5px 8px;font-size:12px;outline:none}
.vc-select:focus,.vc-input:focus{border-color:var(--cz-cyan,#00E5D4)}
.vc-ctl{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--cz-text-muted,#94A3B8)}
.vc-ms{position:relative;display:inline-block}
.vc-ms-btn{display:inline-flex;align-items:center;gap:8px;width:156px;padding:5px 9px 5px 11px;background:var(--cz-input-bg,#1E293B);border:1px solid var(--cz-input-border,#334155);border-radius:10px;color:var(--cz-text-primary,#F8FAFC);cursor:pointer;text-align:left}
.vc-ms-btn:hover,.vc-ms-btn.is-filtered{border-color:var(--cz-cyan,#00E5D4)}
.vc-ms-txt{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.2}
.vc-ms-cap{font-size:8.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-ms-val{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-ms-btn.is-filtered .vc-ms-val{color:var(--cz-cyan,#00E5D4)}
.vc-ms-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:200;width:270px;max-height:380px;display:flex;flex-direction:column;background:var(--cz-menu-bg,rgba(15,26,46,.98));border:1px solid var(--cz-border-light,rgba(0,229,212,.35));border-radius:12px;box-shadow:0 18px 44px -12px rgba(0,0,0,.6);backdrop-filter:blur(14px)}
.vc-ms-head{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--cz-border,rgba(24,40,72,.7))}
.vc-ms-head input{flex:1;min-width:0}
.vc-ms-list{overflow-y:auto;padding:4px;flex:1}
.vc-ms-opt{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;font-size:11.5px;color:var(--cz-text-muted,#94A3B8);cursor:pointer}
.vc-ms-opt:hover{background:rgba(0,229,212,.08);color:var(--cz-text-primary,#F8FAFC)}
.vc-ms-opt span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-ms-opt em{font-style:normal;font-size:10px;opacity:.75}
.vc-ms-opt input{accent-color:var(--cz-cyan,#00E5D4)}
.vc-ms-foot{padding:6px 10px;border-top:1px solid var(--cz-border,rgba(24,40,72,.7));font-size:10px;color:var(--cz-text-muted,#94A3B8)}
.vc-scope{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;font-size:11px}
.vc-scope-lbl{font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--cz-text-muted,#94A3B8)}
.vc-scope-meta{margin-left:auto;color:var(--cz-text-muted,#94A3B8)}
.vc-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 4px 2px 9px;border-radius:999px;border:1px solid var(--cz-border-light,rgba(0,229,212,.35));background:rgba(0,229,212,.08);color:var(--cz-text-primary,#F8FAFC)}
.vc-chip button{border:0;background:none;color:inherit;cursor:pointer;opacity:.7;padding:0 4px}
.vc-ns{height:100%;padding:22px;border-radius:18px;display:flex;flex-direction:column;justify-content:space-between;gap:14px;border:1px solid var(--cz-border,rgba(24,40,72,.7));background:radial-gradient(120% 140% at 0% 0%,rgba(245,158,11,.18),transparent 55%),linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)))}
.vc-ns.is-good{border-color:rgba(16,185,129,.55)}.vc-ns.is-bad{border-color:rgba(244,63,94,.55)}
.vc-eyebrow{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--cz-northstar,#F59E0B)}
.vc-ns-row{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}
.vc-ns-title{font-size:13px;font-weight:600;color:var(--cz-text-muted,#94A3B8)}
.vc-ns-value{font-size:clamp(2.4rem,4vw,3.4rem);line-height:1;font-weight:700;color:var(--cz-text-primary,#F8FAFC)}
.vc-ns-meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:var(--cz-text-muted,#94A3B8)}
.vc-veh-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}
.vc-veh{position:relative;padding:12px 14px;border-radius:14px;cursor:pointer;display:flex;flex-direction:column;gap:2px;border:1px solid var(--cz-border,rgba(24,40,72,.7));background:linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)));transition:transform .15s,border-color .15s}
.vc-veh:hover{transform:translateY(-2px);border-color:var(--cz-border-light,rgba(0,229,212,.35))}
.vc-veh.is-good{box-shadow:inset 3px 0 0 var(--cz-good,#10B981)}.vc-veh.is-bad{box-shadow:inset 3px 0 0 var(--cz-bad,#F43F5E)}
.vc-veh.is-sel{border-color:var(--cz-cyan,#00E5D4)}
.vc-veh-head{display:flex;justify-content:space-between;align-items:center;gap:6px}
.vc-role{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-r{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--cz-input-bg,#1E293B);color:var(--cz-cyan,#00E5D4);border:0;cursor:pointer}
.vc-r.is-counter{color:var(--cz-bad,#F43F5E)}
.vc-veh-label{margin-top:4px;font-size:11px;font-weight:600;color:var(--cz-text-muted,#CBD5E1)}
.vc-veh-value{font-size:1.45rem;font-weight:700;line-height:1.25;color:var(--cz-text-primary,#F8FAFC);white-space:nowrap}
.vc-veh-foot{display:flex;justify-content:space-between;gap:6px;font-size:10px}
.vc-spark{display:block}
.vc-table{width:100%;border-collapse:collapse;font-size:12px}
.vc-table th{padding:9px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);border-bottom:1px solid var(--cz-border,rgba(24,40,72,.7));white-space:nowrap}
.vc-table td{padding:8px 12px;border-bottom:1px solid rgba(51,65,85,.35);color:var(--cz-text-primary,#E2E8F0);white-space:nowrap}
.vc-table tr:hover td{background:rgba(56,189,248,.05)}
.vc-table .r{text-align:right}
.vc-grp td{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);background:rgba(2,6,23,.35)}
.vc-ns-row-t td{background:rgba(245,158,11,.06)}
.vc-mini-bar{display:inline-block;height:6px;border-radius:3px;background:var(--cz-bad,#F43F5E);vertical-align:middle}
.vc-bd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.vc-bd-title{font-size:11px;font-weight:700;color:var(--cz-text-muted,#94A3B8);margin-bottom:6px}
.vc-ins-grid{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}
.vc-ins{padding:14px}
.vc-ins.is-good{border-color:rgba(16,185,129,.45)}.vc-ins.is-bad{border-color:rgba(244,63,94,.45)}
.vc-ins-t{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);margin-bottom:6px}
.vc-ins-b{font-size:12px;line-height:1.5;color:var(--cz-text-primary,#E2E8F0)}
.vc-sim-row{padding:10px 0;border-bottom:1px dashed var(--cz-border,rgba(24,40,72,.7))}
.vc-sim-head,.vc-sim-foot{display:flex;justify-content:space-between;gap:8px}
.vc-sim-head{font-size:12px;font-weight:600;color:var(--cz-text-primary,#E2E8F0)}
.vc-sim-foot{font-size:10px;color:var(--cz-text-muted,#94A3B8)}
.vc-sim-row input[type=range]{width:100%;accent-color:var(--cz-cyan,#00E5D4);margin:6px 0 2px}
.vc-pred-l{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-pred{font-size:2.6rem;font-weight:700;line-height:1.1}
.vc-pred-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11px;color:var(--cz-text-muted,#94A3B8);margin-top:4px}
.vc-note{margin-top:10px;font-size:10.5px;color:var(--cz-text-muted,#94A3B8);line-height:1.5}
.vc-list{margin-top:6px;font-size:12px;list-style:none;padding:0}
.vc-list li{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(51,65,85,.35)}
.vc-contrib{display:grid;grid-template-columns:120px 1fr 70px;align-items:center;gap:8px;font-size:11px;padding:4px 0}
.vc-contrib-track{position:relative;height:10px;background:rgba(51,65,85,.35);border-radius:5px}
.vc-contrib-track i{position:absolute;top:0;bottom:0;border-radius:5px}
.vc-contrib-track b{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--cz-text-muted,#94A3B8)}
#sim-canvas{position:relative;min-height:380px;border-radius:14px;overflow:hidden;background:radial-gradient(80% 80% at 50% 40%,rgba(22,78,99,.45),transparent 70%),#020617}
#sim-canvas canvas{display:block;width:100%;height:100%}
.vc-pager{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;border-top:1px solid var(--cz-border,rgba(24,40,72,.7));font-size:12px;color:var(--cz-text-muted,#94A3B8)}
.vc-tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:10px;border:1px solid}
.vc-tag.pos{color:var(--cz-good,#10B981);border-color:rgba(16,185,129,.5)}
.vc-tag.neg{color:var(--cz-bad,#F43F5E);border-color:rgba(244,63,94,.5)}
.vc-tag.na{color:var(--cz-text-muted,#94A3B8);border-color:rgba(148,163,184,.4)}
.vc-link{color:var(--cz-cyan,#00E5D4);font-weight:600;text-decoration:none}
.vc-link:hover{text-decoration:underline}
.vc-tip{position:fixed;z-index:99998;pointer-events:none;display:none;max-width:380px;padding:10px 12px;border-radius:10px;font-size:11px;line-height:1.5;color:var(--cz-text-primary,#F8FAFC);background:var(--cz-tooltip-b,rgba(6,10,18,.97));border:1px solid var(--cz-border-light,rgba(0,229,212,.35));box-shadow:0 15px 35px rgba(0,0,0,.6)}
.vc-tip .h{font-weight:700;margin-bottom:4px}
.vc-tip .s{color:var(--cz-text-muted,#94A3B8)}
.vc-toast{position:fixed;right:20px;bottom:20px;z-index:99999;max-width:420px;padding:12px 16px;border-radius:10px;font-size:12px;color:#fff;background:#0F1A2E;border:1px solid #1A73E8;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none}
svg text{font-family:inherit}
.vc-case-tabs{display:flex;flex-wrap:wrap;gap:8px;padding:13px 21px 0}
.vc-case-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 13px;padding:13px 21px}
.vc-case-bar #vc-case-q{flex:1 1 233px;max-width:377px}
.vc-case-scope{flex:1 1 233px;min-width:0;font-size:11px;color:var(--cz-text-muted,#94A3B8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-case-wrap{max-height:61.8vh;overflow:auto;border-top:1px solid var(--cz-border,rgba(24,40,72,.7))}
.vc-case-wrap thead th{position:sticky;top:0;z-index:2;background:var(--cz-surface,#0A1120)}
.vc-sortable{cursor:pointer;user-select:none}
.vc-sortable:hover,.vc-sortable.is-on{color:var(--cz-cyan,#00E5D4)}
.vc-arrow{font-size:9px;opacity:.6}
.vc-case-row{cursor:pointer}
.vc-case-row.is-open td{background:rgba(0,229,212,.06)}
.vc-case-detail td{white-space:normal!important;max-width:none!important;background:rgba(2,6,23,.45);padding:13px 21px!important}
.vc-case-text{font-size:12px;line-height:1.618;color:var(--cz-text-primary,#E2E8F0);max-width:89ch;margin-bottom:13px}
.vc-case-snip{color:var(--cz-text-muted,#94A3B8)}

.vc-hero{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1.618fr);gap:21px;align-items:stretch;margin-bottom:34px}
.vc-hero>*{grid-column:auto!important;min-width:0}
@media (max-width:1180px){.vc-hero{grid-template-columns:minmax(0,1fr)}}
#tab-overview,#tab-correlation,#tab-simulator,#tab-cases{max-width:1597px;margin-inline:auto}
.vc-card{border-radius:13px}
.vc-section{padding:21px;margin-bottom:34px}
.vc-sec-h{margin-bottom:13px;flex-wrap:wrap}
.vc-scope{gap:8px;margin-bottom:21px}
.vc-ns{padding:21px 34px;gap:13px;min-height:233px}
.vc-ns-value{font-size:clamp(2.618rem,4.236vw,4.236rem)}
.vc-ns-meta{gap:8px 21px}
.vc-veh-grid{grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:13px;align-content:start}
.vc-veh{min-height:144px;padding:13px 21px;border-radius:13px;justify-content:space-between}
.vc-veh-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-veh-value{font-size:1.618rem;overflow:hidden;text-overflow:ellipsis}
.vc-bd-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,377px),1fr));gap:21px 34px}
.vc-ins-grid{gap:13px;margin-bottom:21px}
.vc-ins{padding:13px 21px;min-height:89px}
.vc-ms-btn{width:178px;min-height:42px;padding:5px 13px}
.vc-ms-val{max-width:144px}
.vc-ms-menu{width:288px;max-height:466px}
#vc-filterbar{gap:8px}
.vc-table th,.vc-table td{padding:8px 13px}
.vc-table td{max-width:377px;overflow:hidden;text-overflow:ellipsis}
.vc-sim-row{padding:13px 0}
.vc-pred{font-size:2.618rem}
.vc-contrib{grid-template-columns:110px minmax(0,1fr) 68px;gap:8px}
#sim-canvas{min-height:322px;max-height:610px}
.vc-pager{padding:13px 21px}

`;
function injectStyles() {
  if ($('vc-styles')) return;
  const st = document.createElement('style');
  st.id = 'vc-styles';
  st.textContent = VC_CSS;
  document.head.appendChild(st);
}

/* ═══ 4. UTILITIES ═══ */
const $ = id => document.getElementById(id);
const isNum = v => typeof v === 'number' && isFinite(v);
const clamp01 = v => Math.max(0, Math.min(1, v));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
function pal() {
  return {
    good: cssVar('--cz-good', '#10B981'), bad: cssVar('--cz-bad', '#F43F5E'), warn: cssVar('--cz-warn', '#F59E0B'),
    axis: cssVar('--cz-axis-text', '#94A3B8'), grid: cssVar('--cz-grid', 'rgba(148,163,184,.16)'),
    ink: cssVar('--cz-text-primary', '#F8FAFC'), muted: cssVar('--cz-text-muted', '#94A3B8'), cyan: cssVar('--cz-cyan', '#00E5D4')
  };
}
function hexA(c, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(c || '').trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : c;
}
function ensureHost(id, parentId, opts = {}) {
  let el = $(id);
  if (el) return el;
  const p = $(parentId);
  if (!p) return null;
  el = document.createElement('div');
  el.id = id;
  if (opts.cls) el.className = opts.cls;
  if (opts.prepend) p.insertBefore(el, p.firstChild); else p.appendChild(el);
  return el;
}
const tip = {
  el: null,
  show(html, e) {
    if (!this.el) { this.el = document.createElement('div'); this.el.className = 'vc-tip'; document.body.appendChild(this.el); }
    this.el.innerHTML = html; this.el.style.display = 'block'; this.move(e);
  },
  move(e) {
    if (!this.el || !e) return;
    const r = this.el.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
    this.el.style.left = Math.max(8, x) + 'px'; this.el.style.top = Math.max(8, y) + 'px';
  },
  hide() { if (this.el) this.el.style.display = 'none'; }
};
function toast(msg, ms = 4000) {
  let el = $('vc-toast');
  if (!el) { el = document.createElement('div'); el.id = 'vc-toast'; el.className = 'vc-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = 'none'; }, ms);
}
function setLoader(msg, isErr) { const q = $('loader-quote'); if (q) { q.textContent = msg; if (isErr) q.style.color = '#FB7185'; } }
function hideLoader() {
  const l = $('tesseract-loader'); if (!l) return;
  l.style.transition = 'opacity .35s'; l.style.opacity = '0';
  setTimeout(() => { l.classList.add('hidden'); l.style.display = 'none'; }, 380);
}
function genTime() {
  const g = S.payload && S.payload.metadata && S.payload.metadata.generated_at;
  if (!g) return 'n/a';
  const d = new Date(g);
  return isNaN(d) ? String(g) : d.toLocaleString();
}

/* ═══ 5. STATS ═══ */
function quant(sorted, q) { if (!sorted.length) return null; const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }
const median = a => quant(a.slice().sort((x, y) => x - y), 0.5);
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
function pValueR(r, n) {
  const df = n - 2;
  if (df < 1 || !isNum(r)) return null;
  if (Math.abs(r) >= 1) return 0;
  const t2 = r * r * df / (1 - r * r);
  return ibeta(df / (df + t2), df / 2, 0.5);
}
function pearson(rows, a, b) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const r of rows) {
    const x = r[a], y = r[b];
    if (!isNum(x) || !isNum(y)) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 3) return { r: null, n, p: null };
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  if (vx <= 1e-12 || vy <= 1e-12) return { r: null, n, p: null, zeroVar: true };
  const r = Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy)));
  return { r, n, p: pValueR(r, n) };
}
const stars = p => !isNum(p) ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
const fmtR = r => isNum(r) ? (r > 0 ? '+' : '') + r.toFixed(2) : 'n/a';
const fmtP = p => !isNum(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3);

/* ═══ 6. FORMATTING ═══ */
function fmtV(def, v) {
  if (!isNum(v)) return '—';
  switch (def.fmt) {
    case 'pct':  return (v * 100).toFixed(1) + '%';
    case 'pct2': return (v * 100).toFixed(2) + '%';
    case 'int':  return Math.round(v).toLocaleString();
    default:     return v.toFixed(1) + (def.unit ? ' ' + def.unit : '');
  }
}
function fmtD(def, d) {
  if (!isNum(d)) return '—';
  const s = d > 0 ? '+' : '';
  if (def.fmt === 'pct')  return s + (d * 100).toFixed(1) + ' pp';
  if (def.fmt === 'pct2') return s + (d * 100).toFixed(2) + ' pp';
  if (def.fmt === 'int')  return s + Math.round(d).toLocaleString();
  return s + d.toFixed(1) + (def.unit ? ' ' + def.unit : '');
}
const fmtPP = v => isNum(v) ? (v > 0 ? '+' : '') + (v * 100).toFixed(1) + ' pp' : '—';
const good = (def, d) => (!isNum(d) || Math.abs(d) < 1e-12) ? 0 : ((d > 0) === def.hib ? 1 : -1);
const tgtStatus = (def, v) => (def.target == null || !isNum(v)) ? 0 : (def.hib ? (v >= def.target ? 1 : -1) : (v <= def.target ? 1 : -1));
const tone = g => g > 0 ? 'vc-good' : g < 0 ? 'vc-bad' : 'vc-muted';
const lastDelta = vals => { const n = vals.length; return n > 1 && isNum(vals[n - 1]) && isNum(vals[n - 2]) ? vals[n - 1] - vals[n - 2] : null; };
function axisFmt(def) { return def.fmt === 'pct' ? d3.format('.0%') : def.fmt === 'pct2' ? d3.format('.1%') : d3.format('~s'); }
function spark(vals, cls = '', w = 72, h = 20) {
  const v = vals.filter(isNum);
  if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), sp = (mx - mn) || 1, p = 2;
  const pts = v.map((y, i) => [p + i * (w - 2 * p) / (v.length - 1), h - p - ((y - mn) / sp) * (h - 2 * p)]);
  const d = 'M' + pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L');
  const L = pts[pts.length - 1];
  return `<svg class="vc-spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="2" fill="currentColor"/></svg>`;
}

/* ═══ 7. CUBE ENGINE ═══ */
function findDims(p, cube) {
  const cols = cube.columns || cube.cols || cube;
  const need = {};
  DIMS.forEach(k => { let mx = -1; const raw = cols[k]; if (raw) for (let i = 0; i < raw.length; i++) { const v = raw[i]; if (typeof v === 'number' && v > mx) mx = v; } need[k] = mx + 1; });
  const ALIAS = { months: 'month', weeks: 'week', pods: 'sub_pod', pod: 'sub_pod', subpod: 'sub_pod', subpods: 'sub_pod', product_sub_pod: 'sub_pod', regions: 'region', markets: 'market', segments: 'segment' };
  const norm = k => { const s = String(k).toLowerCase(); return DIMS.includes(s) ? s : (ALIAS[s] || null); };
  const NUMERIC = /^-?\d+(\.\d+)?$/;
  const asList = v => {
    if (Array.isArray(v)) {
      if (!v.length || v.length > 20000 || v.some(x => x !== null && typeof x === 'object')) return null;
      const L = v.map(x => (x == null ? '(blank)' : String(x)));
      return L.some(x => !NUMERIC.test(x)) ? L : null;
    }
    if (v && typeof v === 'object') {
      for (const key of ['labels', 'values', 'levels', 'categories', 'names', 'items', 'dict']) if (v[key]) { const L = asList(v[key]); if (L) return L; }
      const ks = Object.keys(v);
      if (ks.length && ks.length <= 20000 && ks.every(x => NUMERIC.test(x))) {
        const L = []; ks.forEach(x => { L[+x] = v[x] == null ? '(blank)' : String(v[x]); });
        return asList(Array.from(L, x => x ?? '(blank)'));
      }
    }
    return null;
  };
  const found = {}, seen = new Set([cols]);
  const consider = (dim, v, path) => {
    if (!dim) return;
    const L = asList(v); if (!L || new Set(L).size !== L.length) return;
    const score = L.length === need[dim] ? 2 : L.length > need[dim] ? 1 : 0;
    if (score && (!found[dim] || score > found[dim].score)) found[dim] = { L, score, path };
  };
  const walk = (o, path, depth) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 7) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length <= 64) o.forEach((it, i) => {
        if (it && typeof it === 'object' && !Array.isArray(it)) {
          consider(norm(it.name || it.key || it.dim || it.alias || it.id || ''), it.labels || it.values || it.levels || it.categories, path + '[' + i + ']');
          walk(it, path + '[' + i + ']', depth + 1);
        }
      });
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      consider(norm(k), v, path + '.' + k);
      if (v && typeof v === 'object') walk(v, path + '.' + k, depth + 1);
    }
  };
  walk(cube, 'cube', 0);
  walk(p, 'payload', 0);
  const out = {}, where = {};
  Object.entries(found).forEach(([k, f]) => { out[k] = f.L; where[k] = f.path; });
  console.info('[VectorCore] label sources:', where, '| top-level payload keys:', Object.keys(p));
  return out;
}
function buildCube(p) {
  if (!p) throw new Error('Empty payload from server');
  const cube = p.cube || (p.cubes && (p.cubes.main || Object.values(p.cubes)[0]));
  if (!cube) throw new Error('Payload has neither "cube" nor "cubes". Top-level keys: ' + Object.keys(p).join(', '));
  const cols = cube.columns || cube.cols || cube;
  const dimsSrc = findDims(p, cube);
  const first = cols[MEAS[0]] || cols[Object.keys(cols)[0]] || [];
  const n = cube.rows || cube.n || first.length;
  const d = {}, m = {}, labels = {}, missing = [];
  DIMS.forEach(k => {
    const raw = cols[k], lab = dimsSrc[k];
    if (raw && raw.length && typeof raw[0] === 'string') {
      const L = lab ? lab.map(String) : [...new Set(raw.map(String))].sort();
      const pos = new Map(L.map((x, i) => [x, i]));
      raw.forEach(v => { if (!pos.has(String(v))) { pos.set(String(v), L.length); L.push(String(v)); } });
      labels[k] = L; d[k] = Int32Array.from(raw, v => pos.get(String(v)));
    } else {
      d[k] = raw ? Int32Array.from(raw) : new Int32Array(n);
      const L = lab ? lab.map(String) : [];
      let mx = -1; for (let i = 0; i < d[k].length; i++) if (d[k][i] > mx) mx = d[k][i];
      if (L.length <= mx) { missing.push('labels:' + k + ' (' + L.length + ' of ' + (mx + 1) + ')'); for (let i = L.length; i <= mx; i++) L.push('#' + i); }
      if (!L.length) L.push('(n/a)');
      labels[k] = L;
    }
    if (!raw) missing.push('dim:' + k);
  });
  MEAS.forEach(k => { if (cols[k]) m[k] = Float64Array.from(cols[k]); else { m[k] = new Float64Array(n); missing.push(k); } });
  if (missing.length) console.warn('[VectorCore] cube gaps:', missing.join(', '), '| cube keys:', Object.keys(cube).join(', '), '| columns:', Object.keys(cols).join(', '));
  if (p.metadata && p.metadata.warnings && p.metadata.warnings.length) console.warn('[VectorCore] server warnings:', p.metadata.warnings);
  return { n, d, m, labels };
}
function checksFor(ignore) {
  const out = [];
  for (const d of DIMS) {
    if (d === ignore) continue;
    const s = S.filters[d];
    if (!s.size) continue;
    const lut = new Uint8Array(S.C.labels[d].length);
    s.forEach(i => { lut[i] = 1; });
    out.push([S.C.d[d], lut]);
  }
  return out;
}
/* agg() → totals object · agg(dim, ignore) → [{idx, name, s}] grouped by dim, ignoring the filter on `ignore` */
function agg(groupDim = null, ignore = null) {
  const C = S.C, checks = checksFor(ignore), M = MEAS.map(k => C.m[k]), nm = MEAS.length;
  const total = new Float64Array(nm), groups = new Map(), g = groupDim ? C.d[groupDim] : null;
  rows: for (let i = 0; i < C.n; i++) {
    for (let c = 0; c < checks.length; c++) { if (!checks[c][1][checks[c][0][i]]) continue rows; }
    let t = total;
    if (g) { const key = g[i]; t = groups.get(key); if (!t) { t = new Float64Array(nm); groups.set(key, t); } }
    for (let k = 0; k < nm; k++) t[k] += M[k][i];
  }
  const toObj = a => { const o = {}; for (let k = 0; k < nm; k++) o[MEAS[k]] = a[k]; return o; };
  if (!g) return toObj(total);
  return [...groups].map(([idx, a]) => ({ idx, name: C.labels[groupDim][idx], s: toObj(a) }));
}
function filterSig() { return DIMS.map(d => d + ':' + [...S.filters[d]].sort((a, b) => a - b).join(',')).join('|'); }
function periodSeries() {
  const cap = S.unit === 'week' ? 13 : 6;
  return agg(S.unit).filter(x => !BLANK_LABELS.has(x.name)).sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(-cap);
}

/* ═══ 8. FILTERS ═══ */
function ensureFilterSlots() {
  const known = [...document.querySelectorAll('[data-ms]')].filter(el => MS_MAP[el.dataset.ms]);
  if (known.length) return;
  let bar = $('vc-filterbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'vc-filterbar';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 16px';
    const tabBtn = document.querySelector('[data-tab]');
    const nav = tabBtn ? (tabBtn.closest('nav') || tabBtn.parentElement) : null;
    if (nav && nav.parentElement) nav.parentElement.insertBefore(bar, nav);
    else document.body.insertBefore(bar, document.body.firstChild);
  }
  bar.innerHTML = DIMS.map(d => `<div data-ms="${d}" data-caption="${DIM_LABEL[d]}"></div>`).join('') +
    '<button type="button" class="vc-btn" onclick="resetAllFilters()">↺ Reset</button>';
}
function mountFilters() {
  ensureFilterSlots();
  const hidden = [];
  document.querySelectorAll('[data-ms]').forEach(el => {
    const key = el.dataset.ms, dim = MS_MAP[key];
    if (!dim) { el.style.display = 'none'; hidden.push(el.dataset.caption || key); return; }
    el.style.position = 'relative';
    const cap = el.dataset.caption || DIM_LABEL[dim];
    el.innerHTML =
      `<div class="vc-ms">` +
        `<button type="button" class="vc-ms-btn" data-vc-ms-toggle="${dim}">` +
          `<span class="vc-ms-txt"><span class="vc-ms-cap">${esc(cap)}</span><span class="vc-ms-val" data-vc-ms-val="${dim}">All</span></span>` +
          `<span class="vc-muted" style="font-size:10px">▾</span>` +
        `</button>` +
        `<div class="vc-ms-menu hidden">` +
          `<div class="vc-ms-head"><input class="vc-input" data-vc-ms-search="${dim}" placeholder="Search ${esc(DIM_LABEL[dim])}…"><button type="button" class="vc-btn" data-vc-ms-clear="${dim}">Clear</button></div>` +
          `<div class="vc-ms-list"></div>` +
          `<div class="vc-ms-foot">Nothing ticked = All · numbers = cases closed in current scope</div>` +
        `</div>` +
      `</div>`;
  });
  if (hidden.length) console.info('[VectorCore] Filters hidden (not part of the aggregated cube):', hidden.join(', '));
  updateMsLabels();
}
function renderMsList(menu, dim) {
  const C = S.C, labels = C.labels[dim], sel = S.filters[dim];
  const vol = new Map(agg(dim, dim).map(g => [g.idx, g.s.closed]));
  const idxs = labels.map((_, i) => i).filter(i => !NA_LABELS.has(labels[i]) || sel.has(i));
  if (dim === 'month' || dim === 'week') idxs.sort((a, b) => String(labels[b]).localeCompare(String(labels[a])));
  else idxs.sort((a, b) => (vol.get(b) || 0) - (vol.get(a) || 0));
  const list = menu.querySelector('.vc-ms-list');
  list.innerHTML = idxs.length
    ? idxs.map(i => `<label class="vc-ms-opt" data-label="${esc(labels[i].toLowerCase())}"><input type="checkbox" data-vc-ms-opt="${dim}" value="${i}" ${sel.has(i) ? 'checked' : ''}><span title="${esc(labels[i])}">${esc(labels[i])}</span><em class="vc-mono">${Math.round(vol.get(i) || 0).toLocaleString()}</em></label>`).join('')
    : '<div class="vc-empty">No values</div>';
}
function updateMsLabels() {
  DIMS.forEach(d => {
    const s = S.filters[d], L = S.C.labels[d];
    const txt = !s.size ? 'All' : s.size === 1 ? L[[...s][0]] : s.size + ' selected';
    document.querySelectorAll(`[data-vc-ms-val="${d}"]`).forEach(el => {
      el.textContent = txt;
      const b = el.closest('.vc-ms-btn'); if (b) b.classList.toggle('is-filtered', s.size > 0);
    });
  });
}
function openMenu(btn) {
  const wrap = btn.closest('.vc-ms'), menu = wrap.querySelector('.vc-ms-menu'), dim = btn.dataset.vcMsToggle;
  const wasOpen = !menu.classList.contains('hidden');
  closeMenus();
  if (wasOpen) return;
  renderMsList(menu, dim);
  menu.classList.remove('hidden');
  const s = menu.querySelector('[data-vc-ms-search]');
  if (s) { s.value = ''; s.focus(); }
}
function closeMenus() {
  document.querySelectorAll('.vc-ms-menu').forEach(m => m.classList.add('hidden'));
  document.querySelectorAll('.ms-menu').forEach(m => m.classList.add('hidden'));
}
function toggleFilter(dim, v) {
  const idx = typeof v === 'number' ? v : S.C.labels[dim].indexOf(String(v));
  if (idx < 0) return;
  const s = S.filters[dim];
  if (s.has(idx)) s.delete(idx); else s.add(idx);
  onFiltersChanged();
}
function clearDim(dim) { if (!S.filters[dim]) return; S.filters[dim].clear(); onFiltersChanged(); }
function onFiltersChanged() { updateMsLabels(); markDirty(); S.cases.page = 1; renderVisible(); }
window.resetAllFilters = function () { DIMS.forEach(d => S.filters[d].clear()); closeMenus(); onFiltersChanged(); };

/* ═══ 9. OVERVIEW ═══ */
function renderOverview() {
  const tot = agg(), per = periodSeries();
  S.view = { tot, per };
  const ns0 = $('ov-northstar'); if (ns0 && ns0.parentElement) ns0.parentElement.classList.add('vc-hero');
  renderScope(tot);
  renderNorthStar(tot, per);
  renderVehicles(tot, per);
  renderMatrix(per, tot);
  renderBreakdown();
  renderCategories();
}
function renderScope(tot) {
  const host = ensureHost('vc-scope', 'tab-overview', { prepend: true }); if (!host) return;
  const chips = DIMS.filter(d => S.filters[d].size).map(d => {
    const names = [...S.filters[d]].map(i => S.C.labels[d][i]);
    const txt = names.length > 2 ? names.length + ' selected' : names.join(', ');
    return `<span class="vc-chip">${DIM_LABEL[d]}: <b>${esc(txt)}</b><button type="button" data-vc-clear-dim="${d}" title="Remove">✕</button></span>`;
  }).join('');
  host.innerHTML = `<div class="vc-scope"><span class="vc-scope-lbl">Scope</span>${chips || '<span class="vc-muted">All data</span>'}` +
    `<span class="vc-scope-meta vc-mono">${Math.round(tot.closed).toLocaleString()} cases closed · ${Math.round(tot.sent_den).toLocaleString()} scored · data generated ${esc(genTime())}</span></div>`;
}
function renderNorthStar(tot, per) {
  const host = $('ov-northstar'); if (!host) return;
  const def = DEF.sentiment, v = def.f(tot), vals = per.map(p => def.f(p.s)), d = lastDelta(vals);
  const st = tgtStatus(def, v), g = good(def, d), gap = isNum(v) ? v - def.target : null;
  host.innerHTML =
    `<div class="vc-ns ${st > 0 ? 'is-good' : st < 0 ? 'is-bad' : ''}">` +
      `<div class="vc-eyebrow">🌙 Moonshot · North Star</div>` +
      `<div class="vc-ns-row"><div><div class="vc-ns-title">${esc(def.label)}</div><div class="vc-ns-value vc-mono">${fmtV(def, v)}</div></div>` +
      `<div class="${tone(g)}">${spark(vals, '', 140, 40)}</div></div>` +
      `<div class="vc-ns-meta">` +
        `<span>🎯 Target <b class="vc-mono">${fmtV(def, def.target)}</b></span>` +
        `<span class="${tone(st)}">Gap <b class="vc-mono">${fmtPP(gap)}</b></span>` +
        `<span class="${tone(g)}">${S.unit === 'week' ? 'WoW' : 'MoM'} Δ <b class="vc-mono">${fmtD(def, d)}</b></span>` +
        `<span>Scored <b class="vc-mono">${Math.round(tot.sent_den).toLocaleString()}</b></span>` +
        `<span>Cases closed <b class="vc-mono">${Math.round(tot.closed).toLocaleString()}</b></span>` +
      `</div>` +
    `</div>`;
}
function renderVehicles(tot, per) {
  const host = $('ov-vehicles'); if (!host) return;
  host.classList.add('vc-veh-grid');
  let corr = null; try { corr = getCorr(); } catch (e) { console.warn('[VectorCore] correlation failed', e); }
  const rBy = corr ? Object.fromEntries(corr.strip.map(s => [s.key, s])) : {};
  host.innerHTML = [...VEHICLES, 'casesClosed'].map(k => {
    const def = DEF[k], v = def.f(tot), vals = per.map(p => def.f(p.s)), d = lastDelta(vals);
    const st = tgtStatus(def, v), g = good(def, d), s = rBy[k];
    const chip = CORR_KEYS.includes(k)
      ? `<button type="button" class="vc-r vc-mono ${s && s.aligned === false ? 'is-counter' : ''}" data-vc-corr="${k}" title="Pearson r vs Sentiment across ${DIM_LABEL[S.corr.unit]}s (p=${fmtP(s && s.p)}) · click to analyse">r ${fmtR(s && s.r)}${stars(s && s.p)}</button>`
      : `<span class="vc-role">${def.role === 'context' ? 'context' : 'count'}</span>`;
    const tgt = def.target != null ? `<span class="${tone(st)}">🎯 ${fmtV(def, def.target)}</span>` : '<span class="vc-muted">no target</span>';
    return `<div class="vc-veh ${st > 0 ? 'is-good' : st < 0 ? 'is-bad' : ''} ${S.xKpi === k ? 'is-sel' : ''}" data-vc-veh="${k}" title="Click to rank groups by ${esc(def.label)}">` +
      `<div class="vc-veh-head"><span class="vc-role">${def.role === 'vehicle' ? 'Vehicle' : 'Context'}</span>${chip}</div>` +
      `<div class="vc-veh-label">${esc(def.label)}</div>` +
      `<div class="vc-veh-value vc-mono">${fmtV(def, v)}</div>` +
      `<div class="vc-veh-foot vc-mono"><span class="${tone(g)}">${g > 0 ? '▲' : g < 0 ? '▼' : '•'} ${fmtD(def, d)}</span>${tgt}</div>` +
      `<div class="${tone(g)}" style="margin-top:4px">${spark(vals)}</div>` +
    `</div>`;
  }).join('');
}
function renderMatrix(per, tot) {
  const head = $('kpiHeaderRow'), body = $('kpiSummaryBody'); if (!head || !body) return;
  const tbl = head.closest('table'); if (tbl) tbl.classList.add('vc-table');
  const dl = S.unit === 'week' ? 'WoW Δ' : 'MoM Δ';
  head.innerHTML = '<th>Metric</th><th>Role</th><th class="r">Target</th>' + per.map(p => `<th class="r">${esc(p.name)}</th>`).join('') + `<th class="r">Overall</th><th class="r">${dl}</th>`;
  const span = per.length + 5;
  const groups = [['northstar', '🌙 North Star'], ['vehicle', '🚀 Vehicles'], ['context', '📦 Context']];
  body.innerHTML = groups.map(([role, title]) => {
    const defs = KPIS.filter(k => k.role === role);
    return `<tr class="vc-grp"><td colspan="${span}">${title}</td></tr>` + defs.map(def => {
      const vals = per.map(p => def.f(p.s)), d = lastDelta(vals), g = good(def, d), ov = def.f(tot), ost = tgtStatus(def, ov);
      return `<tr class="${role === 'northstar' ? 'vc-ns-row-t' : ''}">` +
        `<td><b>${esc(def.label)}</b></td><td class="vc-muted" style="font-size:10px;text-transform:uppercase">${role}</td>` +
        `<td class="r vc-mono vc-muted">${def.target != null ? (def.hib ? '≥ ' : '≤ ') + fmtV(def, def.target) : '—'}</td>` +
        vals.map(v => { const s2 = tgtStatus(def, v); return `<td class="r vc-mono ${s2 > 0 ? 'vc-good' : s2 < 0 ? 'vc-bad' : ''}">${fmtV(def, v)}</td>`; }).join('') +
        `<td class="r vc-mono ${ost > 0 ? 'vc-good' : ost < 0 ? 'vc-bad' : ''}"><b>${fmtV(def, ov)}</b></td>` +
        `<td class="r vc-mono ${tone(g)}"><b>${fmtD(def, d)}</b></td></tr>`;
    }).join('');
  }).join('');
}
function breakdownHost() {
  let el = $('vc-breakdown'); if (el) return el;
  const tab = $('tab-overview'), ns = $('ov-northstar'); if (!tab) return null;
  el = document.createElement('div'); el.id = 'vc-breakdown'; el.className = 'vc-card vc-section';
  const hero = ns ? ns.parentElement : null;
  if (hero && hero.parentElement === tab) hero.insertAdjacentElement('afterend', el); else tab.appendChild(el);
  return el;
}
function renderBreakdown() {
  const host = breakdownHost(); if (!host) return;
  if (host.dataset.vc !== '1') {
    host.dataset.vc = '1';
    host.innerHTML =
      `<div class="vc-sec-h"><span>Breakdown · <span id="vc-bd-name"></span> <span class="vc-sub">largest groups by volume, worst first · click a bar to filter</span></span>` +
      `<label class="vc-ctl">KPI <select id="vc-bd-kpi" class="vc-select">${KPIS.map(k => `<option value="${k.key}">${esc(k.label)}</option>`).join('')}</select></label></div>` +
      `<div class="vc-bd-grid">` +
        `<div><div class="vc-bd-title">Sub Pod</div><div id="vc-bars-pod"></div></div>` +
        `<div><div class="vc-bd-title">Region</div><div id="vc-bars-region"></div></div>` +
        `<div><div class="vc-bd-title">Market</div><div id="vc-bars-market"></div></div>` +
        `<div><div class="vc-bd-title">Segment</div><div id="vc-bars-segment"></div></div>` +
      `</div>`;
    $('vc-bd-kpi').addEventListener('change', e => {
      S.xKpi = e.target.value;
      renderBreakdown();
      document.querySelectorAll('[data-vc-veh]').forEach(c => c.classList.toggle('is-sel', c.dataset.vcVeh === S.xKpi));
    });
  }
  $('vc-bd-kpi').value = S.xKpi;
  $('vc-bd-name').textContent = DEF[S.xKpi].label;
  if (!window.d3) {
    ['vc-bars-pod', 'vc-bars-region', 'vc-bars-market', 'vc-bars-segment'].forEach(id => { const h = $(id); if (h) h.innerHTML = '<div class="vc-empty">D3 not loaded (/static/js/d3.v7.min.js)</div>'; });
    return;
  }
  renderBars('vc-bars-pod', 'sub_pod', 12);
  renderBars('vc-bars-region', 'region', 8);
  renderBars('vc-bars-market', 'market', 12);
  renderBars('vc-bars-segment', 'segment', 8);
}
function renderBars(hostId, dim, topN) {
  const host = $(hostId); if (!host) return; host.innerHTML = '';
  const def = DEF[S.xKpi], sel = S.filters[dim], any = sel.size > 0, P = pal();
  let items = agg(dim, dim).filter(g => !NA_LABELS.has(g.name))
    .map(g => ({ idx: g.idx, name: g.name, v: def.f(g.s), w: def.w(g.s), closed: g.s.closed }))
    .filter(x => isNum(x.v) && x.w > 0);
  items.sort((a, b) => b.w - a.w); items = items.slice(0, topN);
  items.sort((a, b) => (def.hib ? a.v - b.v : b.v - a.v));
  if (!items.length) { host.innerHTML = '<div class="vc-empty">No data in scope</div>'; return; }

  const W = Math.max(320, host.clientWidth || 480), rowH = 24, m = { top: 16, right: 70, bottom: 22, left: 150 };
  const ih = items.length * rowH, H = ih + m.top + m.bottom, iw = W - m.left - m.right;
  const onT = v => def.target == null ? null : (def.hib ? v >= def.target : v <= def.target);
  const vMax = d3.max(items, d => d.v);
  const x = d3.scaleLinear().domain([0, Math.max(vMax, def.target || 0) * 1.05 || 1]).nice().range([0, iw]);
  const y = d3.scaleBand().domain(items.map(d => d.name)).range([0, ih]).padding(0.22);
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, H]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  g.append('g').attr('transform', `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-ih).tickFormat(axisFmt(def)))
    .call(a => a.select('.domain').remove())
    .call(a => a.selectAll('line').attr('stroke', P.grid))
    .call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10));
  if (def.target != null) {
    g.append('line').attr('x1', x(def.target)).attr('x2', x(def.target)).attr('y1', -4).attr('y2', ih)
      .attr('stroke', P.good).attr('stroke-dasharray', '4,3').attr('stroke-opacity', 0.8);
    g.append('text').attr('x', x(def.target)).attr('y', -6).attr('text-anchor', 'middle').attr('font-size', 9).attr('fill', P.good).text('🎯 ' + fmtV(def, def.target));
  }
  const row = g.selectAll('g.vc-bar').data(items, d => d.name).join('g').attr('class', 'vc-bar')
    .attr('transform', d => `translate(0,${y(d.name)})`).style('cursor', 'pointer')
    .attr('opacity', d => !any || sel.has(d.idx) ? 1 : 0.35);
  row.append('rect').attr('x', -m.left).attr('y', -2).attr('width', W).attr('height', y.bandwidth() + 4).attr('fill', 'transparent');
  row.append('text').attr('x', -8).attr('y', y.bandwidth() / 2 + 4).attr('text-anchor', 'end').attr('font-size', 11).attr('fill', P.ink)
    .text(d => d.name.length > 22 ? d.name.slice(0, 21) + '…' : d.name);
  row.append('rect').attr('height', y.bandwidth()).attr('rx', 3).attr('width', 0)
    .attr('fill', d => { const t = onT(d.v); return t === null ? P.cyan : t ? P.good : P.bad; })
    .attr('stroke', d => sel.has(d.idx) ? P.ink : 'none').attr('stroke-width', 1.5)
    .transition().duration(REDUCED ? 0 : 500).attr('width', d => Math.max(1, x(d.v)));
  row.append('text').attr('class', 'vc-mono').attr('y', y.bandwidth() / 2 + 4).attr('font-size', 10)
    .attr('x', d => x(d.v) + 6).attr('fill', P.axis).text(d => fmtV(def, d.v));
  row.on('mousemove', (e, d) => tip.show(
      `<div class="h">${esc(d.name)}</div>` +
      `<div>${esc(def.label)} <b class="vc-mono">${fmtV(def, d.v)}</b></div>` +
      `<div class="s">Volume <b class="vc-mono">${Math.round(d.w).toLocaleString()}</b> · Cases closed <b class="vc-mono">${Math.round(d.closed || 0).toLocaleString()}</b></div>` +
      (def.target != null ? `<div class="${onT(d.v) ? 'vc-good' : 'vc-bad'}">${onT(d.v) ? '✓ On target' : '✗ Off target'}</div>` : '') +
      `<div class="s">Click to ${sel.has(d.idx) ? 'remove' : 'add'} filter</div>`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { tip.hide(); toggleFilter(dim, d.idx); });
}
function renderCategories() {
  const head = $('matrixHeaderRow'), body = $('matrixBody'); if (!head || !body) return;
  const tbl = head.closest('table'); if (tbl) tbl.classList.add('vc-table');
  const tree = (S.payload.cat_tree || []).slice().sort((a, b) => (b.total || 0) - (a.total || 0));
  const totDet = tree.reduce((a, n) => a + (n.total || 0), 0), mx = Math.max(1, ...tree.map(n => n.total || 0));
  head.innerHTML = '<th>Category (L1)</th><th class="r">Detractors</th><th class="r">Share of scored</th><th class="r">Share of detractors</th><th></th>';
  body.innerHTML = tree.length
    ? tree.map(n => `<tr><td>${esc(n.name)}</td><td class="r vc-mono vc-bad"><b>${(n.total || 0).toLocaleString()}</b></td>` +
        `<td class="r vc-mono">${isNum(n.share) ? (n.share * 100).toFixed(1) + '%' : '—'}</td>` +
        `<td class="r vc-mono vc-muted">${totDet ? ((n.total / totDet) * 100).toFixed(1) + '%' : '—'}</td>` +
        `<td style="width:30%"><span class="vc-mini-bar" style="width:${((n.total || 0) / mx * 100).toFixed(1)}%"></span></td></tr>`).join('')
    : '<tr><td colspan="5" class="vc-empty">No detractor categories returned by the server.</td></tr>';
  const badge = $('catUnclassifiedBadge'); if (badge) badge.textContent = 'All data · not filter-aware';
  ['l2', 'l3', 'l4'].forEach(k => { const b = $('cat-lvl-btn-' + k); if (b) { b.disabled = true; b.title = 'Only L1 is aggregated server-side'; } });
  const b1 = $('cat-lvl-btn-l1'); if (b1) b1.classList.add('active');
}

/* ═══ 10. CORRELATION ═══ */
function getCorr() {
  const sig = filterSig() + '#' + S.corr.unit + '#' + S.corr.minVol;
  if (S.corrCache && S.corrCache.sig === sig) return S.corrCache;
  const unit = S.corr.unit;
  const selNames = new Set([...S.filters[unit]].map(i => S.C.labels[unit][i]));
  const rows = agg(unit, unit).filter(g => !BLANK_LABELS.has(g.name) && g.s.sent_den >= S.corr.minVol).map(g => {
    const o = { id: g.name, n: g.s.sent_den, closed: g.s.closed, sel: selNames.has(g.name) };
    CORR_KEYS.forEach(k => { o[k] = DEF[k].f(g.s); });
    return o;
  });
  const matrix = CORR_KEYS.map(a => CORR_KEYS.map(b => a === b ? { r: 1, n: rows.filter(x => isNum(x[a])).length, p: 0 } : pearson(rows, a, b)));
  const strip = CORR_KEYS.filter(k => k !== 'sentiment').map(k => {
    const pr = pearson(rows, 'sentiment', k), def = DEF[k];
    return { key: k, def, r: pr.r, p: pr.p, n: pr.n, zeroVar: !!pr.zeroVar, aligned: isNum(pr.r) ? (pr.r > 0) === def.hib : null };
  });
  const outliers = [];
  CORR_KEYS.forEach(k => {
    const vals = rows.map(r => r[k]).filter(isNum);
    if (vals.length < 6) return;
    const med = median(vals), mad = median(vals.map(v => Math.abs(v - med)));
    if (!(mad > 0)) return;
    rows.forEach(r => {
      const v = r[k]; if (!isNum(v)) return;
      const z = 0.6745 * (v - med) / mad;
      if (Math.abs(z) >= 2.5) {
        const better = (z > 0) === DEF[k].hib;
        outliers.push({ type: better ? 'Better than peers' : 'Worse than peers', better, id: r.id, key: k, value: v, ref: med, z, n: r.n, sentiment: r.sentiment });
      }
    });
  });
  outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  S.corrCache = { sig, unit, rows, matrix, strip, outliers };
  return S.corrCache;
}
function renderCorrelation() {
  renderCorrControls();
  if (!window.d3) { const h = ensureHost('corr-strip', 'tab-correlation', { cls: 'vc-card vc-section' }); if (h) h.innerHTML = '<div class="vc-empty">D3 not loaded (/static/js/d3.v7.min.js)</div>'; return; }
  const res = getCorr();
  renderCorrInsights(res);
  renderCorrStrip(res);
  renderCorrHeatmap(res);
  renderCorrScatter(res);
  renderOutliers(res);
}
function renderCorrControls() {
  const host = ensureHost('corr-controls', 'tab-correlation', { prepend: true }); if (!host) return;
  if (host.dataset.vc !== '1') {
    host.dataset.vc = '1';
    host.innerHTML =
      `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:12px">` +
        `<label class="vc-ctl">Unit <select id="vc-corr-unit" class="vc-select">${['sub_pod', 'market', 'region', 'segment', 'week', 'month'].map(d => `<option value="${d}">${DIM_LABEL[d]}</option>`).join('')}</select></label>` +
        `<label class="vc-ctl">Min scored cases / unit <input id="vc-corr-min" type="number" min="1" max="5000" class="vc-input" style="width:80px"></label>` +
        `<button type="button" class="vc-btn" onclick="exportCorrelationToSheets()">⬇ CSV</button>` +
      `</div>`;
    $('vc-corr-unit').addEventListener('change', e => { S.corr.unit = e.target.value; S.corrCache = null; S.dirty.overview = true; renderCorrelation(); });
    $('vc-corr-min').addEventListener('change', e => { S.corr.minVol = Math.max(1, parseInt(e.target.value, 10) || 30); S.corrCache = null; S.dirty.overview = true; renderCorrelation(); });
  }
  $('vc-corr-unit').value = S.corr.unit;
  $('vc-corr-min').value = S.corr.minVol;
}
function renderCorrInsights(res) {
  const host = ensureHost('corr-insights', 'tab-correlation'); if (!host) return;
  host.className = 'vc-ins-grid';
  const valid = res.strip.filter(s => isNum(s.r)), sig = valid.filter(s => isNum(s.p) && s.p < 0.05);
  const best = sig.filter(s => s.aligned).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const counter = sig.filter(s => s.aligned === false).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const srv = S.payload.correlations || {};
  const srvTxt = (srv.strip || []).map(s => `${esc(s.label)} <b class="vc-mono ${s.aligned ? 'vc-good' : 'vc-bad'}">${fmtR(s.r)}</b>`).join(' · ') || 'n/a';
  const card = (icon, t, b, cls = '') => `<div class="vc-card vc-ins ${cls}"><div class="vc-ins-t">${icon} ${t}</div><div class="vc-ins-b">${b}</div></div>`;
  host.innerHTML =
    card('📌', 'Strongest aligned driver', best ? `<b>${esc(best.def.label)}</b> · r <b class="vc-mono">${fmtR(best.r)}</b> (p ${fmtP(best.p)}, n ${best.n})` : 'No significant aligned driver at this unit.', best ? 'is-good' : '') +
    card('⚠️', 'Counter-intuitive signal', counter ? `<b>${esc(counter.def.label)}</b> moves opposite to expectation (r ${fmtR(counter.r)}). Check for confounding, e.g. complex queues.` : 'None significant.', counter ? 'is-bad' : '') +
    card('🧪', 'Coverage', `${res.rows.length} ${DIM_LABEL[res.unit].toLowerCase()} units with ≥ ${S.corr.minVol} scored cases. The ${DIM_LABEL[res.unit].toLowerCase()} filter is ignored here so peers stay visible; selected units are outlined.`) +
    card('👤', `Agent level · all data (${srv.n_agents || '?'} agents)`, srvTxt + '<div class="vc-note" style="margin-top:6px">Computed server-side; not affected by filters.</div>');
}
function renderCorrStrip(res) {
  const host = ensureHost('corr-strip', 'tab-correlation', { cls: 'vc-card vc-section' }); if (!host) return; host.innerHTML = '';
  const data = res.strip.slice().sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0)), P = pal();
  const W = Math.max(420, host.clientWidth || 640), rowH = 30, m = { top: 24, right: 110, bottom: 26, left: 150 }, ih = data.length * rowH, iw = W - m.left - m.right;
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, ih + m.top + m.bottom]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleLinear().domain([-1, 1]).range([0, iw]), y = d3.scaleBand().domain(data.map(d => d.key)).range([0, ih]).padding(0.28);
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).ticks(8).tickFormat(d3.format('+.1f')))
    .call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10)).call(a => a.selectAll('line,path').attr('stroke', P.grid));
  g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', -6).attr('y2', ih).attr('stroke', P.axis).attr('stroke-dasharray', '3,3');
  g.append('text').attr('x', 0).attr('y', -10).attr('font-size', 10).attr('fill', P.axis).text('◀ moves against Sentiment');
  g.append('text').attr('x', iw).attr('y', -10).attr('text-anchor', 'end').attr('font-size', 10).attr('fill', P.axis).text('moves with Sentiment ▶');
  const row = g.selectAll('g.vc-srow').data(data).join('g').attr('class', 'vc-srow').style('cursor', 'pointer')
    .on('mousemove', (e, d) => tip.show(
      `<div class="h">${esc(d.def.label)} ↔ Sentiment %</div><div>Pearson r <b class="vc-mono">${fmtR(d.r)}</b> ${stars(d.p)}</div>` +
      `<div class="s">p ${fmtP(d.p)} · n ${d.n} ${DIM_LABEL[res.unit].toLowerCase()}s</div>` +
      `<div>Expected sign <b>${d.def.hib ? '+' : '−'}</b> · ${d.aligned == null ? 'n/a' : d.aligned ? '✓ aligned' : '✗ counter-intuitive'}</div>` +
      (d.zeroVar ? '<div class="vc-warn">No variance in this slice</div>' : '') + '<div class="s">Click to plot</div>', e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { tip.hide(); S.corr.pair = [d.key, 'sentiment']; renderCorrHeatmap(res); renderCorrScatter(res); });
  row.append('rect').attr('x', -m.left).attr('y', d => y(d.key) - 4).attr('width', W).attr('height', y.bandwidth() + 8).attr('fill', 'transparent');
  row.append('text').attr('x', -10).attr('y', d => y(d.key) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').attr('font-size', 11).attr('fill', P.ink).text(d => d.def.label);
  row.append('rect').attr('y', d => y(d.key)).attr('height', y.bandwidth()).attr('rx', 3).attr('x', x(0)).attr('width', 0)
    .attr('fill', d => d.aligned == null ? P.grid : d.aligned ? P.good : P.bad).attr('opacity', d => isNum(d.p) && d.p < 0.05 ? 1 : 0.45)
    .transition().duration(REDUCED ? 0 : 500)
    .attr('x', d => isNum(d.r) ? Math.min(x(0), x(d.r)) : x(0)).attr('width', d => isNum(d.r) ? Math.abs(x(d.r) - x(0)) : 0);
  row.append('text').attr('class', 'vc-mono').attr('y', d => y(d.key) + y.bandwidth() / 2 + 4).attr('font-size', 11)
    .attr('x', d => isNum(d.r) ? x(d.r) + (d.r >= 0 ? 6 : -6) : x(0) + 6).attr('text-anchor', d => isNum(d.r) && d.r < 0 ? 'end' : 'start')
    .attr('fill', d => d.aligned === false ? P.bad : P.ink)
    .text(d => isNum(d.r) ? fmtR(d.r) + stars(d.p) + (d.aligned === false ? ' ✗' : ' ✓') : (d.zeroVar ? 'no variance' : 'n/a'));
}
function renderCorrHeatmap(res) {
  const host = ensureHost('corr-heatmap', 'tab-correlation', { cls: 'vc-card vc-section' }); if (!host) return; host.innerHTML = '';
  const keys = CORR_KEYS, n = keys.length, P = pal();
  const W = Math.max(380, Math.min(host.clientWidth || 560, 680)), m = { top: 10, right: 10, bottom: 110, left: 130 };
  const size = Math.min((W - m.left - m.right) / n, 58);
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, m.left + size * n + m.right, m.top + size * n + m.bottom]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const color = d3.scaleDiverging(d3.interpolateRdBu).domain([-1, 0, 1]);
  const cells = []; keys.forEach((a, i) => keys.forEach((b, j) => cells.push({ a, b, i, j, c: res.matrix[i][j] })));
  const isPair = d => (S.corr.pair[0] === d.a && S.corr.pair[1] === d.b) || (S.corr.pair[0] === d.b && S.corr.pair[1] === d.a);
  g.selectAll('rect').data(cells).join('rect')
    .attr('x', d => d.j * size).attr('y', d => d.i * size).attr('width', size - 2).attr('height', size - 2).attr('rx', 4)
    .attr('fill', d => isNum(d.c.r) ? color(d.c.r) : P.grid).attr('stroke', d => isPair(d) ? P.ink : 'none').attr('stroke-width', 2)
    .style('cursor', d => d.a === d.b ? 'default' : 'pointer')
    .on('mousemove', (e, d) => tip.show(`<div class="h">${esc(DEF[d.a].label)} × ${esc(DEF[d.b].label)}</div><div>r <b class="vc-mono">${fmtR(d.c.r)}</b> ${stars(d.c.p)}</div><div class="s">p ${fmtP(d.c.p)} · n ${d.c.n}</div>${d.c.zeroVar ? '<div class="vc-warn">No variance</div>' : ''}`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => {
      if (d.a === d.b) return;
      tip.hide();
      S.corr.pair = d.a === 'sentiment' ? [d.b, 'sentiment'] : d.b === 'sentiment' ? [d.a, 'sentiment'] : [d.b, d.a];
      renderCorrHeatmap(res); renderCorrScatter(res);
    });
  g.selectAll('text.v').data(cells).join('text').attr('class', 'v vc-mono')
    .attr('x', d => d.j * size + (size - 2) / 2).attr('y', d => d.i * size + (size - 2) / 2 + 4).attr('text-anchor', 'middle')
    .attr('font-size', Math.max(8, size / 4.8)).attr('pointer-events', 'none')
    .attr('fill', d => isNum(d.c.r) && Math.abs(d.c.r) > 0.55 ? '#FFFFFF' : '#0F172A')
    .text(d => isNum(d.c.r) ? d.c.r.toFixed(2) : '–');
  g.selectAll('text.rl').data(keys).join('text').attr('class', 'rl').attr('x', -8).attr('y', (d, i) => i * size + size / 2 + 3)
    .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', d => d === 'sentiment' ? P.warn : P.axis).text(d => DEF[d].label);
  g.selectAll('text.cl').data(keys).join('text').attr('class', 'cl')
    .attr('transform', (d, i) => `translate(${i * size + size / 2},${n * size + 8}) rotate(-45)`)
    .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', d => d === 'sentiment' ? P.warn : P.axis).text(d => DEF[d].label);
}
function renderCorrScatter(res) {
  const host = ensureHost('corr-scatter', 'tab-correlation', { cls: 'vc-card vc-section' }); if (!host) return; host.innerHTML = '';
  const [kx, ky] = S.corr.pair, dx = DEF[kx], dy = DEF[ky], P = pal();
  const pts = res.rows.filter(r => isNum(r[kx]) && isNum(r[ky])), st = pearson(res.rows, kx, ky);
  const titleHtml = `${esc(dx.label)} → ${esc(dy.label)} <span class="vc-sub vc-mono">r ${fmtR(st.r)}${stars(st.p)} · R² ${isNum(st.r) ? (st.r * st.r * 100).toFixed(1) + '%' : '—'} · n ${st.n} ${DIM_LABEL[res.unit].toLowerCase()}s</span>`;
  const tEl = $('corr-scatter-title');
  if (tEl) tEl.innerHTML = titleHtml; else host.insertAdjacentHTML('beforeend', `<div class="vc-sec-h"><span>${titleHtml}</span></div>`);
  if (pts.length < 3) { host.insertAdjacentHTML('beforeend', '<div class="vc-empty">Not enough units with data. Lower the minimum or pick another unit.</div>'); return; }

  const W = Math.max(380, host.clientWidth || 560), H = 320, m = { top: 14, right: 20, bottom: 42, left: 58 }, iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, H]).attr('width', '100%');
  const clipId = 'vc-clip-' + Math.random().toString(36).slice(2, 8);
  svg.append('defs').append('clipPath').attr('id', clipId).append('rect').attr('width', iw).attr('height', ih);
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleLinear().domain(d3.extent(pts, d => d[kx])).nice().range([0, iw]);
  const y = d3.scaleLinear().domain(d3.extent(pts, d => d[ky])).nice().range([ih, 0]);
  const ax = s => s.call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10)).call(a => a.selectAll('line,path').attr('stroke', P.grid));
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(axisFmt(dx))).call(ax);
  g.append('g').call(d3.axisLeft(y).ticks(6).tickFormat(axisFmt(dy))).call(ax);
  g.append('text').attr('x', iw / 2).attr('y', ih + 34).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', P.axis).text(dx.label);
  g.append('text').attr('transform', 'rotate(-90)').attr('x', -ih / 2).attr('y', -44).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', P.axis).text(dy.label);

  const Wt = d3.sum(pts, p => p.n), mx = d3.sum(pts, p => p.n * p[kx]) / Wt, my = d3.sum(pts, p => p.n * p[ky]) / Wt;
  const sxx = d3.sum(pts, p => p.n * (p[kx] - mx) ** 2), sxy = d3.sum(pts, p => p.n * (p[kx] - mx) * (p[ky] - my));
  if (sxx > 0) {
    const sl = sxy / sxx, [x0, x1] = x.domain();
    g.append('line').attr('clip-path', `url(#${clipId})`).attr('x1', x(x0)).attr('y1', y(my + sl * (x0 - mx))).attr('x2', x(x1)).attr('y2', y(my + sl * (x1 - mx)))
      .attr('stroke', P.warn).attr('stroke-width', 2).attr('stroke-dasharray', '6,4');
  }
  const yd = y.domain(), xd = x.domain();
  if (dy.target != null && dy.target >= yd[0] && dy.target <= yd[1]) g.append('line').attr('x1', 0).attr('x2', iw).attr('y1', y(dy.target)).attr('y2', y(dy.target)).attr('stroke', P.good).attr('stroke-opacity', 0.6);
  if (dx.target != null && dx.target >= xd[0] && dx.target <= xd[1]) g.append('line').attr('x1', x(dx.target)).attr('x2', x(dx.target)).attr('y1', 0).attr('y2', ih).attr('stroke', P.good).attr('stroke-opacity', 0.6);

  const out = new Set(res.outliers.filter(o => o.key === kx || o.key === ky).map(o => o.id));
  const rS = d3.scaleSqrt().domain([0, d3.max(pts, d => d.n) || 1]).range([3, 14]);
  g.selectAll('circle').data(pts).join('circle')
    .attr('cx', d => x(d[kx])).attr('cy', d => y(d[ky])).attr('r', d => rS(d.n))
    .attr('fill', d => out.has(d.id) ? P.bad : P.cyan).attr('fill-opacity', 0.65)
    .attr('stroke', d => d.sel ? P.ink : out.has(d.id) ? P.bad : 'none').attr('stroke-width', d => d.sel ? 2 : 1).style('cursor', 'pointer')
    .on('mousemove', (e, d) => tip.show(
      `<div class="h">${esc(DIM_LABEL[res.unit])}: ${esc(d.id)}</div><div>${esc(dx.label)} <b class="vc-mono">${fmtV(dx, d[kx])}</b></div>` +
      `<div>${esc(dy.label)} <b class="vc-mono">${fmtV(dy, d[ky])}</b></div>` +
      `<div class="s">Scored cases ${Math.round(d.n).toLocaleString()}${out.has(d.id) ? ' · <span class="vc-bad">outlier</span>' : ''} · click to ${d.sel ? 'remove' : 'add'} filter</div>`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { tip.hide(); toggleFilter(res.unit, d.id); });
}
function renderOutliers(res) {
  const badge = $('corr-outliers-badge');
  if (badge) badge.textContent = `${res.outliers.length} flagged · ${DIM_LABEL[res.unit]} level`;
  const body = $('corr-outliers-body'); if (!body) return;
  const tbl = body.closest('table'); if (tbl) tbl.classList.add('vc-table');
  body.innerHTML = res.outliers.length
    ? res.outliers.slice(0, 30).map(o => {
        const def = DEF[o.key];
        return `<tr><td><span class="vc-tag ${o.better ? 'pos' : 'neg'}">${o.type}</span></td><td>${esc(o.id)}</td><td>${esc(def.label)}</td>` +
          `<td class="r vc-mono">${fmtV(def, o.value)}</td><td class="r vc-mono vc-muted">median ${fmtV(def, o.ref)}</td>` +
          `<td class="r vc-mono ${Math.abs(o.z) >= 5 ? 'vc-bad' : ''}">${o.z > 0 ? '+' : ''}${o.z.toFixed(2)}</td>` +
          `<td class="r vc-mono vc-muted">${Math.round(o.n).toLocaleString()}</td><td class="r vc-mono">${fmtV(DEF.sentiment, o.sentiment)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="8" class="vc-empty">No outliers at robust |z| ≥ 2.5.</td></tr>';
}

/* ═══ 11. WHAT-IF SIMULATOR (2D canvas, no WebGL) ═══ */
function solveSym(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function fitBetas() {
  const k = SIM_LEVERS.length;
  for (const u of ['sub_pod', 'market', 'week', 'region']) {
    const rows = agg(u, u).filter(g => !BLANK_LABELS.has(g.name) && g.s.sent_den >= 30)
      .map(g => ({ w: g.s.sent_den, y: DEF.sentiment.f(g.s), x: SIM_LEVERS.map(L => DEF[L.key].f(g.s)) }))
      .filter(r => isNum(r.y) && r.x.every(isNum));
    if (rows.length < k + 5) continue;
    const W = rows.reduce((a, r) => a + r.w, 0), mu = new Array(k).fill(0), sd = new Array(k).fill(0);
    let my = 0, sy = 0;
    rows.forEach(r => { r.x.forEach((v, j) => { mu[j] += r.w * v / W; }); my += r.w * r.y / W; });
    rows.forEach(r => { r.x.forEach((v, j) => { sd[j] += r.w * (v - mu[j]) ** 2 / W; }); sy += r.w * (r.y - my) ** 2 / W; });
    for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]);
    sy = Math.sqrt(sy);
    if (sy < 1e-9 || sd.some(v => v < 1e-9)) continue;
    const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
    rows.forEach(r => {
      const z = r.x.map((v, j) => (v - mu[j]) / sd[j]), zy = (r.y - my) / sy;
      for (let a = 0; a < k; a++) { b[a] += r.w * z[a] * zy / W; for (let c = 0; c < k; c++) A[a][c] += r.w * z[a] * z[c] / W; }
    });
    for (let a = 0; a < k; a++) A[a][a] += 0.1;
    const bs = solveSym(A, b); if (!bs) continue;
    let sse = 0, sst = 0;
    rows.forEach(r => {
      const z = r.x.map((v, j) => (v - mu[j]) / sd[j]), zy = (r.y - my) / sy, yh = z.reduce((a, v, j) => a + v * bs[j], 0);
      sse += r.w * (zy - yh) ** 2; sst += r.w * zy * zy;
    });
    const beta = {}; SIM_LEVERS.forEach((L, j) => { beta[L.key] = bs[j] * sy / sd[j]; });
    return { beta, unit: u, n: rows.length, r2: sst > 0 ? Math.max(0, 1 - sse / sst) : 0 };
  }
  return null;
}
function simNote() {
  const f = S.sim.fit;
  if (S.sim.src === 'fit') return `Weighted ridge fit across ${f.n} ${DIM_LABEL[f.unit].toLowerCase()}s in the current scope (R² ${(f.r2 * 100).toFixed(0)}%). Refits whenever filters change. Directional, not a forecast.`;
  if (S.sim.src === 'server') return 'Too few groups in scope to refit, so server coefficients are used. Directional, not a forecast.';
  return 'Too little data in scope to fit a model, so neutral defaults are used. Widen the filters for a fitted view.';
}
function renderSimulator() {
  ensureHost('sim-controls', 'tab-simulator', { prepend: true });
  ['sim-sliders', 'sim-canvas', 'sim-readout', 'sim-contrib'].forEach(id => ensureHost(id, 'tab-simulator', { cls: 'vc-card vc-section' }));
  const tot = agg(), srv = ((S.payload.simulator || {}).beta) || {}, fit = fitBetas();
  const FALLBACK = { irt: 0.3, reopen: -0.3, escRate: -1.0 };
  S.sim.fit = fit;
  S.sim.src = fit ? 'fit' : SIM_LEVERS.some(L => isNum(srv[L.beta]) && srv[L.beta] !== 0) ? 'server' : 'default';
  if (fit) console.info('[VectorCore] simulator fit', fit);
  S.sim.baseSent = DEF.sentiment.f(tot);
  S.sim.levers = SIM_LEVERS.map(L => {
    const b0 = DEF[L.key].f(tot), base = isNum(b0) ? b0 : (L.lo + L.hi) / 2;
    const b = S.sim.src === 'fit' ? fit.beta[L.key] : S.sim.src === 'server' ? (+srv[L.beta] || 0) : FALLBACK[L.key];
    return { ...L, lo: Math.min(L.lo, base), hi: Math.max(L.hi, base), base, cur: base, b, contrib: 0 };
  });
  const ctl = $('sim-controls');
  if (ctl) ctl.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:13px"><span class="vc-ctl">Scenario</span>` +
    [['baseline', '↺ Baseline'], ['targets', '🎯 All targets'], ['stretch', '🏆 Stretch'], ['stress', '🔥 Stress']]
      .map(([k, l]) => `<button type="button" class="vc-btn" data-vc-sim-preset="${k}">${l}</button>`).join('') +
    `<button type="button" class="vc-btn" onclick="exportScenarioToSheets()">⬇ CSV</button></div>`;
  const sl = $('sim-sliders');
  if (sl) sl.innerHTML = S.sim.levers.map((L, i) => {
    const def = DEF[L.key];
    return `<div class="vc-sim-row">` +
      `<div class="vc-sim-head"><span>${esc(def.label)} <span class="vc-muted">${def.hib ? '↑' : '↓'}</span></span><span class="vc-mono" id="vc-sim-val-${i}">${fmtV(def, L.cur)}</span></div>` +
      `<input type="range" data-vc-sim="${i}" id="vc-sim-in-${i}" min="${L.lo}" max="${L.hi}" step="${L.step}" value="${L.cur}">` +
      `<div class="vc-sim-foot"><span>Baseline ${fmtV(def, L.base)}${def.target != null ? ' · 🎯 ' + fmtV(def, def.target) : ''}</span><span class="vc-mono" id="vc-sim-imp-${i}">±0.0 pp</span></div>` +
    `</div>`;
  }).join('') + `<div class="vc-note">Sentiment change per 1.0 of each lever: ${S.sim.levers.map(L => `${esc(DEF[L.key].label)} <b class="vc-mono">${L.b >= 0 ? '+' : ''}${L.b.toFixed(3)}</b>`).join(' · ')}</div>`;
  updateSim();
  startReactor();
}
function applySimPreset(p) {
  const T = { irt: 0.92, reopen: 0.14, escRate: 0.012 }, X = { irt: 0.95, reopen: 0.10, escRate: 0.008 }, Wst = { irt: 0.80, reopen: 0.30, escRate: 0.02 };
  S.sim.levers.forEach((L, i) => {
    let v = L.base;
    if (p === 'targets') v = T[L.key];
    if (p === 'stretch') v = X[L.key];
    if (p === 'stress') v = Wst[L.key];
    L.cur = Math.max(L.lo, Math.min(L.hi, v));
    const inp = $('vc-sim-in-' + i); if (inp) inp.value = L.cur;
  });
  updateSim();
}
function simPredict() {
  if (!isNum(S.sim.baseSent)) return null;
  return clamp01(S.sim.baseSent + S.sim.levers.reduce((a, L) => a + L.b * (L.cur - L.base), 0));
}
function updateSim() {
  const pred = simPredict(), base = S.sim.baseSent, def = DEF.sentiment;
  S.sim.pred = pred;
  S.sim.levers.forEach((L, i) => {
    L.contrib = L.b * (L.cur - L.base);
    const v = $('vc-sim-val-' + i); if (v) v.textContent = fmtV(DEF[L.key], L.cur);
    const im = $('vc-sim-imp-' + i);
    if (im) { im.textContent = fmtPP(L.contrib); im.className = 'vc-mono ' + (L.contrib > 5e-4 ? 'vc-good' : L.contrib < -5e-4 ? 'vc-bad' : 'vc-muted'); }
  });
  const d = isNum(pred) && isNum(base) ? pred - base : null, gap = isNum(pred) ? pred - def.target : null;
  const paths = isNum(gap) && gap < 0
    ? S.sim.levers.filter(L => Math.abs(L.b) > 1e-9).map(L => ({ L, need: L.cur + (-gap) / L.b }))
        .filter(x => x.need >= 0 && x.need <= 1)
        .sort((a, b) => Math.abs(a.need - a.L.cur) / ((a.L.hi - a.L.lo) || 1) - Math.abs(b.need - b.L.cur) / ((b.L.hi - b.L.lo) || 1))
    : [];
  const ro = $('sim-readout');
  if (ro) ro.innerHTML =
    `<div class="vc-pred-l">Predicted Sentiment %</div>` +
    `<div class="vc-pred vc-mono ${tone(tgtStatus(def, pred))}">${fmtV(def, pred)}</div>` +
    `<div class="vc-pred-meta"><span>Now <b class="vc-mono">${fmtV(def, base)}</b></span>` +
      `<span class="${tone(isNum(d) ? (d > 5e-4 ? 1 : d < -5e-4 ? -1 : 0) : 0)}">Δ <b class="vc-mono">${fmtPP(d)}</b></span>` +
      `<span class="${tone(isNum(gap) ? (gap >= 0 ? 1 : -1) : 0)}">vs 🎯 <b class="vc-mono">${fmtPP(gap)}</b></span></div>` +
    (paths.length ? `<div class="vc-ins-t" style="margin-top:14px">➡️ Single-lever path to target</div><ul class="vc-list">${paths.map(x => `<li><span>${esc(DEF[x.L.key].label)}</span><b class="vc-mono">${fmtV(DEF[x.L.key], x.need)}</b></li>`).join('')}</ul>` : '') +
    `<div class="vc-note">${simNote()}</div>`;
  const ch = $('sim-contrib');
  if (ch) {
    const mx = Math.max(0.005, ...S.sim.levers.map(L => Math.abs(L.contrib || 0))), P = pal();
    ch.innerHTML = S.sim.levers.map(L => {
      const c = L.contrib || 0, w = Math.abs(c) / mx * 50;
      return `<div class="vc-contrib"><span>${esc(DEF[L.key].label)}</span>` +
        `<div class="vc-contrib-track"><b></b><i style="${c >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`};background:${c >= 0 ? P.good : P.bad}"></i></div>` +
        `<span class="vc-mono ${c >= 0 ? 'vc-good' : 'vc-bad'}" style="text-align:right">${fmtPP(c)}</span></div>`;
    }).join('');
  }
}
function startReactor() {
  const host = $('sim-canvas'); if (!host || S.tab !== 'simulator') return;
  if (!S.sim.canvas || !host.contains(S.sim.canvas)) {
    host.innerHTML = '';
    const c = document.createElement('canvas');
    host.appendChild(c);
    S.sim.canvas = c;
    S.sim.anim = { core: 0.5, t0: performance.now() };
  }
  { const w0 = host.clientWidth || 600; host.style.height = Math.max(322, Math.min(610, Math.round(w0 / 1.618))) + 'px'; }
  const c = S.sim.canvas, dpr = Math.min(2, window.devicePixelRatio || 1), W = host.clientWidth || 600, H = host.clientHeight || 380;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  if (S.raf) return;
  const loop = () => {
    if (S.tab !== 'simulator') { S.raf = null; return; }
    drawReactor();
    S.raf = requestAnimationFrame(loop);
  };
  S.raf = requestAnimationFrame(loop);
}
function stopReactor() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; } }
function drawReactor() {
  const c = S.sim.canvas; if (!c || !S.sim.anim) return;
  const ctx = c.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1), W = c.width / dpr, H = c.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const t = REDUCED ? 0 : (performance.now() - S.sim.anim.t0) / 1000, P = pal(), def = DEF.sentiment;
  const pred = isNum(S.sim.pred) ? S.sim.pred : 0, tgt = def.target;
  S.sim.anim.core += (pred - S.sim.anim.core) * 0.08;
  const cx = W / 2, cy = H * 0.38, R = Math.min(W, H) * 0.26, rOf = v => R * (0.25 + 0.75 * clamp01(v));
  const col = pred >= tgt ? P.good : pred >= tgt - 0.03 ? P.warn : P.bad;

  ctx.strokeStyle = 'rgba(148,163,184,.08)'; ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2); ctx.stroke(); }

  const rc = rOf(S.sim.anim.core);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc * 1.8);
  halo.addColorStop(0, hexA(col, 0.35)); halo.addColorStop(1, 'rgba(2,6,23,0)');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, rc * 1.8, 0, Math.PI * 2); ctx.fill();

  ctx.setLineDash([5, 5]); ctx.strokeStyle = hexA(P.good, 0.8); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, rOf(tgt), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);

  for (let k = 0; k < 3; k++) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * (0.3 + k * 0.15) + k * 2.1);
    ctx.strokeStyle = hexA(P.cyan, 0.25); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, R * (0.9 + k * 0.12), R * (0.32 + k * 0.06), 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = P.cyan; ctx.beginPath(); ctx.arc(R * (0.9 + k * 0.12), 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const cg = ctx.createRadialGradient(cx - rc * 0.3, cy - rc * 0.3, rc * 0.1, cx, cy, rc);
  cg.addColorStop(0, '#FFFFFF'); cg.addColorStop(0.35, col); cg.addColorStop(1, '#0F172A');
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, rc, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.font = '700 20px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(fmtV(def, S.sim.pred), cx, cy);
  ctx.font = '11px ui-monospace,Menlo,monospace'; ctx.fillStyle = '#94A3B8';
  ctx.fillText('target ' + fmtV(def, tgt), cx, cy + rOf(tgt) + 14);

  const n = S.sim.levers.length, pw = Math.min(90, W / (n * 2.2)), baseY = H - 28, maxH = H * 0.24;
  S.sim.levers.forEach((L, i) => {
    const ld = DEF[L.key];
    let h = (L.cur - L.lo) / ((L.hi - L.lo) || 1); if (!ld.hib) h = 1 - h; h = clamp01(h);
    L._h = (L._h ?? h) + (h - (L._h ?? h)) * 0.1;
    const x = W / 2 + (i - (n - 1) / 2) * pw * 1.6 - pw / 2;
    const fill = (L.contrib || 0) > 5e-4 ? P.good : (L.contrib || 0) < -5e-4 ? P.bad : '#64748B';
    ctx.fillStyle = 'rgba(51,65,85,.35)'; ctx.fillRect(x, baseY - maxH, pw, maxH);
    ctx.fillStyle = fill; ctx.fillRect(x, baseY - maxH * L._h, pw, maxH * L._h);
    ctx.fillStyle = '#E2E8F0'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '10px system-ui,sans-serif'; ctx.fillText(ld.label, x + pw / 2, baseY + 14);
    ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.fillText(fmtV(ld, L.cur), x + pw / 2, baseY - maxH * L._h - 6);
  });
}

/* ═══ 12. CASE LEVEL DATA (server-paginated, filter-aware) ═══ */
const CASE_MODES = {
  scored:     { label: 'Scored',             source: 'sentiment', params: { scored_only: 'true' } },
  detractors: { label: 'Detractors',         source: 'sentiment', params: { detractors_only: 'true' } },
  sentiment:  { label: 'All sentiment rows', source: 'sentiment', params: {} },
  irt:        { label: 'IRT',                source: 'irt',       params: {} },
  irt_miss:   { label: 'IRT misses',         source: 'irt',       params: { irt_missed: 'true' } },
  esc:        { label: 'Escalations',        source: 'esc',       params: {} }
};
const CASE_LONG = new Set(['explanation', 'summary']);

function casesHosts() {
  const tab = $('tab-cases'); if (!tab) return false;
  if (!$('cld-body')) {
    const card = document.createElement('div'); card.className = 'vc-card';
    card.innerHTML = '<div class="vc-sec-h" style="padding:13px 21px 0"><span>Case Level Data</span></div>' +
      '<div id="cld-subtabs"></div><div id="cld-toolbar"></div>' +
      '<div class="vc-case-wrap"><table class="vc-table"><thead><tr id="cld-head-row"></tr></thead><tbody id="cld-body"></tbody></table></div>' +
      '<div id="cld-pager"></div>';
    tab.appendChild(card);
  }
  const body = $('cld-body'), tbl = body.closest('table'), wrap = tbl.parentElement;
  tbl.classList.add('vc-table'); wrap.classList.add('vc-case-wrap');
  if (!$('cld-subtabs')) { const d = document.createElement('div'); d.id = 'cld-subtabs'; wrap.parentElement.insertBefore(d, wrap); }
  if (!$('cld-toolbar')) { const d = document.createElement('div'); d.id = 'cld-toolbar'; wrap.parentElement.insertBefore(d, wrap); }
  if (!$('cld-pager') && !document.querySelector('[data-pager="cld"]')) { const d = document.createElement('div'); d.id = 'cld-pager'; wrap.parentElement.insertBefore(d, wrap.nextSibling); }
  if (!S.cases.bound) {
    S.cases.bound = true;
    tab.addEventListener('click', e => {
      const t = e.target; if (!(t instanceof Element)) return;
      const so = t.closest('[data-vc-sort]');
      if (so) {
        const k = so.dataset.vcSort;
        if (S.cases.sort === k) S.cases.dir = S.cases.dir === 'asc' ? 'desc' : 'asc'; else { S.cases.sort = k; S.cases.dir = 'desc'; }
        S.cases.page = 1; loadCases(); return;
      }
      if (t.closest('[data-vc-case-retry]')) { loadCases(); return; }
      if (t.closest('[data-vc-case-export]')) { exportCasesScope(); return; }
      const row = t.closest('[data-vc-case-row]');
      if (row && !t.closest('a')) { const i = +row.dataset.vcCaseRow; S.cases.open = S.cases.open === i ? null : i; renderCaseBody(); }
    });
    tab.addEventListener('change', e => {
      const t = e.target;
      if (t && t.id === 'vc-case-jump') {
        const tp = Math.max(1, Math.ceil(S.cases.total / S.cases.size));
        S.cases.page = Math.min(tp, Math.max(1, parseInt(t.value, 10) || 1)); loadCases();
      }
    });
  }
  return true;
}
function renderCasesToolbar() {
  if (!CASE_MODES[S.cases.mode]) S.cases.mode = 'scored';
  const sub = $('cld-subtabs');
  if (sub) {
    sub.classList.add('vc-case-tabs');
    sub.innerHTML = Object.entries(CASE_MODES).map(([k, v]) => `<button type="button" class="vc-btn ${S.cases.mode === k ? 'is-on' : ''}" data-vc-case-mode="${k}">${v.label}</button>`).join('');
  }
  const tb = $('cld-toolbar'); if (!tb) return;
  tb.classList.add('vc-case-bar');
  if (tb.dataset.vcv !== '4') {
    tb.dataset.vcv = '4';
    tb.innerHTML =
      `<input id="vc-case-q" class="vc-input" type="search" placeholder="Search case ID or agent…">` +
      `<label class="vc-ctl">Rows <select id="vc-case-size" class="vc-select">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>` +
      `<span id="vc-case-scope" class="vc-case-scope"></span>` +
      `<span id="vc-case-count" class="vc-mono vc-muted" style="font-size:11px"></span>` +
      `<button type="button" class="vc-btn" onclick="exportCaseLevelToSheets()">⬇ Page CSV</button>` +
      `<button type="button" class="vc-btn" data-vc-case-export>⬇ Scope CSV (≤10k)</button>`;
    $('vc-case-q').addEventListener('input', debounce(e => { S.cases.q = e.target.value.trim(); S.cases.page = 1; loadCases(); }, 300));
  }
  const q = $('vc-case-q'); if (q && document.activeElement !== q) q.value = S.cases.q || '';
  const sz = $('vc-case-size'); if (sz) sz.value = String(S.cases.size);
}
function caseScopeText() {
  const parts = DIMS.filter(d => S.filters[d].size).map(d => {
    const n = [...S.filters[d]].map(i => S.C.labels[d][i]);
    return `${DIM_LABEL[d]}: ${n.length > 2 ? n.length + ' selected' : n.join(', ')}`;
  });
  return parts.length ? parts.join(' · ') : 'All data';
}
function caseQuery(page, size) {
  const st = S.cases, mode = CASE_MODES[st.mode], flt = {};
  DIMS.forEach(d => { if (S.filters[d].size) flt[d] = [...S.filters[d]].map(i => S.C.labels[d][i]); });
  const qs = new URLSearchParams({ source: mode.source, page, page_size: size, filters: JSON.stringify(flt), q: st.q || '' });
  Object.entries(mode.params).forEach(([k, v]) => qs.set(k, v));
  if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir || 'desc'); }
  return qs;
}
function fetchCases(qs, signal) {
  return fetch(API_CASES + '?' + qs.toString(), { signal })
    .then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(j => { throw new Error(j.detail || ('HTTP ' + r.status)); }));
}
function caseCell(k, v) {
  if (v === null || v === undefined || v === '') return '<span class="vc-muted">—</span>';
  switch (k) {
    case 'case_id': return `<a class="vc-link vc-mono" href="https://cases.connect.corp.google.com/#/case/${encodeURIComponent(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
    case 'positive': return +v >= 1 ? '<span class="vc-tag pos">Positive</span>' : '<span class="vc-tag neg">Detractor</span>';
    case 'scored': return +v >= 1 ? '<span class="vc-tag pos">Yes</span>' : '<span class="vc-tag na">No</span>';
    case 'irt_met': return +v >= 1 ? '<span class="vc-tag pos">Met</span>' : '<span class="vc-tag neg">Missed</span>';
    case 'reopened': return +v >= 1 ? '<span class="vc-tag neg">Reopened</span>' : '<span class="vc-tag na">No</span>';
    case 'irt_hours': return isNum(+v) ? `<span class="vc-mono">${(+v).toFixed(1)} h</span>` : esc(v);
    case 'explanation': case 'summary': { const s = String(v); return `<span class="vc-case-snip">${esc(s.length > 89 ? s.slice(0, 88) + '…' : s)}</span>`; }
  }
  if (typeof v === 'number') return `<span class="vc-mono">${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)}</span>`;
  return `<span title="${esc(v)}">${esc(v)}</span>`;
}
function renderCaseHead() {
  const st = S.cases, head = $('cld-head-row'); if (!head) return;
  head.innerHTML = st.keys.map((k, i) => {
    const sortable = !CASE_LONG.has(k), on = st.sort === k;
    if (!sortable) return `<th>${esc(st.labels[i])}</th>`;
    return `<th data-vc-sort="${esc(k)}" class="vc-sortable${on ? ' is-on' : ''}" title="Sort by ${esc(st.labels[i])}">${esc(st.labels[i])} <span class="vc-arrow">${on ? (st.dir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  }).join('');
}
function renderCaseBody() {
  const st = S.cases, body = $('cld-body'); if (!body) return;
  const keys = st.keys, iScored = keys.indexOf('scored');
  const longIdx = keys.map((k, i) => (CASE_LONG.has(k) ? i : -1)).filter(i => i >= 0);
  if (!st.raw.length) {
    body.innerHTML = `<tr><td colspan="${Math.max(1, keys.length)}" class="vc-empty">No rows match this scope${st.q ? ' and search' : ''}.</td></tr>`;
    return;
  }
  body.innerHTML = st.raw.map((r, ri) => {
    const hasText = longIdx.some(i => r[i]), open = st.open === ri;
    const cells = keys.map((k, i) => (k === 'positive' && iScored >= 0 && +r[iScored] !== 1)
      ? '<td><span class="vc-tag na">Not scored</span></td>' : `<td>${caseCell(k, r[i])}</td>`).join('');
    let html = hasText
      ? `<tr data-vc-case-row="${ri}" class="vc-case-row${open ? ' is-open' : ''}" title="Click to ${open ? 'collapse' : 'read'} the narrative">${cells}</tr>`
      : `<tr>${cells}</tr>`;
    if (hasText && open) {
      html += `<tr class="vc-case-detail"><td colspan="${keys.length}">` +
        longIdx.filter(i => r[i]).map(i => `<div class="vc-ins-t">${esc(st.labels[i])}</div><div class="vc-case-text">${esc(r[i])}</div>`).join('') +
        `</td></tr>`;
    }
    return html;
  }).join('');
}
function loadCases() {
  if (!casesHosts()) return;
  renderCasesToolbar();
  const st = S.cases, mode = CASE_MODES[st.mode];
  if (st.lastSource !== mode.source) { st.sort = ''; st.dir = 'desc'; st.lastSource = mode.source; }
  st.open = null; st.keys = st.keys || []; st.raw = st.raw || [];
  const body = $('cld-body'), cols = Math.max(1, st.keys.length);
  body.innerHTML = `<tr><td colspan="${cols}" class="vc-empty">Loading…</td></tr>`;
  const sc = $('vc-case-scope'); if (sc) { sc.textContent = caseScopeText(); sc.title = sc.textContent; }
  if (st.ctl) st.ctl.abort();
  const ctl = new AbortController(); st.ctl = ctl;
  const t0 = performance.now();
  fetchCases(caseQuery(st.page, st.size), ctl.signal)
    .then(data => {
      st.keys = data.keys || []; st.labels = data.labels || st.keys; st.raw = data.rows || []; st.total = +data.total || 0;
      const tp = Math.max(1, Math.ceil(st.total / st.size));
      if (st.total && st.page > tp) { st.page = tp; loadCases(); return; }
      renderCaseHead(); renderCaseBody(); renderPager();
      const cnt = $('vc-case-count'); if (cnt) cnt.textContent = `${st.total.toLocaleString()} rows · ${Math.round(performance.now() - t0)} ms`;
    })
    .catch(err => {
      if (err.name === 'AbortError') return;
      body.innerHTML = `<tr><td colspan="${cols}" class="vc-empty vc-bad">Failed to load: ${esc(err.message)} <button type="button" class="vc-btn" data-vc-case-retry style="margin-left:8px">Retry</button></td></tr>`;
    });
}
function renderPager() {
  const host = $('cld-pager') || document.querySelector('[data-pager="cld"]'); if (!host) return;
  const st = S.cases, tp = Math.max(1, Math.ceil(st.total / st.size));
  const from = st.total ? (st.page - 1) * st.size + 1 : 0, to = Math.min(st.page * st.size, st.total);
  host.className = 'vc-pager';
  host.innerHTML = `<span>Showing <b class="vc-mono">${from.toLocaleString()}–${to.toLocaleString()}</b> of <b class="vc-mono">${st.total.toLocaleString()}</b></span>` +
    `<div style="display:flex;gap:8px;align-items:center">` +
      `<button type="button" class="vc-btn" data-vc-page="first" ${st.page <= 1 ? 'disabled' : ''}>«</button>` +
      `<button type="button" class="vc-btn" data-vc-page="-1" ${st.page <= 1 ? 'disabled' : ''}>‹ Prev</button>` +
      `<span class="vc-ctl">Page <input id="vc-case-jump" class="vc-input vc-mono" type="number" min="1" max="${tp}" value="${st.page}" style="width:68px"> of ${tp.toLocaleString()}</span>` +
      `<button type="button" class="vc-btn" data-vc-page="1" ${st.page >= tp ? 'disabled' : ''}>Next ›</button>` +
      `<button type="button" class="vc-btn" data-vc-page="last" ${st.page >= tp ? 'disabled' : ''}>»</button>` +
    `</div>`;
}
async function exportCasesScope() {
  const st = S.cases, MAXR = 10000, size = 200;
  if (!st.total) { toast('Nothing to export'); return; }
  const pages = Math.min(Math.ceil(st.total / size), MAXR / size), rows = [];
  let labels = st.labels;
  try {
    for (let p = 1; p <= pages; p++) {
      toast(`Exporting… ${Math.min(p * size, st.total, MAXR).toLocaleString()} / ${Math.min(st.total, MAXR).toLocaleString()} rows`, 60000);
      const d = await fetchCases(caseQuery(p, size));
      labels = d.labels || d.keys || labels; rows.push(...(d.rows || []));
    }
    downloadCsv('VectorCore_cases_' + st.mode, labels, rows);
    if (st.total > MAXR) toast(`Exported the first ${MAXR.toLocaleString()} of ${st.total.toLocaleString()} rows. Narrow the filters for the rest.`, 8000);
  } catch (e) { toast('Export failed: ' + e.message, 8000); }
}

/* ═══ 13. EXPORTS (CSV download — no Apps Script needed) + legacy inline handlers ═══ */
function downloadCsv(name, headers, rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [headers, ...rows].map(r => r.map(q).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w.-]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('Downloaded ' + a.download);
}
window.exportKpiMatrixToSheets = function () {
  const v = S.view; if (!v) return;
  downloadCsv('VectorCore_KPI_Matrix', ['Metric', 'Role', 'Target', ...v.per.map(p => p.name), 'Overall'],
    KPIS.map(def => [def.label, def.role, def.target != null ? fmtV(def, def.target) : '', ...v.per.map(p => fmtV(def, def.f(p.s))), fmtV(def, def.f(v.tot))]));
};
window.exportMatrixToSheets = function () {
  downloadCsv('VectorCore_Detractor_Categories', ['Category', 'Detractors', 'Share of scored'],
    (S.payload.cat_tree || []).map(n => [n.name, n.total, isNum(n.share) ? (n.share * 100).toFixed(2) + '%' : '']));
};
window.exportCorrelationToSheets = function () {
  const r = getCorr();
  const rows = CORR_KEYS.map((a, i) => [DEF[a].label, ...CORR_KEYS.map((b, j) => isNum(r.matrix[i][j].r) ? r.matrix[i][j].r.toFixed(4) : '')]);
  rows.push([]); rows.push(['Vehicle', 'Pearson r', 'p-value', 'n', 'Aligned']);
  r.strip.forEach(s => rows.push([s.def.label, isNum(s.r) ? s.r.toFixed(4) : '', isNum(s.p) ? s.p.toFixed(5) : '', s.n, s.aligned == null ? '' : s.aligned ? 'Yes' : 'No']));
  downloadCsv('VectorCore_Correlation_' + DIM_LABEL[r.unit], ['', ...CORR_KEYS.map(k => DEF[k].label)], rows);
};
window.exportScenarioToSheets = function () {
  if (!S.sim.levers.length) return;
  const rows = S.sim.levers.map(L => [DEF[L.key].label, fmtV(DEF[L.key], L.base), fmtV(DEF[L.key], L.cur), fmtPP(L.contrib || 0), L.b.toFixed(4)]);
  rows.push(['Predicted Sentiment %', fmtV(DEF.sentiment, S.sim.baseSent), fmtV(DEF.sentiment, S.sim.pred), '', '']);
  downloadCsv('VectorCore_WhatIf_Scenario', ['Lever', 'Baseline', 'Scenario', 'Contribution', 'Beta'], rows);
};
window.exportCaseLevelToSheets = function () {
  const st = S.cases;
  if (!st.raw || !st.raw.length) { toast('No rows on this page'); return; }
  downloadCsv('VectorCore_cases_' + st.mode + '_page' + st.page, st.labels, st.raw);
};

window.exportModalCasesToSheets = window.exportCaseLevelToSheets;
window.toggleMultiSelectMenu = function (id) {
  const el = $(id); if (!el) return;
  const open = el.classList.contains('hidden');
  closeMenus();
  if (open) el.classList.remove('hidden');
};
window.setCatBreakdownDepth = function (k) { if (k !== 'l1') toast('Only L1 categories are aggregated server-side right now.'); };
window.closeCaseModal = function () { const m = $('caseModal'); if (m) m.classList.add('hidden'); };

/* ═══ 14. THEME, GRANULARITY, TABS ═══ */
function resolveTheme(mode) { if (mode !== 'auto') return mode; const h = new Date().getHours(); return h >= LIGHT_FROM && h < DARK_FROM ? 'light' : 'dark'; }
function applyTheme(mode) {
  if (!['auto', 'light', 'dark'].includes(mode)) mode = 'auto';
  S.theme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* sandboxed storage */ }
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  document.documentElement.setAttribute('data-theme-mode', mode);
  const seg = $('segToggleTheme');
  if (seg) {
    seg.setAttribute('data-val', mode);
    seg.querySelectorAll('.seg-opt').forEach(b => b.classList.toggle('active', (b.dataset.val || b.textContent.trim().toLowerCase()) === mode));
  }
  const hint = $('themeAutoHint'); if (hint) hint.textContent = mode === 'auto' ? 'Auto · ' + resolveTheme(mode) : 'Pinned · ' + mode;
}
function initTheme() {
  let m = 'auto';
  try { m = localStorage.getItem(THEME_KEY) || localStorage.getItem('sentimentRCA.themeMode') || 'auto'; } catch (e) { /* ignore */ }
  applyTheme(m);
  setInterval(() => {
    if (S.theme !== 'auto') return;
    const before = document.documentElement.getAttribute('data-theme');
    applyTheme('auto');
    if (before !== document.documentElement.getAttribute('data-theme') && S.C) { markDirty(); renderVisible(); }
  }, 60000);
}
function setUnit(u) {
  if (u !== 'month' && u !== 'week') return;
  S.unit = u;
  const seg = $('segToggleTime');
  if (seg) { seg.setAttribute('data-val', u); seg.querySelectorAll('.seg-opt').forEach(b => b.classList.toggle('active', b.dataset.val === u)); }
  S.dirty.overview = true;
  renderVisible();
}
function switchTab(t) {
  if (!TABS.includes(t)) return;
  S.tab = t;
  TABS.forEach(k => { const p = $('tab-' + k); if (p) { p.classList.toggle('hidden', k !== t); p.classList.toggle('block', k === t); } });
  document.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  tip.hide();
  if (t !== 'simulator') stopReactor();
  renderVisible();
}
window.switchTab = switchTab;
function markDirty() { Object.keys(S.dirty).forEach(k => { S.dirty[k] = true; }); S.corrCache = null; }
function renderVisible() {
  if (!S.C) return;
  const t = S.tab;
  if (!S.dirty[t]) { if (t === 'simulator') startReactor(); return; }
  S.dirty[t] = false;
  try {
    if (t === 'overview') renderOverview();
    else if (t === 'correlation') renderCorrelation();
    else if (t === 'simulator') renderSimulator();
    else if (t === 'cases') loadCases();
  } catch (e) {
    console.error('[VectorCore] render error in ' + t, e);
    toast('Render error in ' + t + ': ' + e.message, 6000);
  }
}

/* ═══ 15. EVENTS ═══ */
function bindEvents() {
  document.addEventListener('click', e => {
    const t = e.target; if (!(t instanceof Element)) return;
    const msT = t.closest('[data-vc-ms-toggle]'); if (msT) { e.preventDefault(); openMenu(msT); return; }
    const msC = t.closest('[data-vc-ms-clear]');
    if (msC) { const d = msC.dataset.vcMsClear; clearDim(d); const menu = msC.closest('.vc-ms-menu'); if (menu) renderMsList(menu, d); return; }
    const chipX = t.closest('[data-vc-clear-dim]'); if (chipX) { clearDim(chipX.dataset.vcClearDim); return; }
    if (!t.closest('.vc-ms') && !t.closest('.ms-container')) closeMenus();
    const corrChip = t.closest('[data-vc-corr]');
    if (corrChip) { e.stopPropagation(); S.corr.pair = [corrChip.dataset.vcCorr, 'sentiment']; S.dirty.correlation = true; switchTab('correlation'); return; }
    const veh = t.closest('[data-vc-veh]');
    if (veh) {
      S.xKpi = veh.dataset.vcVeh;
      renderBreakdown();
      document.querySelectorAll('[data-vc-veh]').forEach(c => c.classList.toggle('is-sel', c.dataset.vcVeh === S.xKpi));
      const bd = $('vc-breakdown'); if (bd) bd.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' });
      return;
    }
    const tab = t.closest('[data-tab]'); if (tab) { switchTab(tab.dataset.tab); return; }
    const th = t.closest('#segToggleTheme .seg-opt');
    if (th) { applyTheme(th.dataset.val || th.textContent.trim().toLowerCase()); markDirty(); renderVisible(); return; }
    const tm = t.closest('#segToggleTime .seg-opt'); if (tm) { setUnit(tm.dataset.val); return; }
    const sp = t.closest('[data-vc-sim-preset]'); if (sp) { applySimPreset(sp.dataset.vcSimPreset); return; }
    const cm = t.closest('[data-vc-case-mode]'); if (cm) { S.cases.mode = cm.dataset.vcCaseMode; S.cases.page = 1; loadCases(); return; }
    const pg = t.closest('[data-vc-page]');
    if (pg && !pg.disabled) {
      const v = pg.dataset.vcPage, tp = Math.max(1, Math.ceil(S.cases.total / S.cases.size));
      S.cases.page = v === 'first' ? 1 : v === 'last' ? tp : Math.min(tp, Math.max(1, S.cases.page + (+v)));
      loadCases();
    }
  });
  document.addEventListener('change', e => {
    const t = e.target; if (!(t instanceof Element)) return;
    if (t.matches('[data-vc-ms-opt]')) { toggleFilter(t.dataset.vcMsOpt, +t.value); return; }
    if (t.id === 'vc-case-size') { S.cases.size = +t.value; S.cases.page = 1; loadCases(); }
  });
  document.addEventListener('input', e => {
    const t = e.target; if (!(t instanceof Element)) return;
    if (t.matches('[data-vc-ms-search]')) {
      const q = t.value.trim().toLowerCase();
      t.closest('.vc-ms-menu').querySelectorAll('.vc-ms-opt').forEach(o => { o.style.display = o.dataset.label.includes(q) ? '' : 'none'; });
      return;
    }
    if (t.matches('[data-vc-sim]')) { const L = S.sim.levers[+t.dataset.vcSim]; if (L) { L.cur = +t.value; updateSim(); } }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenus(); window.closeCaseModal(); tip.hide(); return; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i >= 0) switchTab(TABS[i]);
  });
  window.addEventListener('resize', debounce(() => { if (!S.C) return; S.dirty[S.tab] = true; renderVisible(); }, 250));
}

/* ═══ 16. BOOT ═══ */
function fetchSummary() {
  return fetch(API_SUMMARY).then(r => { if (!r.ok) throw new Error('API ' + API_SUMMARY + ' returned ' + r.status); return r.json(); });
}
window.boot = function boot() {
  if (S.booted) return;
  S.booted = true;
  injectStyles();
  bindEvents();
  initTheme();
  setLoader('Fetching the pre-aggregated cube…');
  const first = window.__dataPromise ? Promise.resolve(window.__dataPromise) : fetchSummary();
  first.catch(() => fetchSummary())
    .then(data => {
      S.payload = data;
      S.C = buildCube(data);
      console.info(`[VectorCore] cube loaded: ${S.C.n.toLocaleString()} rows · dims: ${DIMS.map(d => d + '=' + S.C.labels[d].length).join(', ')}`);
      mountFilters();
      markDirty();
      switchTab('overview');
      hideLoader();
      window.__booted = true;
    })
    .catch(err => {
      console.error('[VectorCore] boot failed', err);
      setLoader('⚠ ' + err.message, true);
      toast('Failed to load: ' + err.message, 8000);
    });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.boot);
else window.boot();
