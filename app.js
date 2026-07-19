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

// Fetch the persisted Platform Weekly Target "actuals" (one row per
// brand+week+platform, judged against the static PLATFORM_WEEKLY_TARGETS).
async function fetchPlatformActuals() {
  try {
    const rows = await sbFetch('platform_weekly_actuals?select=*&order=created_at.desc');
    return rows || [];
  } catch (e) {
    console.error('Failed to fetch platform weekly actuals:', e);
    return null;
  }
}

async function insertPlatformActual(entry) {
  return sbFetch('platform_weekly_actuals', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(entry)
  });
}

async function updatePlatformActual(id, fields) {
  return sbFetch(`platform_weekly_actuals?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(fields)
  });
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

// One "actual" number per brand+week+platform, judged against the static
// PLATFORM_WEEKLY_TARGETS. Always logs against THIS calendar week (same
// Sunday-ending weekly bucketing used everywhere else in the app) — update
// the existing row if this platform already has an actual for this week,
// else create it.
async function upsertPlatformActual(brand, platform, actualValue) {
  const weekLabel = getWeekLabel();
  const weekEnding = weekBucketKey(weekBucketFromDate());
  const existing = platformActualsData.find(r => r.brand === brand && r.wk === weekLabel && r.plat === platform);
  if (existing && existing.id) {
    return updatePlatformActual(existing.id, { actual: actualValue });
  }
  return insertPlatformActual({ brand, week_label: weekLabel, week_ending: weekEnding, platform, actual: actualValue });
}

// ═══ SCORING ALGORITHM ═══
// Weekly targets, matching the numbers already shown in the KPI cards/Settings page.
const KPI_TARGETS = { engagement: 600, leads: 10, followers: 400, seoPosts: 10 };
// Weight of each of the 7 KPIs in the full composite score (sums to 100).
const KPI_WEIGHTS = { engagement: 20, leads: 25, followers: 10, seo: 10, branding: 15, audience: 10, comm: 10 };

// ═══ PER-PLATFORM LOG FIELDS ═══
// Each social media platform's Log Week form shows its own distinct set of
// metrics (matching what that platform's real analytics screen surfaces).
// "Leads Generated" stays a separate universal field below these since none
// of these platforms report leads directly, but leads is still 25% of score.
const PLATFORM_FIELDS = {
  'Facebook': [
    { key: 'views', label: 'Views' },
    { key: 'viewers', label: 'Viewers' },
    { key: 'shares', label: 'Shares' },
    { key: 'reactions', label: 'Reactions' },
    { key: 'comments', label: 'Comments' },
    { key: 'totalFollowers', label: 'Total Followers' },
    { key: 'newFollowers', label: 'New Followers' },
    { key: 'unfollows', label: 'Unfollows' }
  ],
  'LinkedIn': [
    { key: 'impressions', label: 'Impressions' },
    { key: 'likes', label: 'Likes' },
    { key: 'reactions', label: 'Reactions' },
    { key: 'reposts', label: 'Reposts' },
    { key: 'comments', label: 'Comments' },
    { key: 'totalFollowers', label: 'Total Followers' },
    { key: 'newFollowers', label: 'New Followers' },
    { key: 'connections', label: 'Connections' }
  ],
  'Twitter': [
    { key: 'impressions', label: 'Impressions' },
    { key: 'totalFollowers', label: 'Total Followers' },
    { key: 'newFollowers', label: 'New Followers' }
  ],
  'TikTok': [
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'totalViewers', label: 'Total Viewers' },
    { key: 'newViewers', label: 'New Viewers' },
    { key: 'shares', label: 'Shares' },
    { key: 'comments', label: 'Comments' },
    { key: 'followers', label: 'Followers' },
    { key: 'newFollowers', label: 'New Followers' }
  ],
  'Instagram': [
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'profileVisits', label: 'Profile Visits' },
    { key: 'reach', label: 'Reach' },
    { key: 'interactions', label: 'Interactions' },
    { key: 'followers', label: 'Followers' },
    { key: 'newFollowers', label: 'New Followers' },
    { key: 'unfollows', label: 'Unfollows' }
  ],
  'YouTube': [
    { key: 'watchTime', label: 'Watch Time (hrs)' },
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'impressions', label: 'Impressions' },
    { key: 'subscribers', label: 'Subscribers' },
    { key: 'newSubs', label: 'New Subs' }
  ]
};

// Which of each platform's PLATFORM_FIELDS keys represent a follower-count
// style number (a snapshot total, or that week's follower growth) rather
// than an engagement action. These feed Follower Growth (10% weight)
// instead, via followerGrowthKeys, and are the ONLY fields excluded when
// Engagement (20% weight) is totaled below — every other Platform Metrics
// field entered for that platform (Views, Likes, Shares, Reactions,
// Comments, Reposts, Reach, Profile Visits, Interactions, Impressions,
// Watch Time, etc.) now counts toward Engagement, so the number always
// tallies with everything actually typed into the Log Week form.
const FOLLOWER_FIELD_KEYS = {
  'Facebook':      { growth: ['newFollowers'],              excludeFromEngagement: ['totalFollowers', 'newFollowers', 'unfollows'] },
  'LinkedIn':       { growth: ['newFollowers', 'connections'], excludeFromEngagement: ['totalFollowers', 'newFollowers', 'connections'] },
  'Twitter':       { growth: ['newFollowers'],              excludeFromEngagement: ['totalFollowers', 'newFollowers'] },
  'TikTok':        { growth: ['newFollowers'],              excludeFromEngagement: ['followers', 'newFollowers'] },
  'Instagram':     { growth: ['newFollowers'],              excludeFromEngagement: ['followers', 'newFollowers', 'unfollows'] },
  'YouTube':       { growth: ['newSubs'],                   excludeFromEngagement: ['subscribers', 'newSubs'] },
  'Google Search': { growth: [],                            excludeFromEngagement: [] },
  'Jiji':          { growth: [],                            excludeFromEngagement: [] }
};

// Maps each platform's raw Log Week fields into the two numbers the scoring
// engine needs: Engagement (sum of every entered Platform Metrics field
// except the follower-tracking ones above — so it's driven entirely by
// PLATFORM_FIELDS and always matches what was actually logged) and Follower
// Growth (sum of that platform's growth field(s) — e.g. LinkedIn counts both
// New Followers and Connections, matching how it always has).
function getEngagementAndFollowers(platform, v) {
  const fields = PLATFORM_FIELDS[platform] || [];
  const conf = FOLLOWER_FIELD_KEYS[platform] || { growth: [], excludeFromEngagement: [] };
  // Rounded because YouTube's "Watch Time (hrs)" can be entered as a decimal
  // (e.g. 4.5) — every other field is already a whole number, so without
  // this the total would display an odd trailing decimal like "21,109.1".
  const engagement = Math.round(fields.reduce((sum, f) => conf.excludeFromEngagement.includes(f.key) ? sum : sum + (v[f.key] || 0), 0));
  const followerGrowth = conf.growth.reduce((sum, key) => sum + (v[key] || 0), 0);
  return { engagement, followerGrowth };
}

// Which raw_metrics label represents each platform's "Total Followers"-style
// snapshot and "Impressions"-style reach number. Field names aren't
// identical across platforms (Instagram/TikTok call it "Followers" not
// "Total Followers"; Facebook/Instagram/TikTok report "Views" instead of
// "Impressions"), so this maps each platform to whichever label it actually
// has, letting the Platform Totals charts show all 6 platforms consistently.
const TOTAL_FOLLOWERS_LABEL = { 'Facebook': 'Total Followers', 'LinkedIn': 'Total Followers', 'Twitter': 'Total Followers', 'TikTok': 'Followers', 'Instagram': 'Followers', 'YouTube': 'Subscribers' };
const IMPRESSIONS_LABEL = { 'Facebook': 'Views', 'LinkedIn': 'Impressions', 'Twitter': 'Impressions', 'TikTok': 'Views', 'Instagram': 'Views', 'YouTube': 'Impressions' };

// One distinct color per platform, reused across every Platform Totals /
// Trend Analysis chart and insight card so the whole report stays visually
// consistent. Hex values match this app's own CSS variables (--blue, --teal,
// --purple, --pink, --amber, --red) rather than an unrelated palette, so the
// charts blend with the rest of SMPIS instead of looking bolted on.
const PLATFORM_COLORS = {
  'Facebook':  { hex: '#2878C8', bgVar: 'var(--blue-light)',  textVar: 'var(--blue)' },
  'LinkedIn':  { hex: '#0d9488', bgVar: 'var(--teal-bg)',     textVar: 'var(--teal)' },
  'Twitter':   { hex: '#7c3aed', bgVar: 'var(--purple-bg)',   textVar: 'var(--purple)' },
  'TikTok':    { hex: '#db2777', bgVar: 'var(--pink-bg)',     textVar: 'var(--pink)' },
  'Instagram': { hex: '#d97706', bgVar: 'var(--amber-bg)',    textVar: 'var(--amber)' },
  'YouTube':   { hex: '#dc2626', bgVar: 'var(--red-bg)',      textVar: 'var(--red)' },
  'Google Search': { hex: '#4285F4', bgVar: 'var(--indigo-bg)', textVar: 'var(--indigo)' },
  'Jiji':          { hex: '#16a34a', bgVar: 'var(--green-bg)',  textVar: 'var(--green)' }
};

// Formats a stored raw_metrics object (keyed by human-readable label, e.g.
// {"Views": 4663, "Shares": 26}) into a compact "Label: value · Label: value"
// string for table "Details" columns. Skips zero/blank values to stay short.
function fmtRawMetrics(raw) {
  if (!raw || typeof raw !== 'object') return '—';
  const entries = Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && v !== 0 && v !== '');
  if (!entries.length) return '—';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString() : v}`).join(' · ');
}

// Escapes a string for safe use inside an HTML attribute (e.g. title="...").
function escAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Builds the Log Week modal's platform-specific input fields for whichever
// platform is currently selected. Field ids are prefixed "pf_" and only one
// platform's set exists in the DOM at a time (the whole container is replaced
// on every platform switch), so there's no id collision even though several
// platforms share field names like "Views" or "Likes".
function renderPlatformFieldInputs(platform) {
  const container = document.getElementById('platformFieldsContainer');
  if (!container) return;
  const fields = PLATFORM_FIELDS[platform] || [];
  let html = '';
  for (let i = 0; i < fields.length; i += 2) {
    const a = fields[i], b = fields[i + 1];
    html += `<div class="form-row"><div class="form-group"><label>${a.label}</label><input type="number" id="pf_${a.key}" placeholder="0"></div>`;
    html += b ? `<div class="form-group"><label>${b.label}</label><input type="number" id="pf_${b.key}" placeholder="0"></div></div>` : `</div>`;
  }
  container.innerHTML = html;
}

// Fired when the Platform dropdown changes (and once on load for the default
// selection) so the form always shows the right fields for that platform.
function onLgPlatformChange() {
  const platformEl = document.getElementById('lgPlatform');
  const platform = platformEl ? platformEl.value : 'Facebook';
  renderPlatformFieldInputs(platform);
}

