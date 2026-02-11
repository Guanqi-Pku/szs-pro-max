const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// 辅助函数：读取 CSV 文件并返回 Promise
function loadCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => {
                // 清洗数据：自动去除 Excel 可能产生的 BOM 头（那些奇怪的乱码）
                const cleanData = {};
                Object.keys(data).forEach(key => {
                    const cleanKey = key.trim().replace(/^\ufeff/, ''); // 去除 BOM 和空格
                    cleanData[cleanKey] = data[key];
                });
                results.push(cleanData);
            })
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// 核心加载函数
async function loadGameData() {
    try {
        console.log('正在加载游戏数据...');

        // 1. 加载角色
        const rawCharacters = await loadCSV(path.join(__dirname, 'data', 'characters.csv'));
        const characters = {};
        rawCharacters.forEach(char => {
            // 将数字字符串转为真正的数字
            char.max_hp = parseInt(char.max_hp);
            char.init_hp = parseInt(char.init_hp);
            // 以 ID 为键存入对象，方便查找
            characters[char.id] = char;
        });
        console.log(`✅ 成功加载 ${Object.keys(characters).length} 名武将`);

        // 2. 加载卡牌 (生成标准牌堆)
        const rawCards = await loadCSV(path.join(__dirname, 'data', 'cards.csv'));
        const deck = rawCards.map(card => {
            return {
                // 这里我们不保留原始 CSV 的 id，因为牌堆里每一张牌都需要一个新的独立 ID
                // 原始 CSV 的 id (如 card_001) 可以作为 templateId 引用图片
                templateId: card.id, 
                name: card.name,
                suit: card.suit, // heart, spade...
                rank: card.rank, // A, 2...
                type: card.type, // basic, scroll, equip
                text: `${card.name} ${getSuitIcon(card.suit)}${card.rank}`, // 简易显示文本
                description: card.description // 技能描述
            };
        });
        console.log(`✅ 成功加载 ${deck.length} 张卡牌`);

        return { characters, deck };

    } catch (error) {
        console.error('❌ 加载数据失败:', error);
        process.exit(1); // 失败直接退出
    }
}

// 小工具：把花色英文转图标
function getSuitIcon(suit) {
    const map = {
        'spade': '♠', 'heart': '♥', 'club': '♣', 'diamond': '♦',
        '黑桃': '♠', '红桃': '♥', '梅花': '♣', '方块': '♦' // 兼容中文写法
    };
    return map[suit] || suit;
}

module.exports = { loadGameData };