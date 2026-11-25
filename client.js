'use strict'
const {W,H,wall,cornerRadius,goal,catalog,diamondPacks,coinExchange,ownedStyle,shipMagnet,fields,createGame,activeField,distance,step,stepSeconds,steerPlayer,separate,clamp,teamOf}=MagnetEngine
const $=id=>document.getElementById(id)
const canvas=$('field'),ctx=canvas.getContext('2d')
const held=new Set()
const online={connection:null,seat:0,busy:false,errors:0,rematch:false}
const themeColors={classic:['#67f7ff','#ff72b3','#fff1a0'],prism:['#ff8370','#ffe676','#68ffd9','#79b8ff','#e78aff'],gold:['#fff1b0','#ffb84c','#fb8233'],comet:['#efffff','#7aeeff','#7296ff']}
let game=createGame({mode:'online'}), menu=true, pointer=null, shot=null, shotSerial=0
let previousEvent='', previousOverlay='', currentField=0, bursts=[], audio=null, sound=false
const coinPrices={ice:90,comet:150}
let coins=0,diamonds=0,gear=[],rewardMatch=null,refillDeadline=null,nextRefillCheck=0
let practicing=false,practiceBank=0,practiceShip=null
let cosmetic='classic', shipStyle='classic', selectedPreview=null, ownsPack=false, profile=null, username=null, accountMode=null, cachedStatus=''
let guestMode=true, accountEmail=null, profileRequest=null, profileError=''
let pos=null, frameTime=performance.now(), snapshotArrival=0, lastHud=0, lastSync=0
let backdrop=null, backdropKey=null, localPose=null
let matchSocket=null, streamReady=false, streamRetry=0, streamFailures=0
let pingMs=null, pingUpdated=0, lastPing=0, pingSerial=0, pingProbe=null

