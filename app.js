const W=['Wk1','Wk2','Wk3','Wk4','Wk5','Wk6','Wk7','Wk8'];
const tt={backgroundColor:'#0f172a',titleColor:'#fff',bodyColor:'#94a3b8',borderColor:'rgba(255,255,255,0.07)',borderWidth:1,padding:10,cornerRadius:10};
const gr={color:'rgba(0,0,0,0.04)'};
const ch={color:'#64748b',font:{size:11,family:'Inter'}};
function bOpt(extra={}){return{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:tt,...(extra.plugins||{})},scales:{x:{grid:gr,ticks:ch},y:{grid:gr,ticks:ch,beginAtZero:true}},...extra};}

let logData=[
  {wk:'Wk 8',mgr:'Malik Okunlaya',brand:'GeoInfotech',plat:'All',likes:1842,comments:267,reposts:183,followers:312,leads:38,score:82,grade:'A'},
  {wk:'Wk 7',mgr:'Boluwatife Olu-Ajayi',brand:'Geoinfo Academy',plat:'All',likes:1520,comments:210,reposts:150,followers:380,leads:42,score:89,grade:'A'},
  {wk:'Wk 6',mgr:'Peter Sylvester',brand:'Geostore',plat:'All',likes:1100,comments:180,reposts:120,followers:290,leads:30,score:74,grade:'B+'},
  {wk:'Wk 5',mgr:'Malik Okunlaya',brand:'GeoInfotech',plat:'All',likes:900,comments:160,reposts:100,followers:250,leads:28,score:68,grade:'B'},
  {wk:'Wk 4',mgr:'Boluwatife Olu-Ajayi',brand:'Geoinfo Academy',plat:'All',likes:820,comments:140,reposts:90,followers:220,leads:25,score:65,grade:'B'},
  {wk:'Wk 3',mgr:'Peter Sylvester',brand:'Geostore',plat:'All',likes:750,comments:120,reposts:80,followers:200,leads:22,score:60,grade:'C+'},
  {wk:'Wk 2',mgr:'Malik Okunlaya',brand:'GeoInfotech',plat:'All',likes:680,comments:100,reposts:70,followers:180,leads:18,score:58,grade:'C+'},
  {wk:'Wk 1',mgr:'Boluwatife Olu-Ajayi',brand:'Geoinfo Academy',plat:'All',likes:600,comments:90,reposts:60,followers:160,leads:15,score:55,grade:'C'},
];
let seoData=[
  {title:'Best Drone Matrices in Lagos',keyword:'drone matrices Lagos',cat:'Products',date:'Jun 27',rank:'#1',verified:'✓ Verified'},
  {title:'Top SEO Services Nigeria',keyword:'SEO services Nigeria',cat:'Services',date:'Jun 25',rank:'#2–3',verified:'Pending'},
  {title:'Online Courses for Beginners',keyword:'online courses Nigeria',cat:'Courses',date:'Jun 24',rank:'Not found',verified:'Pending'},
  {title:'Affordable Web Design Lagos',keyword:'web design Lagos',cat:'Services',date:'Jun 22',rank:'#2–3',verified:'✓ Verified'},
  {title:'Drone Photography Tips',keyword:'drone photography tips',cat:'Products',date:'Jun 20',rank:'#1',verified:'✓ Verified'},
];

