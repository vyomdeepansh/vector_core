'use strict';
/* ════════════════════════════════════════════════════════════════════════
   VectorCore · static/js/app.js · v5 (stable)
   Contract: GET /api/v1/vectors/summary →
     { metadata{generated_at, dims?}, cube{rows, columns{dim: idx[]|str[], measure: num[]}},
       cat_tree[], correlations{strip[], n_agents}, simulator{beta{irt, reopen, esc_rate}} }
   • Every KPI = ratio-of-sums over cube rows → exact under any filter combination
   • Dates: day/week → YYYY-MM-DD (2026-01-10) · month → YYYY-MM (2026-01)
   • What-If: weighted ridge (CV-tuned λ, sign constraints, bootstrap band) + Three.js 3D stage
   ════════════════════════════════════════════════════════════════════════ */

/* ═══ 1. CONFIG ═══ */
const API_SUMMARY = '/api/v1/vectors/summary';
const API_CASES = '/api/v1/cases/drilldown';
const THEME_KEY = 'vc.themeMode';               // must match the FOUC guard in index.html
const LIGHT_FROM = 6, DARK_FROM = 18;
const TABS = ['overview', 'correlation', 'simulator', 'cases'];
const DIMS = ['month', 'week', 'sub_pod', 'region', 'market', 'segment'];
const DIM_LABEL = { month: 'Month', week: 'Week', sub_pod: 'Sub Pod', region: 'Region', market: 'Market', segment: 'Segment' };
const MS_MAP = { month: 'month', months: 'month', week: 'week', weeks: 'week', sub_pod: 'sub_pod', pod: 'sub_pod', pods: 'sub_pod', subpods: 'sub_pod', region: 'region', regions: 'region', market: 'market', markets: 'market', segment: 'segment', segments: 'segment' };
const BLANK_LABELS = new Set(['(blank)', '(n/a)']);

const MEAS = ['sent_num', 'sent_den', 'closed', 'reo_num', 'reo_den', 'cht_num', 'cht_den', 'asg_num', 'asg_den',
  'tfr_num', 'tfr_den', 'tta_num', 'tta_den', 'con_num', 'con_den', 'irt_num', 'irt_den', 'esc_num',
  'blk_num', 'blk_den', 'nfo_num', 'nfo_den', 'una_num', 'una_den', 'tfs_num', 'tfs_den', 'new_num', 'new_den',
  'agt_num', 'agt_den', 'int_num', 'int_den', 'cai_num', 'cai_den', 'efc_num', 'efc_den'];

const ratio = (n, d) => (d > 0 ? n / d : null);
const R = (num, den) => s => ratio(s[num], s[den]);

const KPIS = [
  /* North Star */
  { key: 'sentiment', label: 'Sentiment %', role: 'northstar', fmt: 'pct', hib: true, target: 0.70, needs: ['sent_num', 'sent_den'], f: R('sent_num', 'sent_den'), w: s => s.sent_den, desc: 'Case Sentiment Score (% Positive) ÷ SentimentDR' },
  /* Vehicles (8) */
  { key: 'irt', label: 'IRT 24h %', role: 'vehicle', fmt: 'pct', hib: true, target: 0.92, needs: ['irt_num', 'irt_den'], f: R('irt_num', 'irt_den'), w: s => s.irt_den, desc: 'IRT within 24h (%) ÷ IRT (%) Denominator' },
  { key: 'reopen', label: 'Reopen %', role: 'vehicle', fmt: 'pct', hib: false, target: 0.14, needs: ['reo_num', 'reo_den'], f: R('reo_num', 'reo_den'), w: s => s.reo_den, desc: 'Cases Reopened (%) ÷ Cases Reopened (%) DR' },
  { key: 'escRate', label: 'Escalation Rate', role: 'vehicle', fmt: 'pct2', hib: false, target: 0.012, needs: ['esc_num', 'closed'], f: R('esc_num', 'closed'), w: s => s.closed, desc: 'Escalations Opened ÷ Cases Closed' },
  { key: 'poEfc', label: 'poEFC %', role: 'vehicle', fmt: 'pct', hib: true, target: null /* set when agreed */, needs: ['efc_num', 'efc_den'], f: R('efc_num', 'efc_den'), w: s => s.efc_den, desc: 'PoEFC_Num ÷ Quality Reviews' },
  { key: 'consult', label: 'Consult Rate', role: 'vehicle', fmt: 'pct', hib: false, target: null, needs: ['con_num', 'con_den'], f: R('con_num', 'con_den'), w: s => s.con_den, desc: 'Consult Rate 1.5' },
  { key: 'cht', label: 'CHT', role: 'vehicle', fmt: 'num', unit: 'min', hib: false, target: null, needs: ['cht_num', 'cht_den'], f: R('cht_num', 'cht_den'), w: s => s.cht_den, desc: 'Case Handle Time' },
  { key: 'tta', label: 'TTA', role: 'vehicle', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['tta_num', 'tta_den'], f: R('tta_num', 'tta_den'), w: s => s.tta_den, desc: 'Time to Assign' },
  { key: 'timeInAssigned', label: 'Time in Assigned', role: 'vehicle', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['asg_num', 'asg_den'], f: R('asg_num', 'asg_den'), w: s => s.asg_den, desc: 'Average Time in Assigned (hours) ÷ Dr' },
  /* Context */
  { key: 'casesClosed', label: 'Cases Closed', role: 'context', fmt: 'int', hib: true, target: null, needs: ['closed'], f: s => s.closed, w: s => s.closed, desc: 'SUM(Cases Closed)' },
  { key: 'escalations', label: 'Escalations Opened', role: 'context', fmt: 'int', hib: false, target: null, needs: ['esc_num'], f: s => s.esc_num, w: s => s.closed, desc: 'SUM(Escalations Opened)' },
  { key: 'tfr', label: 'TFR (Email)', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['tfr_num', 'tfr_den'], f: R('tfr_num', 'tfr_den'), w: s => s.tfr_den, desc: 'Average Time to First Response (hours) (Email) ÷ Dr' },
  { key: 'tfs', label: 'TFS', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['tfs_num', 'tfs_den'], f: R('tfs_num', 'tfs_den'), w: s => s.tfs_den, desc: 'Average Time to First Solution Offered (hours) ÷ Dr' },
  { key: 'interactions', label: 'Interactions / Case', role: 'context', fmt: 'num', hib: false, target: null, needs: ['int_num', 'int_den'], f: R('int_num', 'int_den'), w: s => s.int_den, desc: 'Average Interactions per Closed Case ÷ Dr' },
  { key: 'consultInt', label: 'Consult Interactions / Case', role: 'context', fmt: 'num', hib: false, target: null, needs: ['cai_num', 'cai_den'], f: R('cai_num', 'cai_den'), w: s => s.cai_den, desc: 'AVERAGE(Consult Average Interactions per Closed Case)' },
  { key: 'timeNew', label: 'Time in New', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['new_num', 'new_den'], f: R('new_num', 'new_den'), w: s => s.new_den, desc: 'Average Time in New (hours) ÷ Dr' },
  { key: 'unassigned', label: 'Time in Unassigned', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['una_num', 'una_den'], f: R('una_num', 'una_den'), w: s => s.una_den, desc: 'Average Time in Unassigned (hours) ÷ Dr' },
  { key: 'blocked', label: 'Time in Blocked By', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['blk_num', 'blk_den'], f: R('blk_num', 'blk_den'), w: s => s.blk_den, desc: 'Average Time in Blocked By (hours) ÷ Dr' },
  { key: 'needInfo', label: 'Time in Need Info', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['nfo_num', 'nfo_den'], f: R('nfo_num', 'nfo_den'), w: s => s.nfo_den, desc: 'Average Time in Need Info (hours) ÷ Dr' },
  { key: 'agentTime', label: 'Agent Time', role: 'context', fmt: 'num', unit: 'h', hib: false, target: null, needs: ['agt_num', 'agt_den'], f: R('agt_num', 'agt_den'), w: s => s.agt_den, desc: 'Average Agent Time (hours) ÷ Dr' }
];
const DEF = Object.fromEntries(KPIS.map(k => [k.key, k]));
const VEHICLES = KPIS.filter(k => k.role === 'vehicle').map(k => k.key);
const VOLUME_KEYS = new Set(['casesClosed', 'escalations']);
const LEVERS_ALL = KPIS.filter(k => k.role !== 'northstar' && !VOLUME_KEYS.has(k.key)).map(k => k.key);
const LEVERS_VEH = VEHICLES.slice();
const CORR_KEYS = ['sentiment', ...VEHICLES];
const SIM_UNITS = [['sub_pod', 'week'], ['sub_pod', 'month'], ['market', 'week'], ['sub_pod'], ['market'], ['week']];
const HEX = { good: 0x10b981, bad: 0xf43f5e, warn: 0xf59e0b, cyan: 0x00e5d4, sky: 0x38bdf8, slate: 0x64748b, dim: 0x475569 };

/* ═══ 2. STATE ═══ */
const S = {
  booted: false, payload: null, C: null, view: null,
  filters: Object.fromEntries(DIMS.map(d => [d, new Set()])),
  unit: 'month', tab: 'overview', xKpi: 'sentiment', theme: 'auto', catDepth: 1,
  corr: { unit: 'sub_pod', minVol: 30, pair: ['irt', 'sentiment'] }, corrCache: null,
  sim: { levers: [], model: null, src: 'none', baseSent: null, pred: null, band: null, plan: null, scope: 'all', enforce: true, minN: 20, saved: [] },
  cases: { page: 1, size: 25, mode: 'scored', total: 0, keys: [], labels: [], raw: [], q: '', sort: '', dir: 'desc', open: null, ctl: null, bound: false },
  raf: null,
  dirty: { overview: true, correlation: true, simulator: true, cases: true }
};