// Turns a "Week Ending" date into a stable label so that logging multiple
// platforms for the same real week produces the SAME week, instead of a
// fresh "Wk N" every time someone hits submit.
// This is a WEEKLY system, so any date — whichever day of the week it
// actually falls on — always snaps forward to the Sunday that ends its
// calendar week. Without this, two managers logging the same intended week
// on different days (or the "Week Ending" field being left blank, which
// used to fall back to the literal date of whichever day someone hit
// Submit) would each mint their own brand-new "week", producing daily-
// looking labels like "Jul 1", "Jul 2", "Jul 3" instead of one real week.
function weekBucketFromDate(dateStr) {
  const d = dateStr ? new Date(String(dateStr).length <= 10 ? dateStr + 'T00:00:00' : dateStr) : new Date();
  const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
  const daysToAdd = (7 - day) % 7;
  const weekEnd = new Date(d);
  weekEnd.setDate(d.getDate() + daysToAdd);
  return weekEnd;
}
function weekBucketKey(dateObj) {
  // Local calendar date, NOT toISOString() (which converts to UTC first).
  // A bucket date built from a plain "YYYY-MM-DD" string always lands on
  // local midnight; in any positive-UTC-offset timezone (e.g. WAT, UTC+1),
  // toISOString() would roll that back into the previous UTC day, making
  // this key silently one day earlier than the date actually shown anywhere
  // else in the app (getWeekLabel/weekBucketLabel use local fields and are
  // unaffected, which is what made this so easy to miss). Using local
  // fields directly keeps this key always in sync with the visible label.
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function weekBucketLabel(dateObj) {
  return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getWeekLabel(dateStr) {
  return 'Wk of ' + weekBucketLabel(weekBucketFromDate(dateStr));
}

// Label for the calendar week immediately before this one — used to show a
// "last week" reference number alongside the This Week's Target vs Actual
// table, so a manager can see what they're comparing against without
// scrolling down to the chart.
function getPrevWeekLabel() {
  const prevWeekBucket = weekBucketFromDate();
  prevWeekBucket.setDate(prevWeekBucket.getDate() - 7);
  return 'Wk of ' + weekBucketLabel(prevWeekBucket);
}

// Short "Jun 26" style formatting for the Week Start date, used anywhere the
// log tables show the full week range instead of just the week-ending label.
function fmtDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Composite score from the quantifiable KPIs this form actually collects
// (Engagement 20%, Leads 25%, Followers 10% = 55% of the full weighting
// model). Rescaled to a 0-100 scale since SEO/Branding/Audience/Communication
// (the remaining 45%) are AI/manually scored elsewhere and aren't part of
// this form yet.
function calcScore({ engagementTotal = 0, followers = 0, leads = 0 }) {
  const engScore = Math.min(engagementTotal / KPI_TARGETS.engagement * 100, 100);
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
function calcFullScore({ engagementTotal = 0, followers = 0, leads = 0, seoScore = null, brandingScore = null, audienceScore = null, commScore = null }) {
  const engScore = Math.min(engagementTotal / KPI_TARGETS.engagement * 100, 100);
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
    weekStart: row.week_start,
    weekEnding: row.week_ending,
    mgr: row.manager,
    brand: row.brand,
    plat: row.platform || 'All Platforms',
    engagementTotal: row.engagement_total || 0,
    rawMetrics: row.raw_metrics || {},
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
    audienceScore: row.audience_score,
    createdAt: row.created_at
  };
}

// Map a platform_weekly_actuals row
function mapRowToTargetEntry(row) {
  return {
    id: row.id,
    brand: row.brand,
    wk: row.week_label,
    weekEnding: row.week_ending,
    plat: row.platform,
    actual: row.actual != null ? row.actual : 0,
    createdAt: row.created_at
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
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
    createdAt: row.created_at
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
      groups[key] = { brand: r.brand, wk: r.wk, weekEnding: r.weekEnding, mgr: r.mgr, engagementTotal: 0, followers: 0, leads: 0, platforms: [], latestCreatedAt: r.createdAt || 0 };
    }
    const g = groups[key];
    g.engagementTotal += r.engagementTotal; g.followers += r.followers; g.leads += r.leads;
    g.platforms.push(r.plat);
    if (!g.weekEnding && r.weekEnding) g.weekEnding = r.weekEnding;
    if (r.createdAt && new Date(r.createdAt) > new Date(g.latestCreatedAt || 0)) g.latestCreatedAt = r.createdAt;
  });

  // AI Branding/Target Audience/Communication notes (weekly_qualitative) and
  // SEO posts are entered from their own separate pages/actions, so a
  // manager can very easily write and save this week's qualitative notes —
  // or log a blog post — before logging any platform's metrics for that same
  // week. Without a group for that week already, getDashboardRow()/
  // latestOverallForBrand() (which only ever look inside this aggregated
  // list) can never find it again, so the notes/scores or post look like
  // they silently vanished even though they really did save to the
  // database. Make sure every qualRows/seoRows week gets a group too, not
  // just weeks that already have a platform log.
  qualRows.forEach(q => {
    const key = q.brand + '||' + q.wk;
    if (!groups[key]) {
      groups[key] = { brand: q.brand, wk: q.wk, weekEnding: q.weekEnding || null, mgr: brandManagers[q.brand] || '—', engagementTotal: 0, followers: 0, leads: 0, platforms: [], latestCreatedAt: q.createdAt || 0 };
    } else if (q.createdAt && new Date(q.createdAt) > new Date(groups[key].latestCreatedAt || 0)) {
      groups[key].latestCreatedAt = q.createdAt;
    }
  });
  seoRows.forEach(s => {
    const key = s.brand + '||' + s.wk;
    if (!groups[key]) {
      groups[key] = { brand: s.brand, wk: s.wk, weekEnding: null, mgr: brandManagers[s.brand] || '—', engagementTotal: 0, followers: 0, leads: 0, platforms: [], latestCreatedAt: s.createdAt || 0 };
    } else if (s.createdAt && new Date(s.createdAt) > new Date(groups[key].latestCreatedAt || 0)) {
      groups[key].latestCreatedAt = s.createdAt;
    }
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
      engagementTotal: g.engagementTotal, followers: g.followers, leads: g.leads,
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
function currentDashboardBrand() {
  return (currentUser && currentUser.role === 'manager') ? currentUser.brand : selectedDashboardBrand;
}
function getDashboardRow() {
  return latestOverallForBrand(currentDashboardBrand());
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

    // KPI Targets & Weights is Admin-only — managers never get access to
    // change scoring targets.
    const settingsNav = document.getElementById('navSettingsItem');
    if (settingsNav) settingsNav.style.display = 'none';

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
  const [rawLogs, rawQual, rawSeo, rawTargets] = await Promise.all([fetchWeeklyLogs(), fetchQualitative(), fetchSeoPosts(), fetchPlatformActuals()]);

  if (rawLogs === null && rawQual === null && rawSeo === null && rawTargets === null) {
    showToast('Offline — showing local data');
    return;
  }

  logData = (rawLogs || []).map(mapRowToLogEntry);
  qualitativeData = (rawQual || []).map(mapRowToQualEntry);
  seoPostsData = (rawSeo || []).map(mapRowToSeoEntry);
  platformActualsData = (rawTargets || []).map(mapRowToTargetEntry);

  // Managers only see their own brand's data
  if (currentUser && currentUser.role === 'manager') {
    logData = logData.filter(r => r.brand === currentUser.brand);
    qualitativeData = qualitativeData.filter(r => r.brand === currentUser.brand);
    seoPostsData = seoPostsData.filter(r => r.brand === currentUser.brand);
    platformActualsData = platformActualsData.filter(r => r.brand === currentUser.brand);
  }

  overallData = aggregateOverall(logData, qualitativeData, seoPostsData);

  renderLogTable();
  renderReportsTable();
  renderPlatformTracker();
  renderPlatformTotalsCharts();
  renderTrendAnalysis();
  renderPlatformTargets();
  renderAllKPIPages();
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
// aspectRatio:2.2 gives a sensible wide/short shape by default (Chart.js
// otherwise infers ratio from the canvas's initial width/height HTML
// attributes, which — for these wide dashboard cards — made charts render
// far taller than intended). Any explicit aspectRatio in `extra` still wins.
function bOpt(extra={}){return{responsive:true,aspectRatio:2.2,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:tt,...(extra.plugins||{})},scales:{x:{grid:gr,ticks:ch},y:{grid:gr,ticks:ch,beginAtZero:true}},...extra};}

// All real, all fetched from Supabase after login (see refreshAllData).
// Empty until then — the login screen covers the UI so there's nothing to
// show prematurely.
let logData = [];          // raw per-platform weekly_logs rows
let qualitativeData = [];  // per-brand-per-week Branding/Audience/Comm scores
let seoPostsData = [];     // persisted blog post log
let overallData = [];      // aggregated per-brand-per-week Overall rows (newest first)
let platformActualsData = []; // per-brand-per-week-per-platform "actual" numbers logged against PLATFORM_WEEKLY_TARGETS

// Static weekly output target per platform — fixed per the spec ("the
// weekly target for each social media will be static"), not user-editable.
// Whatever number a manager logs as that week's "actual" gets judged
// against this to decide Met/Missed.
const PLATFORM_WEEKLY_TARGETS = { 'Facebook': 100, 'LinkedIn': 100, 'Twitter': 10, 'TikTok': 50, 'Instagram': 50, 'YouTube': 50 };

window.onload=()=>{
  // Score donut
  window.scoreDonutObj=new Chart(document.getElementById('scoreDonut'),{type:'doughnut',data:{labels:['Score','Remaining'],datasets:[{data:[0,100],backgroundColor:['#2878C8','#e5f0fa'],borderWidth:0}]},options:{cutout:'70%',plugins:{legend:{display:false},tooltip:{enabled:false}}}});
  // Main chart
  window.mainChartObj=new Chart(document.getElementById('mainChart'),{type:'line',data:{labels:W,datasets:[
    {label:'Engagement',data:[45,120,85,200,310,180,420,580],borderColor:'#2878C8',backgroundColor:'rgba(40,120,200,0.07)',fill:true,tension:0.4,pointRadius:3,borderWidth:2.5},
    {label:'Target',data:Array(8).fill(150),borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // AI hist — shell only; renderAIHistChart() fills it with real weekly
  // composite score history for the current brand once data has loaded.
  window.aiHistChartObj=new Chart(document.getElementById('aiHistChart'),{type:'line',data:{labels:[],datasets:[
    {label:'Score',data:[],borderColor:'#2878C8',backgroundColor:'rgba(40,120,200,0.07)',fill:true,tension:0.4,pointRadius:3,borderWidth:2.5},
    {label:'Target',data:[],borderColor:'#d97706',borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false}
  ]},options:{...bOpt(),plugins:{legend:{display:true,labels:{color:'#64748b',font:{size:11,family:'Inter'},boxWidth:10,padding:14}},tooltip:tt}}});
  // engChart, engDonut, leadsChart, audChart, commChart, flwChart,
  // brandScoreTrendChart and aiBrandTrendChart are all created on first use
  // by renderEngagementKPIPage/renderLeadsKPIPage/renderFollowersKPIPage/
  // renderAudienceKPIPage/renderCommsKPIPage/renderBrandingKPIPage/
  // renderAIReview (via renderTrendChart/renderQualTrendChart/
  // renderEngagementDonut), which run right after this once real data has
  // loaded — see renderAllKPIPages().
  // Leaderboard chart
  window.lbChartObj=new Chart(document.getElementById('lbChart'),{type:'bar',data:{labels:['GeoInfotech','Geoinfo Academy','Geostore'],datasets:[{label:'Score',data:[0,0,0],backgroundColor:['#fbbf24','#94a3b8','#d97706'],borderRadius:8}]},options:{...bOpt(),indexAxis:'y',plugins:{legend:{display:false},tooltip:tt},scales:{x:{grid:gr,ticks:{...ch},max:100},y:{grid:{display:false},ticks:ch}}}});

  renderLBTable(); renderMiniLeaderboard(); renderSEOTable(); renderLogTable(); renderReportsTable(); renderPlatformTracker(); renderPlatformTotalsCharts(); renderTrendAnalysis(); renderAllKPIPages(); renderDashboardKPIs(); renderAIReview();
  onLgPlatformChange();
};

function switchMainTab(btn,key){
  document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  activeMainChartKey = key;
  renderMainChart();
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
  t.innerHTML=`<thead><tr><th>Week</th><th>Brand</th><th>Title</th><th>Keyword</th><th>Category</th><th>Date</th><th>Ranking</th><th>Admin Verify</th></tr></thead><tbody>${seoPostsData.map(r=>`<tr><td style="color:var(--sub2)">${r.wk||'—'}</td><td><span class="pill pill-blue">${r.brand}</span></td><td class="truncate-cell" style="max-width:260px" title="${escAttr(r.title)}">${r.title}</td><td class="truncate-cell" style="color:var(--sub);max-width:150px" title="${escAttr(r.keyword)}">${r.keyword}</td><td><span class="pill pill-blue">${r.cat}</span></td><td style="color:var(--sub2)">${r.date}</td><td><span class="pill ${rc(r.rank)}">${r.rank}</span></td><td><span style="font-size:12px;font-weight:600;color:${r.verified.includes('✓')?'var(--green)':'var(--amber)'}">${r.verified}</span></td></tr>`).join('')}</tbody>`;
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

// Generates real, data-driven weekly insight boxes — no fabricated text or
// numbers. Reads directly off the current Overall row for the brand, so the
// wording and every number in it changes exactly when the underlying real
// data changes. Used by both the Dashboard's "AI Weekly Review" card and
// the AI Review page's "AI Recommendations" card (same real signals,
// surfaced in two places for convenience).
function generateRealInsights(row){
  if (!row){
    return [{ title:'No data logged yet', body:'Log this week\'s platform numbers to see real insights here.', bg:'var(--bg)', border:'var(--sub2)', titleColor:'var(--sub2)' }];
  }
  const insights=[];

  if (row.brandingScore!=null){
    const s=row.brandingScore;
    if (s>=90) insights.push({ title:'Branding is excellent', body:`AI Branding Score of ${s} indicates strong content consistency this week.`, bg:'var(--green-bg)', border:'var(--green)', titleColor:'var(--green)' });
    else if (s>=75) insights.push({ title:'Branding is solid', body:`AI Branding Score of ${s} is above the 75+ target — keep the current content style going.`, bg:'var(--green-bg)', border:'var(--green)', titleColor:'var(--green)' });
    else insights.push({ title:'Branding needs attention', body:`AI Branding Score of ${s} is below the 75+ target this week.`, bg:'var(--amber-bg)', border:'var(--amber)', titleColor:'var(--amber)' });
  } else {
    insights.push({ title:'Branding not scored yet', body:'Write this week\'s branding notes on the AI Review page and click "Score With AI" to get a real score.', bg:'var(--bg)', border:'var(--sub2)', titleColor:'var(--sub2)' });
  }

  const leadsPct=Math.round((row.leads||0)/KPI_TARGETS.leads*100);
  if ((row.leads||0)>=KPI_TARGETS.leads) insights.push({ title:'Lead generation on target', body:`${row.leads} leads this week vs a target of ${KPI_TARGETS.leads} (${leadsPct}%). Keep the current CTA strategy going.`, bg:'var(--green-bg)', border:'var(--green)', titleColor:'var(--green)' });
  else insights.push({ title:'Lead generation needs attention', body:`${row.leads||0} leads vs a target of ${KPI_TARGETS.leads} (${leadsPct}% of target). Consider a stronger CTA in next week's posts.`, bg:'var(--amber-bg)', border:'var(--amber)', titleColor:'var(--amber)' });

  const flwPct=Math.round((row.followers||0)/KPI_TARGETS.followers*100);
  if ((row.followers||0)>=KPI_TARGETS.followers) insights.push({ title:'Follower growth on target', body:`${row.followers} new followers this week vs a target of ${KPI_TARGETS.followers} (${flwPct}%).`, bg:'var(--green-bg)', border:'var(--green)', titleColor:'var(--green)' });
  else insights.push({ title:'Follower growth below target', body:`${row.followers||0} new followers vs a target of ${KPI_TARGETS.followers} (${flwPct}% of target). Consider collaborations or giveaway posts to accelerate growth.`, bg:'var(--red-bg)', border:'var(--red)', titleColor:'var(--red)' });

  if (row.commScore!=null){
    const c=row.commScore;
    if (c>=75) insights.push({ title:'Communication score up', body:`Response time and comment engagement scored ${c}/100 this week. Keep this rhythm going.`, bg:'var(--green-bg)', border:'var(--green)', titleColor:'var(--green)' });
    else insights.push({ title:'Communication needs work', body:`Communication scored ${c}/100 this week, below the 75+ target.`, bg:'var(--amber-bg)', border:'var(--amber)', titleColor:'var(--amber)' });
  } else {
    insights.push({ title:'Communication not scored yet', body:'Write this week\'s communication notes on the AI Review page and click "Score With AI" to get a real score.', bg:'var(--bg)', border:'var(--sub2)', titleColor:'var(--sub2)' });
  }

  return insights;
}

function renderInsightsInto(containerId, row){
  const container=document.getElementById(containerId);
  if (!container) return;
  const insights=generateRealInsights(row);
  container.innerHTML=insights.map(it=>`<div class="ai-box" style="background:${it.bg};border-left-color:${it.border}"><div class="ai-box-title" style="color:${it.titleColor}">${it.title}</div><div class="ai-box-body">${it.body}</div></div>`).join('');
}

// Pushes the real Overall row for the currently-viewed brand into the
// Dashboard: the big score donut, the "Overall Performance Score" breakdown,
// and all 7 KPI stat cards.
function renderDashboardKPIs(){
  const row=getDashboardRow();
  const donutNum=document.getElementById('donutScoreNum');
  const overallNum=document.getElementById('overallScore');
  // Document order: the 4 g4 cards (Engagement/Leads/Follower Growth/SEO)
  // come first, then the 3 g3 cards (AI Branding/Target Audience/Comm) —
  // querySelectorAll always returns matches in tree order, so cards[0..6]
  // line up with that same order regardless of how the selector is written.
  const cards=document.querySelectorAll('#page-dashboard .stat-card');

  if (!row){
    if (donutNum) donutNum.textContent='—';
    if (overallNum) overallNum.textContent='—';
    if (window.scoreDonutObj){ window.scoreDonutObj.data.datasets[0].data=[0,100]; window.scoreDonutObj.update(); }
    fillStatCard(cards[0], { label:'Engagement', value:'—', delta:'No data logged yet', deltaColor:'var(--sub2)', thr:'Target: '+KPI_TARGETS.engagement.toLocaleString(), prog:0 });
    fillStatCard(cards[1], { label:'Leads Generated', value:'—', delta:'No data logged yet', deltaColor:'var(--sub2)', thr:'Target: '+KPI_TARGETS.leads, prog:0 });
    fillStatCard(cards[2], { label:'Follower Growth', value:'—', delta:'No data logged yet', deltaColor:'var(--sub2)', thr:'Target: '+KPI_TARGETS.followers, prog:0 });
    fillStatCard(cards[3], { label:'SEO Performance', value:'—', delta:'No data logged yet', deltaColor:'var(--sub2)', thr:'Target: 50%', prog:0 });
    fillStatCard(cards[4], { label:'AI Branding Score', value:'—/100', delta:'Not scored yet', deltaColor:'var(--sub2)', thr:'Target: 75+', prog:0 });
    fillStatCard(cards[5], { label:'Target Audience Quality', value:'—/100', delta:'Not scored yet', deltaColor:'var(--sub2)', thr:'Target: 70+', prog:0 });
    fillStatCard(cards[6], { label:'Communication Score', value:'—/100', delta:'Not scored yet', deltaColor:'var(--sub2)', thr:'Target: 75+', prog:0 });
    ['Engagement (20%)','Leads (25%)','Followers (10%)','SEO (10%)','AI Branding (15%)','Audience (10%)','Communication (10%)'].forEach(l=>setAiBar(l,null));
    renderInsightsInto('dashAiInsights', null);
    return;
  }

  if (donutNum) donutNum.textContent=row.score;
  if (overallNum) overallNum.textContent=row.score;
  if (window.scoreDonutObj){ window.scoreDonutObj.data.datasets[0].data=[row.score,100-row.score]; window.scoreDonutObj.update(); }

  const engPct=Math.round(row.engagementTotal/KPI_TARGETS.engagement*100);
  const engColor=engPct>=100?'var(--green)':engPct>=70?'var(--amber)':'var(--red)';
  fillStatCard(cards[0], { label:'Engagement', value:row.engagementTotal.toLocaleString(), delta:(engPct>=100?'✓ ':'')+engPct+'% of target', deltaColor:engColor, thr:'Target: '+KPI_TARGETS.engagement.toLocaleString(), prog:engPct, progColor:engColor });

  const leadsPct=Math.round((row.leads||0)/KPI_TARGETS.leads*100);
  const leadsColor=leadsPct>=100?'var(--green)':leadsPct>=70?'var(--amber)':'var(--red)';
  fillStatCard(cards[1], { label:'Leads Generated', value:row.leads, delta:(leadsPct>=100?'✓ ':'⚠ ')+leadsPct+'% of target', deltaColor:leadsColor, thr:'Target: '+KPI_TARGETS.leads, prog:leadsPct, progColor:leadsColor });

  const flwPct=Math.round((row.followers||0)/KPI_TARGETS.followers*100);
  const flwColor=flwPct>=100?'var(--green)':flwPct>=70?'var(--amber)':'var(--red)';
  fillStatCard(cards[2], { label:'Follower Growth', value:row.followers, delta:(flwPct>=100?'✓ ':'⚠ ')+flwPct+'% of target', deltaColor:flwColor, thr:'Target: '+KPI_TARGETS.followers, prog:flwPct, progColor:flwColor });

  const seoVal=row.seoScore;
  const seoColor=seoVal==null?'var(--sub2)':seoVal>=50?'var(--green)':'var(--red)';
  fillStatCard(cards[3], { label:'SEO Performance', value:seoVal!=null?seoVal+'%':'—', delta:seoVal==null?'No posts logged yet':(seoVal>=50?'✓ On target':'Below 50% target'), deltaColor:seoColor, thr:'Target: 50%', prog:seoVal||0, progColor:seoColor });

  const brandColor=row.brandingScore==null?'var(--sub2)':row.brandingScore>=75?'var(--purple)':row.brandingScore>=50?'var(--amber)':'var(--red)';
  fillStatCard(cards[4], { label:'AI Branding Score', value:(row.brandingScore!=null?row.brandingScore:'—')+'/100', delta:row.brandingScore==null?'Not scored yet':(row.brandingScore>=75?'✓ Above target':'Below target'), deltaColor:brandColor, thr:'Target: 75+', prog:row.brandingScore||0, progColor:brandColor });

  const audColor=row.audienceScore==null?'var(--sub2)':row.audienceScore>=70?'var(--teal)':'var(--amber)';
  fillStatCard(cards[5], { label:'Target Audience Quality', value:(row.audienceScore!=null?row.audienceScore:'—')+'/100', delta:row.audienceScore==null?'Not scored yet':(row.audienceScore>=70?'✓ Above target':'Below target'), deltaColor:audColor, thr:'Target: 70+', prog:row.audienceScore||0, progColor:audColor });

  const commColor=row.commScore==null?'var(--sub2)':row.commScore>=75?'var(--green)':'var(--amber)';
  fillStatCard(cards[6], { label:'Communication Score', value:(row.commScore!=null?row.commScore:'—')+'/100', delta:row.commScore==null?'Not scored yet':(row.commScore>=75?'✓ Above target':'Below target'), deltaColor:commColor, thr:'Target: 75+', prog:row.commScore||0, progColor:commColor });

  setAiBar('Engagement (20%)',row.engScore);
  setAiBar('Leads (25%)',row.leadsScore);
  setAiBar('Followers (10%)',row.followersScore);
  setAiBar('SEO (10%)',row.seoScore);
  setAiBar('AI Branding (15%)',row.brandingScore);
  setAiBar('Audience (10%)',row.audienceScore);
  setAiBar('Communication (10%)',row.commScore);

  renderInsightsInto('dashAiInsights', row);
}

// AI Review page's big Grade letter + points line (score breakdown bars are
// already covered by setAiBar in renderDashboardKPIs since it's the same
// underlying row)
function renderAIReview(){
  const brand=currentDashboardBrand();
  const row=getDashboardRow();
  const gradeEl=document.getElementById('aiGradeLetter');
  const ptsEl=document.getElementById('aiPointsText');
  renderQualitativeNotesSection();
  renderInsightsInto('aiRecommendationsBox', row);
  const brandSeries = buildQualSeries(brand, 'brandingScore');
  renderQualTrendChart('aiBrandTrendChart', 'aiBrandTrendChartObj', brandSeries, 'Branding Score', 'rgba(124,58,237,0.12)', '#7c3aed', 75, 'line');
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
  t.innerHTML=`<thead><tr><th>Start</th><th>Week</th><th>Platform</th><th>Manager</th><th>Brand</th><th>Engagement</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th><th>Details</th></tr></thead><tbody>${logData.map(r=>`<tr><td style="color:var(--sub2)">${fmtDateShort(r.weekStart)}</td><td style="color:var(--sub2)">${r.wk}</td><td><span class="pill pill-blue">${r.plat}</span></td><td>${r.mgr}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.engagementTotal.toLocaleString()}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td><td class="truncate-cell" style="color:var(--sub2);font-size:12px;max-width:220px" title="${escAttr(fmtRawMetrics(r.rawMetrics))}">${fmtRawMetrics(r.rawMetrics)}</td></tr>`).join('')}</tbody>`;
}

// Which period chip is currently selected for the Weekly Performance Log
// table (This Week / This Month / This Quarter / This Year) — same concept
// as the Dashboard's period-bar, just filtering table rows instead of a
// single stat.
let reportsPeriod = 'week';
function setReportsPeriod(el, period) {
  reportsPeriod = period;
  document.querySelectorAll('#reportsPeriodBar .pchip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderReportsTable();
}

// Whether a stored week_ending date falls inside the chosen period, measured
// against today's real date (so "This Week" always means the actual current
// calendar week, same definition weekBucketFromDate() uses everywhere else).
// Rows with no stored date always pass through rather than being silently
// hidden.
function weekInPeriod(weekEndingStr, period) {
  if (!weekEndingStr) return true;
  const d = new Date(weekEndingStr + 'T00:00:00');
  const now = new Date();
  if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (period === 'quarter') return d.getFullYear() === now.getFullYear() && Math.floor(d.getMonth() / 3) === Math.floor(now.getMonth() / 3);
  if (period === 'year') return d.getFullYear() === now.getFullYear();
  // 'week' (default): same calendar week as today, using the app's own
  // Sunday-ending week bucket so it matches every other "this week" concept.
  return weekBucketKey(weekBucketFromDate(d)) === weekBucketKey(weekBucketFromDate(now));
}

// Overall performance log — all 7 KPIs combined across platforms, per brand
// per week, filtered to whichever period chip is selected. Every row carries
// a "View Report" button (openWeekReportByIndex) that opens the full
// week-report modal for that exact overallData row — a Dashboard-style
// snapshot locked to that past week instead of always the latest one. The
// button always references the row's ORIGINAL index in overallData (not its
// position in the filtered list), so it still opens the right week.
function renderReportsTable(){
  const rows = overallData
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => weekInPeriod(r.weekEnding, reportsPeriod));
  const bodyHtml = rows.length
    ? rows.map(({ r, i }) => `<tr><td style="color:var(--sub2)">${r.wk}</td><td>${brandManagers[r.brand]||''}</td><td><span class="pill pill-blue">${r.brand}</span></td><td>${r.engagementTotal.toLocaleString()}</td><td>${r.leads}</td><td>${r.followers}</td><td>${r.seoScore!=null?r.seoScore+'%':'—'}</td><td>${r.brandingScore!=null?r.brandingScore:'—'}</td><td>${r.audienceScore!=null?r.audienceScore:'—'}</td><td>${r.commScore!=null?r.commScore:'—'}</td><td style="font-weight:800">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td><td><button class="btn-outline" style="font-size:11px;padding:6px 12px;white-space:nowrap" onclick="openWeekReportByIndex(${i})">View Report</button></td></tr>`).join('')
    : `<tr><td colspan="13" style="padding:16px;color:var(--sub2);font-size:13px">No weeks logged in this period.</td></tr>`;
  document.getElementById('reportsTable').innerHTML=`<thead><tr><th>Week</th><th>Manager</th><th>Brand</th><th>Engagement</th><th>Leads</th><th>Followers</th><th>SEO%</th><th>Branding</th><th>Audience</th><th>Comm</th><th>Score</th><th>Grade</th><th></th></tr></thead><tbody>${bodyHtml}</tbody>`;
}

// ═══ WEEK REPORT MODAL (Reports page) ═══
// A Dashboard-style full snapshot for one specific past week instead of
// always the latest one — lets managers/admin revisit and review any week
// they've ever logged, not just the current one. Built entirely from the
// same real data + same scoring/coloring conventions already used across the
// Dashboard/KPI pages, just locked to whichever overallData row was clicked.

function openWeekReportByIndex(i){
  const row = overallData[i];
  if (!row) { showToast('Could not find that week'); return; }
  renderWeekReportModal(row);
  openModal('weekReportModal');
}

function renderWeekReportModal(row){
  const titleEl = document.getElementById('wrTitle');
  const subEl = document.getElementById('wrSub');
  const gradeEl = document.getElementById('wrGrade');
  const scoreEl = document.getElementById('wrScore');
  if (titleEl) titleEl.textContent = row.wk;
  if (subEl) subEl.textContent = `${row.brand} · ${brandManagers[row.brand] || ''}`;
  const scoreColor = row.score>=80?'var(--green)':row.score>=70?'var(--amber)':'var(--red)';
  if (gradeEl) { gradeEl.textContent = row.grade; gradeEl.style.color = scoreColor; }
  if (scoreEl) scoreEl.textContent = `${row.score} / 100 points`;

  // Same target/threshold/color conventions as renderDashboardKPIs(), just
  // reading off the clicked row instead of always getDashboardRow().
  const engPct = Math.round(row.engagementTotal / KPI_TARGETS.engagement * 100);
  const engColor = engPct>=100?'var(--green)':engPct>=70?'var(--amber)':'var(--red)';
  const leadsPct = Math.round((row.leads||0) / KPI_TARGETS.leads * 100);
  const leadsColor = leadsPct>=100?'var(--green)':leadsPct>=70?'var(--amber)':'var(--red)';
  const flwPct = Math.round((row.followers||0) / KPI_TARGETS.followers * 100);
  const flwColor = flwPct>=100?'var(--green)':flwPct>=70?'var(--amber)':'var(--red)';
  const seoColor = row.seoScore==null?'var(--sub2)':row.seoScore>=50?'var(--green)':'var(--red)';
  const brandColor = row.brandingScore==null?'var(--sub2)':row.brandingScore>=75?'var(--purple)':row.brandingScore>=50?'var(--amber)':'var(--red)';
  const audColor = row.audienceScore==null?'var(--sub2)':row.audienceScore>=70?'var(--teal)':'var(--amber)';
  const commColor = row.commScore==null?'var(--sub2)':row.commScore>=75?'var(--green)':'var(--amber)';

  const kpis = [
    { label:'Engagement', value: row.engagementTotal.toLocaleString(), delta:(engPct>=100?'✓ ':'')+engPct+'% of target', color:engColor, prog:engPct },
    { label:'Leads Generated', value: row.leads, delta:(leadsPct>=100?'✓ ':'⚠ ')+leadsPct+'% of target', color:leadsColor, prog:leadsPct },
    { label:'Follower Growth', value: row.followers, delta:(flwPct>=100?'✓ ':'⚠ ')+flwPct+'% of target', color:flwColor, prog:flwPct },
    { label:'SEO Performance', value: row.seoScore!=null?row.seoScore+'%':'—', delta: row.seoScore==null?'No posts logged':(row.seoScore>=50?'✓ On target':'Below target'), color:seoColor, prog:row.seoScore||0 },
    { label:'AI Branding Score', value:(row.brandingScore!=null?row.brandingScore:'—')+'/100', delta: row.brandingScore==null?'Not scored':(row.brandingScore>=75?'✓ Above target':'Below target'), color:brandColor, prog:row.brandingScore||0 },
    { label:'Target Audience Quality', value:(row.audienceScore!=null?row.audienceScore:'—')+'/100', delta: row.audienceScore==null?'Not scored':(row.audienceScore>=70?'✓ Above target':'Below target'), color:audColor, prog:row.audienceScore||0 },
    { label:'Communication Score', value:(row.commScore!=null?row.commScore:'—')+'/100', delta: row.commScore==null?'Not scored':(row.commScore>=75?'✓ Above target':'Below target'), color:commColor, prog:row.commScore||0 }
  ];
  const kpiCard = k => `<div class="stat-card" style="cursor:default"><div class="sc-top"><div><div class="sc-lbl">${k.label}</div><div class="sc-val">${k.value}</div></div></div><div class="sc-delta" style="color:${k.color}">${k.delta}</div><div class="prog"><div class="prog-f" style="width:${Math.max(0,Math.min(100,k.prog))}%;background:${k.color}"></div></div></div>`;
  const row1El = document.getElementById('wrKpiCardsRow1');
  const row2El = document.getElementById('wrKpiCardsRow2');
  if (row1El) row1El.innerHTML = kpis.slice(0, 4).map(kpiCard).join('');
  if (row2El) row2El.innerHTML = kpis.slice(4).map(kpiCard).join('');

  const bars = [
    { label:'Engagement (20%)', val: row.engScore },
    { label:'Leads (25%)', val: row.leadsScore },
    { label:'Followers (10%)', val: row.followersScore },
    { label:'SEO (10%)', val: row.seoScore },
    { label:'AI Branding (15%)', val: row.brandingScore },
    { label:'Audience (10%)', val: row.audienceScore },
    { label:'Communication (10%)', val: row.commScore }
  ];
  const barsEl = document.getElementById('wrScoreBars');
  if (barsEl) barsEl.innerHTML = bars.map(b => `<div class="ai-score-bar"><div class="ai-bar-label">${b.label}</div><div class="ai-bar-track"><div class="ai-bar-fill" style="width:${b.val!=null?b.val:0}%;background:var(--blue)"></div></div><div class="ai-bar-val">${b.val!=null?b.val:'—'}</div></div>`).join('');

  // Same per-platform rows the Platform Log Tracker shows for this week, with
  // its own Edit button — closes this modal first so the Log Week edit modal
  // never opens stacked on top of it.
  const platRows = rowsForBrandWeek(row.brand, row.wk);
  const platTableEl = document.getElementById('wrPlatformTable');
  if (platTableEl) {
    platTableEl.innerHTML = platRows.length
      ? `<thead><tr><th>Platform</th><th>Engagement</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th><th>Details</th><th></th></tr></thead><tbody>${platRows.map(r=>`<tr><td><span class="pill pill-blue">${r.plat}</span></td><td>${r.engagementTotal.toLocaleString()}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:700">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td><td class="truncate-cell" style="color:var(--sub2);font-size:12px;max-width:180px" title="${escAttr(fmtRawMetrics(r.rawMetrics))}">${fmtRawMetrics(r.rawMetrics)}</td><td>${r._id?`<button class="btn-outline" style="font-size:11px;padding:5px 10px" onclick="closeModal('weekReportModal');openEditLog('${r._id}')">Edit</button>`:''}</td></tr>`).join('')}</tbody>`
      : `<tbody><tr><td style="padding:14px;color:var(--sub2);font-size:13px">No platforms logged this week.</td></tr></tbody>`;
  }

  renderInsightsInto('wrInsights', row);
}

// Platform Log Tracker — groups the raw per-platform rows by the same
// brand+week key used for the Overall aggregation, so managers/admin can see
// exactly which platforms have been logged (and their individual numbers)
// behind each week's Overall row on the Reports page.
function renderPlatformTracker(){
  const container = document.getElementById('platformTracker');
  if (!container) return;

  const ALL_PLATFORMS = ['Facebook','LinkedIn','Twitter','TikTok','Instagram','YouTube'];
  const groups = {};
  logData.forEach(r => {
    const key = r.brand + '||' + r.wk;
    if (!groups[key]) groups[key] = { brand: r.brand, wk: r.wk, weekStart: r.weekStart, weekEnding: r.weekEnding, mgr: r.mgr, rows: [], latestCreatedAt: r.createdAt || 0 };
    if (!groups[key].weekStart && r.weekStart) groups[key].weekStart = r.weekStart;
    if (!groups[key].weekEnding && r.weekEnding) groups[key].weekEnding = r.weekEnding;
    groups[key].rows.push(r);
    if (r.createdAt && new Date(r.createdAt) > new Date(groups[key].latestCreatedAt || 0)) groups[key].latestCreatedAt = r.createdAt;
  });

  let groupList = Object.values(groups).sort((a,b) => new Date(b.latestCreatedAt || 0) - new Date(a.latestCreatedAt || 0));

  if (!groupList.length) {
    container.innerHTML = `<div style="padding:20px;color:var(--sub2);font-size:13px">No weeks logged yet.</div>`;
    return;
  }

  // Defaults the Week Start/Ending filter to just the most recently logged
  // week (instead of dumping every week ever logged onto the page at once)
  // the very first time there's data and nothing's been picked yet. Once the
  // manager types a date or hits "Show All Weeks", their choice is left
  // alone on every re-render (including the 20s auto-refresh poll).
  const startEl = document.getElementById('trackerWeekStart');
  const endEl = document.getElementById('trackerWeekEnd');
  if (startEl && endEl && !startEl.value && !endEl.value && !startEl.dataset.userCleared) {
    const latest = groupList[0];
    if (latest.weekStart) startEl.value = latest.weekStart;
    if (latest.weekEnding) endEl.value = latest.weekEnding;
  }

  const startVal = startEl ? startEl.value : '';
  const endVal = endEl ? endEl.value : '';
  if (startVal || endVal) {
    groupList = groupList.filter(g => {
      if (!g.weekEnding) return true; // no stored date to filter on — keep it visible rather than silently hiding real data
      if (startVal && g.weekEnding < startVal) return false;
      if (endVal && g.weekEnding > endVal) return false;
      return true;
    });
  }

  if (!groupList.length) {
    container.innerHTML = `<div style="padding:20px;color:var(--sub2);font-size:13px">No weeks logged in that date range. <button class="btn-outline" style="font-size:11px;padding:6px 12px;margin-left:6px" onclick="clearTrackerFilter()">Show All Weeks</button></div>`;
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
            <span style="font-weight:800;font-size:14px;color:var(--navy)">${g.weekStart ? fmtDateShort(g.weekStart)+' – ' : ''}${g.wk.replace('Wk of ','')}</span>
            <span class="pill pill-blue" style="margin-left:8px">${g.brand}</span>
            <span style="color:var(--sub2);font-size:12px;margin-left:6px">${g.mgr}</span>
          </div>
          <div style="text-align:right">${overall ? `<div style="font-size:10px;color:var(--sub2);text-transform:uppercase;letter-spacing:.4px">Week's Overall Score</div><span style="font-weight:800;font-size:15px">${overall.score}</span> <span style="font-weight:700;color:${overall.score>=80?'var(--green)':overall.score>=70?'var(--amber)':'var(--red)'}">${overall.grade}</span>` : ''}</div>
        </div>
        <div style="margin-bottom:10px">${platformPills}${extraPills}</div>
        <table class="sp-table"><thead><tr><th>Platform</th><th>Engagement</th><th>Followers</th><th>Leads</th><th>Score</th><th>Grade</th><th>Details</th><th></th></tr></thead><tbody>
          ${g.rows.map(r=>`<tr><td><span class="pill pill-blue">${r.plat}</span></td><td>${r.engagementTotal.toLocaleString()}</td><td>${r.followers}</td><td>${r.leads}</td><td style="font-weight:700">${r.score}</td><td><span style="font-weight:700;color:${r.score>=80?'var(--green)':r.score>=70?'var(--amber)':'var(--red)'}">${r.grade}</span></td><td class="truncate-cell" style="color:var(--sub2);font-size:12px;max-width:220px" title="${escAttr(fmtRawMetrics(r.rawMetrics))}">${fmtRawMetrics(r.rawMetrics)}</td><td>${r._id?`<button class="btn-outline" style="font-size:11px;padding:5px 10px" onclick="openEditLog('${r._id}')" title="Fix a mistaken number for this platform"><svg viewBox="0 0 24 24" style="width:12px;height:12px;stroke:currentColor;stroke-width:2;fill:none;margin-right:3px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit</button>`:''}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
  }).join('');
}

// Platform Totals charts (Reports page) — one horizontal bar per metric,
// broken down across the 6 platforms. Uses each platform's most recently
// logged row (across all brands) so "Total Followers" reflects a current
// snapshot rather than double-counting past weeks.
const PLATFORM_TOTALS_ORDER = ['Facebook','LinkedIn','Twitter','TikTok','Instagram','YouTube'];
const PLATFORM_TOTALS_COLOR = '#0d9488';

// Google Search and Jiji aren't social platforms (no followers/impressions/
// engagement of their own), so they deliberately stay OUT of
// PLATFORM_TOTALS_ORDER — but they're real lead sources, so anywhere leads
// specifically are broken down by platform (the Reports page's Week Leads by
// Platform chart, and the Leads KPI page's top-platform cards + trend chart)
// uses this extended list instead, so their leads show up everywhere leads
// are, without bleeding into Followers/Impressions/Engagement/Platform
// Weekly Targets.
const LEADS_PLATFORMS = [...PLATFORM_TOTALS_ORDER, 'Google Search', 'Jiji'];

function latestRowForPlatform(platform) {
  return logData
    .filter(r => r.plat === platform)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

function upsertHBarChart(canvasId, storeKey, labels, data, chartLabel) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (window[storeKey]) {
    window[storeKey].data.labels = labels;
    window[storeKey].data.datasets[0].data = data;
    window[storeKey].update();
    return;
  }
  window[storeKey] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: chartLabel, data, backgroundColor: PLATFORM_TOTALS_COLOR, borderRadius: 6 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false }, tooltip: tt },
      scales: { x: { grid: gr, ticks: ch, beginAtZero: true }, y: { grid: { display: false }, ticks: ch } }
    }
  });
}

function renderPlatformTotalsCharts() {
  const weeklyFollowers = [], totalFollowers = [], impressions = [];
  PLATFORM_TOTALS_ORDER.forEach(p => {
    const row = latestRowForPlatform(p);
    weeklyFollowers.push(row ? row.followers : 0);
    const raw = row ? row.rawMetrics || {} : {};
    totalFollowers.push(raw[TOTAL_FOLLOWERS_LABEL[p]] || 0);
    impressions.push(raw[IMPRESSIONS_LABEL[p]] || 0);
  });
  upsertHBarChart('platWeeklyFollowersChart', 'platWeeklyFollowersChartObj', PLATFORM_TOTALS_ORDER, weeklyFollowers, 'Weekly Followers');
  upsertHBarChart('platTotalFollowersChart', 'platTotalFollowersChartObj', PLATFORM_TOTALS_ORDER, totalFollowers, 'Total Followers');
  upsertHBarChart('platImpressionsChart', 'platImpressionsChartObj', PLATFORM_TOTALS_ORDER, impressions, 'Impressions');

  // Leads breakdown also includes Google Search (see LEADS_PLATFORMS above) —
  // it intentionally only shows up here and on the Leads KPI page, not in the
  // 3 charts above or anywhere else platforms are broken down.
  const leads = LEADS_PLATFORMS.map(p => { const row = latestRowForPlatform(p); return row ? row.leads : 0; });
  upsertHBarChart('platLeadsChart', 'platLeadsChartObj', LEADS_PLATFORMS, leads, 'Leads');
}

// ═══ TREND ANALYSIS (Reports page) ═══
// Multi-week comparisons across platforms — Total Followers, New Followers,
// and Views/Impressions — each as a grouped bar chart (weeks left-to-right,
// one colored series per platform) plus an auto-generated Highlights panel
// and a week-by-week detail table. Everything here reads live logData, the
// same rows the rest of the Reports page already uses.

// Groups every logged row into a real calendar week (Sunday-ending, via
// weekBucketFromDate) derived straight from its own weekEnding/weekStart/
// createdAt date — NOT from the row's stored wk text. That makes this
// resilient even against older rows whose week_label happened to be minted
// per-submission-day rather than per-week: bucketing here is always by
// actual week, so the chart is guaranteed weekly, never daily. Sorts weeks
// chronologically (oldest → newest), keeps only the most recent maxWeeks of
// them, then sums valueFn(row) per platform per week. Rows for the same
// platform+week from different brands are summed (this is a company-wide
// view across all brands, not a single-brand snapshot).
function buildWeeklyPlatformSeries(valueFn, maxWeeks = 4, rows = logData, platforms = PLATFORM_TOTALS_ORDER) {
  const rowsWithBucket = rows.map(r => {
    const bucketDate = weekBucketFromDate(r.weekEnding || r.weekStart || r.createdAt);
    return { row: r, key: weekBucketKey(bucketDate), label: weekBucketLabel(bucketDate), sortDate: bucketDate };
  });

  const weekMeta = {};
  rowsWithBucket.forEach(rb => { if (!weekMeta[rb.key]) weekMeta[rb.key] = { date: rb.sortDate, label: rb.label }; });
  let weekKeys = Object.keys(weekMeta).sort((a, b) => weekMeta[a].date - weekMeta[b].date);
  if (weekKeys.length > maxWeeks) weekKeys = weekKeys.slice(weekKeys.length - maxWeeks);

  const series = {};
  platforms.forEach(p => { series[p] = weekKeys.map(() => 0); });
  rowsWithBucket.forEach(rb => {
    const wi = weekKeys.indexOf(rb.key);
    if (wi === -1 || !series[rb.row.plat]) return;
    series[rb.row.plat][wi] += valueFn(rb.row) || 0;
  });
  return { weekLabels: weekKeys.map(k => weekMeta[k].label), series };
}

// Per-chart Bar/Line view preference, keyed by the chart's storeKey.
// Undefined/'bar' is the default so every chart that never gets a toggle
// switch wired to it (e.g. the single-platform-group KPI page charts that
// happen to reuse renderTrendChart) is completely unaffected — this only
// changes behavior for charts a toggle switch actually flips.
let chartViewMode = {};

// One dataset per platform, shaped for whichever view is currently active.
// Line view swaps the grouped bars for a smooth per-platform line so a
// multi-week trend direction reads at a glance; Bar view keeps the original
// tightly-clustered comparison bars. Both share the same color per platform
// so switching views doesn't reshuffle which color means which platform.
// Line view is styled after Google Trends' "Interest over time" chart — no
// dots on the line itself (they only appear on hover), a thicker smoothed
// curve, and monotone interpolation so the smoothing never overshoots above
// or below the real data points the way default cubic bezier smoothing can.
function buildComparisonDataset(label, data, color, mode) {
  if (mode === 'line') {
    return { type: 'line', label, data, borderColor: color, backgroundColor: color, pointBackgroundColor: color, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 8, borderWidth: 2.5, tension: 0.4, cubicInterpolationMode: 'monotone', fill: false };
  }
  return { type: 'bar', label, data, backgroundColor: color, borderRadius: 4, maxBarThickness: 28, barPercentage: 1, categoryPercentage: 0.7 };
}

// Flips a chart between Bar and Line view and re-renders whichever section
// owns it, so the chart, its Highlights panel, and its detail table all stay
// in sync (only the chart's own look actually changes, but re-running the
// section's render function is simpler and safer than re-deriving series
// data here just to call the chart function directly).
function toggleChartView(storeKey) {
  chartViewMode[storeKey] = (chartViewMode[storeKey] === 'line') ? 'bar' : 'line';
  if (storeKey === 'targetAchievementChartObj') renderPlatformTargets();
  else renderTrendAnalysis();
}

function renderTrendChart(canvasId, storeKey, weekLabels, series) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // Reads whatever platform keys the passed-in series actually has (rather
  // than always the full PLATFORM_TOTALS_ORDER list) so charts built from an
  // extended platform list — e.g. the Leads KPI page's Leads Over Time chart,
  // which also includes Google Search — render every series they were given.
  const platforms = Object.keys(series).filter(p => series[p].some(v => v > 0));
  const mode = chartViewMode[storeKey] || 'bar';
  const datasets = platforms.map(p => buildComparisonDataset(p, series[p], PLATFORM_COLORS[p].hex, mode));
  if (window[storeKey]) {
    window[storeKey].data.labels = weekLabels;
    window[storeKey].data.datasets = datasets;
    window[storeKey].update();
    return;
  }
  window[storeKey] = new Chart(canvas, {
    type: 'bar',
    data: { labels: weekLabels, datasets },
    options: {
      responsive: true,
      // Without an explicit aspectRatio, Chart.js infers one from the
      // canvas's initial (unset) width/height attributes — for these wide
      // multi-week comparison cards that produced a chart 2-3x taller than
      // it needed to be, and made the tight week-by-week bar grouping much
      // harder to read at a glance. A fixed wide/short ratio fixes both.
      aspectRatio: 2.3,
      plugins: { legend: { display: true, labels: { color: '#64748b', font: { size: 11, family: 'Inter' }, boxWidth: 10, padding: 12 } }, tooltip: tt },
      scales: { x: { grid: { display: false }, ticks: ch }, y: { grid: gr, ticks: ch, beginAtZero: true } }
    }
  });
}

// Surfaces one card per platform that has ever logged data, sorted by the
// size of its week-over-week swing (biggest movers first) so the panel reads
// like a highlights feed rather than a flat alphabetical list.
function renderTrendInsights(containerId, weekLabels, series, unit) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const n = weekLabels.length;
  const items = [];
  PLATFORM_TOTALS_ORDER.forEach(p => {
    const vals = series[p];
    if (!vals.some(v => v > 0)) return;
    const latest = vals[n - 1] || 0;
    let pct = null;
    if (n >= 2 && vals[n - 2] > 0) pct = Math.round((latest - vals[n - 2]) / vals[n - 2] * 100);
    items.push({ platform: p, latest, pct });
  });
  if (!items.length) {
    container.innerHTML = `<div style="padding:8px 0;color:var(--sub2);font-size:12px">No data logged yet.</div>`;
    return;
  }
  items.sort((a, b) => {
    const am = a.pct == null ? -1 : Math.abs(a.pct), bm = b.pct == null ? -1 : Math.abs(b.pct);
    return bm !== am ? bm - am : b.latest - a.latest;
  });
  const latestWeekLabel = weekLabels[n - 1] || 'This week';
  container.innerHTML = items.map(it => {
    const c = PLATFORM_COLORS[it.platform];
    const sub = it.pct == null ? `${latestWeekLabel} · current`
      : it.pct > 0 ? `${latestWeekLabel} · ▲ +${it.pct}% vs prior week`
      : it.pct < 0 ? `${latestWeekLabel} · ▼ ${it.pct}% vs prior week`
      : `${latestWeekLabel} · flat vs prior week`;
    return `<div class="ai-box" style="background:${c.bgVar};border-left-color:${c.textVar}"><div class="ai-box-title" style="color:${c.textVar}">${it.platform}</div><div class="ai-box-body"><strong style="font-size:14px;color:var(--navy)">${it.latest.toLocaleString()}</strong> ${unit}<br>${sub}</div></div>`;
  }).join('');
}

function renderTrendTable(tableId, weekLabels, series) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const platforms = PLATFORM_TOTALS_ORDER.filter(p => series[p].some(v => v > 0));
  if (!platforms.length) {
    table.innerHTML = `<tbody><tr><td style="padding:14px;color:var(--sub2);font-size:13px">No data logged yet.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr><th>Platform</th>${weekLabels.map(w => `<th>${w}</th>`).join('')}</tr></thead><tbody>${platforms.map(p => `<tr><td><span class="pill pill-blue">${p}</span></td>${series[p].map(v => `<td>${v.toLocaleString()}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

// Headline badge shown above a comparison chart, summarizing whether the
// combined total across all platforms is trending up or down vs the
// previous logged week — a single glance instead of reading every bar.
// mode 'sum' adds every platform's value together (raw counts, e.g. total
// followers); mode 'avgPts' averages them instead and reports the change in
// percentage points (for series that are already a % themselves, e.g.
// Target Achievement's "% of weekly target hit").
function renderTrendBadge(containerId, weekLabels, series, mode = 'sum') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const n = weekLabels.length;
  const platforms = Object.keys(series);
  const notEnough = `<span class="trend-badge" style="background:var(--bg);color:var(--sub2)">Log at least 2 weeks to see a trend</span>`;
  if (n < 2 || !platforms.length) { container.innerHTML = notEnough; return; }

  const aggAt = i => {
    const vals = platforms.map(p => series[p][i]).filter(v => v != null);
    if (!vals.length) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    return mode === 'avgPts' ? sum / vals.length : sum;
  };
  const latest = aggAt(n - 1);
  const prev = aggAt(n - 2);
  if (latest == null || prev == null) { container.innerHTML = notEnough; return; }
  if (latest === 0 && prev === 0) { container.innerHTML = `<span class="trend-badge" style="background:var(--bg);color:var(--sub2)">No activity logged yet</span>`; return; }

  const diff = latest - prev;
  const up = diff >= 0;
  const color = up ? 'var(--green)' : 'var(--red)';
  const bg = up ? 'var(--green-bg)' : 'var(--red-bg)';
  const arrow = up ? '▲' : '▼';
  const changeText = mode === 'avgPts'
    ? `${Math.abs(Math.round(diff))} pts`
    : `${prev === 0 ? '100' : Math.round(Math.abs(diff) / Math.abs(prev) * 100)}%`;
  container.innerHTML = `<span class="trend-badge" style="background:${bg};color:${color}">${arrow} ${up ? 'Trending up' : 'Trending down'} ${changeText} vs ${weekLabels[n - 2]}</span>`;
}

function renderTrendAnalysis() {
  const totalFollowersFn = r => (r.rawMetrics || {})[TOTAL_FOLLOWERS_LABEL[r.plat]] || 0;
  const newFollowersFn = r => r.followers || 0;
  const impressionsFn = r => (r.rawMetrics || {})[IMPRESSIONS_LABEL[r.plat]] || 0;

  const tf = buildWeeklyPlatformSeries(totalFollowersFn);
  renderTrendBadge('trendTotalFollowersBadge', tf.weekLabels, tf.series);
  renderTrendChart('trendTotalFollowersChart', 'trendTotalFollowersChartObj', tf.weekLabels, tf.series);
  renderTrendInsights('trendTotalFollowersInsights', tf.weekLabels, tf.series, 'followers');
  renderTrendTable('trendTotalFollowersTable', tf.weekLabels, tf.series);

  const nf = buildWeeklyPlatformSeries(newFollowersFn);
  renderTrendBadge('trendNewFollowersBadge', nf.weekLabels, nf.series);
  renderTrendChart('trendNewFollowersChart', 'trendNewFollowersChartObj', nf.weekLabels, nf.series);
  renderTrendInsights('trendNewFollowersInsights', nf.weekLabels, nf.series, 'new followers');
  renderTrendTable('trendNewFollowersTable', nf.weekLabels, nf.series);

  const im = buildWeeklyPlatformSeries(impressionsFn);
  renderTrendBadge('trendImpressionsBadge', im.weekLabels, im.series);
  renderTrendChart('trendImpressionsChart', 'trendImpressionsChartObj', im.weekLabels, im.series);
  renderTrendInsights('trendImpressionsInsights', im.weekLabels, im.series, 'views/impressions');
  renderTrendTable('trendImpressionsTable', im.weekLabels, im.series);
}

// ═══ PLATFORM WEEKLY TARGETS — static target per platform, manager logs the
// actual number achieved each week, app judges Met/Missed. Scoped to
// currentDashboardBrand() (the manager's own brand, or whichever brand pill
// Admin has selected) — same brand concept the KPI detail pages already use,
// since each brand runs its own accounts against its own targets. ═══

// Reads the input for one platform's "This Week's Actual" cell and saves it.
async function saveTargetActual(platform) {
  const el = document.getElementById('tgtActual_' + platform);
  if (!el) return;
  const val = +el.value;
  if (el.value === '' || isNaN(val) || val < 0) { showToast('Enter a valid number first'); return; }

  const brand = currentDashboardBrand();
  const btn = document.getElementById('tgtSaveBtn_' + platform);
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  try {
    await upsertPlatformActual(brand, platform, val);
    await refreshAllData();
    const target = PLATFORM_WEEKLY_TARGETS[platform];
    showToast(`${platform}: ${val}/${target} logged — ${val >= target ? 'target met ✓' : 'below target'}`);
  } catch (e) {
    console.error(e);
    showToast('Could not save — check connection');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

// The live "This Week" editor table — one row per platform, target is
// static, actual is typed in and saved individually per platform.
function renderPlatformTargetsCurrentTable() {
  const container = document.getElementById('platformTargetsCurrent');
  if (!container) return;
  // Never rebuild while a manager is actively typing an actual value —
  // otherwise the 20s auto-refresh poll would wipe out in-progress input
  // (same class of bug already fixed for the AI Review qualitative notes).
  const active = document.activeElement;
  if (active && active.id && active.id.startsWith('tgtActual_')) return;

  const brand = currentDashboardBrand();
  const weekLabel = getWeekLabel();
  const prevWeekLabel = getPrevWeekLabel();
  const rows = PLATFORM_TOTALS_ORDER.map(p => {
    const target = PLATFORM_WEEKLY_TARGETS[p];
    const row = platformActualsData.find(r => r.brand === brand && r.wk === weekLabel && r.plat === p);
    const actual = row ? row.actual : null;
    const pct = actual != null ? Math.round(actual / target * 100) : null;
    const statusHtml = actual == null
      ? `<span class="pill" style="background:var(--bg);color:var(--sub2)">Not logged yet</span>`
      : pct >= 100
        ? `<span class="pill pill-met">✓ Met · ${pct}%</span>`
        : `<span class="pill pill-miss">✗ ${pct}% of target</span>`;

    // Last week's actual for the same platform+brand, shown purely as a
    // reference number beside the input — so a manager can see at a glance
    // whether this week is tracking up or down without leaving this table.
    const prevRow = platformActualsData.find(r => r.brand === brand && r.wk === prevWeekLabel && r.plat === p);
    const prevHtml = prevRow != null
      ? `<span style="font-weight:600;color:var(--navy)">${prevRow.actual}</span>`
      : `<span style="color:var(--sub2)">—</span>`;

    return `<tr>
      <td><span class="pill pill-blue">${p}</span></td>
      <td style="font-weight:700">${target}</td>
      <td>${prevHtml}</td>
      <td><input type="number" min="0" class="tbl-input" id="tgtActual_${p}" placeholder="e.g. ${target}" value="${actual != null ? actual : ''}" onchange="saveTargetActual('${p}')"></td>
      <td>${statusHtml}</td>
      <td><button class="btn-outline" style="font-size:11px;padding:6px 12px" id="tgtSaveBtn_${p}" onclick="saveTargetActual('${p}')">Save</button></td>
    </tr>`;
  }).join('');

  // The input's own onchange now saves automatically the moment a manager
  // types a number and clicks/tabs away — so simply filling in the field is
  // enough to persist it, instead of relying on a separate Save click that's
  // easy to skip or navigate away from before pressing. The Save button
  // stays as a visible, explicit fallback for anyone who prefers it.
  container.innerHTML = `<thead><tr><th>Platform</th><th>Weekly Target</th><th>${prevWeekLabel}</th><th>This Week's Actual</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

// Groups platformActualsData into real calendar weeks (same weekBucketFromDate
// bucketing as buildWeeklyPlatformSeries) and expresses each platform's
// actual as a % of its own static target, so every platform is comparable
// on one 0–100+ scale despite having very different raw targets. Missing
// weeks are left as null (not 0) so the chart shows a gap instead of a
// misleading "0% achieved" bar for weeks nothing was logged at all.
function buildTargetAchievementSeries(maxWeeks = 4) {
  const brand = currentDashboardBrand();
  const rows = platformActualsData.filter(r => r.brand === brand);
  const rowsWithBucket = rows.map(r => {
    const bucketDate = weekBucketFromDate(r.weekEnding || r.createdAt);
    return { row: r, key: weekBucketKey(bucketDate), label: weekBucketLabel(bucketDate), sortDate: bucketDate };
  });

  const weekMeta = {};
  rowsWithBucket.forEach(rb => { if (!weekMeta[rb.key]) weekMeta[rb.key] = { date: rb.sortDate, label: rb.label }; });
  let weekKeys = Object.keys(weekMeta).sort((a, b) => weekMeta[a].date - weekMeta[b].date);
  if (weekKeys.length > maxWeeks) weekKeys = weekKeys.slice(weekKeys.length - maxWeeks);

  const series = {};
  PLATFORM_TOTALS_ORDER.forEach(p => { series[p] = weekKeys.map(() => null); });
  rowsWithBucket.forEach(rb => {
    const wi = weekKeys.indexOf(rb.key);
    if (wi === -1 || !series[rb.row.plat]) return;
    const target = PLATFORM_WEEKLY_TARGETS[rb.row.plat];
    series[rb.row.plat][wi] = Math.round((rb.row.actual || 0) / target * 100);
  });
  return { weekLabels: weekKeys.map(k => weekMeta[k].label), series };
}

// Grouped bar chart, styled identically to the other Trend Analysis
// comparison charts (tight per-week platform clustering, wide/short
// aspectRatio) plus a dashed "100% Target" reference line so hitting target
// is a single glance — bars crossing the line = met that week.
function renderTargetAchievementChart(canvasId, storeKey, weekLabels, series) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const platforms = PLATFORM_TOTALS_ORDER.filter(p => series[p].some(v => v != null));
  const mode = chartViewMode[storeKey] || 'bar';
  const datasets = platforms.map(p => buildComparisonDataset(p, series[p], PLATFORM_COLORS[p].hex, mode));
  // The 100% Target reference stays a dashed line in both views — it's a
  // fixed threshold, not a per-platform value, so it never makes sense as a
  // bar of its own.
  const targetLine = { label: '100% Target', type: 'line', data: weekLabels.map(() => 100), borderColor: '#d97706', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false };
  const allDatasets = [...datasets, targetLine];

  if (window[storeKey]) {
    window[storeKey].data.labels = weekLabels;
    window[storeKey].data.datasets = allDatasets;
    window[storeKey].update();
    return;
  }
  window[storeKey] = new Chart(canvas, {
    type: 'bar',
    data: { labels: weekLabels, datasets: allDatasets },
    options: {
      responsive: true,
      aspectRatio: 2.3,
      plugins: { legend: { display: true, labels: { color: '#64748b', font: { size: 11, family: 'Inter' }, boxWidth: 10, padding: 12 } }, tooltip: tt },
      scales: { x: { grid: { display: false }, ticks: ch }, y: { grid: gr, ticks: { ...ch, callback: v => v + '%' }, beginAtZero: true } }
    }
  });
}

// Highlights panel — platforms furthest below target surface first (the
// ones that most need attention), matching the "needs a look" framing the
// other Trend Analysis Highlights panels use, just for target-achievement
// instead of week-over-week swings.
function renderTargetInsights(containerId, weekLabels, series) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const n = weekLabels.length;
  const items = [];
  PLATFORM_TOTALS_ORDER.forEach(p => {
    const latest = series[p][n - 1];
    if (latest == null) return;
    items.push({ platform: p, pct: latest });
  });
  if (!items.length) {
    container.innerHTML = `<div style="padding:8px 0;color:var(--sub2);font-size:12px">No actuals logged yet this week.</div>`;
    return;
  }
  items.sort((a, b) => a.pct - b.pct);
  const latestWeekLabel = weekLabels[n - 1] || 'This week';
  container.innerHTML = items.map(it => {
    const c = PLATFORM_COLORS[it.platform];
    const met = it.pct >= 100;
    const sub = met ? `${latestWeekLabel} · ✓ Target met` : `${latestWeekLabel} · ${100 - it.pct}% short of target`;
    return `<div class="ai-box" style="background:${c.bgVar};border-left-color:${c.textVar}"><div class="ai-box-title" style="color:${c.textVar}">${it.platform}</div><div class="ai-box-body"><strong style="font-size:14px;color:var(--navy)">${it.pct}%</strong> of weekly target<br>${sub}</div></div>`;
  }).join('');
}

// Weekly detail table — Platform rows × week columns, each cell the %
// of target hit that week (green ≥100%, red otherwise), same shape as the
// other Trend Analysis detail tables.
function renderTargetDetailTable(tableId, weekLabels, series) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const platforms = PLATFORM_TOTALS_ORDER.filter(p => series[p].some(v => v != null));
  if (!platforms.length) {
    table.innerHTML = `<tbody><tr><td style="padding:14px;color:var(--sub2);font-size:13px">No actuals logged yet.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr><th>Platform</th><th>Weekly Target</th>${weekLabels.map(w => `<th>${w}</th>`).join('')}</tr></thead><tbody>${platforms.map(p => `<tr><td><span class="pill pill-blue">${p}</span></td><td style="font-weight:700">${PLATFORM_WEEKLY_TARGETS[p]}</td>${series[p].map(v => v == null ? `<td style="color:var(--sub2)">—</td>` : `<td><span style="font-weight:700;color:${v >= 100 ? 'var(--green)' : 'var(--red)'}">${v}%</span></td>`).join('')}</tr>`).join('')}</tbody>`;
}

function renderPlatformTargets() {
  // This whole feature is scoped to whichever brand the sidebar pill has
  // selected (same as the Dashboard/KPI pages) — unlike the rest of the
  // Reports page, which shows every brand combined. Labeling it here makes
  // that explicit instead of silently looking empty when a different brand
  // with no logged actuals is selected.
  const brandLabelEl = document.getElementById('targetsBrandLabel');
  if (brandLabelEl) brandLabelEl.textContent = 'Brand: ' + currentDashboardBrand();

  renderPlatformTargetsCurrentTable();
  const ta = buildTargetAchievementSeries();
  renderTrendBadge('targetAchievementBadge', ta.weekLabels, ta.series, 'avgPts');
  renderTargetAchievementChart('targetAchievementChart', 'targetAchievementChartObj', ta.weekLabels, ta.series);
  renderTargetInsights('targetAchievementInsights', ta.weekLabels, ta.series);
  renderTargetDetailTable('targetAchievementTable', ta.weekLabels, ta.series);
}

// ═══ KPI DETAIL PAGES — wire real Log Week data everywhere ═══
// Every stat-card below is mutated in place (label/value/delta/threshold/
// progress bar/icon color) rather than having its HTML replaced, so none of
// this touches div structure — it's pure DOM content updates, same pattern
// as setStatCard already used for the Dashboard.
function fillStatCard(cardEl, opts) {
  if (!cardEl) return;
  const lbl = cardEl.querySelector('.sc-lbl'); if (lbl && opts.label != null) lbl.textContent = opts.label;
  const val = cardEl.querySelector('.sc-val'); if (val && opts.value != null) val.textContent = opts.value;
  const delta = cardEl.querySelector('.sc-delta'); if (delta) { delta.textContent = opts.delta || ''; delta.style.color = opts.deltaColor || ''; }
  const thr = cardEl.querySelector('.sc-thr'); if (thr) { thr.textContent = opts.thr || ''; thr.style.color = opts.thrColor || ''; }
  const progf = cardEl.querySelector('.prog-f'); if (progf) { progf.style.width = Math.max(0, Math.min(100, opts.prog || 0)) + '%'; progf.style.background = opts.progColor || ''; }
  const icon = cardEl.querySelector('.sc-icon'); if (icon && opts.iconBg) icon.style.background = opts.iconBg;
  const iconSvg = cardEl.querySelector('.sc-icon svg'); if (iconSvg && opts.iconColor) iconSvg.style.stroke = opts.iconColor;
}

function rowsForBrandWeek(brand, wk) {
  return logData.filter(r => r.brand === brand && r.wk === wk);
}

function topPlatformsBy(rows, valueFn, n, allowedPlatforms = PLATFORM_TOTALS_ORDER) {
  return rows
    .map(r => ({ plat: r.plat, val: valueFn(r) || 0 }))
    .filter(x => allowedPlatforms.includes(x.plat) && x.val > 0)
    .sort((a, b) => b.val - a.val)
    .slice(0, n);
}

// Real week-by-week history for a single qualitative field (brandingScore/
// audienceScore/commScore), bucketed the same weekly way as everything else.
function buildQualSeries(brand, field, maxWeeks = 4) {
  const withBucket = qualitativeData
    .filter(q => q.brand === brand && q[field] != null)
    .map(q => {
      const bucketDate = weekBucketFromDate(q.weekEnding || null);
      return { key: weekBucketKey(bucketDate), label: weekBucketLabel(bucketDate), date: bucketDate, value: q[field] };
    });
  const weekMeta = {};
  withBucket.forEach(w => { weekMeta[w.key] = w; });
  let keys = Object.keys(weekMeta).sort((a, b) => weekMeta[a].date - weekMeta[b].date);
  if (keys.length > maxWeeks) keys = keys.slice(keys.length - maxWeeks);
  return keys.map(k => ({ label: weekMeta[k].label, value: weekMeta[k].value }));
}

function renderEngagementKPIPage() {
  const scope = document.querySelector('#page-engagement .g4');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const brandRows = logData.filter(r => r.brand === brand);

  if (!row) {
    fillStatCard(cards[0], { label: 'Total Engagement', value: '—', delta: 'No data logged yet', deltaColor: 'var(--sub2)', thr: 'Target: ' + KPI_TARGETS.engagement.toLocaleString(), prog: 0 });
    fillStatCard(cards[1], { label: 'Engagement Score', value: '—', delta: '', thr: '', prog: 0 });
    fillStatCard(cards[2], { label: 'Top Platform', value: '—', delta: '', thr: '', prog: 0 });
    fillStatCard(cards[3], { label: 'Platforms Logged', value: '0 / 6', delta: '', thr: '', prog: 0 });
  } else {
    const weekRows = rowsForBrandWeek(brand, row.wk);
    const top = topPlatformsBy(weekRows, r => r.engagementTotal, 1)[0];
    const loggedCount = new Set(weekRows.map(r => r.plat).filter(p => PLATFORM_TOTALS_ORDER.includes(p))).size;
    const pct = Math.round(row.engagementTotal / KPI_TARGETS.engagement * 100);
    const pctColor = pct >= 100 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';

    fillStatCard(cards[0], { label: 'Total Engagement', value: row.engagementTotal.toLocaleString(), delta: (pct >= 100 ? '✓ ' : '') + pct + '% of target', deltaColor: pctColor, thr: 'Target: ' + KPI_TARGETS.engagement.toLocaleString(), prog: pct, progColor: pctColor });
    fillStatCard(cards[1], { label: 'Engagement Score', value: row.engScore + '/100', delta: 'Grade: ' + row.grade, deltaColor: row.engScore >= 80 ? 'var(--green)' : row.engScore >= 50 ? 'var(--amber)' : 'var(--red)', thr: row.engScore >= 80 ? '✓ Above 80 threshold' : 'Below 80 threshold', thrColor: row.engScore >= 80 ? 'var(--green)' : 'var(--red)', prog: row.engScore, progColor: row.engScore >= 80 ? 'var(--green)' : row.engScore >= 50 ? 'var(--amber)' : 'var(--red)' });
    fillStatCard(cards[2], { label: 'Top Platform', value: top ? top.plat : '—', delta: top ? top.val.toLocaleString() + ' engagement' : 'No platforms logged', deltaColor: 'var(--sub)', thr: row.wk, prog: top ? 100 : 0, progColor: top ? PLATFORM_COLORS[top.plat].hex : 'var(--sub2)', iconBg: top ? PLATFORM_COLORS[top.plat].bgVar : '', iconColor: top ? PLATFORM_COLORS[top.plat].textVar : '' });
    fillStatCard(cards[3], { label: 'Platforms Logged', value: loggedCount + ' / 6', delta: loggedCount >= 6 ? '✓ All platforms logged' : (6 - loggedCount) + ' platform(s) missing', deltaColor: loggedCount >= 6 ? 'var(--green)' : 'var(--amber)', thr: row.wk, prog: Math.round(loggedCount / 6 * 100), progColor: loggedCount >= 6 ? 'var(--green)' : 'var(--amber)' });
  }

  const series = buildWeeklyPlatformSeries(r => r.engagementTotal || 0, 4, brandRows);
  renderTrendChart('engChart', 'engChartObj', series.weekLabels, series.series);
  renderEngagementDonut(row, brand);
}

function renderEngagementDonut(row, brand) {
  const canvas = document.getElementById('engDonut');
  if (!canvas) return;
  let labels = [], data = [], colors = [];
  if (row) {
    const weekRows = rowsForBrandWeek(brand, row.wk).filter(r => PLATFORM_TOTALS_ORDER.includes(r.plat) && r.engagementTotal > 0);
    labels = weekRows.map(r => r.plat);
    data = weekRows.map(r => r.engagementTotal);
    colors = weekRows.map(r => PLATFORM_COLORS[r.plat].hex);
  }
  if (!labels.length) { labels = ['No data yet']; data = [1]; colors = ['#e2e8f0']; }
  if (window.engDonutObj) {
    window.engDonutObj.data.labels = labels;
    window.engDonutObj.data.datasets[0].data = data;
    window.engDonutObj.data.datasets[0].backgroundColor = colors;
    window.engDonutObj.update();
    return;
  }
  window.engDonutObj = new Chart(canvas, { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 7 }] }, options: { cutout: '60%', plugins: { legend: { position: 'bottom', labels: { color: '#64748b', font: { size: 11, family: 'Inter' }, padding: 12, boxWidth: 10 } }, tooltip: tt } } });
}

