const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const L=require('../shared/curriculum-levels'),I=require('../shared/admin-import'),{unitFields}=require('../admin-manage');
test('all published level mappings and subject availability are explicit',()=>{
 assert.equal(L.levels.length,16);assert.equal(L.label(-4),'Foundation A');assert.equal(L.label(0),'Foundation');assert.equal(L.label(101),'Level 10A');
 for(const subject of Object.keys(I.sources)){
  const available=L.levels.filter(l=>L.supports(subject,l.value));assert.equal(available.length,subject==='Mathematics'?16:subject==='English'?15:11);
  const sourceLevels=[...new Map(available.map(l=>{const m=L.source(subject,l.value);return[m.id,{id:m.id,level:m.id,contentDescriptionsContent:[{title:'Fixture strand',contentDescriptions:[{id:'fixture-'+m.id,internalId:1,code:(subject==='Science'?'VC2S':subject==='English'?'VC2E':'VC2M')+m.suffix+'N99',contentDescription:'<p>Fictional descriptor for all-level mapping verification.</p>',elaborations:[],achievementExtracts:[]}]}]}];})).values()];
  const html='Victorian Curriculum F–10 Version 2.0<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{additionalContent:{curriculum:{disciplineCapabilityLanguageTitle:subject,pathways:[{pathway_id:'Standard',curriculum:sourceLevels}]}}}}})+'</script>';
  const result=I.extract(html,subject,available.map(l=>l.value));assert.equal(result.units.length,available.length);
  for(const l of available){const unit=result.units.find(u=>u.year_level===l.value);assert.deepEqual(unit.source_details.level_ids,L.source(subject,l.value).ids);assert.equal(unitFields({title:'Fixture',subject,year_level:l.value,source_url:I.sources[subject],descriptor_code:unit.descriptor_code,descriptor_text:unit.descriptor_text}).year_level,l.value);}
 }
 assert.throws(()=>unitFields({source_url:I.sources.Science,subject:'Science',year_level:-4}),/available/);
 assert.throws(()=>I.extract('','English',[101]),/supported/);
});
test('single-file admin selectors share backend level definitions',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../../app/admin/index.html'),'utf8');const match=html.match(/const LEVELS=(\[[^\n]+\]);/);assert.deepEqual(JSON.parse(match[1]),L.levels);
});