/* ═══ 3. STYLES ═══ */
const VC_CSS = `
.hidden{display:none!important}
.vc-good{color:var(--cz-good,#10B981)!important}.vc-bad{color:var(--cz-bad,#F43F5E)!important}
.vc-muted{color:var(--cz-text-muted,#94A3B8)!important}.vc-warn{color:var(--cz-warn,#F59E0B)!important}
.vc-mono{font-family:var(--cz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}
.vc-card{background:linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)));border:1px solid var(--cz-border,rgba(24,40,72,.7));border-radius:13px;box-shadow:var(--cz-card-shadow,0 10px 30px -10px rgba(0,0,0,.5))}
.vc-section{padding:21px;margin-top:21px}
.vc-sec-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cz-text-primary,#F8FAFC)}
.vc-sub{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--cz-text-muted,#94A3B8)}
.vc-empty{padding:28px;text-align:center;font-size:12px;color:var(--cz-text-muted,#94A3B8)}
.vc-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid var(--cz-input-border,#334155);background:var(--cz-input-bg,#1E293B);color:var(--cz-text-primary,#F8FAFC);cursor:pointer;white-space:nowrap}
.vc-btn:hover:not(:disabled){border-color:var(--cz-cyan,#00E5D4);color:var(--cz-cyan,#00E5D4)}
.vc-btn:disabled{opacity:.45;cursor:not-allowed}
.vc-btn.is-on{background:var(--cz-cyan,#00E5D4);color:#041018;border-color:transparent}
.vc-btn.sm{padding:3px 8px;font-size:11px}
.vc-select,.vc-input{background:var(--cz-input-bg,#1E293B);border:1px solid var(--cz-input-border,#334155);color:var(--cz-text-primary,#F8FAFC);border-radius:8px;padding:5px 8px;font-size:12px;outline:none}
.vc-select:focus,.vc-input:focus{border-color:var(--cz-cyan,#00E5D4)}
.vc-ctl{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--cz-text-muted,#94A3B8)}
.vc-ms{position:relative;display:inline-block}
.vc-ms-btn{display:inline-flex;align-items:center;gap:8px;width:178px;min-height:42px;padding:5px 13px;background:var(--cz-input-bg,#1E293B);border:1px solid var(--cz-input-border,#334155);border-radius:10px;color:var(--cz-text-primary,#F8FAFC);cursor:pointer;text-align:left}
.vc-ms-btn:hover,.vc-ms-btn.is-filtered{border-color:var(--cz-cyan,#00E5D4)}
.vc-ms-txt{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.2}
.vc-ms-cap{font-size:8.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-ms-val{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:144px}
.vc-ms-btn.is-filtered .vc-ms-val{color:var(--cz-cyan,#00E5D4)}
.vc-ms-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:200;width:288px;max-height:466px;display:flex;flex-direction:column;background:var(--cz-menu-bg,rgba(15,26,46,.98));border:1px solid var(--cz-border-light,rgba(0,229,212,.35));border-radius:12px;box-shadow:0 18px 44px -12px rgba(0,0,0,.6);backdrop-filter:blur(14px)}
.vc-ms-head{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--cz-border,rgba(24,40,72,.7))}
.vc-ms-head input{flex:1;min-width:0}
.vc-ms-list{overflow-y:auto;padding:4px;flex:1}
.vc-ms-opt{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;font-size:11.5px;color:var(--cz-text-muted,#94A3B8);cursor:pointer}
.vc-ms-opt:hover{background:rgba(0,229,212,.08);color:var(--cz-text-primary,#F8FAFC)}
.vc-ms-opt span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-ms-opt em{font-style:normal;font-size:10px;opacity:.75}
.vc-ms-opt input{accent-color:var(--cz-cyan,#00E5D4)}
.vc-ms-foot{padding:6px 10px;border-top:1px solid var(--cz-border,rgba(24,40,72,.7));font-size:10px;color:var(--cz-text-muted,#94A3B8)}
.vc-chips{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11px}
.vc-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 4px 2px 9px;border-radius:999px;border:1px solid var(--cz-border-light,rgba(0,229,212,.35));background:rgba(0,229,212,.08);color:var(--cz-text-primary,#F8FAFC)}
.vc-chip button{border:0;background:none;color:inherit;cursor:pointer;opacity:.7;padding:0 4px}
.vc-ns{height:100%;min-height:233px;padding:21px 34px;border-radius:13px;display:flex;flex-direction:column;justify-content:space-between;gap:13px;border:1px solid var(--cz-border,rgba(24,40,72,.7));background:radial-gradient(120% 140% at 0% 0%,rgba(245,158,11,.18),transparent 55%),linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)))}
.vc-ns.is-good{border-color:rgba(16,185,129,.55)}.vc-ns.is-bad{border-color:rgba(244,63,94,.55)}
.vc-eyebrow{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--cz-northstar,#F59E0B)}
.vc-ns-row{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}
.vc-ns-title{font-size:13px;font-weight:600;color:var(--cz-text-muted,#94A3B8)}
.vc-ns-value{font-size:clamp(2.618rem,4.236vw,4.236rem);line-height:1;font-weight:700;color:var(--cz-text-primary,#F8FAFC)}
.vc-ns-meta{display:flex;flex-wrap:wrap;gap:8px 21px;font-size:11px;color:var(--cz-text-muted,#94A3B8)}
.vc-veh{position:relative;min-height:144px;padding:13px 18px;border-radius:13px;cursor:pointer;display:flex;flex-direction:column;justify-content:space-between;gap:2px;border:1px solid var(--cz-border,rgba(24,40,72,.7));background:linear-gradient(135deg,var(--cz-card-grad-a,rgba(20,32,54,.65)),var(--cz-card-grad-b,rgba(10,17,32,.85)));transition:transform .15s,border-color .15s}
.vc-veh:hover{transform:translateY(-2px);border-color:var(--cz-border-light,rgba(0,229,212,.35))}
.vc-veh.is-good{box-shadow:inset 3px 0 0 var(--cz-good,#10B981)}.vc-veh.is-bad{box-shadow:inset 3px 0 0 var(--cz-bad,#F43F5E)}
.vc-veh.is-sel{border-color:var(--cz-cyan,#00E5D4)}
.vc-veh.is-missing{opacity:.55}
.vc-veh-head{display:flex;justify-content:space-between;align-items:center;gap:6px}
.vc-role{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-r{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--cz-input-bg,#1E293B);color:var(--cz-cyan,#00E5D4);border:0;cursor:pointer}
.vc-r.is-counter{color:var(--cz-bad,#F43F5E)}
.vc-veh-label{margin-top:4px;font-size:11px;font-weight:600;color:var(--cz-text-muted,#CBD5E1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-veh-value{font-size:1.5rem;font-weight:700;line-height:1.25;color:var(--cz-text-primary,#F8FAFC);white-space:nowrap}
.vc-veh-foot{display:flex;justify-content:space-between;gap:6px;font-size:10px}
.vc-spark{display:block}
.vc-table{width:100%;border-collapse:collapse;font-size:12px}
.vc-table th{padding:9px 13px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);border-bottom:1px solid var(--cz-border,rgba(24,40,72,.7));white-space:nowrap}
.vc-table td{padding:8px 13px;border-bottom:1px solid rgba(51,65,85,.35);color:var(--cz-text-primary,#E2E8F0);white-space:nowrap;max-width:377px;overflow:hidden;text-overflow:ellipsis}
.vc-table tr:hover td{background:rgba(56,189,248,.05)}
.vc-table .r{text-align:right}
.vc-grp td{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);background:rgba(2,6,23,.35)}
.vc-ns-row-t td{background:rgba(245,158,11,.06)}
.vc-cat-l2 td:first-child{padding-left:34px;color:var(--cz-text-muted,#94A3B8)}
.vc-mini-bar{display:inline-block;height:6px;border-radius:3px;background:var(--cz-bad,#F43F5E);vertical-align:middle}
.vc-ins{padding:13px 18px;min-height:89px}
.vc-ins.is-good{border-color:rgba(16,185,129,.45)}.vc-ins.is-bad{border-color:rgba(244,63,94,.45)}
.vc-ins-t{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8);margin-bottom:6px}
.vc-ins-b{font-size:12px;line-height:1.5;color:var(--cz-text-primary,#E2E8F0)}
.vc-sim-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.vc-sep{width:1px;height:22px;background:var(--cz-border,rgba(24,40,72,.7));margin:0 4px}
.vc-seg{display:inline-flex;border:1px solid var(--cz-input-border,#334155);border-radius:8px;overflow:hidden}
.vc-seg .vc-btn{border:0;border-radius:0}
.vc-sim-grp{margin:13px 0 2px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-sim-row{padding:10px 0;border-bottom:1px dashed var(--cz-border,rgba(24,40,72,.7));transition:background .3s}
.vc-sim-row.is-flat{opacity:.6}
.vc-sim-row.vc-flash{background:rgba(0,229,212,.12)}
.vc-sim-head,.vc-sim-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.vc-sim-head{font-size:12px;font-weight:600;color:var(--cz-text-primary,#E2E8F0)}
.vc-sim-foot{font-size:10px;color:var(--cz-text-muted,#94A3B8)}
.vc-sim-row input[type=range]{width:100%;accent-color:var(--cz-cyan,#00E5D4);margin:6px 0 2px}
.vc-x{border:0;background:none;color:var(--cz-text-muted,#94A3B8);cursor:pointer;font-size:12px;padding:0 2px}
.vc-x:hover{color:var(--cz-cyan,#00E5D4)}
.vc-peer{position:relative;height:6px;margin:2px 0 5px;border-radius:3px;background:rgba(51,65,85,.35)}
.vc-peer i{position:absolute;top:0;bottom:0;border-radius:3px}
.vc-peer i.b1{background:rgba(56,189,248,.22)}.vc-peer i.b2{background:rgba(56,189,248,.45)}
.vc-peer b.base{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--cz-text-muted,#94A3B8)}
.vc-peer em{position:absolute;top:-3px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--cz-cyan,#00E5D4);box-shadow:0 0 8px rgba(0,229,212,.7)}
.vc-pred-l{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--cz-text-muted,#94A3B8)}
.vc-pred{font-size:2.618rem;font-weight:700;line-height:1.1}
.vc-band{font-size:11px;color:var(--cz-text-muted,#94A3B8)}
.vc-pred-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11px;color:var(--cz-text-muted,#94A3B8);margin-top:4px}
.vc-gauge{margin:13px 0 4px}
.vc-gauge-track{position:relative;height:10px;border-radius:5px;background:rgba(51,65,85,.35)}
.vc-gauge-track i{position:absolute;top:0;bottom:0;border-radius:5px;opacity:.6}
.vc-gauge-track b{position:absolute;top:-4px;bottom:-4px;width:3px;margin-left:-1px;border-radius:2px}
.vc-gauge-track b.t{background:var(--cz-good,#10B981);width:2px;opacity:.9}
.vc-gauge-track b.n{background:var(--cz-text-muted,#94A3B8)}
.vc-gauge-track b.p{width:12px;height:12px;top:-1px;margin-left:-6px;border-radius:50%;background:var(--cz-text-primary,#F8FAFC)}
.vc-gauge-ax{display:flex;justify-content:space-between;font-size:9.5px;color:var(--cz-text-muted,#94A3B8);margin-top:4px}
.vc-note{margin-top:10px;font-size:10.5px;color:var(--cz-text-muted,#94A3B8);line-height:1.5}
.vc-list{margin:6px 0 0;font-size:12px;list-style:none;padding:0}
.vc-list li{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid rgba(51,65,85,.35)}
.vc-model{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}
.vc-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;border:1px solid var(--cz-input-border,#334155);color:var(--cz-text-muted,#94A3B8)}
.vc-contrib{display:grid;grid-template-columns:120px minmax(0,1fr) 64px;align-items:center;gap:8px;font-size:11px;padding:3px 0}
.vc-contrib span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-contrib-track{position:relative;height:10px;background:rgba(51,65,85,.35);border-radius:5px}
.vc-contrib-track i{position:absolute;top:0;bottom:0;border-radius:5px}
.vc-contrib-track b{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--cz-text-muted,#94A3B8)}
#sim-canvas{position:relative;min-height:360px;border-radius:13px;overflow:hidden;background:#020617}
#sim-canvas canvas{display:block;width:100%;height:100%}
.vc-hud{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:2}
.vc-hud-l{position:absolute;left:12px;bottom:10px;font-size:10px;color:#94A3B8;z-index:2;pointer-events:none;line-height:1.6}
.vc-pager{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:13px 21px;border-top:1px solid var(--cz-border,rgba(24,40,72,.7));font-size:12px;color:var(--cz-text-muted,#94A3B8)}
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
.vc-case-tabs{display:flex;flex-wrap:wrap;gap:8px}
.vc-case-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 13px}
.vc-case-bar #vc-case-q{flex:1 1 233px;max-width:377px}
.vc-case-scope{flex:1 1 233px;min-width:0;font-size:11px;color:var(--cz-text-muted,#94A3B8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-sortable{cursor:pointer;user-select:none}
.vc-sortable:hover,.vc-sortable.is-on{color:var(--cz-cyan,#00E5D4)}
.vc-arrow{font-size:9px;opacity:.6}
.vc-case-row{cursor:pointer}
.vc-case-row.is-open td{background:rgba(0,229,212,.06)}
.vc-case-detail td{white-space:normal!important;max-width:none!important;background:rgba(2,6,23,.45);padding:13px 21px!important}
.vc-case-text{font-size:12px;line-height:1.618;color:var(--cz-text-primary,#E2E8F0);max-width:89ch;margin-bottom:13px}
.vc-case-snip{color:var(--cz-text-muted,#94A3B8)}
svg text{font-family:inherit}
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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = v => clamp(v, 0, 1);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';
const hexStr = n => '#' + n.toString(16).padStart(6, '0');
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
function pal() {
  return {
    good: cssVar('--cz-good', '#10B981'), bad: cssVar('--cz-bad', '#F43F5E'), warn: cssVar('--cz-warn', '#F59E0B'),
    axis: cssVar('--cz-axis-text', '#94A3B8'), grid: cssVar('--cz-grid', 'rgba(148,163,184,.16)'),
    ink: cssVar('--cz-text-primary', '#F8FAFC'), muted: cssVar('--cz-text-muted', '#94A3B8'), cyan: cssVar('--cz-cyan', '#00E5D4')
  };
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

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
function ensureHost(id, parentId, opts = {}) {
  let el = $(id); if (el) return el;
  const p = $(parentId); if (!p) return null;
  el = document.createElement('div'); el.id = id;
  if (opts.cls) el.className = opts.cls;
  if (opts.prepend) p.insertBefore(el, p.firstChild); else p.appendChild(el);
  return el;
}

/* ═══ 5. DATES — YYYY-MM-DD for days/weeks, YYYY-MM for months ═══ */
const pad2 = n => String(n).padStart(2, '0');
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const isBlank = v => v == null || /^\s*$|^\(blank\)$|^\(n\/a\)$|^(null|none|nan|nat|undefined)$/i.test(String(v));
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const fromDate = d => (isNaN(d) ? null : ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()));
function isoWeekMonday(y, w) {
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5 + (w - 1) * 7 * 864e5);
  return ymd(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate());
}
function fmtDay(v) {
  if (isBlank(v)) return '(blank)';
  if (v instanceof Date) return fromDate(v) || '(blank)';
  if (typeof v === 'number') { if (v > 1e11) return fromDate(new Date(v)); if (v > 1e9) return fromDate(new Date(v * 1000)); return String(v); }
  const s = String(v).trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})[-\s]?W(\d{1,2})\b/i.exec(s))) return isoWeekMonday(+m[1], +m[2]);
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) return ymd(m[3], +m[1], +m[2]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) return ymd(m[1], +m[2], +m[3]);
  if (/[a-z]/i.test(s)) { const d = new Date(s); if (!isNaN(d)) return fromDate(d); }
  return s;
}
function fmtMonth(v) {
  if (isBlank(v)) return '(blank)';
  if (v instanceof Date) return isNaN(v) ? '(blank)' : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}`;
  const s = String(v).trim(); let m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})(?!\d)/.exec(s))) return `${m[1]}-${pad2(+m[2])}`;
  if ((m = /^(\d{4})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}`;
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[2]}-${pad2(+m[1])}`;
  if ((m = /^([a-z]{3,9})[\s\-',.]*(\d{2,4})$/i.exec(s)) && MON[m[1].slice(0, 3).toLowerCase()]) {
    const y = m[2].length === 2 ? '20' + m[2] : m[2]; return `${y}-${pad2(MON[m[1].slice(0, 3).toLowerCase()])}`;
  }
  if ((m = /^(\d{4})[\s\-]*([a-z]{3,9})$/i.exec(s)) && MON[m[2].slice(0, 3).toLowerCase()]) return `${m[1]}-${pad2(MON[m[2].slice(0, 3).toLowerCase()])}`;
  const d = fmtDay(s);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : s;
}
function fmtStamp(v) {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? String(v ?? 'n/a') : `${fromDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const todayStr = () => fromDate(new Date());
const fmtLabel = (dim, v) => (dim === 'month' ? fmtMonth(v) : dim === 'week' ? fmtDay(v) : (isBlank(v) ? '(blank)' : String(v)));
const ISO_DT = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function cellDate(k, v) {
  if (v == null || v === '') return null;
  if (k === 'month') return fmtMonth(v);
  if (k === 'week' || /(^|_)(date|day)$|_at$/i.test(k) || (typeof v === 'string' && ISO_DT.test(v.trim()))) return fmtDay(v);
  return null;
}

/* ═══ 6. STATS ═══ */
function quant(sorted, q) { if (!sorted.length) return null; const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }
const median = a => quant(a.slice().sort((x, y) => x - y), 0.5);
function wquant(pairs, q) { const W = pairs.reduce((a, p) => a + p.w, 0); if (!W) return null; let c = 0; for (const p of pairs) { c += p.w; if (c >= q * W) return p.v; } return pairs[pairs.length - 1].v; }
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
  const r = clamp(cov / Math.sqrt(vx * vy), -1, 1);
  return { r, n, p: pValueR(r, n) };
}
function rankArr(v) {
  const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
}
function spearman(rows, a, b) {
  const P = rows.filter(r => isNum(r[a]) && isNum(r[b]));
  if (P.length < 3) return { r: null, n: P.length };
  const ra = rankArr(P.map(r => r[a])), rb = rankArr(P.map(r => r[b]));
  return pearson(ra.map((x, i) => ({ a: x, b: rb[i] })), 'a', 'b');
}
const stars = p => !isNum(p) ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
const fmtR = r => isNum(r) ? (r > 0 ? '+' : '') + r.toFixed(2) : 'n/a';
const fmtP = p => !isNum(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3);

/* ═══ 7. FORMATTING ═══ */
function fmtV(def, v) {
  if (!isNum(v)) return '—';
  switch (def.fmt) {
    case 'pct': return (v * 100).toFixed(1) + '%';
    case 'pct2': return (v * 100).toFixed(2) + '%';
    case 'int': return Math.round(v).toLocaleString();
    default: return v.toFixed(v !== 0 && Math.abs(v) < 10 ? 2 : 1) + (def.unit ? ' ' + def.unit : '');
  }
}
function fmtD(def, d) {
  if (!isNum(d)) return '—';
  const s = d > 0 ? '+' : '';
  if (def.fmt === 'pct') return s + (d * 100).toFixed(1) + ' pp';
  if (def.fmt === 'pct2') return s + (d * 100).toFixed(2) + ' pp';
  if (def.fmt === 'int') return s + Math.round(d).toLocaleString();
  return s + d.toFixed(Math.abs(d) < 10 ? 2 : 1) + (def.unit ? ' ' + def.unit : '');
}
const fmtPP = v => isNum(v) ? (v > 0 ? '+' : '') + (v * 100).toFixed(1) + ' pp' : '—';
const good = (def, d) => (!isNum(d) || Math.abs(d) < 1e-12) ? 0 : ((d > 0) === def.hib ? 1 : -1);
const tgtStatus = (def, v) => (def.target == null || !isNum(v)) ? 0 : (def.hib ? (v >= def.target ? 1 : -1) : (v <= def.target ? 1 : -1));
const tone = g => g > 0 ? 'vc-good' : g < 0 ? 'vc-bad' : 'vc-muted';
const lastDelta = vals => { const n = vals.length; return n > 1 && isNum(vals[n - 1]) && isNum(vals[n - 2]) ? vals[n - 1] - vals[n - 2] : null; };
const axisFmt = def => def.fmt === 'pct' ? d3.format('.0%') : def.fmt === 'pct2' ? d3.format('.1%') : d3.format('~s');
function spark(vals, cls = '', w = 72, h = 20) {
  const v = vals.filter(isNum);
  if (v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), sp = (mx - mn) || 1, p = 2;
  const pts = v.map((y, i) => [p + i * (w - 2 * p) / (v.length - 1), h - p - ((y - mn) / sp) * (h - 2 * p)]);
  const d = 'M' + pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L');
  const L = pts[pts.length - 1];
  return `<svg class="vc-spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="2" fill="currentColor"/></svg>`;
}

/* ═══ 8. CUBE ENGINE ═══ */
function findDims(p, cube) {
  const cols = cube.columns || cube.cols || cube, need = {};
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
      if (ks.length && ks.length <= 20000 && ks.every(x => NUMERIC.test(x))) { const L = []; ks.forEach(x => { L[+x] = v[x] == null ? '(blank)' : String(v[x]); }); return asList(Array.from(L, x => x ?? '(blank)')); }
    }
    return null;
  };
  const found = {}, seen = new Set([cols]);
  const consider = (dim, v) => {
    if (!dim) return;
    const L = asList(v); if (!L || new Set(L).size !== L.length) return;
    const score = L.length === need[dim] ? 2 : L.length > need[dim] ? 1 : 0;
    if (score && (!found[dim] || score > found[dim].score)) found[dim] = { L, score };
  };
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 7) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length <= 64) o.forEach(it => { if (it && typeof it === 'object' && !Array.isArray(it)) { consider(norm(it.name || it.key || it.dim || it.alias || it.id || ''), it.labels || it.values || it.levels || it.categories); walk(it, depth + 1); } });
      return;
    }
    for (const [k, v] of Object.entries(o)) { consider(norm(k), v); if (v && typeof v === 'object') walk(v, depth + 1); }
  };
  walk(cube, 0); walk(p, 0);
  const out = {}; Object.entries(found).forEach(([k, f]) => { out[k] = f.L; });
  return out;
}
/* Formats labels (dates → ISO), merges duplicates, keeps the original server labels for API filters */
function normalizeDim(dim, codes, labels) {
  const fmt = labels.map(l => fmtLabel(dim, l));
  const uniq = [...new Set(fmt)].sort((a, b) => (BLANK_LABELS.has(a) - BLANK_LABELS.has(b)) || String(a).localeCompare(String(b), undefined, { numeric: true }));
  const pos = new Map(uniq.map((x, i) => [x, i]));
  const remap = Int32Array.from(fmt, f => pos.get(f));
  const out = new Int32Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = remap[codes[i]] ?? 0;
  const raw = uniq.map(() => []);
  labels.forEach((l, i) => raw[remap[i]].push(l));
  return { codes: out, labels: uniq.length ? uniq : ['(n/a)'], raw: raw.length ? raw : [['(n/a)']] };
}
function buildCube(p) {
  if (!p) throw new Error('Empty payload from server');
  const cube = p.cube || (p.cubes && (p.cubes.main || Object.values(p.cubes)[0]));
  if (!cube) throw new Error('Payload has no "cube". Top-level keys: ' + Object.keys(p).join(', '));
  const cols = cube.columns || cube.cols || cube;
  const dimsSrc = Object.assign({}, findDims(p, cube), (p.metadata && p.metadata.dims) || {});
  const firstKey = MEAS.find(k => cols[k]) || DIMS.find(k => cols[k]);
  const n = cube.rows || cube.n || (firstKey ? cols[firstKey].length : 0);
  const d = {}, m = {}, labels = {}, raw = {}, gaps = [];
  DIMS.forEach(k => {
    const col = cols[k];
    let codes, L;
    if (col && col.length && typeof col[0] === 'string') {
      L = [...new Set(col.map(String))];
      const pos = new Map(L.map((x, i) => [x, i]));
      codes = Int32Array.from(col, v => pos.get(String(v)));
    } else {
      codes = col ? Int32Array.from(col) : new Int32Array(n);
      L = Array.isArray(dimsSrc[k]) ? dimsSrc[k].map(x => (x == null ? '(blank)' : String(x))) : [];
      let mx = -1; for (let i = 0; i < codes.length; i++) if (codes[i] > mx) mx = codes[i];
      if (L.length <= mx) { gaps.push('labels:' + k); for (let i = L.length; i <= mx; i++) L.push('#' + i); }
      if (!L.length) L.push('(n/a)');
      if (!col) gaps.push('dim:' + k);
    }
    const nd = normalizeDim(k, codes, L);
    d[k] = nd.codes; labels[k] = nd.labels; raw[k] = nd.raw;
  });
  const avail = new Set();
  MEAS.forEach(k => { if (cols[k]) { m[k] = Float64Array.from(cols[k], v => (isNum(+v) ? +v : 0)); avail.add(k); } else { m[k] = new Float64Array(n); gaps.push(k); } });
  if (gaps.length) console.warn('[VectorCore] cube gaps:', gaps.join(', '));
  return { n, d, m, labels, raw, avail };
}
function applyAvailability() {
  KPIS.forEach(def => {
    def._f = def._f || def.f;
    def.missing = !def.needs.every(k => S.C.avail.has(k));
    def.f = def.missing ? () => null : def._f;
  });
}
function checksFor(ign) {
  const out = [];
  for (const d of DIMS) {
    if (ign.has(d)) continue;
    const s = S.filters[d]; if (!s.size) continue;
    const lut = new Uint8Array(S.C.labels[d].length);
    s.forEach(i => { lut[i] = 1; });
    out.push([S.C.d[d], lut]);
  }
  return out;
}
/* agg() → totals · agg(dim|dims[], ignore|ignores[]) → [{idx, idxs, name, names, s}] */
function agg(group = null, ignore = null) {
  const C = S.C, gd = group == null ? [] : [].concat(group), ign = new Set(ignore == null ? [] : [].concat(ignore));
  const checks = checksFor(ign), nm = MEAS.length, M = MEAS.map(k => C.m[k]);
  const total = new Float64Array(nm), groups = new Map(), gc = gd.map(x => C.d[x]), gm = gd.map(x => C.labels[x].length);
  rows: for (let i = 0; i < C.n; i++) {
    for (let c = 0; c < checks.length; c++) if (!checks[c][1][checks[c][0][i]]) continue rows;
    let t = total;
    if (gc.length) {
      let key = 0; for (let j = 0; j < gc.length; j++) key = key * gm[j] + gc[j][i];
      t = groups.get(key); if (!t) { t = new Float64Array(nm); groups.set(key, t); }
    }
    for (let k = 0; k < nm; k++) t[k] += M[k][i];
  }
  const toObj = a => { const o = {}; for (let k = 0; k < nm; k++) o[MEAS[k]] = a[k]; return o; };
  if (!gc.length) return toObj(total);
  return [...groups].map(([key, a]) => {
    const idxs = new Array(gd.length); let k = key;
    for (let j = gd.length - 1; j >= 0; j--) { idxs[j] = k % gm[j]; k = Math.floor(k / gm[j]); }
    const names = idxs.map((ix, j) => C.labels[gd[j]][ix]);
    return { idx: idxs[0], idxs, key, name: names.join(' · '), names, s: toObj(a) };
  });
}
const filterSig = () => DIMS.map(d => d + ':' + [...S.filters[d]].sort((a, b) => a - b).join(',')).join('|');
function periodSeries() {
  const cap = S.unit === 'week' ? 13 : 6;
  return agg(S.unit).filter(x => !BLANK_LABELS.has(x.name)).sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(-cap);
}

/* ═══ 9. FILTERS ═══ */
function mountFilters() {
  document.querySelectorAll('[data-ms]').forEach(el => {
    const dim = MS_MAP[el.dataset.ms];
    if (!dim) { el.style.display = 'none'; return; }
    el.style.position = 'relative';
    el.innerHTML =
      `<div class="vc-ms"><button type="button" class="vc-ms-btn" data-vc-ms-toggle="${dim}">` +
      `<span class="vc-ms-txt"><span class="vc-ms-cap">${esc(DIM_LABEL[dim])}</span><span class="vc-ms-val" data-vc-ms-val="${dim}">All</span></span>` +
      `<span class="vc-muted" style="font-size:10px">▾</span></button>` +
      `<div class="vc-ms-menu hidden"><div class="vc-ms-head"><input class="vc-input" data-vc-ms-search="${dim}" placeholder="Search ${esc(DIM_LABEL[dim])}…">` +
      `<button type="button" class="vc-btn" data-vc-ms-clear="${dim}">Clear</button></div><div class="vc-ms-list"></div>` +
      `<div class="vc-ms-foot">Nothing ticked = All · numbers = cases closed in scope</div></div></div>`;
  });
  updateMsLabels();
}
function renderMsList(menu, dim) {
  const labels = S.C.labels[dim], sel = S.filters[dim];
  const vol = new Map(agg(dim, dim).map(g => [g.idx, g.s.closed]));
  const idxs = labels.map((_, i) => i).filter(i => !BLANK_LABELS.has(labels[i]) || sel.has(i) || (vol.get(i) || 0) > 0);
  if (dim === 'month' || dim === 'week') idxs.sort((a, b) => String(labels[b]).localeCompare(String(labels[a])));
  else idxs.sort((a, b) => (vol.get(b) || 0) - (vol.get(a) || 0));
  menu.querySelector('.vc-ms-list').innerHTML = idxs.length
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
  const menu = btn.closest('.vc-ms').querySelector('.vc-ms-menu'), dim = btn.dataset.vcMsToggle;
  const wasOpen = !menu.classList.contains('hidden');
  closeMenus(); if (wasOpen) return;
  renderMsList(menu, dim); menu.classList.remove('hidden');
  const s = menu.querySelector('[data-vc-ms-search]'); if (s) { s.value = ''; s.focus(); }
}
function closeMenus() { document.querySelectorAll('.vc-ms-menu').forEach(m => m.classList.add('hidden')); }
function toggleFilter(dim, v) {
  const idx = typeof v === 'number' ? v : S.C.labels[dim].indexOf(String(v));
  if (idx < 0) return;
  const s = S.filters[dim];
  if (s.has(idx)) s.delete(idx); else s.add(idx);
  onFiltersChanged();
}
function clearDim(dim) { if (!S.filters[dim]) return; S.filters[dim].clear(); onFiltersChanged(); }
function resetAllFilters() { DIMS.forEach(d => S.filters[d].clear()); closeMenus(); onFiltersChanged(); }
window.resetAllFilters = resetAllFilters;
function onFiltersChanged() { updateMsLabels(); renderChips(); markDirty(); S.cases.page = 1; renderVisible(); }
function renderChips() {
  const host = $('filter-chips'); if (!host) return;
  host.classList.add('vc-chips');
  const chips = DIMS.filter(d => S.filters[d].size).map(d => {
    const names = [...S.filters[d]].map(i => S.C.labels[d][i]);
    return `<span class="vc-chip">${DIM_LABEL[d]}: <b>${esc(names.length > 2 ? names.length + ' selected' : names.join(', '))}</b><button type="button" data-vc-clear-dim="${d}" title="Remove">✕</button></span>`;
  }).join('');
  const tot = agg();
  host.innerHTML = (chips || '<span class="vc-muted">Scope · All data</span>') +
    `<span class="vc-muted vc-mono" style="margin-left:auto">${Math.round(tot.closed).toLocaleString()} closed · ${Math.round(tot.sent_den).toLocaleString()} scored</span>`;
}

