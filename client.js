'use strict'
const {W,H,wall,cornerRadius,goal,catalog,trails,diamondPacks,coinExchange,ownedStyle,shipMagnet,botLoadout,fields,createGame,activeField,distance,step,stepSeconds,steerPlayer,separate,clamp,teamOf}=MagnetEngine
const $=id=>document.getElementById(id)
const canvas=$('field'),ctx=canvas.getContext('2d')
const held=new Set()
const online={connection:null,seat:0,busy:false,errors:0,rematch:false}
const themeColors={classic:['#67f7ff','#ff72b3','#fff1a0'],prism:['#ff8370','#ffe676','#68ffd9','#79b8ff','#e78aff'],gold:['#fff1b0','#ffb84c','#fb8233'],comet:['#efffff','#7aeeff','#7296ff']}
let game=createGame({mode:'online'}), menu=true, pointer=null, shot=null, shotSerial=0
let previousHit='', previousEvent='', previousOverlay='', currentField=0, bursts=[], audio=null
const coinPrices={ice:90,comet:150}
let coins=0,diamonds=0,gear=[],refillDeadline=null,diamondDeadline=null,claimBusy=false,nextProfileRetry=0
let practicing=false,practiceBank=0,practiceShip=null,practiceEffect=null,practiceTrail=null
let cosmetic='classic', shipStyle='classic', trailStyle='classic', selectedPreview=null, ownsPack=false, profile=null, username=null, accountMode=null, cachedStatus=''
let blockedCount=0
let socialMode=null,boardOffset=0,lastPresence=0,medalQueue=[],medalMatch=null
let guestMode=true, accountEmail=null, profileRequest=null, profileError=''
let pos=null, frameTime=performance.now(), snapshotArrival=0, lastHud=0, lastSync=0
let goalArt=null
let shipTracks=[]
const trailStyles=new Map(trails.map(item=>[item.id,item]))
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
let ageConfirmed=saved('online-age-confirmed')==='yes', pendingOnlineAction=null
const pagePath=location.pathname||'/'
let soundEnabled=true
function updateSoundControl(){
  write('sound',soundEnabled?'Sound off':'Sound on')
  $('sound').setAttribute('aria-pressed',String(!soundEnabled))
}
updateSoundControl()
$('sound').addEventListener('click',()=>{
  soundEnabled=!soundEnabled
  updateSoundControl()
  if(soundEnabled)unlockSound()
  else stopMatchMusic()
})
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
  previousHit=''
  previousOverlay=''
  bursts=[]
  pos=null
  localPose=null
  snapshotArrival=0
  cachedStatus=''
  goalArt=null
  shipTracks=[]
}
function setMenu(){
  practicing=false
  practiceShip=null
  practiceEffect=null
  practiceTrail=null
  practiceBank=0
  clearPlayState()
  menu=true
  game=createGame({mode:'online',field:currentField})
  cachedStatus='First to 3'
  renderHud()
}
function startPractice(style=shipStyle,effect=cosmetic,trail=trailStyle){
  unlockSound()
  clearPlayState()
  practicing=true
  practiceShip=style
  practiceEffect=effect
  practiceTrail=trail
  practiceBank=0
  menu=false
  game=createGame({mode:'bot',difficulty:'training',field:currentField,
    rival:{look:botLoadout([{ship:style,goal:effect}]),speed:0,offset:0,reaction:0}})
  game.craft[0].magnet=shipMagnet(practiceShip)
  renderHud()
}
function goReplay(){
  if(practicing){startPractice(practiceShip,practiceEffect,practiceTrail);return}
  if(menu){openLobby();return}
  if(online.connection&&!online.ranked){
    const connection=online.connection
    api('/room',{action:'leave',token:connection.token}).then(()=>{resetOnline();openLobby()}).catch(error=>{
      if(online.state)online.state.notice=error.message
      renderHud()
    })
    return
  }
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
function unlockSound(){
  if(!soundEnabled)return
  try{
    const Audio=window.AudioContext||window.webkitAudioContext
    if(!Audio)return
    audio??=new Audio()
    if(audio.state==='suspended')audio.resume().catch(()=>{})
  }catch{}
}

// Original four-bar synth loop. All voices are synthesized in the browser.
const arcadeScore=[
  {root:38,chord:[62,65,69],riff:[74,0,77,81,0,77,72,0]},
  {root:34,chord:[58,62,65],riff:[70,0,74,77,0,74,69,0]},
  {root:41,chord:[60,65,69],riff:[72,0,77,81,0,84,77,0]},
  {root:36,chord:[60,64,67],riff:[76,0,79,0,72,76,71,0]}
]
const beatStep=60/126/4
let music=null
function stopMatchMusic(){
  if(!music)return
  music.output.disconnect()
  music=null
}
function musicVoice(time,duration,hz,level,type,endHz=hz){
  const voice=audio.createOscillator(), envelope=audio.createGain()
  voice.type=type
  voice.frequency.setValueAtTime(hz,time)
  voice.frequency.exponentialRampToValueAtTime(endHz,time+duration)
  envelope.gain.setValueAtTime(.0001,time)
  envelope.gain.exponentialRampToValueAtTime(level,time+.009)
  envelope.gain.exponentialRampToValueAtTime(level*.52,time+duration*.65)
  envelope.gain.exponentialRampToValueAtTime(.0001,time+duration)
  voice.connect(envelope).connect(music.output)
  voice.start(time)
  voice.stop(time+duration)
}
function syncMatchMusic(){
  const live=soundEnabled&&audio?.state==='running'&&!menu&&!document.hidden&&
    (practicing||Boolean(online.matchId))&&game.phase!=='over'
  if(!live){stopMatchMusic();return}
  if(!music){
    const output=audio.createGain()
    output.gain.value=.55
    output.connect(audio.destination)
    music={output,next:audio.currentTime+.025,step:0}
  }
  const now=audio.currentTime
  if(music.next<now)music.next=now+.015
  const hz=note=>440*2**((note-69)/12)
  while(music.next<now+.12){
    const step=music.step%16
    const bar=arcadeScore[Math.floor(music.step/16)%arcadeScore.length]
    const time=music.next
    if(step%4===0)musicVoice(time,.14,145,.24,'sine',52)
    if(step%2===1)musicVoice(time,.045,4200,.065,'triangle',2700)
    if(step%4===0||step%4===2||step===15)musicVoice(time,.22,hz(bar.root+12+(step===15?7:0)),.20,'triangle')
    if(step===0||step===8)bar.chord.forEach((note,i)=>musicVoice(time+i*.016,.85,hz(note),.09,'sine'))
    const lead=step%2===0?bar.riff[step/2]:0
    if(lead)musicVoice(time,.24,hz(lead),.24,'triangle')
    music.next+=beatStep
    music.step++
  }
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopMatchMusic()})
function beep(freq,duration,type='sine',volume=.08,endFreq=freq){
  if(!soundEnabled||!audio||audio.state!=='running')return
  const osc=audio.createOscillator(),gain=audio.createGain(),now=audio.currentTime
  osc.type=type;osc.frequency.setValueAtTime(freq,now)
  if(endFreq!==freq)osc.frequency.exponentialRampToValueAtTime(endFreq,now+duration)
  gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration)
  osc.connect(gain).connect(audio.destination);osc.start(now);osc.stop(now+duration)
}
function impactSound(freq,endFreq){
  if(music&&audio?.state==='running'){
    const gain=music.output.gain,now=audio.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(.31,now)
    gain.linearRampToValueAtTime(.55,now+.15)
  }
  beep(freq,.095,'triangle',.28,endFreq)
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
  goalArt={x,y,theme,age:0}
  bursts.push(...effectParticles(theme).map(particle=>({...particle,x,y})))
}
function renderEvent(){
  const hitKey=game.hit&&(online.matchId||'local')+':'+game.hit.id
  if(hitKey&&hitKey!==previousHit){
    previousHit=hitKey
    impactSound(710,240)
  }
  const event=game.event
  const key=(online.matchId||'local')+':'+event.id
  if(previousEvent===key||!event.id)return
  previousEvent=key
  const ours=event.seat===(event.kind==='goal'?teamOf(game,online.seat):online.seat)
  if(event.kind==='goal'){
    celebrate(180,event.seat===0?24:H-24,online.state?.looks?.[event.scorer??(game.mode==='warzone'?-1:event.seat)]?.goal||(!online.connection?(ours?(practiceEffect||cosmetic):game.rival?.look?.goal||'classic'):'classic'))
    beep(ours?660:175,.36,'triangle')
    cachedStatus=ours?'Goal!':'Opponent scores'
  }
  if(event.kind==='push'||event.kind==='pull'){
    if(event.kind==='push')impactSound(540,175)
    else impactSound(340,590)
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
  $('message').hidden=!message
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
  for(const [id,deadline] of [['claim-coins',refillDeadline],['claim-diamonds',diamondDeadline]]){
    const remaining=deadline===null?null:Math.max(0,Math.ceil((deadline-performance.now())/1000))
    $(id).disabled=claimBusy||remaining!==0
    const clock=remaining===null?'Play online to unlock':remaining===0?'Collect':
      [Math.floor(remaining/3600),Math.floor(remaining/60)%60,remaining%60].map(value=>String(value).padStart(2,'0')).join(':')
    write(id,clock)
  }
  $('game-root').dataset.match=String(!menu)
  write('home-player',username||(profileError?'Profile unavailable':!profile&&!ageConfirmed?'Online play is 13+':'Loading profile…'))
  $('home-view').hidden=!menu
  $('match-view').hidden=menu
  const solo=game.mode==='practice'||game.mode==='circuit'
  const seat=online.seat
  const names=online.state?.names
  const war=game.mode==='warzone'
  const ownTeam=teamOf(game,seat)
  const bots=online.state?.bots||[]
  $('report-name').hidden=!online.matchId||!bots.some((bot,seat)=>!bot&&seat!==online.seat)
  const tags=war?[ownTeam===0?'CYAN (YOU)':'CYAN',ownTeam===1?'PINK (YOU)':'PINK']:names||[username||'YOU',practicing?'Practice':'']
  write('score0',solo?(game.mode==='circuit'?'STAGE '+Math.min(game.stage+1,4)+'/4':'PRACTICE'):tags[0]+' '+game.score[0])
  write('score1',solo?game.elapsed.toFixed(1)+'s':(game.score[1]+' '+tags[1]).trim())
  const clock=Math.ceil(game.clock)
  const clockText=Math.floor(clock/60)+':'+String(clock%60).padStart(2,'0')
  write('status',menu?'First to 3':online.connection&&!online.matchId?(online.war?'Finding teams…':'Looking for an opponent…'):
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
  write('ping-display',freshPing?'Ping '+Math.round(pingMs)+' ms':'Ping —')
  ping.dataset.quality=!freshPing?'unknown':pingMs>=150?'poor':pingMs>=80?'fair':'good'
  $('overlay').hidden=!overlay
  $('match-stage').dataset.overlay=String(overlay)
  $('leave-match').hidden=menu||!online.connection||game.phase==='over'&&Boolean(online.matchId)
  const series=online.state?.series
  $('series-score').hidden=!series||series[0]+series[1]<1||game.phase==='over'
  if(series)write('series-score','Rematch '+series[online.seat]+'/'+series[1-online.seat])
  const duel=$('duel-rematch')
  const offer=online.state?.duelOffer
  duel.hidden=game.phase!=='over'||!online.state?.duel
  duel.disabled=offer===online.seat
  write('duel-rematch',offer===undefined?'Rematch':offer===online.seat?'Waiting for opponent':'Accept rematch')
  $('opponent-profile').hidden=game.phase!=='over'||!online.state?.opponent
  $('add-opponent').hidden=$('opponent-profile').hidden
  $('match-departure').hidden=!online.state?.departure
  write('match-departure',online.state?.departure||'')
  $('home-after-match').hidden=menu||!practicing&&game.phase!=='over'
  if(menu){
    showOverlay(fields[currentField].name,'','Play online',false)
  }else if(online.connection&&!online.matchId){
    showOverlay(online.war?'Finding teams':online.ranked?'Looking for an opponent':'Waiting for friend',
      online.war?'Building two teams of five. Your match will start in a few seconds.':online.ranked?'Your match should start in a few seconds.':'Open Online to see your room code.',null,false)
  }else if(game.phase==='over'){
    let title=solo?(game.mode==='circuit'?'Circuit cleared!':'Course cleared!'):
      war?(game.winner===ownTeam?'Your team wins!':'Other team wins'):game.winner===seat?'You win!':'Opponent wins'
    let message=solo?game.elapsed.toFixed(1)+' seconds · '+(game.mode==='circuit'?'4 courses':activeField(game).name):game.score.join(' – ')
    if(online.state?.result?.coins){
      const change=online.state.result.coins
      message+=' · '+(change>0?'+':'')+change+' Arena Coins'
    }
    if(online.state?.result?.entry&&!online.state.result.coins)message+=' · '+online.state.result.entry+' Arena Coins entry'
    if(online.state?.duelMessage)message+=' · '+online.state.duelMessage
    if(online.state?.duelOffer!==undefined&&online.state.duelOffer!==online.seat)message+=' · You have a rematch challenge.'
    if(online.state?.notice)message+=' · '+online.state.notice
    if(online.state?.result?.reason==='forfeit')message+=' · Opponent disconnected'
    if(online.state?.result?.delta)message+=' · '+(online.state.result.delta>0?'+':'')+online.state.result.delta+' rating'
    const replay=online.rematch?'Waiting for rival':online.war?'Play War Zone again':online.connection?'Find another match':'Play again'
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
const effectArtSlots=new Map(catalog.filter(item=>item.type==='effect'&&!item.retired)
  .map((item,index)=>[item.id,index]))
effectArtSlots.set('effect-9',9)
effectArtSlots.set('prism',11)
effectArtSlots.set('gold',19)
const effectArt=typeof Image==='function'?new Image():null
if(effectArt){
  effectArt.addEventListener('load',()=>updateShop())
  effectArt.src='effect-art.webp'
}
function drawEffectArt(g,style,x,y,size,age){
  if(!effectArt?.naturalWidth)return
  const slot=effectArtSlots.get(style)??0
  const width=size*(.35+.65*Math.min(1,age*3.5))
  g.save()
  g.globalAlpha=Math.max(0,Math.min(1,age*12,(1-age)*4))
  g.drawImage(effectArt,slot%5*144,Math.floor(slot/5)*144,144,144,x-width/2,y-width/2,width,width)
  g.restore()
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
function paintTrail(g,style,points,now,color,scale=1){
  const hue=style.accent||color
  const pattern=style.pattern
  g.save()
  g.lineCap='round'
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i]
    const life=Math.max(0,1-(now-b.time)/.32)
    if(!life)continue
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1
    const nx=-dy/length,ny=dx/length
    const strokePart=(offset,width,tint,next=offset)=>{
      g.strokeStyle=tint
      g.lineWidth=width*scale
      g.beginPath()
      g.moveTo(a.x+nx*offset,a.y+ny*offset)
      g.lineTo(b.x+nx*next,b.y+ny*next)
      g.stroke()
    }
    const mark=(shape,offset,radius,tint,outline=false)=>{
      g.save()
      g.translate(b.x+nx*offset,b.y+ny*offset)
      g.rotate(Math.atan2(dy,dx))
      g.fillStyle=g.strokeStyle=tint
      g.lineWidth=1.15*scale
      g.beginPath()
      const size=radius*scale
      if(shape==='circle')g.arc(0,0,size,0,Math.PI*2)
      else if(shape==='petal')g.ellipse(0,0,size,size*.45,.7,0,Math.PI*2)
      else{
        const vertices=shape==='star'?8:shape==='chevron'?3:4
        for(let k=0;k<vertices;k++){
          const angle=k*Math.PI*2/vertices
          const r=shape==='star'&&k%2?size*.28:size
          if(k)g.lineTo(Math.cos(angle)*r,Math.sin(angle)*r)
          else g.moveTo(Math.cos(angle)*r,Math.sin(angle)*r)
        }
        if(shape!=='chevron')g.closePath()
      }
      if(outline)g.stroke()
      else g.fill()
      g.restore()
    }
    const phase=b.time*32
    const before=a.time*32
    const side=i%2?1:-1
    const pulse=Math.sin(phase)
    const beforePulse=Math.sin(before)
    g.globalAlpha=life*.78
    switch(pattern){
      case 'ribbon': strokePart(0,3.5*life,hue);break
      case 'sparks': if(i%2===0)strokePart((i%4===0?1:-1)*4*scale,2,hue);break
      case 'twin':
        strokePart(-3*scale,2,hue);strokePart(3*scale,2,'#a491ff');break
      case 'pixels': if(i%2===0)mark('diamond',(i%4===0?1:-1)*5*scale,3.1,hue);break
      case 'shards': if(i%2)mark('diamond',side*(i%3+2)*scale,4.8,i%3?hue:'#fff');break
      case 'comet':
        g.globalAlpha=life*.23;strokePart(0,9,hue)
        g.globalAlpha=life*.75;strokePart(0,3.7,'#fff0b5');break
      case 'bubbles': if(i%3!==0)mark('circle',side*5*scale,2.5+i%4,hue,true);break
      case 'chevrons': if(i%3===0)mark('chevron',0,5.5,hue,true);break
      case 'rings': if(i%3===0)mark('circle',0,3+life*5,hue,true);break
      case 'smoke':
        g.globalAlpha=life*.22;mark('circle',pulse*3*scale,5+(1-life)*6,hue);break
      case 'lightning':
        strokePart(-side*4*scale,2,hue,side*4*scale)
        if(i%4===0)strokePart(0,1,'#fff',side*8*scale);break
      case 'petals': if(i%2)mark('petal',Math.sin(i*2)*8*scale,4.8,hue);break
      case 'wave': strokePart(beforePulse*6*scale,2.8,hue,pulse*6*scale);break
      case 'prism': strokePart(beforePulse*3*scale,2.8,'hsl('+((b.time*400)%360)+' 100% 72%)',pulse*3*scale);break
      case 'aurora':
        g.globalAlpha=life*.35
        strokePart(beforePulse*5*scale,8,hue,pulse*5*scale)
        strokePart(-beforePulse*5*scale,5,'#99a5ff',-pulse*5*scale);break
      case 'stars':
        g.globalAlpha=life*.28;strokePart(0,1,hue)
        g.globalAlpha=life*.9;if(i%3===0)mark('star',pulse*7*scale,5,hue);break
      case 'helix':
        strokePart(beforePulse*7*scale,2.5,hue,pulse*7*scale)
        strokePart(-beforePulse*7*scale,2.5,'#71fff2',-pulse*7*scale);break
      case 'inferno':
        g.globalAlpha=life*.28;strokePart(0,10,hue)
        g.globalAlpha=life*.9;strokePart(0,2.8,'#ffe674')
        if(i%2===0)mark('diamond',pulse*7*scale,3.7,'#ff9c4c');break
      case 'orbit':
        if(i%3===0)mark('circle',pulse*5*scale,6,hue,true)
        if(i%2)mark('diamond',pulse*10*scale,2.7,'#fff');break
      case 'nova':
        g.globalAlpha=life*.33;strokePart(0,11,'#ae7dff')
        g.globalAlpha=life*.93;strokePart(0,2.4,hue)
        if(i%2===0)mark('star',pulse*8*scale,4.6,i%4?hue:'#fff');break
    }
  }
  g.restore()
}
function drawShipTrails(count,now){
  if(menu||game.phase!=='play'){shipTracks=[];return}
  for(let seat=0;seat<count;seat++){
    if(game.craft[seat].inactive){shipTracks[seat]=[];continue}
    const ship=pos[seat]
    let track=shipTracks[seat]??=[]
    const last=track.at(-1)
    const gap=last?distance(last,ship):0
    if(gap>75){track=[];shipTracks[seat]=track}
    if(!track.length||gap>=2.5&&now-last.time>=.013)track.push({x:ship.x,y:ship.y,time:now})
    while(track.length>1&&(now-track[0].time>.34||track.length>24))track.shift()
    const selected=online.state?.looks?.[seat]?.trail||
      (seat===online.seat?(practicing?practiceTrail:trailStyle):'classic')
    paintTrail(ctx,trailStyles.get(selected)||trails[0],track,now,game.craft[seat].color)
  }
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
  const visibleShips=solo?1:game.craft.length
  drawShipTrails(visibleShips,performance.now()/1000)
  for(let seat=0;seat<visibleShips;seat++){
    if(game.craft[seat].inactive)continue
    const ship=pos[seat], shipColor=game.craft[seat].color
    const rotation=menu?0:performance.now()*.0017+seat*.35
    if(seat===online.seat&&game.mode==='warzone')ring(ship.x,ship.y,18,'#f4fff9',2)
    drawShip(ctx,ship.x,ship.y,shipColor,online.state?.looks?.[seat]?.ship||(seat===online.seat?(practicing?practiceShip:shipStyle):game.rival?.look?.ship||'classic'),rotation)
  }
  disc(puck.x,puck.y,11,'#ffdb753a')
  disc(puck.x,puck.y,8,'#ffe382')
  if(goalArt){
    goalArt.age+=dt
    drawEffectArt(ctx,goalArt.theme,goalArt.x,clamp(goalArt.y,58,H-58),126,goalArt.age)
    if(goalArt.age>=1)goalArt=null
  }
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
  if(pointer&&(game.phase==='over'||pointer.active===false&&now>=pointer.until))pointer=null
  if(practicing&&!anyDialog()){
    const input=inputState()
    const previousPhase=game.phase
    practiceBank+=dt
    while(practiceBank>=stepSeconds){step(game,[input]);practiceBank-=stepSeconds}
    if(previousPhase!=='play'&&game.phase==='play')rebasePointer()
  }
  if(menu&&!username&&(profile||ageConfirmed)&&!profileRequest&&now>=nextProfileRetry&&
    pagePath==='/'&&location.protocol!=='file:'){
    nextProfileRetry=now+12000
    refreshProfile()
  }
  if(username&&now-lastPresence>25000){
    lastPresence=now
    if($('social-dialog').open&&socialMode==='friends')loadSocial('friends')
    else api('/social',{action:'presence',profile}).then(state=>{
      write('open-friends',state.invite?'Friends · Invite':'Friends')
    }).catch(()=>{})
  }
  syncMatchMusic()
  renderEvent()
  if(!menu)draw(dt)
  if(now-lastHud>=70){lastHud=now;renderHud()}
  requestAnimationFrame(frame)
}
$('match-view').addEventListener('contextmenu',event=>event.preventDefault())
$('match-view').addEventListener('selectstart',event=>event.preventDefault())
$('match-view').addEventListener('dblclick',event=>event.preventDefault())
function blockMatchZoom(event){
  if(event.cancelable)event.preventDefault()
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
function rebasePointer(){
  if(!pointer?.active||!pointer.relative)return
  const craft=game.craft[online.seat]
  Object.assign(pointer,{originX:craft.x,originY:craft.y,x:craft.x,y:craft.y,startX:pointer.lastX,startY:pointer.lastY})
}
function movePointer(event){
  pointer.lastX=event.clientX
  pointer.lastY=event.clientY
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
  if(event.button!==0||menu||game.phase==='over'&&!online.connection||pointer?.active||anyDialog())return
  if(event.target.closest('button, a, input, select')||online.matchId&&game.phase==='over')return
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

for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>closeDialog(button.dataset.close))

async function api(route,data){
  if(location.protocol==='file:')throw new Error('Online play is unavailable in this copy.')
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),route==='/account'?18000:6500)
  try{
    const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal})
      .catch(()=>{throw new Error('Connection lost. Try again.')})
    const body=await response.json().catch(()=>{throw new Error('PuckVolt is temporarily unavailable. Try again.')})
    if(body.error)throw new Error(body.error)
    if(!response.ok)throw new Error('PuckVolt is temporarily unavailable. Try again.')
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
    blockedCount=0
    coins=0
    diamonds=0
    gear=[]
    refillDeadline=null
    diamondDeadline=null
    ownsPack=false
    cosmetic='classic'
    shipStyle='classic'
    trailStyle='classic'
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
  blockedCount=data.blockedCount||0
  coins=data.coins||0
  diamonds=data.diamonds||0
  diamondDeadline=Number.isFinite(data.diamondRefillIn)?performance.now()+data.diamondRefillIn:null
  refillDeadline=Number.isFinite(data.refillIn)?performance.now()+data.refillIn:null
  gear=data.gear||[]
  ownsPack=data.ownsPack
  cosmetic=safeCosmetic('effect',saved('cosmetic'))
  shipStyle=safeCosmetic('ship',saved('ship-style'))
  trailStyle=safeCosmetic('trail',saved('trail-style'))
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
  nextProfileRetry=performance.now()+12000
  if(location.protocol==='file:'||pagePath==='/account-deletion'&&!profile||!profile&&!ageConfirmed)return
  if(profileRequest)return profileRequest
  profileRequest=(async()=>{
    try{
      const savedGuest=saved('guest-profile')
      const data=await api('/account',{action:'bootstrap',profile:profile||savedGuest,device:ageConfirmed?guestDevice():saved('guest-device'),ageConfirmed})
      profileError=''
      if(data.ageRequired){
        saved('guest-profile','')
        saved('guest-device','')
        applyProfile({})
        return
      }
      applyProfile(data)
    }catch(error){
      profileError=error.message||'Could not connect to your player profile.'
    }finally{profileRequest=null}
  })()
  return profileRequest
}
function updateAccountCard(){
  write('account-summary',username||'Connecting to your profile…')
  write('account-kind',username?(guestMode?'Guest on this browser':accountEmail||'Signed-in player'):'')
  $('delete-account').disabled=!username
  $('clear-blocks').hidden=!blockedCount
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
    applyProfile(await api('/account',{action,username:$('username').value,email:$('email').value,password:$('password').value,profile,ageConfirmed}))
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
  unlockSound()
  if(online.connecting||online.connection)return
  if(!username)await refreshProfile()
  if(!profile&&!ageConfirmed){
    pendingOnlineAction=action
    closeDialog('lobby-dialog')
    showDialog('age-gate')
    return
  }
  if(online.connecting||online.connection)return
  if(!username){write('room-message',profileError||'Open Account to continue.');return}
  online.connecting=true
  write('room-message','Connecting…')
  try{
    const result=await api('/room',{action,profile,field:currentField,look:{ship:shipStyle,goal:cosmetic,trail:trailStyle},code:$('room-input').value.trim().toUpperCase()})
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
    write('room-message',result.code?'Share this code with your friend.':online.war?'Finding teams…':'Looking for an opponent…')
    openMatchStream()
    await syncOnline(true)
  }catch(error){write('room-message',error.message)}
  finally{online.connecting=false}
}
function matchInput(){
  return {action:'sync',token:online.connection.token,input:inputState(),look:online.rematch?{ship:shipStyle,goal:cosmetic,trail:trailStyle}:undefined,rematch:online.rematch}
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
  if(Number.isFinite(state.balance))coins=state.balance
  if(state.notice)cachedStatus=state.notice
  if(state.result?.medals?.length&&medalMatch!==state.matchId){
    medalMatch=state.matchId
    medalQueue.push(...state.result.medals)
    showNextMedal()
  }
  if(!state.game){
    if(online.rematch&&state.queued){
      online.matchId=null
      online.rematch=false
      write('room-message',online.war?'Finding teams…':'Looking for an opponent…')
    }
    return
  }
  if(state.matchId!==online.matchId){
    const heldPointer=pointer?.active?pointer:null
    clearPlayState()
    pointer=heldPointer
    online.matchId=state.matchId
    online.seat=state.seat
    online.rematch=false
    game=state.game
    rebasePointer()
    $('field-picker').value=String(game.field)
    write('room-message','You are '+(teamOf(game,state.seat)===0?'cyan. Aim for the pink goal.':'pink. Aim for the cyan goal.'))
    closeDialog('lobby-dialog')
  }else{
    if(game.phase!=='serve'&&state.game.phase==='serve'){pos=null;localPose=null}
    const previousPhase=game.phase
    game=state.game
    if(previousPhase!=='play'&&game.phase==='play')rebasePointer()
  }
  snapshotArrival=performance.now()
  if(online.rematch&&state.queued){
    online.matchId=null
    online.rematch=false
    write('room-message',online.war?'Finding teams…':'Looking for an opponent…')
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
$('home-war').addEventListener('click',async()=>{unlockSound();await openLobby();await connect('warzone')})
$('home-practice').addEventListener('click',()=>startPractice())
$('home-after-match').addEventListener('click',async()=>{
  if(!practicing&&game.phase!=='over')return
  const connection=online.connection
  resetOnline()
  if(connection)try{await api('/room',{action:'leave',token:connection.token})}catch{}
  refreshProfile()
})
$('leave-match').addEventListener('click',()=>{
  write('leave-message','')
  showDialog('leave-dialog')
})
$('confirm-leave').addEventListener('click',async()=>{
  if(!online.connection)return
  $('confirm-leave').disabled=true
  try{
    await api('/room',{action:'leave',token:online.connection.token})
    closeDialog('leave-dialog')
    resetOnline()
    await refreshProfile()
  }catch(error){write('leave-message',error.message)}
  finally{$('confirm-leave').disabled=false}
})
for(const action of ['claim-coins','claim-diamonds'])$(action).addEventListener('click',async()=>{
  if(claimBusy||!profile)return
  claimBusy=true
  renderHud()
  try{
    applyProfile(await api('/account',{action,profile}))
    write('claim-message',action==='claim-coins'?'Collected 100 Arena Coins.':'Collected 20 diamonds.')
  }catch(error){write('claim-message',error.message)}
  finally{claimBusy=false;renderHud()}
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
    if(item.type){list.append(gearCard(item,run));continue}
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
    name.textContent=item.amount+' diamonds'
    detail.textContent=item.price+' coins'
    drawDiamond(g,item.amount)
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
  $('shop-preview').hidden=shopPage!=='diamonds'||!item
  if($('shop-preview').hidden)return
  write('preview-name','Exchange for '+item.amount+' diamonds')
  write('preview-stats','Add diamonds to your wallet.')
  write('shop-action','Exchange · '+item.price+' coins')
  $('shop-action').disabled=shopBusy||!username||coins<item.price
  const g=$('preview').getContext('2d')
  g.clearRect(0,0,320,84)
  g.save();g.translate(90,3);drawDiamond(g,item.amount);g.restore()
}
function gearCard(item,run){
  const ship=item.type==='ship'
  const active=selectedPreview?.id===item.id
  const owned=itemOwned(item)
  const equipped=(ship?shipStyle:item.type==='trail'?trailStyle:cosmetic)===item.id
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
    if(ship)drawShip(g,120,120,item.accent,item.id,angle,7.8)
    else if(item.type==='effect')drawEffectArt(g,item.id,120,120,228,angle)
    else{
      const head=105+68*Math.sin(angle*5)
      const points=Array.from({length:24},(_,i)=>({x:head-75+i*3.2,y:124+13*Math.sin(i*.18+angle*5),time:.19+i/80}))
      paintTrail(g,item,points,.48,item.accent||'#67f7ff',2.3)
      drawShip(g,points.at(-1).x,points.at(-1).y,'#a5f3ff',shipStyle,angle*2,2.05)
    }
  }
  paint(ship?0:.46)
  if(active){
    const start=performance.now()
    function spin(now){
      if(run!==previewRun||!$('shop-dialog').open)return
      paint(ship?(now-start)*.0017:((now-start)%1350)/1000)
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
  stats.textContent=ship?'Range '+range+' · Push '+push+' · Pull '+pull:item.type==='trail'?'Ship trail':'Goal celebration'
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
  trial.addEventListener('click',()=>tryGear(item))
  card.append(select,trial,action)
  return card
}
function tryGear(item){
  if(online.connection&&(!online.matchId||activeMatch()))return
  closeDialog('shop-dialog')
  if(online.connection){
    const token=online.connection.token
    resetOnline()
    api('/room',{action:'leave',token}).catch(()=>{})
  }
  startPractice(item.type==='ship'?item.id:shipStyle,item.type==='effect'?item.id:cosmetic,item.type==='trail'?item.id:trailStyle)
}
let exchangeOffer=null
function offerCoins(item){
  if(!username){write('shop-message','Open Account to buy gear.');return}
  const packs=Math.ceil((item.price-coins)/coinExchange.coins)
  const cost=packs*coinExchange.diamonds
  const amount=packs*coinExchange.coins
  exchangeOffer={packs,profile}
  write('coin-offer-text','Trade '+cost+' diamonds for '+amount+' Arena Coins?')
  write('coin-offer-status',diamonds<cost?'You have '+diamonds+' diamonds. Earn coins in matches or claim the hourly refill.':'')
  $('coin-offer-yes').hidden=diamonds<cost
  $('coin-offer-yes').disabled=diamonds<cost
  showDialog('coin-offer')
}
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
    write('shop-message',packs*coinExchange.coins+' coins added. Click Buy to complete your purchase.')
  }catch(error){
    write('coin-offer-status',error.message)
    $('coin-offer-yes').disabled=false
  }finally{
    shopBusy=false
    $('coin-offer-no').disabled=false
    updateShop()
  }
})
function paintDiamond(g,x,y,size){
  g.save()
  g.translate(x-size/2,y-size/2)
  g.scale(size/64,size/64)
  const facet=(color,points)=>{
    g.fillStyle=color
    g.beginPath()
    points.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y))
    g.closePath()
    g.fill()
  }
  facet('#1e72c3',[[6,20],[17,8],[47,8],[58,20],[32,58]])
  facet('#9df9ff',[[6,20],[17,8],[23,20]])
  facet('#ddfdff',[[17,8],[47,8],[41,20],[23,20]])
  facet('#70dcff',[[47,8],[58,20],[41,20]])
  facet('#4fb9fb',[[6,20],[23,20],[32,58]])
  facet('#92efff',[[23,20],[41,20],[32,58]])
  facet('#2d8ee3',[[41,20],[58,20],[32,58]])
  facet('#fff',[[20,10],[23,17],[30,20],[23,22],[20,29],[17,22],[10,20],[17,17]])
  g.restore()
}
function drawDiamond(g,amount){
  if(amount>10)paintDiamond(g,48,41,34)
  if(amount>30)paintDiamond(g,92,41,34)
  paintDiamond(g,70,39,amount>30?58:52)
}
for(const icon of document.querySelectorAll('[data-diamond]')){
  paintDiamond(icon.getContext('2d'),icon.width/2,icon.height/2,icon.width)
}
function setShopPage(page){
  shopPage=page
  selectedPreview=null
  for(const tab of document.querySelectorAll('[data-market]'))tab.setAttribute('aria-pressed',String(tab.dataset.market===page))
  write('shop-heading',page==='ship'?'Ships':page==='effect'?'Goal effects':page==='trail'?'Ship trails':'Diamond exchange')
  write('shop-description',page==='ship'?'Ship upgrades apply in practice and private matches. Ranked and War Zone use equal magnet stats.':
    page==='effect'?'Preview the celebration that plays when you score.':page==='trail'?'Preview the streak your ship leaves as it moves.':'Trade Arena Coins for diamonds.')
  write('shop-message','')
  updateShop()
}
function showShop(page='ship'){
  showDialog('shop-dialog')
  setShopPage(page)
}
$('shop').addEventListener('click',()=>showShop())
$('result-shop').addEventListener('click',async()=>{
  if(online.connection)try{await api('/room',{action:'decline-rematch',token:online.connection.token})}catch{}
  showShop()
})
$('duel-rematch').addEventListener('click',async()=>{
  if(!online.connection)return
  try{
    await api('/room',{action:'duel-rematch',token:online.connection.token})
    syncOnline(true)
  }catch(error){
    if(online.state)online.state.notice=error.message
    renderHud()
  }
})
$('featured-pack').addEventListener('click',()=>showShop('diamonds'))
for(const tab of document.querySelectorAll('[data-market]'))tab.addEventListener('click',()=>setShopPage(tab.dataset.market))
$('shop-action').addEventListener('click',()=>shopAction(selectedPreview))
async function shopAction(item){
  if(!item||shopBusy)return
  if(item.type&&itemOwned(item)){
    if(item.type==='ship'){shipStyle=item.id;saved('ship-style',shipStyle)}
    else if(item.type==='effect'){cosmetic=item.id;saved('cosmetic',cosmetic)}
    else{trailStyle=item.id;saved('trail-style',trailStyle)}
    write('shop-message',item.name+' equipped for your next match.')
    updateShop()
    return
  }
  if(item.type&&(!username||coins<item.price)){offerCoins(item);return}
  shopBusy=true
  updateShop()
  try{
    applyProfile(await api('/redeem',{profile,gear:item.id}))
    write('shop-message',item.type?item.name+' unlocked. Select Equip to use it.':item.amount+' diamonds added.')
  }catch(error){write('shop-message',error.message)}
  finally{shopBusy=false;updateShop()}
}
$('age-confirm').addEventListener('click',async()=>{
  ageConfirmed=true
  saved('online-age-confirmed','yes')
  closeDialog('age-gate')
  await refreshProfile()
  await openLobby()
  const action=pendingOnlineAction
  pendingOnlineAction=null
  if(action&&username)await connect(action)
})
$('delete-account').addEventListener('click',()=>{
  $('delete-password-label').hidden=guestMode
  $('delete-password').value=''
  write('delete-message','')
  showDialog('delete-dialog')
})
$('confirm-delete').addEventListener('click',async()=>{
  if(online.connection&&activeMatch()){write('delete-message','Finish your match and return home first.');return}
  $('confirm-delete').disabled=true
  try{
    if(online.connection){
      await api('/room',{action:'leave',token:online.connection.token})
      resetOnline()
    }
    if(profileRequest)await profileRequest
    await api('/account',{action:'delete',profile,password:$('delete-password').value})
    for(const key of ['guest-device','guest-profile','online-age-confirmed','ship-style','cosmetic','trail-style'])saved(key,'')
    ageConfirmed=false
    applyProfile({})
    $('delete-password').value=''
    closeDialog('delete-dialog')
    updateAccountCard()
    write('account-message','Your account was deleted.')
  }catch(error){write('delete-message',error.message)}
  finally{$('confirm-delete').disabled=false}
})
$('report-name').addEventListener('click',()=>{
  const choices=$('report-seat')
  choices.replaceChildren()
  for(const [seat,name] of (online.state?.names||[]).entries()){
    if(seat===online.seat||online.state.bots?.[seat])continue
    const option=document.createElement('option')
    option.value=String(seat)
    option.textContent=name
    choices.append(option)
  }
  write('report-message','')
  showDialog('report-dialog')
})
$('block-player').addEventListener('click',async()=>{
  $('block-player').disabled=true
  try{
    await api('/block-player',{token:online.connection?.token,seat:Number($('report-seat').value)})
    write('report-message','Player blocked from future matches with you.')
    await refreshProfile()
  }catch(error){write('report-message',error.message)}
  finally{$('block-player').disabled=false}
})
$('clear-blocks').addEventListener('click',async()=>{
  $('clear-blocks').disabled=true
  try{
    applyProfile(await api('/account',{action:'clear-blocks',profile}))
    updateAccountCard()
    write('account-message','Player blocks cleared.')
  }catch(error){write('account-message',error.message)}
  finally{$('clear-blocks').disabled=false}
})
$('send-report').addEventListener('click',async()=>{
  $('send-report').disabled=true
  try{
    await api('/report',{token:online.connection?.token,seat:Number($('report-seat').value)})
    write('report-message','Report submitted.')
  }catch(error){write('report-message',error.message)}
  finally{$('send-report').disabled=false}
})
function setMedalArt(element,medal){
  const column=medal.art%12
  const row=Math.floor(medal.art/12)
  element.style.backgroundPosition=(100*column/11)+'% '+(100*row/8)+'%'
}
function renderMedalCollection(catalog,medals){
  const earned=new Set(medals)
  const content=$('social-content')
  const summary=document.createElement('p')
  summary.className='medal-summary'
  summary.textContent=earned.size+' of '+catalog.length+' medals earned'
  const grid=document.createElement('ul')
  grid.className='market-grid medal-grid'
  for(const medal of catalog){
    const unlocked=earned.has(medal.id)
    const card=document.createElement('li')
    card.className='market-item medal-card'
    card.dataset.earned=String(unlocked)
    const art=document.createElement('span')
    art.className='medal-art'
    art.setAttribute('aria-hidden','true')
    setMedalArt(art,medal)
    const title=document.createElement('strong')
    title.textContent=medal.name
    const status=document.createElement('small')
    status.className='medal-status'
    status.textContent=unlocked?'Earned':'Locked'
    const requirement=document.createElement('small')
    requirement.textContent=medal.instruction
    card.append(art,title,status,requirement)
    grid.append(card)
  }
  content.append(summary,grid)
}
function showNextMedal(){
  const medal=medalQueue.shift()
  if(!medal){closeDialog('medal-dialog');return}
  write('medal-title',medal.name)
  setMedalArt($('medal-emblem'),medal)
  const messages={
    duel:'You earned this in Ranked. Keep sharpening your next shot.',
    war:'Your team made it count. Take that momentum into the next round.',
    friendly:'You earned this in a friend match. Keep the rivalry going.',
    played:'Every match adds up. Your next milestone is waiting.',
    streak:'You kept the wins coming. See how far you can take the streak.'
  }
  write('medal-message','Congratulations on '+medal.name+'! '+(messages[medal.key]||'You earned a place on the leaderboard.')+' '+medal.instruction+'.')
  showDialog('medal-dialog')
}
$('medal-dismiss').addEventListener('click',showNextMedal)
$('medal-dialog').addEventListener('click',event=>{if(event.target===$('medal-dialog'))showNextMedal()})
function socialItem(label,detail='',action='',handler=null,style=''){
  const row=document.createElement('div')
  row.className='social-row '+style
  const text=document.createElement('span')
  text.textContent=detail?label+' · '+detail:label
  row.append(text)
  if(action){
    const button=document.createElement('button')
    button.type='button'
    button.textContent=action
    button.addEventListener('click',handler)
    row.append(button)
  }
  $('social-content').append(row)
}
function statLine(data){
  const count=data?.played||0,wins=data?.wins||0
  return count+' played · '+wins+' wins · '+(count-wins)+' losses · '+(count?Math.round(wins*100/count):0)+'% wins'
}
function renderPlayerStats(player,ranks){
  socialItem(player.name,player.country||'')
  socialItem('Ranked 1v1',statLine(player.duel))
  socialItem('War Zone',statLine(player.war))
  socialItem('Friend matches',statLine(player.friendMatches))
  socialItem('Rating',String(player.rating))
  if(ranks){
    for(const [key,label] of [['lifetime','Lifetime rank'],['weekly','Weekly rank'],['monthly','Monthly rank']])
      socialItem(label,ranks[key]?'#'+ranks[key]:'Unranked')
    socialItem('Friends rank',ranks.friendly?'#'+ranks.friendly:'Add 10 friends to unlock')
  }
  socialItem('Weekly world top 10',String(player.weeklyTop))
  socialItem('Monthly world top 10',String(player.monthlyTop))
}
async function socialRequest(action,extra={}){
  return api('/social',{profile,action,...extra})
}
async function loadSocial(mode,name){
  if(!profile){write('social-message','Play online to create a player profile.');return}
  socialMode=mode
  const requestMode=mode
  write('social-message','')
  try{
    const data=mode==='board'?await socialRequest('leaderboard',{kind:$('board-period').value,region:$('board-region').value,offset:boardOffset}):
      mode==='opponent'?await socialRequest('profile',{name}):await socialRequest('summary')
    if(socialMode!==requestMode)return
    $('social-content').replaceChildren()
    $('social-filter').hidden=mode!=='board'
    $('country-form').hidden=mode!=='stats'
    if(mode==='stats'||mode==='opponent'){
      if(mode==='stats')$('country-code').value=data.player.country||''
      renderPlayerStats(data.player,data.ranks)
    }else if(mode==='medals'){
      renderMedalCollection(data.medalCatalog,data.player.medals)
    }else if(mode==='board'){
      $('board-prev').disabled=boardOffset===0
      $('board-next').disabled=!data.more
      if(!data.rows.length)socialItem('No ranked players yet')
      for(const row of data.rows)socialItem('#'+row.rank+' '+row.name,String(row.points))
    }else{
      if(data.invite)socialItem(data.invite.from+' invited you','','Join',()=>{
        $('room-input').value=data.invite.code
        closeDialog('social-dialog')
        connect('join')
      })
      for(const request of data.requests)socialItem(request,'Friend request','Accept',async()=>{
        try{await socialRequest('friend-accept',{name:request});loadSocial('friends')}
        catch(error){write('social-message',error.message)}
      })
      for(const friend of data.friends)socialItem('● '+friend.name,friend.online?'Online':'Offline',
        friend.online?'Invite':'',async()=>{
          try{
            if(online.connection&&!online.connection.code)throw new Error('Return home before inviting a friend.')
            if(!online.connection)await connect('host')
            await socialRequest('invite',{name:friend.name})
            write('social-message','Invitation sent.')
          }catch(error){write('social-message',error.message)}
        },friend.online?'social-online':'social-offline')
      if(!data.friends.length&&!data.requests.length&&!data.invite)socialItem('Add friends after a match.')
    }
  }catch(error){write('social-message',error.message)}
}
function openSocial(mode,name){
  closeDialog('account-dialog')
  showDialog('social-dialog')
  $('social-content').replaceChildren()
  $('social-filter').hidden=true
  $('country-form').hidden=true
  loadSocial(mode,name)
}
for(const [id,mode] of [['open-friends','friends'],['open-board','board'],['open-medals','medals'],['account-stats','stats'],['account-medals','medals']])
  $(id).addEventListener('click',()=>{boardOffset=0;openSocial(mode)})
