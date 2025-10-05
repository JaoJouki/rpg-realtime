// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const { MongoClient } = require('mongodb');

// --- CONFIGURAÇÃO ---
const MASTER_PASSWORD = 'RPGSEGURO'; 
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "RPGSEGURO-Potraits";
const PERSONAGENS_COLLECTION = "personagens";
const DICE_HISTORY_COLLECTION = "historico_dados"; // Nova coleção para persistência do histórico
// --------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db;
let personagensCollection;
let diceHistoryCollection;
let diceHistory = []; // Histórico de dados em memória, será sincronizado com o DB

// --- FUNÇÕES DE LÓGICA DE DADOS ---

// Função para rolar um dado individual (ex: 'd20')
function rollDie(sides) {
    return Math.floor(Math.random() * sides) + 1;
}

// Função principal para lidar com a expressão de dados (ex: '2d6+1d4')
function handleDiceRoll(expression) {
    const parts = expression.toLowerCase().split('+').filter(p => p.trim() !== '');
    let total = 0;
    const rolls = [];

    for (const part of parts) {
        const match = part.match(/^(\d*)d(\d+)$/);
        if (match) {
            const count = parseInt(match[1] || '1', 10);
            const sides = parseInt(match[2], 10);
            let subTotal = 0;
            const rollDetails = [];

            for (let i = 0; i < count; i++) {
                const result = rollDie(sides);
                subTotal += result;
                rollDetails.push(result);
            }
            total += subTotal;
            rolls.push({ type: `${count}d${sides}`, results: rollDetails, subTotal });
        }
    }

    return { total, rolls, expression };
}

// --- CONFIGURAÇÃO DO SERVIDOR/SESSION/AUTENTICAÇÃO (MANTIDA) ---

const sessionMiddleware = session({
  secret: 'seu-segredo-de-sessao-aleatorio',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const checkAuth = (req, res, next) => {
  if (req.session.loggedIn) {
    return next();
  }
  res.redirect('/login.html');
};

app.get('/', (req, res) => {
  res.redirect('/controle');
});

app.get('/controle', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'controle.html'));
});

app.get('/ficha', (req, res) => {
  res.sendFile(path.join(__dirname, 'ficha.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'overlay.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === MASTER_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/controle');
  } else {
    res.redirect('/login.html?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login.html');
  });
});

// --- LÓGICA DO SOCKET.IO (MODIFICADA) ---

// Conecta o middleware de sessão ao Socket.IO
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  console.log(`[SERVER] Cliente conectado: ${socket.id}`);

  // Envia a lista de personagens e o histórico ao novo cliente
  socket.emit('init', personagens); 
  socket.emit('initDiceHistory', diceHistory); // NOVO: Envia histórico ao conectar

  // NOVO: Handler de rolagem de dados
  socket.on('rollDice', async ({ personagemId, diceExpression }) => {
    if (!personagens[personagemId] || !diceExpression) return;
    
    const { total, rolls, expression } = handleDiceRoll(diceExpression);
    const personagemName = personagens[personagemId].name || personagemId;

    const rollData = {
        timestamp: new Date().toISOString(),
        personagemId,
        personagemName,
        expression,
        rolls,
        total
    };

    // Adiciona ao histórico em memória (e salva no DB, se a conexão estiver ativa)
    diceHistory.unshift(rollData);
    if (diceHistory.length > 50) { // Mantém o histórico em memória limitado
        diceHistory.pop();
    }

    if (diceHistoryCollection) {
        try {
            await diceHistoryCollection.insertOne(rollData);
        } catch (e) {
            console.error("[SERVER] Erro ao salvar histórico de dados no DB:", e);
        }
    }

    // Emite o resultado para todas as telas (ficha, controle, overlay)
    io.emit('rollResult', rollData);
  });

  // Handler de adição de personagem (MANTIDO)
  socket.on('add', async (novoPersonagem) => {
    if (!novoPersonagem.id) return;
    personagens[novoPersonagem.id] = novoPersonagem;
    try {
        await personagensCollection.insertOne(novoPersonagem);
    } catch (e) {
        console.error("[SERVER] Erro ao adicionar personagem no DB:", e);
    }
    io.emit('init', personagens);
  });

  // Handler de atualização de personagem (MANTIDO)
  socket.on('update', async (camposParaAtualizar) => {
    const { id } = camposParaAtualizar;
    if (!id) return;

    // Atualiza o objeto em memória
    if (personagens[id]) {
        Object.assign(personagens[id], camposParaAtualizar);
    } else {
        return; // Personagem não encontrado em memória
    }

    // Sanitiza e atualiza no DB (MANTIDO)
    ['vida', 'vidaMax', 'sanidade', 'sanidadeMax', 'pe', 'peMax'].forEach(stat => {
      if (camposParaAtualizar[stat] !== undefined) {
        let valorAtualizado = camposParaAtualizar[stat];
        if (valorAtualizado < 0) {
          valorAtualizado = 0;
        }
        camposParaAtualizar[stat] = valorAtualizado;
      }
    });

    await personagensCollection.updateOne({ id: id }, { $set: camposParaAtualizar });
    io.emit('update', { id, ...camposParaAtualizar });
  });

  // Handlers de renomear e remover (MANTIDOS)
  socket.on('rename', async ({ oldId, newId }) => {
    if (!oldId || !newId) return;
    const personagem = personagens[oldId];
    if (!personagem) return;
    
    personagem.id = newId;
    personagens[newId] = personagem;
    delete personagens[oldId];

    await personagensCollection.updateOne({ id: oldId }, { $set: { id: newId } });
    io.emit('init', personagens);
  });

  socket.on('remove', async (id) => {
    if (!id) return;
    delete personagens[id];
    await personagensCollection.deleteOne({ id: id });
    io.emit('init', personagens);
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

// --- FUNÇÕES DE INICIALIZAÇÃO DO SERVIDOR (MODIFICADA) ---

let personagens = {};

async function carregarPersonagens() {
    try {
        const docs = await personagensCollection.find({}).toArray();
        const data = {};
        docs.forEach(doc => {
            data[doc.id] = doc;
        });
        return data;
    } catch (e) {
        console.error("[SERVER] Erro ao carregar personagens:", e);
        return {};
    }
}

async function carregarHistorico() {
    try {
        // Carrega os 50 mais recentes
        const docs = await diceHistoryCollection.find({}).sort({ timestamp: -1 }).limit(50).toArray();
        return docs;
    } catch (e) {
        console.error("[SERVER] Erro ao carregar histórico de dados:", e);
        return [];
    }
}

async function startServer() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log("[SERVER] Conectado ao MongoDB Atlas!");
        db = client.db(DB_NAME);
        personagensCollection = db.collection(PERSONAGENS_COLLECTION);
        diceHistoryCollection = db.collection(DICE_HISTORY_COLLECTION);

        // Carrega dados iniciais
        personagens = await carregarPersonagens();
        diceHistory = await carregarHistorico();

        server.listen(PORT, () => {
            console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("[SERVER] Falha ao iniciar o servidor ou conectar ao MongoDB:", error);
    }
}

startServer();