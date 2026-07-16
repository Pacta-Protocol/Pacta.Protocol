# Pacta — marketplace app (full trust mechanics, port 3220)
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3210 3220

CMD ["node", "server-pacta.js"]