/* ═══ 10. OVERVIEW ═══ */
function renderOverview() {
  const tot = agg(), per = periodSeries();
  S.view = { tot, per };
  renderNorthStar(tot, per);
  renderVehicles(tot, per);
  renderExplorer();
  renderMatrix(per, tot);
  renderCategories();
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
    `<div class="vc-ns-meta"><span>🎯 Target <b class="vc-mono">${fmtV(def, def.target)}</b></span>` +
    `<span class="${tone(st)}">Gap <b class="vc-mono">${fmtPP(gap)}</b></span>` +
    `<span class="${tone(g)}">${S.unit === 'week' ? 'WoW' : 'MoM'} Δ <b class="vc-mono">${fmtD(def, d)}</b></span>` +
    `<span>Scored <b class="vc-mono">${Math.round(tot.sent_den).toLocaleString()}</b></span>` +
    `<span>Closed <b class="vc-mono">${Math.round(tot.closed).toLocaleString()}</b></span></div></div>`;
}
function renderVehicles(tot, per) {
  const host = $('ov-vehicles'); if (!host) return;
  let corr = null; try { corr = getCorr(); } catch (e) { console.warn('[VectorCore] correlation failed', e); }
  const rBy = corr ? Object.fromEntries(corr.strip.map(s => [s.key, s])) : {};
  host.innerHTML = [...VEHICLES, 'casesClosed'].map(k => {
    const def = DEF[k], v = def.f(tot), vals = per.map(p => def.f(p.s)), d = lastDelta(vals);
    const st = tgtStatus(def, v), g = good(def, d), s = rBy[k];
    const chip = def.missing ? '<span class="vc-role vc-warn">awaiting feed</span>'
      : k !== 'casesClosed' ? `<button type="button" class="vc-r vc-mono ${s && s.aligned === false ? 'is-counter' : ''}" data-vc-corr="${k}" title="Pearson r vs Sentiment across ${DIM_LABEL[S.corr.unit]}s (p ${fmtP(s && s.p)}) · click to analyse">r ${fmtR(s && s.r)}${stars(s && s.p)}</button>`
      : '<span class="vc-role">volume</span>';
    const tgt = def.target != null ? `<span class="${tone(st)}">🎯 ${fmtV(def, def.target)}</span>` : '<span class="vc-muted">no target</span>';
    return `<div class="vc-veh ${st > 0 ? 'is-good' : st < 0 ? 'is-bad' : ''} ${S.xKpi === k ? 'is-sel' : ''} ${def.missing ? 'is-missing' : ''}" data-vc-veh="${k}" title="${esc(def.desc || '')}">` +
      `<div class="vc-veh-head"><span class="vc-role">${def.role === 'vehicle' ? 'Vehicle' : 'Context'}</span>${chip}</div>` +
      `<div class="vc-veh-label">${esc(def.label)}</div>` +
      `<div class="vc-veh-value vc-mono">${fmtV(def, v)}</div>` +
      `<div class="vc-veh-foot vc-mono"><span class="${tone(g)}">${g > 0 ? '▲' : g < 0 ? '▼' : '•'} ${fmtD(def, d)}</span>${tgt}</div>` +
      `<div class="${tone(g)}" style="margin-top:4px">${spark(vals)}</div></div>`;
  }).join('');
}
function renderExplorer() {
  const sel = $('x-kpi');
  if (sel && !sel.dataset.vc) {
    sel.dataset.vc = '1';
    sel.innerHTML = KPIS.filter(k => !k.missing).map(k => `<option value="${k.key}">${esc(k.label)}</option>`).join('');
  }
  if (DEF[S.xKpi].missing) S.xKpi = 'sentiment';
  if (sel) sel.value = S.xKpi;
  if (!window.d3) { ['x-trend', 'x-pod', 'x-region', 'x-segment'].forEach(id => { const h = $(id); if (h) h.innerHTML = '<div class="vc-empty">D3 not loaded</div>'; }); return; }
  renderTrend();
  renderBars('x-pod', 'sub_pod', 15);
  renderBars('x-region', 'region', 10);
  renderBars('x-segment', 'segment', 10);
}
function renderTrend() {
  const host = $('x-trend'); if (!host) return; host.innerHTML = '';
  const def = DEF[S.xKpi], P = pal(), dim = S.unit, sel = S.filters[dim], any = sel.size > 0;
  const data = agg(dim, dim).filter(g => !BLANK_LABELS.has(g.name)).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(dim === 'week' ? -26 : -12).map(g => ({ idx: g.idx, name: g.name, closed: g.s.closed, v: def.f(g.s) }));
  const tt = $('x-trend-title'); if (tt) tt.textContent = `${def.label} · ${dim === 'week' ? 'Weekly' : 'Monthly'} trend`;
  if (!data.length) { host.innerHTML = '<div class="vc-empty">No periods in scope</div>'; return; }
  const W = Math.max(480, host.clientWidth || 900), H = 250, m = { top: 18, right: 60, bottom: 34, left: 58 }, iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, H]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleBand().domain(data.map(d => d.name)).range([0, iw]).padding(0.28);
  const yB = d3.scaleLinear().domain([0, d3.max(data, d => d.closed) || 1]).nice().range([ih, 0]);
  const vals = data.map(d => d.v).filter(isNum); if (def.target != null) vals.push(def.target);
  const [lo, hi] = vals.length ? d3.extent(vals) : [0, 1], pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 0.05;
  const yL = d3.scaleLinear().domain([Math.max(def.fmt.startsWith('pct') ? 0 : -Infinity, lo - pad), hi + pad]).nice().range([ih, 0]);
  const step = Math.ceil(data.length / 12);
  const ax = s => s.call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10)).call(a => a.selectAll('line,path').attr('stroke', P.grid));
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(data.filter((_, i) => i % step === 0).map(d => d.name))).call(ax);
  g.append('g').call(d3.axisLeft(yL).ticks(5).tickFormat(axisFmt(def))).call(ax);
  g.append('g').attr('transform', `translate(${iw},0)`).call(d3.axisRight(yB).ticks(4).tickFormat(d3.format('~s'))).call(ax);
  g.selectAll('rect.b').data(data).join('rect').attr('class', 'b')
    .attr('x', d => x(d.name)).attr('width', x.bandwidth()).attr('y', d => yB(d.closed)).attr('height', d => ih - yB(d.closed)).attr('rx', 3)
    .attr('fill', P.cyan).attr('fill-opacity', d => !any ? 0.18 : sel.has(d.idx) ? 0.45 : 0.08);
  if (def.target != null) {
    g.append('line').attr('x1', 0).attr('x2', iw).attr('y1', yL(def.target)).attr('y2', yL(def.target)).attr('stroke', P.good).attr('stroke-dasharray', '5,4').attr('stroke-opacity', 0.85);
    g.append('text').attr('x', 4).attr('y', yL(def.target) - 5).attr('font-size', 9.5).attr('fill', P.good).text('🎯 ' + fmtV(def, def.target));
  }
  const cx = d => x(d.name) + x.bandwidth() / 2;
  g.append('path').datum(data).attr('fill', 'none').attr('stroke', P.warn).attr('stroke-width', 2.2)
    .attr('d', d3.line().defined(d => isNum(d.v)).x(cx).y(d => yL(d.v)).curve(d3.curveMonotoneX));
  g.selectAll('circle.p').data(data.filter(d => isNum(d.v))).join('circle').attr('class', 'p').attr('cx', cx).attr('cy', d => yL(d.v)).attr('r', 3.6)
    .attr('fill', d => { const t = tgtStatus(def, d.v); return t > 0 ? P.good : t < 0 ? P.bad : P.warn; }).attr('stroke', P.ink).attr('stroke-width', d => sel.has(d.idx) ? 1.5 : 0);
  g.selectAll('rect.hit').data(data).join('rect').attr('class', 'hit').attr('x', d => x(d.name) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', 0).attr('height', ih)
    .attr('fill', 'transparent').style('cursor', 'pointer')
    .on('mousemove', (e, d) => tip.show(`<div class="h">${esc(DIM_LABEL[dim])} ${esc(d.name)}</div><div>${esc(def.label)} <b class="vc-mono">${fmtV(def, d.v)}</b></div><div class="s">Cases closed <b class="vc-mono">${Math.round(d.closed).toLocaleString()}</b> · click to ${sel.has(d.idx) ? 'remove' : 'add'} filter</div>`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { tip.hide(); toggleFilter(dim, d.idx); });
}
function renderBars(hostId, dim, topN) {
  const host = $(hostId); if (!host) return; host.innerHTML = '';
  const def = DEF[S.xKpi], sel = S.filters[dim], any = sel.size > 0, P = pal();
  let items = agg(dim, dim).filter(g => !BLANK_LABELS.has(g.name))
    .map(g => ({ idx: g.idx, name: g.name, v: def.f(g.s), w: def.w(g.s), closed: g.s.closed }))
    .filter(x => isNum(x.v) && x.w > 0);
  items.sort((a, b) => b.w - a.w); items = items.slice(0, topN);
  items.sort((a, b) => (def.hib ? a.v - b.v : b.v - a.v));
  if (!items.length) { host.innerHTML = '<div class="vc-empty">No data in scope</div>'; return; }
  const W = Math.max(300, host.clientWidth || 420), rowH = 24, m = { top: 18, right: 66, bottom: 22, left: 128 };
  const ih = items.length * rowH, H = ih + m.top + m.bottom, iw = W - m.left - m.right;
  const onT = v => def.target == null ? null : (def.hib ? v >= def.target : v <= def.target);
  const x = d3.scaleLinear().domain([0, Math.max(d3.max(items, d => d.v), def.target || 0) * 1.05 || 1]).nice().range([0, iw]);
  const y = d3.scaleBand().domain(items.map(d => d.name)).range([0, ih]).padding(0.22);
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, H]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).ticks(4).tickSize(-ih).tickFormat(axisFmt(def)))
    .call(a => a.select('.domain').remove()).call(a => a.selectAll('line').attr('stroke', P.grid)).call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10));
  if (def.target != null) g.append('line').attr('x1', x(def.target)).attr('x2', x(def.target)).attr('y1', -4).attr('y2', ih).attr('stroke', P.good).attr('stroke-dasharray', '4,3');
  const row = g.selectAll('g.vc-bar').data(items, d => d.name).join('g').attr('class', 'vc-bar')
    .attr('transform', d => `translate(0,${y(d.name)})`).style('cursor', 'pointer').attr('opacity', d => !any || sel.has(d.idx) ? 1 : 0.35);
  row.append('rect').attr('x', -m.left).attr('y', -2).attr('width', W).attr('height', y.bandwidth() + 4).attr('fill', 'transparent');
  row.append('text').attr('x', -8).attr('y', y.bandwidth() / 2 + 4).attr('text-anchor', 'end').attr('font-size', 11).attr('fill', P.ink).text(d => trunc(d.name, 20));
  row.append('rect').attr('height', y.bandwidth()).attr('rx', 3).attr('width', 0)
    .attr('fill', d => { const t = onT(d.v); return t === null ? P.cyan : t ? P.good : P.bad; })
    .attr('stroke', d => sel.has(d.idx) ? P.ink : 'none').attr('stroke-width', 1.5)
    .transition().duration(REDUCED ? 0 : 450).attr('width', d => Math.max(1, x(d.v)));
  row.append('text').attr('class', 'vc-mono').attr('y', y.bandwidth() / 2 + 4).attr('font-size', 10).attr('x', d => x(d.v) + 6).attr('fill', P.axis).text(d => fmtV(def, d.v));
  row.on('mousemove', (e, d) => tip.show(`<div class="h">${esc(d.name)}</div><div>${esc(def.label)} <b class="vc-mono">${fmtV(def, d.v)}</b></div><div class="s">Volume <b class="vc-mono">${Math.round(d.w).toLocaleString()}</b> · Closed <b class="vc-mono">${Math.round(d.closed || 0).toLocaleString()}</b></div>${def.target != null ? `<div class="${onT(d.v) ? 'vc-good' : 'vc-bad'}">${onT(d.v) ? '✓ On target' : '✗ Off target'}</div>` : ''}<div class="s">Click to ${sel.has(d.idx) ? 'remove' : 'add'} filter</div>`, e))
    .on('mouseleave', () => tip.hide()).on('click', (e, d) => { tip.hide(); toggleFilter(dim, d.idx); });
}
function renderMatrix(per, tot) {
  const head = $('kpiHeaderRow'), body = $('kpiSummaryBody'); if (!head || !body) return;
  const tbl = head.closest('table'); if (tbl) tbl.classList.add('vc-table');
  head.innerHTML = '<th>Metric</th><th>Role</th><th class="r">Target</th>' + per.map(p => `<th class="r">${esc(p.name)}</th>`).join('') + `<th class="r">Overall</th><th class="r">${S.unit === 'week' ? 'WoW Δ' : 'MoM Δ'}</th>`;
  const span = per.length + 5;
  body.innerHTML = [['northstar', '🌙 North Star'], ['vehicle', '🚀 Vehicles'], ['context', '📦 Context']].map(([role, title]) =>
    `<tr class="vc-grp"><td colspan="${span}">${title}</td></tr>` + KPIS.filter(k => k.role === role).map(def => {
      if (def.missing) return `<tr><td title="${esc(def.desc || '')}"><b>${esc(def.label)}</b></td><td class="vc-muted" style="font-size:10px;text-transform:uppercase">${role}</td><td colspan="${span - 2}" class="vc-warn" style="font-size:11px">Awaiting feed — ${esc(def.needs.join(' / '))} not in cube</td></tr>`;
      const vals = per.map(p => def.f(p.s)), d = lastDelta(vals), g = good(def, d), ov = def.f(tot), ost = tgtStatus(def, ov);
      return `<tr class="${role === 'northstar' ? 'vc-ns-row-t' : ''}"><td title="${esc(def.desc || '')}"><b>${esc(def.label)}</b></td><td class="vc-muted" style="font-size:10px;text-transform:uppercase">${role}</td>` +
        `<td class="r vc-mono vc-muted">${def.target != null ? (def.hib ? '≥ ' : '≤ ') + fmtV(def, def.target) : '—'}</td>` +
        vals.map(v => { const s2 = tgtStatus(def, v); return `<td class="r vc-mono ${s2 > 0 ? 'vc-good' : s2 < 0 ? 'vc-bad' : ''}">${fmtV(def, v)}</td>`; }).join('') +
        `<td class="r vc-mono ${ost > 0 ? 'vc-good' : ost < 0 ? 'vc-bad' : ''}"><b>${fmtV(def, ov)}</b></td><td class="r vc-mono ${tone(g)}"><b>${fmtD(def, d)}</b></td></tr>`;
    }).join('')).join('');
}
function renderCategories() {
  const head = $('matrixHeaderRow'), body = $('matrixBody'); if (!head || !body) return;
  const tbl = head.closest('table'); if (tbl) tbl.classList.add('vc-table');
  const kids = n => n.children || n.l2 || n.items || [];
  const tree = (S.payload.cat_tree || []).slice().sort((a, b) => (b.total || 0) - (a.total || 0));
  const hasL2 = tree.some(n => kids(n).length);
  document.querySelectorAll('.lvl-btn[data-depth]').forEach(b => {
    const dpt = +b.dataset.depth;
    b.classList.toggle('active', dpt === S.catDepth);
    b.disabled = dpt === 2 && !hasL2;
    b.title = b.disabled ? 'L2 drivers not provided by the server yet' : '';
  });
  if (S.catDepth === 2 && !hasL2) S.catDepth = 1;
  const totDet = tree.reduce((a, n) => a + (n.total || 0), 0), mx = Math.max(1, ...tree.map(n => n.total || 0));
  const badge = $('catBadge'); if (badge) badge.textContent = `${totDet.toLocaleString()} detractors · all data · not filter-aware`;
  head.innerHTML = '<th>Category</th><th class="r">Detractors</th><th class="r">Share of scored</th><th class="r">Share of detractors</th><th></th>';
  const row = (n, l2) => `<tr class="${l2 ? 'vc-cat-l2' : ''}"><td title="${esc(n.name)}">${l2 ? '↳ ' : ''}${esc(n.name)}</td><td class="r vc-mono vc-bad"><b>${(n.total || 0).toLocaleString()}</b></td>` +
    `<td class="r vc-mono">${isNum(n.share) ? (n.share * 100).toFixed(1) + '%' : '—'}</td><td class="r vc-mono vc-muted">${totDet ? (((n.total || 0) / totDet) * 100).toFixed(1) + '%' : '—'}</td>` +
    `<td style="width:30%"><span class="vc-mini-bar" style="width:${((n.total || 0) / mx * 100).toFixed(1)}%;${l2 ? 'opacity:.55' : ''}"></span></td></tr>`;
  body.innerHTML = tree.length
    ? tree.map(n => row(n, false) + (S.catDepth === 2 ? kids(n).slice().sort((a, b) => (b.total || 0) - (a.total || 0)).map(c => row(c, true)).join('') : '')).join('')
    : '<tr><td colspan="5" class="vc-empty">No detractor categories returned by the server.</td></tr>';
}

