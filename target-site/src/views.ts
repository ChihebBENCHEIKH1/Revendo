/**
 * Server-rendered pages for Vitrine.
 *
 * Template literals rather than a view engine: it is one dependency fewer, the
 * output is obvious at a glance, and the point of this service is the detector, not
 * its presentation layer. `escapeHtml` is applied at every interpolation of
 * user-controlled data — the marketplace is fake, the XSS would be real.
 */

import { escapeHtml } from './gate.js';
import type { Listing } from './listings.js';

const STYLES = `
:root{--bg:#fbfbfd;--card:#fff;--ink:#14171f;--muted:#6b7482;--line:#e6e8ee;--brand:#4338ca;--ok:#0f9d58}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.bar{max-width:1080px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:20px}
.logo{font-weight:800;font-size:20px;letter-spacing:-.4px;color:var(--brand);text-decoration:none}
.logo span{color:var(--ink)}
nav{margin-left:auto;display:flex;gap:18px}
nav a{color:var(--muted);text-decoration:none;font-size:15px}
nav a:hover{color:var(--ink)}
main{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.5px}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.thumb{aspect-ratio:4/3;display:grid;place-items:center;font-size:40px;background:linear-gradient(135deg,#eef0fb,#f7f4ff)}
.card .body{padding:12px 14px}
.card h3{margin:0 0 4px;font-size:15px;font-weight:600}
.price{font-weight:700;color:var(--brand)}
.meta{color:var(--muted);font-size:13px;margin-top:4px}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;max-width:460px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.4px}
input,textarea,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff;color:var(--ink)}
textarea{min-height:90px;resize:vertical}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}
fieldset.conditions{border:1px solid var(--line);border-radius:8px;padding:10px 14px 14px;margin:14px 0 0}
fieldset.conditions legend{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;padding:0 6px}
label.radio{display:flex;align-items:center;gap:9px;margin:8px 0 0;font-size:15px;font-weight:400;color:var(--ink);text-transform:none;letter-spacing:0;cursor:pointer}
label.radio input{width:auto;margin:0}
.notice{background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:8px;padding:12px 14px;font-size:14px;margin-bottom:20px}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 8px;border-radius:99px;background:#e8f5e9;color:var(--ok)}
footer{max-width:1080px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:13px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Vitrine</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="bar">
    <a class="logo" href="/">vitrine<span>.</span></a>
    <nav>
      <a href="/">Articles</a>
      <a href="/sell">Vendre</a>
      <a href="/login">Connexion</a>
      <a href="/__sentinelle">Sentinelle</a>
    </nav>
  </div>
</header>
<main>${body}</main>
<footer>Vitrine is a fictional marketplace built to be scraped. Protected by Sentinelle.</footer>
<script src="/probe.js" defer></script>
</body>
</html>`;
}

export function homePage(listings: readonly Listing[]): string {
  const cards = listings
    .map(
      (l) => `<article class="card">
  <div class="thumb">${escapeHtml(l.emoji)}</div>
  <div class="body">
    <h3>${escapeHtml(l.title)}</h3>
    <div class="price">${(l.priceCents / 100).toFixed(2)} €</div>
    <div class="meta">${escapeHtml(l.brand)} · ${escapeHtml(l.size)} · ${escapeHtml(l.condition)}</div>
  </div>
</article>`,
    )
    .join('\n');

  return layout(
    'Articles',
    `<h1>Articles à vendre</h1>
<p class="sub">${listings.length} annonces en ligne</p>
<div class="grid">${cards}</div>`,
  );
}

