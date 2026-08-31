// Trackline study-topics API (read-only)
//
// GET /api/study-topics?yearLevel=4
//
// Returns { subjects, topics } — curriculum content only, no per-kid data.
// This is GLOBAL/shared data (same for every family), so unlike family-data
// it isn't scoped by familyId at all — matches how question banks and topics
// were designed (see year4_topics_seed.json): one copy, every family reads it.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}

module.exports = async function (context, req) {
  context.log('study-topics invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'GET') {
    context.res = jsonRes(405, { error: 'Method not allowed — this endpoint is read-only.' });
    return;
  }

  try {
    const yearLevel = (req.query && req.query.yearLevel) || '';
    if (!yearLevel) {
      context.res = jsonRes(400, { error: 'yearLevel is required' });
      return;
    }

    // subject_levels for this year, embedding the parent subject and its topics
    // in one PostgREST call via foreign-key embedding — avoids N+1 queries.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subject_levels?year_level=eq.${encodeURIComponent(yearLevel)}` +
      `&select=id,year_level,subject:subjects(id,name,learning_area),` +
      `topics(id,name,vcaa_content_code,sequence,study_content,content_source)`,
      { headers: supabaseHeaders() }
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(()=> '');
      context.log.error('subject_levels GET failed:', res.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
      return;
    }

    const rows = await res.json();

    // Reshape into the flat {subjects, topics} arrays the frontend expects
    // (same shape as DEMO_STUDY_SUBJECTS / DEMO_STUDY_TOPICS in index.html).
    const subjects = [];
    const topics = [];
    rows.forEach(sl => {
      if (sl.subject) {
        subjects.push({ id: sl.subject.id, name: sl.subject.name, yearLevel: sl.year_level });
      }
      (sl.topics || []).forEach(t => {
        topics.push({
          id: t.id,
          subjectId: sl.subject ? sl.subject.id : null,
          name: t.name,
          vcaaCode: t.vcaa_content_code,
          sequence: t.sequence,
          studyContent: t.study_content,
        });
      });
    });
    topics.sort((a,b) => (a.sequence||0) - (b.sequence||0));

    context.res = jsonRes(200, { subjects, topics });
  } catch (err) {
    context.log.error('study-topics function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
