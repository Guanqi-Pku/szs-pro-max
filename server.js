const { loadGameData } = require('./Dataloader');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let GLOBAL_DECK = [];
let GLOBAL_HEROES = {};

app.use(express.static('public'));

const rooms = {};

// --- 辅助函数 ---
function shuffle(array) {
    const newArr = [...array];
    for (let i = newArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
    }
    return newArr;
}

const uuid = () => Math.random().toString(36).substr(2, 9);

io.on('connection', (socket) => {
    console.log('🔗 连接:', socket.id);

    // 1. 加入房间 (含断线重连逻辑)
    socket.on('join', ({ name, roomId }) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                status: 'waiting',
                settings: { 
                    roleConfig: { zhu:1, zhong:1, fan:1, nei:1 }, 
                    hpMode: 'normal',
                    pickCount: 1,
                    candidateCount: 3
                },
                deck: shuffle([...GLOBAL_DECK]).map(c => ({...c, uuid: uuid()})),
                discardPile: [],
                players: {},
                seatOrder: [],
                history: null,
                logs: []
            };
        }
        const room = rooms[roomId];

        // --- 核心修改：检查是否为重连 ---
        let existingPid = null;
        Object.keys(room.players).forEach(pid => {
            if (room.players[pid].name === name) {
                existingPid = pid;
            }
        });

        if (existingPid) {
            // [情景2: 断线重连]
            const p = room.players[existingPid];
            
            // 1. 更新 Socket ID 映射
            if (existingPid !== socket.id) {
                room.players[socket.id] = p; // 将旧数据移到新Socket名下
                delete room.players[existingPid]; // 删除旧Socket引用的key
            }
            
            // 2. 更新玩家对象内部ID
            p.id = socket.id;
            
            // 3. 更新座位表
            const seatIdx = room.seatOrder.indexOf(existingPid);
            if (seatIdx !== -1) {
                room.seatOrder[seatIdx] = socket.id;
            }

            addLog(room, '系统', `用户 <span style="color:#00C851">${name}</span> 断线重连成功`);
        } else {
            // [情景: 新用户加入]
            
            // 如果已经在游戏中 (playing/picking)，则视为[情景1: 中途加入/观众]
            // 如果是 waiting，则是正常加入
            const isLateJoin = room.status !== 'waiting';

            room.players[socket.id] = {
                id: socket.id,
                name: name,
                isHost: room.seatOrder.length === 0, // 只有房间第一个人是房主
                hero: null, backupHeroes: [],
                hp: 0, maxHp: 0,
                // 如果是中途加入，身份设为观众，否则未定
                role: isLateJoin ? '观众' : '未定', 
                isRoleShown: isLateJoin, // 观众身份默认公开
                isFlipped: false, 
                isChained: false, 
                hand: [],
                zones: { equip: [], judge: [], special: [] },
                marks: [], 
                isDead: false
            };
            
            room.seatOrder.push(socket.id);
            
            if (isLateJoin) {
                addLog(room, '系统', `用户 <span style="color:#aaa">${name}</span> 以观众身份加入观战`);
            } else {
                addLog(room, '系统', `用户 <span style="color:#ffd700">${name}</span> 加入了房间`);
            }
        }

        broadcast(roomId);
    });

    // 2. 游戏控制
    socket.on('game_ctrl', ({ roomId, type, data }) => {
        const room = rooms[roomId];
        if (!room) return;
        if(type !== 'undo') saveState(room);

        switch(type) {
            case 'start_pick': 
                if(room.status !== 'waiting') return;
                
                // 只有当前在房间里的有效玩家参与选将
                const validPids = room.seatOrder.filter(pid => room.players[pid]);
                if (validPids.length === 0) return;

                // 重置座位表，剔除无效ID（虽然disconnect不删，但保险起见）
                room.seatOrder = validPids;

                room.settings.roleConfig = data.roleConfig;
                room.settings.pickCount = parseInt(data.pickCount) || 1;
                room.settings.candidateCount = parseInt(data.candidateCount) || 3;
                
                const roles = [];
                const cfg = room.settings.roleConfig;
                for(let i=0; i<cfg.zhu; i++) roles.push('主公');
                for(let i=0; i<cfg.zhong; i++) roles.push('忠臣');
                for(let i=0; i<cfg.fan; i++) roles.push('反贼');
                for(let i=0; i<cfg.nei; i++) roles.push('内奸');
                // 补齐反贼
                while(roles.length < room.seatOrder.length) roles.push('反贼'); 
                const shuffledRoles = shuffle(roles);
                
                room.seatOrder.forEach((pid, i) => {
                    if (room.players[pid]) {
                        room.players[pid].role = shuffledRoles[i] || '反贼';
                        room.players[pid].isRoleShown = false;
                    }
                });

                room.status = 'picking';
                const allHeroes = shuffle(Object.values(GLOBAL_HEROES));
                let hIdx = 0;
                room.seatOrder.forEach(pid => {
                    const p = room.players[pid];
                    if (p) {
                        let candidates = [];
                        for(let k=0; k<room.settings.candidateCount; k++) {
                             candidates.push(allHeroes[hIdx % allHeroes.length]);
                             hIdx++;
                        }
                        p.heroPool = candidates;
                    }
                });
                addLog(room, '系统', `📢 开始选将 (模式: ${room.settings.candidateCount}选${room.settings.pickCount})`);
                break;

            case 'confirm_hero':
                const p = room.players[socket.id];
                if(!p || room.status !== 'picking') return;
                
                const poolMap = new Map((p.heroPool || []).map(h => [h.id, h]));
                const selected = [];
                
                if (data.heroIds && Array.isArray(data.heroIds)) {
                    data.heroIds.forEach(id => {
                        const h = poolMap.get(id);
                        if (h) selected.push(h);
                    });
                }

                if(selected.length > 0) {
                    p.hero = selected[0];
                    p.backupHeroes = selected.slice(1);
                    p.maxHp = parseInt(p.hero.max_hp);
                    p.hp = parseInt(p.hero.init_hp);
                    delete p.heroPool;
                    addLog(room, '系统', `${p.name} 完成了选将`);
                }
                checkGameStart(room);
                break;
            
            case 'force_start':
                room.status = 'playing';
                addLog(room, '系统', `📢 房主强制开始了游戏`);
                break;

            case 'transfer_host':
                const hostP = room.players[socket.id];
                const targetP = room.players[data.targetPid];
                if(hostP && hostP.isHost && targetP) {
                    hostP.isHost = false;
                    targetP.isHost = true;
                    addLog(room, '系统', `👑 房主权限已移交给 <span style="color:#ffd700">${targetP.name}</span>`);
                }
                break;

            case 'restart':
                room.status = 'waiting';
                room.deck = shuffle([...GLOBAL_DECK]).map(c => ({...c, uuid: uuid()}));
                room.discardPile = [];
                // 重置时，保留所有座位上的玩家，但重置状态
                room.seatOrder.forEach(pid => {
                    const pl = room.players[pid];
                    if(pl) {
                        pl.hero = null; 
                        pl.hand = []; 
                        pl.zones = {equip:[], judge:[], special:[]};
                        pl.hp = 0; pl.maxHp = 0; 
                        pl.isDead = false; 
                        pl.isFlipped = false;
                        pl.isChained = false;
                        pl.role = '未定'; 
                        pl.isRoleShown = false; 
                        pl.marks = [];
                        pl.backupHeroes = [];
                        delete pl.heroPool;
                    }
                });
                addLog(room, '系统', '⚠️ 游戏已重置');
                break;
                
            case 'undo':
                if(room.history) {
                    const logs = room.logs;
                    Object.assign(room, JSON.parse(room.history));
                    room.logs = logs;
                    room.history = null;
                    addLog(room, '系统', '↩ 房主撤销了一步操作');
                }
                break;
        }
        broadcast(roomId);
    });

    // 3. 游戏动作
    socket.on('game_action', ({ roomId, type, data, logMsg }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        if(!['undo', 'chat', 'req_view_player'].includes(type)) saveState(room);
        
        const p = room.players[socket.id];

        switch(type) {
            case 'move_card': handleMoveCard(room, data); break;
            
            case 'use_card': 
                handleMoveCard(room, { ...data, toPid: 'discard', toZone: 'discard' });
                if(logMsg) {
                } else if(data.targetPids && data.targetPids.length > 0) {
                    const names = data.targetPids.map(pid => room.players[pid] ? room.players[pid].name : '?').join('、');
                    logMsg = `对 ${names} 使用了【${data.cardName}】`;
                }
                break;
                
            case 'play_card': 
                handleMoveCard(room, { ...data, toPid: 'discard', toZone: 'discard' });
                break;

            case 'update_prop':
                if(room.players[data.targetPid]) {
                    room.players[data.targetPid][data.prop] = data.value;
                }
                break;
            
            case 'toggle_card_visible':
                if(room.players[data.targetPid]) {
                    const targetP = room.players[data.targetPid];
                    // 优先找特殊区
                    let card = targetP.zones.special.find(c => c.uuid === data.uuid);
                    // 没找到再找手牌
                    if(!card) card = targetP.hand.find(c => c.uuid === data.uuid);
                    
                    if(card) {
                        // 0:暗, 1:己, 2:明
                        const current = card.visType || 0;
                        card.visType = (current + 1) % 3;
                        
                        const states = ['🙈均暗置', '🤫仅自己', '👁️均明置'];
                        logMsg = `${p.name} 切换牌状态为: ${states[card.visType]}`;
                    }
                }
                break;

            case 'mark_op':
                if(room.players[data.targetPid]) {
                    if(data.op === 'add') room.players[data.targetPid].marks.push(data.text);
                    else room.players[data.targetPid].marks.splice(data.index, 1);
                }
                break;
            
            case 'chat':
                break;

            case 'print_card':
                if(p) p.hand.push({ uuid: uuid(), name: data.name || '空白牌', suit: 'token', rank: '', type: 'scroll', description: '印卡' });
                break;
            case 'random_gen':
                const res = Math.floor(Math.random() * data.range) + 1;
                logMsg = `🎲 投掷了 ${data.range} 面骰子，结果：<span style="color:#ffd700;font-weight:bold">${res}</span>`;
                break;
            case 'shuffle_hand':
                if(p) p.hand = shuffle(p.hand);
                break;
            
            case 'switch_hero':
                if(p) {
                    if (p.backupHeroes.length > 0) {
                        const oldName = p.hero.name;
                        p.hero = p.backupHeroes.shift();
                        p.maxHp = parseInt(p.hero.max_hp);
                        p.hp = parseInt(p.hero.init_hp);
                        logMsg = `🔄 ${oldName} 阵亡，切换为 ${p.hero.name}`;
                    } else {
                        p.isDead = !p.isDead;
                        if(p.isDead) logMsg = `💀 ${p.name} 宣布阵亡`;
                        else logMsg = `✨ ${p.name} 复活了`;
                    }
                }
                break;
            
            case 'draw_bottom': 
                 if(room.deck.length > 0) {
                     const c = room.deck.shift(); 
                     p.hand.push(c);
                 }
                 break;
            case 'judge_top': 
                 if(room.deck.length > 0) {
                     const c = room.deck.pop();
                     room.discardPile.push(c);
                     logMsg = `⚡ 判定结果：【${c.name}】 <span style="font-size:14px">${c.suit} ${c.rank}</span>`;
                     io.to(roomId).emit('judge_result', { card: c, user: p.name });
                 }
                 break;
            
            case 'req_view_player':
                 const targetP = room.players[data.targetPid];
                 if (targetP) {
                     socket.emit('res_view_player', { 
                         targetPid: data.targetPid, 
                         hand: targetP.hand, 
                         zones: targetP.zones 
                     });
                 }
                 break;
        }

        if(logMsg) addLog(room, p?p.name:'系统', logMsg);
        broadcast(roomId);
    });

    socket.on('disconnect', () => {
        // --- 核心修改：断线不立即删除数据，只打日志 ---
        let rId = null;
        for(const rid in rooms) { if(rooms[rid].players[socket.id]) { rId = rid; break; } }
        if (rId) {
            const room = rooms[rId];
            const p = room.players[socket.id];
            if (p) {
                console.log(`用户 ${p.name} (${socket.id}) 断开连接，保留数据等待重连。`);
                // 可选：广播某人断线
                // addLog(room, '系统', `用户 ${p.name} 暂时离开了`);
                // broadcast(rId);
            }
            
            // 只有当房间空太久才销毁(这里为了简单暂时不销毁，或者依靠服务器重启清理)
        }
    });
});

