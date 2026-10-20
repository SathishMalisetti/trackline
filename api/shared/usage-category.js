// Titles are already collected by the agent; do not infer all Java usage is gaming.
function usageCategory(name,title,category){
 const current=typeof category==='string'?category.trim():'';
 if(current&&current.toLowerCase()!=='uncategorized')return current;
 const app=String(name||'').split(/[\\/]/).pop().toLowerCase();
 const minecraft=['minecraft.exe','minecraft.windows.exe','minecraftlauncher.exe'].includes(app)
  ||(['java.exe','javaw.exe'].includes(app)&&/^\s*minecraft\b/i.test(String(title||'')));
 return minecraft?'Games':(current||null);
}
module.exports={usageCategory};
