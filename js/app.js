/* Stryke — логика приложения */
(() => {
"use strict";

const {P,BY,REASONS,RN,SECTORS,STAGES,FEEDS,VIEWS,DTABS,TERMS} = window.STRYKE;

/* ================= STATE ================= */
const LS = {
  get(k,d){try{const v=localStorage.getItem("stryke:"+k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem("stryke:"+k,JSON.stringify(v))}catch(e){}}
};
let me = normMe(LS.get("me",null));
let uid = null, ref = null, mode = "local"; // local | live | mine-local
const people = new Map();                  // uid -> документ других участников
const names = {}; let userCap = null; let myName = LS.get("name","");
let touched = false;
const saved = new Set(LS.get("saved",[]));
const ui = Object.assign({view:"feed",feed:"foryou",sector:"all",stage:"all"}, LS.get("ui",{}));
if(!VIEWS.some(v=>v[0]===ui.view)) ui.view="feed";
let sheet = null;          // {type, pid, tab, sector, stage}
const draft = {};          // pid -> Set причин, пока шторка «Почему» открыта
let order = [];            // id проектов в текущей ленте
let cur = 0;               // индекс видимого слайда
let agg = {};

function normMe(d){d=d&&typeof d==="object"?d:{};return {preds:Object.assign({},d.preds||{}),cm:Object.assign({},d.cm||{})}}
const clone = o => JSON.parse(JSON.stringify(o));

function recompute(){
  agg = {};
  P.forEach(p=>agg[p.id]={y:0,n:0,ry:{},rn:{},c:[]});
  const all = new Map(people); all.set(uid||"me", me);
  for (const [id,d] of all){
    const preds = d&&d.preds||{};
    for (const pid in preds){
      const a=agg[pid]; const pr=preds[pid]; if(!a||!pr) continue;
      if(pr.v==="y") a.y++; else if(pr.v==="n") a.n++; else continue;
      const bucket = pr.v==="y"?a.ry:a.rn;
      (Array.isArray(pr.r)?pr.r:[]).forEach(r=>{if(RN[r]) bucket[r]=(bucket[r]||0)+1});
    }
    const cm = d&&d.cm||{};
    for (const pid in cm){
      const a=agg[pid]; if(!a||!Array.isArray(cm[pid])) continue;
      cm[pid].forEach(c=>{ if(c&&typeof c.text==="string") a.c.push({uid:id,id:c.id,text:c.text.slice(0,1000),t:+c.t||0,v:preds[pid]&&preds[pid].v}) });
    }
  }
  P.forEach(p=>agg[p.id].c.sort((a,b)=>b.t-a.t));
}

/* ================= HELPERS ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function plural(n,f){const a=Math.abs(n)%100,b=a%10;return n+" "+(a>10&&a<20?f[2]:b>1&&b<5?f[1]:b===1?f[0]:f[2])}
const VOTES_F=["голос","голоса","голосов"], CM_F=["комментарий","комментария","комментариев"], PR_F=["прогноз","прогноза","прогнозов"], PJ_F=["проект","проекта","проектов"];
function ago(t){const s=(Date.now()-t)/1000;if(s<60)return"только что";if(s<3600)return Math.floor(s/60)+" мин назад";if(s<86400)return Math.floor(s/3600)+" ч назад";if(s<86400*30)return Math.floor(s/86400)+" дн назад";return new Date(t).toLocaleDateString("ru-RU",{day:"numeric",month:"short"})}
function pct(a,b){const t=a+b;return t?Math.round(a/t*100):0}
function initials(n){return (n||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase()||"?"}
function nameOf(id){if(id===uid||id==="me")return"Ты";return names[id]||"Участник"}
let toastT; function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,2400)}
function hash(s){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0}
const isDesk = () => matchMedia("(min-width:1024px)").matches;
const icon = id => `<svg><use href="#${id}"/></svg>`;

/* ================= PERSISTENCE ================= */
let saving=false, dirty=false, saveT;
let backend = null;        // "claude" | "supabase" — куда сохраняем, когда mode === "live"
/* op: {t:"pred",pid} | {t:"cadd",pid,c} | {t:"cdel",id} */
function persist(op){
  touched = true;
  LS.set("me",me);
  recompute();
  if (mode!=="live") return;
  if (backend==="supabase"){ if(op) SB.write(op); return; }
  clearTimeout(saveT); saveT=setTimeout(flush,300);
}
async function flush(){
  dirty=true; if(saving) return; saving=true;
  while(dirty){
    dirty=false;
    try{ await ref.set(clone(me)); }
    catch(e){
      const code=e&&e.code;
      if(code==="invalid_argument"||code==="not_granted"||code==="revoked"){ setMode("mine-local"); break; }
      if(code==="unavailable"){ await new Promise(r=>setTimeout(r,600+Math.random()*900)); dirty=true; continue; }
      if(code==="quota_exceeded"){ toast("Хранилище заполнено, сохранить не удалось"); break; }
      toast("Не удалось сохранить, попробуй ещё раз"); break;
    }
  }
  saving=false;
}
function setMode(m){
  const was=mode; mode=m;
  if(m==="mine-local"&&was!=="mine-local") toast("Твои прогнозы сохраняются только на этом устройстве");
  renderSide(); if(ui.view==="profile") renderPage();
}
const modeHTML = () => `<span class="mode${mode==="live"?" live":""}"><b></b>${mode==="live"?"Онлайн":"Локально"}</span>`;

/* ================= ORDER ================= */
function filtered(sector=ui.sector, stage=ui.stage){
  return P.filter(p=>(sector==="all"||p.tags.includes(sector))&&(stage==="all"||p.stage===stage));
}
function list(){
  if (ui.view==="saved") return P.filter(p=>saved.has(p.id));
  const arr = filtered();
  const tot = p=>agg[p.id].y+agg[p.id].n;
  if (ui.feed==="foryou"){
    const aff={}; for(const pid in me.preds){BY[pid]&&BY[pid].tags.forEach(t=>aff[t]=(aff[t]||0)+1)}
    const seed = uid||"anon";
    arr.sort((a,b)=>{
      const va=!!me.preds[a.id], vb=!!me.preds[b.id]; if(va!==vb) return va-vb;
      const fa=a.tags.reduce((s,t)=>s+(aff[t]||0),0), fb=b.tags.reduce((s,t)=>s+(aff[t]||0),0);
      if(fa!==fb) return fb-fa;
      return hash(seed+a.id)-hash(seed+b.id);
    });
  } else if (ui.feed==="hot"){
    arr.sort((a,b)=>tot(b)-tot(a)||(agg[b.id].c.length-agg[a.id].c.length)||b.growth-a.growth);
  } else if (ui.feed==="split"){
    const sc=p=>{const t=tot(p);return t?Math.abs(agg[p.id].y-agg[p.id].n)/t - Math.min(t,20)/1000:2};
    arr.sort((a,b)=>sc(a)-sc(b)||b.growth-a.growth);
  } else arr.sort((a,b)=>b.growth-a.growth);
  return arr;
}

/* ================= CHROME ================= */
function renderChrome(){
  const nav = VIEWS.map(([k,l,i])=>`<button data-act="view" data-k="${k}" ${ui.view===k?'aria-current="page"':""}>${icon(i)}${l}</button>`).join("");
  $("#bnav").innerHTML=nav; $("#snav").innerHTML=nav;
  const filt = ui.sector!=="all"||ui.stage!=="all";
  $("#rtop").innerHTML = ui.view==="saved"
    ? `<span class="mini">${icon("bolt")}</span><h1 class="rtitle">Сохранённое <span class="muted num">${saved.size}</span></h1>`
    : `<span class="mini">${icon("bolt")}</span>
       <div class="tabs" role="group" aria-label="Подразделы ленты">${FEEDS.map(([k,l])=>`<button class="tab" data-act="feed" data-k="${k}" aria-pressed="${ui.feed===k}">${l}</button>`).join("")}</div>
       <button class="ibtn" data-act="filters" aria-label="Фильтры${filt?" (включены)":""}">${icon("i-filter")}${filt?'<i class="dot"></i>':""}</button>`;
}

/* ================= SLIDES ================= */
const tagHTML = (t,cls="") => `<span class="tag ${cls}" data-tip="${esc(t)}" tabindex="0">${esc(t)}</span>`;
function slideHTML(p,i){
  return `<article class="slide" id="s-${p.id}" data-pid="${p.id}" data-i="${i}" aria-label="${esc(p.name)}">
    <div class="bg" style="background-image:url('${p.img}')"></div>
    <div class="slide-in">
      <div class="media">
        <div class="tags">${p.tags.map(t=>tagHTML(t)).join("")}${tagHTML(p.stage,"stage-t")}</div>
        <img class="fg" src="${p.img}" alt="" width="460" height="168" loading="${i<2?"eager":"lazy"}" decoding="async">
        <div class="rail" data-zone="rail">${railHTML(p)}</div>
      </div>
      <div class="info">
        <h2 class="title">${esc(p.name)}</h2>
        <p class="short">${esc(p.short)}</p>
        <div class="metrics num">${p.m.map((x,k)=>`<div class="metric${k===2?" up":""}" data-tip="${esc(x[1])}" tabindex="0"><b>${x[0]}</b><span>${x[1]}</span></div>`).join("")}</div>
        <button class="more" data-act="details">Посмотреть подробнее ↓</button>
        <div data-zone="vote">${voteHTML(p)}</div>
      </div>
    </div>
  </article>`;
}
function railHTML(p){
  const s=saved.has(p.id), n=agg[p.id].c.length, mine=me.preds[p.id];
  return `<button data-act="save" aria-pressed="${s}" aria-label="${s?"Убрать из сохранённого":"Сохранить"}"><span class="ico">${icon("i-save")}</span>${s?"Сохранено":"Сохранить"}</button>
    <button data-act="disc" aria-label="Обсуждение"><span class="ico">${icon("i-chat")}</span><span class="num">${n}</span></button>
    <button data-act="why" class="${mine&&mine.r&&mine.r.length?"on":""}" aria-label="Почему"><span class="ico">${icon("i-why")}</span>Почему</button>`;
}
function voteHTML(p){
  const a=agg[p.id], mine=me.preds[p.id], v=mine&&mine.v, t=a.y+a.n;
  let h=`<p class="ask">Как думаешь, проект стрельнет?</p>
  <div class="votes${v?" voted":""}">
    <button class="vbtn yes" data-act="vote" data-k="y" aria-pressed="${v==="y"}">Стрельнет<small class="num">${plural(a.y,VOTES_F)}</small></button>
    <button class="vbtn no" data-act="vote" data-k="n" aria-pressed="${v==="n"}">Не стрельнет<small class="num">${plural(a.n,VOTES_F)}</small></button>
  </div><div class="vstat">`;
  if(!v) h+=`<p class="hint">${t?`Уже ${plural(t,VOTES_F)}. Проголосуй, чтобы увидеть расклад`:"Будь первым, кто сделает прогноз"}</p>`;
  else { const py=pct(a.y,a.n);
    h+=`<div class="bar"><i style="width:${py}%"></i><i style="width:${100-py}%"></i></div>
      <div class="split-l num"><span><b>${py}%</b> стрельнет</span><span>${plural(t,VOTES_F)}</span><span><b>${100-py}%</b> нет</span></div>`; }
  return h+`</div>`;
}
function endHTML(){
  const filt=ui.sector!=="all"||ui.stage!=="all";
  if(ui.view==="saved") return `<section class="endcard"><div class="big">${icon("bolt")}</div><h3>Это всё сохранённое</h3><p>Возвращайся в ленту, чтобы найти новые проекты.</p><div class="row"><button class="btn pri" data-act="view" data-k="feed">В ленту</button></div></section>`;
  const others=FEEDS.filter(f=>f[0]!==ui.feed).slice(0,2);
  return `<section class="endcard"><div class="big">${icon("bolt")}</div><h3>Ты посмотрел всё</h3>
    <p>В этой подборке больше нет проектов. Загляни в другой раздел${filt?" или сбрось фильтры":""}.</p>
    <div class="row">${others.map(([k,l])=>`<button class="btn ghost" data-act="feed" data-k="${k}">${l}</button>`).join("")}${filt?`<button class="btn pri" data-act="reset-filters">Сбросить фильтры</button>`:""}</div></section>`;
}
function emptyHTML(){
  return ui.view==="saved"
   ? `<section class="endcard"><div class="big">${icon("i-save")}</div><h3>Здесь пока пусто</h3><p>Нажми «Сохранить» справа на карточке, чтобы вернуться к проекту позже.</p><div class="row"><button class="btn pri" data-act="view" data-k="feed">В ленту</button></div></section>`
   : `<section class="endcard"><div class="big">${icon("i-filter")}</div><h3>Нет проектов</h3><p>Под эти фильтры ничего не подходит.</p><div class="row"><button class="btn pri" data-act="reset-filters">Сбросить фильтры</button></div></section>`;
}
function refreshSlide(pid){
  const s=document.getElementById("s-"+pid); if(!s) return;
  const p=BY[pid];
  s.querySelector('[data-zone="vote"]').innerHTML=voteHTML(p);
  s.querySelector('[data-zone="rail"]').innerHTML=railHTML(p);
}

/* ================= VIEWS ================= */
const reel = $("#reel"), stage=$("#stage"), page=$("#page");
let io = null;
function renderView(keepPid){
  renderChrome(); hideTip();
  if(ui.view==="profile"){
    stage.hidden=true; page.hidden=false;
    document.documentElement.classList.remove("reel-mode");
    renderPage(); renderSide(); window.scrollTo(0,0); return;
  }
  stage.hidden=false; page.hidden=true;
  document.documentElement.classList.add("reel-mode");
  order=list().map(p=>p.id);
  reel.innerHTML = order.length ? order.map((id,i)=>slideHTML(BY[id],i)).join("")+endHTML() : emptyHTML();
  cur=0; reel.scrollTop=0;
  if(keepPid){ const i=order.indexOf(keepPid); if(i>0){ cur=i; reel.scrollTop=i*reel.clientHeight; } }
  observe(); updateNav(); renderSide(); maybeCoach();
}
function observe(){
  if(io) io.disconnect();
  if(!("IntersectionObserver" in window)) return;
  io=new IntersectionObserver(es=>{
    es.forEach(e=>{ if(e.isIntersecting){ cur=e.target.dataset.i===""?order.length:+e.target.dataset.i; updateNav(); } });
  },{root:reel,threshold:.6});
  reel.querySelectorAll(".slide,.endcard").forEach((el,i)=>{ if(el.classList.contains("endcard")) el.dataset.i=""; io.observe(el); });
}
function updateNav(){
  const n=reel.children.length;
  const [up,down]=document.querySelectorAll(".reel-nav button");
  if(up) up.disabled=cur<=0;
  if(down) down.disabled=cur>=n-1;
}
function goTo(i,smooth=true){
  const n=reel.children.length; i=Math.max(0,Math.min(n-1,i));
  reel.scrollTo({top:i*reel.clientHeight,behavior:smooth&&!matchMedia("(prefers-reduced-motion:reduce)").matches?"smooth":"auto"});
}
function myStats(){
  const ids=Object.keys(me.preds).filter(id=>BY[id]&&me.preds[id].v);
  const yes=ids.filter(id=>me.preds[id].v==="y").length;
  const cms=Object.values(me.cm).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0);
  let agreeSum=0,agreeN=0;
  ids.forEach(id=>{const a=agg[id],t=a.y+a.n;if(t>1){const same=me.preds[id].v==="y"?a.y:a.n;agreeSum+=(same-1)/(t-1);agreeN++}});
  return {ids,yes,cms,agree:agreeN?Math.round(agreeSum/agreeN*100):null};
}
function renderPage(){
  const s=myStats();
  const sect={}; s.ids.forEach(id=>BY[id].tags.forEach(t=>{sect[t]=sect[t]||{n:0,y:0};sect[t].n++;if(me.preds[id].v==="y")sect[t].y++}));
  const reas={}; s.ids.forEach(id=>(me.preds[id].r||[]).forEach(r=>{if(RN[r])reas[r]=(reas[r]||0)+1}));
  const sects=Object.entries(sect).sort((a,b)=>b[1].n-a[1].n).slice(0,6);
  const reasL=Object.entries(reas).sort((a,b)=>b[1]-a[1]);
  const hist=s.ids.slice().sort((a,b)=>(me.preds[b].t||0)-(me.preds[a].t||0));
  page.innerHTML=`<div class="prof">
    <div class="page-top"><div class="logo">${icon("bolt")}STRYKE</div>${modeHTML()}</div>
    <div class="ph"><div class="av">${esc(initials(myName||"Я"))}</div><div><h2>${esc(myName||"Мой профиль")}</h2><p>${s.ids.length?`${plural(s.ids.length,PR_F)} из ${P.length} проектов`:"Ещё нет прогнозов"}</p></div></div>
    ${backend==="claude"?"":`<div class="namebox"><input id="name-in" maxlength="40" autocomplete="nickname" placeholder="Как подписывать тебя в обсуждениях?" value="${esc(myName)}" aria-label="Имя в обсуждениях"><button class="btn pri" data-act="name-save">Сохранить</button></div>`}
    <div class="stats num">
      <div class="stat"><b>${s.ids.length}</b><span>прогнозов</span></div>
      <div class="stat"><b>${s.ids.length?pct(s.yes,s.ids.length-s.yes)+"%":"—"}</b><span>«стрельнет»</span></div>
      <div class="stat"><b>${s.agree===null?"—":s.agree+"%"}</b><span>согласие</span></div>
      <div class="stat"><b>${s.cms}</b><span>комментариев</span></div>
    </div>
    <p class="muted">Согласие — доля других участников, которые проголосовали так же, как ты. Точность прогнозов появится, когда у проектов будут результаты.</p>
    ${sects.length?`<div class="panel"><h3>По отраслям</h3>${sects.map(([t,o])=>{const y=pct(o.y,o.n-o.y);return `<div class="srow"><b>${esc(t)}</b><span class="num">${o.n} · ${y}% стрельнет</span><div class="bar"><i style="width:${y}%"></i><i style="width:${100-y}%"></i></div></div>`}).join("")}</div>`:""}
    ${reasL.length?`<div class="panel"><h3>Чаще всего опираешься на</h3><div class="rtags">${reasL.map(([k,c])=>`<span class="rtag">${RN[k]} · ${c}</span>`).join("")}</div></div>`:""}
    <div class="panel"><h3>История прогнозов</h3>${hist.length?`<div class="hist">${hist.map(id=>{const p=BY[id],pr=me.preds[id],a=agg[id],same=pr.v==="y"?a.y:a.n;return `<button class="h-it" data-act="goto" data-k="${id}"><img src="${p.img}" alt="" loading="lazy"><div style="min-width:0"><b>${esc(p.name)}</b><small><span class="pill ${pr.v}">${pr.v==="y"?"Стрельнет":"Не стрельнет"}</span> · ${pr.t?ago(pr.t):""}</small></div><div class="h-agree num"><b>${pct(same,a.y+a.n-same)}%</b><br>с тобой</div></button>`}).join("")}</div>`:`<p class="muted">Открой ленту и сделай первый прогноз: стрельнет проект или нет.</p><div class="row" style="justify-content:flex-start;margin-top:10px"><button class="btn pri" data-act="view" data-k="feed">Перейти в ленту</button></div>`}</div>
  </div>`;
}
function renderSide(){
  const s=myStats();
  const hot=P.slice().sort((a,b)=>(agg[b.id].y+agg[b.id].n)-(agg[a.id].y+agg[a.id].n)||b.growth-a.growth).slice(0,6);
  $("#side-r").innerHTML=`<div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0">Моя статистика</h3>${modeHTML()}</div><div class="stats num" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="stat"><b>${s.ids.length}</b><span>прогнозов</span></div><div class="stat"><b>${s.agree===null?"—":s.agree+"%"}</b><span>согласие</span></div></div></div>
    <div class="panel"><h3>Горячее сейчас</h3><div class="hot">${hot.map((p,i)=>{const a=agg[p.id],t=a.y+a.n;return `<button data-act="goto" data-k="${p.id}"><em class="num">${i+1}</em><b>${esc(p.name)}</b><span class="num">${t?pct(a.y,a.n)+"% · "+t:p.m[2][0]}</span></button>`}).join("")}</div>
    <p class="keys"><kbd>↑</kbd> <kbd>↓</kbd> листать · удерживай тег — подсказка</p></div>`;
}
function refreshAll(){
  order.forEach(refreshSlide);
  if(sheet) renderSheet(true);
  renderSide(); if(ui.view==="profile") renderPage();
}

/* ================= SHEETS ================= */
const sheetEl=$("#sheet"), scrim=$("#scrim");
function openSheet(type,pid,extra){
  hideTip();
  sheet=Object.assign({type,pid},extra||{});
  if(type==="why"&&pid&&!draft[pid]) draft[pid]=new Set((me.preds[pid]&&me.preds[pid].r)||[]);
  renderSheet(); sheetEl.hidden=false; scrim.hidden=false;
  sheetEl.style.transform="";
  const f=sheetEl.querySelector(".x"); if(f) f.focus({preventScroll:true});
}
function closeSheet(){
  if(!sheet) return;
  if(sheet.type==="why") delete draft[sheet.pid];
  sheet=null; sheetEl.hidden=true; scrim.hidden=true; sheetEl.innerHTML="";
}
function head(title){ return `<div class="sh-head" data-drag><div class="handle"></div><div class="sh-title"><h4>${title}</h4><button class="x" data-act="sheet-close" aria-label="Закрыть">${icon("i-x")}</button></div></div>`; }
function renderSheet(keep){
  if(!sheet) return;
  const body=sheetEl.querySelector(".sh-body"); const st=body?body.scrollTop:0;
  const ta=sheetEl.querySelector("textarea"); const tv=ta?ta.value:null; const tf=ta&&document.activeElement===ta;
  const p=sheet.pid&&BY[sheet.pid]; let h="";
  if(sheet.type==="details") h=head(`${esc(p.name)} · детали`)+`<div class="sh-body">${detailsBody(p)}</div>`;
  else if(sheet.type==="why") h=head("Почему ты так считаешь?")+`<div class="sh-body">${whyBody(p)}</div>`;
  else if(sheet.type==="disc") h=head(`Обсуждение · ${esc(p.name)}`)+`<div class="sh-body">${discBody(p)}</div>`;
  else if(sheet.type==="filters") h=head("Фильтры")+`<div class="sh-body">${filtersBody()}</div>`;
  sheetEl.innerHTML=h;
  sheetEl.setAttribute("aria-label",sheetEl.querySelector("h4").textContent);
  const nb=sheetEl.querySelector(".sh-body"); if(keep&&nb) nb.scrollTop=st;
  const nt=sheetEl.querySelector("textarea"); if(nt&&tv){ nt.value=tv; if(tf) nt.focus({preventScroll:true}); }
}
function detailsBody(p){
  const tab=sheet.tab||"product"; let pane="";
  if(tab==="product") pane=`<p class="lbl">Что делает</p><p>${esc(p.what)}</p>`;
  else if(tab==="model") pane=`<p class="lbl">Как зарабатывает</p><p>${esc(p.money)}</p>`;
  else if(tab==="metrics") pane=p.facts.map(([k,v])=>`<div class="kv"><span>${esc(k)}</span><b class="num">${esc(v)}</b></div>`).join("");
  else pane=`<div class="note"><p class="lbl">${esc(p.note[0])}</p><p>${esc(p.note[1])}</p></div>`;
  const v=me.preds[p.id]&&me.preds[p.id].v;
  return `<div class="dtabs" role="tablist">${DTABS.map(([k,l])=>`<button class="dtab" role="tab" data-act="dtab" data-k="${k}" aria-selected="${tab===k}">${l}</button>`).join("")}</div>
    <div class="dpane">${pane}</div>
    ${v?"":`<button class="btn pri wide" data-act="sheet-close">Сделать прогноз</button>`}`;
}
function whyBody(p){
  const mine=me.preds[p.id];
  if(!mine) return `<p class="muted">Сначала сделай прогноз: стрельнет проект или нет.</p>
    <div class="votes"><button class="vbtn yes" data-act="vote" data-k="y" data-pid="${p.id}">Стрельнет</button><button class="vbtn no" data-act="vote" data-k="n" data-pid="${p.id}">Не стрельнет</button></div>`;
  const sel=draft[p.id]||(draft[p.id]=new Set(mine.r||[]));
  return `<div class="saved-msg${mine.v==="n"?" no":""}">Прогноз сохранён: ${mine.v==="y"?"СТРЕЛЬНЕТ":"НЕ СТРЕЛЬНЕТ"}. Теперь можно указать, почему.</div>
    <p class="muted">${esc(p.name)} · выбери одну или несколько причин.</p>
    <div class="rlist">${REASONS.map(([k,l])=>`<button class="rbtn" data-act="reason" data-k="${k}" aria-pressed="${sel.has(k)}">${l}<i></i></button>`).join("")}</div>
    <label class="muted" for="why-ta">Комментарий для обсуждения (необязательно)</label>
    <textarea id="why-ta" maxlength="1000" placeholder="Например: сильная команда, но рынок маленький"></textarea>
    <div class="row"><button class="btn ghost" data-act="sheet-close">Пропустить</button><button class="btn pri" data-act="why-done">Готово</button></div>`;
}
function discBody(p){
  const a=agg[p.id], n=a.c.length;
  const top=o=>Object.entries(o).sort((x,y)=>y[1]-x[1]).slice(0,3);
  const ty=top(a.ry), tn=top(a.rn);
  let h="";
  if(ty.length||tn.length){
    const col=(t,arr,cnt)=>`<div><h6>${t}</h6>${arr.length?`<ol>${arr.map(([k,c])=>`<li>${RN[k]}<span class="num">${pct(c,cnt-c)}%</span></li>`).join("")}</ol>`:`<p class="muted">Пока без причин</p>`}</div>`;
    h+=`<div><p class="lbl">Почему так думает сообщество</p><div class="crowd">${col("Стрельнет",ty,a.y)}${col("Не стрельнет",tn,a.n)}</div></div>`;
  }
  h+=`<p class="lbl" style="margin:0">${n?plural(n,CM_F):"Комментариев пока нет"}</p><div class="comments">`;
  if(!n) h+=`<p class="muted">Сделай прогноз и объясни, почему так считаешь. Твой комментарий будет первым.</p>`;
  a.c.slice(0,80).forEach(c=>{
    const own=c.uid===(uid||"me");
    h+=`<div class="cm"><div class="av">${esc(initials(nameOf(c.uid)))}</div><div style="min-width:0">
      <div class="cm-h"><b>${esc(nameOf(c.uid))}</b>${c.v?`<span class="pill ${c.v}">${c.v==="y"?"Стрельнет":"Не стрельнет"}</span>`:""}<time>${ago(c.t)}</time></div>
      <p>${esc(c.text)}</p>${own?`<button class="del" data-act="cdel" data-k="${esc(c.id)}">Удалить</button>`:""}</div></div>`;
  });
  h+=`</div><div class="cform"><textarea id="cm-ta" maxlength="1000" rows="1" placeholder="Напиши комментарий…" aria-label="Комментарий"></textarea><button class="btn pri" data-act="csend">Отпр.</button></div>`;
  return h;
}
function filtersBody(){
  const n=filtered(sheet.sector,sheet.stage).length;
  return `<p class="muted">Удерживай тег, чтобы узнать, что он значит.</p>
    <div><p class="lbl">Отрасль</p><div class="fgroup">${SECTORS.map(s=>`<button class="chip" data-act="f-sector" data-k="${esc(s)}" ${s!=="all"?`data-tip="${esc(s)}"`:""} aria-pressed="${sheet.sector===s}">${s==="all"?"Все":esc(s)}</button>`).join("")}</div></div>
    <div><p class="lbl">Стадия</p><div class="fgroup">${STAGES.map(s=>`<button class="chip" data-act="f-stage" data-k="${s}" ${s!=="all"?`data-tip="${s}"`:""} aria-pressed="${sheet.stage===s}">${s==="all"?"Любая":s}</button>`).join("")}</div></div>
    <div class="row"><button class="btn ghost" data-act="f-reset">Сбросить</button><button class="btn pri" data-act="f-apply" ${n?"":"disabled"}>${n?"Показать "+plural(n,PJ_F):"Нет проектов"}</button></div>`;
}

/* свайп вниз по шапке шторки — закрыть */
(()=>{let y0=null,dy=0;
  sheetEl.addEventListener("pointerdown",e=>{ if(!e.target.closest("[data-drag]")||e.target.closest("button")) return; y0=e.clientY; dy=0; sheetEl.classList.add("dragging"); sheetEl.setPointerCapture(e.pointerId); });
  sheetEl.addEventListener("pointermove",e=>{ if(y0===null) return; dy=Math.max(0,e.clientY-y0); sheetEl.style.transform=`translateY(${dy}px)`; });
  const end=()=>{ if(y0===null) return; y0=null; sheetEl.classList.remove("dragging");
    if(dy>90){ closeSheet(); } else { sheetEl.classList.add("closing"); sheetEl.style.transform=""; setTimeout(()=>sheetEl.classList.remove("closing"),200); } };
  sheetEl.addEventListener("pointerup",end); sheetEl.addEventListener("pointercancel",end);
})();

/* ================= ПОДСКАЗКИ ПО ДОЛГОМУ НАЖАТИЮ ================= */
const tip=$("#tip"); let tipT=null, lpT=null, lpEl=null, lpFired=false, lpX=0, lpY=0, tipFor=null;
function showTip(el){
  const t=TERMS[el.dataset.tip]; if(!t) return;
  tip.innerHTML=`<b>${esc(t[0])}</b><p>${esc(t[1])}</p>`;
  tip.hidden=false; tip.classList.remove("above"); tipFor=el;
  const r=el.getBoundingClientRect(), w=tip.offsetWidth, h=tip.offsetHeight, vw=innerWidth, vh=innerHeight;
  const left=Math.max(16,Math.min(vw-16-w, r.left+r.width/2-w/2));
  let top=r.bottom+10;
  if(top+h>vh-12){ top=r.top-h-10; tip.classList.add("above"); }
  tip.style.left=left+"px"; tip.style.top=Math.max(8,top)+"px";
  tip.style.setProperty("--ax",Math.max(16,Math.min(w-16,r.left+r.width/2-left))+"px");
  clearTimeout(tipT); tipT=setTimeout(hideTip,4500);
  if(navigator.vibrate) try{navigator.vibrate(8)}catch(e){}
}
function hideTip(){ tip.hidden=true; tipFor=null; clearTimeout(tipT); }
function cancelLP(){ clearTimeout(lpT); lpT=null; if(lpEl) lpEl.classList.remove("pressing"); lpEl=null; }
document.addEventListener("pointerdown",e=>{
  const el=e.target.closest("[data-tip]");
  if(!tip.hidden&&el!==tipFor) hideTip();
  if(!el||(e.pointerType==="mouse"&&e.button!==0)) return;
  lpEl=el; lpFired=false; lpX=e.clientX; lpY=e.clientY; el.classList.add("pressing");
  lpT=setTimeout(()=>{ lpFired=true; if(lpEl) lpEl.classList.remove("pressing"); showTip(el); },420);
},{passive:true});
document.addEventListener("pointermove",e=>{ if(lpT&&Math.hypot(e.clientX-lpX,e.clientY-lpY)>10) cancelLP(); },{passive:true});
document.addEventListener("pointerup",cancelLP,{passive:true});
document.addEventListener("pointercancel",cancelLP,{passive:true});
document.addEventListener("contextmenu",e=>{ if(e.target.closest("[data-tip]")) e.preventDefault(); });
document.addEventListener("click",e=>{ if(lpFired){ lpFired=false; if(e.target.closest("[data-tip]")){ e.preventDefault(); e.stopPropagation(); } } },true);
reel.addEventListener("scroll",()=>{ if(!tip.hidden) hideTip(); cancelLP(); const c=$(".coach"); if(c&&reel.scrollTop>40) dismissCoach(); },{passive:true});

/* ================= ПЕРВЫЙ ЗАПУСК ================= */
function maybeCoach(){
  if(LS.get("coach",false)||ui.view!=="feed"||!order.length) return;
  const s=reel.querySelector(".slide .media"); if(!s) return;
  const c=document.createElement("div"); c.className="coach";
  c.innerHTML=`<div class="swipe">${icon("i-up")}</div><p><b>Листай вверх</b>, чтобы перейти к следующему проекту.</p><p>Удерживай тег вроде <b>MVP</b> или <b>Pre-seed</b> — появится объяснение.</p><button class="btn pri wide" data-act="coach-ok">Понятно</button>`;
  s.appendChild(c);
}
function dismissCoach(){ LS.set("coach",true); const c=$(".coach"); if(c) c.remove(); }

/* ================= ACTIONS ================= */
function vote(pid,k){
  const cur0=me.preds[pid];
  if(cur0&&cur0.v===k){ openSheet("why",pid); return; }
  me.preds[pid]={v:k,r:[],t:Date.now()}; delete draft[pid];
  persist({t:"pred",pid}); refreshSlide(pid); renderSide();
  setTimeout(()=>openSheet("why",pid),cur0?0:280);
}
document.addEventListener("click", e=>{
  const b=e.target.closest("[data-act]"); if(!b) return;
  const act=b.dataset.act, k=b.dataset.k;
  const slide=b.closest(".slide"); const pid=(slide&&slide.dataset.pid)||b.dataset.pid||(sheet&&sheet.pid);
  switch(act){
    case "view": closeSheet(); ui.view=k; LS.set("ui",ui); renderView(); break;
    case "feed": ui.feed=k; ui.view="feed"; LS.set("ui",ui); renderView(); break;
    case "prev": goTo(cur-1); break;
    case "next": goTo(cur+1); break;
    case "details": openSheet("details",pid,{tab:"product"}); break;
    case "dtab": sheet.tab=k; renderSheet(); break;
    case "disc": openSheet("disc",pid); break;
    case "why": openSheet("why",pid); break;
    case "filters": openSheet("filters",null,{sector:ui.sector,stage:ui.stage}); break;
    case "f-sector": sheet.sector=k; renderSheet(true); break;
    case "f-stage": sheet.stage=k; renderSheet(true); break;
    case "f-reset": sheet.sector="all"; sheet.stage="all"; renderSheet(true); break;
    case "f-apply": ui.sector=sheet.sector; ui.stage=sheet.stage; LS.set("ui",ui); closeSheet(); renderView(); break;
    case "reset-filters": ui.sector="all"; ui.stage="all"; LS.set("ui",ui); renderView(); break;
    case "sheet-close": closeSheet(); break;
    case "coach-ok": dismissCoach(); break;
    case "name-save": {
      const inp=$("#name-in"); const v=inp?inp.value.trim().slice(0,40):"";
      myName=v; LS.set("name",v);
      if(mode==="live"&&backend==="supabase") SB.write({t:"name",name:v});
      toast(v?"Имя сохранено":"Имя убрано"); renderPage(); break;
    }
    case "save":
      saved.has(pid)?saved.delete(pid):saved.add(pid); LS.set("saved",[...saved]);
      toast(saved.has(pid)?"Сохранено":"Убрано из сохранённого");
      refreshSlide(pid); if(ui.view==="saved") renderChrome(); break;
    case "vote": if(sheet&&sheet.type==="why"){ const p0=pid; closeSheet(); vote(p0,k); } else vote(pid,k); break;
    case "reason": { const s=draft[pid]||(draft[pid]=new Set()); s.has(k)?s.delete(k):s.add(k); b.setAttribute("aria-pressed",s.has(k)); break; }
    case "why-done": {
      const pr=me.preds[pid]; if(!pr) break;
      pr.r=[...(draft[pid]||[])]; const ta=$("#why-ta"); const txt=ta?ta.value.trim():"";
      persist({t:"pred",pid});
      if(txt) persist({t:"cadd",pid,c:addComment(pid,txt)});
      closeSheet(); refreshSlide(pid); renderSide();
      toast(txt?"Причины и комментарий сохранены":"Причины сохранены"); break;
    }
    case "csend": {
      const ta=$("#cm-ta"); const txt=ta?ta.value.trim():""; if(!txt){ta&&ta.focus();break}
      ta.value=""; persist({t:"cadd",pid,c:addComment(pid,txt)}); renderSheet(); refreshSlide(pid);
      const body=sheetEl.querySelector(".sh-body"); if(body) body.scrollTop=0; break;
    }
    case "cdel": {
      const arr=me.cm[pid]||[]; me.cm[pid]=arr.filter(c=>c.id!==k); if(!me.cm[pid].length) delete me.cm[pid];
      persist({t:"cdel",id:k}); renderSheet(true); refreshSlide(pid); break;
    }
    case "goto": {
      closeSheet();
      ui.view="feed"; LS.set("ui",ui);
      if(!filtered().some(p=>p.id===k)){ ui.sector="all"; ui.stage="all"; }
      renderView(k); break;
    }
  }
});
function uuid(){
  if(window.crypto&&crypto.randomUUID) return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16)); b[6]=b[6]&15|64; b[8]=b[8]&63|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function addComment(pid,text){
  const arr=me.cm[pid]||(me.cm[pid]=[]);
  const c={id:uuid(),text:text.slice(0,1000),t:Date.now()};
  arr.push(c); return c;
}

/* клавиатура и колесо мыши: ровно один проект за жест */
document.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&e.target.id==="name-in"){ e.preventDefault(); const b=$('[data-act="name-save"]'); if(b) b.click(); return; }
  if(e.key==="Escape"){ if(!tip.hidden) hideTip(); else closeSheet(); return; }
  if((e.key==="Enter"||e.key===" ")&&e.target.matches&&e.target.matches("span[data-tip],div[data-tip]")){ e.preventDefault(); tip.hidden||tipFor!==e.target?showTip(e.target):hideTip(); return; }
  if(sheet||ui.view==="profile"||/^(TEXTAREA|INPUT)$/.test(document.activeElement&&document.activeElement.tagName)) return;
  if(["ArrowDown","PageDown","j"].includes(e.key)){ e.preventDefault(); goTo(cur+1); }
  else if(["ArrowUp","PageUp","k"].includes(e.key)){ e.preventDefault(); goTo(cur-1); }
});
let wheelLock=0;
reel.addEventListener("wheel",e=>{
  if(Math.abs(e.deltaY)<Math.abs(e.deltaX)) return;
  e.preventDefault();
  const now=Date.now(); if(now<wheelLock||Math.abs(e.deltaY)<8) return;
  wheelLock=now+650; goTo(cur+(e.deltaY>0?1:-1));
},{passive:false});
addEventListener("resize",()=>{ if(ui.view!=="profile") reel.scrollTop=cur*reel.clientHeight; hideTip(); });

