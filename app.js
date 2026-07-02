// ═══ SUPABASE CONFIG ═══
const SUPABASE_URL = 'https://cmbxrsxvzcezvubbwdpb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtYnhyc3h2emNlenZ1YmJ3ZHBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NzQ4MDksImV4cCI6MjA5ODM1MDgwOX0.JjZ0WASnuCOWPFJzHx7YETe3y9b1Lkx2HCYooDJoeOY';

async function sbFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase error ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Fetch all weekly logs from Supabase, newest first
async function fetchWeeklyLogs() {
  try {
    const rows = await sbFetch('weekly_logs?select=*&order=created_at.desc', {
      headers: { 'Prefer': 'return=representation' }
    });
    return rows || [];
  } catch (e) {
    console.error('Failed to fetch weekly logs:', e);
    return null; // null signals failure so caller can fall back to local sample data
  }
}

// Insert a new weekly log row into Supabase
async function insertWeeklyLog(entry) {
  return sbFetch('weekly_logs', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(entry)
  });
}

// Update an existing weekly log row in Supabase (used when the same platform
// is resubmitted for a week that's already been logged, so it updates in
// place instead of creating a duplicate row)
async function updateWeeklyLog(id, fields) {
  return sbFetch(`weekly_logs?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(fields)
  });
}

// Fetch the brand-level weekly qualitative scores (Branding/Audience/Comm)
async function fetchQualitative() {
  try {
    const rows = await sbFetch('weekly_qualitative?select=*&order=created_at.desc');
    return rows || [];
  } catch (e) {
    console.error('Failed to fetch qualitative scores:', e);
    return null;
  }
}

// Fetch the persisted SEO / blog post log
async function fetchSeoPosts() {
  try {
    const rows = await sbFetch('seo_posts?select=*&order=created_at.desc');
    return rows || [];
  } catch (e) {
    console.error('Failed to fetch SEO posts:', e);
    return null;
  }
}

async function insertSeoPost(entry) {
  return sbFetch('seo_posts', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(entry)
  });
}

// Branding/Audience/Communication scores apply once per brand per week (not
// per platform) — update the existing week's row if one exists, else create it.
async function upsertQualitative(brand, weekLabel, weekEnding, fields) {
  const existing = qualitativeData.find(q => q.brand === brand && q.wk === weekLabel);
  if (existing) {
    return sbFetch(`weekly_qualitative?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(fields)
    });
  }
  return sbFetch('weekly_qualitative', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify({ brand, week_label: weekLabel, week_ending: weekEnding || null, ...fields })
  });
}

// ═══ SCORING ALGORITHM ═══
// Weekly targets, matching the numbers already shown in the KPI cards/Settings page.
const KPI_TARGETS = { engagement: 600, leads: 40, followers: 400 };
// Weight of each of the 7 KPIs in the full composite score (sums to 100).
const KPI_WEIGHTS = { engagement: 20, leads: 25, followers: 10, seo: 10, branding: 15, audience: 10, comm: 10 };