/* ═══ 11. RIDGE MODEL (shared by Correlation residuals & What-If) ═══ */
function solveSym(A, b) {
  const n = b.length, M = A.map((r, i) => Array.from(r).concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function designFrom(obs, keys) {
  const n = obs.length, k = keys.length, W = obs.reduce((a, o) => a + o.w, 0);
  const mu = new Array(k).fill(0), sd = new Array(k).fill(0), ws = new Array(k).fill(0);
  obs.forEach(o => keys.forEach((key, j) => { const v = o.x[key]; if (isNum(v)) { mu[j] += o.w * v; ws[j] += o.w; } }));
  for (let j = 0; j < k; j++) mu[j] = ws[j] ? mu[j] / ws[j] : 0;
  obs.forEach(o => keys.forEach((key, j) => { const v = o.x[key]; if (isNum(v)) sd[j] += o.w * (v - mu[j]) ** 2; }));
  for (let j = 0; j < k; j++) sd[j] = ws[j] ? Math.sqrt(sd[j] / ws[j]) : 0;
  let my = 0; obs.forEach(o => { my += o.w * o.y; }); my /= W || 1;
  let sy = 0; obs.forEach(o => { sy += o.w * (o.y - my) ** 2; }); sy = Math.sqrt(sy / (W || 1));
  const Z = obs.map(o => keys.map((key, j) => { const v = o.x[key]; return isNum(v) && sd[j] > 1e-12 ? (v - mu[j]) / sd[j] : 0; }));
  const zy = obs.map(o => (sy > 1e-12 ? (o.y - my) / sy : 0));
  return { n, k, keys, mu, sd, my, sy, Z, zy, w: obs.map(o => o.w / (W || 1)), coverage: ws.map(s => s / (W || 1)) };
}
function gram(D, mult) {
  const { n, k, Z, zy, w } = D, G = Array.from({ length: k }, () => new Float64Array(k)), g = new Float64Array(k);
  let tw = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i] * (mult ? mult[i] : 1); if (!wi) continue;
    tw += wi; const z = Z[i];
    for (let a = 0; a < k; a++) { const za = z[a] * wi; if (za === 0) continue; g[a] += za * zy[i]; const Ga = G[a]; for (let c = a; c < k; c++) Ga[c] += za * z[c]; }
  }
  if (tw <= 0) return null;
  for (let a = 0; a < k; a++) { g[a] /= tw; for (let c = a; c < k; c++) { G[a][c] /= tw; G[c][a] = G[a][c]; } }
  return { G, g };
}
function ridgeSolve(G, g, lambda, active) {
  const k = g.length, idx = []; for (let j = 0; j < k; j++) if (active[j]) idx.push(j);
  const out = new Array(k).fill(0); if (!idx.length) return out;
  const sol = solveSym(idx.map(a => idx.map(c => G[a][c] + (a === c ? lambda : 0))), idx.map(a => g[a]));
  if (!sol) return null;
  idx.forEach((j, t) => { out[j] = sol[t]; });
  return out;
}
function constrainedRidge(G, g, lambda, baseActive, expSign, enforce) {
  const active = baseActive.slice(), dropped = [];
  for (let it = 0; it <= active.length; it++) {
    const b = ridgeSolve(G, g, lambda, active); if (!b) return null;
    if (!enforce) return { b, active, dropped };
    let worst = -1, wv = 0;
    b.forEach((v, j) => { if (active[j] && v * expSign[j] < wv) { wv = v * expSign[j]; worst = j; } });
    if (worst < 0) return { b, active, dropped };
    active[worst] = false; dropped.push(worst);
  }
  return { b: new Array(g.length).fill(0), active, dropped };
}
const dot = (z, b) => { let s = 0; for (let j = 0; j < z.length; j++) s += z[j] * b[j]; return s; };
function r2Of(D, b, rowsMask) {
  let sse = 0, sst = 0;
  for (let i = 0; i < D.n; i++) { if (rowsMask && !rowsMask[i]) continue; const e = D.zy[i] - dot(D.Z[i], b); sse += D.w[i] * e * e; sst += D.w[i] * D.zy[i] ** 2; }
  return sst > 0 ? 1 - sse / sst : 0;
}
function fitRidge(obs, keys, opt = {}) {
  if (!keys.length || obs.length < 8) return null;
  const D = designFrom(obs, keys); if (D.sy < 1e-9) return null;
  const expSign = keys.map(k => (DEF[k].hib ? 1 : -1));
  const baseActive = keys.map((_, j) => D.sd[j] > 1e-9 && D.coverage[j] >= 0.5);
  if (!baseActive.some(Boolean)) return null;
  const rng = mulberry32(1234), folds = 5, fold = new Int32Array(D.n);
  const perm = Array.from({ length: D.n }, (_, i) => i).sort(() => rng() - 0.5);
  perm.forEach((i, t) => { fold[i] = t % folds; });
  let best = { lambda: 0.3, cv: null };
  if (D.n >= 20) {
    for (const l of [0.01, 0.03, 0.1, 0.3, 1, 3]) {
      let sse = 0, sst = 0, ok = true;
      for (let f = 0; f < folds && ok; f++) {
        const gr = gram(D, Array.from(fold, x => (x === f ? 0 : 1)));
        const fit = gr && constrainedRidge(gr.G, gr.g, l, baseActive, expSign, opt.enforce);
        if (!fit) { ok = false; break; }
        for (let i = 0; i < D.n; i++) if (fold[i] === f) { const e = D.zy[i] - dot(D.Z[i], fit.b); sse += D.w[i] * e * e; sst += D.w[i] * D.zy[i] ** 2; }
      }
      const cv = ok && sst > 0 ? 1 - sse / sst : null;
      if (isNum(cv) && (best.cv == null || cv > best.cv)) best = { lambda: l, cv };
    }
  }
  const full = gram(D); if (!full) return null;
  const fit = constrainedRidge(full.G, full.g, best.lambda, baseActive, expSign, opt.enforce); if (!fit) return null;
  const toRaw = bz => keys.map((_, j) => (D.sd[j] > 1e-12 ? bz[j] * D.sy / D.sd[j] : 0));
  const beta = toRaw(fit.b), boot = [];
  if (opt.boot) {
    const br = mulberry32(42);
    for (let b = 0; b < opt.boot; b++) {
      const mult = new Array(D.n).fill(0); for (let i = 0; i < D.n; i++) mult[Math.floor(br() * D.n)]++;
      const gr = gram(D, mult), f = gr && constrainedRidge(gr.G, gr.g, best.lambda, baseActive, expSign, opt.enforce);
      if (f) boot.push(toRaw(f.b));
    }
  }
  return {
    D, keys, beta, bz: fit.b, active: fit.active, lambda: best.lambda, cv: best.cv, r2: r2Of(D, fit.b), boot, n: D.n,
    dropped: fit.dropped.map(j => keys[j]), excluded: keys.filter((_, j) => !baseActive[j]),
    predictRow: x => D.my + keys.reduce((a, k, j) => a + beta[j] * ((isNum(x[k]) ? x[k] : D.mu[j]) - D.mu[j]), 0)
  };
}

