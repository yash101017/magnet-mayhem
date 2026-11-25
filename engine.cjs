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
const catalog=[
  {id:'classic',name:'Standard',type:'ship',accent:'#67f7ff',...starterMagnet},
  {id:'classic',name:'Classic Burst',type:'effect',accent:'#fff1a0'},
  ...shipNames.map((name,i)=>({
    id:i===0?'ice':'ship-'+i,name,type:'ship',design:i,accent:accents[i%accents.length],
    currency:i<10?'coins':'diamonds',price:i<10?90+i*65:18+(i-10)*7,
    range:32+i*2,push:385+i*10,pull:153+i*7
  })),
  ...effectNames.map((name,i)=>({
    id:i===0?'comet':'effect-'+i,name,type:'effect',design:i,accent:accents[(i+3)%accents.length],
    currency:i<10?'coins':'diamonds',price:i===0?150:i<10?110+i*53:13+(i-10)*7
  }))
]
const diamondPacks=[{id:'diamonds-small',amount:10,price:150},{id:'diamonds-medium',amount:30,price:420},{id:'diamonds-large',amount:75,price:950}]
function ownedStyle(type,style,gear=[],legacyPack=false){
  if(legacyPack&&['prism','gold'].includes(style))return style
  return gear.includes(style)&&catalog.some(item=>item.type===type&&item.id===style)?style:'classic'
}
function shipMagnet(style){
  return catalog.find(item=>item.type==='ship'&&item.id===style)||starterMagnet
}
const stepSeconds = 1 / 120
const fields = [
  {name:'Split Gates', bumpers:[{x:140,y:310,r:24},{x:222,y:201,r:24}]},
  {name:'Ricochet Alley', bumpers:[{x:95,y:330,r:28},{x:232,y:256,r:35},{x:130,y:159,r:25}]},
  {name:'Pinball Yard', bumpers:[{x:138,y:338,r:33},{x:250,y:269,r:31},{x:109,y:201,r:29},{x:218,y:126,r:26}]},
  {name:'Open Arena', bumpers:[]},
  {name:'Crosswind', bumpers:[{x:139,y:358,r:20},{x:221,y:162,r:20},{x:79,y:256,r:25},{x:281,y:264,r:25}]}
]
const difficulties = {
  training: {speed:84, shotPower:295, recovery:3.6, reaction:.65, line:.34},
  easy: {speed:126, shotPower:385, recovery:2.45, reaction:.36, line:.46},
  normal: {speed:177, shotPower:470, recovery:1.45, reaction:.24, line:.54},
  hard: {speed:223, shotPower:535, recovery:1.05, reaction:.14, line:.62}
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
  game.think = .55
  game.escape = null
  game.attackStall = 0
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
    puck:{}, lastShot:Array(mode==='warzone'?warTeamSize*2:2).fill(0), status:'', event:{id:0}
  }
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

