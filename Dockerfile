FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

COPY docker/container-start.sh /usr/local/bin/bookhive-start
RUN chmod +x /usr/local/bin/bookhive-start

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=20 --start-period=40s CMD node -e "const http=require('http');const p=Number(process.env.PORT)||3000;const ok=()=>process.exit(0);const bad=()=>process.exit(1);const hit=(path,pass,fail)=>{const r=http.get({host:'127.0.0.1',port:p,path,timeout:2000},res=>res.statusCode<500?pass():fail());r.on('error',fail);r.on('timeout',()=>{r.destroy();fail();});};hit('/health',ok,()=>hit('/',ok,bad));"

CMD ["/usr/local/bin/bookhive-start"]
