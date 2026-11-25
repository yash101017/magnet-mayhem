'use strict'
const http=require('node:http')
const fs=require('node:fs')
const path=require('node:path')
const {randomBytes,randomInt,scrypt,timingSafeEqual}=require('node:crypto')
const {promisify}=require('node:util')
const derive=promisify(scrypt)
const opponentNames=require('./opponent-names.cjs')
const starterDiamonds=25
const stake=30
const refillAmount=100
const refillPeriod=60*60*1000
const reservedNames=new Set(opponentNames.map(name=>name.toLowerCase()))
const {fields,botRivals,createGame,warTeamSize,teamOf,step,stepSeconds,clamp,catalog,diamondPacks,coinExchange,ownedStyle,shipMagnet}=require('./engine.cjs')
const {handleWebhook}=require('./payment.cjs')
const {attachMatchSockets}=require('./match-socket.cjs')
let streamAvailable=false

const page=fs.readFileSync(path.join(__dirname,'index.html'))
const shipArt=fs.readFileSync(path.join(__dirname,'ship-art.webp'))
const effectArt=fs.readFileSync(path.join(__dirname,'effect-art.webp'))
const dataPath=process.env.MAGNET_DATA_FILE||path.join(__dirname,'profiles.json')
const profiles=new Map()
try{
  for(const [key,value] of Object.entries(JSON.parse(fs.readFileSync(dataPath,'utf8'))))profiles.set(key,value)
}catch(error){if(error.code!=='ENOENT')throw error}
const usernames=new Map()
for(const [key,account] of profiles)if(account.username)usernames.set(account.username.toLowerCase(),key)
const emails=new Map()
for(const [key,account] of profiles)if(account.email)emails.set(account.email,key)
const loginLimits=new Map()
const sessions=new Map(), inviteRooms=new Map(), matches=new Map(), queued=new Map(), warQueue=new Map()
const identities=new Map(), addressLimits=new Map()
const id=()=>randomBytes(24).toString('hex')
const legalKey=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value)
const expiration=12000
const botWaitMs=4000
const warWaitMs=6500
const warLineup=[2,1,3,0,4]
let lastTick=Date.now(), lastMaintenance=0, dirty=false

