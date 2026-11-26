export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/learning') return new Response(null,{status:404})
    if (!env.LEARNING_TOKEN || request.headers.get('Authorization') !== 'Bearer '+env.LEARNING_TOKEN) {
      return new Response(null,{status:401})
    }
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
