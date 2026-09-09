const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

/* ================= 牌型逻辑 ================= */
const SUITS=['♠','♥','♦','♣'];
const RED=[false,true,true,false];
const RN={11:'J',12:'Q',13:'K',14:'A'};
const TYPE_NAME={6:'豹子',5:'同花顺',4:'金花',3:'顺子',2:'对子',1:'单张'};
const ANTE=10, START_CHIPS=1000, MAX_RAISES=12;

function rankName(r){return r<=10?String(r):RN[r];}
function makeDeck(){const d=[];for(let s=0;s<4;s++)for(let r=2;r<=14;r++)d.push({rank:r,suit:s});return d;}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

function evaluate(cards){
  const c=[...cards].sort((a,b)=>b.rank-a.rank);
  const ranks=c.map(x=>x.rank);
  const sameSuit=c[0].suit===c[1].suit&&c[1].suit===c[2].suit;
  const isTrips=ranks[0]===ranks[1]&&ranks[1]===ranks[2];
  const uniq=[...new Set(ranks)].sort((a,b)=>b-a);
  let isStraight=false,high=0;
  if(uniq.length===3){
    if(uniq[0]-uniq[1]===1&&uniq[1]-uniq[2]===1){isStraight=true;high=uniq[0];}
    else if(uniq[0]===14&&uniq[1]===3&&uniq[2]===2){isStraight=true;high=3;}
  }
  let pairRank=0,kicker=0;
  if(ranks[0]===ranks[1]){pairRank=ranks[0];kicker=ranks[2];}
  else if(ranks[1]===ranks[2]){pairRank=ranks[1];kicker=ranks[0];}
  const is235=uniq.length===3&&uniq[0]===5&&uniq[1]===3&&uniq[2]===2&&!sameSuit;
  let type;
  if(isTrips)type=6; else if(sameSuit&&isStraight)type=5; else if(sameSuit)type=4;
  else if(isStraight)type=3; else if(pairRank)type=2; else type=1;
  let tb;
  if(type===6)tb=[ranks[0]]; else if(type===5||type===3)tb=[high];
  else if(type===4||type===1)tb=ranks; else tb=[pairRank,kicker];
  return {type,tb,is235,name:TYPE_NAME[type]};
}
function stronger(a,b){
  if(a.is235&&b.type===6)return 1;
  if(b.is235&&a.type===6)return -1;
  if(a.type!==b.type)return a.type>b.type?1:-1;
  for(let i=0;i<a.tb.length;i++)if(a.tb[i]!==b.tb[i])return a.tb[i]>b.tb[i]?1:-1;
  return 0;
}

/* ================= 房间管理 ================= */
const rooms = new Map();
const MAX_PLAYERS = 5;

function makeRoom(id){
  return {id, players:[], phase:'waiting', hostId:null, game:null, timer:null};
}
function newGame(room){
  const players = room.players.map(p=>({
    id:p.id, name:p.name, chips:START_CHIPS, cards:[], eval:null,
    folded:false, looked:false, allIn:false, acted:false, roundBet:0,
    revealed:false, lastAction:{text:'',cls:''}
  }));
  return {players, pot:0, currentBet:ANTE, currentPlayer:0, phase:'betting',
          dealer:0, raiseCount:0, pendingCompare:false, round:0, winner:null};
}
function roomOf(socket){
  for(const r of rooms.values()) if(r.players.some(p=>p.socketId===socket.id)) return r;
  return null;
}
function myIndex(room, socket){
  return room.game.players.findIndex(p=>p.id===socket.id);
}
function nextAliveIndex(g, from){
  const n=g.players.length;
  for(let k=1;k<=n;k++){const i=(from+k)%n;if(g.players[i].chips>0)return i;}
  return from;
}
function activeCount(g){return g.players.filter(p=>!p.folded).length;}

/* ================= 广播 ================= */
function broadcastWaiting(room){
  for(const p of room.players){
    io.to(p.socketId).emit('state',{
      phase:'waiting', roomId:room.id, hostId:room.hostId, you:p.id,
      players:room.players.map(x=>({id:x.id,name:x.name}))
    });
  }
}
function broadcastGame(room){
  const g=room.game;
  for(const p of room.players){
    io.to(p.socketId).emit('state',{
      phase:g.phase, roomId:room.id, you:p.id, hostId:room.hostId,
      round:g.round, dealer:g.dealer, pot:g.pot, currentBet:g.currentBet,
      currentPlayer:g.currentPlayer, pendingCompare:g.pendingCompare, winner:g.winner,
      players:g.players.map(gp=>{
        const show = gp.id===p.id || gp.revealed;
        return {
          id:gp.id, name:gp.name, chips:gp.chips, roundBet:gp.roundBet,
          folded:gp.folded, looked:gp.looked, allIn:gp.allIn, revealed:gp.revealed,
          lastAction:gp.lastAction,
          evalName: show&&gp.eval ? gp.eval.name : null,
          evalIs235: show&&gp.eval ? gp.eval.is235 : false,
          cards: show ? gp.cards : [null,null,null]
        };
      })
    });
  }
}