function renderLeadsKPIPage() {
  const scope = document.querySelector('#page-leads .g4');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const brandRows = logData.filter(r => r.brand === brand);

  if (!row) {
    fillStatCard(cards[0], { label: 'Total Leads', value: '—', delta: 'No data logged yet', deltaColor: 'var(--sub2)', thr: 'Target: ' + KPI_TARGETS.leads + '/wk', prog: 0 });
    for (let i = 1; i < cards.length; i++) fillStatCard(cards[i], { label: 'No platform logged', value: '—', delta: '', thr: '', prog: 0 });
  } else {
    const weekRows = rowsForBrandWeek(brand, row.wk);
    // Leads is the one KPI where Google Search counts as a real platform (it
    // already counts toward the Total Leads figure above via aggregateOverall
    // regardless), so it's included here alongside the normal 6 — just not
    // on the Followers/Engagement pages, where it has no data anyway.
    const top3 = topPlatformsBy(weekRows, r => r.leads, 3, LEADS_PLATFORMS);
    const pct = Math.round(row.leads / KPI_TARGETS.leads * 100);
    const pctColor = pct >= 100 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';
    fillStatCard(cards[0], { label: 'Total Leads', value: row.leads, delta: (pct >= 100 ? '✓ ' : '⚠ ') + pct + '% of target', deltaColor: pctColor, thr: 'Target: ' + KPI_TARGETS.leads + '/wk', prog: pct, progColor: pctColor });
    for (let i = 1; i < cards.length; i++) {
      const p = top3[i - 1];
      if (p) {
        const share = row.leads > 0 ? Math.round(p.val / row.leads * 100) : 0;
        fillStatCard(cards[i], { label: p.plat + ' Leads', value: p.val, delta: share + '% of total leads', deltaColor: 'var(--sub)', thr: row.wk, prog: share, progColor: PLATFORM_COLORS[p.plat].hex, iconBg: PLATFORM_COLORS[p.plat].bgVar, iconColor: PLATFORM_COLORS[p.plat].textVar });
      } else {
        fillStatCard(cards[i], { label: 'No platform logged', value: '—', delta: '', thr: '', prog: 0 });
      }
    }
  }
  const series = buildWeeklyPlatformSeries(r => r.leads || 0, 4, brandRows, LEADS_PLATFORMS);
  renderTrendChart('leadsChart', 'leadsChartObj', series.weekLabels, series.series);
}