window.onload=()=>{
  // Score donut
  new Chart(document.getElementById('scoreDonut'),{type:'doughnut',data:{labels:['Score','Remaining'],datasets:[{data:[82,18],backgroundColor:['#2878C8','#e5f0fa'],borderWidth:0}]},options:{cutout:'70%',plugins:{legend:{display:false},tooltip:{enabled:false}}}});
  // Main chart
  window.mainChartObj=new Chart(document.getElementById('mainChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Engagement',data:[45,120,85,200,310,180,420,580],borderColor:'#2878C8',backgroundColor:'rgba(40,120,200,0.07)',fill:true,tension:0.4,pointRadius:3,borderWidth:2.5},
    {label:'Target',data:Array(8).fill(150),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // AI hist
  new Chart(document.getElementById('aiHistChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Score',data:[62,65,70,72,76,78,76,82],borderColor:'#2878C8',backgroundColor:'rgba(40,120,200,0.07)',fill:true,tension:0.4,pointRadius:3,borderWidth:2.5},
    {label:'Target',data:Array(8).fill(80),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Brand radar
  new Chart(document.getElementById('brandChart'),{type:'radar',data:{labels:['Visual','Tone','Quality','Relevance','Prestige','CTA'],datasets:[{label:'Brand Score',data:[94,88,91,85,93,80],borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,0.12)',borderWidth:2,pointBackgroundColor:'#7c3aed'}]},options:{responsive:true,scales:{r:{grid:{color:'rgba(0,0,0,0.06)'},pointLabels:{color:'#64748b',font:{size:11}},ticks:{display:false},suggestedMin:50,suggestedMax:100}},plugins:{legend:{display:false},tooltip:tt}}});
  // Engagement
  new Chart(document.getElementById('engChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Likes',data:[45,120,85,200,310,180,420,580],borderColor:'#2878C8',tension:0.4,pointRadius:3,borderWidth:2,fill:false},
    {label:'Comments',data:[10,30,25,50,80,60,110,92],borderColor:'#16a34a',tension:0.4,pointRadius:3,borderWidth:2,fill:false},
    {label:'Target',data:Array(8).fill(150),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Engagement donut
  new Chart(document.getElementById('engDonut'),{type:'doughnut',data:{labels:['Facebook','Instagram','Twitter','LinkedIn'],datasets:[{data:[624,814,204,200],backgroundColor:['#1877F2','#E1306C','#1DA1F2','#0A66C2'],borderWidth:0,hoverOffset:7}]},options:{cutout:'60%',plugins:{legend:{position:'bottom',labels:{color:'#64748b',font:{size:11,family:'Inter'},padding:12,boxWidth:10}},tooltip:tt}}});
  // Leads
  new Chart(document.getElementById('leadsChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Facebook',data:[2,4,3,6,8,5,10,9],borderColor:'#1877F2',tension:0.4,pointRadius:3,borderWidth:2,fill:false},
    {label:'Instagram',data:[3,5,6,8,10,9,12,15],borderColor:'#E1306C',tension:0.4,pointRadius:3,borderWidth:2,fill:false},
    {label:'LinkedIn',data:[4,6,5,9,11,10,13,14],borderColor:'#0A66C2',tension:0.4,pointRadius:3,borderWidth:2,fill:false},
    {label:'Target',data:Array(8).fill(10),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Audience
  new Chart(document.getElementById('audChart'),{type:'bar',data:{labels:W,datasets:[
    {label:'Audience Score',data:[65,68,70,72,74,76,75,80],backgroundColor:'rgba(13,148,136,0.65)',borderRadius:6},
    {label:'Target',type:'line',data:Array(8).fill(70),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Comm
  new Chart(document.getElementById('commChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Comm Score',data:[70,72,75,78,80,82,85,88],borderColor:'#16a34a',backgroundColor:'rgba(22,163,74,0.07)',fill:true,tension:0.4,pointRadius:3,borderWidth:2.5},
    {label:'Target',data:Array(8).fill(75),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Followers
  new Chart(document.getElementById('flwChart'),{type:'bar',data:{labels:W,datasets:[
    {label:'Facebook',data:[80,90,85,95,100,88,92,87],backgroundColor:'rgba(24,119,242,0.65)',borderRadius:4},
    {label:'Instagram',data:[100,120,130,140,160,155,165,178],backgroundColor:'rgba(225,48,108,0.65)',borderRadius:4},
    {label:'Twitter',data:[30,35,40,45,50,42,48,47],backgroundColor:'rgba(29,161,242,0.65)',borderRadius:4},
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // Leaderboard chart
  new Chart(document.getElementById('lbChart'),{type:'bar',data:{labels:['Malik Okunlaya','Boluwatife Olu-Ajayi','Peter Sylvester','',''],datasets:[{label:'Score',data:[94,89,82,74,68],backgroundColor:['#fbbf24','#94a3b8','#d97706','#2878C8','#7c3aed'],borderRadius:8}]},options:{...bOpt(),indexAxis:'y',plugins:{legend:{display:false},tooltip:tt},scales:{x:{grid:gr,ticks:{...ch},max:100},y:{grid:{display:false},ticks:ch}}}});

  renderLBTable(); renderSEOTable(); renderLogTable(); renderReportsTable();
};

function switchMainTab(btn,key){
  document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  const map={eng:{data:[45,120,85,200,310,180,420,580],thr:150,lbl:'Engagement'},leads:{data:[2,5,4,8,10,8,12,9],thr:10,lbl:'Leads'},flw:{data:[20,45,60,90,70,80,100,87],thr:100,lbl:'Followers'},seo:{data:[30,35,40,44,48,42,46,44],thr:50,lbl:'SEO Rate %'}};
  const d=map[key];window.mainChartObj.data.datasets[0].data=d.data;window.mainChartObj.data.datasets[0].label=d.lbl;window.mainChartObj.data.datasets[1].data=Array(8).fill(d.thr);window.mainChartObj.update();
}

function renderLBTable(){
  const lbs=[
    {n:'Malik Okunlaya',b:'GeoInfotech',s:94,g:'A+',av:'MO',c:'#f59e0b'},
    {n:'Boluwatife Olu-Ajayi',b:'Geoinfo Academy',s:89,g:'A',av:'BO',c:'#2878C8'},
    {n:'Peter Sylvester',b:'Geostore',s:82,g:'A',av:'PS',c:'#0d9488'}
  ];
  const gc=s=>s>=90?'var(--green)':s>=80?'var(--green)':s>=70?'var(--amber)':'var(--red)';
  document.getElementById('lbTable').innerHTML=`<thead><tr><th>#</th><th>Manager</th><th>Brand</th><th>Score</th><th>Grade</th><th>Status</th></tr></thead><tbody>${lbs.map((r,i)=>`<tr><td style="font-weight:800;color:${i===0?'#d97706':i===1?'#64748b':i===2?'#92400e':'var(--sub2)'}">${i+1}</td><td><span style="display:flex;align-items:center;gap:8px"><span style="width:28px;height:28px;border-radius:50%;background:${r.c};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${r.av}</span>${r.n}</span></td><td>${r.b}</td><td style="font-weight:800;font-size:16px;letter-spacing:-0.5px">${r.s}</td><td><span style="font-weight:700;color:${gc(r.s)}">${r.g}</span></td><td><span class="pill ${r.s>=80?'pill-met':r.s>=70?'pill-warn':'pill-miss'}">${r.s>=80?'✓ On Track':r.s>=70?'⚠ Improving':'✗ Needs Work'}</span></td></tr>`).join('')}</tbody>`;
}

function renderSEOTable(){
  const t=document.getElementById('seoTable');
  const rc=r=>r==='#1'?'pill-met':r==='Not found'?'pill-miss':'pill-warn';
  t.innerHTML=`<thead><tr><th>Title</th><th>Keyword</th><th>Category</th><th>Date</th><th>Ranking</th><th>Admin Verify</th></tr></thead><tbody>${seoData.map(r=>`<tr><td>${r.title}</td><td style="color:var(--sub)">${r.keyword}</td><td><span class="pill pill-blue">${r.cat}</span></td><td style="color:var(--sub2)">${r.date}</td><td><span class="pill ${rc(r.rank)}">${r.rank}</span></td><td><span style="font-size:12px;font-weight:600;color:${r.verified.includes('✓')?'var(--green)':'var(--amber)'}">${r.verified}</span></td></tr>`).join('')}</tbody>`;
}

// Brand to manager mapping - always use this
const brandManagers = {
  'GeoInfotech': 'Malik Okunlaya',
  'Geoinfo Academy': 'Boluwatife Olu-Ajayi',
  'Geostore': 'Peter Sylvester'
};

function renderLogTable(){
  const t=document.getElementById('engLogTable');
  const sc={met:'pill-met',missed:'pill-miss',warn:'pill-warn'};
  // Ensure manager name is always correct for brand
  logData.forEach(r => { if(brandManagers[r.brand]) r.mgr = brandManagers[r.brand]; });
  t.innerHTML=`<thead><tr><th>Week</th><th>Manager</th><th>Brand</th><th>Likes</th><th>Comments</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th></tr></thead><tbody>${logData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk}</td><td>${r.mgr}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.likes.toLocaleString()}</td><td>${r.comments}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td></tr>`).join('')}</tbody>`;
}

function renderReportsTable(){
  document.getElementById('reportsTable').innerHTML=`<thead><tr><th>Week</th><th>Manager</th><th>Brand</th><th>Engagement</th><th>Leads</th><th>Followers</th><th>SEO%</th><th>Branding</th><th>Audience</th><th>Comm</th><th>Score</th><th>Grade</th></tr></thead><tbody>${logData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk}</td><td>${r.mgr}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.likes.toLocaleString()}</td><td>${r.leads}</td><td>${r.followers}</td><td>44%</td><td>91</td><td>80</td><td>88</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td></tr>`).join('')}</tbody>`;
}

function showPage(id,nav){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if(nav) nav.classList.add('active');
  if(window.innerWidth<=900){document.getElementById('sidebar').classList.remove('open');}
}
function toggleSB(){document.getElementById('sidebar').classList.toggle('open');}
function setPeriod(btn){document.querySelectorAll('.pchip').forEach(c=>c.classList.remove('active'));btn.classList.add('active');showToast('Period: '+btn.textContent);}
function setBrand(btn,b){document.querySelectorAll('.bpill').forEach(c=>c.classList.remove('active'));btn.classList.add('active');showToast('Switched to '+b);}
function setLBPeriod(btn,p){document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));btn.classList.add('active');showToast('Leaderboard: '+btn.textContent);}
function selKPI(card,k){document.querySelectorAll('#page-dashboard .stat-card').forEach(c=>c.classList.remove('sel'));card.classList.add('sel');}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function submitLog(){
  const selBrand = document.querySelector('#logModal select:nth-child(1)') ? document.querySelector('#logModal select').value.replace(/ \(.*\)/,'') : 'GeoInfotech';
  logData.unshift({wk:'Wk 9',mgr:brandManagers[selBrand]||'Unknown',brand:selBrand,plat:'All',likes:+document.getElementById('lgLikes').value||0,comments:+document.getElementById('lgComments').value||0,reposts:+document.getElementById('lgReposts').value||0,followers:+document.getElementById('lgFollowers').value||0,leads:+document.getElementById('lgLeads').value||0,score:0,grade:'—'});
  renderLogTable();closeModal('logModal');showToast('Week submitted successfully');
}
function submitSEO(){
  seoData.unshift({title:document.getElementById('seoTitle').value||'New Post',keyword:document.getElementById('seoKw').value||'—',cat:document.getElementById('seoCat').value,date:'Jun 29',rank:document.getElementById('seoRank').value,verified:'Pending'});
  renderSEOTable();closeModal('seoModal');showToast('Blog post logged');
}
function saveSettings(){showToast('KPI targets saved');}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
document.querySelectorAll('.modal-overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');}));