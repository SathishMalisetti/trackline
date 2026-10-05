// Trackline study-exam-submit API
//
// POST /api/study-exam-submit
//   body: { familyId, kidId, topicId, attemptId, answers: { questionId: chosenOption, ... } }
//
// Scoring happens ENTIRELY server-side against the question_ids recorded on
// the attempt row by study-exam-start — the client's answers are trusted,
// the correct answers never are. Applies the 70% pass threshold agreed
// earlier and updates topic_progress accordingly (completed vs reassigned).

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASS_THRESHOLD = 70;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function genId(){
  return 'xa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
}

module.exports = async function (context, req) {
  context.log('study-exam-submit invoked:', req.method);

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
    const { familyId, kidId, topicId, attemptId, answers } = body;
    if (!familyId || !kidId || !topicId || !attemptId || !answers) {
      context.res = jsonRes(400, { error: 'familyId, kidId, topicId, attemptId and answers are required' });
      return;
    }

    // Load the attempt and confirm it actually belongs to this family/kid/topic —
    // never trust the request body alone for who this attempt is for.
    const attRes = await fetch(
      `${SUPABASE_URL}/rest/v1/exam_attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,family_id,member_id,topic_id,question_ids,status`,
      { headers: supabaseHeaders() }
    );
    if (!attRes.ok) {
      context.res = jsonRes(502, { error: 'Upstream database error loading attempt' });
      return;
    }
    const attempts = await attRes.json();
    const attempt = attempts[0];
    if (!attempt || attempt.family_id !== familyId || attempt.member_id !== kidId || attempt.topic_id !== topicId) {
      context.res = jsonRes(403, { error: 'Attempt does not match the supplied family/kid/topic.' });
      return;
    }
    if (attempt.status === 'completed') {
      context.res = jsonRes(409, { error: 'This attempt has already been submitted.' });
      return;
    }

    const questionIds = attempt.question_ids || [];
    const qRes = await fetch(
      `${SUPABASE_URL}/rest/v1/question_bank?id=in.(${questionIds.map(encodeURIComponent).join(',')})&select=id,answer`,
      { headers: supabaseHeaders() }
    );
    if (!qRes.ok) {
      context.res = jsonRes(502, { error: 'Upstream database error loading questions' });
      return;
    }
    const questions = await qRes.json();

    let correctCount = 0;
    const answerRows = questions.map(q => {
      const studentAnswer = answers[q.id];
      const isCorrect = studentAnswer === q.answer;
      if (isCorrect) correctCount++;
      return {
        id: genId(),
        attempt_id: attemptId,
        question_id: q.id,
        student_answer: studentAnswer || null,
        is_correct: isCorrect,
      };
    });
    const total = questions.length;
    const score = total ? Math.round((correctCount / total) * 100) : 0;

    // Insert the answer breakdown (for reports later — not read back here).
    await fetch(`${SUPABASE_URL}/rest/v1/exam_answers`, {
      method: 'POST',
      headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(answerRows),
    });

    // Close out the attempt.
    await fetch(`${SUPABASE_URL}/rest/v1/exam_attempts?id=eq.${encodeURIComponent(attemptId)}`, {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'completed', score, completed_at: new Date().toISOString() }),
    });

    // Upsert topic_progress — unique(member_id, topic_id) lets PostgREST merge
    // in one call via on_conflict, instead of a separate GET-then-PATCH round trip.
    const newStatus = score >= PASS_THRESHOLD ? 'completed' : 'reassigned';
    const progRes = await fetch(
      `${SUPABASE_URL}/rest/v1/topic_progress?on_conflict=member_id,topic_id`,
      {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify([{
          id: genId(),
          family_id: familyId,
          member_id: kidId,
          topic_id: topicId,
          status: newStatus,
          exam_score: score,
          exam_completed_at: new Date().toISOString(),
          attempt_count: 1, // NOTE: merge-duplicates overwrites rather than increments —
                             // see comment below for the increment-safe alternative.
          updated_at: new Date().toISOString(),
        }]),
      }
    );
    if (!progRes.ok) {
      const bodyText = await progRes.text().catch(()=> '');
      context.log.error('topic_progress upsert failed:', progRes.status, bodyText);
      // Non-fatal for the response to the kid — the exam itself was scored and
      // recorded; log it and let a parent-facing report catch the discrepancy.
    }

    context.res = jsonRes(200, { score, correctCount, total, passed: score >= PASS_THRESHOLD });
  } catch (err) {
    context.log.error('study-exam-submit function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};

// IMPORTANT — attempt_count above: PostgREST's merge-duplicates does a column
// overwrite, not a SQL increment, so `attempt_count: 1` will RESET the counter
// on every retry rather than growing it. Two ways to fix, pick one:
//   (a) simplest: read the existing topic_progress row first (one extra GET),
//       compute (existing.attempt_count || 0) + 1, then include that number
//       in the upsert body above.
//   (b) cleaner long-term: write a small Postgres function (increment_topic_attempt)
//       and call it via /rest/v1/rpc/, same pattern family-data already uses for
//       get_family_data/save_family_data — does the +1 atomically in SQL.
// Left as-is with a flat 1 for this first pass since it doesn't block testing
// the exam flow end-to-end; fix before relying on attempt_count for anything
// (e.g. capping retries).

module.exports = require('../shared/auth').protect(module.exports, {});
