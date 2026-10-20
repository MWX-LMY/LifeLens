// ═══════════════════════════════════════════════════════════════════
// LifeLens Renderer
// ═══════════════════════════════════════════════════════════════════

// ─── State ─────────────────────────────────────────────────────
const S = {
  running:true, processing:false, shots:0, analyzed:0, queue:0,
  summaries:[], summarizing:[], diaries:{},
  filterProject:'', filterSoftware:'', filterCategory:'', selectedBlock:null,
  kbMode:'year',
};
const CAT_CLASS = {'工作':'work','娱乐':'entertain','学习':'study','社交':'social'};
const CAT_COLORS = {'工作':'#00E5FF','娱乐':'#64c8ff','学习':'#ffc832','社交':'#ff6496'};
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════
// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $(`tab-${tab}`).classList.add('active');
    if (tab === 'activity') window.lifelens.requestSummaries();
    if (tab === 'diary') initDiaryTab();
    if (tab === 'kanban') refreshKanban();
  };
});

// Window controls
$('winMinimize').onclick = () => window.lifelens.winMinimize();
$('winMaximize').onclick = () => window.lifelens.winMaximize();
$('winClose').onclick = () => window.lifelens.winClose();

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════
const list = $('tlList');

function updateUI(state) {
  S.running=state.running; S.processing=state.processing;
  S.shots=state.shotCount||0; S.analyzed=state.analyzedCount||0; S.queue=state.queueLength||0;
  const ring=$('statusRing'),dot=$('statusDot'),label=$('statusLabel');
  ring.className='status-ring'; dot.className='status-dot-inner';
  if(state.qaInProgress){ring.classList.add('on');dot.classList.add('on');label.textContent='💬 问答中';}
  else if(!S.running){ring.classList.add('off');dot.classList.add('off');label.textContent='○ 已暂停';}
  else if(S.processing){ring.classList.add('on');dot.classList.add('on');label.textContent='◉ 分析中';}
  else{ring.classList.add('on');dot.classList.add('on');label.textContent='● 运行中';}
  const btn=$('btnToggle');
  if(S.running){btn.className='btn btn-stop';btn.textContent='■ 停止捕获';}
  else{btn.className='btn btn-start';btn.textContent='▶ 开始捕获';}
  $('queueNum').textContent=S.queue;
  $('queueNum').className='queue-num'+(S.queue>0?' has-queue':'');
  $('queueSub').textContent=S.queue>0?'待分析':'空闲';
  ['mShots','mAnalyzed','mQueue'].forEach(id=>{
    const el=$(id); if(!el) return;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  });
  $('mShots').textContent=S.shots; $('mAnalyzed').textContent=S.analyzed; $('mQueue').textContent=S.queue;
  $('cardShots')?.classList.add('active');
  $('cardAnalyzed')?.classList.add('active');
  $('cardQueue')?.classList.toggle('active',S.queue>0);
}

