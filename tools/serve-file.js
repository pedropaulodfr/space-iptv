// DESENVOLVIMENTO: serve um arquivo local na rede (porta 8099) com CORS, so para testar listas grandes na TV.
const http = require('http'), fs = require('fs'); const f = process.argv[2], size = fs.statSync(f).size;
http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Access-Control-Allow-Origin': '*' }); fs.createReadStream(f).pipe(r); }).listen(8099, '0.0.0.0', () => console.log('servindo', f));
