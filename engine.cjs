'use strict'

const W = 360
const H = 520
const wall = 14
const cornerRadius = 56
const goal = 66
const range = 112
const starterMagnet={range:28,push:370,pull:145}
const shipNames=['Ice Ship','Sparrow','Manta','Sidewinder','Copperhead','Stingray','Ghostfin','Riptide','Kestrel','Starling','Obsidian','Wraith','Valkyrie','Nightfall','Pulsar','Vortex','Solaris','Monarch','Zenith','Singularity']
const effectNames=['Comet Burst','Roseflare','Ion Rain','Solar Pop','Frost Crown','Ember Trail','Pixel Storm','Mint Rings','Tidal Bloom','Moonfall','Star Shower','Prismatic Wave','Copper Sparks','Aurora','Supernova','Crystal Halo','Phantom Mist','Gravity Well','Cosmic Bloom','Nova Crown']
const accents=['#8ef0ff','#ff92c0','#ab9aff','#ffd17e','#a0f4c5','#ff927e','#8cafff','#e4afff','#fff18b','#b5edff']
const trailDesigns=[
  ['classic','Slipstream','ribbon'],
  ['trail-ion','Ion Sparks','sparks','#74f5ff'],
  ['trail-twin','Twin Plasma','twin','#ff81de'],
  ['trail-pixel','Pixel Dash','pixels','#aaff74'],
  ['trail-frost','Frost Shards','shards','#bcfaff'],
  ['trail-comet','Solar Comet','comet','#ffbc60'],
  ['trail-bubbles','Bubble Drift','bubbles','#69eaff'],
  ['trail-chevron','Vector Wake','chevrons','#c3ff70'],
  ['trail-rings','Gravity Rings','rings','#c4a0ff'],
  ['trail-smoke','Phantom Smoke','smoke','#a995ed'],
  ['trail-lightning','Forked Lightning','lightning','#f1f59b'],
  ['trail-petals','Rose Petals','petals','#ff91bd'],
  ['trail-tide','Neon Tide','wave','#5ff6dd'],
  ['trail-prism','Prism Wave','prism','#83ffd9'],
  ['trail-aurora','Aurora Veil','aurora','#97ffba'],
  ['trail-stars','Constellation','stars','#ffee97'],
  ['trail-helix','Double Helix','helix','#e3aaff'],
  ['trail-inferno','Inferno Wake','inferno','#ff543b'],
  ['trail-orbit','Orbital Debris','orbit','#c3d0ff'],
  ['trail-nova','Nova Crown','nova','#ffe297']
]
const trails=trailDesigns.map(([id,name,pattern,accent],index)=>({
  id,name,pattern,accent,type:'trail',currency:'coins',price:index*50
}))
const catalog=[
  ...trails,
  {id:'classic',name:'Standard',type:'ship',accent:'#67f7ff',...starterMagnet},
  {id:'classic',name:'Classic Burst',type:'effect',accent:'#fff1a0'},
  ...shipNames.map((name,i)=>({
    id:i===0?'ice':'ship-'+i,name,type:'ship',design:i,accent:accents[i%accents.length],
    currency:'coins',price:50*(i<9?i+1:i),retired:i===9,
    range:32+i*2,push:385+i*10,pull:153+i*7
  })),
  ...effectNames.map((name,i)=>({
    id:i===0?'comet':'effect-'+i,name,type:'effect',design:i,accent:accents[(i+3)%accents.length],
    currency:'coins',price:50*(i<9?i+1:i),retired:i===9
  }))
]
const coinExchange={diamonds:10,coins:150,maxPacks:7}
const diamondPacks=[{id:'diamonds-small',amount:10,price:10*coinExchange.coins/coinExchange.diamonds},{id:'diamonds-medium',amount:30,price:30*coinExchange.coins/coinExchange.diamonds},{id:'diamonds-large',amount:75,price:75*coinExchange.coins/coinExchange.diamonds}]
function ownedStyle(type,style,gear=[],legacyPack=false){
  if(legacyPack&&type!=='trail'&&['prism','gold'].includes(style))return style
  return catalog.some(item=>item.type===type&&item.id===style&&(!item.price||gear.includes(style)))?style:'classic'
}
function shipMagnet(style){
  return catalog.find(item=>item.type==='ship'&&item.id===style)||starterMagnet
}
const botStyles={
  ship:catalog.filter(item=>item.type==='ship'&&!item.retired).map(item=>item.id),
  goal:catalog.filter(item=>item.type==='effect'&&!item.retired).map(item=>item.id)
}
function botLoadout(used=[],random=Math.random){
  const pick=type=>{
    const available=botStyles[type].filter(id=>!used.some(look=>look?.[type]===id))
    const pool=available.length?available:botStyles[type]
    return pool[Math.floor(random()*pool.length)]
  }
  return {ship:pick('ship'),goal:pick('goal')}
}
function equipMagnet(craft,style){
  const {range,push,pull}=shipMagnet(style)
  craft.magnet={range,push,pull}
}
const attackTactics=[
  {id:'direct',lane:0,behind:.88,lead:.07,patience:1.1},
  {id:'inside',lane:22,behind:.78,lead:.11,patience:1.35},
  {id:'breakaway',lane:12,behind:.9,lead:.17,patience:.85},
  {id:'wide',lane:39,behind:.72,lead:.09,patience:1.55}
]
const stepSeconds = 1 / 120
const fields = [
  {name:'Split Gates', bumpers:[{x:140,y:310,r:24},{x:222,y:201,r:24}]},
  {name:'Ricochet Alley', bumpers:[{x:95,y:330,r:28},{x:232,y:256,r:35},{x:130,y:159,r:25}]},
  {name:'Pinball Yard', bumpers:[{x:138,y:338,r:33},{x:250,y:269,r:31},{x:109,y:201,r:29},{x:218,y:126,r:26}]},
  {name:'Open Arena', bumpers:[]},
  {name:'Crosswind', bumpers:[{x:139,y:358,r:20},{x:221,y:162,r:20},{x:79,y:256,r:25},{x:281,y:264,r:25}]}
]
const difficulties = {
  training: {speed:84, recovery:3.6, reaction:.65, line:.34},
  easy: {speed:126, recovery:2.45, reaction:.36, line:.46},
  normal: {speed:177, recovery:1.45, reaction:.24, line:.54},
  hard: {speed:223, recovery:1.05, reaction:.14, line:.62}
}
const botRivals = [
  {name:'Bolt',style:'rush',speed:18,offset:0,reaction:-.035},
  {name:'Glint',style:'flank',speed:3,offset:-34,reaction:.015},
  {name:'Vesper',style:'flank',speed:6,offset:34,reaction:-.015},
  {name:'Anchor',style:'guard',speed:-8,offset:0,reaction:.075},
  {name:'Switch',style:'feint',speed:9,offset:14,reaction:.025}
]
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y)
const shipColors = ['#67f7ff','#ff72b3']
const warTeamSize=5
const warSpawns=[[72,431],[95,353],[180,338],[265,353],[288,431]]
function teamOf(game,seat){return game.mode==='warzone'?Math.floor(seat/warTeamSize):seat}
const still = { vx:0, vy:0 }
const neutralInput = Object.freeze({dx:0,dy:0})