function saved(key,value){
  try {
    if(value!==undefined)localStorage.setItem('magnet-'+key,value)
    return localStorage.getItem('magnet-'+key)
  }catch{return null}
}
profile=saved('profile')
let buttonSide=saved('button-side')==='right'?'right':'left'
function updateButtonSide(){
  $('match-stage').dataset.side=buttonSide
  write('control-side','Buttons: '+(buttonSide==='left'?'Left':'Right'))
  $('control-side').setAttribute('aria-label','Move action buttons to the '+(buttonSide==='left'?'right':'left'))
}
function safeCosmetic(type,value){return ownedStyle(type,value,gear,ownsPack)}
for(const [index,field] of fields.entries()){
  const option=document.createElement('option')
  option.value=index
  option.textContent=field.name
  $('field-picker').append(option)
}
function changeField(){
  if(online.connection)return
  currentField=Number($('field-picker').value)
  if(menu || game.phase==='over'){
    if(menu)game=createGame({mode:'online',field:currentField})
    renderHud()
    return
  }
  setMenu()
}
$('field-picker').addEventListener('change',changeField)
function clearPlayState(){
  pointer=null
  held.clear()
  shot=null
  previousEvent=''
  previousOverlay=''
  bursts=[]
  pos=null
  localPose=null
  snapshotArrival=0
  cachedStatus=''
}
function setMenu(){
  practicing=false
  practiceShip=null
  practiceBank=0
  clearPlayState()
  menu=true
  game=createGame({mode:'online',field:currentField})
  cachedStatus='First to 3'
  renderHud()
}
function startPractice(style=shipStyle){
  clearPlayState()
  practicing=true
  practiceShip=style
  practiceBank=0
  menu=false
  game=createGame({mode:'bot',difficulty:'training',field:currentField})
  game.craft[0].magnet=shipMagnet(practiceShip)
  renderHud()
}
function goReplay(){
  if(practicing){startPractice(practiceShip);return}
  if(menu){openLobby();return}
  if(online.connection){
    online.rematch=true
    renderHud()
  }
}
function showDialog(id){
  const dialog=$(id)
  if(!dialog.open)dialog.showModal()
  pointer=null
  held.clear()
}
function closeDialog(id){
  const dialog=$(id)
  if(dialog.open)dialog.close()
}
const anyDialog=()=>[...document.querySelectorAll('dialog')].some(dialog=>dialog.open)
function beep(freq,duration,type='sine'){
  if(!sound||!audio||audio.state!=='running')return
  const osc=audio.createOscillator(),gain=audio.createGain(),now=audio.currentTime
  osc.type=type;osc.frequency.value=freq
  gain.gain.setValueAtTime(.08,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration)
  osc.connect(gain).connect(audio.destination);osc.start(now);osc.stop(now+duration)
}
function effectParticles(theme){
  const item=catalog.find(entry=>entry.type==='effect'&&entry.id===theme)
  const colors=themeColors[theme]||[item?.accent||'#fff1a0','#f6f4ff','#92a2ff']
  const design=item?.design??0
  return Array.from({length:36},(_,i)=>{
    const arms=3+design%7
    const angle=design%3===0?i*Math.PI/18:
      (i%arms)*Math.PI*2/arms+Math.floor(i/arms)*(.07+design%5*.06)
    const speed=45+(design%4===0?i%4*37:(i*43+design*11)%150)
    return {vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,color:colors[i%colors.length],
      radius:1.5+(i+design)%4*.65,life:.42+i%4*.12}
  })
}
function celebrate(x,y,theme){
  bursts.push(...effectParticles(theme).map(particle=>({...particle,x,y})))
}
function renderEvent(){
  const event=game.event
  const key=(online.matchId||'local')+':'+event.id
  if(previousEvent===key||!event.id)return
  previousEvent=key
  const ours=event.seat===(event.kind==='goal'?teamOf(game,online.seat):online.seat)
  if(event.kind==='goal'){
    celebrate(180,event.seat===0?24:H-24,online.state?.looks?.[event.scorer??(game.mode==='warzone'?-1:event.seat)]?.goal||(!online.connection&&ours?cosmetic:'classic'))
    beep(ours?660:175,.36,'triangle')
    cachedStatus=ours?'Goal!':'Opponent scores'
  }
  if(event.kind==='push'||event.kind==='pull'){
    beep(event.kind==='push'?260:490,.12,'triangle')
    if(ours)cachedStatus=''
  }
  if(event.kind==='miss'&&ours){cachedStatus='Get closer to the puck';beep(105,.10)}
  if(event.kind==='reset')cachedStatus='Puck reset'
  if(event.kind==='release')beep(310,.12,'triangle')
}
function showOverlay(title,message,replay,offer){
  const key=JSON.stringify([title,message,replay,offer])
  if(previousOverlay===key)return
  previousOverlay=key
  $('title').textContent=title
  $('message').textContent=message
  $('replay').hidden=!replay
  $('replay').disabled=Boolean(online.rematch)
  $('replay').textContent=replay||''
  $('result-shop').hidden=!offer
}
function write(id,text){
  const node=$(id)
  if(node.textContent!==text)node.textContent=text
}
function renderHud(){
  write('coin-total',coins+' coins')
  const remaining=refillDeadline===null?null:Math.max(0,Math.ceil((refillDeadline-performance.now())/1000))
  write('refill-clock',remaining===null?'Choose a profile':remaining===0?'Refilling?':
    String(Math.floor(remaining/60)).padStart(2,'0')+':'+String(remaining%60).padStart(2,'0'))
  $('game-root').dataset.match=String(!menu)
  write('home-player',username|| (profileError?'Play offline while reconnecting':'Loading playerâ€¦'))
  $('home-view').hidden=!menu
  $('match-view').hidden=menu
  const solo=game.mode==='practice'||game.mode==='circuit'
  const seat=online.seat
  const names=online.state?.names
  const war=game.mode==='warzone'
  const ownTeam=teamOf(game,seat)
  const tags=war?[ownTeam===0?'CYAN (YOU)':'CYAN',ownTeam===1?'PINK (YOU)':'PINK']:names||[username||'YOU',practicing?'Practice':'']
  write('score0',solo?(game.mode==='circuit'?'STAGE '+Math.min(game.stage+1,4)+'/4':'PRACTICE'):tags[0]+' '+game.score[0])
  write('score1',solo?game.elapsed.toFixed(1)+'s':(game.score[1]+' '+tags[1]).trim())
  const clock=Math.ceil(game.clock)
  const clockText=Math.floor(clock/60)+':'+String(clock%60).padStart(2,'0')
  write('status',menu?'First to 3':online.connection&&!online.matchId?(online.war?'Finding teamsâ€¦':'Finding opponentâ€¦'):
    game.phase==='serve'?(game.extra?'Sudden death':'Get ready'):
    game.phase==='goal'?cachedStatus||'Goal':
    solo?(cachedStatus||activeField(game).name):
    game.extra?'Sudden death':cachedStatus||clockText)
  const overlay=menu||game.phase==='over'||Boolean(online.connection&&!online.matchId)
  const playing=!overlay&&!anyDialog()
  const locked=String(playing)
  if(document.documentElement.dataset.gameLocked!==locked)document.documentElement.dataset.gameLocked=locked
  const ping=$('ping-display')
  ping.hidden=!online.connection||!online.matchId
  const freshPing=pingMs!==null&&performance.now()-pingUpdated<4500
  write('ping-display',freshPing?'Ping '+Math.round(pingMs)+' ms':'Ping â€”')
  ping.dataset.quality=!freshPing?'unknown':pingMs>=150?'poor':pingMs>=80?'fair':'good'
  $('overlay').hidden=!overlay
  $('match-stage').dataset.overlay=String(overlay)
  $('home-after-match').hidden=menu||!practicing&&game.phase!=='over'
  if(menu){
    showOverlay(fields[currentField].name,'Drag to steer. Pull the puck close, then push it into the opposing goal.','Open Online',false)
  }else if(online.connection&&!online.matchId){
    showOverlay(online.war?'Finding teams':online.ranked?'Finding a rival':'Waiting for friend',
      online.war?'Building two teams of five. Your match will start in a few seconds.':online.ranked?'Your match should start in a few seconds.':'Open Online to see your room code.',null,false)
  }else if(game.phase==='over'){
    let title=solo?(game.mode==='circuit'?'Circuit cleared!':'Course cleared!'):
      war?(game.winner===ownTeam?'Your team wins!':'Other team wins'):game.winner===seat?'You win!':'Opponent wins'
    let message=solo?game.elapsed.toFixed(1)+' seconds Â· '+(game.mode==='circuit'?'4 courses':activeField(game).name):game.score.join(' â€“ ')
    if(online.state?.result?.coins){
      const change=online.state.result.coins
      message+=' Â· '+(change>0?'+':'')+change+' Arena Coins'
    }
    if(online.state?.result?.reason==='forfeit')message+=' Â· Opponent disconnected'
    if(online.state?.result?.delta)message+=' Â· '+(online.state.result.delta>0?'+':'')+online.state.result.delta+' rating'
    if(ownsPack&&game.winner===ownTeam)message+=' Â· Founders'
    const replay=online.rematch?'Waiting for rival':online.war?'Play War Zone again':online.ranked?'Find another match':'Rematch'
    showOverlay(title,message,replay,true)
  }
  const craft=game.craft[seat]
  const live=!menu&&game.phase==='play'&&(!online.connection||Boolean(online.matchId))
  const ready=live&&craft.cd<=0
  for(const id of ['push','pull']){
    const button=$(id)
    const value=String(!ready)
    if(button.getAttribute('aria-disabled')!==value)button.setAttribute('aria-disabled',value)
    const timer=$(id+'-time')
    timer.hidden=!live||craft.cd<=0
    if(!timer.hidden)write(id+'-time',cooldownLabel(craft.cd))
  }
}
function cooldownLabel(seconds){
  return (seconds>1?Math.ceil(seconds):(Math.ceil(seconds*10)/10).toFixed(1))+'s'
}
function stroke(x,y,xx,yy,color,width=1,g=ctx){
  g.beginPath();g.moveTo(x,y);g.lineTo(xx,yy);g.strokeStyle=color;g.lineWidth=width;g.stroke()
}
function ring(x,y,r,color,width=1,g=ctx){
  g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.strokeStyle=color;g.lineWidth=width;g.stroke()
}
function disc(x,y,r,color,g=ctx){
  g.fillStyle=color;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill()
}
const shipArtTileSize=234
const shipArtSlots=new Map(catalog.filter(item=>item.type==='ship'&&!item.retired)
  .map((item,index)=>[item.id,index]))
