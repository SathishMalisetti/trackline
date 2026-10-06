// Trackline study-exam-start API
//
// POST /api/study-exam-start   body: { familyId, kidId, topicId }
//
// Samples questions from question_bank server-side and returns them WITHOUT
// the answer field — the correct answers must never reach the browser before
// grading. Records which exact questions were shown (question_ids on the
// exam_attempts row) so study-exam-submit can grade against exactly what was
// asked, not trust the client's word for it.
//
// REQUIRES a `question_ids jsonb` column on exam_attempts (not in the original
// schema draft — added for this endpoint to work securely).

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUESTIONS_PER_EXAM = 8;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function genId(){
  return 'xa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
}
function sampleArray(arr, n){
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

module.exports = async function (context, req) {
  context.log('study-exam-start invoked:', req.method);

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
    const { familyId, kidId, topicId } = body;
    if (!familyId || !kidId || !topicId) {
      context.res = jsonRes(400, { error: 'familyId, kidId and topicId are required' });
      return;
    }

    const qRes = await fetch(
      `${SUPABASE_URL}/rest/v1/question_bank?topic_id=eq.${encodeURIComponent(topicId)}&select=id,question,options,difficulty`,
      { headers: supabaseHeaders() }
    );
    if (!qRes.ok) {
      const bodyText = await qRes.text().catch(()=> '');
      context.log.error('question_bank GET failed:', qRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: qRes.status, detail: bodyText });
      return;
    }
    const allQuestions = await qRes.json();
    if (!allQuestions.length) {
      context.res = jsonRes(404, { error: 'No questions available for this topic yet.' });
      return;
    }

    const sampled = sampleArray(allQuestions, Math.min(QUESTIONS_PER_EXAM, allQuestions.length));
    const attemptId = genId();

    // Count prior attempts for this kid+topic to set attempt_number correctly.
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/exam_attempts?member_id=eq.${encodeURIComponent(kidId)}&topic_id=eq.${encodeURIComponent(topicId)}&select=id`,
      { headers: supabaseHeaders() }
    );
    const priorAttempts = countRes.ok ? await countRes.json() : [];

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/exam_attempts`, {
      method: 'POST',
      headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        id: attemptId,
        family_id: familyId,
        member_id: kidId,
        topic_id: topicId,
        attempt_number: priorAttempts.length + 1,
        status: 'in_progress',
        question_ids: sampled.map(q => q.id),
      }),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(()=> '');
      context.log.error('exam_attempts INSERT failed:', insertRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: insertRes.status, detail: bodyText });
      return;
    }

    // Answer field deliberately excluded here.
    const questions = sampled.map(q => ({ id: q.id, question: q.question, options: q.options }));
    context.res = jsonRes(200, { attemptId, questions });
  } catch (err) {
    context.log.error('study-exam-start function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};

module.exports = require('../shared/auth').protect(module.exports, {});
