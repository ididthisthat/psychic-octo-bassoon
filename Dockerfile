FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server.ts store.ts db.ts auth.ts keys.ts telegram.ts ./
ENV OXLO_HOST=0.0.0.0
EXPOSE 8761
CMD ["bun", "server.ts"]