function checkGameStart(room) {
    // 检查所有非观众且有座位的玩家是否都选了将
    const seatPlayers = room.seatOrder.map(pid => room.players[pid]).filter(p => p && p.role !== '观众');
    
    if(seatPlayers.length > 0 && seatPlayers.every(p => p.hero)) {
        room.status = 'playing';
        addLog(room, '系统', '⚔️ 所有玩家选将完毕，游戏开始！');
    }
}

function handleMoveCard(room, { fromPid, fromZone, cardUuid, toPid, toZone }) {
    let card = null, source = null;
    
    if(fromPid === 'deck') { 
        if (room.deck.length === 0) {
            if (room.discardPile.length > 0) {
                room.deck = shuffle(room.discardPile);
                room.discardPile = [];
                addLog(room, '系统', '🔄 牌堆耗尽，弃牌堆已重洗');
            } else {
                return; // 无牌可抽
            }
        }
        source = room.deck; 
        card = source.pop(); 
    }
    else if(fromPid === 'discard') { 
        source = room.discardPile; 
        const idx = source.findIndex(c => c.uuid === cardUuid);
        if(idx!==-1) card = source.splice(idx, 1)[0];
    } else if(room.players[fromPid]) {
        const p = room.players[fromPid];
        source = fromZone === 'hand' ? p.hand : p.zones[fromZone];
        const idx = source.findIndex(c => c.uuid === cardUuid);
        if(idx!==-1) card = source.splice(idx, 1)[0];
    }
    
    if(!card) return;

    if(toPid === 'deck') { 
        if (toZone === 'top') room.deck.push(card); 
        else room.deck.unshift(card); 
    }
    else if(toPid === 'discard') { room.discardPile.push(card); }
    else if(room.players[toPid]) {
        const p = room.players[toPid];
        delete card.visType; 
        if(toZone === 'hand') p.hand.push(card);
        else if (p.zones[toZone]) p.zones[toZone].push(card);
    }
}