// Turns a "Week Ending" date into a stable label so that logging multiple
// platforms for the same real week produces the SAME week, instead of a
// fresh "Wk N" every time someone hits submit.
function getWeekLabel(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  return 'Wk of ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Composite score from the quantifiable KPIs this form actually collects
// (Engagement 20%, Leads 25%, Followers 10% = 55% of the full weighting
// model). Rescaled to a 0-100 scale since SEO/Branding/Audience/Communication
// (the remaining 45%) are AI/manually scored elsewhere and aren't part of
// this form yet.
function calcScore({ likes = 0, comments = 0, reposts = 0, followers = 0, leads = 0 }) {
  const engScore = Math.min((likes + comments + reposts) / KPI_TARGETS.engagement * 100, 100);
  const leadsScore = Math.min(leads / KPI_TARGETS.leads * 100, 100);
  const followersScore = Math.min(followers / KPI_TARGETS.followers * 100, 100);
  const weighted = (engScore * 20 + leadsScore * 25 + followersScore * 10) / 55;
  return Math.round(weighted);
}

// Self-rated SEO ranking -> a 0-100 score for the weekly composite.
function rankToScore(rank) {
  if (rank === '#1') return 100;
  if (rank === '#2–3') return 75;
  if (rank === '#4–5') return 50;
  if (rank === 'Not found') return 0;
  return null;
}

// The real 7-KPI weighted composite for a brand's week: Engagement/Leads/
// Followers come from summed platform logs; SEO comes from that week's blog
// posts; Branding/Audience/Communication come from the manager/AI-scored
// weekly_qualitative row. Any KPI that hasn't been logged yet for the week is
// left out and the remaining weights are rescaled to 100, so the score is
// always meaningful even before every KPI has data.
function calcFullScore({ likes = 0, comments = 0, reposts = 0, followers = 0, leads = 0, seoScore = null, brandingScore = null, audienceScore = null, commScore = null }) {
  const engScore = Math.min((likes + comments + reposts) / KPI_TARGETS.engagement * 100, 100);
  const leadsScore = Math.min(leads / KPI_TARGETS.leads * 100, 100);
  const followersScore = Math.min(followers / KPI_TARGETS.followers * 100, 100);
  const parts = [
    { w: KPI_WEIGHTS.engagement, v: engScore },
    { w: KPI_WEIGHTS.leads, v: leadsScore },
    { w: KPI_WEIGHTS.followers, v: followersScore }
  ];
  if (seoScore != null) parts.push({ w: KPI_WEIGHTS.seo, v: seoScore });
  if (brandingScore != null) parts.push({ w: KPI_WEIGHTS.branding, v: brandingScore });
  if (audienceScore != null) parts.push({ w: KPI_WEIGHTS.audience, v: audienceScore });
  if (commScore != null) parts.push({ w: KPI_WEIGHTS.comm, v: commScore });
  const totalW = parts.reduce((s, p) => s + p.w, 0) || 1;
  const weighted = parts.reduce((s, p) => s + p.w * p.v, 0) / totalW;
  return {
    score: Math.round(weighted),
    engScore: Math.round(engScore),
    leadsScore: Math.round(leadsScore),
    followersScore: Math.round(followersScore),
    seoScore: seoScore != null ? Math.round(seoScore) : null,
    brandingScore: brandingScore != null ? Math.round(brandingScore) : null,
    audienceScore: audienceScore != null ? Math.round(audienceScore) : null,
    commScore: commScore != null ? Math.round(commScore) : null
  };
}

// Matches the grade scale shown on the Leaderboard page (A+ 90-100, A 80-89,
// B+ 75-79, B 65-74, C 50-64, D below 50).
function gradeFor(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 75) return 'B+';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// Map a Supabase row (snake_case columns) to the app's internal logData shape.
// Each row is now one platform's numbers for one brand's week.
function mapRowToLogEntry(row) {
  return {
    wk: row.week_label,
    weekEnding: row.week_ending,
    mgr: row.manager,
    brand: row.brand,
    plat: row.platform || 'All Platforms',
    likes: row.likes || 0,
    comments: row.comments || 0,
    reposts: row.reposts || 0,
    followers: row.followers || 0,
    leads: row.leads || 0,
    score: row.score || 0,
    grade: row.grade || '—',
    _id: row.id,
    createdAt: row.created_at
  };
}

// Map a weekly_qualitative row (Branding/Audience/Communication)
function mapRowToQualEntry(row) {
  return {
    id: row.id,
    brand: row.brand,
    wk: row.week_label,
    weekEnding: row.week_ending,
    commNotes: row.comm_notes || '',
    brandNotes: row.brand_notes || '',
    audienceNotes: row.audience_notes || '',
    commScore: row.comm_score,
    brandingScore: row.branding_score,
    audienceScore: row.audience_score
  };
}

// Map a seo_posts row (persisted blog post log)
function mapRowToSeoEntry(row) {
  return {
    id: row.id,
    brand: row.brand,
    wk: row.week_label,
    title: row.title,
    keyword: row.keyword,
    cat: row.category,
    rank: row.rank,
    verified: row.verified || 'Pending',
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  };
}

// ═══ AGGREGATION: one "Overall" row per brand per week ═══
// Combines every platform logged that week with that week's SEO posts and
// qualitative scores into the single composite the Dashboard, Reports page,
// Leaderboard, and AI Review all read from.
function aggregateOverall(platformRows, qualRows, seoRows) {
  const groups = {};
  platformRows.forEach(r => {
    const key = r.brand + '||' + r.wk;
    if (!groups[key]) {
      groups[key] = { brand: r.brand, wk: r.wk, weekEnding: r.weekEnding, mgr: r.mgr, likes: 0, comments: 0, reposts: 0, followers: 0, leads: 0, platforms: [], latestCreatedAt: r.createdAt || 0 };
    }
    const g = groups[key];
    g.likes += r.likes; g.comments += r.comments; g.reposts += r.reposts; g.followers += r.followers; g.leads += r.leads;
    g.platforms.push(r.plat);
    if (!g.weekEnding && r.weekEnding) g.weekEnding = r.weekEnding;
    if (r.createdAt && new Date(r.createdAt) > new Date(g.latestCreatedAt || 0)) g.latestCreatedAt = r.createdAt;
  });

  return Object.values(groups).map(g => {
    const qual = qualRows.find(q => q.brand === g.brand && q.wk === g.wk) || null;
    const weekSeoRows = seoRows.filter(s => s.brand === g.brand && s.wk === g.wk);
    let seoScore = null;
    if (weekSeoRows.length) {
      const scored = weekSeoRows.map(s => rankToScore(s.rank)).filter(v => v != null);
      if (scored.length) seoScore = scored.reduce((a, b) => a + b, 0) / scored.length;
    }
    const breakdown = calcFullScore({
      likes: g.likes, comments: g.comments, reposts: g.reposts, followers: g.followers, leads: g.leads,
      seoScore,
      brandingScore: qual ? qual.brandingScore : null,
      audienceScore: qual ? qual.audienceScore : null,
      commScore: qual ? qual.commScore : null
    });
    return { ...g, ...breakdown, grade: gradeFor(breakdown.score), seoPostCount: weekSeoRows.length, qual };
  }).sort((a, b) => new Date(b.latestCreatedAt || 0) - new Date(a.latestCreatedAt || 0));
}

// overallData is always sorted newest-first, so this just grabs the first match
function latestOverallForBrand(brand) {
  return overallData.find(r => r.brand === brand) || null;
}

// Admin's brand-switcher pill selection (defaults to GeoInfotech, matching
// the pill that's active by default in the sidebar)
let selectedDashboardBrand = 'GeoInfotech';
function getDashboardRow() {
  const brand = (currentUser && currentUser.role === 'manager') ? currentUser.brand : selectedDashboardBrand;
  return latestOverallForBrand(brand);
}

// ═══ AUTH SYSTEM ═══
const ACCOUNTS = {
  admin:       { password: 'admin123',  role: 'admin',   name: 'Super Admin',         brand: null,               avatar:'SA', roleLabel:'Admin' },
  malik:       { password: 'malik123',  role: 'manager', name: 'Malik Okunlaya',      brand: 'GeoInfotech',      avatar:'MO', roleLabel:'Manager' },
  boluwatife:  { password: 'bolu123',   role: 'manager', name: 'Boluwatife Olu-Ajayi',brand: 'Geoinfo Academy',  avatar:'BO', roleLabel:'Manager' },
  peter:       { password: 'peter123',  role: 'manager', name: 'Peter Sylvester',     brand: 'Geostore',         avatar:'PS', roleLabel:'Manager' },
};

let currentUser = null;

function doLogin() {
  const u = document.getElementById('loginUser').value.trim().toLowerCase();
  const p = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  const acct = ACCOUNTS[u];

  if (!acct || acct.password !== p) {
    errEl.textContent = 'Incorrect username or password.';
    errEl.classList.add('show');
    document.getElementById('loginPass').value = '';
    return;
  }

  errEl.classList.remove('show');
  currentUser = { username: u, ...acct };
  sessionStorage.setItem('smpis_user', u); // persists for this tab session only

  applyRole(currentUser);

  document.body.classList.remove('app-hidden');
  document.getElementById('loginScreen').style.display = 'none';
}

function doLogout() {
  currentUser = null;
  sessionStorage.removeItem('smpis_user');
  document.body.classList.add('app-hidden');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginUser').focus();
}

function applyRole(user) {
  // Update sidebar user pill
  const userPill = document.querySelector('.user-pill');
  if (userPill) {
    userPill.innerHTML = `
      <div class="u-avatar">${user.avatar}</div>
      <div style="flex:1">
        <div class="u-name" style="display:flex;align-items:center;gap:6px">${user.name} <span class="role-badge ${user.role}">${user.roleLabel}</span></div>
        <div class="u-role">${user.brand ? user.brand : 'All Branches'}</div>
        <div class="logout-link" onclick="doLogout()">
          <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </div>
      </div>`;
  }

  // Lock the Log Week and Blog Post modals' Brand dropdowns to the manager's
  // own brand so they can't accidentally submit data under a different
  // brand. Admin gets the full dropdown back.
  [document.getElementById('lgBrand'), document.getElementById('seoBrand')].forEach(sel => {
    if (!sel) return;
    if (user.role === 'manager') {
      const ownOption = Array.from(sel.options).find(o => o.value.startsWith(user.brand + ' ('));
      if (ownOption) sel.value = ownOption.value;
      sel.disabled = true;
    } else {
      sel.disabled = false;
    }
  });

  if (user.role === 'admin') {
    // Admin sees everything — brand switcher visible, all nav items visible
    document.querySelectorAll('.brand-switcher, .nav-item, .bpill').forEach(el => el.style.display = '');
    document.getElementById('page-leaderboard') && (document.querySelector('[onclick*="leaderboard"]').style.display = '');
    showPage('dashboard', document.querySelector('.nav-item.active') || document.querySelector('.nav-item'));
  } else {
    // Manager: lock to their own brand, hide brand switcher, hide leaderboard nav
    const switcher = document.querySelector('.brand-switcher');
    if (switcher) switcher.style.display = 'none';

    document.querySelectorAll('.nav-item').forEach(item => {
      if (item.getAttribute('onclick') && item.getAttribute('onclick').includes('leaderboard')) {
        item.style.display = 'none';
      }
    });

    // Update header subtitle to reflect locked brand
    document.querySelectorAll('.hc-sub').forEach(el => {
      if (el.textContent.includes('GeoInfotech') || el.textContent.includes('Weekly KPI')) {
        el.textContent = el.textContent.replace(/^[^·]+·/, user.brand + ' ·');
      }
    });

    showPage('dashboard', document.querySelector('.nav-item'));
  }

  // Load real data from Supabase once the user is in, then keep polling
  refreshAllData().then(startAutoRefresh);
}

let refreshTimer = null;

// Pulls weekly_logs (per-platform), weekly_qualitative, and seo_posts from
// Supabase, rebuilds the per-brand Overall aggregation, and re-renders every
// table/chart/card that depends on real data (Weekly Log, Weekly Reports,
// SEO log, Leaderboard, Dashboard KPIs, AI Review).
async function refreshAllData() {
  const [rawLogs, rawQual, rawSeo] = await Promise.all([fetchWeeklyLogs(), fetchQualitative(), fetchSeoPosts()]);

  if (rawLogs === null && rawQual === null && rawSeo === null) {
    showToast('Offline — showing local data');
    return;
  }

  logData = (rawLogs || []).map(mapRowToLogEntry);
  qualitativeData = (rawQual || []).map(mapRowToQualEntry);
  seoPostsData = (rawSeo || []).map(mapRowToSeoEntry);

  // Managers only see their own brand's data
  if (currentUser && currentUser.role === 'manager') {
    logData = logData.filter(r => r.brand === currentUser.brand);
    qualitativeData = qualitativeData.filter(r => r.brand === currentUser.brand);
    seoPostsData = seoPostsData.filter(r => r.brand === currentUser.brand);
  }

  overallData = aggregateOverall(logData, qualitativeData, seoPostsData);

  renderLogTable();
  renderReportsTable();
  renderPlatformTracker();
  renderSEOTable();
  renderLBTable();
  renderMiniLeaderboard();
  renderDashboardKPIs();
  renderAIReview();
}

// Poll every 20s so Admin sees new manager submissions without refreshing
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAllData, 20000);
}