/* ================= 发牌与回合 ================= */
function dealHand(room){
  const g=room.game;
  g.dealer = g.round>0 ? nextAliveIndex(g,g.dealer) : g.dealer;
  g.round++;
  g.phase='betting'; g.pot=0; g.currentBet=ANTE; g.raiseCount=0;
  g.pendingCompare=false; g.winner=null;
  const deck=shuffle(makeDeck()); let d=0;
  g.players.forEach(p=>{
    p.folded=false;p.looked=false;p.allIn=false;p.acted=false;p.roundBet=0;
    p.revealed=false;p.cards=[];p.eval=null;p.lastAction={text:'',cls:''};
    if(p.chips>0){
      p.cards=[deck[d++],deck[d++],deck[d++]];
      p.eval=evaluate(p.cards);
      const ant=Math.min(ANTE,p.chips);
      p.chips-=ant;p.roundBet=ant;g.pot+=ant;
      p.lastAction={text:'底注 '+ant,cls:'look'};
      if(p.chips===0)p.allIn=true;
    }else{p.folded=true;p.lastAction={text:'已出局',cls:'out'};}
  });
  g.currentPlayer=nextAliveIndex(g,g.dealer);
  clearTimer(room);
  broadcastGame(room);
  startTurnTimer(room);
}
function advance(room){
  const g=room.game;
  clearTimer(room);
  if(activeCount(g)===1){resolveWin(room);return;}
  const i=findNextActing(g);
  if(i===-1){showdown(room);return;}
  g.currentPlayer=i;
  broadcastGame(room);
  startTurnTimer(room);
}
function findNextActing(g){
  const n=g.players.length;
  for(let k=1;k<=n;k++){
    const i=(g.currentPlayer+k)%n;
    const p=g.players[i];
    if(p.chips>0&&!p.folded&&!p.allIn&&(!p.acted||p.roundBet<g.currentBet))return i;
  }
  return -1;
}
function resolveWin(room){
  const g=room.game;
  const w=g.players.find(p=>!p.folded);
  w.chips+=g.pot;w.revealed=true;w.looked=true;w.lastAction={text:'赢得底池',cls:'win'};
  g.phase='end';
  clearTimer(room);
  broadcastGame(room);
  afterHand(room);
}
function showdown(room){
  const g=room.game;
  const active=g.players.filter(p=>!p.folded);
  active.forEach(p=>{p.revealed=true;p.looked=true;});
  let best=[active[0]];
  for(let i=1;i<active.length;i++){
    const cmp=stronger(active[i].eval,best[0].eval);
    if(cmp>0)best=[active[i]];else if(cmp===0)best.push(active[i]);
  }
  const share=Math.floor(g.pot/best.length);
  let rem=g.pot-share*best.length;
  best.forEach((p,i)=>{p.chips+=share+(i<rem?1:0);p.lastAction={text:'获胜',cls:'win'};});
  g.phase='end';
  clearTimer(room);
  broadcastGame(room);
  afterHand(room);
}
function afterHand(room){
  const g=room.game;
  const alive=g.players.filter(p=>p.chips>0);
  if(alive.length===1){g.phase='over';g.winner=alive[0].name;broadcastGame(room);return;}
  room.timer=setTimeout(()=>{if(room.game.phase==='end')dealHand(room);},7000);
}
function startTurnTimer(room){
  clearTimer(room);
  room.timer=setTimeout(()=>{
    const g=room.game;
    if(g.phase!=='betting')return;
    const p=g.players[g.currentPlayer];
    p.folded=true;p.acted=true;p.lastAction={text:'超时弃牌',cls:'fold'};
    advance(room);
  },90000);
}
function clearTimer(room){if(room.timer){clearTimeout(room.timer);room.timer=null;}}

