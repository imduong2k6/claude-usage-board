"""Aggregate Claude Code transcripts (~/.claude/projects/**/*.jsonl) into one small stats.json.

Reads only usage numbers, timestamps, model ids and session ids; message text is never stored.
The file holds the per-day rows plus a summary, hourly counts and model rows for each range
the board offers (all, last 30 days, last 7 days), all in local time.
Usage: python -I build_stats.py <path to stats.json>
"""
import json, os, re, sys, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

root = os.path.join(os.path.expanduser('~'), '.claude', 'projects')
out_file = sys.argv[1]

IGNORED_PROMPT_STARTS = ('<system-reminder>', '<command-', '<local-command', '[Request interrupted')
FIELDS = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')

replies = {}   # message id -> {ts, model, sid, usage fields (max over streamed duplicates)}
prompts = {}   # uuid -> (ts, sid)
files = 0
t0 = time.time()

def real_prompt(d):
    if d.get('isSidechain') or d.get('isMeta') or d.get('isCompactSummary'):
        return False
    c = (d.get('message') or {}).get('content')
    blocks = [c] if isinstance(c, str) else [b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text']
    return any(t.strip() and not t.lstrip().startswith(IGNORED_PROMPT_STARTS) for t in blocks)

for dp, _, names in os.walk(root):
    for name in names:
        if not name.endswith('.jsonl'):
            continue
        files += 1
        if files % 100 == 0:
            print(f'{files} files, {time.time() - t0:.0f}s', file=sys.stderr, flush=True)
        with open(os.path.join(dp, name), 'rb') as fh:
            for line in fh:
                if line.startswith(b'{"type":"api-request'):
                    continue
                asst = b'"role":"assistant"' in line and b'"usage":{' in line
                user = b'"type":"user"' in line and b'"tool_result"' not in line
                if not (asst or user):
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                ts, sid = d.get('timestamp'), d.get('sessionId')
                if not ts or not sid:
                    continue
                if d.get('type') == 'assistant':
                    m = d.get('message') or {}
                    u, mid, model = m.get('usage'), m.get('id'), m.get('model')
                    if not u or not mid or not model or model.startswith('<'):
                        continue
                    r = replies.setdefault(mid, {'ts': ts, 'model': model, 'sid': sid, **{k: 0 for k in FIELDS}})
                    for k in FIELDS:
                        r[k] = max(r[k], u.get(k) or 0)
                elif d.get('type') == 'user' and d.get('uuid') and real_prompt(d):
                    prompts.setdefault(d['uuid'], (ts, sid))

def local(ts):
    return datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).astimezone()

def pretty(m):
    mm = re.match(r'claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$', m)
    if mm:
        return f'{mm[1].title()} {mm[2]}' + (f'.{mm[3]}' if mm[3] else '')
    mm = re.match(r'claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)', m)
    if mm:
        return f'{mm[3].title()} {mm[1]}' + (f'.{mm[2]}' if mm[2] else '')
    return m

# local day and hour of every reply and prompt, computed once
timed = []
for r in replies.values():
    t = local(r['ts'])
    timed.append((t.strftime('%Y-%m-%d'), t.hour, r))
ptimed = []
for ts, sid in prompts.values():
    t = local(ts)
    ptimed.append((t.strftime('%Y-%m-%d'), t.hour, sid))

all_days = sorted({d for d, _, _ in timed} | {d for d, _, _ in ptimed})
first_day, last_day = all_days[0], all_days[-1]
now = datetime.now().astimezone()
offset_hours = now.utcoffset().total_seconds() / 3600
tz = 'UTC%+g' % offset_hours

