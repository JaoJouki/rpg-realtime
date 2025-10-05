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
const COLLECTION_NAME = "personagens";
// --------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db;
let personagensCollection;

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

app.get('/', (req, res) => { res.redirect('/controle'); });
app.get('/controle', checkAuth, (req, res) => { res.sendFile(path.join(__dirname, 'controle.html')); });

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

async function carregarPersonagens() {
    const personagensCursor = personagensCollection.find();
    const personagensArray = await personagensCursor.toArray();
    const personagensObj = {};
    personagensArray.forEach(p => {
        personagensObj[p.id] = p;
    });
    return personagensObj;
}

io.on('connection', async (socket) => {
  console.log(`[SERVER] Novo cliente conectado: ${socket.id}`);

  const personagensAtuais = await carregarPersonagens();
  socket.emit('init', personagensAtuais);

  socket.on('add', async (data) => {
    if (!data || !data.id) return;
    const novoPersonagem = { ...data, vidaVisivel: true, sanidadeVisivel: true, peVisivel: true };
    await personagensCollection.insertOne(novoPersonagem);
    io.emit('init', await carregarPersonagens());
  });

  socket.on('update', async (data) => {
    const { id, ...campos } = data;
    if (!id) return;

    const camposParaAtualizar = { ...campos };

    // Valida apenas para garantir que os valores não sejam negativos
    ['vida', 'sanidade', 'pe'].forEach(stat => {
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

  socket.on('rename', async ({ oldId, newId }) => {
    if (!oldId || !newId) return;
    await personagensCollection.updateOne({ id: oldId }, { $set: { id: newId } });
    io.emit('init', await carregarPersonagens());
  });

  socket.on('remove', async (id) => {
    if (!id) return;
    await personagensCollection.deleteOne({ id: id });
    io.emit('init', await carregarPersonagens());
  });
  
  // --- NOVO EVENTO DE ROLAGEM DE DADOS ---
  socket.on('rollDice', (data) => {
    const { characterId, dice } = data;
    if (!characterId || !dice) return;

    let totalResult = 0;
    let rollString = [];
    let detailsString = [];

    Object.entries(dice).forEach(([dieSize, count]) => {
      if (count > 0) {
        rollString.push(`${count}d${dieSize}`);
        let rolls = [];
        for (let i = 0; i < count; i++) {
          const roll = Math.floor(Math.random() * parseInt(dieSize)) + 1;
          totalResult += roll;
          rolls.push(roll);
        }
        detailsString.push(`${count}d${dieSize} (${rolls.join(', ')})`);
      }
    });
    
    io.emit('diceResult', {
        characterId: characterId,
        roll: rollString.join(' + '),
        result: totalResult,
        details: detailsString.join(' + ')
    });
  });
  // --- FIM DO NOVO EVENTO ---

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

async function startServer() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log("[SERVER] Conectado ao MongoDB Atlas!");
        db = client.db(DB_NAME);
        personagensCollection = db.collection(COLLECTION_NAME);

        server.listen(PORT, () => console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`));
    } catch (err) {
        console.error("Não foi possível conectar ao MongoDB", err);
        process.exit(1);
    }
}

startServer();