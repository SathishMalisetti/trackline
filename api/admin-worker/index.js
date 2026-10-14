const A=require('../shared/admin');
const {processJob}=require('../shared/admin-generation');
const {processImport}=require('../shared/admin-import');
module.exports=A.protectWorker(async(context,req)=>{
 if(req.method!=='POST')throw A.fail('Method not allowed.',405);
 const imported=await processImport();
 context.res=A.response(200,imported.processed?imported:process.env.OPENAI_API_KEY?await processJob():{processed:false,generationConfigured:false});
});