function addDashEntry(data){
  const{timestamp,activity,error,screenshotTaken}=data;
  const emp=list.querySelector('.empty'); if(emp)emp.remove();
  const t=guessTag(activity);
  const el=document.createElement('div'); el.className='entry entry-fresh';
  const top=document.createElement('div'); top.className='entry-top';
  const d=document.createElement('span'); d.className=`entry-dot ${error?'err':'ok'}`; top.appendChild(d);
  const te=document.createElement('span'); te.className='entry-time'; te.textContent=fmtFull(timestamp); top.appendChild(te);
  const tg=document.createElement('span'); tg.className=`entry-tag t-${t}`; tg.textContent=TAG_LABELS[t]||'💼 工作'; top.appendChild(tg);
  el.appendChild(top);
  const body=document.createElement('div'); body.className='entry-body';
  if(!screenshotTaken) body.textContent='⚠️ 截图失败';
  else if(!activity||activity.includes('分析失败')) body.textContent=activity||'（分析失败）';
  else{const lines=activity.split(/[。！\n]/).map(l=>l.trim()).filter(l=>l.length>0);body.textContent=lines.join('。')+'。';}
  el.appendChild(body);
  if(body.textContent.length>120){
    const xp=document.createElement('span'); xp.className='entry-expand show'; xp.textContent='展开';
    xp.onclick=()=>{body.classList.toggle('open');xp.textContent=body.classList.contains('open')?'收起':'展开';el.scrollIntoView({block:'nearest'});};
    el.appendChild(xp);
  }
  if(error){const er=document.createElement('div');er.className='entry-err';er.textContent=`⚠ ${error}`;el.appendChild(er);}
  list.appendChild(el);
  const al=list.querySelectorAll('.entry-fresh');
  if(al.length>1) al[al.length-2].classList.remove('entry-fresh');
  while(list.children.length>300)list.removeChild(list.firstChild);
  list.scrollTop=list.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ═══════════════════════════════════════════════════════════════════
function renderHeatmap(){
  const grid=$('hmGrid'); grid.innerHTML='';
  if(!S.summaries.length){grid.innerHTML='<div class="hm-empty">暂无汇总数据</div>';return;}
  const items=S.summaries.slice(-60);
  const maxE=Math.max(...items.map(s=>s.entry_count),1);
  items.forEach(s=>{
    const c=document.createElement('div');
    const alpha=0.1+(s.entry_count/maxE)*0.7;
    const ccat=CAT_COLORS[s.category]||'var(--cyan)';
    c.className='hm-cell'+(S.selectedBlock===s.block_key?' selected':'');
    c.style.background=s.category?`${ccat}${Math.round(alpha*255).toString(16).padStart(2,'0')}`:'var(--heat-0)';
    c.dataset.key=s.block_key;
    const tt=document.createElement('div'); tt.className='tooltip'; tt.textContent=`${s.block_label}|${s.project_name}`; c.appendChild(tt);
    c.onclick=()=>{
      document.querySelectorAll('.hm-cell').forEach(x=>x.classList.remove('selected'));
      c.classList.add('selected'); S.selectedBlock=s.block_key;
      $('hmSelectedInfo').textContent=`📌 ${s.block_label} — ${s.project_name} (${s.category})`;
      const tgt=document.querySelector(`[data-summary-key="${s.block_key}"]`);
      if(tgt) tgt.scrollIntoView({behavior:'smooth',block:'center'});
    };
    grid.appendChild(c);
  });
}
function getFilteredSummaries(){
  return S.summaries.filter(s=>{
    if(S.filterProject&&!s.project_name.toLowerCase().includes(S.filterProject.toLowerCase())) return false;
    if(S.filterSoftware&&!s.software.some(sw=>sw.toLowerCase().includes(S.filterSoftware.toLowerCase()))) return false;
    if(S.filterCategory&&s.category!==S.filterCategory) return false;
    return true;
  });
}
function renderTimeline(){
  const lst=$('actList'); const filtered=getFilteredSummaries();
  $('summaryCount').textContent=`${filtered.length}条汇总`;
  lst.innerHTML='';
  if(!filtered.length){lst.innerHTML=`<div class="empty" style="padding:40px"><span class="icon">📭</span><span class="txt">${S.summaries.length===0?'等待首次汇总...':'无匹配结果'}</span></div>`;return;}
  [...filtered].reverse().forEach(s=>{
    const card=document.createElement('div'); card.className='summary-card'; card.dataset.summaryKey=s.block_key;
    if(S.selectedBlock===s.block_key) card.style.borderColor='var(--cyan)';
    const top=document.createElement('div'); top.className='sc-top';
    const t=document.createElement('span'); t.className='sc-time'; t.textContent=s.block_label; top.appendChild(t);
    const ct=document.createElement('span'); ct.className=`sc-category-tag sc-cat-${CAT_CLASS[s.category]||'work'}`; ct.textContent=s.category||'工作'; top.appendChild(ct);
    card.appendChild(top);
    const pj=document.createElement('div'); pj.className='sc-project'; pj.textContent=s.project_name||'未知'; card.appendChild(pj);
    if(s.description){
      const d=document.createElement('div'); d.className='sc-desc'; d.textContent=s.description; card.appendChild(d);
      if(s.description.length>200){const x=document.createElement('span');x.className='sc-expand';x.textContent='展开';x.onclick=()=>{d.classList.toggle('open');x.textContent=d.classList.contains('open')?'收起':'展开';};card.appendChild(x);}
    }
    if(s.software&&s.software.length){
      const sw=document.createElement('div'); sw.className='sc-software';
      s.software.forEach(sf=>{const tg=document.createElement('span');tg.className='sc-soft-tag';tg.textContent=sf;sw.appendChild(tg);});
      card.appendChild(sw);
    }
    if(s.todos){const td=document.createElement('div');td.className='sc-todos show';td.textContent=`📌 ${s.todos}`;card.appendChild(td);}
    lst.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════════
// DIARY TAB - All diaries as card grid
// ═══════════════════════════════════════════════════════════════════
function initDiaryTab(){
  try {
    const tabEl=document.getElementById('tab-diary');
    if(tabEl) {
      tabEl.style.setProperty('flex','0 0 auto','important');
      tabEl.style.setProperty('height',(window.innerHeight-80)+'px','important');
    }
    // Init week filter: 'all' by default
    S.diaryWeek = S.diaryWeek || 'all';
    renderAllDiaries();
    window.lifelens.requestAllDiaries();
    setTimeout(()=>{window.lifelens.requestSummaries();},100);
  } catch(e){console.error('initDiaryTab:',e);}
}

function getWeekLabel(d){
  const start=new Date(d); const day=start.getDay(); start.setDate(start.getDate()-(day===0?6:day-1));
  const end=new Date(start); end.setDate(end.getDate()+6);
  const fmt=(x)=>`${x.getMonth()+1}/${x.getDate()}`;
  return `${fmt(start)}-${fmt(end)}`;
}

function getWeekOptions(){
  const weeks=new Set();
  Object.keys(S.diaries).forEach(dateStr=>{
    const d=new Date(dateStr);
    const weekStart=new Date(d); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
    weeks.add(weekStart.toISOString().slice(0,10));
  });
  return Array.from(weeks).sort().reverse().map(ws=>({value:ws,label:getWeekLabel(ws)}));
}

function renderAllDiaries(){
  const ct=$('diaryContent');
  if(!ct) return;

  // Build week selector HTML (always show "all" button)
  const weekOpts=getWeekOptions();
  let weekHtml=`<div style="display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0;">
    <button class="week-btn ${S.diaryWeek==='all'?'active':''}" data-week="all">📅 全部</button>
    ${weekOpts.map(w=>`<button class="week-btn ${S.diaryWeek===w.value?'active':''}" data-week="${w.value}">${w.label}</button>`).join('')}
    ${weekOpts.length===0?'<span style="font-size:9px;color:var(--text-muted);padding:3px 0;">暂无周数据</span>':''}
  </div>`;

  // Filter by selected week
  let entries=Object.entries(S.diaries);
  if(S.diaryWeek!=='all'){
    const wkStart=new Date(S.diaryWeek).getTime();
    const wkEnd=wkStart+7*86400000;
    entries=entries.filter(([d])=>{
      const t=new Date(d).getTime();
      return t>=wkStart && t<wkEnd;
    });
  }

  if(!entries.length){
    const isEmpty=Object.keys(S.diaries).length===0;
    ct.innerHTML=`${weekHtml}<div class="empty" style="min-height:200px;padding:40px;"><span class="icon">📖</span><span class="txt">${isEmpty?'暂无日记':'该周暂无日记'}</span></div>`;
    $('diaryCount').textContent=isEmpty?'0 篇':`${Object.keys(S.diaries).length} 篇`;
    return;
  }

  entries.sort((a,b)=>b[0].localeCompare(a[0]));
  $('diaryCount').textContent=`${entries.length} 篇`;

  // Bind week button clicks
  setTimeout(()=>{
    document.querySelectorAll('.week-btn').forEach(btn=>{
      btn.onclick=()=>{
        S.diaryWeek=btn.dataset.week;
        renderAllDiaries();
      };
    });
  },0);

  const nl=(t)=>(t||'').replace(/\n/g,'<br>');
  const sec=(title,items,empty)=>(`
    <div class="dcard-section">
      <div class="dcard-stitle">${title}</div>
      ${(items||[]).length
        ? items.map(i=>`<div class="dcard-item">${nl(escHtml(i))}</div>`).join('')
        : `<div class="dcard-empty">${empty}</div>`
      }
    </div>
  `);

  ct.innerHTML=`
    ${weekHtml}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;align-content:start;margin-top:8px;">
      ${entries.map(([date,diary])=>`
        <div class="diary-card">
          <div class="dcard-top">
            <div class="dcard-date">📖 ${escHtml(date)}</div>
            <div class="dcard-meta">
              <span class="dcard-badge">${diary.summary_count||0} 条</span>
            </div>
          </div>
          <div class="dcard-summary">${nl(escHtml(diary.brief_summary))}</div>
          <div class="dcard-inner">
            ${sec('🏆 主要事项',diary.top_3,'暂无')}
            ${sec('✨ 高光时刻',diary.highlights,'暂无')}
            ${sec('📌 待办事项',diary.todos,'暂无')}
            ${sec('⚡ 优化建议',diary.optimizations,'暂无')}
            ${diary.tips?`
              <div class="dcard-section dcard-tipsec">
                <div class="dcard-stitle">💡 温馨提示</div>
                <div class="dcard-tip">${nl(escHtml(diary.tips))}</div>
              </div>
            `:''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ═══════════════════════════════════════════════════════════════════
// KANBAN TAB
// ═══════════════════════════════════════════════════════════════════
function initKanban(){
  const now=new Date(); const curY=now.getFullYear(); const curM=now.getMonth();

  // Populate selects
  const yearSel=$('kbYear'); yearSel.innerHTML='';
  for(let y=curY; y>=curY-5; y--){
    const o=document.createElement('option'); o.value=y; o.textContent=`${y}年`; if(y===curY) o.selected=true;
    yearSel.appendChild(o);
  }
  const monthSel=$('kbMonth'); monthSel.innerHTML='';
  for(let m=0;m<12;m++){
    const o=document.createElement('option'); o.value=m; o.textContent=`${m+1}月`; if(m===curM) o.selected=true;
    monthSel.appendChild(o);
  }
  S.kbYear=curY; S.kbMonth=curM;

  // Build week options (current year)
  S.kbWeek=1;
  buildWeekOptions();

  // Build day options
  const daySel=$('kbDay'); daySel.innerHTML='';
  const weekDays=['周日','周一','周二','周三','周四','周五','周六'];
  for(let d=0;d<7;d++){
    const o=document.createElement('option'); o.value=d; o.textContent=weekDays[d]; if(d===now.getDay()) o.selected=true;
    daySel.appendChild(o);
  }
  S.kbDay=now.getDay();
  S.kbDate=now; // specific date for day mode

  // Mode switching
  function showSelect(mode){
    ['kbYear','kbMonth','kbWeek','kbDay'].forEach(id=>$(id).style.display='none');
    if(mode==='year') $('kbYear').style.display='';
    else if(mode==='month'){ $('kbYear').style.display=''; $('kbMonth').style.display=''; }
    else if(mode==='week'){ $('kbYear').style.display=''; $('kbWeek').style.display=''; }
    else if(mode==='day'){ $('kbDay').style.display=''; }
  }

  S.kbMode='year'; showSelect('year');

  document.querySelectorAll('[data-kb-mode]').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('[data-kb-mode]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      S.kbMode=btn.dataset.kbMode;
      showSelect(S.kbMode);
      refreshKanban();
    };
  });

  // Select change events
  yearSel.onchange=()=>{ S.kbYear=parseInt(yearSel.value); buildWeekOptions(); refreshKanban(); };
  monthSel.onchange=()=>{ S.kbMonth=parseInt(monthSel.value); refreshKanban(); };
  $('kbWeek').onchange=()=>{ S.kbWeek=parseInt($('kbWeek').value); refreshKanban(); };
  $('kbDay').onchange=()=>{ S.kbDay=parseInt($('kbDay').value); refreshKanban(); };

  refreshKanban();
}

function buildWeekOptions(){
  const sel=$('kbWeek'); sel.innerHTML='';
  const y=S.kbYear||new Date().getFullYear();
  const now=new Date();
  // Find week numbers for the year
  const weeks=[];
  const d=new Date(y,0,1);
  while(d.getFullYear()===y){
    const wn=d.getDay()===0?6:d.getDay()-1; // Mon=0
    const ms=new Date(d); ms.setDate(ms.getDate()-wn);
    const me=new Date(ms); me.setDate(me.getDate()+6);
    if(me.getFullYear()>y) break;
    const label=`${ms.getMonth()+1}/${ms.getDate()}-${me.getMonth()+1}/${me.getDate()}`;
    weeks.push({start:new Date(ms),label});
    d.setDate(d.getDate()+7);
  }
  weeks.forEach((w,i)=>{
    const o=document.createElement('option'); o.value=i+1; o.textContent=w.label;
    // Auto-select current week
    if(now>=w.start && now<=new Date(w.start.getTime()+6*86400000)) o.selected=true;
    sel.appendChild(o);
  });
}

function refreshKanban(){
  const now=new Date(); const y=S.kbYear||now.getFullYear(); const m=S.kbMonth??now.getMonth();
  let start,end,label;

  switch(S.kbMode){
    case 'year':
      start=new Date(y,0,1); end=new Date(y+1,0,1);
      label=`${y}年`;
      break;
    case 'month':
      start=new Date(y,m,1); end=new Date(y,m+1,1);
      label=`${y}年${m+1}月`;
      break;
    case 'week':{
      const weekOpts=$('kbWeek').options;
      const idx=S.kbWeek-1;
      const base=new Date(y,0,1);
      const weekStart=new Date(base); weekStart.setDate(weekStart.getDate()+idx*7);
      const dow=weekStart.getDay(); weekStart.setDate(weekStart.getDate()-(dow===0?6:dow-1));
      start=weekStart;
      end=new Date(start); end.setDate(end.getDate()+7);
      label=`${(start.getMonth()+1)}/${start.getDate()} - ${end.getMonth()+1}/${end.getDate()-1}`;
      break;
    }
    case 'day':{
      const today=new Date();
      const diff=S.kbDay-today.getDay();
      start=new Date(today); start.setDate(start.getDate()+diff);
      start.setHours(0,0,0,0);
      end=new Date(start); end.setDate(end.getDate()+1);
      const days=['日','一','二','三','四','五','六'];
      label=`周${days[S.kbDay]} (${start.getMonth()+1}/${start.getDate()})`;
      break;
    }
  }

  $('kbRangeLabel').textContent=label;
  // Only request stats for the time range (not all data)
  window.lifelens.requestStats({mode:S.kbMode,start:start.toISOString(),end:end.toISOString()});
}

function renderKanbanCharts(stats){
  const container=$('kbCharts');
  if(!stats||!stats.total_blocks){
    container.innerHTML=`<div class="kb-empty" style="grid-column:1/-1;flex-direction:column;"><span class="icon">📊</span><span>暂无数据</span><span style="font-size:11px;color:var(--text-muted);margin-top:4px;">需要约 10 分钟数据才能生成图表 (已捕获 ${S.summaries.length} 条汇总)</span></div>`;
    return;
  }
  container.innerHTML='';

  // 1. Pie: Category distribution
  const pieCard=document.createElement('div'); pieCard.className='kb-chart-card';
  pieCard.innerHTML='<div class="kb-chart-title">🎯 活动类型分布</div><canvas class="kb-chart-canvas" id="chartPie"></canvas>';
  container.appendChild(pieCard);

  // 2. Bar: Software ranking
  const swCard=document.createElement('div'); swCard.className='kb-chart-card';
  swCard.innerHTML='<div class="kb-chart-title">📦 软件使用排名</div><canvas class="kb-chart-canvas" id="chartSW"></canvas>';
  container.appendChild(swCard);

  // 3. Bar: Project ranking (full width)
  const pjCard=document.createElement('div'); pjCard.className='kb-chart-card full';
  pjCard.innerHTML='<div class="kb-chart-title">📋 项目专注时间排名</div><canvas class="kb-chart-canvas" id="chartPJ"></canvas>';
  container.appendChild(pjCard);

  // Draw charts after DOM render
  requestAnimationFrame(()=>{
    drawPieChart('chartPie',stats.category_distribution);
    drawBarChart('chartSW',stats.software_ranking,'#00E5FF');
    drawBarChart('chartPJ',stats.project_ranking,'#a37ef7');
  });
}

function drawPieChart(canvasId,data){
  const c=document.getElementById(canvasId); if(!c)return;
  const ctx=c.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  let w=c.clientWidth, h=c.clientHeight;
  if(!w||!h){w=300;h=200;}
  c.width=w*dpr; c.height=h*dpr;
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,w,h);
  const cx=w*0.45,cy=h/2,radius=Math.min(w*0.4,h*0.4);

  const PIE_COLORS = ['#00E5FF','#FF3366','#FFD700','#7B68EE','#00FF88','#FF6B35','#FF69B4','#00BFFF'];
  const entries=Object.entries(data||{}).filter(([_,v])=>v>0);
  const total=entries.reduce((s,[_,v])=>s+v,0);
  if(!total){ctx.fillStyle='var(--text-dim)';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('无数据',cx,cy);return;}

  // Glow effect
  ctx.shadowColor = 'rgba(0,229,255,0.15)';
  ctx.shadowBlur = 10;

  let startAngle=-Math.PI/2;
  entries.forEach(([label,val],i)=>{
    const slice=(val/total)*Math.PI*2;
    const color=PIE_COLORS[i%PIE_COLORS.length];
    // Gradient fill for each slice
    const grad=ctx.createRadialGradient(cx,cy,0,cx,cy,radius);
    grad.addColorStop(0,color+'cc');
    grad.addColorStop(1,color+'66');
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,radius,startAngle,startAngle+slice); ctx.closePath();
    ctx.fillStyle=grad; ctx.fill();
    // Glow border
    ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1; ctx.stroke();
    const mid=startAngle+slice/2;
    const lx=cx+Math.cos(mid)*radius*0.65;
    const ly=cy+Math.sin(mid)*radius*0.65;
    ctx.shadowBlur = 0;
    ctx.fillStyle=color; ctx.font='bold 11px sans-serif'; ctx.textAlign='center';
    ctx.fillText(`${label} ${Math.round(val/total*100)}%`,lx,ly+4);
    ctx.shadowBlur = 10;
    startAngle+=slice;
  });
  ctx.shadowBlur = 0;
  ctx.fillStyle='var(--text)'; ctx.font='bold 14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(total,cx,cy-6);
  ctx.fillStyle='var(--text-dim)'; ctx.font='9px sans-serif';
  ctx.fillText('时段',cx,cy+10);
}

function drawBarChart(canvasId,dataArr,color){
  const c=document.getElementById(canvasId); if(!c)return;
  const ctx=c.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  let w=c.clientWidth, h=c.clientHeight;
  if(!w||!h){w=300;h=200;} // fallback for hidden elements
  c.width=w*dpr; c.height=h*dpr;
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,w,h);
  if(!dataArr||!dataArr.length){
    ctx.fillStyle='var(--text-dim)';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('无数据',w/2,h/2);
    return;
  }

  const BAR_COLORS = ['#00E5FF','#FF3366','#FFD700','#7B68EE','#00FF88','#FF6B35','#FF69B4','#00BFFF','#FF4500','#32CD32'];
  const items=dataArr.slice(0,10);
  const maxVal=Math.max(...items.map(([_,v])=>v),1);
  const barH=Math.min(24,(h-30)/items.length);
  const left=10;
  const labelW=Math.min(100,w*0.25);
  const right=w-10;

  // Glow behind bars
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = 6;

  items.forEach(([label,val],i)=>{
    const y=i*barH+10;
    const barW=Math.max(2,((val/maxVal)*(right-left-labelW-10)));
    ctx.fillStyle='#000'; ctx.font='bold 10px sans-serif'; ctx.textAlign='right'; ctx.textBaseline='middle';
    const maxLabelLen=Math.floor((labelW-6)/6);
    const displayLabel=label.length>maxLabelLen?label.slice(0,maxLabelLen)+'…':label;
    ctx.fillText(displayLabel,left+labelW-2,y+barH/2);
    const c2=BAR_COLORS[i%BAR_COLORS.length];
    const grad=ctx.createLinearGradient(left+labelW+4,0,left+labelW+4+barW,0);
    grad.addColorStop(0,c2+'88'); grad.addColorStop(0.5,c2+'cc'); grad.addColorStop(1,c2);
    ctx.fillStyle=grad;
    ctx.shadowColor = c2+'44';
    ctx.beginPath(); ctx.roundRect(left+labelW+4,y+2,barW,barH-4,4); ctx.fill();
    // Overlay lighter highlight
    const grad2=ctx.createLinearGradient(left+labelW+4,0,left+labelW+4,barH-4);
    grad2.addColorStop(0,'rgba(255,255,255,0.15)');
    grad2.addColorStop(0.5,'rgba(255,255,255,0)');
    grad2.addColorStop(1,'rgba(0,0,0,0.1)');
    ctx.fillStyle=grad2;
    ctx.beginPath(); ctx.roundRect(left+labelW+4,y+2,barW,barH-4,4); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle='#000'; ctx.font='bold 9px sans-serif'; ctx.textBaseline='middle';
    // Position value text within bar if wide enough, otherwise after bar
    const barEnd = left+labelW+4+barW;
    const txtW = String(val).length * 6; // rough text width
    if (barW > txtW + 12) {
      // Text inside bar (right-aligned)
      ctx.textAlign = 'right';
      ctx.fillText(String(val), barEnd - 4, y+barH/2);
    } else if (barEnd + txtW + 6 < w - 5) {
      // Text after bar (left-aligned)
      ctx.textAlign = 'left';
      ctx.fillText(String(val), barEnd + 4, y+barH/2);
    } else {
      // Clamped to canvas edge
      ctx.textAlign = 'right';
      ctx.fillText(String(val), w - 5, y+barH/2);
    }
    ctx.shadowBlur = 6;
  });
  ctx.shadowBlur = 0;
}

// ═══════════════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════════════
function guessTag(a){
  if(!a||a.includes('分析失败')||a.includes('截图失败')) return'err';
  if(/(代码|编程|开发|debug|编码|terminal|编辑器|npm|git|编译|vs |ide|命令行|console)/i.test(a)) return'code';
  if(/(游戏|minecraft|playing|娱乐|我的世界|steam)/i.test(a)) return'game';
  if(/(会议|zoom|teams|meeting|腾讯会议|钉钉|飞书)/i.test(a)) return'meeting';
  if(/(浏览|网页|浏览器|chrome|baidu|搜索|bilibili|youtube|文档|read|阅读|pdf)/i.test(a)) return'browse';
  if(/(空闲|锁屏|屏保|sleep|away|idle)/i.test(a)) return'idle';
  return'work';
}
const TAG_LABELS={code:'💻 编码',game:'🎮 游戏',browse:'🌐 浏览',meeting:'🤝 会议',idle:'💤 空闲',err:'⚠️ 错误',work:'💼 工作'};
function fmtFull(iso){const d=new Date(iso);return d.toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});}