function persist(){
  const scratch=dataPath+'.tmp'
  fs.writeFileSync(scratch,JSON.stringify(Object.fromEntries(profiles)))
  fs.renameSync(scratch,dataPath)
  dirty=false
}
function existingKey(value){
  return legalKey(value)&&profiles.has(value)?value:null
}
function identity(value){
  const key=existingKey(value)
  if(!key||!profiles.get(key).username)throw new Error('Choose a username before playing.')
  return key
}
function refreshCoins(account,now=Date.now()){
  if(!Number.isFinite(account.coins)){account.coins=refillAmount;dirty=true}
  if(!Number.isFinite(account.nextCoinsAt)){account.nextCoinsAt=now+refillPeriod;dirty=true}
  if(now<account.nextCoinsAt)return
  const periods=1+Math.floor((now-account.nextCoinsAt)/refillPeriod)
  account.coins+=periods*refillAmount
  account.nextCoinsAt+=periods*refillPeriod
  dirty=true
}
function canEnter(profile){
  const account=profiles.get(profile)
  refreshCoins(account)
  return account.coins>=stake
}
function profileState(key){
  const account=profiles.get(key)
  refreshCoins(account)
  return {refillIn:Math.max(0,account.nextCoinsAt-Date.now()),profile:key,username:account.username||null,guest:!account.credentials,email:account.email||null,coins:account.coins||0,diamonds:account.diamonds??starterDiamonds,gear:account.gear||[],rating:account.rating,ownsPack:account.ownsPack}
}
function saveAccount(key,account){
  const prior=profiles.get(key)
  const oldName=prior?.username?.toLowerCase()
  const newName=account.username.toLowerCase()
  if(oldName&&oldName!==newName)usernames.delete(oldName)
  profiles.set(key,account)
  usernames.set(newName,key)
  if(account.email)emails.set(account.email,key)
  try{persist()}catch(error){
    usernames.delete(newName)
    if(account.email&&account.email!==prior?.email)emails.delete(account.email)
    if(prior){
      profiles.set(key,prior)
      if(oldName)usernames.set(oldName,key)
    }else profiles.delete(key)
    throw error
  }
  return profileState(key)
}
function guestProfile(data){
  const known=existingKey(data.profile)||existingKey(data.device)
  if(known&&profiles.get(known).username)return profileState(known)
  const key=known||(legalKey(data.device)?data.device:id())
  if(!known&&profiles.size>=50000)throw new Error('Guest profile limit reached.')
  let username
  do{username='Racer '+randomBytes(3).toString('hex').toUpperCase()}
  while(usernames.has(username.toLowerCase()))
  return saveAccount(key,{rating:1000,skill:1000,coins:refillAmount,nextCoinsAt:Date.now()+refillPeriod,
    ownsPack:false,...profiles.get(key),username,credentials:null})
}
function checkName(username,key){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{2,19}$/.test(username))
    throw new Error('Use 3â€“20 letters, numbers, spaces, dashes, or underscores.')
  const name=username.toLowerCase()
  if(reservedNames.has(name)||(usernames.has(name)&&usernames.get(name)!==key))
    throw new Error('That player name is taken.')
}
async function accountAction(data,ip){
  const action=data.action
  if(action==='bootstrap')return guestProfile(data)
  const username=typeof data.username==='string'?data.username.trim().replace(/ +/g,' '):''
  const email=typeof data.email==='string'?data.email.trim().toLowerCase():''
  const password=typeof data.password==='string'?data.password:''
  if(!['guest','register','login','rename'].includes(action))throw new Error('Unknown account action.')
  const known=existingKey(data.profile)
  if(action==='rename'){
    const key=identity(data.profile)
    checkName(username,key)
    return saveAccount(key,{...profiles.get(key),username})
  }
  if(action!=='guest'){
    const now=Date.now()
    const attempts=loginLimits.get(ip)||{start:now,count:0}
    if(now-attempts.start>=60000){attempts.start=now;attempts.count=0}
    loginLimits.set(ip,attempts)
    if(++attempts.count>12)throw new Error('Too many account attempts. Try again in a minute.')
    if(password.length<8||password.length>128)throw new Error('Use a password with 8â€“128 characters.')
  }
  if(action==='login'){
    const identifier=(email||username).toLowerCase()
    const key=emails.get(identifier)||usernames.get(identifier)
    const credentials=profiles.get(key)?.credentials
    const result=await derive(password,credentials?.salt||'magnet-missing-account',64)
    if(!credentials||!timingSafeEqual(result,Buffer.from(credentials.hash,'hex')))
      throw new Error('Email, player name, or password is incorrect.')
    return profileState(key)
  }
  const current=known&&profiles.get(known)
  const keep=known&&!current.credentials&&(action==='register'||!current.username)?known:null
  const playerName=username||(keep?current.username:'')
  checkName(playerName,keep)
  if(action==='register'&&email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new Error('Enter a valid email address.')
  if(email&&emails.has(email))throw new Error('That email already has an account. Sign in instead.')
  const credentials=action==='register'?{salt:randomBytes(16).toString('hex')}:null
  if(credentials)credentials.hash=(await derive(password,credentials.salt,64)).toString('hex')
  const latest=keep&&profiles.get(keep)
  if(latest?.credentials)throw new Error('This player already has sign-in details.')
  if(email&&emails.has(email))throw new Error('That email already has an account. Sign in instead.')
  checkName(playerName,keep)
  if(!keep&&profiles.size>=50000)throw new Error('Guest profile limit reached.')
  return saveAccount(keep||id(),{rating:1000,skill:1000,coins:refillAmount,nextCoinsAt:Date.now()+refillPeriod,
    ownsPack:false,...latest,username:playerName,credentials,...(email?{email}:{})})
}
function redeem(data){
  const key=identity(data.profile)
  const account=profiles.get(key)
  if(data.gear==='exchange-coins'){
    const count=data.packs
    if(!Number.isInteger(count)||count<1||count>coinExchange.maxPacks)throw new Error('Invalid coin exchange.')
    const diamonds=account.diamonds??starterDiamonds
    const cost=count*coinExchange.diamonds
    if(diamonds<cost)throw new Error('You need more diamonds.')
    refreshCoins(account)
    return saveAccount(key,{...account,diamonds:diamonds-cost,coins:account.coins+count*coinExchange.coins})
  }
  const pack=diamondPacks.find(item=>item.id===data.gear)
  const item=catalog.find(item=>item.price&&!item.retired&&item.id===data.gear)
  if(!item&&!pack)throw new Error('Item unavailable.')
  if(item&&account.gear?.includes(item.id))return profileState(key)
  refreshCoins(account)
  const currency=item?.currency||'coins'
  const diamonds=account.diamonds??starterDiamonds
  const balance=currency==='coins'?account.coins:diamonds
  const price=(item||pack).price
  if(balance<price)throw new Error('You need more '+currency+'.')
  const updated={...account,diamonds,[currency]:balance-price}
  if(pack)updated.diamonds+=pack.amount
  if(item)updated.gear=[...(account.gear||[]),item.id]
  return saveAccount(key,updated)
}

function getInput(raw){
  if(!raw||typeof raw!=='object')return {dx:0,dy:0}
  const direction=value=>Number.isFinite(value)?clamp(value,-1,1):0
  const input={dx:direction(raw.dx),dy:direction(raw.dy)}
  if(Number.isFinite(raw.x)&&Number.isFinite(raw.y)){
    input.x=clamp(raw.x,0,360)
    input.y=clamp(raw.y,0,520)
  }
  if(Number.isSafeInteger(raw.shot?.id)&&raw.shot.id>0&&typeof raw.shot.push==='boolean')
    input.shot={id:raw.shot.id,push:raw.shot.push}
  return input
}
function difficultyForSkill(skill){
  return skill>=1160?'hard':skill>=1040?'normal':'easy'
}
function fallbackSkill(skill,won,margin){
  return clamp(Math.round(skill+(won?17:-17)+margin*3),650,1800)
}
function startMatch(players,field,kind,rival=null){
  const skill=rival?(profiles.get(players[0].profile).skill??profiles.get(players[0].profile).rating):1000
  const difficulty=difficultyForSkill(skill)
  const style=rival?{...rival,speed:rival.speed+clamp((skill-1000)*.13,-20,25)}:null
  const game=createGame({mode:rival?'bot':'online',field,difficulty,rival:style})
  const names=players.map(player=>profiles.get(player.profile).username)
  if(rival)names.push(rival.displayName)
  const match={id:id(),players,field,kind,names,skill,game,results:null,created:Date.now()}
  registerMatch(match)
}
function registerMatch(match){
  matches.set(match.id,match)
  for(const [seat,player] of match.players.entries()){
    if(!player)continue
    player.match=match
    const {range,push,pull}=shipMagnet(player.look.ship)
    match.game.craft[seat].magnet={range,push,pull}
    player.seat=seat
    player.input=getInput(null)
    player.rematch=false
    queued.delete(player.token)
    warQueue.delete(player.token)
  }
}
function playerSkill(player){
  const account=profiles.get(player.profile)
  return account.skill??account.rating
}
function warBot(skill){
  const style=botRivals[randomInt(botRivals.length)]
  return {difficulty:difficultyForSkill(skill),speed:style.speed,offset:style.offset}
}
function freeBotName(names){
  let index=randomInt(opponentNames.length)
  while(names.includes(opponentNames[index]))index=(index+1)%opponentNames.length
  return opponentNames[index]
}
function startWarMatch(group){
  const players=Array(warTeamSize*2).fill(null)
  const counts=[0,0], totals=[0,0]
  for(const player of group.slice().sort((a,b)=>playerSkill(b)-playerSkill(a))){
    const team=counts[0]===counts[1]?(totals[0]<=totals[1]?0:1):counts[0]<counts[1]?0:1
    players[team*warTeamSize+warLineup[counts[team]++]]=player
    totals[team]+=playerSkill(player)
  }
  const skill=Math.round(group.reduce((sum,player)=>sum+playerSkill(player),0)/group.length)
  const names=players.map(player=>player?profiles.get(player.profile).username:null)
  const bots=players.map((player,seat)=>{
    if(player)return null
    names[seat]=freeBotName(names)
    return warBot(skill)
  })
  const field=[3,4][randomInt(2)]
  const game=createGame({mode:'warzone',field,bots})
  registerMatch({id:id(),players,field,kind:'warzone',names,skill,game,results:null,created:Date.now()})
}
function finish(match,winner,reason){
  if(match.results)return
  match.game.winner=winner
  match.game.phase='over'
  match.end=Date.now()
  match.results=match.players.map(()=>({reason,delta:0}))
  for(const [seat,player] of match.players.entries()){
    if(!player)continue
    const account=profiles.get(player.profile)
    refreshCoins(account)
    const coins=teamOf(match.game,seat)===winner?stake:-stake
    account.coins+=coins
    Object.assign(match.results[seat],{coins,balance:account.coins})
    if(match.kind==='warzone'&&reason==='completed'){
      const team=teamOf(match.game,seat)
      account.skill=fallbackSkill(playerSkill(player),team===winner,match.game.score[team]-match.game.score[1-team])
    }
  }
  dirty=true
  if(reason==='completed'&&match.kind==='fallback'){
    const account=profiles.get(match.players[0].profile)
    const margin=match.game.score[0]-match.game.score[1]
    account.skill=fallbackSkill(match.skill,winner===0,margin)
    dirty=true
  }
  if(match.kind!=='ranked'||(reason==='forfeit'&&match.game.elapsed<1))return
  const a=profiles.get(match.players[winner].profile), b=profiles.get(match.players[1-winner].profile)
  const change=Math.round(28/(1+10**((a.rating-b.rating)/400)))
  a.rating+=change
  b.rating-=change
  a.skill=clamp((a.skill??a.rating-change)+change,650,1800)
  b.skill=clamp((b.skill??b.rating+change)-change,650,1800)
  match.results[winner].delta=change
  match.results[1-winner].delta=-change
  dirty=true
}
function scrub(player){
  if(identities.get(player.profile)===player)identities.delete(player.profile)
  if(player.code&&inviteRooms.get(player.code)===player)inviteRooms.delete(player.code)
  queued.delete(player.token)
  warQueue.delete(player.token)
  sessions.delete(player.token)
}
function remove(player){
  const match=player.match
  if(match&&!match.results){
    if(match.kind==='warzone'){
      const account=profiles.get(player.profile)
      refreshCoins(account)
      account.coins-=stake
      dirty=true
      const seat=player.seat
      match.players[seat]=null
      match.names[seat]=freeBotName(match.names)
      delete match.game.craft[seat].magnet
      match.game.bots[seat]=warBot(match.skill)
      match.game.botThink[seat]=0
      if(!match.players.some(Boolean))matches.delete(match.id)
    }else finish(match,1-player.seat,'forfeit')
  }
  scrub(player)
}
function playerLook(profile,look){
  const account=profiles.get(profile)
  return {
    ship:ownedStyle('ship',look?.ship,account.gear,account.ownsPack),
    goal:ownedStyle('effect',look?.goal,account.gear,account.ownsPack)
  }
}
function makeSession(profile,look){
  if(!canEnter(profile))throw new Error('You need 30 Arena Coins. Try free practice while your coins refill.')
  if(identities.has(profile))throw new Error('This profile is already in an online session. Use a private window for a second player.')
  if(sessions.size>=500)throw new Error('All online slots are occupied.')
  const player={token:id(),profile,seen:Date.now(),input:getInput(null),look:playerLook(profile,look)}
  sessions.set(player.token,player)
  identities.set(profile,player)
  return player
}
function findPairs(now){
  for(const [token,player] of queued){
    if(!queued.has(token))continue
    const self=profiles.get(player.profile).rating
    const window=100+Math.floor((now-player.queuedAt)/1250)*35
    let rival=null, best=Infinity
    for(const candidate of queued.values()){
      if(candidate===player)continue
      const gap=Math.abs(self-profiles.get(candidate.profile).rating)
      if(gap>window||gap>100+Math.floor((now-candidate.queuedAt)/1250)*35||gap>=best)continue
      rival=candidate;best=gap
    }
    if(rival)startMatch(randomInt(2)?[player,rival]:[rival,player],[3,4][randomInt(2)],'ranked')
  }
  for(const player of queued.values()){
    if(now-player.queuedAt<botWaitMs)continue
    const roster=botRivals.filter(bot=>bot.name!==player.lastBot)
    const rival=roster[randomInt(roster.length)]
    player.lastBot=rival.name
    const recent=profiles.get(player.profile).lastOpponent
    const index=randomInt(opponentNames.length)
    const displayName=opponentNames[index]===recent?opponentNames[(index+1)%opponentNames.length]:opponentNames[index]
    profiles.get(player.profile).lastOpponent=displayName
    dirty=true
    startMatch([player],randomInt(fields.length),'fallback',{...rival,displayName})
  }
}
function findWarMatches(now){
  const maximum=warTeamSize*2
  for(const [token,anchor] of warQueue){
    if(!warQueue.has(token))continue
    const skill=playerSkill(anchor)
    const radius=player=>100+Math.floor((now-player.queuedAt)/1250)*35
    const compatible=[...warQueue.values()].filter(player=>{
      const difference=Math.abs(playerSkill(player)-skill)
      return difference<=Math.min(radius(anchor),radius(player))
    })
    compatible.sort((a,b)=>Math.abs(playerSkill(a)-skill)-Math.abs(playerSkill(b)-skill)||a.queuedAt-b.queuedAt)
    if(compatible.length<maximum&&now-anchor.queuedAt<warWaitMs)continue
    const group=[anchor,...compatible.filter(player=>player!==anchor)].slice(0,maximum)
    startWarMatch(group)
  }
}
function tick(){
  const now=Date.now()
  let steps=Math.floor((now-lastTick)/(stepSeconds*1000))
  if(!steps)return
  lastTick=steps>6?now:lastTick+steps*stepSeconds*1000
  steps=Math.min(6,steps)
  for(const match of matches.values()){
    if(match.results)continue
    const inputs=match.players.map(player=>player?.input)
    for(let index=0;index<steps;index++)step(match.game,inputs)
    if(match.game.phase==='over')finish(match,match.game.winner,'completed')
  }
  if(now-lastMaintenance<500)return
  lastMaintenance=now
  for(const player of sessions.values())if(now-player.seen>expiration)remove(player)
  for(const [key,match] of matches){
    if(match.end&&now-match.end>300000){
      for(const player of match.players)if(player?.match===match)scrub(player)
      matches.delete(key)
    }
  }
  for(const [ip,value] of addressLimits)if(now-value.start>5000)addressLimits.delete(ip)
  for(const [ip,value] of loginLimits)if(now-value.start>60000)loginLimits.delete(ip)
  findPairs(now)
  findWarMatches(now)
  if(dirty){try{persist()}catch(error){console.error('Could not save profiles:',error.message)}}
}
setInterval(tick,12).unref()

function roomAction(data){
  if(['host','join','rank','warzone'].includes(data.action)){
    if(data.action==='join'){
      const owner=inviteRooms.get(data.code)
      if(!owner||owner.match)throw new Error('Room unavailable. Ask your friend for a new code.')
      const profile=identity(data.profile)
      const player=makeSession(profile,data.look)
      startMatch([owner,player],owner.field,'private')
      return {profile,token:player.token,code:data.code}
    }
    const profile=identity(data.profile)
    const player=makeSession(profile,data.look)
    if(data.action==='rank'||data.action==='warzone'){
      player.queuedAt=Date.now()
      const queue=data.action==='warzone'?warQueue:queued
      queue.set(player.token,player)
      return {profile,token:player.token}
    }
    player.field=Number.isInteger(data.field)&&fields[data.field]?data.field:0
    do{player.code=randomBytes(3).toString('hex').toUpperCase()}while(inviteRooms.has(player.code))
    inviteRooms.set(player.code,player)
    return {profile,token:player.token,code:player.code}
  }
  const player=sessions.get(data.token)
  if(!player)throw new Error('Session ended.')
  if(data.action==='leave'){remove(player);return {}}
  if(data.action!=='sync')throw new Error('Unknown room action.')
  player.seen=Date.now()
  player.input=getInput(data.input)
  const match=player.match
  if(!match)return {queued:queued.has(player.token)||warQueue.has(player.token)}
  let notice
  if(data.rematch&&match.results&&!canEnter(player.profile)){
    notice='You need 30 Arena Coins. Try free practice while your coins refill.'
  }else if(data.rematch&&match.results){
    if(data.look)player.look=playerLook(player.profile,data.look)
    if(['ranked','fallback','warzone'].includes(match.kind)){
      player.match=null
      player.queuedAt=Date.now()
      const queue=match.kind==='warzone'?warQueue:queued
      queue.set(player.token,player)
      return {queued:true}
    }
    player.rematch=true
    const rival=match.players[1-player.seat]
    if(identities.get(rival.profile)!==rival)throw new Error('Your friend has left the room.')
    if(rival.rematch&&!canEnter(rival.profile)){
      rival.rematch=false
      notice='Your friend needs 30 Arena Coins to rematch.'
    }else if(rival.rematch){
      matches.delete(match.id)
      startMatch([rival,player],match.field,'private')
      player.rematch=false
    }
  }
  const current=player.match
  const {field,phase,score,clock,winner,extra,craft,puck,trail,effects,event}=current.game
  return {game:{mode:current.kind==='warzone'?'warzone':'online',field,phase,score,clock,winner,extra,craft,puck,trail,effects,event},
    notice,names:current.names,looks:current.players.map(participant=>participant?.look),seat:player.seat,matchId:current.id,result:current.results?.[player.seat]}
}
function send(res,status,body){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(body))
}
async function bodyOf(req){
  const chunks=[]
  let size=0
  for await(const chunk of req){
    size+=chunk.length
    if(size>64000)throw new Error('Request is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function grant(key){
  const account=profiles.get(key)
  if(!account)return false
  if(account.ownsPack)return true
  account.ownsPack=true
  try{persist()}catch(error){account.ownsPack=false;throw error}
  return true
}
async function serve(req,res){
  const route=new URL(req.url,'http://localhost').pathname
  if(req.method==='GET'&&route==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}).end(page)
    return
  }
  if(req.method==='GET'&&(route==='/ship-art.webp'||route==='/effect-art.webp')){
    res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-cache'}).end(route==='/ship-art.webp'?shipArt:effectArt)
    return
  }
  if(req.method==='GET'&&route==='/health'){send(res,200,{ok:true,build:'animated-effect-shop',stream:streamAvailable});return}
  if(req.method!=='POST'||!['/room','/profile','/account','/redeem','/stripe/webhook'].includes(route)){send(res,404,{error:'Not found.'});return}
  const ip=req.socket.remoteAddress
  const now=Date.now()
  const count=addressLimits.get(ip)||{start:now,count:0}
  if(now-count.start>1000){count.start=now;count.count=0}
  addressLimits.set(ip,count)
  if(++count.count>190){send(res,429,{error:'Too many requests.'});return}
  try{
    const raw=await bodyOf(req)
    if(route==='/stripe/webhook'){
      await handleWebhook(raw,req.headers['stripe-signature'],grant)
      send(res,200,{received:true})
      return
    }
    const data=JSON.parse(raw)
    if(!data||typeof data!=='object')throw new Error('Invalid request.')
    if(route==='/room'){send(res,200,roomAction(data));return}
    if(route==='/profile'){
      const key=existingKey(data.profile)
      send(res,200,key?profileState(key):{profile:null,username:null})
      return
    }
    if(route==='/redeem'){send(res,200,redeem(data));return}
    if(route==='/account'){send(res,200,await accountAction(data,ip));return}

  }catch(error){send(res,error.statusCode||400,{error:error.message||'Request failed.'})}
}
const port=Number(process.env.PORT||8792)
if(require.main===module){
  const server=http.createServer(serve)
  streamAvailable=attachMatchSockets(server,roomAction,sessions)
  server.on('error',error=>{
    console.error(error.code==='EADDRINUSE'?'Port '+port+' is already in use. Try Play.cmd with a different port.':error.message)
    process.exitCode=1
  })
  server.listen(port,process.env.HOST||'0.0.0.0',()=>{
    const url='http://localhost:'+server.address().port+'/'
    console.log('Magnet Mayhem is running at '+url)
    console.log('Leave this window open while you play.')
    if(process.platform==='win32'&&process.env.MAGNET_OPEN_BROWSER==='1'){
      const {spawn}=require('node:child_process')
      const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true})
      opener.on('error',()=>console.log('Open '+url+' in your browser.'))
      opener.unref()
    }
  })
}
module.exports={serve,difficultyForSkill,fallbackSkill}