function magnet(game,seat,push) {
  const craft=game.craft[seat], puck=game.puck
  if(game.phase!=='play'||craft.cd>0)return false
  const d=distance(craft,puck)
  const ai=game.mode==='warzone'&&game.bots?.[seat]?difficulties[game.bots[seat].difficulty]:game.mode==='bot'&&seat===1?difficulties[game.difficulty]:null
  const stats=craft.magnet||starterMagnet
  if(d>(ai?range:stats.range)||d<1){event(game,'miss',seat);return false}
  const force=push?(ai?.shotPower??stats.push):-(ai?Math.min(330,d*5):stats.pull)
  game.lastMagnetSeat=seat
  puck.vx=puck.vx*.38+(puck.x-craft.x)/d*force+craft.vx*.22
  puck.vy=puck.vy*.38+(puck.y-craft.y)/d*force+craft.vy*.22
  craft.cd=ai?.recovery??.85
  game.effects.push({x:craft.x,y:craft.y,t:0,color:craft.color,push,reach:ai?range:stats.range})
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
    if(game.routeTime>=.8&&distance(ship,puck)>28&&distance(ship,puck)<=range&&magnet(game,1,false)){
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
    const x=clamp(puck.x+side*77,42,W-42)
    const y=clamp(puck.y+end*63,42,H-42)
    steer(bot,x,y,ai.speed,dt)
    const gap=distance(bot,puck)
    const inward=(bot.x-puck.x)*side>54&&(bot.y-puck.y)*end>41
    if(inward&&gap>=85&&gap<=range&&magnet(game,1,false)){
      game.escape={x:clamp(bot.x-side*41,29,W-29),y:clamp(bot.y+end*73,29,H-29),left:.8}
    }
    return
  }
  const offset=(rival?.offset||0)*clamp((320-puck.y)/150,0,1)
  const behind=rival?.style==='rush'?33:44
  const defender=game.craft[0]
  const clearLane=puck.x<defender.x-20?-1:puck.x>defender.x+20?1:game.attackSide
  const goalX=W/2+clearLane*33
  const goalLine=(puck.x-goalX)*behind/Math.max(65,H-puck.y)
  const swing=12*Math.sin(game.elapsed*4.5+(rival?.offset||0)*.08)
  let targetX=clamp(puck.x+goalLine+offset+swing+puck.vx*.08,30,330)
  let targetY=clamp(puck.y-behind+7*Math.cos(game.elapsed*3.7),29,455)
  if(rival?.style==='guard'&&puck.y>285){
    targetX=clamp(puck.x+goalLine+swing,42,318)
    targetY=clamp(puck.y-66,80,436)
  }
  const d=distance(bot,puck)
  const puckSlow=Math.hypot(puck.vx,puck.vy)<25
  game.attackStall=puckSlow?game.attackStall+dt:0
  const ahead=puck.y-bot.y
  const openLane=activeField(game).bumpers.every(bumper=>distance(puck,bumper)>bumper.r+85)
  // Close the gap instead of settling at a preferred shooting distance.
  if(openLane&&puckSlow&&game.attackStall<1.05&&ahead>48&&Math.abs(puck.x-bot.x)<range){
    steerAttacker(game,{x:clamp(puck.x+goalLine,30,W-30),
      y:clamp(puck.y-29,30,H-30)},puck,speed,dt)
    game.attackStall=0
    return
  }
  const defenderInLane=defender.y>puck.y&&defender.y-puck.y<95&&Math.abs(defender.x-puck.x)<30
  if(openLane&&puckSlow&&defenderInLane&&ahead>15&&d<range){
    const flank=(defender.x<puck.x?-1:defender.x>puck.x?1:game.attackSide)
    const target={x:clamp(puck.x+flank*41,31,W-31),y:clamp(puck.y-29,31,H-31)}
    if(bot.cd<=0&&d>43&&Math.abs(puck.x-bot.x)>23&&magnet(game,1,false)){
      game.escape={x:clamp(bot.x+flank*35,31,W-31),y:clamp(bot.y+32,31,H-31),left:.44}
      game.attackStall=0
      return
    }
    targetX=target.x
    targetY=target.y
  }
  game.attackStall=puckSlow?game.attackStall+dt:0
  if(game.attackStall>=1.15&&bot.cd<=0){
    game.attackStall=0
    const line=puck.y-bot.y
    const aim=puck.x+(puck.x-bot.x)*(H-puck.y)/Math.max(line,1)
    if(d<range&&line>18&&Math.abs(aim-goalX)<60&&magnet(game,1,true))return
    if(d>42&&d<range&&magnet(game,1,false)){
      game.escape={x:clamp(bot.x+game.attackSide*48,32,W-32),y:clamp(bot.y-27,32,H-32),left:.5}
    }else{
      const side=puck.x<90?1:puck.x>W-90?-1:game.attackSide
      game.escape={x:clamp(puck.x+side*65,32,W-32),y:clamp(puck.y-53,32,H-32),left:.55}
    }
    game.attackSide*=-1
    if(game.escape)return
  }
  steerAttacker(game,{x:targetX,y:targetY},puck,speed,dt)
  game.think-=dt
  if(game.think>0)return
  game.think=ai.reaction+(rival?.reaction||0)
  const rise=puck.y-bot.y
  const aim=puck.x+(puck.x-bot.x)*(H-puck.y)/Math.max(rise,1)
  if(distance(bot,puck)<84&&rise>20&&Math.abs(aim-goalX)<23+ai.line*45){
    magnet(game,1,true)
  }else if(rival?.style==='feint'&&d>85&&d<106&&puck.y>bot.y+45&&Math.abs(puck.vx)>70){
    magnet(game,1,false)
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
  })).sort((a,b)=>a.distance-b.distance)
  const firstBot=attackOrder.find(entry=>game.bots?.[entry.seat])?.seat
  const secondBot=attackOrder.find(entry=>entry.seat!==firstBot&&game.bots?.[entry.seat])?.seat
  for(let seat=first;seat<end;seat++){
    const config=game.bots?.[seat]
    if(!config){applyInput(game,seat,inputs[seat]||neutralInput,dt);continue}
    const ship=game.craft[seat], ai=difficulties[config.difficulty]
    const [lane]=warSpawns[seat-first]
    const chase=seat===firstBot
    const support=seat===secondBot
    const space=42+config.offset*.22
    const dx=W/2-puck.x,dy=attackGoal-puck.y
    const length=Math.max(1,Math.hypot(dx,dy))
    const touch=distance(ship,puck)
    let x,y
    if(chase){
      const corner=(puck.x<65||puck.x>W-65)&&(puck.y<65||puck.y>H-65)
      x=corner?puck.x+(W/2-puck.x)*.35:puck.x-dx/length*space
      y=corner?puck.y+(H/2-puck.y)*.27:puck.y-dy/length*space
      if(!corner&&touch>80){x=puck.x;y=puck.y-direction*24}
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
    if(touch<=range&&ahead>16&&Math.abs(puck.x-ship.x)<ahead*1.25)magnet(game,seat,true)
    else if(chase&&touch>47&&touch<range&&Math.hypot(puck.vx,puck.vy)<70)magnet(game,seat,false)
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
  if(game.mode==='warzone'){
    runWarTeam(game,0,inputs,dt)
    runWarTeam(game,1,inputs,dt)
  }else{
    applyInput(game,0,inputs[0]||neutralInput,dt)
    if(game.mode==='bot')runAI(game,dt)
    else if(!solo)applyInput(game,1,inputs[1]||neutralInput,dt)
  }
  const craft=solo?[game.craft[0]]:game.craft
  const puck=game.puck, bumpers=activeField(game).bumpers
  for(let pass=0;pass<3;pass++){
    for(let first=0;first<craft.length-1;first++)for(let second=first+1;second<craft.length;second++)
      separate(craft[first],craft[second],28,.5,.5,.25)
    for(const body of craft){
      for(const bumper of bumpers) separate(body,bumper,14+bumper.r,1,0,.15)
      setInside(body,15)
    }
  }
  for(const body of craft)separate(body,puck,23,0,1,.26)
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

const api={W,H,wall,cornerRadius,goal,range,catalog,diamondPacks,ownedStyle,shipMagnet,fields,difficulties,botRivals,stepSeconds,createGame,activeField,warTeamSize,teamOf,step,steerPlayer,magnet,distance,separate,clamp}
if(typeof module!=='undefined')module.exports=api
else globalThis.MagnetEngine=api