// ═══════════════════════════════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════════════════════════════
window.lifelens.onStateUpdate(updateUI);
window.lifelens.onScreenshotTaken((data)=>{
  S.shots=data.shotCount||S.shots+1;
  ['mShots','mAnalyzed','mQueue'].forEach(id=>{const el=$(id);if(!el)return;el.classList.remove('bump');void el.offsetWidth;el.classList.add('bump');});
  $('mShots').textContent=S.shots;
});
window.lifelens.onAnalyzing(()=>{$('statusRing').className='status-ring on';$('statusDot').className='status-dot-inner on';$('statusLabel').textContent='◉ 分析中';});
window.lifelens.onCaptureResult((data)=>{addDashEntry(data);$('statusRing').className='status-ring on';$('statusDot').className='status-dot-inner on';$('statusLabel').textContent='● 运行中';});

window.lifelens.onSummariesUpdate((data)=>{
  S.summaries=data.summaries||[]; S.summarizing=data.summarizing||[];
  const overlay=$('summarizingOverlay'),badge=$('summarizingBadge');
  if(S.summarizing.length>0){overlay?.classList.add('show');badge?.classList.add('show');}
  else{overlay?.classList.remove('show');badge?.classList.remove('show');}
  if($('tab-activity')?.classList.contains('active')){renderHeatmap();renderTimeline();}
  if($('tab-kanban')?.classList.contains('active')) refreshKanban();
  if($('tab-diary')?.classList.contains('active')) renderAllDiaries();
});