// Check for existing session (tab refresh)
window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('smpis_user');
  if (saved && ACCOUNTS[saved]) {
    currentUser = { username: saved, ...ACCOUNTS[saved] };
    document.body.classList.remove('app-hidden');
    document.getElementById('loginScreen').style.display = 'none';
    // Wait for window.onload (charts) before applying role
    setTimeout(() => applyRole(currentUser), 50);
  }
});

const W=['Wk1','Wk2','Wk3','Wk4','Wk5','Wk6','Wk7','Wk8'];
const tt={backgroundColor:'#0f172a',titleColor:'#fff',bodyColor:'#94a3b8',borderColor:'rgba(255,255,255,0.07)',borderWidth:1,padding:10,cornerRadius:10};
const gr={color:'rgba(0,0,0,0.04)'};
const ch={color:'#64748b',font:{size:11,family:'Inter'}};
function bOpt(extra={}){return{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:tt,...(extra.plugins||{})},scales:{x:{grid:gr,ticks:ch},y:{grid:gr,ticks:ch,beginAtZero:true}},...extra};}

// All real, all fetched from Supabase after login (see refreshAllData).
// Empty until then — the login screen covers the UI so there's nothing to
// show prematurely.
let logData = [];          // raw per-platform weekly_logs rows
let qualitativeData = [];  // per-brand-per-week Branding/Audience/Comm scores
let seoPostsData = [];     // persisted blog post log
let overallData = [];      // aggregated per-brand-per-week Overall rows (newest first)

