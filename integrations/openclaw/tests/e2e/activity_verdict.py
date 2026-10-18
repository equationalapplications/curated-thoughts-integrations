"""Verdict for run_activity.sh (OpenClaw autonomous-work e2e).

Reads <work>/wire.jsonl (request bodies only), <work>/ct-calls.jsonl (stub ct
argv), <work>/mcp/mcp-calls.jsonl and the verbose JSONL, prints one line per
check and exits 0 only when every check passes. Never prints environment
values; the key check reads ZAI_API_KEY and only reports found / not found.
"""
import json
import os
import re
import sys

WORK = sys.argv[1]
HEADING = '## Curated Thoughts — relevant to this step'
MARKER = re.compile(r'<!-- ct-fact:([A-Za-z0-9._:-]+) -->')
EXPECTED = {'TASK.md': 'w-task', 'git status': 'w-git', '.env.local': 'w-env'}
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")


def strip_cache(x):
    if isinstance(x, dict):
        return {k: strip_cache(v) for k, v in x.items() if k != 'cache_control'}
    if isinstance(x, list):
        return [strip_cache(v) for v in x]
    return x


def canon(x):
    return json.dumps(strip_cache(x), sort_keys=True, ensure_ascii=False)


def texts(content):
    if isinstance(content, str):
        return [content]
    out = []
    for p in content or []:
        if not isinstance(p, dict):
            continue
        if p.get('type') == 'text':
            out.append(p.get('text', ''))
        elif p.get('type') == 'tool_result':
            inner = p.get('content')
            out.extend(texts(inner if isinstance(inner, list) else [{'type': 'text', 'text': str(inner or '')}]))
    return out


def tool_results(req):
    out = {}
    for m in req['messages']:
        if isinstance(m.get('content'), list):
            for p in m['content']:
                if isinstance(p, dict) and p.get('type') == 'tool_result':
                    out[p.get('tool_use_id')] = p
    return out


def delivered_ids(text):
    # a user-turn correction names the ids it replaces with markers too
    return MARKER.findall(re.sub(r'\(supersedes [^)]*\)', '', text))


reqs = []
for line in open(os.path.join(WORK, 'wire.jsonl'), encoding='utf-8'):
    row = json.loads(line)
    if row.get('method') == 'POST' and row['path'].split('?')[0].endswith('/v1/messages'):
        reqs.append(json.loads(row['body']))
check('model requests captured', len(reqs) >= 4, f'{len(reqs)} requests')

# --- ct argv: activity queries -------------------------------------------
calls = [json.loads(l) for l in open(os.path.join(WORK, 'ct-calls.jsonl'), encoding='utf-8')]
matches = [c for c in calls if c[:2] == ['wisdom', 'match'] and '--help' not in c]
activity = [c for c in matches if c[c.index('--max') + 1] == '1']
queries = [c[c.index('--') + 1] for c in activity]
print('activity queries:', queries)
check('every activity query is the single argv element after --', all(c.index('--') == len(c) - 2 for c in activity))
check('one query per activity key, in order (git status and .env.local not re-queried)',
      queries == ['TASK.md', 'git status', '.env.local'], repr(queries))
check('no activity query from the CT recall tool', 'release' not in queries)
mcp_log = os.path.join(WORK, 'mcp', 'mcp-calls.jsonl')
mcp_calls = [json.loads(l) for l in open(mcp_log, encoding='utf-8')] if os.path.exists(mcp_log) else []
check('the agent called the CT recall tool', len(mcp_calls) >= 1, f'{len(mcp_calls)} call(s)')

# --- wire: delivery, marker-first, persistence, replay ----------------------
last = reqs[-1]
first_seen = {}
for i, r in enumerate(reqs):
    for tid, p in tool_results(r).items():
        first_seen.setdefault(tid, (i, canon(p)))
blocks = {}
for tid, (i, c) in first_seen.items():
    for t in texts([json.loads(c)]):
        if HEADING in t:
            block = t[t.index(HEADING):]
            ids = MARKER.findall(block)
            blocks[tid] = (i, block, ids[0] if ids else None)
got = sorted(b[2] for b in blocks.values())
check('one activity block per expected fact', got == sorted(EXPECTED.values()), repr(got))
for tid, (i, block, fid) in blocks.items():
    title = block.split('\n')[3] if len(block.split('\n')) > 3 else ''
    check(f'{fid}: marker first on the title line', title.startswith(f'<!-- ct-fact:{fid} --> **'))
    later = [r for r in reqs[i:] if tid in tool_results(r)]
    same = all(canon(tool_results(r)[tid]) == first_seen[tid][1] for r in later)
    check(f'{fid}: the tool result is byte-identical in every later request ({len(later)}), turn 2 included',
          same and tid in tool_results(last))

counts = {}
for m in last['messages']:
    for t in texts(m['content']):
        for fid in delivered_ids(t):
            counts[fid] = counts.get(fid, 0) + 1
dupes = {k: v for k, v in counts.items() if v > 1}
check('exactly once: no fact marker twice in the final request', not dupes, repr(dupes) if dupes else repr(sorted(counts)))
def has_stub(t):
    return '"in_context": true' in t or '"in_context":true' in t or '\\"in_context\\":true' in t


recall_stub = any(has_stub(t) for r in tool_results(last).values() for t in texts([r]))
via_meta = any(
    p.get('type') == 'tool_use' and p.get('name') == 'tool_call' and 'curated_recall_context' in json.dumps(p.get('input'))
    for m in last['messages'] if isinstance(m.get('content'), list) for p in m['content'] if isinstance(p, dict)
)
print('recall route:', 'tool_call meta tool' if via_meta else 'direct')
check('N3: the recall result stubs a fact already in context', recall_stub)
if via_meta:
    wrapped_stub = any(
        has_stub(t) and '<<<EXTERNAL_UNTRUSTED_CONTENT' in t and t.rstrip().endswith('>>>')
        for r in tool_results(last).values() for t in texts([r])
    )
    check('N3 via tool_call: the stub sits inside the external-content wrapper', wrapped_stub)

# --- verbose -----------------------------------------------------------------
vlog = os.path.join(WORK, 'state', 'logs', 'ct-wisdom-verbose.jsonl')
records = [json.loads(l) for l in open(vlog, encoding='utf-8')] if os.path.exists(vlog) else []
act = [(r.get('event'), r.get('query'), r.get('activity')) for r in records if r.get('channel') == 'activity']
check('verbose: one activity delivery record per fact', sorted(q for e, q, _ in act if e == 'delivery') == sorted(EXPECTED), repr(act))

# --- keys never written ------------------------------------------------------
key = os.environ.get('ZAI_API_KEY', '')
found = False
if key:
    for root, _dirs, files in os.walk(WORK):
        if '/host/' in root + '/' or root.endswith('/host'):
            continue
        for f in files:
            try:
                with open(os.path.join(root, f), 'rb') as fh:
                    if key.encode() in fh.read():
                        found = True
            except OSError:
                pass
check('the API key appears in no work-dir file', bool(key) and not found)

ok = all(results)
print('VERDICT:', 'PASS' if ok else 'FAIL', f'({sum(results)}/{len(results)})')
sys.exit(0 if ok else 1)