function cornerAt(body){
  const low=wall+cornerRadius
  const x=body.x<low?low:body.x>W-low?W-low:null
  const y=body.y<low?low:body.y>H-low?H-low:null
  return x===null||y===null?null:{x,y}
}
function collideCorner(body,padding,bounce){
  const corner=cornerAt(body)
  if(!corner)return
  const dx=body.x-corner.x,dy=body.y-corner.y
  const d=Math.hypot(dx,dy), radius=cornerRadius-padding
  if(d<=radius)return
  const nx=dx/d,ny=dy/d
  body.x=corner.x+nx*radius
  body.y=corner.y+ny*radius
  const outward=body.vx*nx+body.vy*ny
  if(outward>0){
    body.vx-=nx*outward*(1+bounce)
    body.vy-=ny*outward*(1+bounce)
  }
}
function setInside(body, padding) {
  collideCorner(body,padding,0)
  body.x = clamp(body.x,wall+padding,W-wall-padding)
  body.y = clamp(body.y,wall+padding,H-wall-padding)
}
function releasePinnedPuck(game,craft,dt){
  const puck=game.puck, corner=cornerAt(puck)
  const pinned=corner&&distance(puck,corner)>cornerRadius-12&&
    Math.hypot(puck.vx,puck.vy)<35&&craft.some(ship=>distance(ship,puck)<28)
  game.cornerStall=pinned?(game.cornerStall||0)+dt:0
  if(game.cornerStall<1.2)return
  game.cornerStall=0
  const dx=corner.x-puck.x,dy=corner.y-puck.y,d=Math.hypot(dx,dy)
  puck.x+=dx/d*4
  puck.y+=dy/d*4
  puck.vx=370*dx/d
  puck.vy=370*dy/d
  event(game,'release')
}

