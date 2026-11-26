'use strict'
const http=require('node:http')
const fs=require('node:fs')
const path=require('node:path')
const {randomBytes,randomInt,scrypt,timingSafeEqual,createHash}=require('node:crypto')
const {promisify}=require('node:util')
const derive=promisify(scrypt)
const opponentNames=require('./opponent-names.cjs')
const starterDiamonds=25
const winReward=30
const refillAmount=100
const refillPeriod=60*60*1000
const reservedNames=new Set(opponentNames.map(name=>name.toLowerCase()))
const {fields,botRivals,attackTactics,createGame,warTeamSize,teamOf,step,stepSeconds,clamp,catalog,diamondPacks,coinExchange,ownedStyle,botLoadout,equipMagnet}=require('./engine.cjs')
const {handleWebhook}=require('./payment.cjs')
const {attachMatchSockets}=require('./match-socket.cjs')
let streamAvailable=false

const page=fs.readFileSync(path.join(__dirname,'index.html'))
const shipArt=fs.readFileSync(path.join(__dirname,'ship-art.webp'))
const effectArt=fs.readFileSync(path.join(__dirname,'effect-art.webp'))
const dataPath=process.env.MAGNET_DATA_FILE||path.join(__dirname,'profiles.json')
const profiles=new Map()
const learningKey='_botLearningV1'
let learning={}
const rankedMagnet={range:48,push:465,pull:210}
const durableProfiles=process.env.MAGNET_DURABLE_PROFILES==='1'
const profileRevisionKey='_profileRevisionsV1'
const profileRevisions=new Map()
const storedProfiles=new Map()
const profileWrites=new Map()
const deletingProfiles=new Set()
let profileFlush=null,profileStatus=durableProfiles?'connecting':'local'
const pendingLearningKey='_botLearningPendingV1'
const learningUrl=process.env.MAGNET_LEARNING_URL
const learningToken=process.env.MAGNET_LEARNING_TOKEN
let pendingLearning=[], learningSync=false, nextLearningSync=0, learningStatus=learningUrl&&learningToken?'connecting':'local'
try{
  const saved=JSON.parse(fs.readFileSync(dataPath,'utf8'))
  learning=saved[learningKey]||{}
  pendingLearning=saved[pendingLearningKey]||[]
  for(const [key,value] of Object.entries(saved)){
    if(!/^[a-f0-9]{48}$/.test(key))continue
    profiles.set(key,value)
    const revision=saved[profileRevisionKey]?.[key]
    if(Number.isSafeInteger(revision))profileRevisions.set(key,revision)
  }
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
  if(durableProfiles)for(const [id,account] of profiles){
    const profile=JSON.stringify(account)
    if((profileWrites.get(id)?.profile??storedProfiles.get(id))===profile)continue
    const revision=Math.max(Date.now()*1024,(profileRevisions.get(id)||0)+1)
    profileRevisions.set(id,revision)
    profileWrites.set(id,{id,revision,profile})
  }
  const scratch=dataPath+'.tmp'
  fs.writeFileSync(scratch,JSON.stringify({...Object.fromEntries(profiles),[learningKey]:learning,[pendingLearningKey]:pendingLearning,[profileRevisionKey]:Object.fromEntries(profileRevisions)}))
  fs.renameSync(scratch,dataPath)
  dirty=false
  if(durableProfiles)void flushProfiles()
}
async function profileRequest(method,cursor='',rows){
  const endpoint=new URL('/profiles',learningUrl)
  if(cursor)endpoint.searchParams.set('after',cursor)
  const response=await fetch(endpoint,{method,headers:{Authorization:'Bearer '+learningToken,
    'Content-Type':'application/json'},body:rows&&JSON.stringify(rows),signal:AbortSignal.timeout(5500)})
  if(!response.ok)throw new Error('Player storage returned '+response.status)
  return method==='GET'?response.json():null
}
async function restoreProfiles(){
  if(!durableProfiles)return
  if(!learningUrl||!learningToken)throw new Error('Player storage credentials are missing')
  const remote=[]
  let cursor=''
  while(true){
    const rows=await profileRequest('GET',cursor)
    if(!Array.isArray(rows))throw new Error('Invalid player storage response')
    remote.push(...rows)
    if(rows.length<100)break
    cursor=rows.at(-1).id
  }
  for(const {id,revision,profile} of remote){
    storedProfiles.set(id,profile)
    if(revision<(profileRevisions.get(id)||0))continue
    const restored=JSON.parse(profile)
    if(restored===null)profiles.delete(id)
    else profiles.set(id,restored)
    profileRevisions.set(id,revision)
  }
  usernames.clear()
  emails.clear()
  for(const [id,account] of profiles){
    if(account.username)usernames.set(account.username.toLowerCase(),id)
    if(account.email)emails.set(account.email,id)
  }
  profileStatus='durable'
  persist()
  if(!await flushProfiles())throw new Error('Player storage could not migrate local accounts')
  console.log('Player storage connected. Restored '+remote.length+' accounts.')
}
function flushProfiles(){
  if(!durableProfiles)return Promise.resolve(true)
  if(profileFlush)return profileFlush
  if(!profileWrites.size)return Promise.resolve(true)
  profileFlush=(async()=>{
    try{
      while(profileWrites.size){
        const rows=[...profileWrites.values()].slice(0,25)
        await profileRequest('POST','',rows)
        for(const row of rows){
          storedProfiles.set(row.id,row.profile)
          if(profileWrites.get(row.id)===row)profileWrites.delete(row.id)
        }
      }
      profileStatus='durable'
      return true
    }catch(error){
      profileStatus='retrying'
      console.error('Player storage sync:',error.message)
      return false
    }finally{profileFlush=null}
  })()
  return profileFlush
}
function existingKey(value){
  return legalKey(value)&&profiles.has(value)?value:null
}
function identity(value){
  const key=existingKey(value)
  if(key&&deletingProfiles.has(key))throw new Error('Account deletion is in progress.')
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
function profileState(key){
  const account=profiles.get(key)
  refreshCoins(account)
  return {refillIn:Math.max(0,account.nextCoinsAt-Date.now()),profile:key,username:account.username||null,guest:!account.credentials,email:account.email||null,coins:account.coins||0,blockedCount:account.blockedPlayers?.length||0,diamonds:account.diamonds??starterDiamonds,gear:account.gear||[],rating:account.rating,ownsPack:account.ownsPack}
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
  if(known&&deletingProfiles.has(known))throw new Error('Account deletion is in progress.')
  if(known&&profiles.get(known).username)return profileState(known)
  const key=known||(legalKey(data.device)&&!profileRevisions.has(data.device)?data.device:id())
  if(!known&&profiles.size>=50000)throw new Error('Guest profile limit reached.')
  let username
  do{username='Racer '+randomBytes(3).toString('hex').toUpperCase()}
  while(usernames.has(username.toLowerCase()))
  return saveAccount(key,{rating:1000,skill:1000,coins:refillAmount,nextCoinsAt:Date.now()+refillPeriod,
    ownsPack:false,...profiles.get(key),username,credentials:null})
}
let moderatedNames=new Set()
let moderationRefresh=0
async function refreshModeration(){
  if(!durableProfiles||Date.now()<moderationRefresh)return
  moderationRefresh=Date.now()+60000
  try{
    const response=await fetch(new URL('/moderation',learningUrl),{headers:{Authorization:'Bearer '+learningToken},signal:AbortSignal.timeout(4500)})
    if(!response.ok)throw new Error('Moderation store returned '+response.status)
    moderatedNames=new Set(await response.json())
  }catch(error){console.error('Name moderation:',error.message)}
}
function nameBlocked(name){
  const normalized=name.toLowerCase().replace(/[^a-z0-9]/g,'')
  return moderatedNames.has(normalized)
}
function checkName(username,key){
  if(nameBlocked(username))throw new Error('Choose a different player name.')
  if(!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{2,19}$/.test(username))
    throw new Error('Use 3–20 letters, numbers, spaces, dashes, or underscores.')
  const name=username.toLowerCase()
  if(reservedNames.has(name)||(usernames.has(name)&&usernames.get(name)!==key))
    throw new Error('That player name is taken.')
}
async function deleteAccount(data){
  const key=identity(data.profile)
  const account=profiles.get(key)
  if(account.credentials){
    const password=typeof data.password==='string'?data.password:''
    if(password.length<8||password.length>128)throw new Error('Enter your password to delete this account.')
    const derived=await derive(password,account.credentials.salt,64)
    if(!timingSafeEqual(derived,Buffer.from(account.credentials.hash,'hex')))throw new Error('Password is incorrect.')
    if(profiles.get(key)!==account)throw new Error('Your account changed. Try again.')
  }
  if(identities.has(key))throw new Error('Return home before deleting your account.')
  if(deletingProfiles.has(key))throw new Error('Account deletion is in progress.')
  deletingProfiles.add(key)
  try{
    if(durableProfiles&&!await flushProfiles())throw new Error('Account storage is unavailable. Try again shortly.')
    const revision=Math.max(Date.now()*1024,(profileRevisions.get(key)||0)+1)
    if(durableProfiles){
      await profileRequest('POST','',[{id:key,revision,profile:'null'}])
      storedProfiles.set(key,'null')
    }
    profileRevisions.set(key,revision)
    profiles.delete(key)
    usernames.delete(account.username.toLowerCase())
    if(account.email)emails.delete(account.email)
    persist()
    return {deleted:true}
  }finally{deletingProfiles.delete(key)}
}
function blockKey(profile){
  return createHash('sha256').update(profile).digest('hex')
}
function mayMatch(a,b){
  return !profiles.get(a)?.blockedPlayers?.includes(blockKey(b))&&
    !profiles.get(b)?.blockedPlayers?.includes(blockKey(a))
}
function blockPlayer(data){
  const player=sessions.get(data.token)
  const target=Number.isInteger(data.seat)?player?.match?.players[data.seat]:null
  if(!target||target===player)throw new Error('Choose another player in your match.')
  const key=identity(player.profile)
  const account=profiles.get(key)
  const blockedPlayers=account.blockedPlayers||[]
  const hash=blockKey(target.profile)
  if(blockedPlayers.includes(hash))return {blocked:true}
  if(blockedPlayers.length>=50)throw new Error('Your block list is full. Clear it from Account.')
  saveAccount(key,{...account,blockedPlayers:[...blockedPlayers,hash]})
  return {blocked:true}
}
async function reportName(data){
  const player=sessions.get(data.token)
  const match=player?.match
  const seat=data.seat
  if(!match||!Number.isInteger(seat)||seat===player.seat||!match.players[seat])
    throw new Error('Choose a player from your current match.')
  if(player.reportedMatch===match.id)throw new Error('You already reported a name in this match.')
  const report={id:id(),name:match.names[seat],created:Date.now()}
  player.reportedMatch=match.id
  try{
    if(durableProfiles){
      const response=await fetch(new URL('/reports',learningUrl),{method:'POST',
        headers:{Authorization:'Bearer '+learningToken,'Content-Type':'application/json'},
        body:JSON.stringify(report),signal:AbortSignal.timeout(4500)})
      if(!response.ok)throw new Error('Could not submit the report. Try again.')
    }else fs.appendFileSync(dataPath+'.reports',JSON.stringify(report)+'\n')
  }catch(error){player.reportedMatch=null;throw error}
  return {reported:true}
}
const supportAttempts=new Map()
async function submitSupport(data,ip){
  const now=Date.now()
  if(now-(supportAttempts.get(ip)||0)<30000)throw new Error('Please wait before sending another request.')
  const email=typeof data.email==='string'?data.email.trim():''
  const message=typeof data.message==='string'?data.message.trim():''
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||message.length<10||message.length>1500)
    throw new Error('Enter a valid email and a message of 10 to 1,500 characters.')
  supportAttempts.set(ip,now)
  const ticket={id:id(),email,message,created:now}
  if(durableProfiles){
    const response=await fetch(new URL('/support',learningUrl),{method:'POST',
      headers:{Authorization:'Bearer '+learningToken,'Content-Type':'application/json'},
      body:JSON.stringify(ticket),signal:AbortSignal.timeout(4500)})
    if(!response.ok)throw new Error('Support is temporarily unavailable.')
  }else fs.appendFileSync(dataPath+'.support',JSON.stringify(ticket)+'\n')
  return {reference:ticket.id}
}
function allowAccountAttempt(ip){
  const now=Date.now()
  const attempts=loginLimits.get(ip)||{start:now,count:0}
  if(now-attempts.start>=60000){attempts.start=now;attempts.count=0}
  loginLimits.set(ip,attempts)
  return ++attempts.count<=12
}
async function accountAction(data,ip){
  const action=data.action
  if(action==='clear-blocks'){
    const key=identity(data.profile)
    return saveAccount(key,{...profiles.get(key),blockedPlayers:[]})
  }
  if(action==='delete'){
    if(!allowAccountAttempt(ip))throw new Error('Too many account attempts. Try again in a minute.')
    return deleteAccount(data)
  }
  if(action==='bootstrap'){
    if(!existingKey(data.profile)&&!existingKey(data.device)&&data.ageConfirmed!==true)
      return {ageRequired:true}
    return guestProfile(data)
  }
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
    if(!allowAccountAttempt(ip))throw new Error('Too many account attempts. Try again in a minute.')
    if(password.length<8||password.length>128)throw new Error('Use a password with 8–128 characters.')
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
  if(!known&&data.ageConfirmed!==true)throw new Error('Confirm that you are 13 or older to create a profile.')
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
  if(keep&&(!latest||deletingProfiles.has(keep)))throw new Error('Your profile is unavailable.')
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
const botTiers=[850,950,1050,1150,1250,1400,1550,1700,1850]
function botTarget(skill){
  return botTiers.reduce((best,rating)=>Math.abs(rating-skill-20)<Math.abs(best-skill-20)?rating:best)
}
function tacticFor(tier,field){
  const records=learning[tier]?.[field]||{}
  const total=Object.values(records).reduce((sum,record)=>sum+record.games,0)
  const score=tactic=>{
    const record=records[tactic.id]
    if(!record)return 2
    return record.reward/record.games+.4*Math.sqrt(Math.log(total+1)/record.games)
  }
  return attackTactics.reduce((best,tactic)=>score(tactic)>score(best)?tactic:best)
}
function addTacticResult({tier,field,tactic,reward}){
  const records=(learning[tier]??={})[field]??={}
  const record=records[tactic]??={games:0,reward:0}
  if(record.games>=80){
    record.games*=.95
    record.reward*=.95
  }
  record.games++
  record.reward+=reward
}
async function requestLearning(method,rows){
  const response=await fetch(learningUrl,{method,headers:{Authorization:'Bearer '+learningToken,
    'Content-Type':'application/json'},body:rows&&JSON.stringify(rows),signal:AbortSignal.timeout(4500)})
  if(!response.ok)throw new Error('Learning store returned '+response.status)
  return method==='GET'?response.json():null
}
async function syncLearning(now=Date.now()){
  if(!learningUrl||!learningToken||learningSync||now<nextLearningSync)return
  if(learningStatus==='durable'&&!pendingLearning.length)return
  learningSync=true
  let acknowledged=0, restored=null
  try{
    while(acknowledged<pendingLearning.length){
      const batch=pendingLearning.slice(acknowledged,acknowledged+50)
      await requestLearning('POST',batch)
      acknowledged+=batch.length
    }
    if(learningStatus!=='durable')restored=await requestLearning('GET')
    if(restored){
      learning={}
      for(const row of restored){
        const fields=learning[row.tier]??={}
        const records=fields[row.field]??={}
        records[row.tactic]={games:row.games,reward:row.reward}
      }
      for(const row of pendingLearning.slice(acknowledged))addTacticResult(row)
    }
    learningStatus='durable'
  }catch(error){
    learningStatus='retrying'
    nextLearningSync=now+15000
    console.error('Bot learning sync:',error.message)
  }finally{
    if(acknowledged)pendingLearning.splice(0,acknowledged)
    if(acknowledged||restored)dirty=true
    learningSync=false
  }
}
function learnTactic(match,winner){
  const shots=match.game.botShots
  const reward=clamp((winner===1?.50:0)+.30*(match.game.score[1]/3)+.20*(shots.count?shots.forward/shots.count:0)-.20*shots.ownGoals,0,1)
  const row={id:match.id,tier:match.botRating,field:match.field,tactic:match.game.rival.tactic.id,reward}
  addTacticResult(row)
  if(learningUrl&&learningToken)pendingLearning.push(row)
}
function ratingChange(rating,other,won,games,normalK=24){
  const expected=1/(1+10**((other-rating)/400))
  return Math.round((games<8?normalK*1.8:normalK)*(Number(won)-expected))
}
function startMatch(players,field,kind,rival=null){
  const skill=rival?playerSkill(players[0],'bot'):1000
  const botRating=rival?botTarget(skill):null
  const difficulty=difficultyForSkill(botRating??skill)
  const style=rival?{...rival,tactic:tacticFor(botRating,field),look:randomBotLook(players.map(player=>player.look)),speed:rival.speed+clamp((botRating-1050)*.065,-16,55)}:null
  const game=createGame({mode:rival?'bot':'online',field,difficulty,rival:style})
  const names=players.map(player=>profiles.get(player.profile).username)
  if(rival)names.push(rival.displayName)
  const match={id:id(),players,field,kind,names,skill,botRating,game,results:null,created:Date.now()}
  registerMatch(match)
}
function registerMatch(match){
  matches.set(match.id,match)
  match.game.fairMagnets=['ranked','fallback','warzone'].includes(match.kind)
  if(match.game.fairMagnets)for(const ship of match.game.craft)ship.magnet={...rankedMagnet}
  for(const [seat,player] of match.players.entries()){
    if(!player)continue
    player.match=match
    if(!match.game.fairMagnets)equipMagnet(match.game.craft[seat],player.look.ship)
    player.seat=seat
    player.input=getInput(null)
    player.rematch=false
    queued.delete(player.token)
    warQueue.delete(player.token)
  }
}
function playerSkill(player,mode='war'){
  const account=profiles.get(player.profile)
  return (mode==='bot'?account.botRating:account.warRating)??account.rating??1000
}
function randomBotLook(used){return botLoadout(used,()=>randomInt(2**24)/2**24)}
function warBot(skill,used,field){
  const style=botRivals[randomInt(botRivals.length)]
  const rating=botTarget(skill)
  return {difficulty:difficultyForSkill(rating),speed:style.speed+clamp((rating-1050)*.065,-16,55),offset:style.offset,tactic:tacticFor(rating,field),look:randomBotLook(used)}
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
  const used=group.map(player=>player.look)
  const field=[3,4][randomInt(2)]
  const bots=players.map((player,seat)=>{
    if(player)return null
    names[seat]=freeBotName(names)
    const bot=warBot(skill,used,field)
    used.push(bot.look)
    return bot
  })
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
    const coins=reason==='completed'&&teamOf(match.game,seat)===winner?winReward:0
    account.coins+=coins
    Object.assign(match.results[seat],{coins,balance:account.coins})
  }
  dirty=true
  if(reason==='completed'&&match.kind==='fallback'){
    const account=profiles.get(match.players[0].profile)
    const games=account.botGames??0
    account.botRating=clamp(match.skill+ratingChange(match.skill,match.botRating,winner===0,games),650,1950)
    account.botGames=games+1
    learnTactic(match,winner)
  }
  if(reason==='completed'&&match.kind==='warzone'){
    const groups=[[],[]]
    for(const [seat,player] of match.players.entries())if(player)groups[teamOf(match.game,seat)].push(player)
    if(groups.every(group=>group.length)){
      const averages=groups.map(group=>group.reduce((sum,player)=>sum+playerSkill(player),0)/group.length)
      for(const [team,group] of groups.entries())for(const player of group){
        const account=profiles.get(player.profile)
        const games=account.warGames??0
        account.warRating=clamp(playerSkill(player)+ratingChange(averages[team],averages[1-team],team===winner,games,15),650,1950)
        account.warGames=games+1
      }
    }
  }
  if(match.kind!=='ranked'||reason!=='completed')return
  const a=profiles.get(match.players[winner].profile), b=profiles.get(match.players[1-winner].profile)
  const change=ratingChange(a.rating,b.rating,true,Math.min(a.rankedGames??0,b.rankedGames??0))
  a.rating+=change
  b.rating-=change
  a.rankedGames=(a.rankedGames??0)+1
  b.rankedGames=(b.rankedGames??0)+1
  match.results[winner].delta=change
  match.results[1-winner].delta=-change
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
      const seat=player.seat
      match.players[seat]=null
      match.names[seat]=freeBotName(match.names)
      const bot=warBot(match.skill,[...match.players.map(participant=>participant?.look),...match.game.bots.map(config=>config?.look)],match.field)
      match.game.bots[seat]=bot
      if(!match.game.fairMagnets)equipMagnet(match.game.craft[seat],bot.look.ship)
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
    goal:ownedStyle('effect',look?.goal,account.gear,account.ownsPack),
    trail:ownedStyle('trail',look?.trail,account.gear)
  }
}
function makeSession(profile,look){
  if(nameBlocked(profiles.get(profile).username))throw new Error('Update your player name in Account before playing online.')
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
    const window=70+Math.floor((now-player.queuedAt)/1000)*35
    let rival=null, best=Infinity
    for(const candidate of queued.values()){
      if(candidate===player||!mayMatch(player.profile,candidate.profile))continue
      const gap=Math.abs(self-profiles.get(candidate.profile).rating)
      if(gap>window||gap>70+Math.floor((now-candidate.queuedAt)/1000)*35||gap>=best)continue
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
    const group=[anchor]
    for(const candidate of compatible){
      if(group.length>=maximum)break
      if(candidate!==anchor&&group.every(player=>mayMatch(player.profile,candidate.profile)))group.push(candidate)
    }
    if(group.length<maximum&&now-anchor.queuedAt<warWaitMs)continue
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
  for(const [ip,time] of supportAttempts)if(now-time>30000)supportAttempts.delete(ip)
  for(const [ip,value] of loginLimits)if(now-value.start>60000)loginLimits.delete(ip)
  findPairs(now)
  findWarMatches(now)
  void syncLearning(now)
  void refreshModeration()
  if(profileWrites.size)void flushProfiles()
  if(dirty){try{persist()}catch(error){console.error('Could not save profiles:',error.message)}}
}
setInterval(tick,12).unref()

function roomAction(data){
  if(['host','join','rank','warzone'].includes(data.action)){
    if(data.action==='join'){
      const owner=inviteRooms.get(data.code)
      if(!owner||owner.match)throw new Error('Room unavailable. Ask your friend for a new code.')
      const profile=identity(data.profile)
      if(!mayMatch(owner.profile,profile))throw new Error('This room is unavailable.')
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
  if(data.rematch&&match.results){
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
    if(rival.rematch&&!mayMatch(player.profile,rival.profile))throw new Error('A rematch is unavailable.')
    if(rival.rematch){
      matches.delete(match.id)
      startMatch([rival,player],match.field,'private')
      player.rematch=false
    }
  }
  const current=player.match
  const {field,phase,score,clock,winner,extra,craft,puck,trail,effects,event,hit}=current.game
  return {game:{mode:current.kind==='warzone'?'warzone':'online',field,phase,score,clock,winner,extra,craft,puck,trail,effects,event,hit},
    notice,names:current.names,bots:craft.map((_,seat)=>!current.players[seat]),looks:craft.map((_,seat)=>current.players[seat]?.look||current.game.bots?.[seat]?.look||(seat===1?current.game.rival?.look:undefined)),seat:player.seat,matchId:current.id,result:current.results?.[player.seat]}
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
  if(req.method==='GET'&&(['/','/account-deletion','/privacy','/terms','/support'].includes(route))){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}).end(page)
    return
  }
  if(req.method==='GET'&&(route==='/ship-art.webp'||route==='/effect-art.webp')){
    res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-cache'}).end(route==='/ship-art.webp'?shipArt:effectArt)
    return
  }
  if(req.method==='GET'&&route==='/health'){send(res,200,{ok:true,build:'puckvolt-neutral-match-labels',stream:streamAvailable,learning:learningStatus,profiles:profileStatus});return}
  if(req.method!=='POST'||!['/room','/profile','/account','/redeem','/report','/block-player','/support','/stripe/webhook'].includes(route)){send(res,404,{error:'Not found.'});return}
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
    if(route==='/support'){send(res,200,await submitSupport(data,ip));return}
    if(route==='/block-player'){const result=blockPlayer(data);await flushProfiles();send(res,200,result);return}
    if(route==='/report'){send(res,200,await reportName(data));return}
    if(route==='/room'){send(res,200,roomAction(data));return}
    if(route==='/profile'){
      const key=existingKey(data.profile)
      send(res,200,key?profileState(key):{profile:null,username:null})
      return
    }
    if(route==='/redeem'){
      if(profileStatus==='retrying'&&!await flushProfiles()){send(res,503,{error:'Your wallet is syncing. Try again shortly.'});return}
      const result=redeem(data)
      await flushProfiles()
      send(res,200,result)
      return
    }
    if(route==='/account'){
      const result=await accountAction(data,ip)
      await flushProfiles()
      send(res,200,result)
      return
    }

  }catch(error){send(res,error.statusCode||400,{error:error.message||'Request failed.'})}
}
const port=Number(process.env.PORT||8792)
if(require.main===module){
  const server=http.createServer(serve)
  streamAvailable=attachMatchSockets(server,roomAction,sessions)
  process.once('SIGTERM',()=>{
    server.close()
    const deadline=setTimeout(()=>process.exit(0),6000)
    Promise.resolve().then(()=>{
      if(dirty)persist()
      return flushProfiles()
    }).catch(error=>console.error('Shutdown save:',error.message)).finally(()=>{
      clearTimeout(deadline)
      process.exit(0)
    })
  })
  server.on('error',error=>{
    console.error(error.code==='EADDRINUSE'?'Port '+port+' is already in use. Try Play.cmd with a different port.':error.message)
    process.exitCode=1
  })
  void Promise.all([syncLearning(),restoreProfiles()]).then(()=>server.listen(port,process.env.HOST||'0.0.0.0',()=>{
    const url='http://localhost:'+server.address().port+'/'
    console.log('PuckVolt is running at '+url)
    console.log('Leave this window open while you play.')
    if(process.platform==='win32'&&process.env.MAGNET_OPEN_BROWSER==='1'){
      const {spawn}=require('node:child_process')
      const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true})
      opener.on('error',()=>console.log('Open '+url+' in your browser.'))
      opener.unref()
    }
  })).catch(error=>{
    console.error('Could not start with durable player storage:',error.message)
    process.exitCode=1
  })
}
module.exports={serve,difficultyForSkill}


