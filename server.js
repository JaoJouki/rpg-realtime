// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir arquivos estáticos da pasta 'public' (onde você pode colocar imagens, fontes, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Objeto para guardar os dados dos personagens na memória do servidor
let personagens = {};

io.on('connection', (socket) => {
  console.log(`[SERVER] Novo cliente conectado: ${socket.id}`);

  // 1. Assim que o cliente conecta, envia a lista completa de personagens
  socket.emit('init', personagens);

  // 2. Ouve por um evento 'add' para adicionar um novo personagem
  socket.on('add', (data) => {
    if (!data || !data.id) return;
    console.log(`[SERVER] Adicionando personagem: ${data.id}`);
    personagens[data.id] = data;
    // Avisa todos os clientes que a lista mudou
    io.emit('init', personagens);
  });

  // 3. Ouve por um evento 'update' para atualizar um personagem existente
  socket.on('update', (data) => {
    const { id, ...campos } = data;
    // Garante que o ID existe antes de tentar atualizar
    if (!id || !personagens[id]) return;
    
    console.log(`[SERVER] Atualizando personagem: ${id} com dados:`, campos);
    // Mescla os novos campos com os dados existentes do personagem
    Object.assign(personagens[id], campos);
    // Avisa todos os clientes sobre a atualização específica
    io.emit('update', { id, ...campos });
  });

  // 4. Ouve por um evento 'rename' para renomear um personagem
  socket.on('rename', ({ oldId, newId }) => {
    if (!oldId || !newId || !personagens[oldId] || personagens[newId]) return;
    console.log(`[SERVER] Renomeando ${oldId} para ${newId}`);
    personagens[newId] = { ...personagens[oldId] };
    delete personagens[oldId];
    // Avisa todos os clientes que a lista mudou
    io.emit('init', personagens);
  });
  
  // 5. Ouve por um evento 'remove' para deletar um personagem
  socket.on('remove', (id) => {
    if (!id || !personagens[id]) return;
    console.log(`[SERVER] Removendo personagem: ${id}`);
    delete personagens[id];
    // Avisa todos os clientes que a lista mudou
    io.emit('init', personagens);
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`));