function activeField(game) {
  if (game.mode === 'circuit') return [0,1,2,4].map(index => fields[index])[Math.min(game.stage,3)]
  return fields[game.field]
}

function resetRound(game) {
  game.lastMagnetSeat=null
  game.lastTouch=null
  game.think = .55
  game.escape = null
  game.attackStall = 0
  game.noProgress=0
  game.progressMark=null
  game.attackSide = 1
  game.lastAttackPosition = null
  game.motionStall = 0
  game.routeSide = null
  game.routeObstacle = null
  game.routeTime = 0
  game.cornerStall = 0
  game.trail = []
  game.effects = []
  game.serve = game.mode === 'practice' || game.mode === 'circuit' ? 0 : .8
  if (game.serve) game.phase = 'serve'
  else game.phase = 'play'
  if(game.mode==='warzone'){
    game.craft.forEach((craft,seat)=>{
      const [x,y]=warSpawns[seat%warTeamSize]
      Object.assign(craft,still,{x:teamOf(game,seat)===0?x:W-x,y:teamOf(game,seat)===0?y:H-y,cd:0})
    })
    game.botThink=game.craft.map((_,seat)=>.18+seat*.045)
  }else{
    Object.assign(game.craft[0], still, {x:180,y:410,cd:0})
    Object.assign(game.craft[1], still, {x:180,y:110,cd:0})
  }
  Object.assign(game.puck,still,{x:180,y:260})
}

function createGame({mode='bot', field=0, difficulty='easy', rival=null, bots=null} = {}) {
  const game = {
    mode,rival,bots,field:fields[field]?field:0,difficulty:Object.hasOwn(difficulties,difficulty)?difficulty:'easy',
    phase:'play',score:[0,0],stage:0,elapsed:0,serial:0,clock:90,delay:0,winner:null,extra:false,
    craft:(mode==='warzone'?shipColors.flatMap(color=>Array(warTeamSize).fill(color)):shipColors).map(color=>({color})),
    puck:{}, botShots:{count:0,forward:0,ownGoals:0},lastTouch:null, lastShot:Array(mode==='warzone'?warTeamSize*2:2).fill(0), status:'', event:{id:0}
  }
  if(mode==='bot')equipMagnet(game.craft[1],rival?.look?.ship)
  if(mode==='warzone')bots?.forEach((bot,seat)=>{if(bot)equipMagnet(game.craft[seat],bot.look?.ship)})
  resetRound(game)
  return game
}

function event(game,kind,seat) {
  game.event={id:++game.serial,kind,seat}
}

function changeGoal(game,owner) {
  if(game.mode==='practice'||game.mode==='circuit'){
    if(owner===1){resetRound(game);event(game,'reset');return}
    game.stage++
    event(game,'goal',0)
    if(game.mode==='practice'||game.stage===4){
      game.phase='over'
      game.winner=0
    } else {
      game.phase='goal'
      game.delay=.85
    }
    return
  }
  if(game.lastTouch?.bot&&game.lastTouch.team!==owner)game.botShots.ownGoals++
  game.score[owner]++
  event(game,'goal',owner)
  if(game.lastMagnetSeat!==null&&teamOf(game,game.lastMagnetSeat)===owner)game.event.scorer=game.lastMagnetSeat
  if(game.score[owner]>=3||game.extra){
    game.winner=owner
    game.phase='over'
  }else{
    game.phase='goal'
    game.delay=.85
  }
}

