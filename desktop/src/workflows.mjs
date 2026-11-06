export function mentionAt(text, cursor) {
  const prefix=text.slice(0,cursor);
  const match=/(?:^|\s)@([^\s@]*)$/.exec(prefix);
  return match ? { query:match[1], start:cursor-match[1].length-1, end:cursor } : null;
}
export function insertReference(text, mention, path) {
  const quoted=/\s/.test(path) ? `@"${path}"` : `@${path}`;
  return { text:text.slice(0,mention.start)+quoted+' '+text.slice(mention.end).replace(/^ /,''), cursor:mention.start+quoted.length+1 };
}
export function parseLocalLink(href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  let decoded; try{decoded=decodeURIComponent(href);}catch{return null;}
  const match=/^(.*?)(?::(\d+)|#L(\d+))$/.exec(decoded);
  return { path:match ? match[1] : decoded, line:Math.max(1,Number(match?.[2]||match?.[3]||1)) };
}
export function changeGroups(files) {
  return [
    {id:'working',title:'未暂存',files:files.filter(f=>f.status==='??'||f.status[1]&&f.status[1]!==' ')},
    {id:'staged',title:'已暂存',files:files.filter(f=>f.status!=='??'&&f.status[0]&&f.status[0]!==' ')},
  ];
}