function renderFollowersKPIPage() {
  const scope = document.querySelector('#page-followers .g4');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const brandRows = logData.filter(r => r.brand === brand);

  if (!row) {
    fillStatCard(cards[0], { label: 'Total New Followers', value: '—', delta: 'No data logged yet', deltaColor: 'var(--sub2)', thr: 'Target: ' + KPI_TARGETS.followers + '/wk', prog: 0 });
    for (let i = 1; i < cards.length; i++) fillStatCard(cards[i], { label: 'No platform logged', value: '—', delta: '', thr: '', prog: 0 });
  } else {
    const weekRows = rowsForBrandWeek(brand, row.wk);
    const top3 = topPlatformsBy(weekRows, r => r.followers, 3);
    const pct = Math.round(row.followers / KPI_TARGETS.followers * 100);
    const pctColor = pct >= 100 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';
    fillStatCard(cards[0], { label: 'Total New Followers', value: row.followers, delta: (pct >= 100 ? '✓ ' : '⚠ ') + pct + '% of target', deltaColor: pctColor, thr: 'Target: ' + KPI_TARGETS.followers + '/wk', prog: pct, progColor: pctColor });
    for (let i = 1; i < cards.length; i++) {
      const p = top3[i - 1];
      if (p) {
        const share = row.followers > 0 ? Math.round(p.val / row.followers * 100) : 0;
        fillStatCard(cards[i], { label: p.plat, value: p.val, delta: share + '% of total growth', deltaColor: 'var(--sub)', thr: row.wk, prog: share, progColor: PLATFORM_COLORS[p.plat].hex, iconBg: PLATFORM_COLORS[p.plat].bgVar, iconColor: PLATFORM_COLORS[p.plat].textVar });
      } else {
        fillStatCard(cards[i], { label: 'No platform logged', value: '—', delta: '', thr: '', prog: 0 });
      }
    }
  }
  const series = buildWeeklyPlatformSeries(r => r.followers || 0, 4, brandRows);
  renderTrendChart('flwChart', 'flwChartObj', series.weekLabels, series.series);
}