function isBotSeat(game,seat){
  return game.mode==='bot'&&seat===1||game.mode==='warzone'&&Boolean(game.bots?.[seat])
}
function threatensOwnGoal(game,seat,vx,vy){
  const ownY=teamOf(game,seat)===0?H-wall:wall
  const dy=ownY-game.puck.y
  if(dy*vy<=0||Math.abs(vy)<1)return false
  const t=dy/vy
  if(t>.95)return false
  const span=W-2*(wall+8)
  const projected=game.puck.x+vx*t-wall-8
  const folded=((projected%(span*2))+span*2)%(span*2)
  const x=wall+8+(folded>span?span*2-folded:folded)
  return Math.abs(x-W/2)<goal+12
}
function avoidOwnGoalContact(game,seat,before){
  if(!before)return
  const ship=game.craft[seat],puck=game.puck
  const dx=puck.x-ship.x,dy=puck.y-ship.y,gap=Math.hypot(dx,dy)
  if(gap>=27||gap<.01)return
  const nx=dx/gap,ny=dy/gap
  const closing=(ship.vx-puck.vx)*nx+(ship.vy-puck.vy)*ny
  if(closing<=0||!threatensOwnGoal(game,seat,puck.vx+nx*closing*1.26,puck.vy+ny*closing*1.26))return
  ship.x=before.x
  ship.y=before.y
  ship.vx=0
  ship.vy=0
}
function magnet(game,seat,push) {
  const craft=game.craft[seat], puck=game.puck
  if(game.phase!=='play'||craft.cd>0)return false
  const d=distance(craft,puck)
  const ai=game.mode==='warzone'&&game.bots?.[seat]?difficulties[game.bots[seat].difficulty]:game.mode==='bot'&&seat===1?difficulties[game.difficulty]:null
  const stats=craft.magnet||starterMagnet
  if(d>stats.range||d<1){event(game,'miss',seat);return false}
  const force=push?stats.push:-stats.pull
  const vx=puck.vx*.38+(puck.x-craft.x)/d*force+craft.vx*.22
  const vy=puck.vy*.38+(puck.y-craft.y)/d*force+craft.vy*.22
  if(ai&&threatensOwnGoal(game,seat,vx,vy))return false
  if(ai&&push){
    game.botShots.count++
    const direction=teamOf(game,seat)===0?-1:1
    if((puck.y-craft.y)*direction>d*.55)game.botShots.forward++
  }
  game.lastMagnetSeat=seat
  game.lastTouch={bot:Boolean(ai),team:teamOf(game,seat)}
  puck.vx=vx
  puck.vy=vy
  craft.cd=game.fairMagnets?.85:(ai?.recovery??.85)
  game.effects.push({x:craft.x,y:craft.y,t:0,color:craft.color,push,reach:stats.range})
  event(game,push?'push':'pull',seat)
  return true
}

function steer(craft,x,y,speed,dt,response=14) {
  const dx=x-craft.x,dy=y-craft.y,d=Math.hypot(dx,dy)
  const rate=Math.min(speed,d*12)/Math.max(1,d), blend=Math.min(1,dt*response)
  craft.vx+=(dx*rate-craft.vx)*blend
  craft.vy+=(dy*rate-craft.vy)*blend
  craft.x+=craft.vx*dt
  craft.y+=craft.vy*dt
  setInside(craft,15)
  craft.cd=Math.max(0,craft.cd-dt)
}

