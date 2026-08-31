// Trackline study-generate-year API
//
// POST /api/study-generate-year   body: { familyId, kidId, yearLevel, calendarYear, state? }
//
// Generates a FULL calendar year of study_assignments for one kid, using real
// school term dates (school_term_dates table) instead of a generic repeating
// pattern. Call this once when a kid's year level is set, or once per new
// calendar year.
//
// PACING MODEL (corrected against real Victorian school practice - Maths gets
// ~60min/day per VCAA's own position statement, but Science/Humanities run as
// a single ~50min session per WEEK, and a content descriptor is genuinely
// taught over several weeks, not consumed in one):
// Each subject's current topic is held for WEEKS_PER_TOPIC consecutive weeks
// before advancing - see the DAY_PATTERN/WEEKS_PER_TOPIC constants below.
// An earlier version of this file advanced every subject's topic every single
// week, which exhausted a 43-topic Year 4 set by Term 2 of a ~41-week year.
// At this pacing the same 43 topics cover roughly 85% of the year for Maths,
// 71% for English, 63% for Science - short of a full year (more topics still
// needed), but a realistic gap instead of a wildly overstated one.
//
// NO REPEATS: cursor per subject only advances forward through the ordered
// topic list; a topic already assigned to this kid is never assigned again
// as "new" content.
//
// CONTENT EXHAUSTION FALLBACK: once a subject's topic list runs out (which,
// at current content volumes, WILL happen mid-year - see the simulation
// output), the generator switches that subject into a revision cycle: it
// re-walks the topic list from the start, assigning already-completed topics
// again as review sessions, rather than leaving blank days. This is a
// legitimate stopgap, not a substitute for adding more topics - the response
// reports exactly which subjects hit this and when, so it's visible, not silent.
//
// IDEMPOTENT: only inserts assignments for (kid, date, subject) combinations
// that don't already have a row - safe to re-run without duplicating.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mon-Fri subject rotation - which subjects get a session on each weekday.
// CORRECTED against real Victorian school practice (checked after the first
// version of this file): Maths/English get frequent sessions, but Science
// drops to once a week (Friday) - schools run it as a single ~50min session,
// not daily like Maths. See WEEKS_PER_TOPIC below for the other half of the fix.
const DAY_PATTERN = [
  ['Mathematics','English'],  // Mon
  ['English'],                // Tue
  ['Mathematics'],            // Wed
  ['English','Mathematics'],  // Thu
  ['Science'],                // Fri - Science's one weekly session
];
// A topic is held for this many CONSECUTIVE weeks before advancing to the
// next one - matches real classroom pacing (a content descriptor is taught
// over multiple weeks, not consumed in a single week). The original version
// of this file advanced every subject's topic every single week it appeared,
// which exhausted a 43-topic Year 4 set by Term 2. At 2 weeks/topic, the
// current content instead covers roughly 85% of the year for Maths, 71% for
// English, 63% for Science - short of a full year, but far closer, and an
// honest number rather than a wildly wrong one.
const WEEKS_PER_TOPIC = 2;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function genId(){
  return 'sa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
}
function toISODate(d){ return d.toISOString().slice(0,10); }
function mondayOfDate(d){
  const copy = new Date(d);
  const dow = copy.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy;
}
function weekdaysBetween(startISO, endISO){
  const out = [];
  let d = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    if (dow >= 1 && dow <= 5) out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// Groups a term's weekdays into Mon-Fri chunks (first/last week of a term
// may be short - a term rarely starts exactly on a Monday).
function chunkIntoWeeks(days){
  const weeks = [];
  let current = [];
  days.forEach(d => {
    if (d.getUTCDay() === 1 && current.length) { weeks.push(current); current = []; }
    current.push(d);
  });
  if (current.length) weeks.push(current);
  return weeks;
}

module.exports = async function (context, req) {
  context.log('study-generate-year invoked:', req.method);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'POST') {
    context.res = jsonRes(405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const { familyId, kidId, yearLevel, calendarYear } = body;
    const state = body.state || 'VIC';
    if (!familyId || !kidId || !yearLevel || !calendarYear) {
      context.res = jsonRes(400, { error: 'familyId, kidId, yearLevel and calendarYear are required' });
      return;
    }

    // 1. Load term dates for this state/year.
    const termRes = await fetch(
      `${SUPABASE_URL}/rest/v1/school_term_dates?state=eq.${encodeURIComponent(state)}&calendar_year=eq.${encodeURIComponent(calendarYear)}&select=term_number,start_date,student_start_date,finish_date&order=term_number.asc`,
      { headers: supabaseHeaders() }
    );
    if (!termRes.ok) {
      context.res = jsonRes(502, { error: 'Could not load school_term_dates' });
      return;
    }
    const terms = await termRes.json();
    if (!terms.length) {
      context.res = jsonRes(404, { error: `No term dates found for ${state} ${calendarYear} - add them to school_term_dates first.` });
      return;
    }

    // 2. Load this year level's subjects + topics, ordered by sequence.
    const topicsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subject_levels?year_level=eq.${encodeURIComponent(yearLevel)}` +
      `&select=subject:subjects(id,name),topics(id,name,sequence)`,
      { headers: supabaseHeaders() }
    );
    if (!topicsRes.ok) {
      context.res = jsonRes(502, { error: 'Could not load topics for this year level' });
      return;
    }
    const subjectLevels = await topicsRes.json();
    const topicsBySubjectName = {}; // 'Mathematics' -> [{id,name}, ...] ordered
    const subjectIdByName = {};
    subjectLevels.forEach(sl => {
      if (!sl.subject) return;
      subjectIdByName[sl.subject.name] = sl.subject.id;
      const ordered = (sl.topics || []).slice().sort((a,b) => (a.sequence||0) - (b.sequence||0));
      topicsBySubjectName[sl.subject.name] = ordered;
    });

    // 3. Load already-assigned topic_ids for this kid so cursors resume
    //    correctly on re-runs instead of restarting from topic zero.
    //    With topics now spanning multiple weeks, "resuming" needs both WHICH
    //    topic is current per subject AND how many weeks it's already had.
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/study_assignments?member_id=eq.${encodeURIComponent(kidId)}&select=subject_id,topic_id,assigned_date&order=assigned_date.asc`,
      { headers: supabaseHeaders() }
    );
    const existingRows = existingRes.ok ? await existingRes.json() : [];
    const existingDates = new Set(existingRows.map(r => r.subject_id + '|' + r.assigned_date));

    const cursor = {};          // subjectName -> index of the topic currently in progress
    const weeksOnCurrent = {};  // subjectName -> how many distinct weeks that topic has already had
    Object.keys(topicsBySubjectName).forEach(name => { cursor[name] = 0; weeksOnCurrent[name] = 0; });

    Object.keys(subjectIdByName).forEach(subjName => {
      const subjectId = subjectIdByName[subjName];
      const topics = topicsBySubjectName[subjName];
      const rowsForSubject = existingRows.filter(r => r.subject_id === subjectId);
      if (!rowsForSubject.length) return;
      const lastTopicId = rowsForSubject[rowsForSubject.length - 1].topic_id;
      const idx = topics.findIndex(t => t.id === lastTopicId);
      if (idx < 0) return;
      const weeksSeen = new Set(rowsForSubject.filter(r => r.topic_id === lastTopicId).map(r => toISODate(mondayOfDate(new Date(r.assigned_date)))));
      if (weeksSeen.size >= WEEKS_PER_TOPIC) {
        cursor[subjName] = idx + 1;      // that topic's run is complete - move on
        weeksOnCurrent[subjName] = 0;
      } else {
        cursor[subjName] = idx;          // still partway through this topic
        weeksOnCurrent[subjName] = weeksSeen.size;
      }
    });

    // 4. Walk every week of every term. A subject's topic only advances once
    //    it's had WEEKS_PER_TOPIC weeks - otherwise the SAME topic repeats.
    const newRows = [];
    const exhaustedAt = {};
    const revisionCursor = {};

    terms.forEach(term => {
      const start = term.term_number === 1 ? term.student_start_date : term.start_date;
      const weeks = chunkIntoWeeks(weekdaysBetween(start, term.finish_date));

      weeks.forEach(weekDays => {
        const weekTopic = {};
        Object.keys(topicsBySubjectName).forEach(subjName => {
          const topics = topicsBySubjectName[subjName];
          const appearsThisWeek = weekDays.some(d => DAY_PATTERN[d.getUTCDay()-1] && DAY_PATTERN[d.getUTCDay()-1].includes(subjName));
          if (!appearsThisWeek) return;

          if (cursor[subjName] >= topics.length) {
            // exhausted - fall into revision cycle, replaying from the start
            if (!exhaustedAt[subjName]) exhaustedAt[subjName] = { date: toISODate(weekDays[0]), term: term.term_number };
            if (topics.length) {
              const idx = (revisionCursor[subjName] || 0) % topics.length;
              weekTopic[subjName] = topics[idx];
              revisionCursor[subjName] = idx + 1;
            }
            return;
          }

          weekTopic[subjName] = topics[cursor[subjName]];
          weeksOnCurrent[subjName] += 1;
          if (weeksOnCurrent[subjName] >= WEEKS_PER_TOPIC) {
            cursor[subjName] += 1;
            weeksOnCurrent[subjName] = 0;
          }
        });

        weekDays.forEach(d => {
          const dow = d.getUTCDay();
          const subjectsToday = DAY_PATTERN[dow-1] || [];
          subjectsToday.forEach(subjName => {
            const topic = weekTopic[subjName];
            if (!topic) return;
            const subjectId = subjectIdByName[subjName];
            const dateISO = toISODate(d);
            const key = subjectId + '|' + dateISO;
            if (existingDates.has(key)) return; // idempotent - don't duplicate a prior run
            newRows.push({
              id: genId(),
              family_id: familyId,
              member_id: kidId,
              subject_id: subjectId,
              topic_id: topic.id,
              term: term.term_number,
              week: weeks.indexOf(weekDays) + 1,
              assigned_date: dateISO,
              status: 'pending',
            });
          });
        });
      });
    });

    // 5. Bulk insert.
    if (newRows.length) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/study_assignments`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify(newRows),
      });
      if (!insertRes.ok) {
        const bodyText = await insertRes.text().catch(()=> '');
        context.log.error('study_assignments bulk insert failed:', insertRes.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error inserting assignments', detail: bodyText });
        return;
      }
    }

    context.res = jsonRes(200, {
      assignmentsCreated: newRows.length,
      alreadyExisted: existingRows.length,
      exhausted: exhaustedAt, // which subjects ran out of NEW content, and when - surface this to the parent, don't hide it
    });
  } catch (err) {
    context.log.error('study-generate-year function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