function renderSEOKPIPage() {
  const scope = document.querySelector('#page-seo .g4');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const weekPosts = row ? seoPostsData.filter(s => s.brand === brand && s.wk === row.wk) : [];
  const total = weekPosts.length;
  const ranked = weekPosts.filter(s => s.rank && s.rank !== 'Not found');
  const notRanking = weekPosts.filter(s => s.rank === 'Not found').length;
  const rankingRate = total > 0 ? Math.round(ranked.length / total * 100) : 0;

  fillStatCard(cards[0], { label: 'Posts This Week', value: total, delta: total >= KPI_TARGETS.seoPosts ? '✓ Target met' : total > 0 ? (KPI_TARGETS.seoPosts - total) + ' short of target' : 'No posts yet', deltaColor: total >= KPI_TARGETS.seoPosts ? 'var(--green)' : total > 0 ? 'var(--amber)' : 'var(--sub2)', thr: 'Target: ' + KPI_TARGETS.seoPosts, prog: Math.min(total / KPI_TARGETS.seoPosts * 100, 100), progColor: total >= KPI_TARGETS.seoPosts ? 'var(--green)' : 'var(--amber)' });
  fillStatCard(cards[1], { label: 'Ranking Rate', value: rankingRate + '%', delta: total === 0 ? 'No posts yet' : rankingRate >= 50 ? '✓ On target' : 'Below 50% target', deltaColor: total === 0 ? 'var(--sub2)' : rankingRate >= 50 ? 'var(--green)' : 'var(--red)', thr: 'Target: 50%', prog: rankingRate, progColor: rankingRate >= 50 ? 'var(--green)' : 'var(--amber)' });
  fillStatCard(cards[2], { label: 'Ranking Posts', value: ranked.length, delta: ranked.length > 0 ? ranked.length + ' ranking (#1–#5)' : 'None ranking yet', deltaColor: ranked.length > 0 ? 'var(--green)' : 'var(--sub2)', thr: total > 0 ? Math.round(ranked.length / total * 100) + '% of posts' : '—', prog: total > 0 ? Math.round(ranked.length / total * 100) : 0, progColor: 'var(--green)' });
  fillStatCard(cards[3], { label: 'Not Ranking', value: notRanking, delta: notRanking > 0 ? 'Needs attention' : total > 0 ? '✓ None' : 'No posts yet', deltaColor: notRanking > 0 ? 'var(--red)' : 'var(--green)', thr: total > 0 ? Math.round(notRanking / total * 100) + '% of posts' : '—', prog: total > 0 ? Math.round(notRanking / total * 100) : 0, progColor: 'var(--red)' });
}