shipArtSlots.set('ship-9',10)
shipArtSlots.set('prism',16)
shipArtSlots.set('gold',18)
const shipArt=typeof Image==='function'?new Image():null
if(shipArt){
  shipArt.addEventListener('load',()=>updateShop())
  shipArt.src='ship-art.webp'
}
function drawShip(g,x,y,color,style,rotation=0,scale=1){
  g.save()
  g.translate(x,y)
  g.scale(scale,scale)
  g.fillStyle='#071725'
  g.beginPath();g.arc(0,0,14,0,Math.PI*2);g.fill()
  if(shipArt?.naturalWidth){
    const index=shipArtSlots.get(style)??0
    g.save()
    g.rotate(rotation)
    g.drawImage(shipArt,index%5*shipArtTileSize,Math.floor(index/5)*shipArtTileSize,shipArtTileSize,shipArtTileSize,-13,-13,26,26)
    g.restore()
  }
  g.strokeStyle=color
  g.lineWidth=1.8
  g.beginPath();g.arc(0,0,13.4,0,Math.PI*2);g.stroke()
  g.restore()
}

function arenaBackdrop(field){
  if(backdrop&&backdropKey===field.name)return backdrop
  backdrop??=document.createElement('canvas')
  backdrop.width=canvas.width
  backdrop.height=canvas.height
  const g=backdrop.getContext('2d')
  g.setTransform(2,0,0,2,0,0)
  g.clearRect(0,0,W,H)
  g.fillStyle='#263657'
  for(let x=24;x<W;x+=24)for(let y=24;y<H;y+=24)g.fillRect(x,y,2,2)
  stroke(wall,H/2,W-wall,H/2,'#36426b',1,g)
  ring(180,260,52,'#36426b',1,g)
  const inset=wall+cornerRadius
  for(const [y,color] of [[wall,game.craft[game.craft.length-1].color],[H-wall,game.craft[0].color]]){
    stroke(inset,y,180-goal,y,'#7184ae',3,g);stroke(180+goal,y,W-inset,y,'#7184ae',3,g)
    g.shadowColor=color;g.shadowBlur=15
    stroke(180-goal,y,180+goal,y,color,5,g)
    g.shadowBlur=0
  }
  stroke(wall,inset,wall,H-inset,'#7184ae',3,g)
  stroke(W-wall,inset,W-wall,H-inset,'#7184ae',3,g)
  for(const [x,y,angle] of [[inset,inset,Math.PI],[W-inset,inset,-Math.PI/2],
    [W-inset,H-inset,0],[inset,H-inset,Math.PI/2]]){
    g.beginPath()
    g.arc(x,y,cornerRadius,angle,angle+Math.PI/2)
    g.strokeStyle='#7184ae'
    g.lineWidth=3
    g.stroke()
  }
  for(const obstacle of field.bumpers){
    disc(obstacle.x,obstacle.y,obstacle.r,'#3a2651',g)
    ring(obstacle.x,obstacle.y,obstacle.r,'#d193ff',2,g)
    ring(obstacle.x,obstacle.y,obstacle.r-7,'#78539d',1.5,g)
  }
  backdropKey=field.name
  return backdrop
}
function draw(dt){
  ctx.setTransform(2,0,0,2,0,0)
  ctx.clearRect(0,0,W,H)
  const field=activeField(game)
  ctx.drawImage(arenaBackdrop(field),0,0,W,H)
  const solo=game.mode==='practice'||game.mode==='circuit'
  const targets=[...game.craft,game.puck]
  if(!pos||pos.length!==targets.length)pos=targets.map(body=>({x:body.x,y:body.y}))
  const predict=online.connection&&game.phase==='play'&&snapshotArrival?
    clamp((performance.now()-snapshotArrival)/1000,0,.10):0
  targets.forEach((body,index)=>{
    const x=clamp(body.x+body.vx*predict,0,W)
    const y=clamp(body.y+body.vy*predict,0,H)
    if(index===online.seat&&online.connection&&game.phase==='play'){
      localPose??={...body}
      const input=inputState()
      const driving=Number.isFinite(input.x)||Boolean(input.dx||input.dy)
      steerPlayer(localPose,input,dt)
      const offset=Math.hypot(x-localPose.x,y-localPose.y)
      const blend=offset>100?1:1-Math.exp(-dt*(driving&&offset<42?5:16))
      localPose.x+=(x-localPose.x)*blend
      localPose.y+=(y-localPose.y)*blend
      for(const bumper of field.bumpers)separate(localPose,bumper,14+bumper.r,1,0,.15)
      pos[index].x=localPose.x
      pos[index].y=localPose.y
      return
    }
    if(index===online.seat)localPose=null
    const blend=!online.connection||Math.hypot(pos[index].x-body.x,pos[index].y-body.y)>110?1:1-Math.exp(-dt*20)
    pos[index].x+=(x-pos[index].x)*blend
    pos[index].y+=(y-pos[index].y)*blend
  })
  const puck=pos[game.craft.length]
  const ship=game.craft[online.seat]
  const ours=pos[online.seat], color=ship.color, reach=(ship.magnet||shipMagnet('classic')).range
  if(!menu&&game.phase==='play'){
    ctx.setLineDash([3,6])
    ring(ours.x,ours.y,reach,distance(ours,puck)<=reach?color+'70':color+'25')
    ctx.setLineDash([])
  }
  for(const effect of game.effects){
    ctx.globalAlpha=1-effect.t/.34
    ring(effect.x,effect.y,effect.push?12+effect.t*(effect.reach||112)*2.4:Math.max(4,(effect.reach||112)*(1-effect.t*2.3)),effect.color,3)
  }
  ctx.globalAlpha=1
  game.trail.forEach((point,i)=>{ctx.globalAlpha=i*.035;disc(point.x,point.y,3+i*.38,'#f9dc79')})
  ctx.globalAlpha=1
  for(let seat=0;seat<(solo?1:game.craft.length);seat++){
    const ship=pos[seat], shipColor=game.craft[seat].color
    const rotation=menu?0:performance.now()*.0017+seat*.35
    if(seat===online.seat&&game.mode==='warzone')ring(ship.x,ship.y,18,'#f4fff9',2)
    drawShip(ctx,ship.x,ship.y,shipColor,online.state?.looks?.[seat]?.ship||(seat===online.seat?(practicing?practiceShip:shipStyle):'classic'),rotation)
  }
  disc(puck.x,puck.y,11,'#ffdb753a')
  disc(puck.x,puck.y,8,'#ffe382')
  bursts=bursts.filter(particle=>{
    particle.life-=dt
    if(particle.life<=0)return false
    particle.x+=particle.vx*dt;particle.y+=particle.vy*dt
    ctx.globalAlpha=Math.min(1,particle.life*2)
    disc(particle.x,particle.y,particle.radius,particle.color)
    return true
  })
  ctx.globalAlpha=1
  if(!menu&&game.phase==='serve'){
    ctx.font='800 22px system-ui';ctx.textAlign='center';ctx.fillStyle='#fff'
    ctx.fillText(game.extra?'SUDDEN DEATH':'READY',W/2,H/2+6)
  }
}
const axis=(positive,negative,extraPositive,extraNegative)=>Number(held.has(positive)||held.has(extraPositive))-Number(held.has(negative)||held.has(extraNegative))
function inputState(){
  const dx=axis('d','a','arrowright','arrowleft')
  const dy=axis('s','w','arrowdown','arrowup')
  const target=pointer&&(pointer.active!==false||performance.now()<pointer.until)?pointer:null
  return {x:dx||dy?undefined:target?.x,y:dx||dy?undefined:target?.y,dx,dy,shot}
}
function frame(now){
  const dt=clamp((now-frameTime)/1000,0,.05)
  frameTime=now
  if(pointer&&(game.phase!=='play'||pointer.active===false&&now>=pointer.until))pointer=null
  if(practicing&&!anyDialog()){
    const input=inputState()
    practiceBank+=dt
    while(practiceBank>=stepSeconds){step(game,[input]);practiceBank-=stepSeconds}
  }
  if(username&&refillDeadline!==null&&now>=refillDeadline&&now>=nextRefillCheck){
    nextRefillCheck=now+4000
    refreshProfile()
  }
  renderEvent()
  if(!menu)draw(dt)
  if(now-lastHud>=70){lastHud=now;renderHud()}
  requestAnimationFrame(frame)
}
$('match-view').addEventListener('contextmenu',event=>event.preventDefault())
$('match-view').addEventListener('selectstart',event=>event.preventDefault())
$('match-view').addEventListener('dblclick',event=>event.preventDefault())
function blockMatchZoom(event){
  if(document.documentElement.dataset.gameLocked==='true'&&event.cancelable)event.preventDefault()
}
for(const type of ['gesturestart','gesturechange','gestureend'])document.addEventListener(type,blockMatchZoom,{passive:false})
let lastActionTap=0
$('match-view').addEventListener('touchend',event=>{
  if(!event.target.closest('.magnet-buttons button'))return
  const now=performance.now()
  if(lastActionTap&&now-lastActionTap<350)blockMatchZoom(event)
  lastActionTap=now
},{passive:false})
const steerSurface=$('match-view')
function movePointer(event){
  if(pointer.relative){
    pointer.x=clamp(pointer.originX+(event.clientX-pointer.startX)*pointer.scaleX,0,W)
    pointer.y=clamp(pointer.originY+(event.clientY-pointer.startY)*pointer.scaleY,0,H)
    return
  }
  const rect=canvas.getBoundingClientRect()
  pointer.x=clamp((event.clientX-rect.left)*W/rect.width,0,W)
  pointer.y=clamp((event.clientY-rect.top)*H/rect.height,0,H)
}
steerSurface.addEventListener('pointerdown',event=>{
  if(event.button!==0||menu||game.phase!=='play'||pointer?.active||anyDialog())return
  if(event.target.closest('button, a, input, select, .overlay'))return
  const relative=event.pointerType==='touch'||event.pointerType==='pen'
  if(!relative&&event.target!==canvas)return
  const rect=canvas.getBoundingClientRect()
  if(!rect.width||!rect.height)return
  if(event.cancelable)event.preventDefault()
  const craft=pos?.[online.seat]||game.craft[online.seat]
  pointer={id:event.pointerId,active:true,relative,originX:craft.x,originY:craft.y,
    startX:event.clientX,startY:event.clientY,scaleX:W/rect.width*1.15,scaleY:H/rect.height*1.15}
  steerSurface.setPointerCapture(event.pointerId)
  movePointer(event)
  syncOnline()
})
steerSurface.addEventListener('pointermove',event=>{
  if(!pointer?.active||pointer.id!==event.pointerId)return
  if(event.cancelable)event.preventDefault()
  movePointer(event)
  syncOnline()
})
for(const type of ['pointerup','pointercancel','lostpointercapture'])steerSurface.addEventListener(type,event=>{
  if(!pointer?.active||pointer.id!==event.pointerId)return
  if(type==='pointerup'&&pointer.relative){
    movePointer(event)
    pointer.active=false
    pointer.until=performance.now()+175
  }else{
    pointer=null
  }
  syncOnline()
})
function shoot(push){
  if(menu||game.phase!=='play'||anyDialog()||game.craft[online.seat].cd>0)return
  shot={id:++shotSerial,push}
  syncOnline(true)
}
window.addEventListener('keydown',event=>{
  const key=event.key.toLowerCase()
  if(menu||anyDialog()||!['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','q','e'].includes(key))return
  event.preventDefault();held.add(key)
  if(!event.repeat&&(key==='q'||key==='e'))shoot(key==='e')
})
window.addEventListener('keyup',event=>held.delete(event.key.toLowerCase()))
window.addEventListener('blur',()=>{held.clear();pointer=null})
$('replay').addEventListener('click',goReplay)
for(const id of ['push','pull']){
  const button=$(id)
  const trigger=()=>shoot(id==='push')
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0)return
    if(event.cancelable)event.preventDefault()
    trigger()
  })
  button.addEventListener('click',event=>{if(event.detail===0)trigger()})
}
$('control-side').addEventListener('click',()=>{
  buttonSide=buttonSide==='left'?'right':'left'
  saved('button-side',buttonSide)
  updateButtonSide()
})
updateButtonSide()
$('sound').addEventListener('click',async()=>{
  sound=!sound
  if(sound){
    try{audio??=new (window.AudioContext||window.webkitAudioContext)();await audio.resume();beep(440,.1)}
    catch{sound=false}
  }
  write('sound',sound?'Sound on':'Sound off')
  $('sound').setAttribute('aria-pressed',String(sound))
})
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>closeDialog(button.dataset.close))

