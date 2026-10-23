import pathlib, re, sys

# 1) Ingestion: add a 0/1 count column so Consult Avg Interactions stays exact under filters
p = pathlib.Path('app/processing/load_data.py'); s = p.read_text()
if 'Consult Average Interactions per Closed Case Dr' not in s:
    hook = '\n    return df\n\ndef run_ingestion'
    if hook not in s: sys.exit('✗ load_data.py: end of clean() not found')
    add = ('\n    cai = "Consult Average Interactions per Closed Case"\n'
           '    if table == "sentiment_raw" and cai in df.columns:\n'
           '        df[cai + " Dr"] = df[cai].notna().astype("int8")')
    s = s.replace(hook, add + hook, 1); p.write_text(s); print('✓ load_data.py')

# 2) Aggregator: add the new numerator/denominator pairs after tta_den
NEW = {
 "blk_num": "Average Time in Blocked By (hours)", "blk_den": "Average Time in Blocked By (hours) Dr",
 "nfo_num": "Average Time in Need Info (hours)", "nfo_den": "Average Time in Need Info (hours) Dr",
 "una_num": "Average Time in Unassigned (hours)", "una_den": "Average Time in Unassigned (hours) Dr",
 "tfs_num": "Average Time to First Solution Offered (TFS) (hours)", "tfs_den": "Average Time to First Solution Offered (TFS) (hours) Dr",
 "new_num": "Average Time in New (hours)", "new_den": "Average Time in New (hours) Dr",
 "agt_num": "Average Agent Time (hours)", "agt_den": "Average Agent Time (hours) Dr",
 "int_num": "Average Interactions per Closed Case", "int_den": "Average Interactions per Closed Case Dr",
 "cai_num": "Consult Average Interactions per Closed Case", "cai_den": "Consult Average Interactions per Closed Case Dr",
}
p = pathlib.Path('app/processing/aggregator.py'); s = p.read_text()
if '"blk_num"' not in s:
    m = re.search(r'^(\s*)"tta_den":\s*"[^"]+",\s*$', s, re.M)
    if not m: sys.exit('✗ aggregator.py: "tta_den" line not found — run: grep -n tta_den app/processing/aggregator.py')
    ind = m.group(1)
    block = ''.join(f'\n{ind}"{k}": "{v}",' for k, v in NEW.items())
    s = s[:m.end()] + block + s[m.end():]; p.write_text(s); print('✓ aggregator.py')

# 3) Dashboard: register measures and KPIs (shown in the KPI Matrix and Breakdown selector)
p = pathlib.Path('static/js/app.js'); s = p.read_text()
if "'blk_num'" not in s:
    s, n = re.subn(r"(const MEAS = \[[^\]]*?)\s*\];", lambda m: m.group(1) + ",\n  " + ", ".join(f"'{k}'" for k in NEW) + "];", s, 1)
    if not n: sys.exit('✗ app.js: MEAS list not found')
    kpis = """  { key: 'blocked',  label: 'Time in Blocked By',  role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.blk_num, s.blk_den), w: s => s.blk_den },
  { key: 'needInfo', label: 'Time in Need Info',   role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.nfo_num, s.nfo_den), w: s => s.nfo_den },
  { key: 'unassigned', label: 'Time in Unassigned', role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.una_num, s.una_den), w: s => s.una_den },
  { key: 'tfs',      label: 'TFS',                 role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.tfs_num, s.tfs_den), w: s => s.tfs_den },
  { key: 'timeNew',  label: 'Time in New',         role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.new_num, s.new_den), w: s => s.new_den },
  { key: 'agentTime', label: 'Agent Time',         role: 'context', fmt: 'num', hib: false, target: null, unit: 'h', f: s => ratio(s.agt_num, s.agt_den), w: s => s.agt_den },
  { key: 'interactions', label: 'Interactions / Case', role: 'context', fmt: 'num', hib: false, target: null, f: s => ratio(s.int_num, s.int_den), w: s => s.int_den },
  { key: 'consultInt', label: 'Consult Avg Interactions', role: 'context', fmt: 'num', hib: false, target: null, f: s => ratio(s.cai_num, s.cai_den), w: s => s.cai_den },
"""
    i = s.find("  { key: 'casesClosed'")
    if i < 0: sys.exit("✗ app.js: casesClosed KPI not found")
    s = s[:i] + kpis + s[i:]; p.write_text(s); print('✓ app.js')
