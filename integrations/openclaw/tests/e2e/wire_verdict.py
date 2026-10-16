"""AC 9 byte-level verdict from two recorded Anthropic Messages requests."""
import json, sys, hashlib, re
rows = [json.loads(l) for l in open(sys.argv[1])]
reqs = [json.loads(r['body']) for r in rows]
MK = re.compile(r'ct-fact:([A-Za-z0-9._:-]+)')
def canon(x): return json.dumps(x, sort_keys=True, ensure_ascii=False)
def h(x): return hashlib.sha256(canon(x).encode()).hexdigest()[:16]
def text_of(m):
    c = m.get('content')
    if isinstance(c, str): return c
    return '\n'.join(p.get('text', '') for p in c if isinstance(p, dict) and p.get('type') == 'text')
for i, r in enumerate(reqs):
    sysp = r.get('system')
    st = sysp if isinstance(sysp, str) else ''.join(p.get('text', '') for p in (sysp or []) if isinstance(p, dict))
    print(f'request {i+1}: model={r.get("model")} system sha={h(sysp)} system markers={MK.findall(st)} messages={len(r["messages"])} cache_control in system={"cache_control" in canon(sysp)}')
    for j, m in enumerate(r['messages']):
        t = text_of(m)
        print(f'   [{j}] {m["role"]:9} sha={h(m["content"])} markers={MK.findall(t)} head={t[:70]!r}')
a, b = reqs[0], reqs[1]
print()
print('system identical across turns        :', canon(a.get('system')) == canon(b.get('system')))
print('tools identical across turns         :', canon(a.get('tools')) == canon(b.get('tools')))
n = len(a['messages'])
prefix_ok = canon(a['messages'][: n]) == canon(b['messages'][: n])
print(f'turn-1 messages replayed byte-identically as turn-2 prefix ({n} msgs):', prefix_ok)
if not prefix_ok:
    for j in range(n):
        if canon(a['messages'][j]) != canon(b['messages'][j]):
            print('  first divergence at message', j)
            print('  t1:', canon(a['messages'][j])[:600])
            print('  t2:', canon(b['messages'][j])[:600])
            break
last = b['messages'][-1]
tail_ids = MK.findall(text_of(last))
print('turn-2 live block rides the LAST user message:', bool(tail_ids), tail_ids)
first_ids = MK.findall(text_of(a['messages'][-1]))
dupes = sorted(set(first_ids) & set(tail_ids))
print('exactly-once (turn-2 block repeats no turn-1 id):', not dupes, dupes)
ok = (canon(a.get('system')) == canon(b.get('system')) and prefix_ok and bool(tail_ids) and not dupes)
print('VERDICT:', 'cache-safe' if ok else 'NOT cache-safe')
sys.exit(0 if ok else 1)
