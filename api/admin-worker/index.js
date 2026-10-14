const A=require('../shared/admin');
const {processJob}=require('../shared/admin-generation');
module.exports=A.protectWorker(async(context,req)=>{
 if(req.method!=='POST')throw A.fail('Method not allowed.',405);
 context.res=A.response(200,await processJob());
});