/* ================= 动作处理 ================= */
function handleAction(room, idx, data){
  const g=room.game, p=g.players[idx];
  const need=g.currentBet-p.roundBet;
  const take=(amt)=>{const x=Math.min(amt,p.chips);p.chips-=x;p.roundBet+=x;g.pot+=x;if(p.chips===0)p.allIn=true;return x;};

  switch(data.type){
    case 'look':
      if(!p.looked){p.looked=true;p.lastAction={text:'看牌',cls:'look'};}
      broadcastGame(room);
      return;
    case 'call':{
      const x=take(need); p.acted=true;
      p.lastAction=x>0?{text:'跟注 '+x,cls:'look'}:{text:'过牌',cls:'look'};
      advance(room); return;
    }
    case 'raise':{
      if(data.amount==='allin'){
        const all=p.chips;p.chips=0;p.roundBet+=all;g.pot+=all;p.allIn=true;
        if(p.roundBet>g.currentBet)g.currentBet=p.roundBet;
        p.lastAction={text:'全下',cls:'raise'};
      }else{
        const a=Number(data.amount)||10;
        take(need+a); g.currentBet+=a;
        p.lastAction={text:'加注到 '+g.currentBet,cls:'raise'};
      }
      g.raiseCount++; p.acted=true;
      advance(room); return;
    }
    case 'fold':
      p.folded=true;p.acted=true;p.lastAction={text:'弃牌',cls:'fold'};
      advance(room); return;
    case 'compare':{
      const t=g.players.find(x=>x.id===data.targetId);
      if(!t||t.folded)return;
      const fee=g.currentBet; take(fee);
      p.looked=true;p.revealed=true;t.looked=true;t.revealed=true;
      const cmp=stronger(p.eval,t.eval);
      if(cmp>0){t.folded=true;t.lastAction={text:'比牌落败',cls:'fold'};p.lastAction={text:'比牌胜',cls:'win'};}
      else if(cmp<0){p.folded=true;p.lastAction={text:'比牌落败',cls:'fold'};t.lastAction={text:'比牌胜',cls:'win'};}
      else{p.lastAction={text:'比牌平',cls:'win'};t.lastAction={text:'比牌平',cls:'win'};}
      p.acted=true;
      advance(room); return;
    }
  }
}

/* ================= 连接事件 ================= */
io.on('connection', socket=>{
  socket.on('create-room', ({name})=>{
    const roomId=Math.random().toString(36).slice(2,7).toUpperCase();
    const room=makeRoom(roomId);
    rooms.set(roomId,room);
    const p={id:socket.id,socketId:socket.id,name:(name||'玩家').slice(0,8)};
    room.players.push(p);
    room.hostId=socket.id;
    socket.join(roomId);
    broadcastWaiting(room);
  });

  socket.on('join-room', ({roomId,name})=>{
    const room=rooms.get((roomId||'').toUpperCase());
    if(!room)return socket.emit('error','房间不存在');
    if(room.phase!=='waiting')return socket.emit('error','游戏已开始');
    if(room.players.length>=MAX_PLAYERS)return socket.emit('error','房间已满');
    if(room.players.some(p=>p.name===name))return socket.emit('error','昵称重复');
    const p={id:socket.id,socketId:socket.id,name:(name||'玩家').slice(0,8)};
    room.players.push(p);
    socket.join(room.id);
    broadcastWaiting(room);
  });

  socket.on('start-game', ()=>{
    const room=roomOf(socket);
    if(!room)return;
    if(room.hostId!==socket.id)return socket.emit('error','只有房主能开始');
    if(room.players.length<2)return socket.emit('error','至少需要 2 人');
    room.phase='playing';
    room.game=newGame(room);
    dealHand(room);
  });

  socket.on('next-hand', ()=>{
    const room=roomOf(socket);
    if(!room)return;
    if(room.game&&room.game.phase==='end'){clearTimer(room);dealHand(room);}
  });

  socket.on('restart', ()=>{
    const room=roomOf(socket);
    if(!room)return;
    if(room.hostId!==socket.id)return;
    room.phase='playing';
    room.game=newGame(room);
    dealHand(room);
  });

  socket.on('action', data=>{
    const room=roomOf(socket);
    if(!room||!room.game)return;
    if(room.game.phase!=='betting')return;
    const idx=myIndex(room,socket);
    if(idx!==room.game.currentPlayer)return socket.emit('error','还没轮到你');
    handleAction(room,idx,data);
  });

  socket.on('disconnect', ()=>{
    for(const [id,room] of rooms){
      const i=room.players.findIndex(p=>p.socketId===socket.id);
      if(i===-1)continue;
      if(room.phase==='waiting'){
        room.players.splice(i,1);
        if(room.players.length===0)rooms.delete(id);
        else{if(room.hostId===socket.id)room.hostId=room.players[0].socketId;broadcastWaiting(room);}
      }else if(room.game){
        const gp=room.game.players.find(p=>p.id===room.players[i].id);
        if(gp&&!gp.folded){gp.folded=true;gp.acted=true;gp.lastAction={text:'掉线',cls:'fold'};}
        if(room.game.phase==='betting')advance(room);
        else broadcastGame(room);
      }
    }
  });
});

server.listen(3000, ()=>console.log('✅ 炸金花服务器已启动: http://localhost:3000'));