/* ═══ 12. CORRELATION ═══ */
function getCorr() {
  const sig = filterSig() + '#' + S.corr.unit + '#' + S.corr.minVol;
  if (S.corrCache && S.corrCache.sig === sig) return S.corrCache;
  const unit = S.corr.unit, selNames = new Set([...S.filters[unit]].map(i => S.C.labels[unit][i]));
  const allKeys = ['sentiment', ...LEVERS_ALL].filter(k => !DEF[k].missing);
  const rows = agg(unit, unit).filter(g => !BLANK_LABELS.has(g.name) && g.s.sent_den >= S.corr.minVol).map(g => {
    const o = { id: g.name, n: g.s.sent_den, closed: g.s.closed, sel: selNames.has(g.name) };
    allKeys.forEach(k => { o[k] = DEF[k].f(g.s); });
    return o;
  });
  const hk = CORR_KEYS.filter(k => !DEF[k].missing);
  const matrix = hk.map(a => hk.map(b => (a === b ? { r: 1, n: rows.filter(x => isNum(x[a])).length, p: 0 } : pearson(rows, a, b))));
  const strip = allKeys.filter(k => k !== 'sentiment').map(k => {
    const pr = pearson(rows, 'sentiment', k), sp = spearman(rows, 'sentiment', k), def = DEF[k];
    return { key: k, def, r: pr.r, p: pr.p, n: pr.n, rho: sp.r, zeroVar: !!pr.zeroVar, aligned: isNum(pr.r) ? (pr.r > 0) === def.hib : null };
  });
  const outliers = [];
  hk.forEach(k => {
    const vals = rows.map(r => r[k]).filter(isNum); if (vals.length < 6) return;
    const med = median(vals), mad = median(vals.map(v => Math.abs(v - med))); if (!(mad > 0)) return;
    rows.forEach(r => {
      const v = r[k]; if (!isNum(v)) return;
      const z = 0.6745 * (v - med) / mad;
      if (Math.abs(z) >= 2.5) { const better = (z > 0) === DEF[k].hib; outliers.push({ type: better ? 'Better than peers' : 'Worse than peers', better, id: r.id, key: k, value: v, ref: med, refLbl: 'median', z, n: r.n, sentiment: r.sentiment }); }
    });
  });
  const vk = VEHICLES.filter(k => !DEF[k].missing);
  const obs = rows.filter(r => isNum(r.sentiment)).map(r => ({ id: r.id, w: r.n, y: r.sentiment, x: r }));
  const model = obs.length >= 12 ? fitRidge(obs, vk, { enforce: false }) : null;
  if (model) {
    const res = obs.map(o => ({ o, yh: model.predictRow(o.x) })).map(e => ({ ...e, e: e.o.y - e.yh }));
    const es = res.map(e => e.e), med = median(es), mad = median(es.map(v => Math.abs(v - med)));
    if (mad > 0) res.forEach(e => {
      const z = 0.6745 * (e.e - med) / mad;
      if (Math.abs(z) >= 2.5) outliers.push({ type: z > 0 ? 'Over-performer' : 'Under-performer', better: z > 0, id: e.o.id, key: 'sentiment', value: e.o.y, ref: e.yh, refLbl: 'model', z, n: e.o.w, sentiment: e.o.y });
    });
  }
  outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  S.corrCache = { sig, unit, rows, hk, matrix, strip, outliers, model };
  return S.corrCache;
}
function renderCorrelation() {
  renderCorrControls();
  if (!window.d3) { const h = $('corr-strip'); if (h) h.innerHTML = '<div class="vc-empty">D3 not loaded</div>'; return; }
  const res = getCorr();
  const note = $('corr-note');
  if (note) {
    const miss = KPIS.filter(k => k.missing).map(k => k.label);
    note.textContent = [res.rows.length < 8 ? `Only ${res.rows.length} ${DIM_LABEL[res.unit].toLowerCase()} units qualify, so treat r values as unstable.` : '', miss.length ? `No data yet: ${miss.join(', ')}.` : ''].filter(Boolean).join(' ');
  }
  renderCorrInsights(res); renderCorrStrip(res); renderCorrHeatmap(res); renderCorrScatter(res); renderOutliers(res);
}
function renderCorrControls() {
  const u = $('corr-unit'), mn = $('corr-min');
  if (u && !u.dataset.vc) { u.dataset.vc = '1'; u.innerHTML = ['sub_pod', 'market', 'region', 'segment', 'week', 'month'].map(d => `<option value="${d}">${DIM_LABEL[d]}</option>`).join(''); }
  if (u) u.value = S.corr.unit;
  if (mn) mn.value = S.corr.minVol;
}
function renderCorrInsights(res) {
  const host = $('corr-insights'); if (!host) return;
  const sig = res.strip.filter(s => isNum(s.r) && isNum(s.p) && s.p < 0.05);
  const best = sig.filter(s => s.aligned).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const counter = sig.filter(s => s.aligned === false).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const srv = S.payload.correlations || {};
  const srvTxt = (srv.strip || []).map(s => `${esc(s.label)} <b class="vc-mono ${s.aligned ? 'vc-good' : 'vc-bad'}">${fmtR(s.r)}</b>`).join(' · ') || 'n/a';
  const card = (icon, t, b, cls = '') => `<div class="vc-card vc-ins ${cls}"><div class="vc-ins-t">${icon} ${t}</div><div class="vc-ins-b">${b}</div></div>`;
  host.innerHTML =
    card('📌', 'Strongest aligned driver', best ? `<b>${esc(best.def.label)}</b> · r <b class="vc-mono">${fmtR(best.r)}</b> (p ${fmtP(best.p)}, ρ ${fmtR(best.rho)}, n ${best.n})` : 'No significant aligned driver at this unit.', best ? 'is-good' : '') +
    card('⚠️', 'Counter-intuitive signal', counter ? `<b>${esc(counter.def.label)}</b> moves opposite to expectation (r ${fmtR(counter.r)}). Check for confounding, e.g. complex queues.` : 'None significant.', counter ? 'is-bad' : '') +
    card('🧪', 'Coverage', `${res.rows.length} ${DIM_LABEL[res.unit].toLowerCase()} units with ≥ ${S.corr.minVol} scored cases. The ${DIM_LABEL[res.unit].toLowerCase()} filter is ignored so peers stay visible; selected units are outlined.${res.model ? ` Vehicle model R² ${(res.model.r2 * 100).toFixed(0)}%.` : ''}`) +
    card('👤', `Agent level · all data (${srv.n_agents || '?'} agents)`, srvTxt + '<div class="vc-note" style="margin-top:6px">Computed server-side; not filter-aware.</div>');
}
function renderCorrStrip(res) {
  const host = $('corr-strip'); if (!host) return; host.innerHTML = '';
  const data = res.strip.slice().sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0)), P = pal();
  if (!data.length) { host.innerHTML = '<div class="vc-empty">No metrics to correlate.</div>'; return; }
  const W = Math.max(420, host.clientWidth || 640), rowH = 28, m = { top: 24, right: 130, bottom: 26, left: 170 }, ih = data.length * rowH, iw = W - m.left - m.right;
  const svg = d3.select(host).append('svg').attr('viewBox', [0, 0, W, ih + m.top + m.bottom]).attr('width', '100%');
  const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
  const x = d3.scaleLinear().domain([-1, 1]).range([0, iw]), y = d3.scaleBand().domain(data.map(d => d.key)).range([0, ih]).padding(0.28);
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).ticks(8).tickFormat(d3.format('+.1f')))
    .call(a => a.selectAll('text').attr('fill', P.axis).attr('font-size', 10)).call(a => a.selectAll('line,path').attr('stroke', P.grid));
  g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', -6).attr('y2', ih).attr('stroke', P.axis).attr('stroke-dasharray', '3,3');
  g.append('text').attr('x', 0).attr('y', -10).attr('font-size', 10).attr('fill', P.axis).text('◀ moves against Sentiment');
  g.append('text').attr('x', iw).attr('y', -10).attr('text-anchor', 'end').attr('font-size', 10).attr('fill', P.axis).text('moves with Sentiment ▶');
  const row = g.selectAll('g.vc-srow').data(data).join('g').attr('class', 'vc-srow').style('cursor', 'pointer')
    .on('mousemove', (e, d) => tip.show(`<div class="h">${esc(d.def.label)} ↔ Sentiment %</div><div>Pearson r <b class="vc-mono">${fmtR(d.r)}</b> ${stars(d.p)} · Spearman ρ <b class="vc-mono">${fmtR(d.rho)}</b></div><div class="s">p ${fmtP(d.p)} · n ${d.n} ${DIM_LABEL[res.unit].toLowerCase()}s</div><div>Expected sign <b>${d.def.hib ? '+' : '−'}</b> · ${d.aligned == null ? 'n/a' : d.aligned ? '✓ aligned' : '✗ counter-intuitive'}</div>${d.zeroVar ? '<div class="vc-warn">No variance in this slice</div>' : ''}<div class="s">Click to plot</div>`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { tip.hide(); S.corr.pair = [d.key, 'sentiment']; renderCorrHeatmap(res); renderCorrScatter(res); });
  row.append('rect').attr('x', -m.left).attr('y', d => y(d.key) - 4).attr('width', W).attr('height', y.bandwidth() + 8).attr('fill', 'transparent');
  row.append('text').attr('x', -10).attr('y', d => y(d.key) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').attr('font-size', 11).attr('fill', d => d.def.role === 'vehicle' ? P.ink : P.muted).text(d => d.def.label);
  row.append('rect').attr('y', d => y(d.key)).attr('height', y.bandwidth()).attr('rx', 3).attr('x', x(0)).attr('width', 0)
    .attr('fill', d => d.aligned == null ? P.grid : d.aligned ? P.good : P.bad).attr('opacity', d => isNum(d.p) && d.p < 0.05 ? 1 : 0.4)
    .transition().duration(REDUCED ? 0 : 450).attr('x', d => isNum(d.r) ? Math.min(x(0), x(d.r)) : x(0)).attr('width', d => isNum(d.r) ? Math.abs(x(d.r) - x(0)) : 0);
  row.append('text').attr('class', 'vc-mono').attr('y', d => y(d.key) + y.bandwidth() / 2 + 4).attr('font-size', 11)
    .attr('x', d => isNum(d.r) ? x(d.r) + (d.r >= 0 ? 6 : -6) : x(0) + 6).attr('text-anchor', d => isNum(d.r) && d.r < 0 ? 'end' : 'start')
    .attr('fill', d => d.aligned === false ? P.bad : P.ink)
    .text(d => isNum(d.r) ? fmtR(d.r) + stars(d.p) + (d.aligned === false ? ' ✗' : ' ✓') : (d.zeroVar ? 'no variance' : 'n/a'));
}
function renderCorrHeatmap(res) {
  const host = $('corr-heatmap'); if (!host) return; host.innerHTML = '';
  const keys = res.hk, n = keys.length, P = pal(); if (n < 2) return;
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
    .on('mousemove', (e, d) => tip.show(`<div class="h">${esc(DEF[d.a].label)} × ${esc(DEF[d.b].label)}</div><div>r <b class="vc-mono">${fmtR(d.c.r)}</b> ${stars(d.c.p)}</div><div class="s">p ${fmtP(d.c.p)} · n ${d.c.n}</div>`, e))
    .on('mouseleave', () => tip.hide())
    .on('click', (e, d) => { if (d.a === d.b) return; tip.hide(); S.corr.pair = d.a === 'sentiment' ? [d.b, 'sentiment'] : d.b === 'sentiment' ? [d.a, 'sentiment'] : [d.b, d.a]; renderCorrHeatmap(res); renderCorrScatter(res); });
  g.selectAll('text.v').data(cells).join('text').attr('class', 'v vc-mono')
    .attr('x', d => d.j * size + (size - 2) / 2).attr('y', d => d.i * size + (size - 2) / 2 + 4).attr('text-anchor', 'middle')
    .attr('font-size', Math.max(8, size / 4.8)).attr('pointer-events', 'none')
    .attr('fill', d => isNum(d.c.r) && Math.abs(d.c.r) > 0.55 ? '#FFFFFF' : '#0F172A').text(d => isNum(d.c.r) ? d.c.r.toFixed(2) : '–');
  g.selectAll('text.rl').data(keys).join('text').attr('class', 'rl').attr('x', -8).attr('y', (d, i) => i * size + size / 2 + 3)
    .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', d => d === 'sentiment' ? P.warn : P.axis).text(d => DEF[d].label);
  g.selectAll('text.cl').data(keys).join('text').attr('class', 'cl').attr('transform', (d, i) => `translate(${i * size + size / 2},${n * size + 8}) rotate(-45)`)
    .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', d => d === 'sentiment' ? P.warn : P.axis).text(d => DEF[d].label);
}
function renderCorrScatter(res) {
  const host = $('corr-scatter'); if (!host) return; host.innerHTML = '';
  let [kx, ky] = S.corr.pair; if (!DEF[kx] || DEF[kx].missing) kx = 'irt';
  const dx = DEF[kx], dy = DEF[ky], P = pal();
  const pts = res.rows.filter(r => isNum(r[kx]) && isNum(r[ky])), st = pearson(res.rows, kx, ky);
  const tEl = $('corr-scatter-title');
  if (tEl) tEl.innerHTML = `${esc(dx.label)} → ${esc(dy.label)} <span class="vc-sub vc-mono">r ${fmtR(st.r)}${stars(st.p)} · R² ${isNum(st.r) ? (st.r * st.r * 100).toFixed(1) + '%' : '—'} · n ${st.n}</span>`;
  if (pts.length < 3) { host.innerHTML = '<div class="vc-empty">Not enough units with data. Lower the minimum or pick another unit.</div>'; return; }
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
  if (sxx > 0) { const sl = sxy / sxx, [x0, x1] = x.domain(); g.append('line').attr('clip-path', `url(#${clipId})`).attr('x1', x(x0)).attr('y1', y(my + sl * (x0 - mx))).attr('x2', x(x1)).attr('y2', y(my + sl * (x1 - mx))).attr('stroke', P.warn).attr('stroke-width', 2).attr('stroke-dasharray', '6,4'); }
  const yd = y.domain(), xd = x.domain();
  if (dy.target != null && dy.target >= yd[0] && dy.target <= yd[1]) g.append('line').attr('x1', 0).attr('x2', iw).attr('y1', y(dy.target)).attr('y2', y(dy.target)).attr('stroke', P.good).attr('stroke-opacity', 0.6);
  if (dx.target != null && dx.target >= xd[0] && dx.target <= xd[1]) g.append('line').attr('x1', x(dx.target)).attr('x2', x(dx.target)).attr('y1', 0).attr('y2', ih).attr('stroke', P.good).attr('stroke-opacity', 0.6);
  const out = new Set(res.outliers.filter(o => o.key === kx || o.key === ky).map(o => o.id));
  const rS = d3.scaleSqrt().domain([0, d3.max(pts, d => d.n) || 1]).range([3, 14]);
  g.selectAll('circle').data(pts).join('circle').attr('cx', d => x(d[kx])).attr('cy', d => y(d[ky])).attr('r', d => rS(d.n))
    .attr('fill', d => out.has(d.id) ? P.bad : P.cyan).attr('fill-opacity', 0.65)
    .attr('stroke', d => d.sel ? P.ink : out.has(d.id) ? P.bad : 'none').attr('stroke-width', d => d.sel ? 2 : 1).style('cursor', 'pointer')
    .on('mousemove', (e, d) => tip.show(`<div class="h">${esc(DIM_LABEL[res.unit])}: ${esc(d.id)}</div><div>${esc(dx.label)} <b class="vc-mono">${fmtV(dx, d[kx])}</b></div><div>${esc(dy.label)} <b class="vc-mono">${fmtV(dy, d[ky])}</b></div><div class="s">Scored ${Math.round(d.n).toLocaleString()}${out.has(d.id) ? ' · <span class="vc-bad">outlier</span>' : ''} · click to ${d.sel ? 'remove' : 'add'} filter</div>`, e))
    .on('mouseleave', () => tip.hide()).on('click', (e, d) => { tip.hide(); toggleFilter(res.unit, d.id); });
}
function renderOutliers(res) {
  const badge = $('corr-outliers-badge'); if (badge) badge.textContent = `${res.outliers.length} flagged · ${DIM_LABEL[res.unit]} level`;
  const body = $('corr-outliers-body'); if (!body) return;
  const tbl = body.closest('table'); if (tbl) tbl.classList.add('vc-table');
  body.innerHTML = res.outliers.length
    ? res.outliers.slice(0, 30).map(o => { const def = DEF[o.key]; return `<tr><td><span class="vc-tag ${o.better ? 'pos' : 'neg'}">${o.type}</span></td><td>${esc(o.id)}</td><td>${esc(def.label)}</td><td class="r vc-mono">${fmtV(def, o.value)}</td><td class="r vc-mono vc-muted">${o.refLbl} ${fmtV(def, o.ref)}</td><td class="r vc-mono ${Math.abs(o.z) >= 5 ? 'vc-bad' : ''}">${o.z > 0 ? '+' : ''}${o.z.toFixed(2)}</td><td class="r vc-mono vc-muted">${Math.round(o.n).toLocaleString()}</td><td class="r vc-mono">${fmtV(DEF.sentiment, o.sentiment)}</td></tr>`; }).join('')
    : '<tr><td colspan="8" class="vc-empty">No outliers at robust |z| ≥ 2.5.</td></tr>';
}

/* ═══ 13. WHAT-IF SIMULATOR — model, levers, readouts ═══ */
function simObs(units, keys) {
  return agg(units, units[0])
    .filter(g => !g.names.some(n => BLANK_LABELS.has(n)) && g.s.sent_den >= S.sim.minN)
    .map(g => { const x = {}; keys.forEach(k => { x[k] = DEF[k].f(g.s); }); return { id: g.name, w: g.s.sent_den, y: DEF.sentiment.f(g.s), x }; })
    .filter(o => isNum(o.y));
}
function buildSimModel(keys) {
  const cands = [];
  for (const u of SIM_UNITS) {
    const obs = simObs(u, keys);
    if (obs.length < Math.max(15, Math.ceil(keys.length * 1.5))) continue;
    const W = obs.reduce((a, o) => a + o.w, 0) || 1;
    const cov = keys.map(k => obs.reduce((a, o) => a + (isNum(o.x[k]) ? o.w : 0), 0) / W);
    cands.push({ u, obs, cov, score: cov.filter(c => c >= 0.5).length * 1e6 + obs.length });
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands) {
    const m = fitRidge(c.obs, keys, { enforce: S.sim.enforce, boot: 60 });
    if (m) { m.unit = c.u; m.obs = c.obs; return m; }
  }
  return null;
}
function leverWhy(k) {
  const m = S.sim.model; if (!m) return 'no model in scope';
  const j = m.keys.indexOf(k); if (j < 0) return 'not in model';
  if (m.D.sd[j] <= 1e-9) return 'no variance · in this scope';
  if (m.D.coverage[j] < 0.5) return `data gap · ${Math.round(m.D.coverage[j] * 100)}% coverage at ${m.unit.map(d => DIM_LABEL[d]).join('×')}`;
  if (m.dropped.includes(k)) return 'wrong direction · dropped by guard';
  return 'negligible effect';
}
function peerQ(obs, key) {
  const pairs = obs.filter(o => isNum(o.x[key])).map(o => ({ v: o.x[key], w: o.w })).sort((a, b) => a.v - b.v);
  if (pairs.length < 5) return null;
  const q = p => wquant(pairs, p), W = pairs.reduce((a, p) => a + p.w, 0), mu = pairs.reduce((a, p) => a + p.w * p.v, 0) / W;
  return { p02: q(0.02), p05: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p98: q(0.98), n: pairs.length, sd: Math.sqrt(pairs.reduce((a, p) => a + p.w * (p.v - mu) ** 2, 0) / W) };
}
function simNote() {
  const m = S.sim.model;
  if (S.sim.src === 'fit') return `Weighted ridge regression over ${m.n.toLocaleString()} ${m.unit.map(d => DIM_LABEL[d]).join(' × ')} cells (≥ ${S.sim.minN} scored each). Peers outside a filtered ${DIM_LABEL[m.unit[0]]} are kept so the model has contrast; the baseline is your exact scope. Associational, not causal: use it to rank levers, not to promise outcomes.`;
  if (S.sim.src === 'server') return 'Too few cells in scope to fit a model. Using server coefficients for IRT, Reopen and Esc Rate only. Widen the filters for a full fit.';
  return 'Too little data in scope to fit a model. Widen the filters.';
}
function renderSimulator() {
  const tot = agg(); S.sim.tot = tot;
  S.sim.baseSent = DEF.sentiment.f(tot);
  const keys = (S.sim.scope === 'vehicles' ? LEVERS_VEH : LEVERS_ALL).filter(k => !DEF[k].missing && isNum(DEF[k].f(tot)));
  const t0 = performance.now();
  const model = keys.length && isNum(S.sim.baseSent) ? buildSimModel(keys) : null;
  S.sim.fitMs = Math.round(performance.now() - t0);
  S.sim.model = model;
  const peerObs = model ? model.obs : simObs(['sub_pod'], keys);
  const srv = (S.payload.simulator && S.payload.simulator.beta) || {};
  const SRV = { irt: +srv.irt || 0, reopen: +srv.reopen || 0, escRate: +srv.esc_rate || 0 };
  S.sim.src = model ? 'fit' : Object.values(SRV).some(v => v !== 0) ? 'server' : 'none';
  if (model) console.info('[VectorCore] what-if model', { unit: model.unit, n: model.n, r2: model.r2, cv: model.cv, lambda: model.lambda, ms: S.sim.fitMs });
  S.sim.levers = keys.map((k, j) => {
    const def = DEF[k], base = def.f(tot), q = peerQ(peerObs, k);
    const pts = [base, def.target, q && q.p02, q && q.p98].filter(isNum);
    let lo = Math.min(...pts), hi = Math.max(...pts);
    const pad = (hi - lo) * 0.12 || Math.abs(base) * 0.25 || 0.05;
    lo -= pad; hi += pad;
    if (def.fmt.startsWith('pct')) { lo = Math.max(0, lo); hi = Math.min(1, hi); } else lo = Math.max(0, lo);
    const b = model ? model.beta[j] : (SRV[k] || 0);
    return { key: k, def, base, cur: base, lo, hi, step: (hi - lo) / 400, b, bz: model ? model.bz[j] : 0, q, sd: model ? model.D.sd[j] : (q ? q.sd : 0), contrib: 0 };
  });
  renderSimControls();
  renderSimSliders();
  const host = $('sim-canvas');
  if (host && g3Init(host)) g3Build();
  updateSim();
}
function renderSimControls() {
  const host = $('sim-controls'); if (!host) return;
  const nAll = LEVERS_ALL.filter(k => !DEF[k].missing).length, nVeh = LEVERS_VEH.filter(k => !DEF[k].missing).length;
  host.innerHTML = `<div class="vc-sim-ctl"><span class="vc-ctl">Preset</span>` +
    [['baseline', '↺ Baseline'], ['targets', '🎯 Targets'], ['median', '⚖ Median peer'], ['topq', '🏆 Top quartile'], ['best', '💎 Best-in-class'], ['stress', '🔥 Stress']]
      .map(([k, l]) => `<button type="button" class="vc-btn sm" data-vc-sim-preset="${k}">${l}</button>`).join('') +
    `<span class="vc-sep"></span><div class="vc-seg"><button type="button" class="vc-btn sm ${S.sim.scope === 'all' ? 'is-on' : ''}" data-vc-sim-scope="all">All metrics · ${nAll}</button><button type="button" class="vc-btn sm ${S.sim.scope === 'vehicles' ? 'is-on' : ''}" data-vc-sim-scope="vehicles">Vehicles · ${nVeh}</button></div>` +
    `<label class="vc-ctl" title="Drops levers whose fitted effect has the opposite sign to the direction of good"><input type="checkbox" id="vc-sim-enforce" ${S.sim.enforce ? 'checked' : ''}> Expected direction only</label>` +
    `<span class="vc-sep"></span><button type="button" class="vc-btn sm" data-vc-sim-save>💾 Save scenario</button><button type="button" class="vc-btn sm" data-vc-export="scenario">⬇ CSV</button></div>`;
}
const leverPos = (L, v) => clamp((v - L.lo) / ((L.hi - L.lo) || 1) * 100, 0, 100);
function renderSimSliders() {
  const host = $('sim-sliders'); if (!host) return;
  if (!S.sim.levers.length) { host.innerHTML = '<div class="vc-empty">No levers have data in this scope.</div>'; return; }
  const row = (L, i) => {
    const def = L.def, flat = Math.abs(L.b) < 1e-12, q = L.q;
    const band = q ? `<i class="b1" style="left:${leverPos(L, q.p10).toFixed(1)}%;width:${(leverPos(L, q.p90) - leverPos(L, q.p10)).toFixed(1)}%"></i><i class="b2" style="left:${leverPos(L, q.p25).toFixed(1)}%;width:${(leverPos(L, q.p75) - leverPos(L, q.p25)).toFixed(1)}%"></i>` : '';
    return `<div class="vc-sim-row${flat ? ' is-flat' : ''}" id="vc-sim-row-${i}">` +
      `<div class="vc-sim-head"><span title="${esc(def.desc || '')}">${esc(def.label)} <span class="vc-muted">${def.hib ? '↑' : '↓'}</span></span>` +
      `<span><b class="vc-mono" id="vc-sim-val-${i}">${fmtV(def, L.cur)}</b> <button type="button" class="vc-x" data-vc-sim-reset="${i}" title="Reset to baseline">↺</button></span></div>` +
      `<input type="range" data-vc-sim="${i}" id="vc-sim-in-${i}" min="${L.lo}" max="${L.hi}" step="${L.step}" value="${L.cur}">` +
      `<div class="vc-peer" title="Peers: P10–P90 light · P25–P75 dark · | baseline · ● scenario">${band}<b class="base" style="left:${leverPos(L, L.base).toFixed(1)}%"></b><em id="vc-sim-cur-${i}" style="left:${leverPos(L, L.cur).toFixed(1)}%"></em></div>` +
      `<div class="vc-sim-foot"><span>Base ${fmtV(def, L.base)}${q ? ' · P50 ' + fmtV(def, q.p50) : ''}${def.target != null ? ' · 🎯 ' + fmtV(def, def.target) : ''}</span><span class="vc-mono" id="vc-sim-imp-${i}">${flat ? esc(leverWhy(L.key)) : '±0.0 pp'}</span></div></div>`;
  };
  host.innerHTML = [['vehicle', '🚀 Vehicles'], ['context', '📦 Context']].map(([role, title]) => {
    const items = S.sim.levers.map((L, i) => [L, i]).filter(([L]) => L.def.role === role);
    return items.length ? `<div class="vc-sim-grp">${title} · ${items.length}</div>` + items.map(([L, i]) => row(L, i)).join('') : '';
  }).join('');
}
function simPredict(betas, values) {
  if (!isNum(S.sim.baseSent)) return null;
  return clamp01(S.sim.baseSent + S.sim.levers.reduce((a, L, j) => {
    const v = values ? (isNum(values[L.key]) ? values[L.key] : L.base) : L.cur;
    return a + (betas ? betas[j] : L.b) * (v - L.base);
  }, 0));
}
function setLever(i, v) {
  const L = S.sim.levers[i]; if (!L) return;
  L.cur = clamp(v, L.lo, L.hi);
  const inp = $('vc-sim-in-' + i); if (inp) inp.value = L.cur;
}
function applySimPreset(p) {
  S.sim.levers.forEach((L, i) => {
    const q = L.q, hib = L.def.hib;
    let v = L.base;
    if (p === 'targets' && L.def.target != null) v = L.def.target;
    if (q) {
      if (p === 'median') v = q.p50;
      if (p === 'topq') v = hib ? q.p75 : q.p25;
      if (p === 'best') v = hib ? q.p90 : q.p10;
      if (p === 'stress') v = hib ? q.p10 : q.p90;
    }
    setLever(i, isNum(v) ? v : L.base);
  });
  updateSim();
}
function planToTarget() {
  const tgt = DEF.sentiment.target, now = simPredict();
  if (!isNum(now)) return null;
  if (now >= tgt) return { reached: true, steps: [], final: now, singles: [] };
  let need = tgt - now; const steps = [];
  const cand = S.sim.levers.map(L => {
    const dir = L.def.hib ? 1 : -1, capV = L.q ? (dir > 0 ? L.q.p90 : L.q.p10) : null;
    const cap = isNum(capV) ? clamp(capV, L.lo, L.hi) : null;
    return { L, dir, aligned: L.b * dir > 0, cap, room: isNum(cap) ? Math.max(0, (cap - L.cur) * dir) : 0, perSd: Math.abs(L.b) * (L.sd || 0) };
  }).filter(c => c.aligned && c.room > 0 && c.perSd > 0).sort((a, b) => b.perSd - a.perSd);
  for (const c of cand) {
    if (need <= 1e-6) break;
    const move = Math.min(c.room, need / Math.abs(c.L.b)), gain = Math.abs(c.L.b) * move;
    steps.push({ i: S.sim.levers.indexOf(c.L), L: c.L, from: c.L.cur, to: c.L.cur + c.dir * move, gain });
    need -= gain;
  }
  const gap = tgt - now;
  const singles = S.sim.levers.filter(L => Math.abs(L.b) > 1e-12 && L.b * (L.def.hib ? 1 : -1) > 0).map(L => {
    const to = L.cur + gap / L.b, effort = L.sd > 0 ? Math.abs(to - L.cur) / L.sd : Infinity;
    const inPeer = L.q ? to >= Math.min(L.q.p02, L.q.p98) && to <= Math.max(L.q.p02, L.q.p98) : false;
    const valid = to >= 0 && (!L.def.fmt.startsWith('pct') || to <= 1);
    return { L, to, effort, inPeer, valid };
  }).filter(s => s.valid).sort((a, b) => a.effort - b.effort).slice(0, 5);
  return { reached: need <= 1e-6, steps, final: tgt - Math.max(0, need), short: Math.max(0, need), singles };
}
function gaugeHtml(base, pred, tgt) {
  const vals = [base, pred, tgt].filter(isNum); if (!vals.length) return '';
  let lo = Math.max(0, Math.min(...vals) - 0.04), hi = Math.min(1, Math.max(...vals) + 0.04); if (hi - lo < 0.05) hi = Math.min(1, lo + 0.05);
  const pos = v => clamp((v - lo) / (hi - lo) * 100, 0, 100);
  const seg = isNum(base) && isNum(pred) ? `<i style="left:${pos(Math.min(base, pred)).toFixed(1)}%;width:${Math.abs(pos(pred) - pos(base)).toFixed(1)}%;background:${pred >= base ? 'var(--cz-good,#10B981)' : 'var(--cz-bad,#F43F5E)'}"></i>` : '';
  return `<div class="vc-gauge"><div class="vc-gauge-track">${seg}<b class="t" style="left:${pos(tgt).toFixed(1)}%"></b>${isNum(base) ? `<b class="n" style="left:${pos(base).toFixed(1)}%"></b>` : ''}${isNum(pred) ? `<b class="p" style="left:${pos(pred).toFixed(1)}%"></b>` : ''}</div>` +
    `<div class="vc-gauge-ax vc-mono"><span>${(lo * 100).toFixed(0)}%</span><span>▮ now · ● scenario · ┃ target</span><span>${(hi * 100).toFixed(0)}%</span></div></div>`;
}
function updateSim() {
  const def = DEF.sentiment, base = S.sim.baseSent, pred = simPredict(), m = S.sim.model;
  S.sim.pred = pred;
  S.sim.levers.forEach((L, i) => {
    L.contrib = L.b * (L.cur - L.base);
    const v = $('vc-sim-val-' + i); if (v) v.textContent = fmtV(L.def, L.cur);
    const mk = $('vc-sim-cur-' + i); if (mk) mk.style.left = leverPos(L, L.cur).toFixed(1) + '%';
    const im = $('vc-sim-imp-' + i);
    if (im && Math.abs(L.b) > 1e-12) { im.textContent = fmtPP(L.contrib); im.className = 'vc-mono ' + (L.contrib > 5e-4 ? 'vc-good' : L.contrib < -5e-4 ? 'vc-bad' : 'vc-muted'); }
  });
  let band = null;
  if (m && m.boot.length >= 10 && isNum(pred)) { const ps = m.boot.map(b => simPredict(b)).filter(isNum).sort((a, b) => a - b); band = [quant(ps, 0.1), quant(ps, 0.9)]; }
  S.sim.band = band;
  const plan = planToTarget(); S.sim.plan = plan;
  const d = isNum(pred) && isNum(base) ? pred - base : null, gap = isNum(pred) ? pred - def.target : null;
  const ro = $('sim-readout');
  if (ro) {
    let planHtml = '';
    if (plan && plan.reached && !plan.steps.length) planHtml = `<div class="vc-ins-t vc-good" style="margin-top:14px">✅ Scenario meets the ${fmtV(def, def.target)} target</div>`;
    else if (plan && plan.steps.length) planHtml = `<div class="vc-ins-t" style="margin-top:14px">🧭 Fastest path to ${fmtV(def, def.target)}</div><ul class="vc-list">` +
      plan.steps.map(s => `<li><span>${esc(s.L.def.label)}</span><span class="vc-mono">${fmtV(s.L.def, s.from)} → <b>${fmtV(s.L.def, s.to)}</b> <span class="vc-good">${fmtPP(s.gain)}</span></span></li>`).join('') + '</ul>' +
      (plan.reached ? '' : `<div class="vc-note vc-warn">Even at best-in-class peer levels (P90), the model tops out near ${fmtV(def, plan.final)}, ${fmtPP(-plan.short)} short.</div>`) +
      `<button type="button" class="vc-btn sm" data-vc-sim-apply-plan style="margin-top:8px">Apply plan</button>`;
    else if (plan && !plan.reached) planHtml = '<div class="vc-note">No lever in this model has a reliable effect in the right direction.</div>';
    const singles = plan && plan.singles && plan.singles.length ? `<div class="vc-ins-t" style="margin-top:14px">➡️ Single-lever paths</div><ul class="vc-list">` +
      plan.singles.map(s => `<li><span>${esc(s.L.def.label)}</span><span class="vc-mono"><b>${fmtV(s.L.def, s.to)}</b> ${s.inPeer ? '<span class="vc-muted">within peers</span>' : '<span class="vc-warn">beyond peers</span>'}</span></li>`).join('') + '</ul>' : '';
    const chips = m ? `<div class="vc-model"><span class="vc-pill">Ridge λ ${m.lambda}</span><span class="vc-pill">R² ${(m.r2 * 100).toFixed(0)}%</span>${isNum(m.cv) ? `<span class="vc-pill">CV R² ${(m.cv * 100).toFixed(0)}%</span>` : ''}<span class="vc-pill">${m.n.toLocaleString()} cells</span><span class="vc-pill">${m.unit.map(x => DIM_LABEL[x]).join(' × ')}</span><span class="vc-pill">${S.fitMs || S.sim.fitMs} ms</span></div>` : '';
    const why = {};
    if (m) S.sim.levers.filter(L => Math.abs(L.b) < 1e-12).forEach(L => { const w = leverWhy(L.key).split(' · ')[0]; (why[w] = why[w] || []).push(L.def.label); });
    const drops = Object.keys(why).length ? `<div class="vc-note">${Object.entries(why).map(([w, ls]) => `<b>${esc(w)}</b>: ${ls.map(esc).join(', ')}`).join('<br>')}</div>` : '';
    ro.innerHTML = `<div class="vc-pred-l">Predicted Sentiment %</div>` +
      `<div class="vc-pred vc-mono ${tone(tgtStatus(def, pred))}">${fmtV(def, pred)}</div>` +
      (band ? `<div class="vc-band vc-mono">80% band ${fmtV(def, band[0])} – ${fmtV(def, band[1])}</div>` : '') +
      `<div class="vc-pred-meta"><span>Now <b class="vc-mono">${fmtV(def, base)}</b></span><span class="${tone(isNum(d) ? (d > 5e-4 ? 1 : d < -5e-4 ? -1 : 0) : 0)}">Δ <b class="vc-mono">${fmtPP(d)}</b></span><span class="${tone(isNum(gap) ? (gap >= 0 ? 1 : -1) : 0)}">vs 🎯 <b class="vc-mono">${fmtPP(gap)}</b></span></div>` +
      gaugeHtml(base, pred, def.target) + planHtml + singles + chips + drops + `<div class="vc-note">${simNote()}</div>`;
  }
  renderSimContrib();
  renderSimCompare();
  g3Update();
}
function contribRows(items, fmt) {
  const mx = Math.max(0.002, ...items.map(x => Math.abs(x.v))), P = pal();
  return items.map(x => { const w = Math.abs(x.v) / mx * 50; return `<div class="vc-contrib" title="${esc(x.tip || '')}"><span>${esc(x.label)}</span><div class="vc-contrib-track"><b></b><i style="${x.v >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`};background:${x.v >= 0 ? P.good : P.bad}"></i></div><span class="vc-mono ${x.v >= 0 ? 'vc-good' : 'vc-bad'}" style="text-align:right">${fmt(x.v)}</span></div>`; }).join('');
}
function renderSimContrib() {
  const host = $('sim-contrib'); if (!host) return;
  const moved = S.sim.levers.filter(L => Math.abs(L.contrib) > 1e-5).sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))
    .map(L => ({ label: L.def.label, v: L.contrib, tip: `${fmtV(L.def, L.base)} → ${fmtV(L.def, L.cur)}` }));
  const lev = S.sim.levers.filter(L => Math.abs(L.b) > 1e-12 && L.sd > 0)
    .map(L => ({ label: L.def.label, v: (L.b * (L.def.hib ? 1 : -1) > 0 ? 1 : -1) * Math.abs(L.b) * L.sd, tip: `1σ = ${fmtD(L.def, L.sd)}` })).sort((a, b) => b.v - a.v);
  host.innerHTML = (moved.length ? contribRows(moved, fmtPP) : '<div class="vc-note" style="margin-top:0">Move a slider or pick a preset to see each lever’s contribution.</div>') +
    `<h4 style="margin:16px 0 6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700" class="vc-muted">Leverage · +1σ peer improvement</h4>` +
    (lev.length ? contribRows(lev, fmtPP) : '<div class="vc-note">No fitted effects.</div>');
}
function renderSimCompare() {
  const host = ensureHost('vc-sim-compare', 'tab-simulator', { cls: 'vc-card vc-section' }); if (!host) return;
  const sv = S.sim.saved, def = DEF.sentiment;
  if (!sv.length) { host.innerHTML = '<div class="vc-sec-h"><span>Scenario comparison <span class="vc-sub">Save up to 4 scenarios to compare them under the current model</span></span></div>'; return; }
  const keys = S.sim.levers.filter(L => sv.some(s => isNum(s.values[L.key]) && Math.abs(s.values[L.key] - L.base) > 1e-9));
  const preds = sv.map(s => simPredict(null, s.values));
  host.innerHTML = `<div class="vc-sec-h"><span>Scenario comparison <span class="vc-sub">re-scored against the current scope &amp; model</span></span><button type="button" class="vc-btn sm" data-vc-sim-clear>Clear all</button></div>` +
    `<div style="overflow-x:auto"><table class="vc-table"><thead><tr><th>Metric</th><th class="r">Baseline</th>${sv.map((s, i) => `<th class="r">${esc(s.name)} <button type="button" class="vc-x" data-vc-sim-load="${i}" title="Load">⤴</button><button type="button" class="vc-x" data-vc-sim-del="${i}" title="Delete">✕</button></th>`).join('')}</tr></thead><tbody>` +
    `<tr class="vc-ns-row-t"><td><b>Predicted Sentiment %</b></td><td class="r vc-mono">${fmtV(def, S.sim.baseSent)}</td>${preds.map(p => `<td class="r vc-mono ${tone(tgtStatus(def, p))}"><b>${fmtV(def, p)}</b> <span class="vc-muted">${fmtPP(isNum(p) && isNum(S.sim.baseSent) ? p - S.sim.baseSent : null)}</span></td>`).join('')}</tr>` +
    keys.map(L => `<tr><td>${esc(L.def.label)}</td><td class="r vc-mono vc-muted">${fmtV(L.def, L.base)}</td>${sv.map(s => { const v = s.values[L.key]; const ch = isNum(v) && Math.abs(v - L.base) > 1e-9; return `<td class="r vc-mono ${ch ? tone(good(L.def, v - L.base)) : 'vc-muted'}">${fmtV(L.def, isNum(v) ? v : L.base)}</td>`; }).join('')}</tr>`).join('') +
    `</tbody></table></div>`;
}
function saveScenario() {
  if (!S.sim.levers.length) return;
  const names = ['A', 'B', 'C', 'D'], used = new Set(S.sim.saved.map(s => s.name));
  const name = 'Scenario ' + (names.find(n => !used.has('Scenario ' + n)) || names[S.sim.saved.length % 4]);
  if (S.sim.saved.length >= 4) S.sim.saved.shift();
  S.sim.saved.push({ name, values: Object.fromEntries(S.sim.levers.map(L => [L.key, L.cur])), at: fmtStamp(new Date()) });
  renderSimCompare(); toast(`${name} saved`);
}
function loadScenario(i) {
  const s = S.sim.saved[i]; if (!s) return;
  S.sim.levers.forEach((L, j) => setLever(j, isNum(s.values[L.key]) ? s.values[L.key] : L.base));
  updateSim();
}