window.onload=()=>{
  // Score donut
  window.scoreDonutObj=new Chart(document.getElementById('scoreDonut'),{type:'doughnut',data:{labels:['Score','Remaining'],datasets:[{data:[0,100],backgroundColor:['#2878C8','#e5f0fa'],borderWidth:0}]},options:{cutout:'70%',plugins:{legend:{display:false},tooltip:{enabled:false}}}});
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
  window.lbChartObj=new Chart(document.getElementById('lbChart'),{type:'bar',data:{labels:['GeoInfotech','Geoinfo Academy','Geostore'],datasets:[{label:'Score',data:[0,0,0],backgroundColor:['#fbbf24','#94a3b8','#d97706'],borderRadius:8}]},options:{...bOpt(),indexAxis:'y',plugins:{legend:{display:false},tooltip:tt},scales:{x:{grid:gr,ticks:{...ch},max:100},y:{grid:{display:false},ticks:ch}}}});

  renderLBTable(); renderMiniLeaderboard(); renderSEOTable(); renderLogTable(); renderReportsTable(); renderPlatformTracker(); renderDashboardKPIs(); renderAIReview();
};

function switchMainTab(btn,key){
  document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  const map={eng:{data:[45,120,85,200,310,180,420,580],thr:150,lbl:'Engagement'},leads:{data:[2,5,4,8,10,8,12,9],thr:10,lbl:'Leads'},flw:{data:[20,45,60,90,70,80,100,87],thr:100,lbl:'Followers'},seo:{data:[30,35,40,44,48,42,46,44],thr:50,lbl:'SEO Rate %'}};
  const d=map[key];window.mainChartObj.data.datasets[0].data=d.data;window.mainChartObj.data.datasets[0].label=d.lbl;window.mainChartObj.data.datasets[1].data=Array(8).fill(d.thr);window.mainChartObj.update();
}

function renderLBTable(){
  const brands=[
    {name:'GeoInfotech', mgr:'Malik Okunlaya', av:'MO', c:'#f59e0b'},
    {name:'Geoinfo Academy', mgr:'Boluwatife Olu-Ajayi', av:'BO', c:'#2878C8'},
    {name:'Geostore', mgr:'Peter Sylvester', av:'PS', c:'#0d9488'}
  ];
  const lbs=brands.map(b=>{
    const row=latestOverallForBrand(b.name);
    return {n:b.mgr,b:b.name,s:row?row.score:null,g:row?row.grade:'—',av:b.av,c:b.c};
  }).sort((a,z)=>(z.s??-1)-(a.s??-1));

  const gc=s=>s==null?'var(--sub2)':s>=90?'var(--green)':s>=80?'var(--green)':s>=70?'var(--amber)':'var(--red)';
  document.getElementById('lbTable').innerHTML=`<thead><tr><th>#</th><th>Manager</th><th>Brand</th><th>Score</th><th>Grade</th><th>Status</th></tr></thead><tbody>${lbs.map((r,i)=>`<tr><td style="font-weight:800;color:${i===0?'#d97706':i===1?'#64748b':i===2?'#92400e':'var(--sub2)'}">${i+1}</td><td><span style="display:flex;align-items:center;gap:8px"><span style="width:28px;height:28px;border-radius:50%;background:${r.c};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${r.av}</span>${r.n}</span></td><td>${r.b}</td><td style="font-weight:800;font-size:16px;letter-spacing:-0.5px">${r.s!=null?r.s:'—'}</td><td><span style="font-weight:700;color:${gc(r.s)}">${r.g}</span></td><td><span class="pill ${r.s>=80?'pill-met':r.s>=70?'pill-warn':r.s!=null?'pill-miss':''}">${r.s==null?'No data yet':r.s>=80?'✓ On Track':r.s>=70?'⚠ Improving':'✗ Needs Work'}</span></td></tr>`).join('')}</tbody>`;

  if (window.lbChartObj) {
    window.lbChartObj.data.labels = lbs.map(r=>r.b);
    window.lbChartObj.data.datasets[0].data = lbs.map(r=>r.s ?? 0);
    window.lbChartObj.update();
  }
}