function separate(a,b,radius,moveA,moveB,restitution) {
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)
  if(d>=radius)return
  const nx=d>0?dx/d:1,ny=d>0?dy/d:0
  const overlap=radius-d
  a.x-=nx*overlap*moveA
  a.y-=ny*overlap*moveA
  b.x+=nx*overlap*moveB
  b.y+=ny*overlap*moveB
  const speed=((a.vx||0)-(b.vx||0))*nx+((a.vy||0)-(b.vy||0))*ny
  if(speed<=0)return
  const impulse=speed*(1+restitution)
  if(moveA){a.vx-=nx*impulse*moveA;a.vy-=ny*impulse*moveA}
  if(moveB){b.vx+=nx*impulse*moveB;b.vy+=ny*impulse*moveB}
  return impulse
}

function steerAttacker(game,target,puck,speed,dt){
  const ship=game.craft[1]
  if(distance(ship,target)<(ship.cd>0?17:8)){
    const dx=ship.x-puck.x,dy=ship.y-puck.y
    const length=Math.max(1,Math.hypot(dx,dy))
    const side=game.attackSide
    target={x:clamp(target.x+side*dy/length*22,30,W-30),
      y:clamp(target.y-side*dx/length*22,30,H-30)}
  }
  const bumpers=activeField(game).bumpers
  for(const bumper of bumpers){
    const dx=target.x-bumper.x,dy=target.y-bumper.y
    const clearance=bumper.r+24
    const d=Math.hypot(dx,dy)
    if(d>=clearance)continue
    const angle=d>1?Math.atan2(dy,dx):Math.atan2(ship.y-bumper.y,ship.x-bumper.x)
    target={x:clamp(bumper.x+Math.cos(angle)*clearance,30,W-30),
      y:clamp(bumper.y+Math.sin(angle)*clearance,30,H-30)}
  }
  const dx=target.x-ship.x,dy=target.y-ship.y
  const travel=dx*dx+dy*dy
  let block=null
  let nearest=Infinity
  for(const bumper of bumpers){
    const projected=((bumper.x-ship.x)*dx+(bumper.y-ship.y)*dy)/Math.max(1,travel)
    // A nearby bumper behind us does not block a route leading away from it.
    if(projected<=0)continue
    const t=Math.min(1,projected)
    const gap=Math.hypot(ship.x+dx*t-bumper.x,ship.y+dy*t-bumper.y)
    if(gap>bumper.r+17||t>=nearest)continue
    block=bumper
    nearest=t
  }
  if(block){
    const radius=block.r+28
    const angle=Math.atan2(ship.y-block.y,ship.x-block.x)
    const candidate=side=>({
      x:clamp(block.x+Math.cos(angle+side*.55)*radius,30,W-30),
      y:clamp(block.y+Math.sin(angle+side*.55)*radius,30,H-30)
    })
    if(game.routeObstacle!==block){
      game.routeSide=distance(candidate(1),target)<=distance(candidate(-1),target)?1:-1
      game.routeObstacle=block
      game.routeTime=0
    }
    game.routeTime+=dt
    if(game.routeTime>=.8&&distance(ship,puck)>28&&distance(ship,puck)<=(ship.magnet||starterMagnet).range&&magnet(game,1,false)){
      game.routeTime=0
    }
    target=candidate(game.routeSide)
  }else{
    game.routeObstacle=null
    game.routeTime=0
  }
  steer(ship,target.x,target.y,speed,dt)
}

