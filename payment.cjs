'use strict'
const {createHmac,timingSafeEqual}=require('node:crypto')
const SKU='neon-founders'
const AMOUNT=299
const CURRENCY='usd'
const profilePattern=/^[0-9a-f]{48}$/

function siteOrigin(){
  try{
    const url=new URL(process.env.MAGNET_PUBLIC_URL)
    if(url.protocol==='https:'&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash)return url.origin
  }catch{}
  return null
}
function checkoutEnabled(){
  return Boolean(siteOrigin()&&process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET)
}
function fail(message,statusCode){
  return Object.assign(new Error(message),{statusCode})
}
async function createCheckout(profile){
  if(!checkoutEnabled())throw fail('Checkout is unavailable.',503)
  if(!profilePattern.test(profile))throw fail('Invalid profile.',400)
  const origin=siteOrigin()
  const payload=new URLSearchParams({
    mode:'payment',
    client_reference_id:profile,
    success_url:origin+'/?checkout=success',
    cancel_url:origin+'/?checkout=cancel',
    'metadata[sku]':SKU,
    'line_items[0][quantity]':'1',
    'line_items[0][price_data][currency]':CURRENCY,
    'line_items[0][price_data][unit_amount]':String(AMOUNT),
    'line_items[0][price_data][product_data][name]':'Magnet Mayhem Neon Founders Pack'
  })
  const bucket=Math.floor(Date.now()/1800000)
  let response
  try{
    response=await fetch('https://api.stripe.com/v1/checkout/sessions',{
      method:'POST',signal:AbortSignal.timeout(8500),
      headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,
        'Content-Type':'application/x-www-form-urlencoded',
        'Idempotency-Key':SKU+'-'+profile+'-'+bucket},
      body:payload
    })
    const body=await response.json()
    if(response.ok&&typeof body.url==='string'&&new URL(body.url).hostname==='checkout.stripe.com')return body.url
  }catch{}
  throw fail('Checkout could not start. Try again shortly.',502)
}
function verify(raw,signature,secret){
  const parts=String(signature||'').split(',').map(part=>part.trim().split('='))
  const stamp=parts.find(([name])=>name==='t')?.[1]
  if(!/^\d+$/.test(stamp||'')||Math.abs(Date.now()/1000-Number(stamp))>300)return false
  const expected=createHmac('sha256',secret).update(stamp+'.').update(raw).digest()
  return parts.some(([name,value])=>name==='v1'&&/^[0-9a-f]{64}$/.test(value||'')&&
    timingSafeEqual(expected,Buffer.from(value,'hex')))
}
async function handleWebhook(raw,signature,grant){
  if(!checkoutEnabled())throw fail('Checkout is unavailable.',503)
  if(!verify(raw,signature,process.env.STRIPE_WEBHOOK_SECRET))throw fail('Invalid signature.',400)
  const event=JSON.parse(raw)
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return
  const session=event.data?.object
  if(!session||session.metadata?.sku!==SKU||session.payment_status!=='paid'||session.mode!=='payment'||
    session.currency!==CURRENCY||session.amount_total!==AMOUNT||!profilePattern.test(session.client_reference_id||''))return
  try{
    if(!grant(session.client_reference_id))throw new Error('Unknown profile')
  }catch{
    throw fail('Purchase could not be recorded.',500)
  }
}
module.exports={checkoutEnabled,createCheckout,handleWebhook}
