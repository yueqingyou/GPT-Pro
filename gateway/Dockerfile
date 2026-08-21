FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY gateway/server.mjs ./gateway/server.mjs
COPY gateway/web ./gateway/web
WORKDIR /app/gateway
EXPOSE 8080 8081
CMD ["node", "server.mjs"]