// Diary IPC
window.lifelens.onDiaryResult((data)=>{
  if(data.diary){
    S.diaries[data.date]=data.diary;
    if($('tab-diary')?.classList.contains('active')) renderAllDiaries();
  }
});
window.lifelens.onDiaryGenerating(()=>{});

// Stats IPC
window.lifelens.onStatsResult((data)=>{renderKanbanCharts(data);});

// ═══ Q&A ═══
let qaAnswering = false;
let qaBuffer = '';
let qaMsgEl = null;

window.lifelens.onQAToken((data)=>{
  const chat=$('qaChat');
  if(data.type==='thinking'||data.type==='search'||data.type==='answer'){
    const emp=chat.querySelector('.qa-empty'); if(emp) emp.remove();
    const div=document.createElement('div');
    div.className=data.type==='thinking'?'qa-msg qa-thinking':data.type==='search'?'qa-msg qa-search':'qa-msg qa-answer';
    div.textContent=data.text;
    chat.appendChild(div);
    chat.scrollTop=chat.scrollHeight;
  }else if(data.type==='token'){
    if(!qaMsgEl||!qaMsgEl.isConnected){
      const emp=chat.querySelector('.qa-empty'); if(emp) emp.remove();
      qaMsgEl=document.createElement('div');
      qaMsgEl.className='qa-msg qa-assist';
      chat.appendChild(qaMsgEl);
    }
    qaMsgEl.appendChild(document.createTextNode(data.text));
    chat.scrollTop=chat.scrollHeight;
  }else if(data.type==='error'){
    const emp=chat.querySelector('.qa-empty'); if(emp) emp.remove();
    const div=document.createElement('div'); div.className='qa-msg qa-error'; div.textContent=data.text;
    chat.appendChild(div); chat.scrollTop=chat.scrollHeight;
    qaAnswering=false; $('qaSend').disabled=false; $('qaInput').disabled=false;
  }else if(data.type==='done'){
    qaAnswering=false; $('qaSend').disabled=false; $('qaInput').disabled=false;
    $('qaInput').focus();
  }
});