/* ═══ 14. ORBITAL STAGE — 2D canvas · pseudo-3D projection (no WebGL / Three.js) ═══ */
const OC = { good: '#10B981', bad: '#F43F5E', warn: '#F59E0B', cyan: '#00E5D4', sky: '#38BDF8', slate: '#64748B', dim: '#475569' };
const CORE_Y = 3.4, LOOK_Y = 2.2, PILLAR_R = 0.42, PILLAR_MIN = 0.35, PILLAR_MAX = 5.2;
const G3 = {
  host: null, canvas: null, ctx: null, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, F: 600, tr: null,
  failed: false, spin: true, built: false, userCam: false,
  cam: { theta: 0.65, elev: 0.42, r: 25 }, drag: null, idleAt: 0, hover: -2, t0: performance.now(),
  items: [], stars: [], hits: [], R: 7, coreR: 1.6, coreRT: 1.6, ghostR: 1.6, coreCol: OC.good
};
const rOf = v => clamp(1.6 + ((isNum(v) ? v : DEF.sentiment.target) - DEF.sentiment.target) * 12, 0.5, 3.2);
function ocA(hex, a) { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex; }
function ocShade(hex, f) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex); if (!m) return hex;
  const c = [1, 2, 3].map(i => parseInt(m[i], 16)).map(v => Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function ocRR(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.lineTo(X + W - r, Y); x.quadraticCurveTo(X + W, Y, X + W, Y + r); x.lineTo(X + W, Y + H - r); x.quadraticCurveTo(X + W, Y + H, X + W - r, Y + H); x.lineTo(X + r, Y + H); x.quadraticCurveTo(X, Y + H, X, Y + H - r); x.lineTo(X, Y + r); x.quadraticCurveTo(X, Y, X + r, Y); x.closePath(); }
function health(L, v) {
  if (!isNum(v)) return 0;
  let p; const q = L.q;
  if (q && isNum(q.p10) && isNum(q.p90) && q.p90 > q.p10) {
    const pts = [[L.lo, 0], [q.p10, 0.1], [q.p25, 0.25], [q.p50, 0.5], [q.p75, 0.75], [q.p90, 0.9], [L.hi, 1]].filter(a => isNum(a[0])).sort((a, b) => a[0] - b[0]);
    p = v <= pts[0][0] ? 0 : v >= pts[pts.length - 1][0] ? 1 : null;
    for (let i = 1; p === null && i < pts.length; i++) if (v <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; p = x1 > x0 ? y0 + (y1 - y0) * (v - x0) / (x1 - x0) : y1; }
  } else p = (v - L.lo) / ((L.hi - L.lo) || 1);
  p = clamp01(p ?? 0.5);
  return L.def.hib ? p : 1 - p;
}

/* ── Projection: yaw (theta) → pitch (elev) → perspective divide ── */
function ocProj(x, y, z) {
  const T = G3.tr, xr = x * T.ct - z * T.st, zr = x * T.st + z * T.ct, yy = y - LOOK_Y;
  const yc = yy * T.ce - zr * T.se, zc = yy * T.se + zr * T.ce;
  const d = Math.max(0.5, G3.cam.r - zc), s = G3.F / d;
  return { x: G3.cx + xr * s, y: G3.cy - yc * s, s, d, zc, zr };
}
function ocCircle3D(r, y, tilt = 0, spin = 0, n = 96) {
  const ct = Math.cos(tilt), st = Math.sin(tilt), cs = Math.cos(spin), ss = Math.sin(spin), pts = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y1 = -z * st, z1 = z * ct;
    pts.push(ocProj(x * cs + z1 * ss, y + y1, -x * ss + z1 * cs));
  }
  return pts;
}
function ocStrokeRuns(ctx, pts, front, zRef) {
  ctx.beginPath(); let pen = false;
  for (const p of pts) { if ((p.zc >= zRef) === front) { if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; } } else pen = false; }
  ctx.stroke();
}
const ocFade = d => clamp(1 - Math.max(0, d - G3.cam.r) / (G3.R * 2.4) * 0.5, 0.5, 1);

/* ── Lifecycle (same API the rest of v5 calls) ── */
function g3Init(host) {
  if (G3.canvas) {
    if (!host.contains(G3.canvas)) { host.innerHTML = ''; host.appendChild(G3.canvas); g3Hud(host); }
    G3.host = host; g3Resize(); return true;
  }
  const cv = document.createElement('canvas'), ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) { G3.failed = true; host.innerHTML = '<div class="vc-empty" style="padding-top:140px">Canvas not supported in this browser. Sliders and readouts still work.</div>'; return false; }
  host.innerHTML = ''; host.appendChild(cv);
  G3.canvas = cv; G3.ctx = ctx; G3.host = host;
  cv.style.touchAction = 'none'; cv.style.cursor = 'grab';
  cv.addEventListener('pointerdown', e => { G3.drag = { x: e.clientX, y: e.clientY, th: G3.cam.theta, el: G3.cam.elev, moved: 0 }; try { cv.setPointerCapture(e.pointerId); } catch (_) { } cv.style.cursor = 'grabbing'; G3.idleAt = performance.now(); });
  cv.addEventListener('pointermove', e => {
    if (G3.drag) {
      const dx = e.clientX - G3.drag.x, dy = e.clientY - G3.drag.y;
      G3.drag.moved = Math.max(G3.drag.moved, Math.abs(dx) + Math.abs(dy));
      G3.cam.theta = G3.drag.th - dx * 0.008; G3.cam.elev = clamp(G3.drag.el + dy * 0.005, 0.12, 1.2);
      G3.userCam = true; G3.idleAt = performance.now(); tip.hide(); return;
    }
    g3Hover(e);
  });
  cv.addEventListener('pointerup', e => { const d = G3.drag; G3.drag = null; cv.style.cursor = 'grab'; try { cv.releasePointerCapture(e.pointerId); } catch (_) { } if (d && d.moved < 5) g3Click(e); });
  cv.addEventListener('pointerleave', () => { if (!G3.drag) { G3.hover = -2; tip.hide(); } });
  cv.addEventListener('wheel', e => { e.preventDefault(); G3.cam.r = clamp(G3.cam.r * (1 + Math.sign(e.deltaY) * 0.08), 12, 60); G3.userCam = true; G3.idleAt = performance.now(); }, { passive: false });
  cv.addEventListener('dblclick', () => g3ResetCam());
  g3Hud(host); g3Resize();
  return true;
}
function g3Hud(host) {
  if (host.querySelector('.vc-hud')) return;
  host.insertAdjacentHTML('beforeend', `<div class="vc-hud"><button type="button" class="vc-btn sm" data-vc-g3="reset" title="Reset view">⟲ View</button><button type="button" class="vc-btn sm ${G3.spin ? 'is-on' : ''}" data-vc-g3="spin" title="Auto-orbit">⟳ Orbit</button></div>` +
    `<div class="vc-hud-l">Core = predicted Sentiment · dashed ring = target · wireframe = today<br>Pillar height = health vs peers · colour = contribution · beam = influence</div>`);
}
function g3ResetCam() { G3.cam = { theta: 0.65, elev: 0.42, r: clamp(G3.R * 3.6, 22, 52) }; G3.userCam = false; G3.idleAt = performance.now(); }
function g3Resize() {
  if (!G3.canvas || !G3.host) return;
  const w = G3.host.clientWidth; if (!w) return;
  const h = clamp(Math.round(w / 1.618), 360, 600), dpr = Math.min(2, window.devicePixelRatio || 1);
  G3.host.style.height = h + 'px';
  if (G3.w !== w || G3.h !== h || G3.dpr !== dpr) {
    G3.w = w; G3.h = h; G3.dpr = dpr;
    G3.canvas.width = Math.round(w * dpr); G3.canvas.height = Math.round(h * dpr);
    G3.canvas.style.width = w + 'px'; G3.canvas.style.height = h + 'px';
  }
  G3.cx = w / 2; G3.cy = h * 0.52; G3.F = Math.min(h * 1.6, w * 1.2);
}
function g3Build() {
  if (!G3.ctx) return;
  const levers = S.sim.levers, n = levers.length;
  G3.R = Math.max(7, n * 0.62);
  G3.items = levers.map((L, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2, hb = PILLAR_MIN + PILLAR_MAX * health(L, L.base);
    return {
      L, i, x: Math.cos(a) * G3.R, z: Math.sin(a) * G3.R, h: hb, hT: hb, hb,
      ht: L.def.target != null ? PILLAR_MIN + PILLAR_MAX * health(L, L.def.target) : null,
      col: OC.sky, beam: OC.cyan, inf: 0, glow: 0, flow: 0, dir: 1, flat: false
    };
  });
  G3.coreR = G3.coreRT = G3.ghostR = rOf(S.sim.baseSent);
  if (!G3.stars.length) { const rnd = mulberry32(7); G3.stars = Array.from({ length: 150 }, () => ({ a: rnd() * Math.PI * 2, y: rnd(), r: rnd() * 1.3 + 0.3, tw: rnd() * 6 })); }
  if (!G3.userCam) g3ResetCam();
  G3.built = true;
}
function g3Update() {
  if (!G3.built) return;
  const tgt = DEF.sentiment.target, pred = S.sim.pred;
  G3.coreCol = !isNum(pred) ? OC.slate : pred >= tgt ? OC.good : pred >= tgt - 0.03 ? OC.warn : OC.bad;
  G3.coreRT = rOf(pred);
  const maxBz = Math.max(1e-9, ...S.sim.levers.map(L => Math.abs(L.bz || 0)));
  const maxC = Math.max(0.002, ...S.sim.levers.map(L => Math.abs(L.contrib)));
  G3.items.forEach(it => {
    const L = it.L, c = L.contrib, flat = Math.abs(L.b) < 1e-12;
    it.hT = PILLAR_MIN + PILLAR_MAX * health(L, L.cur);
    it.flat = flat;
    it.col = flat ? OC.dim : c > 5e-4 ? OC.good : c < -5e-4 ? OC.bad : OC.sky;
    it.beam = c > 5e-4 ? OC.good : c < -5e-4 ? OC.bad : OC.cyan;
    it.inf = flat ? 0 : (Math.abs(L.bz || 0) / maxBz) || (S.sim.src === 'server' ? 0.5 : 0);
    it.glow = Math.min(1, Math.abs(c) / maxC);
    it.flow = flat ? 0 : 0.15 + 0.85 * it.inf;
    it.dir = c < -5e-4 ? -1 : 1;
  });
}
function g3Start() {
  if (S.raf || !G3.built || S.tab !== 'simulator') return;
  const loop = () => {
    if (S.tab !== 'simulator' || !G3.built) { S.raf = null; return; }
    if (!document.hidden) { try { g3Frame(); } catch (e) { console.error('[VectorCore] orbital frame error', e); S.raf = null; return; } }
    S.raf = requestAnimationFrame(loop);
  };
  S.raf = requestAnimationFrame(loop);
}
function g3Stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = null; }

