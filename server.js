// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

let personagens = {};

io.on('connection', (socket) => {
  console.log(`[SERVER] Novo cliente conectado: ${socket.id}`);

  socket.emit('init', personagens);

  socket.on('add', (data) => {
    if (!data || !data.id) return;
    console.log(`[SERVER] Adicionando personagem: ${data.id}`);
    
    // ALTERADO: Adiciona o personagem com os status de visibilidade padrão
    personagens[data.id] = {
      ...data,
      vidaVisivel: true,
      sanidadeVisivel: true,
      peVisivel: true,
    };
    
    io.emit('init', personagens);
  });

  socket.on('update', (data) => {
    const { id, ...campos } = data;
    if (!id || !personagens[id]) return;
    
    console.log(`[SERVER] Atualizando personagem: ${id} com dados:`, campos);
    Object.assign(personagens[id], campos);
    io.emit('update', { id, ...campos });
  });

  socket.on('rename', ({ oldId, newId }) => {
    if (!oldId || !newId || !personagens[oldId] || personagens[newId]) return;
    console.log(`[SERVER] Renomeando ${oldId} para ${newId}`);
    // Mantém o estado de visibilidade ao renomear
    personagens[newId] = { ...personagens[oldId] };
    delete personagens[oldId];
    io.emit('init', personagens);
  });
  
  socket.on('remove', (id) => {
    if (!id || !personagens[id]) return;
    console.log(`[SERVER] Removendo personagem: ${id}`);
    delete personagens[id];
    io.emit('init', personagens);
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`));