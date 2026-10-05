// Trackline study-set-year-level API
//
// POST /api/study-set-year-level
//   body: { familyId, kidId, yearLevel, calendarYear, state? }
//
// This is the single action the "Save & generate schedule" button in Settings
// calls. It does three things in one request:
//   1. Writes members.year_level DIRECTLY via a PATCH to the members table -
//      deliberately bypassing family-data's save_family_data RPC entirely.
//      That RPC decomposes the whole family blob server-side in a way this
//      codebase doesn't have visibility into; if it doesn't already know
//      about a year_level column, it can silently drop it, which is exactly
//      the symptom reported (year level not surviving a refresh). A direct
//      PATCH to one column has no such ambiguity.
//   2. DELETEs every existing study_assignments row for this kid - "check
//      anything already assigned, delete it" - a clean slate before
//      regenerating, rather than layering a new schedule on top of a stale
//      one (e.g. from before a year-level correction).
//   3. Regenerates the full year, using the SAME corrected pacing logic as
//      study-generate-year (2 weeks/topic, Science 1x/week) - kept in sync
//      manually since these are separate files; if you change the pacing
//      model in one, change it in both.
//
// topic_progress (exam scores/completions) is intentionally NOT touched here -
// wiping the SCHEDULE isn't the same as wiping a kid's actual progress history.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DAY_PATTERN = [
  ['Mathematics','English'], ['English'], ['Mathematics'],
  ['English','Mathematics'], ['Science'],
];
const WEEKS_PER_TOPIC = 2;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function genId(){ return 'sa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10); }
function toISODate(d){ return d.toISOString().slice(0,10); }
function weekdaysBetween(startISO, endISO){
  const out = [];
  let d = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function chunkIntoWeeks(days){
  const weeks = []; let current = [];
  days.forEach(d => {
    if (d.getUTCDay() === 1 && current.length) { weeks.push(current); current = []; }
    current.push(d);
  });
  if (current.length) weeks.push(current);
  return weeks;
}

module.exports = async function (context, req) {
  context.log('study-set-year-level invoked:', req.method);

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

    // STEP 1: write year_level directly - the actual fix for it not persisting.
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/members?id=eq.${encodeURIComponent(kidId)}&family_id=eq.${encodeURIComponent(familyId)}`, {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ year_level: yearLevel }),
    });
    if (!patchRes.ok) {
      const bodyText = await patchRes.text().catch(()=> '');
      context.log.error('members year_level PATCH failed:', patchRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Could not save year level', detail: bodyText });
      return;
    }

    // STEP 2: wipe any existing schedule for this kid.
    const deleteRes = await fetch(`${SUPABASE_URL}/rest/v1/study_assignments?member_id=eq.${encodeURIComponent(kidId)}&family_id=eq.${encodeURIComponent(familyId)}`, {
      method: 'DELETE',
      headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
    });
    if (!deleteRes.ok) {
      const bodyText = await deleteRes.text().catch(()=> '');
      context.log.error('study_assignments DELETE failed:', deleteRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Could not clear existing schedule', detail: bodyText });
      return;
    }

    // STEP 3: load term dates + topics, then regenerate from scratch (cursor starts at 0
    // for everything, since we just deleted all prior assignments).
    const termRes = await fetch(
      `${SUPABASE_URL}/rest/v1/school_term_dates?state=eq.${encodeURIComponent(state)}&calendar_year=eq.${encodeURIComponent(calendarYear)}&select=term_number,start_date,student_start_date,finish_date&order=term_number.asc`,
      { headers: supabaseHeaders() }
    );
    if (!termRes.ok) {
      context.res = jsonRes(502, { error: 'Could not load school_term_dates', yearLevelSaved: true, scheduleCleared: true });
      return;
    }
    const terms = await termRes.json();
    if (!terms.length) {
      context.res = jsonRes(200, {
        yearLevelSaved: true, scheduleCleared: true, assignmentsCreated: 0,
        warning: `Year level saved and old schedule cleared, but no term dates exist for ${state} ${calendarYear} - add them to school_term_dates before a new schedule can be generated.`,
      });
      return;
    }

    const topicsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subject_levels?year_level=eq.${encodeURIComponent(yearLevel)}` +
      `&select=subject:subjects(id,name),topics(id,name,sequence)`,
      { headers: supabaseHeaders() }
    );
    if (!topicsRes.ok) {
      context.res = jsonRes(502, { error: 'Could not load topics for this year level', yearLevelSaved: true, scheduleCleared: true });
      return;
    }
    const subjectLevels = await topicsRes.json();
    const topicsBySubjectName = {};
    const subjectIdByName = {};
    subjectLevels.forEach(sl => {
      if (!sl.subject) return;
      subjectIdByName[sl.subject.name] = sl.subject.id;
      topicsBySubjectName[sl.subject.name] = (sl.topics || []).slice().sort((a,b) => (a.sequence||0) - (b.sequence||0));
    });
    if (!Object.keys(topicsBySubjectName).length) {
      context.res = jsonRes(200, {
        yearLevelSaved: true, scheduleCleared: true, assignmentsCreated: 0,
        warning: `Year level saved and old schedule cleared, but no topics exist for year level "${yearLevel}" yet - seed the curriculum content before a schedule can be generated.`,
      });
      return;
    }

    const cursor = {}; const weeksOnCurrent = {}; const revisionCursor = {};
    Object.keys(topicsBySubjectName).forEach(n => { cursor[n]=0; weeksOnCurrent[n]=0; revisionCursor[n]=0; });
    const exhaustedAt = {};
    const newRows = [];

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
            if (!exhaustedAt[subjName]) exhaustedAt[subjName] = { date: toISODate(weekDays[0]), term: term.term_number };
            if (topics.length) {
              const idx = revisionCursor[subjName] % topics.length;
              weekTopic[subjName] = topics[idx];
              revisionCursor[subjName] += 1;
            }
            return;
          }
          weekTopic[subjName] = topics[cursor[subjName]];
          weeksOnCurrent[subjName] += 1;
          if (weeksOnCurrent[subjName] >= WEEKS_PER_TOPIC) { cursor[subjName] += 1; weeksOnCurrent[subjName] = 0; }
        });
        weekDays.forEach(d => {
          const subjectsToday = DAY_PATTERN[d.getUTCDay()-1] || [];
          subjectsToday.forEach(subjName => {
            const topic = weekTopic[subjName];
            if (!topic) return;
            newRows.push({
              id: genId(), family_id: familyId, member_id: kidId,
              subject_id: subjectIdByName[subjName], topic_id: topic.id,
              term: term.term_number, week: weeks.indexOf(weekDays) + 1,
              assigned_date: toISODate(d), status: 'pending',
            });
          });
        });
      });
    });

    if (newRows.length) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/study_assignments`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify(newRows),
      });
      if (!insertRes.ok) {
        const bodyText = await insertRes.text().catch(()=> '');
        context.log.error('study_assignments bulk insert failed:', insertRes.status, bodyText);
        context.res = jsonRes(502, { error: 'Year level saved and old schedule cleared, but regeneration failed inserting new rows', detail: bodyText, yearLevelSaved: true, scheduleCleared: true });
        return;
      }
    }

    context.res = jsonRes(200, {
      yearLevelSaved: true,
      scheduleCleared: true,
      assignmentsCreated: newRows.length,
      exhausted: exhaustedAt,
    });
  } catch (err) {
    context.log.error('study-set-year-level function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};

module.exports = require('../shared/auth').protect(module.exports, {"parent": true});
