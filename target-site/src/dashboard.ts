/**
 * The Sentinelle console.
 *
 * This is the demo's output device: every decision the detector makes streams here
 * live, with the evidence that produced it. A bot detector you cannot watch think is
 * a bot detector nobody trusts enough to switch from monitor mode to enforcement —
 * so the explanation surface is a feature, not decoration.
 *
 * Server-Sent Events rather than WebSockets: the traffic is one-directional, SSE
 * reconnects on its own, and it survives proxies that mangle upgrade requests. Using
 * a bidirectional protocol for a unidirectional feed is a cost with no benefit.
 */

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinelle — console</title>
<style>
:root{--bg:#080a0f;--panel:#0f131c;--line:#1c2331;--ink:#e6ecf5;--muted:#7b8899;
      --ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--accent:#38bdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{border-bottom:1px solid var(--line);padding:16px 22px;display:flex;align-items:center;gap:16px}
h1{font-size:15px;margin:0;letter-spacing:2px;text-transform:uppercase;color:var(--accent)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.right{margin-left:auto;color:var(--muted);font-size:12px;display:flex;gap:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
.stat{background:var(--panel);padding:14px 18px}
.stat .k{color:var(--muted);font-size:11px;letter-spacing:1.4px;text-transform:uppercase}
.stat .v{font-size:26px;font-weight:700;margin-top:2px}
main{padding:18px 22px;display:grid;gap:12px;max-width:1200px}
.event{background:var(--panel);border:1px solid var(--line);border-left-width:3px;border-radius:8px;
       padding:14px 16px;animation:in .25s ease}
@keyframes in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.event.allow{border-left-color:var(--ok)} .event.challenge{border-left-color:var(--warn)} .event.block{border-left-color:var(--bad)}
.head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.score{font-size:32px;font-weight:800;min-width:56px}
.allow .score{color:var(--ok)} .challenge .score{color:var(--warn)} .block .score{color:var(--bad)}
.verdict{font-size:11px;font-weight:700;letter-spacing:1.6px;padding:3px 9px;border-radius:99px;text-transform:uppercase}
.allow .verdict{background:rgba(34,197,94,.13);color:var(--ok)}
.challenge .verdict{background:rgba(245,158,11,.13);color:var(--warn)}
.block .verdict{background:rgba(239,68,68,.13);color:var(--bad)}
.who{color:var(--muted);font-size:12px}
.who b{color:var(--ink);font-weight:600}
.sig{margin-top:12px;display:grid;gap:5px}
/* 92px, not 74: "FINGERPRINT" is the longest layer name and was being clipped to
   "FINGERPRIN" — which looked like a rendering bug in every screenshot of it. */
.row{display:grid;grid-template-columns:92px 34px 1fr;gap:10px;align-items:baseline;font-size:12px}
.layer{font-size:9.5px;letter-spacing:.9px;text-transform:uppercase;padding:2px 5px;border-radius:3px;text-align:center;color:#0b0e14;font-weight:700;white-space:nowrap}
.layer.transport{background:#60a5fa} .layer.fingerprint{background:#c084fc} .layer.behavior{background:#fbbf24}
.w{color:var(--bad);font-weight:700;text-align:right}
.desc{color:var(--ink)} .ev{color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:60px 0}
.empty code{background:var(--panel);padding:3px 8px;border-radius:4px;color:var(--accent)}
</style></head>
<body>
<header>
  <span class="dot" id="live"></span>
  <h1>Sentinelle</h1>
  <div class="right">
    <span>vitrine.local</span>
    <span>thresholds: challenge ≥30 · block ≥60</span>
  </div>
</header>

<div class="stats">
  <div class="stat"><div class="k">Assessments</div><div class="v" id="s-total">0</div></div>
  <div class="stat"><div class="k">Allowed</div><div class="v" style="color:var(--ok)" id="s-allow">0</div></div>
  <div class="stat"><div class="k">Challenged</div><div class="v" style="color:var(--warn)" id="s-chal">0</div></div>
  <div class="stat"><div class="k">Blocked</div><div class="v" style="color:var(--bad)" id="s-block">0</div></div>
  <div class="stat"><div class="k">Sessions</div><div class="v" id="s-sess">0</div></div>
  <div class="stat"><div class="k">Peak score</div><div class="v" id="s-peak">0</div></div>
</div>

<main id="feed">
  <div class="empty" id="empty">
    Waiting for traffic… run <code>make demo-naive</code> or <code>make demo-stealth</code>
  </div>
</main>

<script>
(function(){
  var feed = document.getElementById('feed');
  var empty = document.getElementById('empty');
  var stats = { total:0, allow:0, challenge:0, block:0, peak:0 };
  var sessions = new Set();
  // One card per session, updated in place: a session is a story that accumulates
  // evidence, and re-rendering the whole story on every request would bury it.
  var cards = new Map();

  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function verdictClass(v){ return String(v).split(' ')[0]; }

  function render(ev){
    var cls = verdictClass(ev.verdict);
    var rows = (ev.detections||[]).map(function(d){
      return '<div class="row">'
        + '<span class="layer ' + esc(d.layer) + '">' + esc(d.layer) + '</span>'
        + '<span class="w">+' + esc(d.weight) + '</span>'
        + '<span><span class="desc">' + esc(d.description) + '</span> '
        + '<span class="ev">— ' + esc(d.evidence) + '</span></span></div>';
    }).join('');

    var ua = (ev.userAgent||'').slice(0,58) || 'unknown UA';
    return '<div class="head">'
      + '<span class="score">' + esc(ev.score) + '</span>'
      + '<span class="verdict">' + esc(ev.verdict) + '</span>'
      + '<span class="who"><b>' + esc(ev.action) + '</b> · ' + esc(ev.path)
      + ' · ip ' + esc(ev.ip) + ' · sid ' + esc(String(ev.sessionId).slice(0,8))
      + '<br>' + esc(ua) + '</span></div>'
      + (rows ? '<div class="sig">' + rows + '</div>' : '');
  }

  function push(ev){
    if(empty) { empty.remove(); empty = null; }

    stats.total++;
    var cls = verdictClass(ev.verdict);
    if(stats[cls] !== undefined) stats[cls]++;
    sessions.add(ev.sessionId);
    if(ev.score > stats.peak) stats.peak = ev.score;

    document.getElementById('s-total').textContent = stats.total;
    document.getElementById('s-allow').textContent = stats.allow;
    document.getElementById('s-chal').textContent = stats.challenge;
    document.getElementById('s-block').textContent = stats.block;
    document.getElementById('s-sess').textContent = sessions.size;
    document.getElementById('s-peak').textContent = stats.peak;

    var card = cards.get(ev.sessionId);
    if(!card){
      card = document.createElement('div');
      cards.set(ev.sessionId, card);
      feed.prepend(card);
    } else {
      feed.prepend(card);
    }
    card.className = 'event ' + cls;
    card.innerHTML = render(ev);

    // Bound the DOM. A demo left running for an hour should not become a memory leak.
    while(feed.children.length > 40){
      var last = feed.lastElementChild;
      cards.forEach(function(v,k){ if(v === last) cards.delete(k); });
      last.remove();
    }
  }

  fetch('/__sentinelle/recent').then(function(r){ return r.json(); })
    .then(function(list){ list.slice().reverse().forEach(push); })
    .catch(function(){});

  var es = new EventSource('/__sentinelle/stream');
  es.onmessage = function(e){ try { push(JSON.parse(e.data)); } catch(err){} };
  es.onerror = function(){ document.getElementById('live').style.background = '#ef4444'; };
  es.onopen  = function(){ document.getElementById('live').style.background = '#22c55e'; };
})();
</script>
</body></html>`;
}