function runAI(game,dt) {
  const bot=game.craft[1], puck=game.puck, ai=difficulties[game.difficulty]
  const reach=(bot.magnet||starterMagnet).range
  const rival=game.rival
  const speed=ai.speed+(rival?.speed||0)
  const last=game.lastAttackPosition
  game.motionStall=last&&distance(bot,last)<.11?game.motionStall+dt:0
  game.lastAttackPosition={x:bot.x,y:bot.y}
  if(game.motionStall>=.26){
    const away=bot.x<72?1:bot.x>W-72?-1:game.attackSide
    game.escape={x:clamp(bot.x+away*77,35,W-35),
      y:clamp(bot.y+(bot.y<puck.y?-1:1)*51,35,H-35),left:.66}
    game.attackSide*=-1
    game.routeSide=game.routeSide?-game.routeSide:null
    game.motionStall=0
  }
  if(game.escape){
    const exit=game.escape
    steerAttacker(game,exit,puck,speed,dt)
    exit.left-=dt
    if(exit.left<=0)game.escape=null
    return
  }
  const side=puck.x<48?1:puck.x>W-48?-1:0
  const end=puck.y<65?1:puck.y>H-65?-1:0
  if(side&&end){
    const x=clamp(puck.x+side*reach*.6,42,W-42)
    const y=clamp(puck.y+end*reach*.55,42,H-42)
    steer(bot,x,y,ai.speed,dt)
    const gap=distance(bot,puck)
    const inward=(bot.x-puck.x)*side>12&&(bot.y-puck.y)*end>12
    if(inward&&gap>=22&&gap<=reach&&magnet(game,1,false)){
      game.escape={x:clamp(bot.x-side*41,29,W-29),y:clamp(bot.y+end*73,29,H-29),left:.8}
    }
    return
  }
  const tactic=rival?.tactic||attackTactics[0]
  const defender=game.craft[0]
  const clearLane=puck.x<defender.x-20?-1:puck.x>defender.x+20?1:game.attackSide
  const goalX=W/2+clearLane*tactic.lane
  const mark=game.progressMark
  game.noProgress=mark&&puck.y<mark.y+12?game.noProgress+dt:0
  if(!mark||puck.y>mark.y+12||puck.y<mark.y-45||game.noProgress>tactic.patience+1){
    game.progressMark={x:puck.x,y:puck.y}
    if(game.noProgress>tactic.patience+1)game.attackSide*=-1
    game.noProgress=0
  }
  const behind=Math.max(23,Math.min(reach-3,reach*tactic.behind))
  const lead=clamp(puck.vx*tactic.lead,-20,20)
  const guideX=clamp(puck.x+lead,wall,W-wall)
  const dx=goalX-guideX, dy=Math.max(25,H-wall-puck.y)
  const lineLength=Math.hypot(dx,dy)
  const targetX=clamp(guideX-dx/lineLength*behind,24,W-24)
  const targetY=clamp(puck.y-dy/lineLength*behind,24,H-24)

  const stuck=game.noProgress>=tactic.patience&&Math.hypot(puck.vx,puck.vy)<34
  const flank=(puck.x<60?1:puck.x>W-60?-1:game.attackSide)*Math.min(16,reach*.28)
  steerAttacker(game,{x:stuck?clamp(targetX+flank*.65,24,W-24):targetX,y:targetY},puck,speed,dt)
  if(bot.cd>0)return
  game.think-=dt
  if(game.think>0)return
  game.think=ai.reaction+(rival?.reaction||0)
  const gap=distance(bot,puck)
  if(gap>reach)return
  const rise=puck.y-bot.y
  const aim=puck.x+(puck.x-bot.x)*(H-puck.y)/Math.max(rise,1)
  const aligned=rise>gap*.42&&Math.abs(aim-goalX)<35+ai.line*48
  if(aligned||rise>gap*.65&&(stuck||Math.abs(puck.x-W/2)<80)){
    if(magnet(game,1,true))game.noProgress=0
  }else if(stuck&&rise<gap*.65){
    if(magnet(game,1,false)){
      game.escape={x:clamp(bot.x+flank*1.8,26,W-26),y:clamp(bot.y-24,26,H-26),left:.38}
      game.noProgress=0
    }
  }
}

