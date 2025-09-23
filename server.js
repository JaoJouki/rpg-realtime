// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');

// --- CONFIGURAÇÃO ---
const MASTER_PASSWORD = 'sua_senha_secreta'; // <-- TROQUE PELA SUA SENHA DE MESTRE
const PORT = process.env.PORT || 3000;
// --------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: 'seu-segredo-de-sessao-aleatorio',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let personagens = {};

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

io.on('connection', (socket) => {
  console.log(`[SERVER] Novo cliente conectado: ${socket.id}`);
  socket.emit('init', personagens);

  socket.on('add', (data) => {
    if (!data || !data.id) return;
    personagens[data.id] = { ...data, vidaVisivel: true, sanidadeVisivel: true, peVisivel: true };
    io.emit('init', personagens);
  });

  socket.on('update', (data) => {
    const { id, ...campos } = data;
    if (!id || !personagens[id]) return;
    Object.assign(personagens[id], campos);
    io.emit('update', { id, ...campos });
  });

  socket.on('rename', ({ oldId, newId }) => {
    if (!oldId || !newId || !personagens[oldId] || personagens[newId]) return;
    personagens[newId] = { ...personagens[oldId] };
    delete personagens[oldId];
    io.emit('init', personagens);
  });
  
  socket.on('remove', (id) => {
    if (!id || !personagens[id]) return;
    delete personagens[id];
    io.emit('init', personagens);
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`));