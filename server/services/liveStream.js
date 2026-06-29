let clients = [];

// Send keep-alive comments every 20 seconds to prevent connection timeouts
setInterval(() => {
  clients = clients.filter(client => {
    try {
      client.write(':\n\n');
      return true;
    } catch (e) {
      return false; // remove dead connection
    }
  });
}, 20000);

function registerClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // No Access-Control-Allow-Origin: this is a local-only service and
  // wildcard CORS would let any page on the LAN subscribe to change events.
  res.flushHeaders();

  clients.push(res);

  // Remove the client connection when closed
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
}

function broadcastChange(type, message = null) {
  const payload = JSON.stringify({ type, message });
  clients = clients.filter(client => {
    try {
      client.write(`event: change\ndata: ${payload}\n\n`);
      return true;
    } catch (e) {
      return false; // remove dead connection
    }
  });
}

module.exports = {
  registerClient,
  broadcastChange
};