async function api(route,data){
  if(location.protocol==='file:')throw new Error('Launch the multiplayer download to connect to the game server.')
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),3600)
  try{
    const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal})
    const body=await response.json()
    if(body.error)throw new Error(body.error)
    if(!response.ok)throw new Error('Server unavailable.')
    return body
  }finally{clearTimeout(timer)}
}
function setProfile(key){
  if(key){profile=key;saved('profile',key)}
}
function applyProfile(data){
  if(!data.profile){
    profile=null
    username=null
    coins=0
    diamonds=0
    gear=[]
    refillDeadline=null
    ownsPack=false
    cosmetic='classic'
    shipStyle='classic'
    guestMode=true
    accountEmail=null
    saved('profile','')
    return
  }
  setProfile(data.profile)
  username=data.username
  guestMode=Boolean(data.guest)
  accountEmail=data.email||null
  if(guestMode&&username)saved('guest-profile',profile)
  else if(saved('guest-profile')===profile)saved('guest-profile','')
  if(!guestMode&&saved('guest-device')===profile)saved('guest-device','')
  coins=data.coins||0
  diamonds=data.diamonds||0
  refillDeadline=Number.isFinite(data.refillIn)?performance.now()+data.refillIn:null
  gear=data.gear||[]
  ownsPack=data.ownsPack
  cosmetic=safeCosmetic('effect',saved('cosmetic'))
  shipStyle=safeCosmetic('ship',saved('ship-style'))
  write('rating',username?'Rating '+data.rating:'')
  updateShop()
}
function guestDevice(){
  const cached=saved('guest-device')
  if(/^[a-f0-9]{48}$/.test(cached||''))return cached
  const bytes=new Uint8Array(24)
  window.crypto.getRandomValues(bytes)
  const id=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('')
  saved('guest-device',id)
  return id
}
async function refreshProfile(){
  if(location.protocol==='file:')return
  if(profileRequest)return profileRequest
  profileRequest=(async()=>{
    try{
      const savedGuest=saved('guest-profile')
      const data=await api('/account',{action:'bootstrap',profile:profile||savedGuest,device:guestDevice()})
      profileError=''
      applyProfile(data)
    }catch{
      profileError='Could not connect to your player profile. Try again in a moment.'
    }finally{profileRequest=null}
  })()
  return profileRequest
}
function updateAccountCard(){
  write('account-summary',username||'Connecting to your profileâ€¦')
  write('account-kind',username?(guestMode?'Guest on this browser':accountEmail||'Signed-in player'):'')
  $('rename-account').disabled=!username
  $('register-account').hidden=Boolean(username&&!guestMode)
  $('switch-account').hidden=!username||guestMode
}
function openAccount(){
  $('account-form').hidden=true
  $('account-choices').hidden=false
  updateAccountCard()
  write('account-message',profileError)
  showDialog('account-dialog')
  if(!username)refreshProfile().then(()=>{
    updateAccountCard()
    write('account-message',profileError)
  })
}
function chooseAccount(action){
  accountMode=action
  const rename=action==='rename'
  const register=action==='register'
  $('account-choices').hidden=true
  $('account-form').hidden=false
  $('username-row').hidden=!rename
  $('username').required=rename
  $('username').value=rename?username||'':''
  $('email-row').hidden=rename
  $('email').required=!rename
  $('email').type=register?'email':'text'
  $('email').value=''
  $('password-row').hidden=rename
  $('password').required=!rename
  $('password').autocomplete=register?'new-password':'current-password'
  $('password').value=''
  write('email-label',register?'Email address':'Email or player name')
  write('account-submit',rename?'Save name':register?'Save account':'Sign in')
  write('account-form-help',register?'Keep your coins and unlocked gear when you switch devices.':
    rename?'This name appears on your scoreboard.':'Use your saved account details.')
  write('account-message','')
  $(rename?'username':'email').focus()
}
$('account').addEventListener('click',openAccount)
$('rename-account').addEventListener('click',()=>chooseAccount('rename'))
$('register-account').addEventListener('click',()=>chooseAccount('register'))
$('login-account').addEventListener('click',()=>chooseAccount('login'))
$('account-back').addEventListener('click',openAccount)
$('switch-account').addEventListener('click',async()=>{
  if(activeMatch()){write('account-message','Finish your match before switching accounts.');return}
  if(online.connection){
    try{await api('/room',{action:'leave',token:online.connection.token})}catch{}
    resetOnline()
  }
  applyProfile({})
  await refreshProfile()
  openAccount()
})
$('account-form').addEventListener('submit',async event=>{
  event.preventDefault()
  const button=$('account-submit')
  if(activeMatch()&&accountMode!=='rename'){
    write('account-message','Finish your match before changing sign-in details.')
    return
  }
  button.disabled=true
  try{
    if(accountMode==='register'&&!username)await refreshProfile()
    if(accountMode==='register'&&!username)throw new Error(profileError||'Player profile unavailable.')
    const action=accountMode
    applyProfile(await api('/account',{action,username:$('username').value,email:$('email').value,password:$('password').value,profile}))
    $('password').value=''
    openAccount()
    write('account-message',action==='register'?'Account saved. Your progress is still here.':action==='rename'?'Player name updated.':'Signed in.')
  }catch(error){write('account-message',error.message)}
  finally{button.disabled=false}
})
function resetOnline(){
  closeMatchStream()
  streamFailures=0
  streamRetry=0
  pingMs=null
  pingProbe=null
  lastPing=0
  online.connection=null
  online.seat=0
  online.matchId=null
  online.state=null
  online.ranked=false
  online.war=false
  online.rematch=false
  online.errors=0
  $('field-picker').disabled=false
  $('host').disabled=$('ranked').disabled=$('warzone').disabled=$('join-submit').disabled=false
  $('copy').hidden=true
  write('room-code','')
  write('room-message','')
  setMenu()
}
async function connect(action){
  if(online.connecting||online.connection)return
  if(!username)await refreshProfile()
  if(!username){write('room-message',profileError||'Connect to a player profile first.');return}
  online.connecting=true
  write('room-message','Connectingâ€¦')
  try{
    const result=await api('/room',{action,profile,field:currentField,look:{ship:shipStyle,goal:cosmetic},code:$('room-input').value.trim().toUpperCase()})
    setProfile(result.profile)
    clearPlayState()
    online.connection=result
    online.war=action==='warzone'
    online.ranked=action==='rank'||online.war
    menu=false
    practicing=false
    $('field-picker').disabled=true
    write('room-code',result.code||'')
    $('copy').hidden=!result.code
    write('room-message',result.code?'Share this code with your friend.':online.war?'Finding teamsâ€¦':'Looking for an opponentâ€¦')
    openMatchStream()
    await syncOnline(true)
  }catch(error){write('room-message',error.message)}
  finally{online.connecting=false}
}
function matchInput(){
  return {action:'sync',token:online.connection.token,input:inputState(),look:online.rematch?{ship:shipStyle,goal:cosmetic}:undefined,rematch:online.rematch}
}
function closeMatchStream(){
  const old=matchSocket
  matchSocket=null
  streamReady=false
  pingProbe=null
  old?.close()
}
function recordPing(elapsed){
  if(!Number.isFinite(elapsed)||elapsed<0||elapsed>5000)return
  pingMs=pingMs===null?elapsed:pingMs*.65+elapsed*.35
  pingUpdated=performance.now()
}
function openMatchStream(){
  if(typeof WebSocket==='undefined'||matchSocket||!online.connection||streamFailures>=3)return
  const url=new URL('/match-stream',location.href)
  url.protocol=location.protocol==='https:'?'wss:':'ws:'
  const connection=online.connection
  try{
    const socket=new WebSocket(url)
    matchSocket=socket
    socket.addEventListener('open',()=>{
      if(matchSocket===socket&&online.connection===connection)socket.send(JSON.stringify(matchInput()))
    })
    socket.addEventListener('message',event=>{
      if(matchSocket!==socket||online.connection!==connection)return
      let state
      try{state=JSON.parse(event.data)}catch{return}
      if(Number.isSafeInteger(state.pong)){
        if(pingProbe?.id===state.pong){
          recordPing(performance.now()-pingProbe.started)
          pingProbe=null
        }
        return
      }
      if(state.error){
        closeMatchStream()
        streamRetry=performance.now()+1000
        return
      }
      streamReady=true
      streamFailures=0
      streamLastMessage=performance.now()
      applyOnlineState(state)
    })
    socket.addEventListener('close',()=>{
      if(matchSocket!==socket)return
      closeMatchStream()
      streamFailures++
      streamRetry=performance.now()+500*2**(streamFailures-1)
    })
  }catch{
    streamFailures++
    streamRetry=performance.now()+500*2**(streamFailures-1)
  }
}
let streamLastMessage=0
function applyOnlineState(state){
  online.errors=0
  online.state=state
  if(state.notice)online.rematch=false
  if(state.result?.coins&&rewardMatch!==state.matchId){
    rewardMatch=state.matchId
    coins=state.result.balance
  }
  if(!state.game){
    if(online.rematch&&state.queued){
      online.matchId=null
      online.rematch=false
      write('room-message',online.war?'Finding teamsâ€¦':'Looking for a rivalâ€¦')
    }
    return
  }
  if(state.matchId!==online.matchId){
    clearPlayState()
    online.matchId=state.matchId
    online.seat=state.seat
    online.rematch=false
    game=state.game
    $('field-picker').value=String(game.field)
    write('room-message','You are '+(teamOf(game,state.seat)===0?'cyan. Aim for the pink goal.':'pink. Aim for the cyan goal.'))
    closeDialog('lobby-dialog')
  }else{
    if(game.phase!=='serve'&&state.game.phase==='serve'){pos=null;localPose=null}
    game=state.game
  }
  snapshotArrival=performance.now()
  if(online.rematch&&state.queued){
    online.matchId=null
    online.rematch=false
    write('room-message',online.war?'Finding teamsâ€¦':'Looking for a rivalâ€¦')
  }
}
async function syncOnline(urgent=false){
  if(!online.connection)return
  const now=performance.now()
  if(streamReady&&now-streamLastMessage>1300){
    closeMatchStream()
    streamRetry=now+750
  }
  if(!matchSocket&&now>=streamRetry)openMatchStream()
  const minimum=online.matchId&&game.phase!=='over'?(streamReady?30:45):180
  if(!urgent&&now-lastSync<minimum)return
  if(streamReady&&matchSocket?.readyState===1){
    if(matchSocket.bufferedAmount<4000){
      lastSync=now
      const data=matchInput()
      if(now-lastPing>=2000||!lastPing){
        lastPing=now
        pingProbe={id:++pingSerial,started:now}
        data.ping=pingProbe.id
      }
      matchSocket.send(JSON.stringify(data))
    }
    return
  }
  if(online.busy)return
  lastSync=now
  online.busy=true
  const connection=online.connection
  try{
    const state=await api('/room',matchInput())
    if(connection!==online.connection||streamReady)return
    recordPing(performance.now()-now)
    applyOnlineState(state)
  }catch(error){
    if(connection===online.connection&&!streamReady&&++online.errors>=7){
      resetOnline()
      write('room-message','Connection lost. Create or join another room.')
      showDialog('lobby-dialog')
    }
  }finally{online.busy=false}
}
function activeMatch(){
  return Boolean(online.matchId&&game.phase!=='over')
}
async function openLobby(){
  if(!username&&location.protocol!=='file:')await refreshProfile()
  write('selected-field',online.matchId?activeField(game).name:fields[currentField].name)
  if(profileError)write('room-message',profileError)
  $('host').disabled=$('ranked').disabled=$('warzone').disabled=$('join-submit').disabled=activeMatch()
  showDialog('lobby-dialog')
}
$('lobby').addEventListener('click',openLobby)
$('home-play').addEventListener('click',openLobby)
$('home-war').addEventListener('click',async()=>{await openLobby();await connect('warzone')})
$('home-practice').addEventListener('click',()=>startPractice())
$('home-after-match').addEventListener('click',async()=>{
  if(!practicing&&game.phase!=='over')return
  const connection=online.connection
  resetOnline()
  if(connection)try{await api('/room',{action:'leave',token:connection.token})}catch{}
  refreshProfile()
})
$('host').addEventListener('click',()=>connect('host'))
$('ranked').addEventListener('click',()=>connect('rank'))
$('warzone').addEventListener('click',()=>connect('warzone'))
$('join').addEventListener('submit',event=>{event.preventDefault();connect('join')})
$('copy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText($('room-code').textContent);write('room-message','Room code copied.')}
  catch{write('room-message','Share the room code shown above.')}
})
setInterval(syncOnline,34)

