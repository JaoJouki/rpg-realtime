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
const CHAR_COLLECTION = "personagens";
const MESA_COLLECTION = "mesas";
// --------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db;
let personagensCollection;
let mesasCollection;

const sessionMiddleware = session({
  secret: 'seu-segredo-de-sessao-aleatorio-super-forte',
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

// --- ROTAS ---

// Páginas públicas (não precisam de autenticação de mestre)
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/mesa.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mesa.html'));
});

// Páginas protegidas (apenas para o mestre logado)
app.get('/', checkAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/controle.html', checkAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'controle.html')); });

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === MASTER_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login.html?error=1');
  }
});

// --- API PARA AS MESAS ---
app.get('/api/mesas', checkAuth, async (req, res) => {
    const mesas = await mesasCollection.find().toArray();
    res.json(mesas);
});

app.post('/api/mesas', checkAuth, async (req, res) => {
    const { nome, descricao } = req.body;
    if (!nome) {
        return res.status(400).send("O nome da mesa é obrigatório.");
    }
    const mesaId = nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    
    const novaMesa = { _id: mesaId, nome, descricao, personagens: [] };
    try {
        await mesasCollection.insertOne(novaMesa);
        res.redirect('/');
    } catch (e) {
        res.status(409).send("Uma mesa com nome similar já existe.");
    }
});

// O restante do seu server.js continua aqui...
// (as funções carregarPersonagens, io.on('connection'), startServer, etc., permanecem as mesmas)
async function carregarPersonagens(mesaId) {
    if (!mesaId) return {};
    const personagensCursor = personagensCollection.find({ mesaId: mesaId });
    const personagensArray = await personagensCursor.toArray();
    const personagensObj = {};
    personagensArray.forEach(p => {
        personagensObj[p.id] = p;
    });
    return personagensObj;
}

io.on('connection', async (socket) => {
  const mesaId = socket.handshake.query.mesaId;
  if (!mesaId) {
      console.log(`[SERVER] Cliente ${socket.id} conectado sem mesa especificada.`);
      return;
  }
  
  socket.join(mesaId);
  console.log(`[SERVER] Cliente ${socket.id} entrou na sala da mesa: ${mesaId}`);

  const personagensAtuais = await carregarPersonagens(mesaId);
  socket.emit('init', personagensAtuais);

  socket.on('add', async (data) => {
    if (!data || !data.id || !data.mesaId) return;
    const novoPersonagem = { ...data, vidaVisivel: true, sanidadeVisivel: true, peVisivel: true, anotacoes: "" };
    
    await personagensCollection.insertOne(novoPersonagem);
    await mesasCollection.updateOne({ _id: data.mesaId }, { $addToSet: { personagens: data.id } });
    
    io.to(mesaId).emit('init', await carregarPersonagens(mesaId));
  });

  socket.on('update', async (data) => {
    const { id, ...campos } = data;
    if (!id) return;
    await personagensCollection.updateOne({ id: id, mesaId: mesaId }, { $set: campos });
    io.to(mesaId).emit('update', { id, ...campos });
  });

  socket.on('rename', async ({ oldId, newId }) => {
    if (!oldId || !newId) return;
    await personagensCollection.updateOne({ id: oldId, mesaId: mesaId }, { $set: { id: newId } });
    await mesasCollection.updateOne({ _id: mesaId, personagens: oldId }, { $set: { "personagens.$": newId } });
    io.to(mesaId).emit('init', await carregarPersonagens(mesaId));
  });

  socket.on('remove', async (id) => {
    if (!id) return;
    await personagensCollection.deleteOne({ id: id, mesaId: mesaId });
    await mesasCollection.updateOne({ _id: mesaId }, { $pull: { personagens: id } });
    io.to(mesaId).emit('init', await carregarPersonagens(mesaId));
  });

  socket.on('roll', (data) => {
    const { id, numDice, diceType, bonus = 0, keepHighest, keepLowest } = data;
    if (!id || !numDice || !diceType) return;

    const rolls = Array.from({ length: numDice }, () => Math.floor(Math.random() * diceType) + 1);
    
    let keptRolls = [...rolls];
    if (keepHighest && keepHighest > 0 && keepHighest < rolls.length) {
      keptRolls = [...rolls].sort((a, b) => b - a).slice(0, keepHighest);
    } else if (keepLowest && keepLowest > 0 && keepLowest < rolls.length) {
      keptRolls = [...rolls].sort((a, b) => a - b).slice(0, keepLowest);
    }
    
    const total = keptRolls.reduce((sum, roll) => sum + roll, 0) + bonus;

    io.to(mesaId).emit('rollResult', { id, rolls, keptRolls, bonus, total });
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente ${socket.id} desconectado da sala: ${mesaId}`);
  });
});

async function startServer() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log("[SERVER] Conectado ao MongoDB Atlas!");
        db = client.db(DB_NAME);
        personagensCollection = db.collection(CHAR_COLLECTION);
        mesasCollection = db.collection(MESA_COLLECTION);

        server.listen(PORT, () => console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`));
    } catch (err) {
        console.error("Não foi possível conectar ao MongoDB", err);
        process.exit(1);
    }
}

startServer();