'use strict'
const fs=require('node:fs')
const path=require('node:path')
const root=__dirname
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^\ufeff/,'')
const bundle=read('index.template.html')
  .replace('/* ENGINE */',()=> '(() => {\n'+read('engine.cjs')+'\n})()')
  .replace('/* CLIENT */',()=>read('client.js'))
fs.writeFileSync(path.join(root,'index.html'),bundle)