function pathToPuck(game,ship,x,y){
  for(const bumper of activeField(game).bumpers){
    const dx=x-ship.x,dy=y-ship.y
    const t=clamp(((bumper.x-ship.x)*dx+(bumper.y-ship.y)*dy)/Math.max(1,dx*dx+dy*dy),0,1)
    if(t<=0||Math.hypot(ship.x+dx*t-bumper.x,ship.y+dy*t-bumper.y)>bumper.r+17)continue
    const angle=Math.atan2(ship.y-bumper.y,ship.x-bumper.x)
    const radius=bumper.r+25
    const route=[-1,1].map(side=>({x:bumper.x+Math.cos(angle+side*.52)*radius,y:bumper.y+Math.sin(angle+side*.52)*radius}))
    return distance(route[0],{x,y})<distance(route[1],{x,y})?route[0]:route[1]
  }
  return {x,y}
}
function runWarTeam(game,team,inputs,dt){
  const first=team*warTeamSize
  const end=first+warTeamSize
  const puck=game.puck
  const direction=team===0?-1:1
  const attackGoal=team===0?wall:H-wall
  const attackOrder=game.craft.slice(first,end).map((craft,index)=>({
    seat:first+index,distance:distance(craft,puck)
  })).filter(entry=>!game.craft[entry.seat].inactive).sort((a,b)=>a.distance-b.distance)
  const firstBot=attackOrder.find(entry=>game.bots?.[entry.seat])?.seat
  const secondBot=attackOrder.find(entry=>entry.seat!==firstBot&&game.bots?.[entry.seat])?.seat
  for(let seat=first;seat<end;seat++){
    if(game.craft[seat].inactive)continue
    const config=game.bots?.[seat]
    if(!config){applyInput(game,seat,inputs[seat]||neutralInput,dt);continue}
    const ship=game.craft[seat], ai=difficulties[config.difficulty]
    const [lane]=warSpawns[seat-first]
    const chase=seat===firstBot
    const support=seat===secondBot
    const reach=(ship.magnet||starterMagnet).range
    const space=Math.max(23,Math.min(reach-3,reach*(config.tactic?.behind??.84)))
    const goalX=W/2+(seat%2?1:-1)*(config.tactic?.lane??0)
    const dx=goalX-puck.x,dy=attackGoal-puck.y
    const length=Math.max(1,Math.hypot(dx,dy))
    const touch=distance(ship,puck)
    let x,y
    if(chase){
      const corner=(puck.x<65||puck.x>W-65)&&(puck.y<65||puck.y>H-65)
      x=corner?puck.x+(W/2-puck.x)*.35:puck.x-dx/length*space
      y=corner?puck.y+(H/2-puck.y)*.27:puck.y-dy/length*space
      if(!corner&&touch>reach+12){x=puck.x;y=puck.y-direction*24}
    }else if(support){
      x=puck.x+(ship.x<puck.x?-65:65)
      y=puck.y-direction*36
    }else{
      x=lane*.66+puck.x*.34+Math.sin(game.elapsed*2+seat)*12
      y=puck.y-direction*(72+(seat-first)%3*25)
      y=team===0?clamp(y,145,H-40):clamp(y,40,H-145)
    }
    const target=pathToPuck(game,ship,clamp(x,31,W-31),clamp(y,32,H-32))
    steer(ship,target.x,target.y,ai.speed+config.speed,dt)
    game.botThink[seat]-=dt
    if(game.botThink[seat]>0||ship.cd>0||(!chase&&!support))continue
    game.botThink[seat]=ai.reaction+.08
    const ahead=(puck.y-ship.y)*direction
    if(touch<=reach&&ahead>16&&Math.abs(puck.x-ship.x)<ahead*1.25)magnet(game,seat,true)
    else if(chase&&touch>Math.max(23,reach*.65)&&touch<reach&&Math.abs(puck.x-ship.x)>touch*.72&&Math.hypot(puck.vx,puck.vy)<30)magnet(game,seat,false)
  }
}

function steerPlayer(craft,input,dt) {
  const targeted=Number.isFinite(input.x)&&Number.isFinite(input.y)
  const tilt=Math.min(1,Math.hypot(input.dx,input.dy))
  const strength=targeted?1:tilt**1.65
  steer(craft,input.x??craft.x+input.dx*90,input.y??craft.y+input.dy*90,365*strength,dt,targeted?27:18)
}

function applyInput(game,seat,input,dt) {
  const craft=game.craft[seat]
  steerPlayer(craft,input,dt)
  if(input.shot&&input.shot.id>game.lastShot[seat]){
    game.lastShot[seat]=input.shot.id
    magnet(game,seat,input.shot.push)
  }
}