$('qaSend').onclick = submitQuestion;
$('qaInput').onkeydown = (e) => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); } };

function submitQuestion(){
  const input=$('qaInput'); const q=input.value.trim();
  if(!q || qaAnswering) return;
  input.value='';
  qaAnswering=true; $('qaSend').disabled=true; $('qaInput').disabled=true;
  const chat=$('qaChat');
  const emp=chat.querySelector('.qa-empty'); if(emp) emp.remove();
  const userDiv=document.createElement('div');
  userDiv.className='qa-msg qa-user';
  userDiv.textContent=q;
  chat.appendChild(userDiv);
  chat.scrollTop=chat.scrollHeight;
  qaMsgEl=null;
  window.lifelens.askQuestion(q);
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════════════
$('btnToggle').onclick=()=>window.lifelens.toggleCapture();
$('btnClear').onclick=()=>{list.innerHTML=`<div class="empty"><span class="icon">📭</span><span class="txt">列表已清空</span></div>`;};
$('btnBottom').onclick=()=>{list.scrollTop=list.scrollHeight;};
$('filterProject').oninput=()=>{S.filterProject=$('filterProject').value;renderTimeline();};
$('filterSoftware').oninput=()=>{S.filterSoftware=$('filterSoftware').value;renderTimeline();};
$('filterCategory').onchange=()=>{S.filterCategory=$('filterCategory').value;renderTimeline();};
$('btnFilterClear').onclick=()=>{$('filterProject').value='';$('filterSoftware').value='';$('filterCategory').value='';S.filterProject='';S.filterSoftware='';S.filterCategory='';renderTimeline();};

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
let availableModels = [];
let selectedModel = '';

$('settingsIcon').onclick = () => {
  $('settingsOverlay').classList.add('show');
  loadModelsList();
  window.lifelens.getConfig();
};
$('settingsClose').onclick = () => $('settingsOverlay').classList.remove('show');
$('settingsOverlay').onclick = (e) => { if(e.target === e.currentTarget) $('settingsOverlay').classList.remove('show'); };

function loadModelsList() {
  $('modelStatus').textContent = '⏳ 检测中...';
  window.lifelens.getModels();
}

window.lifelens.onModelsList((models) => {
  availableModels = models || [];
  const sel = $('modelSelect');
  sel.innerHTML = '';
  if (!models.length) {
    sel.innerHTML = '<option value="">未检测到模型（Ollama 未运行）</option>';
    $('modelStatus').textContent = '❌ Ollama 未连接';
    return;
  }
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  // Select current config model
  if (selectedModel && models.includes(selectedModel)) {
    sel.value = selectedModel;
  } else {
    sel.value = models.includes('qwen3-vl:8b') ? 'qwen3-vl:8b' : models[0];
  }
  $('modelStatus').textContent = `✅ 检测到 ${models.length} 个模型`;
});

window.lifelens.onConfigUpdated((cfg) => {
  selectedModel = cfg.model || '';
  const sel = $('modelSelect');
  if (sel.options.length > 0 && selectedModel) {
    sel.value = selectedModel;
  }
});

$('refreshModelsBtn').onclick = loadModelsList;
$('saveModelBtn').onclick = () => {
  const model = $('modelSelect').value;
  if (!model) return;
  window.lifelens.saveConfig({ model });
  $('settingsStatus').style.display = 'block';
  setTimeout(() => { $('settingsStatus').style.display = 'none'; }, 2000);
};

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════
window.lifelens.requestState();
initKanban();

// Clock
setInterval(()=>{
  const now=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  $('dashClock').textContent=now;
},1000);

// Card shimmer
let activeIdx=0;
setInterval(()=>{
  ['cardShots','cardAnalyzed','cardQueue'].forEach((id,i)=>{const el=$(id);if(el)el.classList.toggle('active',i===activeIdx);});
  activeIdx=(activeIdx+1)%3;
},2500);