function saveState(room) { const {history, ...state} = room; room.history = JSON.stringify(state); }

function addLog(room, user, msg) {
    const time = new Date().toLocaleTimeString('zh-CN',{hour12:false});
    let fmtMsg = msg.replace(/【(.*?)】/g, '<span style="color:orange;font-weight:bold">【$1】</span>');
    room.logs.push({time, user, html: fmtMsg});
    if(room.logs.length > 150) room.logs.shift();
}

function broadcast(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    const sockets = io.sockets.adapter.rooms.get(roomId);
    if(sockets) {
        for(const sid of sockets) {
            const socket = io.sockets.sockets.get(sid);
            if(!socket) continue;
            const clean = JSON.parse(JSON.stringify(room));
            delete clean.history;
            Object.values(clean.players).forEach(p => {
                const isOwner = (p.id === sid);
                ['hand', 'zones'].forEach(prop => {
                    if (prop === 'hand') {
                        if (!isOwner) {
                            p.hand = p.hand.map(c => {
                                const v = c.visType || 0;
                                if (v === 2) return c; // 均明置
                                return { uuid: c.uuid, type: 'back', suit: '', rank: '', name: '?', visType: v };
                            });
                            p.handCount = p.hand.length;
                        }
                    } else {
                        ['equip', 'judge', 'special'].forEach(z => {
                            p.zones[z] = p.zones[z].map(c => {
                                const v = c.visType || 0;
                                let show = false;
                                if (v === 2) show = true;
                                if (v === 1 && isOwner) show = true;
                                if (z === 'equip' || z === 'judge') show = true; 
                                if (show) return c;
                                return { uuid: c.uuid, type: 'back', name: '?', visType: v };
                            });
                        });
                    }
                });

                if(p.id !== sid) {
                    if(!p.isRoleShown) p.role = '???';
                }
            });
            clean.deckCount = clean.deck.length;
            delete clean.deck; 
            socket.emit('game_update', clean);
        }
    }
}

loadGameData().then((data) => {
    GLOBAL_DECK = data.deck;
    GLOBAL_HEROES = data.characters;
    const PORT = 3000;
    server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
});