function renderAudienceKPIPage() {
  const scope = document.querySelector('#page-audience .g4');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const series = buildQualSeries(brand, 'audienceScore');
  const latest = series[series.length - 1], prev = series[series.length - 2];
  const score = latest ? latest.value : null;
  const delta = latest && prev ? Math.round(latest.value - prev.value) : null;
  const hasNotes = !!(row && row.qual && row.qual.audienceNotes);

  fillStatCard(cards[0], { label: 'Audience Score', value: score != null ? score + '/100' : '—', delta: score != null ? (score >= 70 ? '✓ Above target' : 'Below target') : 'No data yet', deltaColor: score == null ? 'var(--sub2)' : score >= 70 ? 'var(--green)' : 'var(--red)', thr: 'Target: 70+', prog: score || 0, progColor: score >= 70 ? 'var(--teal)' : score >= 50 ? 'var(--amber)' : 'var(--red)' });
  fillStatCard(cards[1], { label: 'vs Last Week', value: delta != null ? (delta >= 0 ? '+' : '') + delta : '—', delta: delta != null ? (delta >= 0 ? '▲ Improved' : '▼ Declined') : 'No prior week yet', deltaColor: delta == null ? 'var(--sub2)' : delta >= 0 ? 'var(--green)' : 'var(--red)', thr: prev ? prev.label : '—', prog: delta != null ? Math.min(Math.abs(delta) * 4, 100) : 0, progColor: delta >= 0 ? 'var(--green)' : 'var(--red)' });
  fillStatCard(cards[2], { label: 'Notes Status', value: hasNotes ? 'Submitted' : 'None', delta: row ? row.wk : '', deltaColor: 'var(--sub)', thr: hasNotes ? '✓ Notes on file' : 'Add notes in Log Week', thrColor: hasNotes ? 'var(--green)' : 'var(--amber)', prog: hasNotes ? 100 : 0, progColor: 'var(--teal)' });
  fillStatCard(cards[3], { label: 'Weeks Tracked', value: series.length, delta: series.length + ' of last 8 weeks logged', deltaColor: 'var(--sub)', thr: '', prog: Math.round(series.length / 8 * 100), progColor: 'var(--teal)' });

  renderQualTrendChart('audChart', 'audChartObj', series, 'Audience Score', 'rgba(13,148,136,0.65)', '#0d9488', 70, 'bar');
}