function step(game,inputs=[neutralInput,neutralInput],dt=stepSeconds) {
  game.effects=game.effects.filter(effect=>(effect.t+=dt)<.34)
  if(game.phase==='serve'){
    game.serve-=dt
    if(game.serve<=0)game.phase='play'
    return
  }
  if(game.phase==='goal'){
    game.delay-=dt
    if(game.delay<=0)resetRound(game)
    return
  }
  if(game.phase!=='play')return
  game.elapsed+=dt
  const solo=game.mode==='practice'||game.mode==='circuit'
  if(!solo&&!game.extra){
    game.clock=Math.max(0,game.clock-dt)
    if(game.clock===0){
      if(game.score[0]!==game.score[1]){
        game.winner=game.score[0]>game.score[1]?0:1
        game.phase='over'
        return
      }
      game.extra=true
      resetRound(game)
      return
    }
  }
  const botPositions=game.craft.map((ship,seat)=>isBotSeat(game,seat)?{x:ship.x,y:ship.y}:null)
  if(game.mode==='warzone'){
    runWarTeam(game,0,inputs,dt)
    runWarTeam(game,1,inputs,dt)
  }else{
    applyInput(game,0,inputs[0]||neutralInput,dt)
    if(game.mode==='bot')runAI(game,dt)
    else if(!solo)applyInput(game,1,inputs[1]||neutralInput,dt)
  }
  const activeCraft=solo?[0]:game.craft.map((_,seat)=>seat).filter(seat=>!game.craft[seat].inactive)
  const craft=activeCraft.map(seat=>game.craft[seat])
  const puck=game.puck, bumpers=activeField(game).bumpers
  for(let pass=0;pass<3;pass++){
    for(let first=0;first<craft.length-1;first++)for(let second=first+1;second<craft.length;second++)
      separate(craft[first],craft[second],28,.5,.5,.25)
    for(const body of craft){
      for(const bumper of bumpers) separate(body,bumper,14+bumper.r,1,0,.15)
      setInside(body,15)
    }
  }
  let impact=0
  for(const seat of activeCraft){
    const body=game.craft[seat]
    avoidOwnGoalContact(game,seat,botPositions[seat])
    const impulse=separate(body,puck,23,0,1,.26)||0
    if(impulse>impact)impact=impulse
    if(impulse>=28)game.lastTouch={bot:isBotSeat(game,seat),team:teamOf(game,seat)}
  }
  if(impact>=28&&(!game.hit||game.elapsed-game.hit.time>=.11)){
    game.hit={id:++game.serial,time:game.elapsed}
  }
  puck.x+=puck.vx*dt
  puck.y+=puck.vy*dt
  const damping=Math.pow(.37,dt)
  puck.vx*=damping
  puck.vy*=damping
  for(const bumper of bumpers)separate(puck,bumper,8+bumper.r,1,0,.86)
  collideCorner(puck,8,.86)
  if(puck.x<wall+8||puck.x>W-wall-8){
    puck.x=clamp(puck.x,wall+8,W-wall-8);puck.vx*=-.86
  }
  const opening=Math.abs(puck.x-W/2)<goal-8
  if(opening&&puck.y<wall-4){changeGoal(game,0);return}
  if(opening&&puck.y>H-wall+4){changeGoal(game,1);return}
  if(!opening&&(puck.y<wall+8||puck.y>H-wall-8)){
    puck.y=clamp(puck.y,wall+8,H-wall-8);puck.vy*=-.86
  }
  releasePinnedPuck(game,craft,dt)
  if((game.frame=(game.frame||0)+1)%3===0){
    game.trail.push({x:puck.x,y:puck.y})
    if(game.trail.length>11)game.trail.shift()
  }
}

const api={W,H,wall,cornerRadius,goal,range,catalog,trails,diamondPacks,coinExchange,ownedStyle,shipMagnet,botLoadout,equipMagnet,fields,difficulties,botRivals,attackTactics,stepSeconds,createGame,activeField,warTeamSize,teamOf,step,steerPlayer,magnet,distance,separate,clamp}
if(typeof module!=='undefined')module.exports=api
else globalThis.MagnetEngine=api



