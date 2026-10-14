const A=require('../shared/admin');
const G=require('../shared/admin-generation');
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw A.fail('Invalid record ID.');return value;};
function field(value,name,min=1,max=500){if(typeof value!=='string'||value.trim().length<min||value.length>max)throw A.fail(`Enter a valid ${name}.`);return value.trim();}
function unitFields(b){
 let url;try{url=new URL(b.source_url);}catch{throw A.fail('Enter an official VCAA source URL.');}
 if(url.protocol!=='https:'||!(url.hostname==='vcaa.vic.edu.au'||url.hostname.endsWith('.vcaa.vic.edu.au')))throw A.fail('Use an HTTPS VCAA curriculum reference.');
 if(![4,7].includes(Number(b.year_level))||!['Mathematics','English','Science'].includes(b.subject))throw A.fail('Select Year 4 or Year 7 and a supported subject.');
 return{title:field(b.title,'unit title',1,150),subject:b.subject,year_level:Number(b.year_level),curriculum_version:field(b.curriculum_version||'Victorian Curriculum F-10 Version 2.0','curriculum version',1,100),source_url:url.href,descriptor_code:field(b.descriptor_code,'descriptor code',1,80),descriptor_text:field(b.descriptor_text,'descriptor text',10,10000)};
}
function scrub(value){if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|pin.?hash|token|credential/i.test(k)).map(([k,v])=>[k,scrub(v)]));return value;}
module.exports=A.protect(async(context,req)=>{
 const b=req.body||{},kind=req.query?.kind||'overview';let result;
 if(req.method==='GET'){
  const offset=Math.max(0,Math.min(100000,parseInt(req.query?.offset||0,10)||0));
  if(kind==='overview'){
   const [units,jobs,versions]=await Promise.all([A.db('curriculum_units?select=id,subject,year_level,archived'),A.db('curriculum_generation_jobs?select=id,status,error,created_at&order=created_at.desc&limit=8'),A.db('curriculum_content_versions?select=id,status')]);
   result={units,versions,jobs,generationConfigured:!!process.env.OPENAI_API_KEY,workerConfigured:!!process.env.ADMIN_GENERATION_WORKER_KEY&&process.env.ADMIN_GENERATION_WORKER_KEY.length>=32,model:process.env.ADMIN_GENERATION_MODEL||'gpt-4.1-mini'};
  }else if(kind==='units'){
   let filter='';if(req.query?.unitId)filter+='&id=eq.'+uuid(req.query.unitId);
   if(req.query?.year){if(!['4','7'].includes(String(req.query.year)))throw A.fail('Select Year 4 or 7.');filter+='&year_level=eq.'+req.query.year;}
   if(req.query?.subject){if(!['Mathematics','English','Science'].includes(req.query.subject))throw A.fail('Select a supported subject.');filter+='&subject=eq.'+encodeURIComponent(req.query.subject);}
   result=await A.db('curriculum_units?select=*&order=created_at.desc&limit=50&offset='+offset+filter);
  }
  else if(kind==='versions')result=await A.db('curriculum_content_versions?unit_id=eq.'+uuid(req.query.unitId)+'&select=*&order=version.desc&limit=50');
  else if(kind==='jobs')result=await A.db('curriculum_generation_jobs?select=*,unit:curriculum_units(title)&order=created_at.desc&limit=50&offset='+offset);
  else if(kind==='families'){
   const search=req.query?.search||'';if(!/^[\p{L}\p{N} _-]{0,80}$/u.test(search))throw A.fail('Use letters and numbers for family search.');
   result=await A.db('families?select=id,name,updated_at&order=updated_at.desc&limit=25&offset='+offset+(search?'&name=ilike.*'+encodeURIComponent(search)+'*':''));
  }else if(kind==='admins')result=await A.db('platform_admins?select=id,username,enabled,created_at&order=created_at&limit=100');
  else if(kind==='audit')result=await A.db('admin_audit_log?select=id,admin_id,action,target_id,details,created_at&order=created_at.desc&limit=50&offset='+offset);
  else throw A.fail('Unknown administration view.');
 }else if(req.method==='POST'){
  if(b.action==='unit-save'){
   const row={...unitFields(b),created_by:req.admin.id};
   if(b.id){const id=uuid(b.id);const versions=await A.db('curriculum_content_versions?unit_id=eq.'+id+'&select=id&limit=1');if(versions.length)throw A.fail('Source references are immutable once content exists. Add a new unit for a changed source.',409);result=await A.patch('curriculum_units',id,row);}
   else result=await A.insert('curriculum_units',row);
   await A.audit(req.admin,'unit.save',(result[0]||{}).id);
  }else if(b.action==='units-import'){
   if(!Array.isArray(b.units)||!b.units.length||b.units.length>100)throw A.fail('Import between 1 and 100 unit references.');
   result=await A.insert('curriculum_units',b.units.map(u=>({...unitFields(u),created_by:req.admin.id})));await A.audit(req.admin,'units.import',null,{count:result.length});
  }else if(b.action==='unit-archive'){result=await A.patch('curriculum_units',uuid(b.id),{archived:!!b.archived});await A.audit(req.admin,'unit.archive',b.id);}
  else if(b.action==='draft-create'){
   const id=uuid(b.unitId),[unit]=await A.db('curriculum_units?id=eq.'+id+'&select=*');if(!unit||unit.archived)throw A.fail('Select an active unit.');
   const issues=G.validate(b.content);if(issues.length)throw A.fail(issues.slice(0,5).join(' '));
   result=await A.rpc('admin_create_draft',{p_unit:id,p_admin:req.admin.id,p_content:{...b.content,session:{learn_minutes:30,practice_minutes:15,checkpoint_minutes:5,pass_percent:80},reference:{source_url:unit.source_url,descriptor_code:unit.descriptor_code,descriptor_text:unit.descriptor_text,curriculum_version:unit.curriculum_version,year_level:unit.year_level,subject:unit.subject}}});
  }else if(b.action==='version-save'||b.action==='version-validate'){
   const id=uuid(b.id),[v]=await A.db('curriculum_content_versions?id=eq.'+id+'&select=*');if(!v||!['draft','validated'].includes(v.status))throw A.fail('Only unpublished drafts can be edited or validated.',409);
   const content=b.action==='version-save'?b.content:v.content,issues=G.validate(content);if(issues.length)throw A.fail(issues.slice(0,5).join(' '));
   // Preserve immutable reference metadata through draft editing.
   const updated={...content,reference:v.content.reference,session:{learn_minutes:30,practice_minutes:15,checkpoint_minutes:5,pass_percent:80}};
   result=await A.db('curriculum_content_versions?id=eq.'+id+'&status=in.(draft,validated)',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({content:updated,status:b.action==='version-validate'?'validated':'draft',review_notes:typeof b.review_notes==='string'?b.review_notes.slice(0,2000):v.review_notes})});
   if(!result.length)throw A.fail('The draft changed while you were editing. Reload it.',409);await A.audit(req.admin,b.action,b.id);
  }else if(b.action==='version-publish'){
   A.recentPassword(req);if(b.reviewConfirmed!==true)throw A.fail('Confirm the lesson, answers and curriculum fit have been reviewed.');
   await A.rpc('admin_publish_content',{p_id:uuid(b.id),p_admin:req.admin.id});result={ok:true};
  }else if(b.action==='version-archive'){A.recentPassword(req);result=await A.patch('curriculum_content_versions',uuid(b.id),{status:'archived'});await A.audit(req.admin,'content.archive',b.id);}
  else if(b.action==='generation-queue'){
   if(!process.env.OPENAI_API_KEY)throw A.fail('Configure the server OPENAI_API_KEY before queuing generation.',503);
   const [unit]=await A.db('curriculum_units?id=eq.'+uuid(b.unitId)+'&select=id,archived');if(!unit||unit.archived)throw A.fail('Select an active unit.');
   result=await A.insert('curriculum_generation_jobs',{unit_id:unit.id,created_by:req.admin.id});await A.audit(req.admin,'generation.queue',result[0].id);
  }else if(b.action==='generation-run'){result=await G.processJob(b.id?uuid(b.id):null);}
  else if(b.action==='generation-retry'||b.action==='generation-cancel'){
   const id=uuid(b.id),allowed=b.action==='generation-retry'?'failed':'queued,running';
   result=await A.db('curriculum_generation_jobs?id=eq.'+id+'&status=in.('+allowed+')',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(b.action==='generation-retry'?{status:'queued',attempts:0,error:null,finished_at:null}:{status:'cancelled',finished_at:new Date().toISOString()})});
   if(!result.length)throw A.fail('This job cannot be changed in its current state.',409);await A.audit(req.admin,b.action,id);
  }else if(b.action==='family-open'){
   const id=field(b.familyId,'family ID',1,128);await A.audit(req.admin,'family.details_view',id);
   const filter='family_id=eq.'+encodeURIComponent(id);
   const [data,progress,devices,taskLogs,examAttempts,shoppingLists]=await Promise.all([
    A.rpc('get_family_data',{p_family_id:id}),
    A.db('topic_progress?'+filter+'&select=member_id,topic_id,status,exam_score,attempt_count&order=updated_at.desc&limit=250'),
    A.db('devices?'+filter+'&select=id,member_id,hostname,label,last_sync_at,revoked'),
    A.db('chore_logs?'+filter+'&select=chore_id,date,completed_at,logged_by&order=date.desc&limit=250'),
    A.db('exam_attempts?'+filter+'&select=member_id,topic_id,attempt_number,score,status,started_at,completed_at&order=started_at.desc&limit=250'),
    A.db('shopping_lists?'+filter+'&select=date,data,updated_at&order=date.desc&limit=50')
   ]);if(!data)throw A.fail('Family not found.',404);result=scrub({familyData:data,studyProgress:progress,devices,taskLogs,examAttempts,shoppingLists});
  }else if(b.action==='admin-create'){
   A.recentPassword(req);const username=field(b.username,'username',3,32).toLowerCase();if(!/^[a-z][a-z0-9_-]{2,31}$/.test(username))throw A.fail('Use letters, numbers, _ or - for the username.');
   if(typeof b.password!=='string'||b.password.length<12||b.password.length>128||typeof b.pin!=='string'||!/^\d{4}$/.test(b.pin))throw A.fail('Use a password of 12–128 characters and a 4-digit PIN.');
   const rows=await A.insert('platform_admins',{username,password_hash:await A.hashSecret(b.password),pin_hash:await A.hashSecret(b.pin)});result=rows.map(A.publicAdmin);await A.audit(req.admin,'admin.created',rows[0].id);
  }else if(b.action==='account-change'){
   A.recentPassword(req);const id=uuid(b.id);if(b.password!=null&&(typeof b.password!=='string'||b.password.length<12||b.password.length>128))throw A.fail('Use a password of 12–128 characters.');if(b.pin!=null&&(typeof b.pin!=='string'||!/^\d{4}$/.test(b.pin)))throw A.fail('Use a 4-digit PIN.');
   if(b.enabled!=null&&typeof b.enabled!=='boolean')throw A.fail('Invalid account status.');
   if(b.password==null&&b.pin==null&&b.enabled==null)throw A.fail('Choose a credential or account change.');
   await A.rpc('admin_change_account',{p_actor:req.admin.id,p_target:id,p_password:b.password?await A.hashSecret(b.password):null,p_pin:b.pin?await A.hashSecret(b.pin):null,p_enabled:b.enabled??null});
   context.res=A.response(200,{ok:true,signedOut:id===req.admin.id},id===req.admin.id?{'Set-Cookie':A.cookie('',true)}:{});return;
  }else throw A.fail('Unknown administration action.');
 }else throw A.fail('Method not allowed.',405);
 context.res=A.response(200,result);
});
module.exports.scrub=scrub;
module.exports.unitFields=unitFields;