export function loginPage(error?: string): string {
  return layout(
    'Connexion',
    `<h1>Connexion</h1>
<p class="sub">Connectez-vous pour publier une annonce.</p>
${error ? `<div class="notice">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/api/login">
  <label for="email">Adresse e-mail</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Mot de passe</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit" id="submit-login">Se connecter</button>
</form>
<p class="sub" style="margin-top:16px">Démo : <code>seller@vitrine.test</code> / <code>hunter2</code></p>`,
  );
}

export function sellPage(): string {
  return layout(
    'Vendre',
    `<h1>Nouvelle annonce</h1>
<p class="sub">Décrivez votre article. Il sera visible immédiatement.</p>
<form method="post" action="/api/listings">
  <label for="title">Titre</label>
  <input id="title" name="title" required maxlength="120">
  <label for="brand">Marque</label>
  <input id="brand" name="brand" required maxlength="60">
  <label for="size">Taille</label>
  <input id="size" name="size" required maxlength="20">
  <!--
    Radios, not a <select>. A native select opens an OS-level widget that lives
    outside the page, so a pointer-driven agent cannot interact with it through
    Input.dispatchMouseEvent — the interaction would have to be faked in JS, which is
    exactly what this site is built to detect. Radios keep the whole interaction
    inside the document where it can be measured honestly.
  -->
  <fieldset class="conditions">
    <legend>État</legend>
    <label class="radio"><input type="radio" name="condition" id="condition-neuf" value="Neuf avec étiquette"> Neuf avec étiquette</label>
    <label class="radio"><input type="radio" name="condition" id="condition-tres-bon" value="Très bon état" checked> Très bon état</label>
    <label class="radio"><input type="radio" name="condition" id="condition-bon" value="Bon état"> Bon état</label>
    <label class="radio"><input type="radio" name="condition" id="condition-satisfaisant" value="Satisfaisant"> Satisfaisant</label>
  </fieldset>
  <label for="price">Prix (€)</label>
  <input id="price" name="price" type="number" step="0.01" min="1" required>
  <label for="description">Description</label>
  <textarea id="description" name="description" maxlength="600"></textarea>
  <button type="submit" id="submit-listing">Publier l'annonce</button>
</form>`,
  );
}

export function listingCreatedPage(listing: Listing): string {
  return layout(
    'Annonce publiée',
    `<span class="badge">EN LIGNE</span>
<h1 style="margin-top:10px">${escapeHtml(listing.title)}</h1>
<p class="sub">Référence <code>${escapeHtml(listing.id)}</code></p>
<div class="notice">Votre annonce est publiée et visible par les acheteurs.</div>
<p><strong>${(listing.priceCents / 100).toFixed(2)} €</strong> · ${escapeHtml(listing.brand)} · ${escapeHtml(listing.size)}</p>
<p>${escapeHtml(listing.description)}</p>`,
  );
}

/**
 * The challenge interstitial.
 *
 * A real challenge is a proof-of-work or an interaction puzzle whose cost is
 * negligible for one human and prohibitive for a million requests. This one asks for
 * a deliberate pointer gesture, which is honest about what it is actually testing:
 * not "are you human" but "will you pay the behavioural cost of looking like one".
 * A worker that has a real mouse model solves it; one that calls .click() cannot.
 */
export function challengePage(next: string, score: number): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vérification — Vitrine</title>
<style>${STYLES}
 body{display:grid;place-items:center;min-height:100vh;background:#f4f5fa}
 .box{background:#fff;border:1px solid var(--line);border-radius:14px;padding:32px;max-width:440px;text-align:center}
 #pad{margin:22px 0;height:120px;border:2px dashed #c7cbd8;border-radius:10px;position:relative;cursor:crosshair}
 #target{position:absolute;right:14px;top:44px;width:32px;height:32px;border-radius:50%;background:var(--brand)}
 .bar{height:6px;background:#eceef4;border-radius:99px;overflow:hidden;margin-top:8px}
 .fill{height:100%;width:0;background:var(--brand);transition:width .12s}
</style></head><body>
<div class="box">
  <h1>Vérification rapide</h1>
  <p class="sub">Déplacez votre curseur jusqu'au point bleu pour continuer.</p>
  <div id="pad"><div id="target"></div></div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <p class="sub" style="font-size:12px;margin-top:14px">Score de session : ${score}</p>
</div>
<script src="/probe.js" defer></script>
<script>
(function(){
  // Require a genuine path, not a single teleport into the target: at least 15
  // distinct samples, a total travelled distance well above the straight-line
  // distance, and a terminal position inside the target.
  var pad = document.getElementById('pad'), target = document.getElementById('target'), fill = document.getElementById('fill');
  var samples = [], travelled = 0, last = null;
  pad.addEventListener('mousemove', function(e){
    var r = pad.getBoundingClientRect(), p = {x:e.clientX-r.left, y:e.clientY-r.top};
    if(last) travelled += Math.hypot(p.x-last.x, p.y-last.y);
    last = p; samples.push(p);
    fill.style.width = Math.min(100, samples.length/15*100) + '%';
    var t = target.getBoundingClientRect();
    var inside = e.clientX>=t.left && e.clientX<=t.right && e.clientY>=t.top && e.clientY<=t.bottom;
    if(inside && samples.length>=15 && travelled>60){
      fetch('/api/challenge/solve',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({samples:samples.length,travelled:Math.round(travelled)}),credentials:'same-origin'})
        .then(function(){ location.href=${JSON.stringify(next)}; });
    }
  }, {passive:true});
})();
</script>
</body></html>`;
}
