// Trackline study-assignments API (read-only)
//
// GET /api/study-assignments?familyId=X&kidId=Y&weekOffset=0
//
// Returns:
//   days:    [{date, dayLabel, items:[{subjectId,subjectName,topicId,topicName,status}]}]
//            for Mon-Fri of the REQUESTED week (weekOffset 0 = this week, 1 = next, etc)
//   overdue: [{date,subjectId,subjectName,topicId,topicName,status}]
//            ALWAYS computed independent of weekOffset - any assignment with
//            assigned_date before today that isn't status='completed'. This is
//            what lets Kid View / Parent View show "3 tasks from earlier still
//            pending" regardless of which week the caller happened to ask for.
//
// NOTE: this endpoint only READS study_assignments rows — it does not generate
// them. The auto-assignment algorithm (see study_assignments_design.md) needs
// to run separately and write rows into study_assignments ahead of time.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const OVERDUE_LIMIT = 25; // cap the overdue list - if a kid has more than this piling up, that's a parent conversation, not a UI problem

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function toISODate(d){ return d.toISOString().slice(0,10); }
function mondayOfWeek(baseDate, weekOffset){
  const d = new Date(baseDate);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday + (weekOffset * 7));
  d.setUTCHours(0,0,0,0);
  return d;
}
function mapRow(r){
  return {
    date: r.assigned_date,
    subjectId: r.subject_id,
    subjectName: r.subject ? r.subject.name : '',
    topicId: r.topic_id,
    topicName: r.topic ? r.topic.name : '',
    status: r.status,
  };
}

module.exports = async function (context, req) {
  context.log('study-assignments invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'GET') {
    context.res = jsonRes(405, { error: 'Method not allowed — this endpoint is read-only.' });
    return;
  }

  try {
    const familyId = (req.query && req.query.familyId) || '';
    const kidId = (req.query && req.query.kidId) || '';
    const weekOffset = parseInt((req.query && req.query.weekOffset) || '0', 10) || 0;
    if (!familyId || !kidId) {
      context.res = jsonRes(400, { error: 'familyId and kidId are required' });
      return;
    }

    const monday = mondayOfWeek(new Date(), weekOffset);
    const friday = new Date(monday);
    friday.setUTCDate(friday.getUTCDate() + 4);
    const mondayISO = toISODate(monday);
    const fridayISO = toISODate(friday);
    const todayISO = toISODate(new Date());

    const selectClause = 'select=id,assigned_date,status,topic_id,subject_id,topic:topics(name),subject:subjects(name)';

    const [weekRes, overdueRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/study_assignments?family_id=eq.${encodeURIComponent(familyId)}` +
        `&member_id=eq.${encodeURIComponent(kidId)}` +
        `&assigned_date=gte.${mondayISO}&assigned_date=lte.${fridayISO}` +
        `&${selectClause}&order=assigned_date.asc`,
        { headers: supabaseHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/study_assignments?family_id=eq.${encodeURIComponent(familyId)}` +
        `&member_id=eq.${encodeURIComponent(kidId)}` +
        `&assigned_date=lt.${todayISO}&status=neq.completed` +
        `&${selectClause}&order=assigned_date.asc&limit=${OVERDUE_LIMIT}`,
        { headers: supabaseHeaders() }
      ),
    ]);

    if (!weekRes.ok) {
      const bodyText = await weekRes.text().catch(()=> '');
      context.log.error('study_assignments (week) GET failed:', weekRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: weekRes.status, detail: bodyText });
      return;
    }
    const weekRows = await weekRes.json();
    const overdueRows = overdueRes.ok ? await overdueRes.json() : [];
    if (!overdueRes.ok) {
      context.log.error('study_assignments (overdue) GET failed (non-fatal):', overdueRes.status);
    }

    const byDate = {};
    weekRows.forEach(r => {
      byDate[r.assigned_date] = byDate[r.assigned_date] || [];
      byDate[r.assigned_date].push(mapRow(r));
    });

    const days = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + i);
      const dateISO = toISODate(d);
      days.push({ date: dateISO, dayLabel: DAY_LABELS[d.getUTCDay()], items: byDate[dateISO] || [] });
    }

    const overdue = overdueRows.map(mapRow);

    context.res = jsonRes(200, { days, overdue });
  } catch (err) {
    context.log.error('study-assignments function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};

