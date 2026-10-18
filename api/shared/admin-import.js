const fetch=require('node-fetch'),crypto=require('node:crypto'),zlib=require('node:zlib');
const A=require('./admin');
const sources=Object.freeze({Mathematics:'https://f10.vcaa.vic.edu.au/learning-areas/mathematics/curriculum',English:'https://f10.vcaa.vic.edu.au/learning-areas/english/english/curriculum',Science:'https://f10.vcaa.vic.edu.au/learning-areas/science/curriculum'});
const attribution='Victorian Curriculum F–10 content © VCAA, licensed CC-BY-NC 3.0 Australia. Trackline is not endorsed by VCAA.';
const licence='https://f10.vcaa.vic.edu.au/copyright-statement';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function canonical(v){if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
function plain(value){
 if(typeof value!=='string')throw A.fail('VCAA source contains an invalid text field.',503);
 const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',times:'×',divide:'÷',hellip:'…',frac12:'½',frac14:'¼',frac34:'¾',sup2:'²',sup3:'³',deg:'°',minus:'−',le:'≤',ge:'≥',ne:'≠',pi:'π'};
 return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi,'^($1)').replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi,'_($1)').replace(/<br\s*\/?\s*>|<\/(p|div|li|h[1-6])>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,(all,e)=>{if(e[0]==='#'){const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):all;}return entities[e.toLowerCase()]??all;}).replace(/[ \t\r]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function extract(html,subject,years){
 if(!sources[subject]||!Array.isArray(years)||!years.length||years.some(y=>![4,7].includes(y)))throw A.fail('Select a supported subject and year.');
 if(typeof html!=='string'||Buffer.byteLength(html)>8*1024*1024||!html.includes('Victorian Curriculum F–10 Version 2.0'))throw A.fail('VCAA returned an unrecognised curriculum version or oversized page.',503);
 const script=html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);if(!script)throw A.fail('VCAA page structure changed. No references were imported.',503);
 let data;try{data=JSON.parse(script[1]);}catch{throw A.fail('VCAA curriculum data could not be read.',503);}
 const c=data?.props?.pageProps?.additionalContent?.curriculum;
 if(c?.disciplineCapabilityLanguageTitle!==subject||!Array.isArray(c.pathways))throw A.fail('VCAA subject data does not match the requested subject.',503);
 const paths=c.pathways.filter(p=>p?.pathway_id==='Standard');if(paths.length!==1||!Array.isArray(paths[0].curriculum))throw A.fail('VCAA standard curriculum pathway is unavailable.',503);
 const units=[],seen=new Set();
 for(const year of [...new Set(years)].sort()){
  const levelId=subject==='Science'?(year===4?'3–4':'7–8'):String(year),levels=paths[0].curriculum.filter(l=>l?.id===levelId);
  if(levels.length!==1||!Array.isArray(levels[0].contentDescriptionsContent))throw A.fail(`VCAA level ${levelId} is missing. No references were imported.`,503);
  const level=levels[0],before=units.length;
  function add(descriptor,strand,substrand){
   const prefix=subject==='Science'?'VC2S'+(year===4?'4':'8'):subject==='Mathematics'?'VC2M'+year:'VC2E'+year;
   if(!descriptor||typeof descriptor.code!=='string'||!new RegExp('^'+prefix+'[A-Z]+\\d{2}$').test(descriptor.code)||!Array.isArray(descriptor.elaborations)||!Array.isArray(descriptor.achievementExtracts))throw A.fail('VCAA descriptor structure changed. No references were imported.',503);
   const description=plain(descriptor.contentDescription);if(description.length<10||description.length>10000)throw A.fail('VCAA descriptor text is missing or too large.',503);
   const key=year+':'+descriptor.code;if(seen.has(key))throw A.fail('VCAA source has duplicate descriptor codes. No references were imported.',503);seen.add(key);
   const details={level_label:level.level,level_ids:subject==='Science'?(year===4?[3,4]:[7,8]):[year],strand:plain(strand),substrand:plain(substrand),stem:plain(descriptor.stem||''),description_html:descriptor.contentDescription,descriptor_id:descriptor.id,internal_id:descriptor.internalId,
    elaborations:descriptor.elaborations.map(e=>({id:e.id,html:e.elaborationText,text:plain(e.elaborationText)})),achievement_extracts:descriptor.achievementExtracts,
    achievement_standard:plain(level.achievementStandardContent||''),achievement_standard_html:level.achievementStandardContent||'',level_description:plain(level.levelDescriptionContent||''),attribution,licence_url:licence};
   const normalized={descriptor_code:descriptor.code,descriptor_text:description,year_level:year,source_details:details};
   units.push({...normalized,title:(details.substrand||details.strand||subject)+' · '+descriptor.code,source_record_hash:sha(canonical(normalized))});
  }
  for(const strand of level.contentDescriptionsContent){
   if(!strand||!Array.isArray(strand.contentDescriptions))throw A.fail('VCAA strand structure changed.',503);
   for(const d of strand.contentDescriptions)add(d,strand.title,'');
   if(strand.subStrands!==undefined&&!Array.isArray(strand.subStrands))throw A.fail('VCAA substrand structure changed.',503);
   for(const sub of strand.subStrands||[]){if(!Array.isArray(sub?.contentDescriptions))throw A.fail('VCAA substrand descriptors are unavailable.',503);for(const d of sub.contentDescriptions)add(d,strand.title,sub.title);}
  }
  if(units.length===before)throw A.fail('VCAA level contains no descriptors. No references were imported.',503);
 }
 if(units.length>500)throw A.fail('VCAA import is unexpectedly large.',503);
 return{units,buildId:typeof data.buildId==='string'?data.buildId:null};
}
async function download(subject,years){
 const url=sources[subject];if(!url)throw A.fail('Unsupported subject.');
 const r=await fetch(url,{timeout:20000,size:8*1024*1024,redirect:'error',headers:{Accept:'text/html','User-Agent':'TracklineCurriculumImporter/1.0'}});
 if(!r.ok||!r.headers.get('content-type')?.includes('text/html'))throw A.fail('The official VCAA source is unavailable. Retry later.',503);
 const html=await r.text(),parsed=extract(html,subject,years);
 return{units:parsed.units,provenance:{source_url:url,source_sha256:sha(html),source_fetched_at:new Date().toISOString(),source_bytes:Buffer.byteLength(html),source_etag:r.headers.get('etag'),source_last_modified:r.headers.get('last-modified'),source_build_id:parsed.buildId,parser_version:'vcaa-next-v1',source_archive_base64:zlib.gzipSync(html).toString('base64'),attribution,licence_url:licence}};
}
async function processImport(id=null){
 const job=await A.rpc('admin_claim_curriculum_import',{p_id:id});if(!job)return{processed:false};
 try{
  if(job.source_url!==sources[job.subject])throw A.fail('Import source URL does not match the official source.',503);
  const result=await download(job.subject,job.year_levels);
  const saved=await A.rpc('admin_finish_curriculum_import',{p_id:job.id,p_lease:job.lease_id,p_provenance:result.provenance,p_units:result.units,p_error:null});
  return{processed:true,importId:job.id,...saved};
 }catch(e){
  const saved=await A.rpc('admin_finish_curriculum_import',{p_id:job.id,p_lease:job.lease_id,p_provenance:null,p_units:null,p_error:e.status?e.message:'Source download or parsing failed. Retry later.'});
  return{processed:true,importId:job.id,status:saved.status};
 }
}
function reference(unit){return{descriptor_code:unit.descriptor_code,descriptor_text:unit.descriptor_text,source_url:unit.source_url,curriculum_version:unit.curriculum_version,year_level:unit.year_level,subject:unit.subject,...(unit.source_import_id?{source_import_id:unit.source_import_id,source_record_hash:unit.source_record_hash,source_level:unit.source_details?.level_label,attribution,licence_url:licence}:{})};}
module.exports={sources,attribution,licence,plain,extract,download,processImport,reference,canonical};
