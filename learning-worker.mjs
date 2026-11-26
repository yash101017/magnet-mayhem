export default {
  async scheduled(_event,env){
    const cutoff=Date.now()-90*24*60*60*1000
    await env.LEARNING.batch([
      env.LEARNING.prepare('DELETE FROM support_requests WHERE created<?').bind(cutoff),
      env.LEARNING.prepare('DELETE FROM name_reports WHERE created<?').bind(cutoff),
      env.LEARNING.prepare("DELETE FROM name_reviews WHERE decision='dismiss' AND reviewed_at<?").bind(cutoff)
    ])
  },
  async fetch(request, env) {
    const url=new URL(request.url)
    if (!['/learning','/profiles','/reports','/support','/moderation'].includes(url.pathname)) return new Response(null,{status:404})
    if (!env.LEARNING_TOKEN || request.headers.get('Authorization') !== 'Bearer '+env.LEARNING_TOKEN) {
      return new Response(null,{status:401})
    }
    if(url.pathname==='/moderation'){
      if(request.method!=='GET')return new Response(null,{status:405})
      const {results}=await env.LEARNING.prepare("SELECT normalized FROM name_reviews WHERE decision='block'").all()
      return Response.json(results.map(row=>row.normalized),{headers:{'Cache-Control':'no-store'}})
    }
    if(url.pathname==='/support'){
      if(request.method!=='POST')return new Response(null,{status:405})
      const row=await request.json().catch(()=>null)
      if(!row||!/^[a-f0-9]{48}$/.test(row.id)||typeof row.email!=='string'||row.email.length>254||
        typeof row.message!=='string'||row.message.length>1500||!Number.isSafeInteger(row.created))
        return new Response(null,{status:400})
      await env.LEARNING.prepare('INSERT OR IGNORE INTO support_requests(id,email,message,created) VALUES(?,?,?,?)')
        .bind(row.id,row.email,row.message,row.created).run()
      return new Response(null,{status:204})
    }
    if(url.pathname==='/reports'){
      if(request.method!=='POST')return new Response(null,{status:405})
      const report=await request.json().catch(()=>null)
      if(!report||!/^[a-f0-9]{48}$/.test(report.id)||typeof report.name!=='string'||report.name.length>20||
        !Number.isSafeInteger(report.created))return new Response(null,{status:400})
      await env.LEARNING.prepare('INSERT OR IGNORE INTO name_reports(id,name,created) VALUES(?,?,?)')
        .bind(report.id,report.name,report.created).run()
      return new Response(null,{status:204})
    }
    if(url.pathname==='/profiles')return profiles(request,env,url)
    if (request.method === 'GET') {
      const {results}=await env.LEARNING.prepare('SELECT tier, field, tactic, games, reward FROM bot_tactics').all()
      return Response.json(results,{headers:{'Cache-Control':'no-store'}})
    }
    if (request.method !== 'POST') return new Response(null,{status:405})
    if (Number(request.headers.get('Content-Length'))>50000) return new Response(null,{status:413})
    const rows=await request.json().catch(()=>null)
    if (!Array.isArray(rows)||rows.length<1||rows.length>50||rows.some(row=>!row||
      !/^[a-f0-9]{48}$/.test(row.id)||![850,950,1050,1150,1250,1400,1550,1700,1850].includes(row.tier)||
      !Number.isInteger(row.field)||row.field<0||row.field>4||!['direct','inside','breakaway','wide'].includes(row.tactic)||
      !Number.isFinite(row.reward)||row.reward<0||row.reward>1)) return new Response(null,{status:400})
    const insert=env.LEARNING.prepare('INSERT OR IGNORE INTO bot_training_events (id,tier,field,tactic,reward) VALUES (?,?,?,?,?)')
    await env.LEARNING.batch(rows.map(row=>insert.bind(row.id,row.tier,row.field,row.tactic,row.reward)))
    return new Response(null,{status:204})
  }
}

async function profiles(request,env,url){
  if(request.method==='GET'){
    const cursor=url.searchParams.get('after')||''
    if(cursor&&!/^[a-f0-9]{48}$/.test(cursor))return new Response(null,{status:400})
    const {results}=await env.LEARNING.prepare(
      'SELECT id,revision,profile FROM player_profiles WHERE id>? ORDER BY id LIMIT 100'
    ).bind(cursor).all()
    return Response.json(results,{headers:{'Cache-Control':'no-store'}})
  }
  if(request.method!=='POST')return new Response(null,{status:405})
  const raw=await request.text()
  if(raw.length>400000)return new Response(null,{status:413})
  let rows
  try{rows=JSON.parse(raw)}catch{return new Response(null,{status:400})}
  if(!Array.isArray(rows)||!rows.length||rows.length>25||rows.some(row=>!row||
    !/^[a-f0-9]{48}$/.test(row.id)||!Number.isSafeInteger(row.revision)||row.revision<=0||
    typeof row.profile!=='string'||row.profile.length>15000))return new Response(null,{status:400})
  const write=env.LEARNING.prepare(`
    INSERT INTO player_profiles(id,revision,profile) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,profile=excluded.profile
    WHERE excluded.revision>player_profiles.revision
  `)
  await env.LEARNING.batch(rows.map(row=>write.bind(row.id,row.revision,row.profile)))
  return new Response(null,{status:204})
}