/* ── Frame ── */
function g3Frame() {
  const ctx = G3.ctx; if (!ctx || !G3.w) return;
  const now = performance.now(), t = (now - G3.t0) / 1000, k = REDUCED ? 1 : 0.14, c = G3.cam, dark = isDark();
  if (G3.spin && !G3.drag && !REDUCED && now - G3.idleAt > 3500) c.theta += 0.0016;
  G3.tr = { ct: Math.cos(c.theta), st: Math.sin(c.theta), ce: Math.cos(c.elev), se: Math.sin(c.elev) };
  G3.coreR += (G3.coreRT - G3.coreR) * k;
  G3.items.forEach(it => { it.h += (it.hT - it.h) * k; });
  ctx.setTransform(G3.dpr, 0, 0, G3.dpr, 0, 0);
  G3.hits = [];
  ocBackground(ctx, dark, t);
  ocFloor(ctx, dark);
  const core = ocProj(0, CORE_Y, 0);
  const items = G3.items.map(it => ({ it, b: ocProj(it.x, 0, it.z), top: ocProj(it.x, it.h, it.z) })).sort((a, b) => b.b.d - a.b.d);
  items.forEach(P => ocShadow(ctx, P, dark));
  items.filter(P => P.b.zr < 0).forEach(P => ocPillar(ctx, P, dark));
  ocBeams(ctx, items, false, core.zc, t, dark);
  ocRings(ctx, false, core.zc, t, dark);
  ocCore(ctx, core, dark, t);
  ocRings(ctx, true, core.zc, t, dark);
  ocBeams(ctx, items, true, core.zc, t, dark);
  items.filter(P => P.b.zr >= 0).forEach(P => ocPillar(ctx, P, dark));
  ocLabels(ctx, items, dark);
  ocCoreLabel(ctx, core, dark);
}
function ocBackground(ctx, dark, t) {
  const w = G3.w, h = G3.h, g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.75);
  if (dark) { g.addColorStop(0, '#0B1E3A'); g.addColorStop(0.55, '#050B1A'); g.addColorStop(1, '#020617'); }
  else { g.addColorStop(0, '#FFFFFF'); g.addColorStop(1, '#E2E8F0'); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  if (!dark) return;
  const TAU = Math.PI * 2;
  G3.stars.forEach(s => {
    const x = (((s.a + G3.cam.theta * 0.15) % TAU) + TAU) % TAU / TAU * w, y = s.y * h * 0.7;
    ctx.fillStyle = `rgba(203,213,225,${REDUCED ? 0.55 : 0.3 + 0.35 * Math.sin(t * 1.3 + s.tw)})`;
    ctx.fillRect(x, y, s.r, s.r);
  });
}
function ocFloor(ctx, dark) {
  const R = G3.R, se = Math.max(0.06, G3.tr.se), o = ocProj(0, 0, 0), path = pts => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
  const disc = ocCircle3D(R + 1.8, 0, 0, 0, 120);
  path(disc); ctx.closePath();
  const fg = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, (R + 1.8) * o.s);
  fg.addColorStop(0, dark ? 'rgba(14,30,56,.9)' : 'rgba(226,232,240,.95)'); fg.addColorStop(1, dark ? 'rgba(6,12,26,.5)' : 'rgba(203,213,225,.55)');
  ctx.fillStyle = fg; ctx.fill();
  ctx.lineWidth = 1;
  [0.35, 0.6, 0.85, 1, 1.15].forEach(f => {
    ctx.setLineDash(f === 1 ? [] : [2, 5]);
    ctx.strokeStyle = dark ? `rgba(56,189,248,${f === 1 ? 0.35 : 0.14})` : `rgba(71,85,105,${f === 1 ? 0.35 : 0.18})`;
    path(ocCircle3D(R * f, 0, 0, 0, 96)); ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.strokeStyle = dark ? 'rgba(56,189,248,.10)' : 'rgba(71,85,105,.12)';
  G3.items.forEach(it => { const p = ocProj(it.x, 0, it.z); ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  ctx.save(); ctx.translate(o.x, o.y); ctx.scale(1, se);
  const pr = G3.coreR * o.s * 2.4, pg = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
  pg.addColorStop(0, ocA(G3.coreCol, dark ? 0.35 : 0.2)); pg.addColorStop(1, ocA(G3.coreCol, 0));
  ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function ocShadow(ctx, P, dark) {
  const it = P.it, sp = ocProj(it.x + it.h * 0.22, 0, it.z + it.h * 0.14), r = PILLAR_R * sp.s * (2 + it.h * 0.22);
  ctx.save(); ctx.translate(sp.x, sp.y); ctx.scale(1, Math.max(0.06, G3.tr.se));
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, dark ? 'rgba(0,0,0,.45)' : 'rgba(15,23,42,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function ocPillar(ctx, P, dark) {
  const it = P.it, b = P.b, top = P.top, se = G3.tr.se, hov = G3.hover === it.i, col = it.col;
  const rb = PILLAR_R * b.s, rt = PILLAR_R * top.s, eb = Math.max(1, rb * se), et = Math.max(1, rt * se);
  ctx.save(); ctx.globalAlpha = ocFade(b.d);
  ctx.fillStyle = dark ? '#1E293B' : '#CBD5E1';
  ctx.beginPath(); ctx.ellipse(b.x, b.y, rb * 1.9, eb * 1.9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = dark ? 'rgba(148,163,184,.25)' : 'rgba(71,85,105,.25)'; ctx.lineWidth = 1; ctx.stroke();
  let tp = null;
  if (it.ht != null) {
    tp = ocProj(it.x, it.ht, it.z);
    ctx.strokeStyle = ocA(OC.good, 0.4); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(tp.x, tp.y, PILLAR_R * tp.s * 1.45, Math.max(1, PILLAR_R * tp.s * 1.45 * se), 0, Math.PI, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(top.x - rt, top.y); ctx.lineTo(b.x - rb, b.y);
  ctx.ellipse(b.x, b.y, rb, eb, 0, Math.PI, 0, true);
  ctx.lineTo(top.x + rt, top.y); ctx.closePath();
  const lg = ctx.createLinearGradient(b.x - rb, 0, b.x + rb, 0);
  lg.addColorStop(0, ocShade(col, -0.55)); lg.addColorStop(0.3, ocShade(col, 0.3)); lg.addColorStop(0.55, col); lg.addColorStop(1, ocShade(col, -0.62));
  if (dark && it.glow > 0.05) { ctx.shadowColor = col; ctx.shadowBlur = 6 + 18 * it.glow; }
  ctx.fillStyle = lg; ctx.fill(); ctx.shadowBlur = 0;
  if (hov) { ctx.strokeStyle = dark ? '#F8FAFC' : '#0F172A'; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.beginPath(); ctx.ellipse(top.x, top.y, rt, et, 0, 0, Math.PI * 2);
  ctx.fillStyle = ocShade(col, 0.35); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.stroke();
  const gt = ocProj(it.x, it.hb, it.z), rg = PILLAR_R * gt.s * 1.32, rgb = rb * 1.32;
  ctx.setLineDash([3, 3]); ctx.strokeStyle = dark ? 'rgba(148,163,184,.45)' : 'rgba(71,85,105,.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(b.x - rgb, b.y); ctx.lineTo(gt.x - rg, gt.y); ctx.moveTo(b.x + rgb, b.y); ctx.lineTo(gt.x + rg, gt.y); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(gt.x, gt.y, rg, Math.max(1, rg * se), 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  if (tp) {
    ctx.strokeStyle = ocA(OC.good, 0.95); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.ellipse(tp.x, tp.y, PILLAR_R * tp.s * 1.45, Math.max(1, PILLAR_R * tp.s * 1.45 * se), 0, 0, Math.PI); ctx.stroke();
  }
  ctx.fillStyle = it.flat ? OC.dim : it.beam;
  ctx.beginPath(); ctx.arc(top.x, top.y - et - 3, Math.max(2, rt * 0.3), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  G3.hits.push({ type: 'pillar', i: it.i, d: b.d, x0: Math.min(b.x - rb, top.x - rt) - 4, x1: Math.max(b.x + rb, top.x + rt) + 4, y0: Math.min(top.y - et, gt.y) - 8, y1: b.y + eb + 4 });
}
function ocBeams(ctx, items, front, zRef, t, dark) {
  const cR = G3.coreR;
  items.forEach(P => {
    const it = P.it, sx = it.x, sy = it.h + 0.3, sz = it.z;
    const dx = sx, dy = sy - CORE_Y, dz = sz, len = Math.hypot(dx, dy, dz) || 1;
    const ex = dx / len * cR, ey = CORE_Y + dy / len * cR, ez = dz / len * cR, e = ocProj(ex, ey, ez);
    if ((e.zc >= zRef) !== front) return;
    const a = ocProj(sx, sy, sz), m = ocProj((sx + ex) / 2, (sy + ey) / 2 + 1.1, (sz + ez) / 2);
    const qx = 2 * m.x - (a.x + e.x) / 2, qy = 2 * m.y - (a.y + e.y) / 2;
    const alpha = (it.flat ? 0.06 : 0.12 + 0.7 * it.inf) * ocFade(P.b.d);
    const lg = ctx.createLinearGradient(a.x, a.y, e.x, e.y);
    lg.addColorStop(0, ocA(it.beam, alpha * 0.35)); lg.addColorStop(1, ocA(it.beam, alpha));
    ctx.strokeStyle = lg; ctx.lineWidth = 0.8 + 2.2 * it.inf;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(qx, qy, e.x, e.y); ctx.stroke();
    if (!it.flow || REDUCED) return;
    ctx.save(); if (dark) ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      let f = (k / 6 + t * 0.22 * it.flow) % 1; if (it.dir < 0) f = 1 - f;
      const u = 1 - f, px = u * u * a.x + 2 * u * f * qx + f * f * e.x, py = u * u * a.y + 2 * u * f * qy + f * f * e.y;
      const fade = Math.sin(f * Math.PI), r = 1.4 + 2.2 * it.inf;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 3);
      g.addColorStop(0, ocA(it.beam, 0.9 * fade)); g.addColorStop(1, ocA(it.beam, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  });
}
function ocRings(ctx, front, zRef, t, dark) {
  const def = DEF.sentiment, cr = G3.coreR, sp = REDUCED ? 0 : t, target = ocCircle3D(rOf(def.target), CORE_Y, 0, 0, 120);
  ctx.save();
  ctx.setLineDash([6, 5]); ctx.lineWidth = front ? 1.8 : 1.2; ctx.strokeStyle = ocA(OC.good, front ? 0.95 : 0.35);
  ocStrokeRuns(ctx, target, front, zRef); ctx.setLineDash([]);
  [{ r: cr * 1.75 + 0.4, tilt: 1.15, spin: sp * 0.35, a: 0.55, sat: 0.18 }, { r: cr * 2.25 + 0.6, tilt: -0.7, spin: 1.4 - sp * 0.22, a: 0.35, sat: -0.12 }].forEach(o => {
    const pts = ocCircle3D(o.r, CORE_Y, o.tilt, o.spin, 96);
    ctx.lineWidth = 1; ctx.strokeStyle = ocA(OC.cyan, front ? o.a : o.a * 0.35);
    ocStrokeRuns(ctx, pts, front, zRef);
    const s = pts[Math.floor(((((sp * o.sat) % 1) + 1) % 1) * 96)];
    if ((s.zc >= zRef) === front) {
      if (dark) ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 8);
      g.addColorStop(0, ocA(OC.cyan, 0.9)); g.addColorStop(1, ocA(OC.cyan, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#E0FFFC'; ctx.beginPath(); ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  });
  if (front) {
    const p = target.reduce((a, q) => (q.x > a.x ? q : a));
    ctx.font = '600 10px ui-monospace,Menlo,Consolas,monospace'; ctx.fillStyle = OC.good; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('🎯 ' + fmtV(def, def.target), p.x + 6, p.y);
  }
  ctx.restore();
}
function ocCore(ctx, p, dark, t) {
  const col = G3.coreCol, pulse = REDUCED ? 1 : 1 + 0.025 * Math.sin(t * 2.2), R = G3.coreR * p.s * pulse, se = G3.tr.se;
  ctx.save();
  if (dark) ctx.globalCompositeOperation = 'lighter';
  const hg = ctx.createRadialGradient(p.x, p.y, R * 0.6, p.x, p.y, R * 3.2);
  hg.addColorStop(0, ocA(col, dark ? 0.4 : 0.22)); hg.addColorStop(1, ocA(col, 0));
  ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(p.x, p.y, R * 3.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const lx = p.x - R * 0.38, ly = p.y - R * 0.42, g = ctx.createRadialGradient(lx, ly, R * 0.05, p.x, p.y, R * 1.02);
  g.addColorStop(0, '#FFFFFF'); g.addColorStop(0.18, ocShade(col, 0.45)); g.addColorStop(0.62, col); g.addColorStop(1, ocShade(col, -0.65));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, R, Math.max(1, R * se), 0, 0, Math.PI); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(p.x, p.y, R - 1, Math.PI * 0.1, Math.PI * 0.6); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(lx, ly, R * 0.16, R * 0.1, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.setLineDash([4, 4]); ctx.strokeStyle = dark ? 'rgba(148,163,184,.45)' : 'rgba(71,85,105,.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(p.x, p.y, G3.ghostR * p.s, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  G3.hits.push({ type: 'core', i: -1, d: p.d, x: p.x, y: p.y, r: R });
}
function ocLabels(ctx, items, dark) {
  const W = G3.w, placed = [], out = [], MONO = 'ui-monospace,Menlo,Consolas,monospace', SANS = 'system-ui,-apple-system,Segoe UI,sans-serif';
  items.slice().sort((a, b) => a.b.d - b.b.d).forEach(P => {
    const it = P.it, L = it.L, hov = G3.hover === it.i, capY = P.top.y - PILLAR_R * P.top.s * G3.tr.se - 8;
    const title = trunc(L.def.label, 20), val = fmtV(L.def, L.cur), con = Math.abs(L.contrib) > 5e-5 ? fmtPP(L.contrib) : '';
    ctx.font = `600 10.5px ${SANS}`; const tw = ctx.measureText(title).width;
    ctx.font = `700 11px ${MONO}`; const vw = ctx.measureText(val + (con ? '  ' + con : '')).width, v0 = ctx.measureText(val).width;
    const w = Math.max(tw, vw) + 16, h = 32;
    const x = clamp(P.top.x - w / 2, 4, W - w - 4); let y = capY - 8 - h, tries = 0;
    const hit = (X, Y) => placed.some(r => X < r.x + r.w && X + w > r.x && Y < r.y + r.h && Y + h > r.y);
    while (!hov && tries < 3 && hit(x, y)) { y -= h + 3; tries++; }
    const compact = !hov && hit(x, y);
    const rect = compact ? { x: clamp(P.top.x - v0 / 2 - 6, 4, W - v0 - 16), y: capY - 22, w: v0 + 12, h: 16 } : { x, y, w, h };
    if (!compact) placed.push(rect);
    out.push({ P, it, rect, compact, title, val, con, capY, hov });
  });
  out.reverse().sort((a, b) => a.hov - b.hov).forEach(o => {
    const { P, it, rect, compact } = o, acc = it.flat ? OC.slate : it.beam;
    ctx.save(); ctx.globalAlpha = o.hov ? 1 : ocFade(P.b.d);
    if (!compact && rect.y + rect.h < o.capY - 10) {
      ctx.strokeStyle = ocA(acc, 0.5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(P.top.x, o.capY); ctx.lineTo(rect.x + rect.w / 2, rect.y + rect.h); ctx.stroke();
    }
    ocRR(ctx, rect.x, rect.y, rect.w, rect.h, compact ? 7 : 9);
    ctx.fillStyle = dark ? 'rgba(6,12,24,.86)' : 'rgba(255,255,255,.94)'; ctx.fill();
    ctx.strokeStyle = acc; ctx.lineWidth = o.hov ? 2 : 1.2; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx = rect.x + rect.w / 2;
    if (compact) { ctx.font = '700 10.5px ui-monospace,Menlo,Consolas,monospace'; ctx.fillStyle = acc; ctx.fillText(o.val, cx, rect.y + 8.5); }
    else {
      ctx.font = '600 10.5px system-ui,-apple-system,Segoe UI,sans-serif'; ctx.fillStyle = dark ? '#E2E8F0' : '#0F172A'; ctx.fillText(o.title, cx, rect.y + 10);
      ctx.font = '700 11px ui-monospace,Menlo,Consolas,monospace';
      const txt = o.val + (o.con ? '  ' + o.con : ''), full = ctx.measureText(txt).width, vw = ctx.measureText(o.val + (o.con ? '  ' : '')).width;
      ctx.textAlign = 'left'; ctx.fillStyle = dark ? '#F8FAFC' : '#0F172A'; ctx.fillText(o.val, cx - full / 2, rect.y + 23);
      if (o.con) { ctx.fillStyle = it.L.contrib >= 0 ? OC.good : OC.bad; ctx.fillText(o.con, cx - full / 2 + vw, rect.y + 23); }
    }
    ctx.restore();
  });
}
function ocCoreLabel(ctx, p, dark) {
  const def = DEF.sentiment, pred = S.sim.pred, base = S.sim.baseSent, R = G3.coreR * p.s;
  const v = fmtV(def, pred), dl = isNum(pred) && isNum(base) ? fmtPP(pred - base) : '';
  ctx.save();
  ctx.font = '700 15px ui-monospace,Menlo,Consolas,monospace';
  const vw = ctx.measureText(v).width, full = ctx.measureText(v + (dl ? '  ' + dl : '')).width;
  const w = Math.max(full, 132) + 22, h = 42, x = clamp(p.x - w / 2, 4, G3.w - w - 4), y = Math.max(6, p.y - R - 22 - h);
  ocRR(ctx, x, y, w, h, 11);
  ctx.fillStyle = dark ? 'rgba(6,12,24,.88)' : 'rgba(255,255,255,.95)'; ctx.fill();
  ctx.strokeStyle = G3.coreCol; ctx.lineWidth = 2; ctx.stroke();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.font = '700 9.5px system-ui,-apple-system,Segoe UI,sans-serif'; ctx.fillStyle = dark ? '#94A3B8' : '#475569';
  ctx.fillText('🌙 PREDICTED SENTIMENT', x + w / 2, y + 12);
  ctx.font = '700 15px ui-monospace,Menlo,Consolas,monospace'; ctx.textAlign = 'left';
  const sx = x + w / 2 - full / 2;
  ctx.fillStyle = G3.coreCol; ctx.fillText(v, sx, y + 29);
  if (dl) { ctx.font = '600 12px ui-monospace,Menlo,Consolas,monospace'; ctx.fillStyle = pred - base >= 0 ? OC.good : OC.bad; ctx.fillText('  ' + dl, sx + vw, y + 29); }
  ctx.restore();
}

/* ── Interaction ── */
function g3PickAt(e) {
  const r = G3.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null;
  G3.hits.forEach(h => {
    const hit = h.type === 'core' ? Math.hypot(x - h.x, y - h.y) <= h.r : x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1;
    if (hit && (!best || h.d < best.d)) best = h;
  });
  return best ? best.i : -2;
}
function g3Hover(e) {
  if (!G3.built) return;
  const i = g3PickAt(e); G3.hover = i;
  G3.canvas.style.cursor = i === -2 ? 'grab' : 'pointer';
  if (i === -2) { tip.hide(); return; }
  const def = DEF.sentiment;
  if (i === -1) { tip.show(`<div class="h">🌙 Predicted Sentiment %</div><div><b class="vc-mono">${fmtV(def, S.sim.pred)}</b>${S.sim.band ? ` <span class="s">(80% band ${fmtV(def, S.sim.band[0])} – ${fmtV(def, S.sim.band[1])})</span>` : ''}</div><div class="s">Now ${fmtV(def, S.sim.baseSent)} · 🎯 ${fmtV(def, def.target)}</div>`, e); return; }
  const L = S.sim.levers[i]; if (!L) return;
  tip.show(`<div class="h">${esc(L.def.label)} ${L.def.hib ? '↑' : '↓'}</div><div>Scenario <b class="vc-mono">${fmtV(L.def, L.cur)}</b> · Base <span class="vc-mono">${fmtV(L.def, L.base)}</span></div>` +
    (L.q ? `<div class="s">Peers P25–P75 ${fmtV(L.def, L.q.p25)} – ${fmtV(L.def, L.q.p75)} · health ${(health(L, L.cur) * 100).toFixed(0)}%</div>` : '') +
    `<div>Contribution <b class="vc-mono ${L.contrib >= 0 ? 'vc-good' : 'vc-bad'}">${fmtPP(L.contrib)}</b></div>` +
    `<div class="s">${Math.abs(L.b) < 1e-12 ? 'No reliable effect in this model' : `+1σ (${fmtD(L.def, L.sd)}) in the good direction ≈ ${fmtPP(Math.abs(L.b) * L.sd * (L.b * (L.def.hib ? 1 : -1) > 0 ? 1 : -1))}`}</div><div class="s">Click to edit</div>`, e);
}
function g3Click(e) {
  const i = g3PickAt(e); if (i < 0) return;
  const row = $('vc-sim-row-' + i); if (!row) return;
  row.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' });
  row.classList.add('vc-flash'); setTimeout(() => row.classList.remove('vc-flash'), 1200);
  const inp = $('vc-sim-in-' + i); if (inp) inp.focus({ preventScroll: true });
}


/* ═══ 15. CASE LEVEL DATA (server-paginated, filter-aware) ═══ */
const CASE_MODES = {
  scored: { label: 'Scored', source: 'sentiment', params: { scored_only: 'true' } },
  detractors: { label: 'Detractors', source: 'sentiment', params: { detractors_only: 'true' } },
  sentiment: { label: 'All sentiment rows', source: 'sentiment', params: {} },
  irt: { label: 'IRT', source: 'irt', params: {} },
  irt_miss: { label: 'IRT misses', source: 'irt', params: { irt_missed: 'true' } },
  esc: { label: 'Escalations', source: 'esc', params: {} }
};
const CASE_LONG = new Set(['explanation', 'summary']);
function casesReady() {
  const tab = $('tab-cases'), body = $('cld-body'); if (!tab || !body) return false;
  const tbl = body.closest('table'); if (tbl) tbl.classList.add('vc-table');
  if (!S.cases.bound) {
    S.cases.bound = true;
    tab.addEventListener('click', e => {
      const t = e.target; if (!(t instanceof Element)) return;
      const md = t.closest('[data-vc-case-mode]'); if (md) { S.cases.mode = md.dataset.vcCaseMode; S.cases.page = 1; loadCases(); return; }
      const so = t.closest('[data-vc-sort]');
      if (so) { const k = so.dataset.vcSort; if (S.cases.sort === k) S.cases.dir = S.cases.dir === 'asc' ? 'desc' : 'asc'; else { S.cases.sort = k; S.cases.dir = 'desc'; } S.cases.page = 1; loadCases(); return; }
      const pg = t.closest('[data-vc-page]');
      if (pg && !pg.disabled) { const v = pg.dataset.vcPage, tp = Math.max(1, Math.ceil(S.cases.total / S.cases.size)); S.cases.page = v === 'first' ? 1 : v === 'last' ? tp : clamp(S.cases.page + (+v), 1, tp); loadCases(); return; }
      if (t.closest('[data-vc-case-retry]')) { loadCases(); return; }
      if (t.closest('[data-vc-case-export]')) { exportCasesScope(); return; }
      if (t.closest('[data-vc-case-page-csv]')) { exportCasePage(); return; }
      const row = t.closest('[data-vc-case-row]');
      if (row && !t.closest('a')) { const i = +row.dataset.vcCaseRow; S.cases.open = S.cases.open === i ? null : i; renderCaseBody(); }
    });
    tab.addEventListener('change', e => {
      const t = e.target;
      if (t && t.id === 'vc-case-jump') { const tp = Math.max(1, Math.ceil(S.cases.total / S.cases.size)); S.cases.page = clamp(parseInt(t.value, 10) || 1, 1, tp); loadCases(); }
      if (t && t.id === 'vc-case-size') { S.cases.size = +t.value; S.cases.page = 1; loadCases(); }
    });
  }
  return true;
}
function renderCasesToolbar() {
  if (!CASE_MODES[S.cases.mode]) S.cases.mode = 'scored';
  const sub = $('cld-subtabs');
  if (sub) { sub.classList.add('vc-case-tabs'); sub.innerHTML = Object.entries(CASE_MODES).map(([k, v]) => `<button type="button" class="vc-btn sm ${S.cases.mode === k ? 'is-on' : ''}" data-vc-case-mode="${k}">${v.label}</button>`).join(''); }
  const tb = $('cld-toolbar'); if (!tb) return;
  tb.classList.add('vc-case-bar');
  if (tb.dataset.vcv !== '5') {
    tb.dataset.vcv = '5';
    tb.innerHTML = `<input id="vc-case-q" class="vc-input" type="search" placeholder="Search case ID or agent…">` +
      `<label class="vc-ctl">Rows <select id="vc-case-size" class="vc-select">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>` +
      `<span id="vc-case-scope" class="vc-case-scope"></span><span id="vc-case-count" class="vc-mono vc-muted" style="font-size:11px"></span>` +
      `<button type="button" class="vc-btn sm" data-vc-case-page-csv>⬇ Page CSV</button><button type="button" class="vc-btn sm" data-vc-case-export>⬇ Scope CSV (≤10k)</button>`;
    $('vc-case-q').addEventListener('input', debounce(e => { S.cases.q = e.target.value.trim(); S.cases.page = 1; loadCases(); }, 300));
  }
  const q = $('vc-case-q'); if (q && document.activeElement !== q) q.value = S.cases.q || '';
  const sz = $('vc-case-size'); if (sz) sz.value = String(S.cases.size);
}
function caseScopeText() {
  const parts = DIMS.filter(d => S.filters[d].size).map(d => { const n = [...S.filters[d]].map(i => S.C.labels[d][i]); return `${DIM_LABEL[d]}: ${n.length > 2 ? n.length + ' selected' : n.join(', ')}`; });
  return parts.length ? parts.join(' · ') : 'All data';
}
function caseQuery(page, size) {
  const st = S.cases, mode = CASE_MODES[st.mode], flt = {};
  DIMS.forEach(d => { if (S.filters[d].size) flt[d] = [...S.filters[d]].flatMap(i => S.C.raw[d][i] || [S.C.labels[d][i]]); });
  const qs = new URLSearchParams({ source: mode.source, page, page_size: size, filters: JSON.stringify(flt), q: st.q || '' });
  Object.entries(mode.params).forEach(([k, v]) => qs.set(k, v));
  if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir || 'desc'); }
  return qs;
}
function fetchCases(qs, signal) {
  return fetch(API_CASES + '?' + qs.toString(), { signal })
    .then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(j => { throw new Error(j.detail || ('HTTP ' + r.status)); }));
}
function cellText(k, v) { const d = cellDate(k, v); return d != null ? d : v; }
function caseCell(k, v) {
  if (v === null || v === undefined || v === '') return '<span class="vc-muted">—</span>';
  const dt = cellDate(k, v); if (dt != null) return `<span class="vc-mono">${esc(dt)}</span>`;
  switch (k) {
    case 'case_id': return `<a class="vc-link vc-mono" href="https://cases.connect.corp.google.com/#/case/${encodeURIComponent(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
    case 'positive': return +v >= 1 ? '<span class="vc-tag pos">Positive</span>' : '<span class="vc-tag neg">Detractor</span>';
    case 'scored': return +v >= 1 ? '<span class="vc-tag pos">Yes</span>' : '<span class="vc-tag na">No</span>';
    case 'irt_met': return +v >= 1 ? '<span class="vc-tag pos">Met</span>' : '<span class="vc-tag neg">Missed</span>';
    case 'reopened': return +v >= 1 ? '<span class="vc-tag neg">Reopened</span>' : '<span class="vc-tag na">No</span>';
    case 'irt_hours': return isNum(+v) ? `<span class="vc-mono">${(+v).toFixed(1)} h</span>` : esc(v);
    case 'explanation': case 'summary': return `<span class="vc-case-snip">${esc(trunc(v, 89))}</span>`;
  }
  if (typeof v === 'number') return `<span class="vc-mono">${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)}</span>`;
  return `<span title="${esc(v)}">${esc(v)}</span>`;
}
function renderCaseHead() {
  const st = S.cases, head = $('cld-head') || $('cld-head-row'); if (!head) return;
  head.innerHTML = st.keys.map((k, i) => {
    if (CASE_LONG.has(k)) return `<th>${esc(st.labels[i])}</th>`;
    const on = st.sort === k;
    return `<th data-vc-sort="${esc(k)}" class="vc-sortable${on ? ' is-on' : ''}" title="Sort by ${esc(st.labels[i])}">${esc(st.labels[i])} <span class="vc-arrow">${on ? (st.dir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  }).join('');
}
function renderCaseBody() {
  const st = S.cases, body = $('cld-body'); if (!body) return;
  const keys = st.keys, iScored = keys.indexOf('scored'), longIdx = keys.map((k, i) => (CASE_LONG.has(k) ? i : -1)).filter(i => i >= 0);
  if (!st.raw.length) { body.innerHTML = `<tr><td colspan="${Math.max(1, keys.length)}" class="vc-empty">No rows match this scope${st.q ? ' and search' : ''}.</td></tr>`; return; }
  body.innerHTML = st.raw.map((r, ri) => {
    const hasText = longIdx.some(i => r[i]), open = st.open === ri;
    const cells = keys.map((k, i) => (k === 'positive' && iScored >= 0 && +r[iScored] !== 1) ? '<td><span class="vc-tag na">Not scored</span></td>' : `<td>${caseCell(k, r[i])}</td>`).join('');
    let html = hasText ? `<tr data-vc-case-row="${ri}" class="vc-case-row${open ? ' is-open' : ''}" title="Click to ${open ? 'collapse' : 'read'} the narrative">${cells}</tr>` : `<tr>${cells}</tr>`;
    if (hasText && open) html += `<tr class="vc-case-detail"><td colspan="${keys.length}">` + longIdx.filter(i => r[i]).map(i => `<div class="vc-ins-t">${esc(st.labels[i])}</div><div class="vc-case-text">${esc(r[i])}</div>`).join('') + '</td></tr>';
    return html;
  }).join('');
}
function renderPager() {
  const host = $('cld-pager'); if (!host) return;
  const st = S.cases, tp = Math.max(1, Math.ceil(st.total / st.size));
  const from = st.total ? (st.page - 1) * st.size + 1 : 0, to = Math.min(st.page * st.size, st.total);
  host.className = 'vc-pager';
  host.innerHTML = `<span>Showing <b class="vc-mono">${from.toLocaleString()}–${to.toLocaleString()}</b> of <b class="vc-mono">${st.total.toLocaleString()}</b></span>` +
    `<div style="display:flex;gap:8px;align-items:center"><button type="button" class="vc-btn sm" data-vc-page="first" ${st.page <= 1 ? 'disabled' : ''}>«</button><button type="button" class="vc-btn sm" data-vc-page="-1" ${st.page <= 1 ? 'disabled' : ''}>‹ Prev</button>` +
    `<span class="vc-ctl">Page <input id="vc-case-jump" class="vc-input vc-mono" type="number" min="1" max="${tp}" value="${st.page}" style="width:68px"> of ${tp.toLocaleString()}</span>` +
    `<button type="button" class="vc-btn sm" data-vc-page="1" ${st.page >= tp ? 'disabled' : ''}>Next ›</button><button type="button" class="vc-btn sm" data-vc-page="last" ${st.page >= tp ? 'disabled' : ''}>»</button></div>`;
}
function loadCases() {
  if (!casesReady()) return;
  renderCasesToolbar();
  const st = S.cases, mode = CASE_MODES[st.mode];
  if (st.lastSource !== mode.source) { st.sort = ''; st.dir = 'desc'; st.lastSource = mode.source; }
  st.open = null;
  const body = $('cld-body'), cols = Math.max(1, st.keys.length);
  body.innerHTML = `<tr><td colspan="${cols}" class="vc-empty">Loading…</td></tr>`;
  const sc = $('vc-case-scope'); if (sc) { sc.textContent = caseScopeText(); sc.title = sc.textContent; }
  if (st.ctl) st.ctl.abort();
  const ctl = new AbortController(); st.ctl = ctl;
  const t0 = performance.now();
  fetchCases(caseQuery(st.page, st.size), ctl.signal).then(data => {
    st.keys = data.keys || []; st.labels = data.labels || st.keys; st.raw = data.rows || []; st.total = +data.total || 0;
    const tp = Math.max(1, Math.ceil(st.total / st.size));
    if (st.total && st.page > tp) { st.page = tp; loadCases(); return; }
    renderCaseHead(); renderCaseBody(); renderPager();
    const cnt = $('vc-case-count'); if (cnt) cnt.textContent = `${st.total.toLocaleString()} rows · ${Math.round(performance.now() - t0)} ms`;
  }).catch(err => {
    if (err.name === 'AbortError') return;
    body.innerHTML = `<tr><td colspan="${cols}" class="vc-empty vc-bad">Failed to load: ${esc(err.message)} <button type="button" class="vc-btn sm" data-vc-case-retry style="margin-left:8px">Retry</button></td></tr>`;
  });
}
function exportCasePage() {
  const st = S.cases;
  if (!st.raw.length) { toast('No rows on this page'); return; }
  downloadCsv('VectorCore_cases_' + st.mode + '_page' + st.page, st.labels, st.raw.map(r => st.keys.map((k, i) => cellText(k, r[i]))));
}
async function exportCasesScope() {
  const st = S.cases, MAXR = 10000, size = 200;
  if (!st.total) { toast('Nothing to export'); return; }
  const pages = Math.min(Math.ceil(st.total / size), MAXR / size), rows = [];
  let labels = st.labels, keys = st.keys;
  try {
    for (let p = 1; p <= pages; p++) {
      toast(`Exporting… ${Math.min(p * size, st.total, MAXR).toLocaleString()} / ${Math.min(st.total, MAXR).toLocaleString()} rows`, 60000);
      const d = await fetchCases(caseQuery(p, size));
      keys = d.keys || keys; labels = d.labels || keys;
      (d.rows || []).forEach(r => rows.push(keys.map((k, i) => cellText(k, r[i]))));
    }
    downloadCsv('VectorCore_cases_' + st.mode, labels, rows);
    if (st.total > MAXR) toast(`Exported the first ${MAXR.toLocaleString()} of ${st.total.toLocaleString()} rows. Narrow the filters for the rest.`, 8000);
  } catch (e) { toast('Export failed: ' + e.message, 8000); }
}

/* ═══ 16. EXPORTS ═══ */
function downloadCsv(name, headers, rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [headers, ...rows].map(r => r.map(q).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name.replace(/[^\w.-]+/g, '_') + '_' + todayStr() + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('Downloaded ' + a.download);
}
function exportKpiMatrix() {
  const v = S.view; if (!v) return;
  downloadCsv('VectorCore_KPI_Matrix', ['Metric', 'Role', 'Target', ...v.per.map(p => p.name), 'Overall'],
    KPIS.map(def => [def.label, def.role, def.target != null ? fmtV(def, def.target) : '', ...v.per.map(p => fmtV(def, def.f(p.s))), fmtV(def, def.f(v.tot))]));
}
function exportCategories() { downloadCsv('VectorCore_Detractor_Categories', ['Category', 'Detractors', 'Share of scored'], (S.payload.cat_tree || []).map(n => [n.name, n.total, isNum(n.share) ? (n.share * 100).toFixed(2) + '%' : ''])); }
function exportCorrelation() {
  const r = getCorr();
  const rows = r.hk.map((a, i) => [DEF[a].label, ...r.hk.map((b, j) => (isNum(r.matrix[i][j].r) ? r.matrix[i][j].r.toFixed(4) : ''))]);
  rows.push([]); rows.push(['Metric', 'Pearson r', 'p-value', 'Spearman rho', 'n', 'Aligned']);
  r.strip.forEach(s => rows.push([s.def.label, isNum(s.r) ? s.r.toFixed(4) : '', isNum(s.p) ? s.p.toFixed(5) : '', isNum(s.rho) ? s.rho.toFixed(4) : '', s.n, s.aligned == null ? '' : s.aligned ? 'Yes' : 'No']));
  downloadCsv('VectorCore_Correlation_' + DIM_LABEL[r.unit], ['', ...r.hk.map(k => DEF[k].label)], rows);
}
function exportScenario() {
  if (!S.sim.levers.length) return;
  const rows = S.sim.levers.map(L => [L.def.label, fmtV(L.def, L.base), fmtV(L.def, L.cur), fmtPP(L.contrib), L.b.toPrecision(4), L.q ? fmtV(L.def, L.q.p50) : '']);
  rows.push(['Predicted Sentiment %', fmtV(DEF.sentiment, S.sim.baseSent), fmtV(DEF.sentiment, S.sim.pred), S.sim.band ? `80% band ${fmtV(DEF.sentiment, S.sim.band[0])}–${fmtV(DEF.sentiment, S.sim.band[1])}` : '', '', '']);
  downloadCsv('VectorCore_WhatIf_Scenario', ['Lever', 'Baseline', 'Scenario', 'Contribution', 'Beta per unit', 'Peer median'], rows);
}
window.exportKpiMatrixToSheets = exportKpiMatrix;
window.exportMatrixToSheets = exportCategories;
window.exportCorrelationToSheets = exportCorrelation;
window.exportScenarioToSheets = exportScenario;
window.exportCaseLevelToSheets = exportCasePage;
window.exportModalCasesToSheets = exportCasePage;
window.closeCaseModal = function () { const m = $('caseModal'); if (m) m.classList.add('hidden'); };

/* ═══ 17. THEME · GRANULARITY · TABS ═══ */
const resolveTheme = mode => (mode !== 'auto' ? mode : (h => (h >= LIGHT_FROM && h < DARK_FROM ? 'light' : 'dark'))(new Date().getHours()));
function applyTheme(mode) {
  if (!['auto', 'light', 'dark'].includes(mode)) mode = 'auto';
  S.theme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  document.documentElement.setAttribute('data-theme-mode', mode);
  const seg = $('segToggleTheme');
  if (seg) { seg.setAttribute('data-val', mode); seg.querySelectorAll('.seg-opt').forEach(b => b.classList.toggle('active', b.dataset.val === mode)); }
  const hint = $('themeAutoHint'); if (hint) hint.textContent = mode === 'auto' ? 'Auto · ' + resolveTheme(mode) : 'Pinned · ' + mode;
}
function initTheme() {
  let m = 'auto';
  try { m = localStorage.getItem(THEME_KEY) || localStorage.getItem('vectorcore.themeMode') || 'auto'; } catch (e) { /* ignore */ }
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
  S.dirty.overview = true; renderVisible();
}
function switchTab(t) {
  if (!TABS.includes(t)) return;
  S.tab = t;
  TABS.forEach(k => { const p = $('tab-' + k); if (p) p.classList.toggle('hidden', k !== t); });
  document.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  tip.hide();
  renderVisible();
}
window.switchTab = switchTab;
function markDirty() { Object.keys(S.dirty).forEach(k => { S.dirty[k] = true; }); S.corrCache = null; }
function renderVisible() {
  if (!S.C) return;
  const t = S.tab;
  if (S.dirty[t]) {
    S.dirty[t] = false;
    try {
      if (t === 'overview') renderOverview();
      else if (t === 'correlation') renderCorrelation();
      else if (t === 'simulator') renderSimulator();
      else if (t === 'cases') loadCases();
    } catch (e) { console.error('[VectorCore] render error in ' + t, e); toast('Render error in ' + t + ': ' + e.message, 6000); }
  }
  if (t === 'simulator') { g3Resize(); g3Start(); } else g3Stop();
}

/* ═══ 18. EVENTS ═══ */
function bindEvents() {
  document.addEventListener('click', e => {
    const t = e.target; if (!(t instanceof Element)) return;
    const msT = t.closest('[data-vc-ms-toggle]'); if (msT) { e.preventDefault(); openMenu(msT); return; }
    const msC = t.closest('[data-vc-ms-clear]'); if (msC) { const d = msC.dataset.vcMsClear; clearDim(d); const menu = msC.closest('.vc-ms-menu'); if (menu) renderMsList(menu, d); return; }
    if (!t.closest('.vc-ms')) closeMenus();
    const chipX = t.closest('[data-vc-clear-dim]'); if (chipX) { clearDim(chipX.dataset.vcClearDim); return; }
    if (t.closest('[data-reset-all]')) { resetAllFilters(); return; }
    if (t.closest('[data-modal-close]')) { window.closeCaseModal(); return; }
    const corrChip = t.closest('[data-vc-corr]');
    if (corrChip) { e.stopPropagation(); S.corr.pair = [corrChip.dataset.vcCorr, 'sentiment']; S.dirty.correlation = true; switchTab('correlation'); return; }
    const veh = t.closest('[data-vc-veh]');
    if (veh) {
      if (DEF[veh.dataset.vcVeh].missing) { toast(`${DEF[veh.dataset.vcVeh].label} has no data yet`); return; }
      S.xKpi = veh.dataset.vcVeh; renderExplorer();
      document.querySelectorAll('[data-vc-veh]').forEach(c => c.classList.toggle('is-sel', c.dataset.vcVeh === S.xKpi));
      const xt = $('x-trend'); if (xt) xt.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' });
      return;
    }
    const tab = t.closest('[data-tab]'); if (tab) { switchTab(tab.dataset.tab); return; }
    const th = t.closest('#segToggleTheme .seg-opt'); if (th) { applyTheme(th.dataset.val); markDirty(); renderVisible(); return; }
    const tm = t.closest('#segToggleTime .seg-opt'); if (tm) { setUnit(tm.dataset.val); return; }
    const lv = t.closest('.lvl-btn[data-depth]'); if (lv && !lv.disabled) { S.catDepth = +lv.dataset.depth; renderCategories(); return; }
    const sp = t.closest('[data-vc-sim-preset]'); if (sp) { applySimPreset(sp.dataset.vcSimPreset); return; }
    const sc = t.closest('[data-vc-sim-scope]'); if (sc) { S.sim.scope = sc.dataset.vcSimScope; S.dirty.simulator = true; renderVisible(); return; }
    const rs = t.closest('[data-vc-sim-reset]'); if (rs) { const i = +rs.dataset.vcSimReset; const L = S.sim.levers[i]; if (L) { setLever(i, L.base); updateSim(); } return; }
    if (t.closest('[data-vc-sim-apply-plan]')) { (S.sim.plan && S.sim.plan.steps || []).forEach(s => setLever(s.i, s.to)); updateSim(); return; }
    if (t.closest('[data-vc-sim-save]')) { saveScenario(); return; }
    if (t.closest('[data-vc-sim-clear]')) { S.sim.saved = []; renderSimCompare(); return; }
    const ld = t.closest('[data-vc-sim-load]'); if (ld) { loadScenario(+ld.dataset.vcSimLoad); return; }
    const dl = t.closest('[data-vc-sim-del]'); if (dl) { S.sim.saved.splice(+dl.dataset.vcSimDel, 1); renderSimCompare(); return; }
    const g3 = t.closest('[data-vc-g3]');
    if (g3) { if (g3.dataset.vcG3 === 'reset') g3ResetCam(); else { G3.spin = !G3.spin; g3.classList.toggle('is-on', G3.spin); } return; }
    const ex = t.closest('[data-vc-export]');
    if (ex) { ({ scenario: exportScenario, kpi: exportKpiMatrix, corr: exportCorrelation, cats: exportCategories })[ex.dataset.vcExport]?.(); }
  });
  document.addEventListener('change', e => {
    const t = e.target; if (!(t instanceof Element)) return;
    if (t.matches('[data-vc-ms-opt]')) { toggleFilter(t.dataset.vcMsOpt, +t.value); return; }
    if (t.id === 'x-kpi') { S.xKpi = t.value; renderExplorer(); document.querySelectorAll('[data-vc-veh]').forEach(c => c.classList.toggle('is-sel', c.dataset.vcVeh === S.xKpi)); return; }
    if (t.id === 'corr-unit') { S.corr.unit = t.value; S.corrCache = null; S.dirty.overview = true; renderCorrelation(); return; }
    if (t.id === 'corr-min') { S.corr.minVol = clamp(parseInt(t.value, 10) || 30, 1, 5000); S.corrCache = null; S.dirty.overview = true; renderCorrelation(); return; }
    if (t.id === 'vc-sim-enforce') { S.sim.enforce = t.checked; S.dirty.simulator = true; renderVisible(); }
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
    const i = ['1', '2', '3', '4'].indexOf(e.key); if (i >= 0) switchTab(TABS[i]);
  });
  window.addEventListener('resize', debounce(() => {
    if (!S.C) return;
    if (S.tab === 'simulator') { g3Resize(); return; }
    S.dirty[S.tab] = true; renderVisible();
  }, 250));
}

/* ═══ 19. BOOT ═══ */
function fetchSummary() { return fetch(API_SUMMARY).then(r => { if (!r.ok) throw new Error('API ' + API_SUMMARY + ' returned ' + r.status); return r.json(); }); }
window.boot = function boot() {
  if (S.booted) return;
  S.booted = true;
  injectStyles(); bindEvents(); initTheme();
  setLoader('Fetching the pre-aggregated cube…');
  const first = window.__dataPromise ? Promise.resolve(window.__dataPromise) : fetchSummary();
  first.catch(() => fetchSummary()).then(data => {
    S.payload = data;
    S.C = buildCube(data);
    applyAvailability();
    console.info(`[VectorCore] cube loaded: ${S.C.n.toLocaleString()} rows · ${DIMS.map(d => d + '=' + S.C.labels[d].length).join(', ')} · missing KPIs: ${KPIS.filter(k => k.missing).map(k => k.key).join(', ') || 'none'}`);
    mountFilters(); renderChips();
    const stamp = $('data-stamp'); if (stamp) stamp.textContent = 'Data ' + fmtStamp(data.metadata && data.metadata.generated_at);
    markDirty(); switchTab('overview');
    hideLoader(); window.__booted = true;
  }).catch(err => {
    console.error('[VectorCore] boot failed', err);
    setLoader('⚠ ' + err.message, true);
    toast('Failed to load: ' + err.message, 8000);
  });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.boot);
else window.boot();