// Dashboard's "Top Managers" mini leaderboard — same real ranking as the full
// Leaderboard page (latestOverallForBrand per brand, sorted by score
// descending), just rendered as the smaller gold/silver/bronze row list
// instead of a table. Was previously static hardcoded HTML.
function renderMiniLeaderboard(){
  const list = document.getElementById('miniLbList');
  if (!list) return;

  const brands=[
    {name:'GeoInfotech', mgr:'Malik Okunlaya', av:'MO', c:'#f59e0b'},
    {name:'Geoinfo Academy', mgr:'Boluwatife Olu-Ajayi', av:'BO', c:'#2878C8'},
    {name:'Geostore', mgr:'Peter Sylvester', av:'PS', c:'#0d9488'}
  ];
  const lbs=brands.map(b=>{
    const row=latestOverallForBrand(b.name);
    return {n:b.mgr,b:b.name,s:row?row.score:null,g:row?row.grade:'—',av:b.av,c:b.c};
  }).sort((a,z)=>(z.s??-1)-(a.s??-1));

  const gc=s=>s==null?'var(--sub2)':s>=80?'var(--green)':s>=70?'var(--amber)':'var(--red)';
  const rankClass=i=>i===0?'gold':i===1?'silver':i===2?'bronze':'';

  list.innerHTML = lbs.map((r,i)=>`
    <div class="lb-row">
      <div class="lb-rank ${rankClass(i)}">${i+1}</div>
      <div class="lb-avatar" style="background:${r.c}">${r.av}</div>
      <div class="lb-info"><div class="lb-name">${r.n}</div><div class="lb-brand">${r.b}</div></div>
      <div style="text-align:right"><div class="lb-score">${r.s!=null?r.s:'—'}</div><div class="lb-grade" style="color:${gc(r.s)}">${r.g}</div></div>
    </div>`).join('');
}

