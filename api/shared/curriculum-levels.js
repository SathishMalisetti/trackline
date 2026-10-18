// Stable numeric storage IDs. 101 means Maths Level 10A, never Year 11.
const levels=Object.freeze([
 ...['A','B','C','D'].map((stage,i)=>({value:i-4,label:'Foundation '+stage,sourceId:'FL'+stage,suffix:'F'+stage})),
 {value:0,label:'Foundation',sourceId:'F',suffix:'F'},
 ...Array.from({length:10},(_,i)=>({value:i+1,label:'Year '+(i+1),sourceId:String(i+1),suffix:String(i+1)})),
 {value:101,label:'Level 10A',sourceId:'10A',suffix:'10A'}
]);
const valid=value=>Number.isInteger(value)&&levels.some(l=>l.value===value);
const supports=(subject,value)=>valid(value)&&(subject==='Mathematics'||subject==='English'&&value!==101||subject==='Science'&&value>=0&&value<=10);
const label=value=>levels.find(l=>l.value===value)?.label||'Unknown level';
function source(subject,value){
 if(!supports(subject,value))throw new Error('Unsupported subject/level combination');
 if(subject!=='Science'){const l=levels.find(l=>l.value===value);return{id:l.sourceId,suffix:l.suffix,ids:[value]};}
 const end=value<=2?2:Math.ceil(value/2)*2;
 return{id:end===2?'F–2':`${end-1}–${end}`,suffix:String(end),ids:end===2?[0,1,2]:[end-1,end]};
}
module.exports={levels,valid,supports,label,source};