function renderCommsKPIPage() {
  const scope = document.querySelector('#page-comms .g3');
  if (!scope) return;
  const cards = scope.querySelectorAll('.stat-card');
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const series = buildQualSeries(brand, 'commScore');
  const latest = series[series.length - 1], prev = series[series.length - 2];
  const score = latest ? latest.value : null;
  const delta = latest && prev ? Math.round(latest.value - prev.value) : null;
  const hasNotes = !!(row && row.qual && row.qual.commNotes);

  fillStatCard(cards[0], { label: 'Comm Score', value: score != null ? score + '/100' : '—', delta: score != null ? 'Grade: ' + gradeFor(score) : 'No data yet', deltaColor: score == null ? 'var(--sub2)' : score >= 75 ? 'var(--green)' : 'var(--amber)', thr: 'Target: 75+', prog: score || 0, progColor: score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)' });
  fillStatCard(cards[1], { label: 'vs Last Week', value: delta != null ? (delta >= 0 ? '+' : '') + delta : '—', delta: delta != null ? (delta >= 0 ? '▲ Improved' : '▼ Declined') : 'No prior week yet', deltaColor: delta == null ? 'var(--sub2)' : delta >= 0 ? 'var(--green)' : 'var(--red)', thr: prev ? prev.label : '—', prog: delta != null ? Math.min(Math.abs(delta) * 4, 100) : 0, progColor: delta >= 0 ? 'var(--green)' : 'var(--red)' });
  fillStatCard(cards[2], { label: 'Notes Status', value: hasNotes ? 'Submitted' : 'None', delta: row ? row.wk : '', deltaColor: 'var(--sub)', thr: hasNotes ? '✓ Notes on file' : 'Add notes in Log Week', thrColor: hasNotes ? 'var(--green)' : 'var(--amber)', prog: hasNotes ? 100 : 0, progColor: 'var(--green)' });

  renderQualTrendChart('commChart', 'commChartObj', series, 'Comm Score', 'rgba(22,163,74,0.07)', '#16a34a', 75, 'line');
}

// Shared line/bar chart renderer for a single qualitative score's real
// history (Branding/Audience/Communication all use this same shape of data:
// one score per brand per week).
function renderQualTrendChart(canvasId, storeKey, series, label, fillColor, lineColor, target, kind) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const labels = series.map(s => s.label);
  const data = series.map(s => s.value);
  const targetLine = { label: 'Target', data: labels.map(() => target), borderColor: '#d97706', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false, type: 'line' };
  const mainDataset = kind === 'bar'
    ? { label, data, backgroundColor: fillColor, borderRadius: 6, type: 'bar' }
    : { label, data, borderColor: lineColor, backgroundColor: fillColor, fill: true, tension: 0.4, pointRadius: 3, borderWidth: 2.5, type: 'line' };
  if (window[storeKey]) {
    window[storeKey].data.labels = labels;
    window[storeKey].data.datasets = [mainDataset, targetLine];
    window[storeKey].update();
    return;
  }
  window[storeKey] = new Chart(canvas, { type: kind === 'bar' ? 'bar' : 'line', data: { labels, datasets: [mainDataset, targetLine] }, options: { ...bOpt(), plugins: { legend: { display: true, labels: { color: '#64748b', font: { size: 11, family: 'Inter' }, boxWidth: 10, padding: 14 } }, tooltip: tt } } });
}

// Dashboard "Performance Trend" — real weekly totals for the current brand,
// switchable between the 4 quantifiable KPIs via the tab pills.
function buildMainChartSeries(key, brand) {
  const brandRows = logData.filter(r => r.brand === brand);
  if (key === 'seo') {
    const withBucket = seoPostsData.filter(s => s.brand === brand).map(s => {
      // seo posts don't carry weekEnding on the mapped object; fall back to
      // the week label text itself for bucketing since it's already
      // consistent going forward (getWeekLabel-derived).
      return s.wk;
    });
    const counts = {};
    withBucket.forEach(wk => { counts[wk] = (counts[wk] || 0) + 1; });
    const keys = Object.keys(counts);
    return { labels: keys.map(k => k.replace('Wk of ', '')), data: keys.map(k => counts[k]), thr: 15 };
  }
  const valueFn = key === 'eng' ? (r => r.engagementTotal || 0) : key === 'leads' ? (r => r.leads || 0) : (r => r.followers || 0);
  const series = buildWeeklyPlatformSeries(valueFn, 4, brandRows);
  const labels = series.weekLabels;
  const data = labels.map((_, i) => PLATFORM_TOTALS_ORDER.reduce((sum, p) => sum + (series.series[p][i] || 0), 0));
  const thr = key === 'eng' ? KPI_TARGETS.engagement : key === 'leads' ? KPI_TARGETS.leads : KPI_TARGETS.followers;
  return { labels, data, thr };
}

let activeMainChartKey = 'eng';
function renderMainChart() {
  if (!window.mainChartObj) return;
  const key = activeMainChartKey;
  const lbl = { eng: 'Engagement', leads: 'Leads', flw: 'Followers', seo: 'SEO Posts' }[key];
  const { labels, data, thr } = buildMainChartSeries(key, currentDashboardBrand());
  window.mainChartObj.data.labels = labels;
  window.mainChartObj.data.datasets[0].data = data;
  window.mainChartObj.data.datasets[0].label = lbl;
  window.mainChartObj.data.datasets[1].data = labels.map(() => thr);
  window.mainChartObj.update();
}

// AI Review "Score History" — real weekly composite score for the brand.
function renderAIHistChart() {
  const canvas = document.getElementById('aiHistChart');
  if (!canvas || !window.aiHistChartObj) return;
  const brand = currentDashboardBrand();
  const rows = overallData.filter(r => r.brand === brand).slice().sort((a, b) => weekBucketFromDate(a.weekEnding || null) - weekBucketFromDate(b.weekEnding || null));
  const trimmed = rows.slice(-4);
  const labels = trimmed.map(r => weekBucketLabel(weekBucketFromDate(r.weekEnding || null)));
  const data = trimmed.map(r => r.score);
  window.aiHistChartObj.data.labels = labels;
  window.aiHistChartObj.data.datasets[0].data = data;
  window.aiHistChartObj.data.datasets[1].data = labels.map(() => 80);
  window.aiHistChartObj.update();
}

// Real content for the Branding KPI page's Score History chart + Manager
// Notes box (both replace fabricated demo content that had no real Log Week
// field behind it).
function renderBrandingKPIPage() {
  const brand = currentDashboardBrand();
  const row = getDashboardRow();
  const scoreEl = document.getElementById('brandHeroScore');
  const statusEl = document.getElementById('brandHeroStatus');
  const series = buildQualSeries(brand, 'brandingScore');
  const score = row && row.brandingScore != null ? row.brandingScore : null;
  if (scoreEl) scoreEl.textContent = score != null ? score : '—';
  if (statusEl) statusEl.textContent = score == null ? 'No data yet' : score >= 90 ? '✨ Excellent' : score >= 75 ? '✓ Good' : score >= 50 ? '⚠ Needs work' : '✗ Below target';

  renderQualTrendChart('brandScoreTrendChart', 'brandScoreTrendChartObj', series, 'Branding Score', 'rgba(124,58,237,0.12)', '#7c3aed', 75, 'line');

  const notesEl = document.getElementById('brandManagerNotes');
  if (notesEl) {
    const notes = row && row.qual && row.qual.brandNotes;
    notesEl.innerHTML = notes
      ? `<div class="ai-box"><div class="ai-box-title">Manager Notes — ${row.wk}</div><div class="ai-box-body">${notes}</div></div>`
      : `<div class="ai-box" style="background:var(--bg);border-left-color:var(--sub2)"><div class="ai-box-title" style="color:var(--sub2)">No notes submitted yet</div><div class="ai-box-body">Branding notes entered in Log Week will show up here.</div></div>`;
  }
}

