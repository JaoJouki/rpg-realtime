// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
// NOVO: Importe o MongoClient do driver do MongoDB
const { MongoClient } = require('mongodb');

// --- CONFIGURAÇÃO ---
const MASTER_PASSWORD = 'RPGSEGURO'; 
const PORT = process.env.PORT || 3000;
// NOVO: Coloque sua Connection String aqui.
// DICA DE SEGURANÇA: O ideal é usar Environment Variables!
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "RPGSEGURO-Potraits"; // Nome do seu banco de dados
const COLLECTION_NAME = "personagens"; // Nome da sua "tabela" de personagens
// --------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// NOVO: Variáveis para o banco de dados
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

// REMOVIDO: Não usaremos mais uma variável em memória
// let personagens = {}; 

// --- Funções de autenticação (sem alteração) ---
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

// NOVO: Função para carregar os personagens do banco de dados para um objeto local
// Isso mantém a velocidade da sua aplicação, lendo da memória, mas salvando no DB.
async function carregarPersonagens() {
    const personagensCursor = personagensCollection.find();
    const personagensArray = await personagensCursor.toArray();
    const personagensObj = {};
    personagensArray.forEach(p => {
        // O MongoDB salva com um _id, usamos o campo 'id' como chave do nosso objeto
        personagensObj[p.id] = p;
    });
    return personagensObj;
}

io.on('connection', async (socket) => {
  console.log(`[SERVER] Novo cliente conectado: ${socket.id}`);

  // Envia os personagens atuais assim que alguém conecta
  const personagensAtuais = await carregarPersonagens();
  socket.emit('init', personagensAtuais);

  socket.on('add', async (data) => {
    if (!data || !data.id) return;
    const novoPersonagem = { ...data, vidaVisivel: true, sanidadeVisivel: true, peVisivel: true };

    // Salva no banco de dados
    await personagensCollection.insertOne(novoPersonagem);

    // Avisa todos os clientes
    io.emit('init', await carregarPersonagens());
  });

  // ***** INÍCIO DA ALTERAÇÃO *****
  socket.on('update', async (data) => {
    const { id, ...campos } = data;
    if (!id) return;

    // 1. Busca o personagem atual no banco para obter os valores máximos
    const personagemAtual = await personagensCollection.findOne({ id: id });
    if (!personagemAtual) return; // Se o personagem não for encontrado, interrompe

    const camposParaAtualizar = { ...campos };

    // 2. Itera sobre os status para validar os limites
    ['vida', 'sanidade', 'pe'].forEach(stat => {
      // Verifica se o campo que estamos tentando atualizar existe no "data"
      if (camposParaAtualizar[stat] !== undefined) {
        const maxStatKey = `${stat}Max`; // ex: "vidaMax"
        const maxValor = personagemAtual[maxStatKey];
        let valorAtualizado = camposParaAtualizar[stat];

        // 3. Garante que o valor não seja menor que 0
        if (valorAtualizado < 0) {
          valorAtualizado = 0;
        }

        // 4. Garante que o valor não ultrapasse o máximo (se o máximo existir)
        if (maxValor !== undefined && maxValor !== null && valorAtualizado > maxValor) {
          valorAtualizado = maxValor;
        }
        
        // 5. Atribui o valor corrigido ao objeto que será salvo
        camposParaAtualizar[stat] = valorAtualizado;
      }
    });

    // 6. Atualiza no banco de dados com os valores já validados
    await personagensCollection.updateOne({ id: id }, { $set: camposParaAtualizar });

    // 7. Avisa todos os clientes com os dados corrigidos
    io.emit('update', { id, ...camposParaAtualizar });
  });
  // ***** FIM DA ALTERAÇÃO *****


  socket.on('rename', async ({ oldId, newId }) => {
    if (!oldId || !newId) return;

    // Renomeia no banco de dados (atualizando o campo 'id')
    await personagensCollection.updateOne({ id: oldId }, { $set: { id: newId } });

    // Avisa todos os clientes para recarregarem tudo
    io.emit('init', await carregarPersonagens());
  });

  socket.on('remove', async (id) => {
    if (!id) return;

    // Remove do banco de dados
    await personagensCollection.deleteOne({ id: id });

    // Avisa todos os clientes para recarregarem tudo
    io.emit('init', await carregarPersonagens());
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

// NOVO: Função principal para conectar ao DB e iniciar o servidor
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