let shopPage='ship', shopBusy=false, previewRun=0
const legacyGear=['prism','gold'].flatMap(id=>['ship','effect'].map(type=>({
  id,type,name:(id==='prism'?'Prism':'Gold')+(type==='ship'?' Ship':' Burst'),
  accent:id==='prism'?'#d3a5ff':'#ffd182'
})))
function itemOwned(item){
  return item.id==='classic'||safeCosmetic(item.type,item.id)===item.id
}
function updateShop(){
  write('shop-coins',coins.toLocaleString()+' coins')
  write('shop-diamonds',diamonds.toLocaleString()+' diamonds')
  if(!$('shop-dialog').open)return
  const list=$('shop-items')
  const run=++previewRun
  list.replaceChildren()
  const entries=shopPage==='diamonds'?diamondPacks:
    [...catalog,...(ownsPack?legacyGear:[])].filter(item=>item.type===shopPage&&(!item.retired||itemOwned(item)))
  for(const item of entries){
    if(item.type==='ship'){list.append(shipCard(item,run));continue}
    const button=document.createElement('button')
    button.className='market-item'
    button.type='button'
    button.disabled=shopBusy
    button.setAttribute('aria-pressed',String(selectedPreview?.id===item.id))
    const art=document.createElement('canvas')
    art.width=140
    art.height=78
    art.setAttribute('aria-hidden','true')
    const g=art.getContext('2d')
    const name=document.createElement('strong')
    const detail=document.createElement('small')
    if(shopPage==='diamonds'){
      name.textContent=item.amount+' diamonds'
      detail.textContent=item.price+' coins'
      drawDiamond(g,item.amount)
    }else{
      name.textContent=item.name
      const equipped=item.id===cosmetic
      detail.textContent=equipped?'Equipped':itemOwned(item)?item.price?'Owned':'Starter':item.price+' '+item.currency
      drawEffect(g,item.id,70,39,.35)
    }
    button.append(art,name,detail)
    button.addEventListener('click',()=>{
      selectedPreview=item
      write('shop-message','')
      updateShop()
      $('shop-preview').scrollIntoView({block:'nearest'})
      $('shop-action').focus({preventScroll:true})
    })
    list.append(button)
  }
  const item=selectedPreview
  $('shop-preview').hidden=shopPage==='ship'||!item
  if($('shop-preview').hidden)return
  const exchange=shopPage==='diamonds'
  const owned=!exchange&&itemOwned(item)
  const equipped=owned&&item.id===(item.type==='ship'?shipStyle:cosmetic)
  const currency=item.currency||'coins'
  write('preview-name',exchange?'Exchange for '+item.amount+' diamonds':item.name)
  write('preview-stats',exchange?'Add diamonds to your wallet.':'Plays after a goal.')
  write('shop-action',equipped?'Equipped':owned?'Equip':(exchange?'Exchange':'Unlock')+' Â· '+item.price+' '+currency)
  $('shop-action').disabled=shopBusy||equipped||!owned&&(!username||(currency==='coins'?coins:diamonds)<item.price)
  const g=$('preview').getContext('2d')
  if(item.type==='effect'){
    const start=performance.now()
    function animate(now){
      if(run!==previewRun||!$('shop-dialog').open)return
      const age=Math.min(.72,(now-start)/1000)
      g.clearRect(0,0,320,84)
      drawEffect(g,item.id,160,42,age)
      if(age<.72)requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
  }else{
    g.clearRect(0,0,320,84)
    g.save();g.translate(90,3);drawDiamond(g,item.amount);g.restore()
  }
}
function shipCard(item,run){
  const active=selectedPreview?.id===item.id
  const owned=itemOwned(item)
  const equipped=shipStyle===item.id
  const card=document.createElement('div')
  card.className='market-item market-ship-card'
  card.dataset.selected=String(active)
  const select=document.createElement('button')
  select.type='button'
  select.className='ship-select'
  select.setAttribute('aria-pressed',String(active))
  select.setAttribute('aria-label','Preview '+item.name)
  const art=document.createElement('canvas')
  art.className='market-ship-art'
  art.width=art.height=240
  art.setAttribute('aria-hidden','true')
  const g=art.getContext('2d')
  function paint(angle){
    g.clearRect(0,0,240,240)
    drawShip(g,120,120,item.accent,item.id,angle,7.8)
  }
  paint(0)
  if(active){
    const start=performance.now()
    function spin(now){
      if(run!==previewRun||!$('shop-dialog').open)return
      paint((now-start)*.0017)
      requestAnimationFrame(spin)
    }
    requestAnimationFrame(spin)
  }
  const name=document.createElement('strong')
  name.textContent=item.name
  const detail=document.createElement('small')
  detail.textContent=equipped?'Equipped':owned?'Owned':item.price+' coins'
  const stats=document.createElement('small')
  const {range,push,pull}=shipMagnet(item.id)
  stats.textContent='Range '+range+' · Push '+push+' · Pull '+pull
  select.append(art,name,detail,stats)
  const action=document.createElement('button')
  action.type='button'
  action.className='ship-action primary'
  action.textContent=equipped?'Equipped':owned?'Equip':'Buy · '+item.price+' coins'
  action.disabled=shopBusy||equipped
  action.setAttribute('aria-label',action.textContent+' — '+item.name)
  select.addEventListener('click',()=>{
    if(active)return
    selectedPreview=item
    write('shop-message','')
    const index=Array.from($('shop-items').children).indexOf(card)
    updateShop()
    $('shop-items').children[index]?.firstElementChild?.focus({preventScroll:true})
  })
  action.addEventListener('click',()=>{
    if(action.disabled)return
    selectedPreview=item
    shopAction(item)
  })
  const trial=document.createElement('button')
  trial.type='button'
  trial.className='ship-trial'
  trial.textContent='Try it in practice match'
  trial.setAttribute('aria-label','Try '+item.name+' in a practice match')
  trial.disabled=shopBusy||Boolean(online.connection&&(!online.matchId||activeMatch()))
  trial.addEventListener('click',()=>tryShip(item.id))
  card.append(select,trial,action)
  return card
}
function tryShip(style){
  if(online.connection&&(!online.matchId||activeMatch()))return
  closeDialog('shop-dialog')
  if(online.connection){
    const token=online.connection.token
    resetOnline()
    api('/room',{action:'leave',token}).catch(()=>{})
  }
  startPractice(style)
}
let exchangeOffer=null
function offerCoins(item){
  if(!username){write('shop-message','Connect to your player profile to buy ships.');return}
  const packs=Math.ceil((item.price-coins)/coinExchange.coins)
  const cost=packs*coinExchange.diamonds
  const amount=packs*coinExchange.coins
  exchangeOffer={packs,profile}
  write('coin-offer-text','Trade '+cost+' diamonds for '+amount+' Arena Coins?')
  write('coin-offer-status',diamonds<cost?'You have '+diamonds+' diamonds.':'')
  $('coin-offer-yes').hidden=diamonds<cost
  $('coin-offer-yes').disabled=diamonds<cost
  $('coin-offer-pack').hidden=diamonds>=cost
  $('coin-offer-more').hidden=diamonds>=cost
  showDialog('coin-offer')
}
$('coin-offer-more').addEventListener('click',()=>{
  write('coin-offer-status','Diamond checkout is coming soon. Prices may change before launch.')
})
$('coin-offer-no').addEventListener('click',()=>closeDialog('coin-offer'))
$('coin-offer').addEventListener('close',()=>{
  exchangeOffer=null
  const card=$('shop-items').querySelector('[data-selected="true"] .ship-action')
  card?.focus({preventScroll:true})
})
$('coin-offer-yes').addEventListener('click',async()=>{
  if(shopBusy||!exchangeOffer||exchangeOffer.profile!==profile)return
  const {packs}=exchangeOffer
  shopBusy=true
  $('coin-offer-yes').disabled=true
  $('coin-offer-no').disabled=true
  try{
    applyProfile(await api('/redeem',{profile,gear:'exchange-coins',packs}))
    closeDialog('coin-offer')
    write('shop-message',packs*coinExchange.coins+' coins added. Click Buy to purchase the ship.')
  }catch(error){
    write('coin-offer-status',error.message)
    $('coin-offer-yes').disabled=false
  }finally{
    shopBusy=false
    $('coin-offer-no').disabled=false
    updateShop()
  }
})
function drawEffect(g,style,x,y,age){
  for(const particle of effectParticles(style)){
    g.fillStyle=particle.color
    g.globalAlpha=Math.max(.08,1-age/particle.life)
    g.beginPath()
    g.arc(x+particle.vx*age,y+particle.vy*age*.7,particle.radius,0,Math.PI*2)
    g.fill()
  }
  g.globalAlpha=1
}
function drawDiamond(g,amount){
  g.fillStyle=amount>30?'#d7aaff':'#91f0ff'
  g.beginPath()
  g.moveTo(70,13);g.lineTo(95,30);g.lineTo(70,65);g.lineTo(45,30);g.closePath();g.fill()
  g.fillStyle='#496aab'
  g.beginPath()
  g.moveTo(45,30);g.lineTo(95,30);g.lineTo(70,65);g.closePath();g.fill()
}
function setShopPage(page){
  shopPage=page
  selectedPreview=null
  for(const tab of document.querySelectorAll('[data-market]'))tab.setAttribute('aria-pressed',String(tab.dataset.market===page))
  write('shop-heading',page==='ship'?'Ships':page==='effect'?'Goal effects':'Diamond exchange')
  write('shop-description',page==='ship'?'Compare magnet range and push and pull power.':
    page==='effect'?'Preview the celebration that plays when you score.':'Trade Arena Coins for diamonds.')
  write('shop-message','')
  updateShop()
}
function showShop(page='ship'){
  showDialog('shop-dialog')
  setShopPage(page)
}
$('shop').addEventListener('click',()=>showShop())
$('result-shop').addEventListener('click',()=>showShop())
$('featured-pack').addEventListener('click',()=>showShop('diamonds'))
for(const tab of document.querySelectorAll('[data-market]'))tab.addEventListener('click',()=>setShopPage(tab.dataset.market))
$('shop-action').addEventListener('click',()=>shopAction(selectedPreview))
async function shopAction(item){
  if(!item||shopBusy)return
  if(item.type&&itemOwned(item)){
    if(item.type==='ship'){shipStyle=item.id;saved('ship-style',shipStyle)}
    else{cosmetic=item.id;saved('cosmetic',cosmetic)}
    write('shop-message',item.name+' equipped for your next match.')
    updateShop()
    return
  }
  if(item.type==='ship'&&(!username||coins<item.price)){offerCoins(item);return}
  shopBusy=true
  updateShop()
  try{
    applyProfile(await api('/redeem',{profile,gear:item.id}))
    write('shop-message',item.type?item.name+' unlocked. Select Equip to use it.':item.amount+' diamonds added.')
  }catch(error){write('shop-message',error.message)}
  finally{shopBusy=false;updateShop()}
}
setMenu()
requestAnimationFrame(frame)
refreshProfile()