/* ================= SUPABASE: общая база на любом хостинге ================= */
const SB = (() => {
  let sb=null, q=Promise.resolve(), redrawT=null;
  const cfg=window.STRYKE_CONFIG||{};
  const isUuid=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  function redraw(){ clearTimeout(redrawT); redrawT=setTimeout(()=>{ recompute(); refreshAll(); },120); }
  function bucket(id){ let d=people.get(id); if(!d){ d={preds:{},cm:{}}; people.set(id,d); } return d; }
  function predRow(pid){ const pr=me.preds[pid]; return {user_id:uid,project_id:pid,vote:pr.v,reasons:(pr.r||[]).filter(r=>RN[r]),updated_at:new Date(pr.t||Date.now()).toISOString()}; }
  async function fetchAll(table,cols,orderBy){
    const out=[];
    for(let from=0;from<50000;from+=1000){
      let qq=sb.from(table).select(cols); if(orderBy) qq=qq.order(orderBy,{ascending:false});
      const {data,error}=await qq.range(from,from+999); if(error) throw error;
      out.push(...data); if(data.length<1000) break;
    }
    return out;
  }
  function fail(e){ try{ console.warn("Supabase:",e&&e.message||e); }catch(_){} }
  /* записи идут строго по очереди, чтобы не перепутать порядок */
  function write(op){
    q=q.then(async()=>{
      let r=null;
      if(op.t==="pred"){ if(!me.preds[op.pid]) return; r=await sb.from("predictions").upsert(predRow(op.pid)); }
      else if(op.t==="cadd") r=await sb.from("comments").insert({id:op.c.id,user_id:uid,project_id:op.pid,text:op.c.text});
      else if(op.t==="cdel") r=await sb.from("comments").delete().eq("id",op.id);
      else if(op.t==="name") r=await sb.from("profiles").upsert({id:uid,name:op.name||null});
      if(r&&r.error){ fail(r.error); toast("Не удалось сохранить на сервере"); }
    }).catch(e=>{ fail(e); toast("Нет связи с сервером"); });
  }
  async function loadNames(ids){
    ids=[...new Set(ids)].filter(id=>id&&id!==uid&&!(id in names)); if(!ids.length) return;
    ids.forEach(id=>names[id]="Участник");
    for(let i=0;i<ids.length;i+=200){
      const {data}=await sb.from("profiles").select("id,name").in("id",ids.slice(i,i+200));
      (data||[]).forEach(p=>{ if(p.name) names[p.id]=p.name; });
    }
    if(sheet&&sheet.type==="disc") renderSheet(true);
  }
  async function start(){
    if(!window.supabase||!cfg.url||!cfg.anonKey) return;   // нет настроек — работаем локально
    try{
      sb=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true}});
      let {data:{session}}=await sb.auth.getSession();
      if(!session){ const r=await sb.auth.signInAnonymously(); if(r.error) throw r.error; session=r.data.session; }
      uid=session.user.id;
      const [preds,cms,prof]=await Promise.all([
        fetchAll("predictions","user_id,project_id,vote,reasons,updated_at"),
        fetchAll("comments","id,user_id,project_id,text,created_at","created_at"),
        sb.from("profiles").select("name").eq("id",uid).maybeSingle()
      ]);
      const remote={preds:{},cm:{}};
      people.clear();
      preds.forEach(r=>{ const d=r.user_id===uid?remote:bucket(r.user_id); d.preds[r.project_id]={v:r.vote,r:r.reasons||[],t:Date.parse(r.updated_at)||0}; });
      cms.forEach(r=>{ const d=r.user_id===uid?remote:bucket(r.user_id); (d.cm[r.project_id]||(d.cm[r.project_id]=[])).push({id:r.id,text:r.text,t:Date.parse(r.created_at)||0}); });
      /* один раз переносим в базу то, что человек успел сделать до её подключения.
         Потом не переносим: иначе удалённые админом комментарии вернулись бы из памяти браузера */
      const migrate=!LS.get("migrated",false);
      const local=migrate?me:{preds:{},cm:{}}, ops=[];
      for(const pid in local.preds){
        const lp=local.preds[pid], rp=remote.preds[pid];
        if(BY[pid]&&lp&&lp.v&&(!rp||(lp.t||0)>(rp.t||0))){ remote.preds[pid]=lp; ops.push({t:"pred",pid}); }
      }
      const known=new Set(Object.values(remote.cm).flat().map(c=>c.id));
      for(const pid in local.cm){
        if(!BY[pid]) continue;
        (local.cm[pid]||[]).forEach(c=>{ if(!c||known.has(c.id)) return;
          const nc={id:isUuid(c.id)?c.id:uuid(),text:String(c.text).slice(0,1000),t:c.t||Date.now()};
          (remote.cm[pid]||(remote.cm[pid]=[])).push(nc); ops.push({t:"cadd",pid,c:nc}); });
      }
      const remoteName=(prof.data&&prof.data.name)||"";
      if(migrate&&!remoteName&&myName) ops.push({t:"name",name:myName}); else myName=remoteName;
      me=remote; mode="live"; backend="supabase";
      ops.forEach(write); LS.set("migrated",true);
      LS.set("me",me); LS.set("name",myName);
      recompute(); refreshAll();
      loadNames([...people.keys()]);
      sb.channel("stryke-live")
        .on("postgres_changes",{event:"*",schema:"public",table:"predictions"},({eventType,new:n,old:o})=>{
          const row=eventType==="DELETE"?o:n; if(!row||!row.user_id||row.user_id===uid) return;
          const d=bucket(row.user_id);
          if(eventType==="DELETE") delete d.preds[row.project_id];
          else d.preds[row.project_id]={v:row.vote,r:row.reasons||[],t:Date.parse(row.updated_at)||Date.now()};
          loadNames([row.user_id]); redraw();
        })
        .on("postgres_changes",{event:"*",schema:"public",table:"comments"},({eventType,new:n,old:o})=>{
          if(eventType==="DELETE"){ if(!o||!o.id) return; for(const d of people.values()) for(const pid in d.cm) d.cm[pid]=d.cm[pid].filter(c=>c.id!==o.id); redraw(); return; }
          if(!n||n.user_id===uid) return;
          const d=bucket(n.user_id), arr=d.cm[n.project_id]||(d.cm[n.project_id]=[]);
          if(!arr.some(c=>c.id===n.id)) arr.push({id:n.id,text:n.text,t:Date.parse(n.created_at)||Date.now()});
          loadNames([n.user_id]); redraw();
        })
        .subscribe();
    }catch(e){
      fail(e); sb=null; mode="local"; backend=null; renderSide(); if(ui.view==="profile") renderPage();
      const m=String(e&&e.message||"");
      toast(/anonymous/i.test(m)?"Вход не настроен: включи Anonymous sign-ins в Supabase":"Сервер недоступен — прогнозы сохраняются на этом устройстве");
    }
  }
  return {start,write};
})();