function renderSEOTable(){
  const t=document.getElementById('seoTable');
  const rc=r=>r==='#1'?'pill-met':r==='Not found'?'pill-miss':'pill-warn';
  t.innerHTML=`<thead><tr><th>Week</th><th>Brand</th><th>Title</th><th>Keyword</th><th>Category</th><th>Date</th><th>Ranking</th><th>Admin Verify</th></tr></thead><tbody>${seoPostsData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk||'—'}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.title}</td><td style="color:var(--sub)">${r.keyword}</td><td><span class="pill pill-blue">${r.cat}</span></td><td style="color:var(--sub2)">${r.date}</td><td><span class="pill ${rc(r.rank)}">${r.rank}</span></td><td><span style="font-size:12px;font-weight:600;color:${r.verified.includes('✓')?'var(--green)':'var(--amber)'}">${r.verified}</span></td></tr>`).join('')}</tbody>`;
}

// Finds a .stat-card within a page/scope by its label text and sets its value.
// Used because the individual KPI cards on Dashboard don't have per-card ids.
function setStatCard(scopeSelector, label, value){
  const cards=document.querySelectorAll(scopeSelector+' .stat-card');
  for (const card of cards){
    const lbl=card.querySelector('.sc-lbl');
    if (lbl && lbl.textContent.trim()===label){
      const val=card.querySelector('.sc-val');
      if (val) val.textContent=value;
      return card;
    }
  }
  return null;
}

// Same idea for the .ai-score-bar breakdown rows (used on both the Dashboard
// "Overall Performance Score" card and the AI Review "Score Breakdown" card —
// both get updated since they show the same underlying weekly composite).
function setAiBar(label, value){
  document.querySelectorAll('.ai-score-bar').forEach(bar=>{
    const lbl=bar.querySelector('.ai-bar-label');
    if (lbl && lbl.textContent.trim()===label){
      const val=bar.querySelector('.ai-bar-val');
      const fill=bar.querySelector('.ai-bar-fill');
      if (val) val.textContent=value!=null?value:'—';
      if (fill) fill.style.width=(value!=null?value:0)+'%';
    }
  });
}

// Pushes the real Overall row for the currently-viewed brand into the
// Dashboard: the big score donut, the "Overall Performance Score" breakdown,
// and all 7 KPI stat cards.
function renderDashboardKPIs(){
  const row=getDashboardRow();
  const donutNum=document.getElementById('donutScoreNum');
  const overallNum=document.getElementById('overallScore');

  if (!row){
    if (donutNum) donutNum.textContent='—';
    if (overallNum) overallNum.textContent='—';
    setStatCard('#page-dashboard','Engagement','—');
    setStatCard('#page-dashboard','Leads Generated','—');
    setStatCard('#page-dashboard','Follower Growth','—');
    setStatCard('#page-dashboard','SEO Performance','—');
    setStatCard('#page-dashboard','AI Branding Score','—/100');
    setStatCard('#page-dashboard','Target Audience Quality','—/100');
    setStatCard('#page-dashboard','Communication Score','—/100');
    ['Engagement (20%)','Leads (25%)','Followers (10%)','SEO (10%)','AI Branding (15%)','Audience (10%)','Communication (10%)'].forEach(l=>setAiBar(l,null));
    if (window.scoreDonutObj){ window.scoreDonutObj.data.datasets[0].data=[0,100]; window.scoreDonutObj.update(); }
    return;
  }

  if (donutNum) donutNum.textContent=row.score;
  if (overallNum) overallNum.textContent=row.score;
  if (window.scoreDonutObj){ window.scoreDonutObj.data.datasets[0].data=[row.score,100-row.score]; window.scoreDonutObj.update(); }

  setStatCard('#page-dashboard','Engagement',(row.likes+row.comments+row.reposts).toLocaleString());
  setStatCard('#page-dashboard','Leads Generated',row.leads);
  setStatCard('#page-dashboard','Follower Growth',row.followers);
  setStatCard('#page-dashboard','SEO Performance',row.seoScore!=null?row.seoScore+'%':'—');
  setStatCard('#page-dashboard','AI Branding Score',(row.brandingScore!=null?row.brandingScore:'—')+'/100');
  setStatCard('#page-dashboard','Target Audience Quality',(row.audienceScore!=null?row.audienceScore:'—')+'/100');
  setStatCard('#page-dashboard','Communication Score',(row.commScore!=null?row.commScore:'—')+'/100');

  setAiBar('Engagement (20%)',row.engScore);
  setAiBar('Leads (25%)',row.leadsScore);
  setAiBar('Followers (10%)',row.followersScore);
  setAiBar('SEO (10%)',row.seoScore);
  setAiBar('AI Branding (15%)',row.brandingScore);
  setAiBar('Audience (10%)',row.audienceScore);
  setAiBar('Communication (10%)',row.commScore);
}

// AI Review page's big Grade letter + points line (score breakdown bars are
// already covered by setAiBar in renderDashboardKPIs since it's the same
// underlying row)
function renderAIReview(){
  const row=getDashboardRow();
  const gradeEl=document.getElementById('aiGradeLetter');
  const ptsEl=document.getElementById('aiPointsText');
  if (!row){
    if (gradeEl) gradeEl.textContent='—';
    if (ptsEl) ptsEl.textContent='No data logged yet';
    return;
  }
  if (gradeEl) gradeEl.textContent=row.grade;
  if (ptsEl) ptsEl.textContent=`${row.score} / 100 points`;
}

// Brand to manager mapping - always use this
const brandManagers = {
  'GeoInfotech': 'Malik Okunlaya',
  'Geoinfo Academy': 'Boluwatife Olu-Ajayi',
  'Geostore': 'Peter Sylvester'
};

// Per-platform performance log — one row per social media per week.
function renderLogTable(){
  const t=document.getElementById('engLogTable');
  // Ensure manager name is always correct for brand
  logData.forEach(r => { if(brandManagers[r.brand]) r.mgr = brandManagers[r.brand]; });
  t.innerHTML=`<thead><tr><th>Week</th><th>Platform</th><th>Manager</th><th>Brand</th><th>Likes</th><th>Comments</th><th>Reposts</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th></tr></thead><tbody>${logData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk}</td><td><span class="pill pill-blue">${r.plat}</span></td><td>${r.mgr}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.likes.toLocaleString()}</td><td>${r.comments}</td><td>${r.reposts}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td></tr>`).join('')}</tbody>`;
}

