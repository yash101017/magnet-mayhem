'use strict'

function attachMatchSockets(server, roomAction, sessions){
  let WebSocketServer
  try{({WebSocketServer}=require('ws'))}
  catch(error){
    if(error.code!=='MODULE_NOT_FOUND'||process.env.RENDER==='true')throw error
    return false
  }
  const sockets=new WebSocketServer({noServer:true,maxPayload:2048,perMessageDeflate:false})
  const active=new Map()
  server.on('upgrade',(req,network,head)=>{
    if(req.url!=='/match-stream'||sockets.clients.size>=500){network.destroy();return}
    try{
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){
        network.destroy()
        return
      }
    }catch{network.destroy();return}
    sockets.handleUpgrade(req,network,head,ws=>sockets.emit('connection',ws))
  })
  sockets.on('connection',ws=>{
    const state={ws,received:Date.now(),sent:0,window:Date.now(),messages:0}
    const authDeadline=setTimeout(()=>{if(!state.token)ws.close(1008,'Room token required')},5000)
    authDeadline.unref()
    ws.on('error',()=>{})
    ws.on('message',raw=>{
      const now=Date.now()
      if(now-state.window>=1000){state.window=now;state.messages=0}
      if(++state.messages>75){ws.close(1008,'Too many inputs');return}
      let data
      try{data=JSON.parse(raw.toString())}catch{ws.close(1007,'Invalid input');return}
      if(!data||typeof data!=='object'){ws.close(1007,'Invalid input');return}
      if(!state.token){
        if(typeof data.token!=='string'||!sessions.has(data.token)){ws.close(1008,'Room expired');return}
        state.token=data.token
        active.get(state.token)?.ws.close(1000,'Replaced')
        active.set(state.token,state)
      }
      state.received=now
      if(Number.isSafeInteger(data.ping)&&data.ping>=0&&ws.bufferedAmount<32000){
        ws.send(JSON.stringify({pong:data.ping}))
      }
      state.input=data.input
      state.look=data.look
      state.rematch=Boolean(data.rematch)
    })
    ws.on('close',()=>{
      clearTimeout(authDeadline)
      if(state.token&&active.get(state.token)===state)active.delete(state.token)
    })
  })
  const broadcast=setInterval(()=>{
    const now=Date.now()
    for(const [token,state] of active){
      const session=sessions.get(token)
      if(!session||now-state.received>5000){state.ws.close(1008,'Room disconnected');active.delete(token);continue}
      const period=session.match&&!session.match.results?32:145
      if(now-state.sent<period||state.ws.readyState!==1||state.ws.bufferedAmount>32000)continue
      state.sent=now
      try{
        const response=roomAction({action:'sync',token,input:state.input,look:state.look,rematch:state.rematch})
        state.ws.send(JSON.stringify(response))
      }catch(error){
        state.ws.send(JSON.stringify({error:error.message}))
        state.rematch=false
      }
    }
  },33)
  broadcast.unref()
  server.on('close',()=>{
    clearInterval(broadcast)
    for(const ws of sockets.clients)ws.terminate()
    sockets.close()
  })
  return true
}

module.exports={attachMatchSockets}
