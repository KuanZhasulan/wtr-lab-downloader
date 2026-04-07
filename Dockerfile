FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install chromium --with-deps

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm install -D typescript @types/node @types/express
RUN npx tsc

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