for(const mode of ['stats','friends','board','medals'])$('social-'+mode).addEventListener('click',()=>{boardOffset=0;loadSocial(mode)})
for(const id of ['board-period','board-region'])$(id).addEventListener('change',()=>{boardOffset=0;loadSocial('board')})
$('board-prev').addEventListener('click',()=>{boardOffset=Math.max(0,boardOffset-100);loadSocial('board')})
$('board-next').addEventListener('click',()=>{boardOffset+=100;loadSocial('board')})
$('country-form').addEventListener('submit',async event=>{
  event.preventDefault()
  try{await socialRequest('country',{country:$('country-code').value.trim()});loadSocial('stats')}
  catch(error){write('social-message',error.message)}
})
$('opponent-profile').addEventListener('click',()=>openSocial('opponent',online.state?.opponent))
$('add-opponent').addEventListener('click',async()=>{
  try{
    await socialRequest('friend-request',{name:online.state?.opponent})
    if(online.state)online.state.notice='Friend request sent.'
    renderHud()
  }catch(error){if(online.state)online.state.notice=error.message;renderHud()}
})
$('support-form').addEventListener('submit',async(event)=>{
  event.preventDefault()
  $('send-support').disabled=true
  try{
    const result=await api('/support',{email:$('support-email').value,message:$('support-message').value})
    write('support-status','Request received. Reference '+result.reference)
    $('support-message').value=''
  }catch(error){write('support-status',error.message)}
  finally{$('send-support').disabled=false}
})
setMenu()
requestAnimationFrame(frame)
if(pagePath==='/privacy')showDialog('privacy-dialog')
else if(pagePath==='/support')showDialog('support-dialog')
else if(pagePath==='/terms')showDialog('terms-dialog')
else if(pagePath==='/account-deletion'){
  openAccount()
  if(!profile)write('account-message','Sign in to delete your account. Guest accounts can be deleted on the browser where they were created.')
}else refreshProfile()



