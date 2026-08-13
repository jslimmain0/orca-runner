import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('OK') }
  else { res.writeHead(404); res.end() }
}).listen(port, () => console.log(`dummy listening ${port}`))