/* ================= BOOT ================= */
recompute(); renderView();

async function resolveNames(){
  if(!userCap||!userCap.profiles) return;
  const ids=[...people.keys()].filter(id=>!(id in names));
  if(!ids.length) return;
  try{ const ps=await userCap.profiles(ids);
    ids.forEach(id=>{const n=ps&&ps[id]&&ps[id].name; names[id]=n||"Участник"});
    if(sheet&&sheet.type==="disc") renderSheet(true);
  }catch(e){}
}
function mergeMe(a,b){ const m=normMe(clone(a)); for(const k in b.preds){ if(!m.preds[k]||(b.preds[k].t||0)>(m.preds[k].t||0)) m.preds[k]=b.preds[k]; } for(const k in b.cm){ const ids=new Set((m.cm[k]||[]).map(c=>c.id)); m.cm[k]=(m.cm[k]||[]).concat(b.cm[k].filter(c=>!ids.has(c.id))); } return m; }

/* Общая база доступна только внутри claude.ai. На обычном хостинге window.claude нет — сайт работает локально. */
(async()=>{
  if(!window.claude||!window.claude.use){ SB.start(); return; }
  let db=null;
  try{ [db,userCap]=await Promise.all([window.claude.use("db"),window.claude.use("user")]); }catch(e){}
  if(!db||!userCap) return;
  try{ uid=await userCap.id(); }catch(e){}
  if(!uid) return;
  try{ const p=await userCap.me(); myName=(p&&p.name)||""; }catch(e){}
  ref=db.doc("people/"+uid);
  let canWrite=null; try{ canWrite=await userCap.can("data.write"); }catch(e){}
  const local=me; let first=true;
  db.collection("people").onSnapshot(snap=>{
    people.clear();
    snap.docs.forEach(d=>{ if(!d.exists) return;
      if(d.id===uid){ if(first&&canWrite!==false){ const remote=normMe(d.data()); me=Object.keys(local.preds).length||Object.keys(local.cm).length?mergeMe(remote,local):remote; } return; }
      people.set(d.id,d.data()) });
    if(first){
      first=false;
      if(canWrite===false) setMode("mine-local");
      else { mode="live"; backend="claude"; if(Object.keys(me.preds).length||Object.keys(me.cm).length) flush(); }
    }
    recompute(); refreshAll(); resolveNames();
  }, ()=>{ mode="local"; renderSide(); });
})();
})();