def aggregate(since):
    """Summary, hourly counts and model rows for the days on or after `since` (None: all)."""
    hourly = [0] * 24
    models = defaultdict(lambda: {'messages': 0, 'input_tokens': 0, 'output_tokens': 0, 'cache_write_tokens': 0, 'cache_read_tokens': 0})
    sessions, active = set(), set()
    tot = defaultdict(int)
    for day, hour, r in timed:
        if since and day < since:
            continue
        n = sum(r[k] for k in FIELDS)
        hourly[hour] += 1
        active.add(day); sessions.add(r['sid'])
        mo = models[r['model']]
        mo['messages'] += 1
        mo['input_tokens'] += r['input_tokens']; mo['output_tokens'] += r['output_tokens']
        mo['cache_write_tokens'] += r['cache_creation_input_tokens']; mo['cache_read_tokens'] += r['cache_read_input_tokens']
        tot['replies'] += 1; tot['tokens'] += n
        tot['input_tokens'] += r['input_tokens']; tot['output_tokens'] += r['output_tokens']
        tot['cache_write_tokens'] += r['cache_creation_input_tokens']; tot['cache_read_tokens'] += r['cache_read_input_tokens']
    for day, hour, sid in ptimed:
        if since and day < since:
            continue
        hourly[hour] += 1
        active.add(day); sessions.add(sid)
        tot['prompts'] += 1

    start = max(since, first_day) if since else first_day
    rows = sorted(({'model': k, 'name': pretty(k), **v, 'tokens': v['input_tokens'] + v['output_tokens'] + v['cache_write_tokens'] + v['cache_read_tokens']}
                   for k, v in models.items()), key=lambda r: -r['tokens'])
    for r in rows:
        r['share'] = round(r['tokens'] / tot['tokens'], 4) if tot['tokens'] else 0
    peak = max(range(24), key=lambda h: hourly[h])
    span = (datetime.strptime(last_day, '%Y-%m-%d') - datetime.strptime(start, '%Y-%m-%d')).days + 1
    summary = {
        'sessions': len(sessions), 'messages': tot['replies'] + tot['prompts'], 'prompts': tot['prompts'], 'replies': tot['replies'],
        'tokens': tot['tokens'], 'input_tokens': tot['input_tokens'], 'output_tokens': tot['output_tokens'],
        'cache_write_tokens': tot['cache_write_tokens'], 'cache_read_tokens': tot['cache_read_tokens'],
        'active_days': len(active), 'first_day': start, 'last_day': last_day, 'span_days': max(1, span),
        'peak_hour': peak, 'favorite_model': max(rows, key=lambda r: r['messages'])['name'] if rows else '—',
    }
    return {'summary': summary, 'hourly': hourly, 'models': rows}

daily = defaultdict(lambda: {'messages': 0, 'tokens': 0, 'output_tokens': 0, 'sessions': set()})
for day, _, r in timed:
    x = daily[day]
    x['messages'] += 1; x['tokens'] += sum(r[k] for k in FIELDS); x['output_tokens'] += r['output_tokens']; x['sessions'].add(r['sid'])
for day, _, sid in ptimed:
    x = daily[day]
    x['messages'] += 1; x['sessions'].add(sid)

first_dt, last_dt = datetime.strptime(first_day, '%Y-%m-%d'), datetime.strptime(last_day, '%Y-%m-%d')
daily_rows = []
for i in range((last_dt - first_dt).days + 1):
    k = (first_dt + timedelta(days=i)).strftime('%Y-%m-%d')
    x = daily.get(k)
    daily_rows.append({'day': k, 'messages': x['messages'] if x else 0, 'tokens': x['tokens'] if x else 0,
                       'output_tokens': x['output_tokens'] if x else 0, 'sessions': len(x['sessions']) if x else 0})

stats = {
    'generated_at': now.isoformat(timespec='seconds'), 'tz': tz, 'transcripts_scanned': files, 'daily': daily_rows,
    'ranges': {
        'all': aggregate(None),
        '30d': aggregate((now - timedelta(days=29)).strftime('%Y-%m-%d')),
        '7d': aggregate((now - timedelta(days=6)).strftime('%Y-%m-%d')),
    },
}

os.makedirs(os.path.dirname(os.path.abspath(out_file)), exist_ok=True)
tmp = out_file + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(stats, f, separators=(',', ':'))
os.replace(tmp, out_file)  # atomic: a reader never sees a half-written file
for k, v in stats['ranges'].items():
    print(k, json.dumps({f: v['summary'][f] for f in ('sessions', 'messages', 'tokens', 'active_days', 'first_day', 'peak_hour', 'favorite_model')}))
print(f'done {time.time() - t0:.0f}s', file=sys.stderr)