// Overall performance log — all 7 KPIs combined across platforms, per brand per week.
function renderReportsTable(){
  document.getElementById('reportsTable').innerHTML=`<thead><tr><th>Week</th><th>Manager</th><th>Brand</th><th>Engagement</th><th>Leads</th><th>Followers</th><th>SEO%</th><th>Branding</th><th>Audience</th><th>Comm</th><th>Score</th><th>Grade</th></tr></thead><tbody>${overallData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk}</td><td>${brandManagers[r.brand]||''}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${(r.likes+r.comments+r.reposts).toLocaleString()}</td><td>${r.leads}</td><td>${r.followers}</td><td>${r.seoScore!=null?r.seoScore+'%':'—'}</td><td>${r.brandingScore!=null?r.brandingScore:'—'}</td><td>${r.audienceScore!=null?r.audienceScore:'—'}</td><td>${r.commScore!=null?r.commScore:'—'}</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td></tr>`).join('')}</tbody>`;
}

// Platform Log Tracker — groups the raw per-platform rows by the same
// brand+week key used for the Overall aggregation, so managers/admin can see
// exactly which platforms have been logged (and their individual numbers)
// behind each week's Overall row on the Reports page.
function renderPlatformTracker(){
  const container = document.getElementById('platformTracker');
  if (!container) return;

  const ALL_PLATFORMS = ['Facebook','Instagram','Twitter/X','LinkedIn'];
  const groups = {};
  logData.forEach(r => {
    const key = r.brand + '||' + r.wk;
    if (!groups[key]) groups[key] = { brand: r.brand, wk: r.wk, mgr: r.mgr, rows: [], latestCreatedAt: r.createdAt || 0 };
    groups[key].rows.push(r);
    if (r.createdAt && new Date(r.createdAt) > new Date(groups[key].latestCreatedAt || 0)) groups[key].latestCreatedAt = r.createdAt;
  });

  const groupList = Object.values(groups).sort((a,b) => new Date(b.latestCreatedAt || 0) - new Date(a.latestCreatedAt || 0));

  if (!groupList.length) {
    container.innerHTML = `<div style="padding:20px;color:var(--sub2);font-size:13px">No weeks logged yet.</div>`;
    return;
  }

  container.innerHTML = groupList.map(g => {
    const overall = overallData.find(o => o.brand === g.brand && o.wk === g.wk);
    const loggedPlatforms = new Set(g.rows.map(r => r.plat));
    const platformPills = ALL_PLATFORMS.map(p => {
      const done = loggedPlatforms.has(p);
      return `<span class="pill ${done?'pill-met':'pill-miss'}" style="margin-right:4px">${done?'✓':'✗'} ${p}</span>`;
    }).join('');
    const extraPlatforms = [...loggedPlatforms].filter(p => !ALL_PLATFORMS.includes(p));
    const extraPills = extraPlatforms.map(p => `<span class="pill pill-blue" style="margin-right:4px">✓ ${p}</span>`).join('');

    return `
      <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <div>
            <span style="font-weight:800;font-size:14px;color:var(--navy)">${g.wk}</span>
            <span class="pill pill-blue" style="margin-left:8px">${g.brand}</span>
            <span style="color:var(--sub2);font-size:12px;margin-left:6px">${g.mgr}</span>
          </div>
          <div style="text-align:right">${overall ? `<div style="font-size:10px;color:var(--sub2);text-transform:uppercase;letter-spacing:.4px">Week's Overall Score</div><span style="font-weight:800;font-size:15px">${overall.score}</span> <span style="font-weight:700;color:${overall.score>=80?'var(--green)':overall.score>=70?'var(--amber)':'var(--red)'}">${overall.grade}</span>` : ''}</div>
        </div>
        <div style="margin-bottom:10px">${platformPills}${extraPills}</div>
        <table class="sp-table"><thead><tr><th>Platform</th><th>Likes</th><th>Comments</th><th>Reposts</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th></tr></thead><tbody>
          ${g.rows.map(r=>`<tr><td><span class="pill pill-blue">${r.plat}</span></td><td>${r.likes.toLocaleString()}</td><td>${r.comments}</td><td>${r.reposts}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:700">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td></tr>`).join('')}
        </tbody></table>
      </div>`;
  }).join('');
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
function setBrand(btn,b){document.querySelectorAll('.bpill').forEach(c=>c.classList.remove('active'));btn.classList.add('active');selectedDashboardBrand=b;renderDashboardKPIs();renderAIReview();showToast('Switched to '+b);}
function setLBPeriod(btn,p){document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));btn.classList.add('active');showToast('Leaderboard: '+btn.textContent);}
function selKPI(card,k){document.querySelectorAll('#page-dashboard .stat-card').forEach(c=>c.classList.remove('sel'));card.classList.add('sel');}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
// Every platform gets its own row for the week (Facebook, Instagram, etc. all
// log separately). Branding/Audience/Communication scores apply once per
// brand per week, so they're upserted into weekly_qualitative regardless of
// which platform's log this was.
async function submitLog(){
  const brandSelectEl = document.getElementById('lgBrand');
  const selBrand = brandSelectEl ? brandSelectEl.value.replace(/ \(.*\)/,'') : (currentUser && currentUser.brand) || 'GeoInfotech';
  const mgrName = brandManagers[selBrand] || (currentUser ? currentUser.name : 'Unknown');

  const platformEl = document.getElementById('lgPlatform');
  const platform = platformEl ? platformEl.value : 'All Platforms';
  const weekEndEl = document.getElementById('lgWeekEnd');
  const weekEndingVal = weekEndEl ? weekEndEl.value : '';
  const weekLabel = getWeekLabel(weekEndingVal);

  const likes = +document.getElementById('lgLikes').value || 0;
  const comments = +document.getElementById('lgComments').value || 0;
  const reposts = +document.getElementById('lgReposts').value || 0;
  const followers = +document.getElementById('lgFollowers').value || 0;
  const leads = +document.getElementById('lgLeads').value || 0;
  const score = calcScore({ likes, comments, reposts, followers, leads });
  const grade = gradeFor(score);

  // Resubmitting the same platform for a week that's already logged updates
  // that row instead of creating a duplicate (matches the DB unique index on
  // brand+week_label+platform).
  const existing = logData.find(r => r.brand === selBrand && r.wk === weekLabel && r.plat === platform);

  const brandingScoreVal = document.getElementById('lgBrandingScore').value;
  const audienceScoreVal = document.getElementById('lgAudienceScore').value;
  const commScoreVal = document.getElementById('lgCommScore').value;
  const brandNotesVal = document.getElementById('lgBrandNotes').value;
  const audienceNotesVal = document.getElementById('lgAudienceNotes').value;
  const commNotesVal = document.getElementById('lgCommNotes').value;

  const submitBtn = document.querySelector('#logModal .btn-blue');
  const originalText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.textContent = 'Saving...'; submitBtn.disabled = true; }

  try {
    const fields = { likes, comments, reposts, followers, leads, score, grade, week_ending: weekEndingVal || null };
    if (existing) {
      if (existing._id) await updateWeeklyLog(existing._id, fields);
    } else {
      await insertWeeklyLog({ week_label: weekLabel, manager: mgrName, brand: selBrand, platform, ...fields });
    }

    // Only touch the shared weekly qualitative row if the manager actually
    // filled something in — leaving these blank keeps whatever's already saved.
    const qualFields = {};
    if (brandingScoreVal !== '') qualFields.branding_score = Math.max(0, Math.min(100, +brandingScoreVal));
    if (audienceScoreVal !== '') qualFields.audience_score = Math.max(0, Math.min(100, +audienceScoreVal));
    if (commScoreVal !== '') qualFields.comm_score = Math.max(0, Math.min(100, +commScoreVal));
    if (brandNotesVal) qualFields.brand_notes = brandNotesVal;
    if (audienceNotesVal) qualFields.audience_notes = audienceNotesVal;
    if (commNotesVal) qualFields.comm_notes = commNotesVal;
    if (Object.keys(qualFields).length) {
      await upsertQualitative(selBrand, weekLabel, weekEndingVal, qualFields);
    }

    await refreshAllData();
    closeModal('logModal');
    showToast(existing ? `${platform} updated for ${weekLabel}` : `${platform} logged for ${weekLabel}`);
    ['lgLikes','lgComments','lgReposts','lgFollowers','lgLeads','lgBrandingScore','lgAudienceScore','lgCommScore'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['lgBrandNotes','lgAudienceNotes','lgCommNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    if (weekEndEl) weekEndEl.value = '';
  } catch (e) {
    console.error(e);
    showToast('Could not sync — check connection');
  } finally {
    if (submitBtn) { submitBtn.textContent = originalText; submitBtn.disabled = false; }
  }
}

// Sends the Branding/Audience/Communication notes to the score-qualitative
// Edge Function, which asks Claude to grade them and writes the scores
// straight into weekly_qualitative. Fills the 3 score fields in the modal
// with the result so the manager can review before submitting.
// Requires the Edge Function to be deployed with an ANTHROPIC_API_KEY secret
// set — see supabase/functions/score-qualitative/index.ts for setup steps.
async function requestAIScoring(){
  const brandSelectEl = document.getElementById('lgBrand');
  const selBrand = brandSelectEl ? brandSelectEl.value.replace(/ \(.*\)/,'') : (currentUser && currentUser.brand) || 'GeoInfotech';
  const weekEndEl = document.getElementById('lgWeekEnd');
  const weekEndingVal = weekEndEl ? weekEndEl.value : '';
  const weekLabel = getWeekLabel(weekEndingVal);

  const brandNotes = document.getElementById('lgBrandNotes').value;
  const audienceNotes = document.getElementById('lgAudienceNotes').value;
  const commNotes = document.getElementById('lgCommNotes').value;

  if (!brandNotes && !audienceNotes && !commNotes) {
    showToast('Write some notes first so the AI has something to score');
    return;
  }

  const btn = document.getElementById('aiScoreBtn');
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Scoring...'; btn.disabled = true; }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/score-qualitative`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ brand: selBrand, weekLabel, weekEnding: weekEndingVal, brandNotes, audienceNotes, commNotes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI scoring failed');

    document.getElementById('lgBrandingScore').value = data.branding_score;
    document.getElementById('lgAudienceScore').value = data.audience_score;
    document.getElementById('lgCommScore').value = data.comm_score;
    showToast('AI scored — review and submit');
  } catch (e) {
    console.error(e);
    showToast('AI scoring isn\'t set up yet — enter scores manually');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

async function submitSEO(){
  const brandSelectEl = document.getElementById('seoBrand');
  const selBrand = brandSelectEl ? brandSelectEl.value.replace(/ \(.*\)/,'') : (currentUser && currentUser.brand) || 'GeoInfotech';
  const weekEndEl = document.getElementById('seoWeekEnd');
  const weekLabel = getWeekLabel(weekEndEl ? weekEndEl.value : '');

  const entry = {
    brand: selBrand,
    week_label: weekLabel,
    title: document.getElementById('seoTitle').value || 'New Post',
    keyword: document.getElementById('seoKw').value || '—',
    category: document.getElementById('seoCat').value,
    rank: document.getElementById('seoRank').value,
    verified: 'Pending'
  };

  const submitBtn = document.querySelector('#seoModal .btn-blue');
  const originalText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.textContent = 'Saving...'; submitBtn.disabled = true; }

  try {
    await insertSeoPost(entry);
    await refreshAllData();
    closeModal('seoModal');
    showToast('Blog post logged');
    ['seoTitle','seoKw'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const notesEl = document.getElementById('seoNotes'); if (notesEl) notesEl.value = '';
    if (weekEndEl) weekEndEl.value = '';
  } catch (e) {
    console.error(e);
    showToast('Could not sync — check connection');
  } finally {
    if (submitBtn) { submitBtn.textContent = originalText; submitBtn.disabled = false; }
  }
}
function saveSettings(){showToast('KPI targets saved');}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
document.querySelectorAll('.modal-overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');}));