// Central place that refreshes every KPI detail page + dashboard/AI charts
// tied to whichever brand is currently in view — called after data loads
// and whenever the admin brand switcher changes.
function renderAllKPIPages() {
  renderEngagementKPIPage();
  renderLeadsKPIPage();
  renderFollowersKPIPage();
  renderSEOKPIPage();
  renderAudienceKPIPage();
  renderCommsKPIPage();
  renderBrandingKPIPage();
  renderMainChart();
  renderAIHistChart();
}

function showPage(id,nav){
  // KPI Targets & Weights is Admin-only. Block managers even if they reach
  // this some other way than clicking the (already-hidden) nav item.
  if (id === 'settings' && currentUser && currentUser.role !== 'admin') {
    showToast('Only Admin can change KPI Targets');
    return;
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if(nav) nav.classList.add('active');
  if(window.innerWidth<=900){document.getElementById('sidebar').classList.remove('open');}
}
function toggleSB(){document.getElementById('sidebar').classList.toggle('open');}
function setPeriod(btn){document.querySelectorAll('.pchip').forEach(c=>c.classList.remove('active'));btn.classList.add('active');showToast('Period: '+btn.textContent);}
function setBrand(btn,b){document.querySelectorAll('.bpill').forEach(c=>c.classList.remove('active'));btn.classList.add('active');selectedDashboardBrand=b;renderDashboardKPIs();renderAIReview();renderAllKPIPages();renderPlatformTargets();showToast('Switched to '+b);}
function setLBPeriod(btn,p){document.querySelectorAll('.tab-pill').forEach(t=>t.classList.remove('active'));btn.classList.add('active');showToast('Leaderboard: '+btn.textContent);}
function selKPI(card,k){document.querySelectorAll('#page-dashboard .stat-card').forEach(c=>c.classList.remove('sel'));card.classList.add('sel');}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}

// Collapsible Reports-page subsections (Platform Totals, Trend Analysis,
// Platform Weekly Targets) — just toggles a class on the header (for the
// chevron rotation) and the body right below it (for display:none).
function toggleSubsection(headEl, bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  headEl.classList.toggle('collapsed', collapsed);
}

// Resets the Platform Log Tracker's date filter back to "show everything"
// (it otherwise auto-narrows to the most recently logged week so the page
// doesn't dump every week ever logged onto the screen at once).
function clearTrackerFilter() {
  const startEl = document.getElementById('trackerWeekStart');
  const endEl = document.getElementById('trackerWeekEnd');
  if (startEl) { startEl.value = ''; startEl.dataset.userCleared = '1'; }
  if (endEl) endEl.value = '';
  renderPlatformTracker();
}

// ═══ EDITING AN EXISTING PLATFORM LOG ENTRY ═══
// Lets a manager/admin fix a mistaken number on an already-submitted
// platform row (from the Reports page's Platform Log Tracker) instead of
// creating a confusing duplicate. Reuses the same Log Week modal used for
// new entries — editingLogId just tells submitLog() to PATCH that specific
// row instead of matching/inserting by brand+week+platform.
let editingLogId = null;

function resetLogModalState() {
  editingLogId = null;
  const titleEl = document.getElementById('logModalTitle');
  const subEl = document.getElementById('logModalSub');
  if (titleEl) titleEl.textContent = 'Log This Week';
  if (subEl) subEl.textContent = 'Submit weekly performance data for all KPIs';
  const brandEl = document.getElementById('lgBrand');
  const platformEl = document.getElementById('lgPlatform');
  if (brandEl) brandEl.disabled = false;
  if (platformEl) platformEl.disabled = false;
}

// Every "Log Week" button in the app calls this (instead of openModal
// directly) so a previous edit's locked dropdowns/leftover values never
// bleed into a fresh new-entry submission.
function openNewLogModal() {
  resetLogModalState();
  // Note: lgBrandNotes/lgAudienceNotes/lgCommNotes now live on the AI Review
  // page (Branding/Audience/Communication are AI-decided there, not part of
  // this form anymore) — intentionally NOT touched here so opening a fresh
  // Log Week entry never clobbers notes someone's mid-typing elsewhere.
  ['lgWeekStart','lgWeekEnd','lgLeads'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const platformEl = document.getElementById('lgPlatform');
  if (platformEl) renderPlatformFieldInputs(platformEl.value);
  openModal('logModal');
}

function cancelLogModal() {
  resetLogModalState();
  closeModal('logModal');
}

// Finds a platform's internal field key for a given human label (reverse of
// PLATFORM_FIELDS) — needed because raw_metrics is stored keyed by label
// ("Views", "Total Followers"...) but the form inputs are keyed by field id
// ("pf_views", "pf_totalFollowers"...).
function fieldKeyForLabel(platform, label) {
  const fields = PLATFORM_FIELDS[platform] || [];
  const match = fields.find(f => f.label === label);
  return match ? match.key : null;
}

// Opens the Log Week modal pre-filled with an existing platform log entry
// so a mistaken number can be fixed in place. Brand and Platform are locked
// since they define which row gets updated and which fields even apply.
function openEditLog(id) {
  const row = logData.find(r => r._id === id);
  if (!row) { showToast('Could not find that entry'); return; }
  editingLogId = id;

  const titleEl = document.getElementById('logModalTitle');
  const subEl = document.getElementById('logModalSub');
  if (titleEl) titleEl.textContent = 'Edit Log Entry';
  if (subEl) subEl.textContent = `Editing ${row.plat} · ${row.brand} · ${row.wk}`;

  const brandEl = document.getElementById('lgBrand');
  const platformEl = document.getElementById('lgPlatform');
  if (brandEl) {
    const opt = Array.from(brandEl.options).find(o => o.value.startsWith(row.brand));
    if (opt) brandEl.value = opt.value;
    brandEl.disabled = true;
  }
  if (platformEl) {
    platformEl.value = row.plat;
    platformEl.disabled = true;
    renderPlatformFieldInputs(row.plat);
  }

  const weekStartEl = document.getElementById('lgWeekStart');
  const weekEndEl = document.getElementById('lgWeekEnd');
  if (weekStartEl) weekStartEl.value = row.weekStart || '';
  if (weekEndEl) weekEndEl.value = row.weekEnding || '';

  const leadsEl = document.getElementById('lgLeads');
  if (leadsEl) leadsEl.value = row.leads != null ? row.leads : '';

  (PLATFORM_FIELDS[row.plat] || []).forEach(f => {
    const el = document.getElementById('pf_' + f.key);
    if (el) el.value = (row.rawMetrics && row.rawMetrics[f.label]) || '';
  });

  // Branding/Audience/Communication are no longer part of this form at all
  // (AI-decided from the AI Review page instead) — nothing to clear here.

  openModal('logModal');
}
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
  const weekStartEl = document.getElementById('lgWeekStart');
  const weekStartVal = weekStartEl ? weekStartEl.value : '';
  const weekEndEl = document.getElementById('lgWeekEnd');
  const weekEndingVal = weekEndEl ? weekEndEl.value : '';
  const weekLabel = getWeekLabel(weekEndingVal);

  // Read this platform's specific fields (Facebook/LinkedIn/Twitter/TikTok/
  // Instagram/YouTube each have their own set — see PLATFORM_FIELDS) and map
  // them into the raw values object the scoring function understands, plus a
  // raw_metrics object (keyed by human label) for display in the log tables.
  const platformFieldDefs = PLATFORM_FIELDS[platform] || [];
  const rawValues = {};
  const rawMetrics = {};
  platformFieldDefs.forEach(f => {
    const el = document.getElementById('pf_' + f.key);
    const val = el ? (+el.value || 0) : 0;
    rawValues[f.key] = val;
    rawMetrics[f.label] = val;
  });
  const { engagement: engagementTotal, followerGrowth: followers } = getEngagementAndFollowers(platform, rawValues);
  const leads = +document.getElementById('lgLeads').value || 0;
  const score = calcScore({ engagementTotal, followers, leads });
  const grade = gradeFor(score);

  // Resubmitting the same platform for a week that's already logged updates
  // that row instead of creating a duplicate (matches the DB unique index on
  // brand+week_label+platform).
  //
  // When editingLogId is set (opened via the Platform Log Tracker's Edit
  // button), we only reuse that exact row if the week hasn't changed — i.e.
  // the manager is just correcting a number for the SAME week. If they also
  // changed the Week Start/End to a different week while editing, that's a
  // brand-new week's data and must NOT overwrite the original row (that would
  // silently erase the previous week's real numbers). In that case we fall
  // back to the normal brand+week+platform match — updating an existing row
  // for that new week if one already exists, or inserting a fresh one — so
  // the original edited row is left completely untouched.
  const editingRow = editingLogId ? logData.find(r => r._id === editingLogId) : null;
  const existing = (editingRow && editingRow.wk === weekLabel)
    ? editingRow
    : logData.find(r => r.brand === selBrand && r.wk === weekLabel && r.plat === platform);

  const submitBtn = document.querySelector('#logModal .btn-blue');
  const originalText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.textContent = 'Saving...'; submitBtn.disabled = true; }

  try {
    const fields = { likes: 0, comments: 0, reposts: 0, engagement_total: engagementTotal, followers, leads, score, grade, raw_metrics: rawMetrics, week_start: weekStartVal || null, week_ending: weekEndingVal || null };
    if (existing) {
      if (existing._id) await updateWeeklyLog(existing._id, fields);
    } else {
      await insertWeeklyLog({ week_label: weekLabel, manager: mgrName, brand: selBrand, platform, ...fields });
    }

    // Branding/Audience/Communication scores + notes no longer live on this
    // form at all — they're entirely AI-decided now, entered and scored
    // from the AI Review page (see requestAIScoring()/saveQualitativeNotes()).

    await refreshAllData();
    closeModal('logModal');
    showToast(existing ? `${platform} updated for ${weekLabel}` : `${platform} logged for ${weekLabel}`);
    const leadsEl = document.getElementById('lgLeads'); if (leadsEl) leadsEl.value = '';
    if (weekEndEl) weekEndEl.value = '';
    if (weekStartEl) weekStartEl.value = '';
    resetLogModalState();
    renderPlatformFieldInputs(platform);
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
// ═══ QUALITATIVE KPIs — AI Review page ═══
// Branding/Audience/Communication used to be manually scored + noted right
// in the Log Week form. They're now entirely AI-decided from here instead:
// write the notes, click "Score With AI", and the resulting scores save
// straight to weekly_qualitative (no separate "Submit" step needed).
// Scoped to whichever brand+week the rest of the AI Review page is showing
// (currentDashboardBrand() + the latest logged week for that brand).

function qualNotesTargetWeek() {
  const row = getDashboardRow();
  return { brand: currentDashboardBrand(), weekLabel: row ? row.wk : getWeekLabel(), weekEnding: row ? row.weekEnding : null, row };
}

async function requestAIScoring(){
  const { brand: selBrand, weekLabel, weekEnding: weekEndingVal } = qualNotesTargetWeek();

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

    await upsertQualitative(selBrand, weekLabel, weekEndingVal, {
      branding_score: data.branding_score,
      audience_score: data.audience_score,
      comm_score: data.comm_score,
      ...(brandNotes ? { brand_notes: brandNotes } : {}),
      ...(audienceNotes ? { audience_notes: audienceNotes } : {}),
      ...(commNotes ? { comm_notes: commNotes } : {})
    });
    await refreshAllData();
    showToast('AI scored and saved for ' + weekLabel);
  } catch (e) {
    console.error(e);
    showToast('AI scoring isn\'t set up yet — try again later');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

// Fallback for when the AI Edge Function isn't available yet — saves the
// written notes on their own so nothing is lost while waiting to be scored.
async function saveQualitativeNotes(){
  const { brand: selBrand, weekLabel, weekEnding: weekEndingVal } = qualNotesTargetWeek();
  const brandNotes = document.getElementById('lgBrandNotes').value;
  const audienceNotes = document.getElementById('lgAudienceNotes').value;
  const commNotes = document.getElementById('lgCommNotes').value;
  if (!brandNotes && !audienceNotes && !commNotes) { showToast('Nothing to save yet'); return; }
  try {
    const fields = {};
    if (brandNotes) fields.brand_notes = brandNotes;
    if (audienceNotes) fields.audience_notes = audienceNotes;
    if (commNotes) fields.comm_notes = commNotes;
    await upsertQualitative(selBrand, weekLabel, weekEndingVal, fields);
    await refreshAllData();
    showToast('Notes saved for ' + weekLabel);
  } catch (e) {
    console.error(e);
    showToast('Could not save — check connection');
  }
}

// Fills the notes textareas + score displays for whichever brand/week is
// currently in view. Skips any field the user is actively typing in so a
// periodic auto-refresh (every 20s) never clobbers an in-progress note.
function renderQualitativeNotesSection(){
  const { row } = qualNotesTargetWeek();
  [
    ['lgBrandNotes', row && row.qual && row.qual.brandNotes],
    ['lgAudienceNotes', row && row.qual && row.qual.audienceNotes],
    ['lgCommNotes', row && row.qual && row.qual.commNotes]
  ].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val || '';
  });
  const b = document.getElementById('qualBrandScoreDisplay');
  const a = document.getElementById('qualAudienceScoreDisplay');
  const c = document.getElementById('qualCommScoreDisplay');
  if (b) b.textContent = row && row.brandingScore != null ? row.brandingScore + '/100' : '—';
  if (a) a.textContent = row && row.audienceScore != null ? row.audienceScore + '/100' : '—';
  if (c) c.textContent = row && row.commScore != null ? row.commScore + '/100' : '—';
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
function saveSettings(){
  if (currentUser && currentUser.role !== 'admin') { showToast('Only Admin can change KPI Targets'); return; }
  showToast('KPI targets saved');
}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
document.querySelectorAll('.modal-overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');}));